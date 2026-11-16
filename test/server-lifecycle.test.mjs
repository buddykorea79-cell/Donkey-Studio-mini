import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMiniServer, findFfmpeg } from '../server/index.mjs';
import { sourceThumbnail } from '../server/vclip-core.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, ollamaHost) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'donkey-mini-lifecycle-'));
  const dataDir = path.join(root, 'data');
  const previousHost = process.env.OLLAMA_HOST;
  if (ollamaHost) process.env.OLLAMA_HOST = ollamaHost;
  let app;
  try { app = await createMiniServer({ dataDir, outputDir: path.join(root, 'output'), ffmpeg: findFfmpeg() }); }
  finally { if (previousHost === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = previousHost; }
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('donkey-mini-lifecycle-'));
    await rm(root, { recursive: true, force: true });
  });
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function video() {
    const file = path.join(root, 'synthetic.mp4');
    await execute(app.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=24',
      '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file], { windowsHide: true });
    return readFile(file);
  }
  return { app, root, dataDir, base, api, video };
}

test('a failed project save leaves the previous project visible and permits recovery', async t => {
  const { dataDir, api } = await fixture(t);
  const before = (await api('/api/project')).body;
  const blocker = path.join(dataDir, 'project.json.tmp');
  await mkdir(blocker);
  assert.equal((await api('/api/project', 'PUT', { settings: { targetSec: 17 } })).status, 400);
  assert.deepEqual((await api('/api/project')).body, before);
  await rmdir(blocker);
  assert.equal((await api('/api/project', 'PUT', { settings: { targetSec: 18 } })).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'project.json'), 'utf8')).settings.targetSec, 18);
});

test('a failed import never leaves a source pointing at a deleted file', async t => {
  const { dataDir, base, api, video } = await fixture(t);
  const bytes = await video();
  const blocker = path.join(dataDir, 'project.json.tmp');
  await mkdir(blocker);
  const response = await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': encodeURIComponent('한글 영상.mp4') }, body: bytes });
  assert.equal(response.status, 400);
  assert.equal((await api('/api/project')).body.sources.length, 0);
  assert.deepEqual(await readdir(path.join(dataDir, 'sources')), []);
  await rmdir(blocker);
  const retry = await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'retry.mp4' }, body: bytes });
  assert.equal(retry.status, 201);
  assert.equal((await api('/api/project')).body.sources.length, 1);
});

test('a delayed project body cannot change settings while an upload owns the project', async t => {
  const { base, api } = await fixture(t);
  const body = JSON.stringify({ settings: { targetSec: 17 } });
  const pending = http.request(base + '/api/project', { method: 'PUT', headers: { 'Content-Length': Buffer.byteLength(body) } });
  const completed = new Promise((resolve, reject) => {
    pending.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    pending.on('error', reject);
  });
  pending.write(body.slice(0, 1));
  await pause(30);
  const upload = http.request(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'pending.mp4', 'Content-Length': 1000000 } });
  upload.on('error', () => {});
  t.after(() => { pending.destroy(); upload.destroy(); });
  upload.write(Buffer.alloc(256));
  await pause(30);
  pending.end(body.slice(1));
  assert.equal(await completed, 409);
  assert.equal((await api('/api/project')).body.settings.targetSec, 30);
  upload.destroy();
});

test('shutdown aborts incomplete uploads and waits for their copied files to be removed', async t => {
  const { app, base, dataDir } = await fixture(t);
  const upload = http.request(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'pending.mp4', 'Content-Length': 1000000 } });
  upload.on('error', () => {});
  upload.write(Buffer.alloc(256));
  t.after(() => upload.destroy());
  for (let i = 0; i < 50 && !(await readdir(path.join(dataDir, 'sources'))).length; i++) await pause(10);
  assert.equal((await readdir(path.join(dataDir, 'sources'))).length, 1);
  await app.close();
  assert.deepEqual(await readdir(path.join(dataDir, 'sources')), []);
});

test('disconnecting an upload leaves no project entry and the next edit can succeed', async t => {
  const { base, dataDir, api, video } = await fixture(t);
  const bytes = await video();
  const upload = http.request(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'canceled.mp4', 'Content-Length': bytes.length } });
  upload.on('error', () => {});
  upload.end(bytes);
  await once(upload, 'finish');
  upload.destroy();
  let result;
  for (let i = 0; i < 100; i++) {
    result = await api('/api/project', 'PUT', { settings: { targetSec: 18 } });
    if (result.status === 200) break;
    assert.equal(result.status, 409);
    await pause(10);
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.sources.length, 0);
  assert.deepEqual(await readdir(path.join(dataDir, 'sources')), []);
});

