import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { renderClips, createProxy, renderPreview } from '../server/media.mjs';
import { findFfmpeg } from '../server/index.mjs';

const execute = promisify(execFile);
const ffmpeg = findFfmpeg();
const ffprobe = path.join(path.dirname(ffmpeg || ''), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const command = (binary, args, options = {}) => execute(binary, args, { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024, ...options });
const ff = args => command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args]);
const probe = async file => JSON.parse((await command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function pixel(file, at) {
  const { stdout } = await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file,
    '-frames:v', '1', '-vf', 'crop=2:2:iw/2:ih/2,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  assert.ok(stdout.length >= 3, 'The output must contain a decodable video frame.');
  return [...stdout.subarray(0, 3)];
}

test('real FFmpeg preserves source timing, formats, files and cancellation cleanup', { timeout: 60000 }, async t => {
  assert.ok(ffmpeg && existsSync(ffprobe), 'FFmpeg and FFprobe are required for media integration checks.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'donkey-mini-media-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('donkey-mini-media-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const delayed = path.join(root, '한글 # 지연 오디오.mkv');
  await ff(['-f', 'lavfi', '-i', 'color=c=red:size=160x90:rate=24:duration=2', '-itsoffset', '0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', '-n', delayed]);
  const source = { id: 'delayed', name: path.basename(delayed), path: delayed, width: 160, height: 90, fps: 24, durationSec: 2, hasAudio: true };
  const before = await digest(delayed);
  async function rms(file, start) {
    const { stdout } = await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', file,
      '-t', '0.15', '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' });
    let power = 0;
    for (let i = 0; i + 4 <= stdout.length; i += 4) power += stdout.readFloatLE(i) ** 2;
    return Math.sqrt(power / (stdout.length / 4));
  }
  await t.test('delayed audio remains aligned with the picture after trimming and proxy creation', async () => {
    const out = path.join(root, 'delay');
    const result = await renderClips({ ffmpeg, sources: [source], clips: [{ sourceId: source.id, startSec: 0.25, endSec: 1.5 }],
      resolution: 'source', fps: 24, mode: 'separate', outputDir: out });
    const file = result.files[0].path;
    assert.ok(await rms(file, 0.03) < 0.005, 'The original 0.25 seconds of remaining audio delay must stay silent.');
    assert.ok(await rms(file, 0.35) > 0.05, 'Sound must begin at its original position in the trimmed timeline.');
    const proxy = path.join(root, 'proxy.mp4');
    await createProxy({ ffmpeg, source, outputPath: proxy });
    assert.ok(await rms(proxy, 0.05) < 0.005, 'A proxy must preserve the original initial silence.');
    assert.ok(await rms(proxy, 0.65) > 0.05);
    assert.equal(await digest(delayed), before);
  });
  const portrait = path.join(root, '세로 영상.mp4');
  await ff(['-f', 'lavfi', '-i', 'color=c=blue:size=90x160:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-n', portrait]);
  const sources = [source, { id: 'portrait', name: path.basename(portrait), path: portrait, width: 90, height: 160, fps: 30, durationSec: 2, hasAudio: false }];
  const clips = [{ sourceId: source.id, startSec: 0.25, endSec: 1.25 }, { sourceId: 'portrait', startSec: 0.25, endSec: 1.5 }];
  const hashes = await Promise.all(sources.map(item => digest(item.path)));
  await t.test('all output modes combine aspect ratios, frame rates and silent sources without changing originals', async () => {
    for (const mode of ['separate', 'merged', 'both']) {
      const outputDir = path.join(root, `${mode} 한글 # 파일`);
      const { files } = await renderClips({ ffmpeg, sources, clips, resolution: 'source', fps: 24, mode, outputDir });
      assert.equal(files.length, mode === 'both' ? 3 : mode === 'merged' ? 1 : 2);
      assert.deepEqual((await readdir(outputDir)).sort(), files.map(file => file.name).sort(), 'No hidden render files may remain after success.');
      for (const file of files) {
        const data = await probe(file.path);
        const video = data.streams.find(stream => stream.codec_type === 'video');
        const audio = data.streams.find(stream => stream.codec_type === 'audio');
        assert.equal(video.codec_name, 'h264');
        assert.equal(video.width, 160); assert.equal(video.height, 90);
        assert.equal(video.r_frame_rate, '24/1');
        assert.equal(audio.codec_name, 'aac'); assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 2);
        assert.ok(Math.abs(Number(data.format.duration) - file.durationSec) < 1 / 24 + 0.03, 'Duration must stay within one output frame plus AAC packet rounding.');
        if (file.kind === 'merged') {
          const red = await pixel(file.path, 0.4), blue = await pixel(file.path, 1.4);
          assert.ok(red[0] > red[2] + 100, 'The first clip must be the selected landscape footage.');
          assert.ok(blue[2] > blue[0] + 100, 'The second clip must be the selected portrait footage.');
          assert.ok(await rms(file.path, 1.4) < 0.005, 'A silent second source must not contain audio from the previous source.');
        }
      }
    }
    assert.deepEqual(await Promise.all(sources.map(item => digest(item.path))), hashes);
  });
  await t.test('existing destinations are preserved and cancellation removes only job-owned intermediate files', async () => {
    const outputDir = path.join(root, 'separate 한글 # 파일');
    const existing = await Promise.all((await readdir(outputDir)).sort().map(async name => [name, await digest(path.join(outputDir, name))]));
    await assert.rejects(renderClips({ ffmpeg, sources, clips, resolution: 'source', fps: 24, mode: 'separate', outputDir }), /이미 파일/);
    assert.deepEqual(await Promise.all((await readdir(outputDir)).sort().map(async name => [name, await digest(path.join(outputDir, name))])), existing);
    const cancelledDir = path.join(root, 'cancel');
    const controller = new AbortController();
    await assert.rejects(renderClips({ ffmpeg, sources, clips, resolution: 'source', fps: 24, mode: 'both', outputDir: cancelledDir,
      signal: controller.signal, onProgress: progress => { if (progress.clipIndex === 2) controller.abort(); } }), { name: 'AbortError' });
    assert.deepEqual(await readdir(cancelledDir), [], 'A canceled second clip must remove the already-rendered first clip and its temp folder.');
    const runningDir = path.join(root, 'cancel-running'), runningController = new AbortController();
    let cancelTimer;
    try {
      await assert.rejects(renderClips({ ffmpeg, sources, clips: [clips[0]], quality: { denoise: 1, sharpen: 1, stabilize: true },
        resolution: '2160', fps: 60, mode: 'both', outputDir: runningDir, signal: runningController.signal,
        onProgress: () => { cancelTimer ??= setTimeout(() => runningController.abort(), 75); } }), { name: 'AbortError' });
    } finally { clearTimeout(cancelTimer); }
    assert.deepEqual(await readdir(runningDir), [], 'Canceling an active encoder must clean partial output and release its files.');
    assert.deepEqual(await Promise.all(sources.map(item => digest(item.path))), hashes);
    const failureDir = path.join(root, 'failure');
    await assert.rejects(renderClips({ ffmpeg, sources: [{ ...source, path: path.join(root, 'missing-source.mp4') }],
      clips: [clips[0]], resolution: 'source', mode: 'both', outputDir: failureDir }), /FFmpeg 처리 실패/);
    assert.deepEqual(await readdir(failureDir), []);
  });
  await t.test('quality controls change actual pixels and every filter runs on the original LGPL runtime', async () => {
    const neutralPath = path.join(root, 'neutral.mp4'), brighterPath = path.join(root, 'brighter.mp4');
    const clip = { startSec: 0.25, endSec: 0.75 };
    await renderPreview({ ffmpeg, source, clip, quality: {}, outputPath: neutralPath });
    await renderPreview({ ffmpeg, source, clip, quality: { exposure: 0.1, saturation: 0.5 }, outputPath: brighterPath });
    const neutral = await pixel(neutralPath, 0.2), brighter = await pixel(brighterPath, 0.2);
    assert.ok(brighter[1] > neutral[1] + 20 && brighter[2] > neutral[2] + 20, 'Exposure and saturation must affect encoded pixels.');
    const bundled = path.resolve(process.env.DONQUI_STUDIO_PATH || 'D:/Donqui-Studio', 'electron/native/bin/win32-x64/ffmpeg-shared.exe');
    if (!existsSync(bundled)) { t.diagnostic('Original LGPL runtime is not installed; optional compatibility sample skipped.'); return; }
    const result = await renderClips({ ffmpeg: bundled, sources, clips,
      quality: { denoise: 0.5, sharpen: 0.5, exposure: -0.1, saturation: 1.2, stabilize: true },
      resolution: 'source', fps: 24, mode: 'both', outputDir: path.join(root, 'LGPL 한글 # 파일') });
    assert.equal(result.files.length, 3);
    for (const file of result.files) {
      const metadata = await probe(file.path);
      assert.equal(metadata.streams.find(stream => stream.codec_type === 'video').codec_name, 'h264');
      assert.ok(Math.abs(Number(metadata.format.duration) - file.durationSec) < 0.07);
    }
  });
  await t.test('clips beyond the end of a short audio track receive silence and still merge', async () => {
    const shortAudio = path.join(root, '짧은 음성.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=red:size=160x90:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.25',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-n', shortAudio]);
    const shortSource = { ...source, id: 'shortAudio', path: shortAudio, name: path.basename(shortAudio) };
    const { files } = await renderClips({ ffmpeg, sources: [shortSource],
      clips: [{ sourceId: shortSource.id, startSec: 1, endSec: 1.5 }, { sourceId: shortSource.id, startSec: 0, endSec: 0.5 }],
      resolution: 'source', fps: 24, mode: 'both', outputDir: path.join(root, 'short-audio') });
    for (const file of files) {
      assert.ok((await probe(file.path)).streams.some(stream => stream.codec_type === 'audio'), 'Even an empty selected audio range needs an AAC track.');
    }
    const merged = files.find(file => file.kind === 'merged').path;
    assert.ok(await rms(merged, 0.1) < 0.005);
    assert.ok(await rms(merged, 0.6) > 0.05);
  });
  await t.test('short 4K HEVC footage keeps rotation in proxies and supports 4K export', async () => {
    const hevc = path.join(root, '4K 원본.mp4'), rotated = path.join(root, '4K 세로 회전.mov');
    await ff(['-f', 'lavfi', '-i', 'color=c=green:size=3840x2160:rate=10:duration=0.4', '-an', '-c:v', 'libx265',
      '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-pix_fmt', 'yuv420p', '-n', hevc]);
    await ff(['-i', hevc, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', '-n', rotated]);
    const fourK = { id: '4k', name: path.basename(hevc), path: hevc, width: 3840, height: 2160, fps: 10, durationSec: 0.4, hasAudio: false };
    const rotatedSource = { ...fourK, path: rotated, width: 2160, height: 3840 };
    const proxy = path.join(root, '회전 프록시.mp4');
    await createProxy({ ffmpeg, source: rotatedSource, outputPath: proxy });
    const proxyVideo = (await probe(proxy)).streams.find(stream => stream.codec_type === 'video');
    assert.equal(proxyVideo.width, 720); assert.equal(proxyVideo.height, 1280);
    assert.equal(proxyVideo.codec_name, 'h264');
    assert.ok(!proxyVideo.side_data_list?.some(item => item.rotation), 'Rotation must be applied once, not retained for a second playback rotation.');
    const result = await renderClips({ ffmpeg, sources: [fourK], clips: [{ sourceId: fourK.id, startSec: 0.1, endSec: 0.4 }],
      resolution: '2160', fps: 10, mode: 'separate', outputDir: path.join(root, '4k-output') });
    const video = (await probe(result.files[0].path)).streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.width, 3840); assert.equal(video.height, 2160);
    assert.equal(video.codec_name, 'h264');
  });
});
