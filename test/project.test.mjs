import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, recommendClips, updateProject, validateRange, validateSettings } from '../server/project.mjs';

const candidate = (id, sourceId, startSec, endSec, score) => ({ id, sourceId, startSec, endSec, score, qualityScore: score });
const duration = clips => clips.filter(c => c.selected).reduce((sum, c) => sum + c.endSec - c.startSec, 0);

test('recommendations meet an attainable target exactly and preserve the input candidates', () => {
  const candidates = [candidate('a', 'one', 0, 5, 98), candidate('b', 'one', 8, 13, 90), candidate('c', 'two', 0, 5, 70)];
  const original = structuredClone(candidates);
  const result = recommendClips(candidates, 7.25);
  assert.equal(duration(result), 7.25);
  assert.deepEqual(result.filter(c => c.selected).map(c => [c.id, c.startSec, c.endSec]), [['a', 0, 5], ['b', 8, 10.25]]);
  assert.deepEqual(candidates, original);
});

test('recommendations never repeat a source interval, while independent sources can use the same times', () => {
  const result = recommendClips([
    candidate('first', 'one', 0, 5, 98), candidate('overlap', 'one', 3, 8, 95),
    candidate('covered', 'one', 1, 4, 90), candidate('second-source', 'two', 0, 5, 85),
  ], 11);
  const selected = result.filter(c => c.selected);
  assert.equal(duration(result), 11);
  assert.equal(result.find(c => c.id === 'covered').selected, false);
  for (const [i, a] of selected.entries()) for (const b of selected.slice(i + 1)) {
    if (a.sourceId === b.sourceId) assert.ok(a.endSec <= b.startSec || b.endSec <= a.startSec);
  }
  assert.ok(selected.some(c => c.sourceId === 'two'));
  assert.equal(duration(recommendClips([candidate('only', 'one', 0, 2, 99)], 30)), 2);
});

test('source bounds and project edits reject invalid or ambiguous clip ranges', () => {
  const project = { sources: [{ id: 'source', durationSec: 6, rangeStart: 0, rangeEnd: 6 }], clips: [], settings: structuredClone(DEFAULT_SETTINGS) };
  const clip = { id: 'clip', sourceId: 'source', startSec: 1, endSec: 3, selected: true };
  const edited = updateProject(project, { sources: [{ id: 'source', rangeStart: 0.5, rangeEnd: 5.5 }], clips: [clip], settings: { targetSec: 4 } });
  assert.equal(edited.sources[0].rangeStart, 0.5);
  assert.equal(edited.clips[0].origin, 'manual');
  assert.equal(edited.clips[0].selected, true);
  assert.equal(edited.settings.targetSec, 4);
  assert.equal(project.sources[0].rangeStart, 0);
  assert.equal(project.clips.length, 0);
  for (const [start, end] of [[-1, 2], [2, 7], [2, 2], [3, 2], [NaN, 2], [0, Infinity]]) {
    assert.throws(() => validateRange(start, end, 6));
  }
  assert.throws(() => updateProject(project, { clips: [{ ...clip, endSec: 7 }] }));
  assert.throws(() => updateProject(project, { clips: [{ ...clip, sourceId: 'missing' }] }));
  assert.throws(() => updateProject(project, { clips: [clip, clip] }));
  assert.throws(() => updateProject(project, { clips: {} }));
});

test('invalid analysis and enhancement values are rejected before persisting a project', () => {
  for (const input of [
    { targetSec: 0 }, { targetSec: 7201 }, { targetSec: 'bad' }, { clipSec: 1 }, { clipSec: 21 },
    { maxCandidates: 121 }, { quality: { denoise: -0.1 } }, { quality: { sharpen: 2 } },
    { quality: { exposure: 0.3 } }, { quality: { saturation: 0 } },
  ]) assert.throws(() => validateSettings(input));
  const changed = validateSettings({ quality: { denoise: 0 }, model: '' });
  assert.equal(changed.quality.denoise, 0);
  assert.equal(changed.quality.sharpen, DEFAULT_SETTINGS.quality.sharpen);
  assert.equal(changed.model, '');
});

test('fractional clip targets produce editable ranges instead of tiny invalid leftovers', () => {
  const result = recommendClips([candidate('a', 'one', 0, 2, 98), candidate('b', 'one', 3, 5, 90)], 2.05);
  assert.ok(Math.abs(duration(result) - 2.05) < 1e-9);
  for (const clip of result.filter(item => item.selected)) assert.doesNotThrow(() => validateRange(clip.startSec, clip.endSec, 5));
  const updated = updateProject({ sources: [{ id: 'one', durationSec: 5 }], clips: result, settings: structuredClone(DEFAULT_SETTINGS) }, { settings: { targetSec: 2.05 } });
  assert.ok(Math.abs(duration(updated.clips) - 2.05) < 1e-9);
});

test('range boundaries tolerate floating point subtraction but reject null and clipped-away intervals', () => {
  assert.deepEqual(validateRange(.2, .3, 1), { startSec: .2, endSec: .3 });
  assert.deepEqual(validateRange(1.135, 1.235, 1.235), { startSec: 1.135, endSec: 1.235 });
  for (const start of [null, false, '', [], {}]) assert.throws(() => validateRange(start, 1, 2));
  assert.throws(() => validateRange(.9005, 1.0006, 1));
  assert.throws(() => validateRange(0, .1, 0));
});

test('source updates reject unknown and duplicate source identities without altering the input', () => {
  const project = { sources: [{ id: 'one', durationSec: 5, rangeStart: 0, rangeEnd: 5 }], clips: [], settings: structuredClone(DEFAULT_SETTINGS) };
  const source = { id: 'one', rangeStart: 0, rangeEnd: 2 };
  assert.throws(() => updateProject(project, { sources: [source, source] }));
  assert.throws(() => updateProject(project, { sources: [{ ...source, id: 'unknown' }] }));
  assert.equal(project.sources[0].rangeEnd, 5);
});