test('a failed source deletion leaves its source, clips and saved project intact', async t => {
  const { base, dataDir, api, video } = await fixture(t);
  const response = await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'source.mp4' }, body: await video() });
  const source = await response.json();
  assert.equal(response.status, 201);
  assert.equal((await api('/api/project', 'PUT', { clips: [{ id: 'clip', sourceId: source.id, startSec: 0, endSec: .5, selected: true }] })).status, 200);
  const before = (await api('/api/project')).body;
  const saved = await readFile(path.join(dataDir, 'project.json'), 'utf8');
  await mkdir(path.join(dataDir, 'project.json.tmp'));
  assert.equal((await api('/api/sources/' + source.id, 'DELETE')).status, 400);
  assert.deepEqual((await api('/api/project')).body, before);
  assert.equal(await readFile(path.join(dataDir, 'project.json'), 'utf8'), saved);
});

test('health identifies this server and malformed request shapes cannot silently reset settings', async t => {
  const { base, api } = await fixture(t);
  assert.deepEqual((await api('/api/health')).body, { app: 'donkey-studio-mini', pid: process.pid });
  assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const before = (await api('/api/project')).body;
  for (const body of [null, [], 1, { sources: {} }, { sources: [null] }, { clips: null }, { clips: [null] }, { settings: null }, { settings: [] }, { settings: { quality: [] } }, { settings: { targetSec: false } }]) {
    assert.equal((await api('/api/project', 'PUT', body)).status, 400, JSON.stringify(body));
    assert.deepEqual((await api('/api/project')).body, before);
  }
});

test('restart restores missing nested defaults without losing saved enhancement values', async t => {
  const { app, root, dataDir } = await fixture(t);
  await app.close();
  await writeFile(path.join(dataDir, 'project.json'), JSON.stringify({ sources: [], clips: [], settings: { quality: { denoise: .6 } } }));
  const restarted = await createMiniServer({ dataDir, outputDir: path.join(root, 'output'), ffmpeg: app.ffmpeg });
  t.after(() => restarted.close());
  restarted.server.listen(0, '127.0.0.1');
  await once(restarted.server, 'listening');
  const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/project`, { method: 'PUT', body: '{}' });
  const project = await response.json();
  assert.equal(response.status, 200);
  assert.equal(project.settings.quality.denoise, .6);
  assert.equal(project.settings.quality.sharpen, .25);
});

test('an already canceled thumbnail does not access files or spawn FFmpeg', async () => {
  await assert.rejects(sourceThumbnail('missing-video.mp4', 0, 'missing-cache', AbortSignal.abort()), { name: 'AbortError' });
});

test('cancel interrupts a stalled model discovery request and retains the prior clips', { timeout: 10000 }, async t => {
  let modelRequested;
  const requestArrived = new Promise(resolve => { modelRequested = resolve; });
  const models = http.createServer(() => modelRequested());
  models.listen(0, '127.0.0.1');
  await once(models, 'listening');
  t.after(async () => {
    models.closeAllConnections();
    await new Promise(resolve => models.close(resolve));
  });
  const { api, base, video } = await fixture(t, `http://127.0.0.1:${models.address().port}`);
  const imported = await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'source.mp4' }, body: await video() });
  const source = await imported.json();
  assert.equal(imported.status, 201);
  assert.equal((await api('/api/project', 'PUT', { clips: [{ id: 'manual', sourceId: source.id, startSec: 0, endSec: .5, selected: true }] })).status, 200);
  const before = (await api('/api/project')).body;
  const started = await api('/api/analyze', 'POST', {});
  assert.equal(started.status, 202);
  await requestArrived;
  const startedCancel = Date.now();
  assert.equal((await api('/api/jobs/' + started.body.jobId + '/cancel', 'POST', {})).status, 200);
  let job;
  do {
    job = (await api('/api/jobs/' + started.body.jobId)).body;
    if (job.status !== 'running') break;
    await pause(10);
  } while (Date.now() - startedCancel < 1500);
  assert.equal(job.status, 'canceled');
  assert.ok(Date.now() - startedCancel < 1500);
  assert.deepEqual((await api('/api/project')).body, before);
  assert.equal((await api('/api/project', 'PUT', {})).status, 200);
});
