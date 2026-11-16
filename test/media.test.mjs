import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chooseEncoder, clipArguments, normalizeQuality, outputDimensions, renderClips, safeFilename, validateClip, videoFilters } from '../server/media.mjs';

const source = { id: 'one', path: path.resolve('드론 영상.mp4'), name: '드론 영상.mp4', width: 3840, height: 2160, durationSec: 20, fps: 30, hasAudio: true };

test('output dimensions retain landscape, portrait and 4:3 aspect ratios with even H264 sizes', () => {
  assert.deepEqual(outputDimensions(source, '1080'), { width: 1920, height: 1080 });
  assert.deepEqual(outputDimensions({ ...source, width: 2160, height: 3840 }, '1080'), { width: 1080, height: 1920 });
  assert.deepEqual(outputDimensions({ ...source, width: 4000, height: 3000 }, '1080'), { width: 1440, height: 1080 });
  assert.deepEqual(outputDimensions({ ...source, width: 1921, height: 1081 }, 'source'), { width: 1920, height: 1080 });
  assert.throws(() => outputDimensions(source, '4k-ish'));
});

test('quality filters make requested corrections without silently changing a neutral image', () => {
  const dimensions = { width: 1920, height: 1080 };
  const neutral = videoFilters(dimensions, {}, 30);
  assert.doesNotMatch(neutral, /atadenoise|unsharp|deshake|lutyuv=/);
  const adjusted = videoFilters(dimensions, { denoise: 0.5, sharpen: 0.8, exposure: 0.1, saturation: 1.2, stabilize: true }, 60);
  assert.match(adjusted, /atadenoise=0a=0.0125:0b=0.0300/);
  assert.match(adjusted, /unsharp=5:5:1.200/);
  assert.match(adjusted, /lutyuv=y='clip\(val\+25.5000,0,255\)'/);
  assert.match(adjusted, /\(val-128\)\*1.2000/);
  assert.match(adjusted, /deshake=/);
  assert.match(adjusted, /fps=60,format=yuv420p$/);
  assert.throws(() => normalizeQuality({ exposure: 0.8 }));
  assert.throws(() => normalizeQuality({ denoise: NaN }));
});

test('encoder selection works with the original LGPL runtime and prefers x264 when available', () => {
  assert.equal(chooseEncoder(' V..... libopenh264 OpenH264 encoder'), 'libopenh264');
  assert.equal(chooseEncoder(' V..... libx264 libx264 H.264\n V..... libopenh264 OpenH264'), 'libx264');
  assert.throws(() => chooseEncoder(' V..... h264_nvenc NVIDIA'));
});

test('clip ranges reject source overrun and command uses accurate decoding, cover exclusion and normalized audio', () => {
  assert.throws(() => validateClip(source, { startSec: -1, endSec: 2 }));
  assert.throws(() => validateClip(source, { startSec: 1, endSec: 20.1 }));
  assert.throws(() => validateClip(source, { startSec: 1, endSec: 1.01 }));
  const args = clipArguments({ source, clip: { startSec: 1.25, endSec: 3.5 }, quality: {}, dimensions: { width: 1920, height: 1080 }, fps: 30, encoder: 'libopenh264', outputPath: 'out.mp4' });
  assert.equal(args[args.indexOf('-ss') + 1], '1.250000');
  assert.equal(args[args.indexOf('-t') + 1], '2.250000');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libopenh264');
  assert.ok(args.includes('0:V:0'));
  assert.ok(args.includes('0:a:0'));
  assert.ok(args.includes('-n'));
  assert.ok(!args.includes('copy'));
  assert.match(args[args.indexOf('-af') + 1], /atrim=duration=2.250000/);
  const silent = clipArguments({ source: { ...source, hasAudio: false }, clip: { startSec: 0, endSec: 1 }, quality: {}, dimensions: { width: 640, height: 360 }, fps: 30, encoder: 'libx264', outputPath: 'out.mp4' });
  assert.ok(silent.includes('anullsrc=channel_layout=stereo:sample_rate=48000'));
  assert.ok(silent.includes('1:a:0'));
});

test('output filenames retain Korean and remove Windows reserved syntax', () => {
  assert.equal(safeFilename('제주 드론 영상.mp4'), '제주 드론 영상');
  assert.equal(safeFilename('CON.mp4'), '_CON');
  assert.equal(safeFilename('여행:첫날?.mov'), '여행_첫날_');
});

test('empty selection and already canceled jobs do not start FFmpeg or touch outputs', async () => {
  await assert.rejects(renderClips({ ffmpeg: 'missing', sources: [source], clips: [], outputDir: 'unused' }), /클립을 선택/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderClips({ ffmpeg: 'missing', sources: [source], clips: [{ sourceId: 'one', startSec: 0, endSec: 1 }], outputDir: 'unused', signal: controller.signal }), { name: 'AbortError' });
});
