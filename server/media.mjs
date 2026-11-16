import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const encoderCache = new Map();
const MODES = new Set(['merged', 'separate', 'both']);
const abortError = () => new DOMException('작업을 취소했습니다.', 'AbortError');
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function normalizeQuality(value = {}) {
  const bounds = { denoise: [0, 1, 0], sharpen: [0, 1, 0], exposure: [-0.2, 0.2, 0], saturation: [0.5, 1.5, 1] };
  const quality = {};
  for (const [key, [min, max, fallback]] of Object.entries(bounds)) {
    const number = value[key] === undefined ? fallback : value[key];
    if (!Number.isFinite(number) || number < min || number > max) throw new Error(`올바르지 않은 화질 설정: ${key}`);
    quality[key] = number;
  }
  quality.stabilize = value.stabilize === true;
  return quality;
}

/** Keep Korean and other Unicode names; remove only filesystem-reserved characters. */
export function safeFilename(value) {
  const stem = path.parse(String(value || '영상')).name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 90);
  const safe = stem || '영상';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}

export function outputDimensions(source, resolution = '1080') {
  const { width, height } = source;
  if (![width, height].every(value => Number.isFinite(value) && value >= 2 && value <= 16384)) {
    throw new Error('영상의 크기를 확인할 수 없습니다.');
  }
  if (!['source', '720', '1080', '2160'].includes(String(resolution))) throw new Error('지원하지 않는 출력 해상도입니다.');
  let ratio = 1;
  if (String(resolution) !== 'source') {
    const short = Number(resolution);
    const long = short * 16 / 9;
    ratio = Math.min(long / Math.max(width, height), short / Math.min(width, height));
  }
  return { width: Math.max(2, Math.floor(width * ratio / 2) * 2), height: Math.max(2, Math.floor(height * ratio / 2) * 2) };
}

export function videoFilters(dimensions, quality = {}, fps = 30) {
  const q = normalizeQuality(quality);
  const { width, height } = dimensions;
  if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value % 2 === 0)) throw new Error('출력 크기는 짝수여야 합니다.');
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('출력 프레임은 1~120fps 범위여야 합니다.');
  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    'format=yuv420p',
  ];
  if (q.stabilize) filters.push('deshake=rx=16:ry=16:edge=mirror');
  // These filters ship in Donqui's LGPL runtime; hqdn3d/eq do not.
  if (q.denoise > 0) {
    const a = (q.denoise * 0.025).toFixed(4);
    const b = (q.denoise * 0.06).toFixed(4);
    filters.push(`atadenoise=0a=${a}:0b=${b}:1a=${a}:1b=${b}:2a=${a}:2b=${b}:s=5`);
  }
  if (q.exposure !== 0 || q.saturation !== 1) {
    const offset = (q.exposure * 255).toFixed(4);
    const saturation = q.saturation.toFixed(4);
    filters.push(`lutyuv=y='clip(val+${offset},0,255)':u='clip((val-128)*${saturation}+128,0,255)':v='clip((val-128)*${saturation}+128,0,255)'`);
  }
  if (q.sharpen > 0) filters.push(`unsharp=5:5:${(q.sharpen * 1.5).toFixed(3)}:5:5:0`);
  filters.push(`fps=${fps}`, 'format=yuv420p');
  return filters.join(',');
}

export function chooseEncoder(output) {
  if (/\blibx264\b/.test(output)) return 'libx264';
  if (/\blibopenh264\b/.test(output)) return 'libopenh264';
  throw new Error('이 FFmpeg에는 H.264 인코더가 없습니다. libx264 또는 libopenh264 지원 빌드가 필요합니다.');
}

function run(ffmpeg, args, { signal, durationSec = 0, onProgress, cwd } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let pending = '';
    let timedOut = false;
    // Long footage may take hours on a CPU; a wedged process must still terminate.
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 6 * 60 * 60 * 1000);
    const cancel = () => child.kill();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) child.kill();
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-512 * 1024);
      pending += data;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match && durationSec > 0) onProgress?.(Math.max(0, Math.min(1, Number(match[1]) / 1e6 / durationSec)));
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16384); });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', code => {
      clean();
      if (signal?.aborted) reject(abortError());
      else if (timedOut) reject(new Error('영상 처리 제한 시간을 초과했습니다.'));
      else if (code !== 0) reject(new Error(`FFmpeg 처리 실패 (${code}): ${stderr.trim().split(/\r?\n/).slice(-8).join(' ').slice(-1400)}`));
      else resolve(stdout);
    });
  });
}

