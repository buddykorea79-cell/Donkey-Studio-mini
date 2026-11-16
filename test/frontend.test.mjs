import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = () => ({
  sources: [{ id: 'source-one', name: '한글 영상.mp4', durationSec: 1.235, rangeStart: 0, rangeEnd: 1.235, width: 640, height: 360, fps: 24, url: '/media/source-one' }],
  clips: [{ id: 'clip-one', sourceId: 'source-one', startSec: 0, endSec: 1.235, selected: true, origin: 'manual' }],
  settings: { model: '', clipSec: 2 }, exports: [], activeJob: null,
});

// A small DOM/transport boundary keeps these regression tests dependency-free.
// Browser layout and native input behavior are covered separately in browser QA.
async function studio(initial = fixture(), handler = null) {
  class Element {
    constructor(id = '') { this.id = id; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.hidden = false; this.value = ''; this.disabled = false; this.currentTime = 0; this.duration = 1.235; this.paused = true; this.innerHTML = ''; this.textContent = ''; this.classList = { toggle() {}, add() {}, contains() { return false; } }; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    hasAttribute(key) { return key in this.attributes; }
    querySelector() { return new Element(); }
    querySelectorAll() { return []; }
    contains() { return false; }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    load() {}
    scrollIntoView() {}
    matches() { return false; }
    closest(selector) { return selector === 'button' ? this : null; }
  }
  const elements = new Map();
  const events = new Map();
  const timers = new Map();
  const requests = [];
  const transport = { project: structuredClone(initial), handler, uploads: 0 };
  const document = {
    documentElement: new Element(), activeElement: null,
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
    querySelector() { return new Element(); }, querySelectorAll() { return []; },
    addEventListener(name, listener) { events.set(name, listener); },
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, localStorage: { setItem() {} },
    structuredClone, console, crypto: { randomUUID }, CSS: { escape: value => value },
    setTimeout(fn, delay) { const id = randomUUID(); timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (path, options = {}) => {
      requests.push({ path, ...options });
      if (transport.handler) { const answer = await transport.handler(path, options); if (answer) return answer; }
      const payload = path === '/api/project' ? transport.project : { ollama: { available: true, models: [] }, ffmpeg: { available: true } };
      return { ok: true, json: async () => structuredClone(payload) };
    },
    XMLHttpRequest: class {
      constructor() { this.upload = new Element(); this.listeners = new Map(); }
      open() {} setRequestHeader() {}
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      send() { transport.uploads++; this.status = 201; this.responseText = JSON.stringify(initial.sources[0]); queueMicrotask(() => this.listeners.get('load')()); }
      abort() { this.listeners.get('abort')?.(); }
    },
  });
  vm.runInContext(script, context);
  await tick();
  const run = code => vm.runInContext(code, context);
  const response = payload => ({ ok: true, json: async () => structuredClone(payload) });
  return { run, elements, events, timers, transport, requests, Element, response };
}

test('fractional source endpoints remain exact when trimming clips and analysis ranges', async () => {
  const app = await studio();
  app.run("changeClipRange('clip-one', 'endSec', 1.235)");
  assert.equal(app.run('project.clips[0].endSec'), 1.235);
  app.run("changeSourceRange('rangeEnd', 1.235)");
  assert.equal(app.run('project.sources[0].rangeEnd'), 1.235);
  app.run("changeClipRange('clip-one', 'startSec', 1.234)");
  assert.ok(app.run('project.clips[0].endSec - project.clips[0].startSec') >= .1 - 1e-12);
});

test('manual clips fit a fractional-duration source exactly', async () => {
  const app = await studio();
  const button = new app.Element(); button.dataset.action = 'add-clip';
  await app.events.get('click')({ target: button });
  assert.equal(app.run('project.clips.at(-1).endSec'), 1.235);
  assert.equal(app.run('project.clips.at(-1).startSec'), 0);
});

test('job completion keeps edits locked until the refreshed project arrives', async () => {
  const app = await studio();
  let resolveProject;
  app.transport.handler = (path) => {
    if (path.startsWith('/api/jobs/')) return app.response({ type: 'export', status: 'done', result: { files: [] } });
    if (path === '/api/project') return new Promise(resolve => { resolveProject = resolve; });
  };
  app.run("activeJob = { id: 'job-one', type: 'export' }");
  const completed = app.run('pollJob()');
  await tick();
  assert.equal(app.run('busy()'), true);
  resolveProject(app.response(app.transport.project));
  await completed;
  assert.equal(app.run('busy()'), false);
});

test('enhancement results restore their own clip after switching sources', async () => {
  const project = fixture();
  project.sources.push({ ...project.sources[0], id: 'source-two', name: '두 번째.mp4', url: '/media/source-two' });
  const app = await studio(project);
  app.run("showSource('source-two'); activeJob = { id: 'job-preview', type: 'preview', clipId: 'clip-one' }");
  app.transport.handler = path => path.startsWith('/api/jobs/') ? app.response({ type: 'preview', status: 'done', result: { clipId: 'clip-one', sourceId: 'source-one', files: [{ url: '/output/job-preview/enhanced.mp4' }] } }) : null;
  await app.run('pollJob()');
  assert.equal(app.run('sourceId'), 'source-one');
  assert.equal(app.run('clipId'), 'clip-one');
  assert.equal(app.elements.get('viewer-title').textContent, '한글 영상.mp4');
  assert.equal(app.run('currentPreview'), '/output/job-preview/enhanced.mp4');
});

test('canceling an import while pending changes save prevents upload', async () => {
  const app = await studio();
  let finishSave;
  app.transport.handler = (path, options) => path === '/api/project' && options.method === 'PUT' ? new Promise(resolve => { finishSave = resolve; }) : null;
  const importing = app.run("importFiles([{ name: '첫 번째.mp4' }, { name: '두 번째.mp4' }])");
  await tick();
  await app.elements.get('cancel-job').listeners.get('click')();
  finishSave(app.response(app.transport.project));
  await importing;
  assert.equal(app.transport.uploads, 0);
  assert.equal(app.run('busy()'), false);
});

test('number-field commits retain the clicked inspector action', async () => {
  const app = await studio();
  const input = new app.Element(); input.dataset.setting = 'targetSec'; input.value = '12'; input.type = 'number';
  const inspector = app.elements.get('inspector-content');
  let redraws = 0, html = inspector.innerHTML;
  Object.defineProperty(inspector, 'innerHTML', { get: () => html, set(value) { redraws++; html = value; } });
  app.events.get('change')({ target: input });
  assert.equal(app.run('project.settings.targetSec'), 12);
  assert.equal(redraws, 0, 'blur must not detach the analyze button receiving the click');
});

test('queued autosaves preserve the latest edit when an older response arrives late', async () => {
  const app = await studio();
  const pending = [];
  app.transport.handler = (path, options) => path === '/api/project' && options.method === 'PUT'
    ? new Promise(resolve => pending.push({ changes: JSON.parse(options.body), resolve })) : null;
  const first = app.run('project.settings.targetSec = 12; saveSoon(); saveNow()');
  await tick();
  const second = app.run('project.settings.targetSec = 18; saveSoon(); saveNow()');
  assert.equal(pending.length, 1, 'project writes must be serialized');
  pending[0].resolve(app.response({ ...app.transport.project, settings: { targetSec: 12 } }));
  await first; await tick();
  assert.equal(app.run('project.settings.targetSec'), 18);
  assert.equal(app.elements.get('save-status').textContent, '변경 사항 저장 중…');
  assert.equal(pending[1].changes.settings.targetSec, 18);
  pending[1].resolve(app.response({ ...app.transport.project, settings: { targetSec: 18 } }));
  await second;
  assert.equal(app.elements.get('save-status').textContent, '로컬에 저장됨');
});

test('a failed autosave can be retried without changing or losing the edit', async () => {
  const app = await studio();
  app.transport.handler = (path, options) => {
    if (path === '/api/project' && options.method === 'PUT') throw new Error('offline');
  };
  await assert.rejects(app.run('project.settings.targetSec = 16; saveSoon(); saveNow()'), /offline/);
  assert.equal(app.elements.get('retry-save').hidden, false);
  assert.equal(app.run('project.settings.targetSec'), 16);
  app.transport.handler = null;
  app.elements.get('retry-save').listeners.get('click')();
  await tick();
  assert.equal(app.run('savedRevision === editRevision'), true);
  assert.equal(app.elements.get('retry-save').hidden, true);
  assert.equal(JSON.parse(app.requests.at(-1).body).settings.targetSec, 16);
});

test('initial project-loading failure retries without allowing an empty workspace to save', async () => {
  const app = await studio(fixture(), path => { if (path === '/api/project') throw new Error('startup disconnect'); });
  assert.equal(app.run('busy()'), true);
  assert.equal(app.run('project.sources.length'), 0);
  assert.match(app.elements.get('save-status').textContent, /재시도/);
  const retry = [...app.timers.values()].find(timer => timer.delay === 3000);
  assert.ok(retry);
  app.transport.handler = null;
  await retry.fn(); await tick();
  assert.equal(app.run('busy()'), false);
  assert.equal(app.run('project.sources[0].name'), '한글 영상.mp4');
  assert.equal(app.requests.filter(request => request.method === 'PUT').length, 0);
});

test('editing the current clip leaves an obsolete enhancement preview and preserves exact bounds', async () => {
  const app = await studio();
  app.run("showClip('clip-one'); currentPreview = '/output/old-preview.mp4'; changeClipRange('clip-one', 'endSec', .75)");
  assert.equal(app.run('currentPreview'), null);
  assert.equal(app.elements.get('player').src, '/media/source-one');
  assert.equal(app.run('project.clips[0].endSec'), .75);
  assert.equal(app.elements.get('preview-badge').hidden, true);
});

test('adding a clip during enhancement preview uses the source timeline position', async () => {
  const project = fixture();
  Object.assign(project.sources[0], { durationSec: 20, rangeEnd: 20 });
  Object.assign(project.clips[0], { startSec: 10, endSec: 15 });
  const app = await studio(project);
  app.run("showClip('clip-one'); currentPreview = '/output/preview.mp4'; player.currentTime = .75");
  const button = new app.Element(); button.dataset.action = 'add-clip';
  await app.events.get('click')({ target: button });
  assert.equal(app.run('project.clips.at(-1).startSec'), 10.75);
  assert.equal(app.run('project.clips.at(-1).endSec'), 12.75);
});

test('job recovery keeps retrying when a server restart is followed by a project fetch failure', async () => {
  const app = await studio();
  app.run("activeJob = { id: 'old-job', type: 'export' }");
  app.transport.handler = path => {
    if (path.startsWith('/api/jobs/')) return { ok: false, status: 404, json: async () => ({ error: 'missing job' }) };
    if (path === '/api/project') throw new Error('temporarily unavailable');
  };
  await app.run('pollJob()');
  assert.equal(app.run('busy()'), true);
  assert.ok([...app.timers.values()].some(timer => timer.delay === 3000));
  assert.match(app.elements.get('job-message').textContent, /다시 확인/);
});
