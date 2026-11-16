import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMiniServer, findFfmpeg } from '../server/index.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('local API imports, analyzes, edits and exports synthetic footage with restart persistence', { timeout: 60000 }, async t => {
  const ffmpeg = findFfmpeg();
  assert.ok(ffmpeg, 'A local FFmpeg installation is required for the integration test.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'donqui-mini-api-'));
  const dataDir = path.join(root, 'data'), outputDir = path.join(root, 'output');
  const fixture = path.join(root, '한글 드론 영상.mp4');
  // No user's media, model inference or external service is used in this test.
  const oldHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = '127.0.0.1:1';
  let app;
  let base;
  t.after(async () => {
    if (app) await app.close();
    if (oldHost === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = oldHost;
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('donqui-mini-api-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', fixture], { windowsHide: true });
  async function start() {
    app = await createMiniServer({ dataDir, outputDir, ffmpeg });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  async function api(route, { method = 'GET', body, headers } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function finished(id) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await api('/api/jobs/' + id);
      assert.equal(result.status, 200);
      if (result.body.status !== 'running') return result.body;
      await pause(30);
    }
    assert.fail('Background job did not finish within 20 seconds');
  }

  await t.test('external origins and foreign hosts cannot read or mutate the local project', async () => {
    assert.equal((await api('/api/project', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
    assert.equal((await api('/api/project', { method: 'PUT', body: {}, headers: { Origin: 'https://unrelated.example' } })).status, 403);
    // Fetch may normalize Host, so use a raw HTTP request to exercise DNS-rebinding protection.
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(base + '/api/project', { headers: { Host: 'foreign.example' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await api('/api/project', { headers: { Origin: base } })).status, 200);
  });

  let source;
  const bytes = await readFile(fixture);
  await t.test('raw import preserves Korean names and serves exact byte ranges', async () => {
    const response = await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(path.basename(fixture)) }, body: bytes });
    source = await response.json();
    assert.equal(response.status, 201, JSON.stringify(source));
    assert.equal(source.name, '한글 드론 영상.mp4');
    assert.equal(source.path, undefined);
    assert.ok(Math.abs(source.durationSec - 6) < 0.1);
    assert.equal(source.width, 160);
    assert.equal(source.height, 90);
    assert.equal(source.hasAudio, true);
    const range = await fetch(base + source.url, { headers: { Range: 'bytes=0-63' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('Content-Range'), `bytes 0-63/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 64));
    assert.equal((await fetch(base + source.url, { headers: { Range: 'bytes=999999999-' } })).status, 416);
    const head = await fetch(base + source.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('Content-Length')), bytes.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  await t.test('invalid files and settings fail without changing the existing project', async () => {
    assert.equal((await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'bad.txt' }, body: 'invalid' })).status, 400);
    const invalid = await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': 'bad.mp4' }, body: 'invalid' });
    assert.equal(invalid.status, 400);
    assert.equal((await readdir(path.join(dataDir, 'sources'))).length, 1);
    assert.equal((await api('/api/project', { method: 'PUT', body: { settings: { targetSec: -1 } } })).status, 400);
    assert.equal((await api('/api/project')).body.sources.length, 1);
    assert.equal((await api('/api/jobs/00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await api('/api/export', { method: 'POST', body: {} })).status, 400);
  });

  const settings = { targetSec: 3, clipSec: 2, maxCandidates: 3, model: '', resolution: 'source', fps: 24, mode: 'both',
    quality: { denoise: 0, sharpen: 0, exposure: 0, saturation: 1, stabilize: false } };
  await t.test('source range saves and quality-only analysis completes within the chosen range', async () => {
    const saved = await api('/api/project', { method: 'PUT', body: { sources: [{ id: source.id, rangeStart: 0.5, rangeEnd: 5.5 }], settings } });
    assert.equal(saved.status, 200);
    const started = await api('/api/analyze', { method: 'POST', body: {} });
    assert.equal(started.status, 202);
    const job = await finished(started.body.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.aiCount, 0);
    assert.ok(job.result.fallbackCount > 0);
    assert.ok(Math.abs(job.result.actualSec - 3) < 0.01);
    for (const clip of job.result.clips) {
      assert.ok(clip.startSec >= 0.5 && clip.endSec <= 5.5);
      assert.ok(clip.thumbnail?.startsWith('data:image/jpeg;base64,'));
    }
  });

  await t.test('cancel stops an active job and releases the project for later changes', async () => {
    const before = (await api('/api/project')).body;
    const started = await api('/api/analyze', { method: 'POST', body: {} });
    assert.equal(started.status, 202);
    assert.equal((await api('/api/jobs/' + started.body.jobId + '/cancel', { method: 'POST', body: {} })).status, 200);
    const job = await finished(started.body.jobId);
    assert.equal(job.status, 'canceled', job.error);
    assert.deepEqual((await api('/api/project')).body, before);
    assert.equal((await api('/api/project', { method: 'PUT', body: { settings } })).status, 200);
  });

  await t.test('enhancement previews identify their source clip and proxies remain available on the source', async () => {
    const before = (await api('/api/project')).body;
    const clip = before.clips.find(item => item.selected);
    const started = await api('/api/preview', { method: 'POST', body: { clipId: clip.id, quality: { sharpen: .3 } } });
    assert.equal(started.status, 202);
    const job = await finished(started.body.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.clipId, clip.id);
    assert.equal(job.result.sourceId, source.id);
    assert.equal((await fetch(base + job.result.files[0].url, { method: 'HEAD' })).status, 200);
    assert.deepEqual((await api('/api/project')).body.settings, before.settings);
    const proxyStarted = await api('/api/proxy', { method: 'POST', body: { sourceId: source.id } });
    assert.equal(proxyStarted.status, 202);
    const proxy = await finished(proxyStarted.body.jobId);
    assert.equal(proxy.status, 'done', proxy.error);
    assert.equal(proxy.result.sourceId, source.id);
    assert.equal((await api('/api/project')).body.sources[0].previewUrl, proxy.result.url);
    assert.equal((await fetch(base + proxy.result.url, { method: 'HEAD' })).status, 200);
  });

  await t.test('analysis persistence failure preserves earlier recommendations and releases the project', async () => {
    const before = (await api('/api/project')).body;
    const blocker = path.join(dataDir, 'project.json.tmp');
    await mkdir(blocker);
    try {
      const started = await api('/api/analyze', { method: 'POST', body: {} });
      assert.equal(started.status, 202);
      const job = await finished(started.body.jobId);
      assert.equal(job.status, 'error');
      assert.deepEqual((await api('/api/project')).body, before);
    } finally { await rmdir(blocker); }
    assert.equal((await api('/api/project', { method: 'PUT', body: {} })).status, 200);
  });

  let exported;
  await t.test('two selected clips produce both individual and merged valid H.264 MP4 files', async () => {
    const clips = [
      { id: 'manual-one', sourceId: source.id, startSec: 0.5, endSec: 1.5, selected: true },
      { id: 'manual-two', sourceId: source.id, startSec: 3, endSec: 4, selected: true },
    ];
    assert.equal((await api('/api/project', { method: 'PUT', body: { clips, settings } })).status, 200);
    const started = await api('/api/export', { method: 'POST', body: {} });
    assert.equal(started.status, 202);
    const job = await finished(started.body.jobId);
    assert.equal(job.status, 'done', job.error);
    exported = job.result.files;
    assert.equal(exported.length, 3);
    assert.equal(exported.filter(f => f.kind === 'clip').length, 2);
    assert.equal(exported.filter(f => f.kind === 'merged').length, 1);
    const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    for (const file of exported) {
      assert.ok(file.name.includes('한글') || file.name.includes('모음'));
      const local = path.join(outputDir, started.body.jobId, file.name);
      assert.ok((await stat(local)).size > 1000);
      const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', local], { windowsHide: true });
      const metadata = JSON.parse(stdout);
      const video = metadata.streams.find(s => s.codec_type === 'video');
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.width, 160);
      assert.equal(video.height, 90);
      assert.equal(video.r_frame_rate, '24/1');
      assert.ok(metadata.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
      const expected = file.kind === 'merged' ? 2 : 1;
      assert.ok(Math.abs(Number(metadata.format.duration) - expected) < 0.15, metadata.format.duration);
      const response = await fetch(base + file.url + '?download');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''/);
      assert.ok((await response.arrayBuffer()).byteLength > 1000);
    }
  });

  await t.test('project, trims and exported files remain available after restarting the server', async () => {
    await app.close(); app = null;
    await start();
    const loaded = await api('/api/project');
    assert.equal(loaded.body.sources[0].name, source.name);
    assert.equal(loaded.body.sources[0].rangeStart, 0.5);
    assert.deepEqual(loaded.body.clips.map(c => [c.startSec, c.endSec]), [[0.5, 1.5], [3, 4]]);
    assert.equal(loaded.body.settings.model, '');
    assert.equal(loaded.body.exports.length, 1);
    assert.equal(loaded.body.exports[0].files.length, 3);
    assert.equal((await fetch(base + exported[0].url, { method: 'HEAD' })).status, 200);
  });

  await t.test('render failures report an error and release the job without losing earlier exports', async () => {
    const storedSource = path.join(dataDir, 'sources', source.id + '.mp4');
    const unavailable = storedSource + '.unavailable';
    await rename(storedSource, unavailable);
    try {
      const started = await api('/api/export', { method: 'POST', body: {} });
      assert.equal(started.status, 202);
      const job = await finished(started.body.jobId);
      assert.equal(job.status, 'error');
      assert.ok(job.error.length > 0);
      assert.equal((await api('/api/project', { method: 'PUT', body: { settings } })).status, 200);
      assert.equal((await api('/api/project')).body.exports.length, 1);
      assert.equal((await fetch(base + exported[0].url, { method: 'HEAD' })).status, 200);
    } finally { await rename(unavailable, storedSource); }
  });
});

test('multiple source videos retain separate ranges and export together across aspect ratios and audio layouts', { timeout: 60000 }, async t => {
  const ffmpeg = findFfmpeg();
  assert.ok(ffmpeg, 'A local FFmpeg installation is required for the integration test.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'donkey-mini-multi-'));
  const dataDir = path.join(root, 'data'), outputDir = path.join(root, 'output');
  const inputs = [path.join(root, '드론 가로.mp4'), path.join(root, '액션캠 세로 무음.mp4')];
  const oldHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = '127.0.0.1:1';
  let app;
  t.after(async () => {
    if (app) await app.close();
    if (oldHost === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = oldHost;
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('donkey-mini-multi-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await Promise.all([
    execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:size=160x90:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', inputs[0]], { windowsHide: true }),
    execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=blue:size=90x160:rate=30',
      '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', '-y', inputs[1]], { windowsHide: true }),
  ]);
  app = await createMiniServer({ dataDir, outputDir, ffmpeg });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, `${route}: ${JSON.stringify(result)}`);
    return result;
  }
  async function complete(id) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const job = await api('/api/jobs/' + id);
      if (job.status !== 'running') { assert.equal(job.status, 'done', job.error); return job; }
      await pause(30);
    }
    assert.fail('Multi-source processing did not finish within 20 seconds');
  }
  const sources = [];
  for (const input of inputs) {
    const response = await fetch(base + '/api/import', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(path.basename(input)) }, body: await readFile(input) });
    const source = await response.json();
    assert.equal(response.status, 201, JSON.stringify(source));
    sources.push(source);
  }
  assert.equal(sources[0].hasAudio, true);
  assert.equal(sources[1].hasAudio, false);
  assert.deepEqual(sources.map(s => [s.width, s.height]), [[160, 90], [90, 160]]);
  const ranges = [
    { id: sources[0].id, rangeStart: 0.25, rangeEnd: 2.75 },
    { id: sources[1].id, rangeStart: 0.5, rangeEnd: 3 },
  ];
  const settings = { targetSec: 4, clipSec: 2, maxCandidates: 2, model: '', resolution: 'source', fps: 24, mode: 'both',
    quality: { denoise: 0, sharpen: 0, exposure: 0, saturation: 1, stabilize: false } };
  const saved = await api('/api/project', 'PUT', { sources: ranges, settings });
  assert.deepEqual(saved.sources.map(s => [s.rangeStart, s.rangeEnd]), [[0.25, 2.75], [0.5, 3]]);
  const analyze = await api('/api/analyze', 'POST', {});
  const analyzed = await complete(analyze.jobId);
  assert.equal(analyzed.result.aiCount, 0);
  assert.ok(Math.abs(analyzed.result.actualSec - 4) < 0.01);
  assert.deepEqual(new Set(analyzed.result.clips.map(c => c.sourceId)), new Set(sources.map(s => s.id)));
  assert.deepEqual(new Set(analyzed.result.clips.filter(c => c.selected).map(c => c.sourceId)), new Set(sources.map(s => s.id)));
  for (const clip of analyzed.result.clips) {
    const range = ranges.find(r => r.id === clip.sourceId);
    assert.ok(clip.startSec >= range.rangeStart && clip.endSec <= range.rangeEnd);
  }
  await api('/api/project', 'PUT', { settings, clips: [
    { id: 'landscape', sourceId: sources[0].id, startSec: 0.25, endSec: 1.25, selected: true },
    { id: 'portrait', sourceId: sources[1].id, startSec: 0.5, endSec: 1.75, selected: true },
  ] });
  const exporting = await api('/api/export', 'POST', {});
  const exported = (await complete(exporting.jobId)).result.files;
  assert.equal(exported.length, 3);
  assert.deepEqual(exported.filter(f => f.kind === 'clip').map(f => f.name), ['01_드론 가로.mp4', '02_액션캠 세로 무음.mp4']);
  assert.equal(exported.find(f => f.kind === 'merged').name, 'Donkey-Studio-Mini_모음.mp4');
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  for (const file of exported) {
    const local = path.join(outputDir, exporting.jobId, file.name);
    const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', local], { windowsHide: true });
    const metadata = JSON.parse(stdout);
    const video = metadata.streams.find(s => s.codec_type === 'video');
    const audio = metadata.streams.find(s => s.codec_type === 'audio');
    assert.deepEqual([video.width, video.height, video.r_frame_rate, video.codec_name], [160, 90, '24/1', 'h264']);
    assert.deepEqual([audio.codec_name, audio.channels, audio.sample_rate], ['aac', 2, '48000']);
    assert.ok(Math.abs(Number(metadata.format.duration) - file.durationSec) < 0.15, metadata.format.duration);
  }
  // Verify the merged file actually contains both sources in the selected order.
  const merged = path.join(outputDir, exporting.jobId, 'Donkey-Studio-Mini_모음.mp4');
  for (const [seconds, dominant] of [[0.5, 0], [1.5, 2]]) {
    const { stdout } = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', merged,
      '-vf', 'crop=2:2:80:44', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, encoding: 'buffer' });
    assert.equal(stdout.length, 12);
    assert.ok(stdout[dominant] > 180, `Expected ${dominant === 0 ? 'red drone' : 'blue action-camera'} frame at ${seconds}s`);
    assert.ok(stdout[dominant === 0 ? 2 : 0] < 50);
  }
});