async function encoderFor(ffmpeg, signal) {
  if (!encoderCache.has(ffmpeg)) {
    const lookup = run(ffmpeg, ['-hide_banner', '-encoders'], { signal }).then(chooseEncoder);
    encoderCache.set(ffmpeg, lookup);
    lookup.catch(() => encoderCache.delete(ffmpeg));
  }
  return encoderCache.get(ffmpeg);
}

function encoderArgs(encoder, dimensions, fps) {
  if (encoder === 'libx264') return ['-c:v', encoder, '-preset', 'fast', '-crf', '18'];
  const rate = Math.max(2000000, Math.round(dimensions.width * dimensions.height * fps * 0.14));
  return ['-c:v', encoder, '-b:v', String(rate), '-maxrate', String(rate * 2), '-bufsize', String(rate * 4)];
}

export function validateClip(source, clip) {
  if (!source || typeof source.path !== 'string' || !path.isAbsolute(source.path)) throw new Error('원본 영상 파일을 찾을 수 없습니다.');
  const startSec = clip?.startSec;
  const endSec = clip?.endSec;
  if (!Number.isFinite(source.durationSec) || !Number.isFinite(startSec) || !Number.isFinite(endSec) ||
      startSec < 0 || endSec - startSec < 0.1 || endSec > source.durationSec + 0.001) {
    throw new Error('클립의 시작·끝 시간을 원본 영상 범위 안에서 지정해 주세요.');
  }
  return { startSec, endSec: Math.min(endSec, source.durationSec), durationSec: Math.min(endSec, source.durationSec) - startSec };
}

export function clipArguments({ source, clip, quality, dimensions, fps, encoder, outputPath }) {
  const range = validateClip(source, clip);
  const duration = range.durationSec.toFixed(6);
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-n', '-threads', '2', '-ss', range.startSec.toFixed(6), '-i', source.path];
  if (!source.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  // Uppercase V excludes MJPEG cover streams found in DJI camera files.
  args.push('-map', '0:V:0', '-map', source.hasAudio ? '0:a:0' : '1:a:0',
    '-t', duration, '-vf', videoFilters(dimensions, quality, fps),
    // Preserve delayed audio and timestamp gaps on the trimmed video timeline.
    // Resetting audio PTS alone would move a late-starting microphone track forward.
    '-af', `aresample=48000:async=1:first_pts=0,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS`,
    ...encoderArgs(encoder, dimensions, fps), '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '1',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-map_metadata', '-1', '-video_track_timescale', '90000', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

async function ensureMissing(file) {
  try { await stat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`이미 파일이 있습니다. 다른 저장 위치를 선택하세요: ${path.basename(file)}`);
}

async function publish(temporary, destination) {
  if ((await stat(temporary)).size === 0) throw new Error('영상 파일이 비어 있습니다.');
  // Linking is atomic and fails if a destination already exists; never overwrite user files.
  try { await link(temporary, destination); }
  catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
  }
}

async function clearTaskDirectory(directory, parent) {
  const base = path.resolve(parent);
  const target = path.resolve(directory);
  if (path.dirname(target) !== base || !path.basename(target).startsWith('.mini-render-')) {
    throw new Error('임시 작업 폴더 범위가 올바르지 않습니다.');
  }
  await rm(target, { recursive: true, force: true });
}

export async function renderClips({ ffmpeg, sources, clips, quality = {}, resolution = '1080', fps = 30, mode = 'both', outputDir, signal, onProgress }) {
  if (!MODES.has(mode)) throw new Error('저장 방식이 올바르지 않습니다.');
  if (signal?.aborted) throw abortError();
  const selected = clips.filter(clip => clip.selected !== false);
  if (selected.length === 0) throw new Error('저장할 클립을 선택해 주세요.');
  if (selected.length > 200) throw new Error('한 번에 최대 200개 클립을 저장할 수 있습니다.');
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const jobs = selected.map((clip, index) => {
    const source = sourceMap.get(clip.sourceId);
    const range = validateClip(source, clip);
    return { source, clip, ...range, name: `${String(index + 1).padStart(2, '0')}_${safeFilename(source.name)}.mp4` };
  });
  const dimensions = outputDimensions(jobs[0].source, resolution);
  const normalized = normalizeQuality(quality);
  videoFilters(dimensions, normalized, fps);
  const base = path.resolve(outputDir);
  await mkdir(base, { recursive: true });
  const files = [];
  if (mode !== 'merged') jobs.forEach(job => files.push({ name: job.name, path: path.join(base, job.name), durationSec: job.durationSec, kind: 'clip' }));
  const totalDuration = jobs.reduce((sum, job) => sum + job.durationSec, 0);
  if (mode !== 'separate') files.push({ name: 'Donkey-Studio-Mini_모음.mp4', path: path.join(base, 'Donkey-Studio-Mini_모음.mp4'), durationSec: totalDuration, kind: 'merged' });
  for (const file of files) await ensureMissing(file.path);
  const encoder = await encoderFor(ffmpeg, signal);
  const temporary = path.join(base, `.mini-render-${randomUUID()}`);
  await mkdir(temporary);
  const committed = [];
  try {
    const hasMerge = mode !== 'separate';
    const renderShare = hasMerge ? 0.94 : 1;
    let completedDuration = 0;
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      if (signal?.aborted) throw abortError();
      const outputPath = path.join(temporary, `segment-${String(index).padStart(4, '0')}.mp4`);
      const progress = fraction => onProgress?.({ progress: renderShare * (completedDuration + fraction * job.durationSec) / totalDuration, stage: '클립 보정·저장 중', clipIndex: index + 1, totalClips: jobs.length });
      progress(0);
      await run(ffmpeg, clipArguments({ source: job.source, clip: job.clip, quality: normalized, dimensions, fps, encoder, outputPath }), { signal, durationSec: job.durationSec, onProgress: progress });
      job.temporary = outputPath;
      progress(1);
      completedDuration += job.durationSec;
    }
    let merged;
    if (hasMerge) {
      const manifest = path.join(temporary, 'concat.txt');
      await writeFile(manifest, jobs.map(job => `file '${path.basename(job.temporary)}'\nduration ${job.durationSec.toFixed(6)}`).join('\n') + '\n');
      merged = path.join(temporary, 'merged.mp4');
      onProgress?.({ progress: renderShare, stage: '클립을 하나의 영상으로 합치는 중' });
      // Resolve the manifest from its working directory: FFmpeg otherwise treats a # in
      // a parent directory (including Windows sandbox paths) as a URL fragment.
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-n', '-f', 'concat', '-safe', '1', '-i', 'concat.txt',
        '-map', '0:V:0', '-map', '0:a:0', '-c', 'copy', '-t', totalDuration.toFixed(6), '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats', merged], { cwd: temporary, signal, durationSec: totalDuration, onProgress: fraction => onProgress?.({ progress: renderShare + fraction * (1 - renderShare), stage: '클립을 하나의 영상으로 합치는 중' }) });
    }
    if (signal?.aborted) throw abortError();
    for (const file of files) {
      const from = file.kind === 'merged' ? merged : jobs.find(job => job.name === file.name).temporary;
      await publish(from, file.path);
      committed.push(file.path);
    }
    onProgress?.({ progress: 1, stage: '저장 완료' });
    return { files };
  } catch (error) {
    // Only paths successfully created by this job are removed, never pre-existing files.
    await Promise.all(committed.map(file => rm(file, { force: true })));
    throw error;
  } finally {
    await clearTaskDirectory(temporary, base);
  }
}

async function renderSingle({ ffmpeg, source, clip, quality, outputPath, signal, onProgress }) {
  if (signal?.aborted) throw abortError();
  validateClip(source, clip);
  const destination = path.resolve(outputPath);
  const base = path.dirname(destination);
  await mkdir(base, { recursive: true });
  await ensureMissing(destination);
  const temporary = path.join(base, `.mini-render-${randomUUID()}`);
  await mkdir(temporary);
  try {
    const dimensions = outputDimensions(source, '720');
    // Avoid inventing resolution when creating a preview of a smaller original.
    if (dimensions.width > source.width) Object.assign(dimensions, outputDimensions(source, 'source'));
    const fps = Math.max(1, Math.min(30, finite(source.fps, 30)));
    const encoder = await encoderFor(ffmpeg, signal);
    const file = path.join(temporary, 'preview.mp4');
    await run(ffmpeg, clipArguments({ source, clip, quality, dimensions, fps, encoder, outputPath: file }), {
      signal, durationSec: clip.endSec - clip.startSec,
      onProgress: progress => onProgress?.({ progress, stage: '미리보기 준비 중' }),
    });
    if (signal?.aborted) throw abortError();
    await publish(file, destination);
    return destination;
  } finally { await clearTaskDirectory(temporary, base); }
}

export async function createProxy({ ffmpeg, source, outputPath, signal, onProgress }) {
  return renderSingle({ ffmpeg, source, clip: { startSec: 0, endSec: source.durationSec }, quality: {}, outputPath, signal, onProgress });
}

export async function renderPreview({ ffmpeg, source, clip, quality, outputPath, signal, onProgress }) {
  validateClip(source, clip);
  return renderSingle({ ffmpeg, source, clip: { ...clip, endSec: Math.min(clip.endSec, clip.startSec + 4) }, quality, outputPath, signal, onProgress });
}
