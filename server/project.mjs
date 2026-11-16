import { randomUUID } from 'node:crypto';

export const DEFAULT_SETTINGS = {
  targetSec: 30, clipSec: 5, maxCandidates: 12, model: 'auto',
  quality: { denoise: 0.25, sharpen: 0.25, exposure: 0, saturation: 1.03, stabilize: false },
  resolution: '1080', fps: 30, mode: 'both',
};
const number = (value, min, max, name) => {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) throw new Error(name + ' 값을 확인해 주세요.');
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(name + ' 범위를 확인해 주세요.');
  return n;
};
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' 형식을 확인해 주세요.');
}
export function validateSettings(input = {}, previous = DEFAULT_SETTINGS) {
  object(input, '설정');
  if (input.quality !== undefined) object(input.quality, '화질 설정');
  const s = { ...previous, ...input };
  const q = { ...previous.quality, ...input.quality };
  return {
    targetSec: number(s.targetSec, 0.5, 7200, '목표 길이'),
    clipSec: number(s.clipSec, 2, 20, '추천 클립 길이'),
    maxCandidates: Math.round(number(s.maxCandidates, 1, 120, '분석 구간 수')),
    model: typeof s.model === 'string' && s.model.length <= 200 ? s.model : 'auto',
    quality: {
      denoise: number(q.denoise, 0, 1, '노이즈 감소'), sharpen: number(q.sharpen, 0, 1, '선명도'),
      exposure: number(q.exposure, -0.2, 0.2, '밝기'), saturation: number(q.saturation, 0.5, 1.5, '채도'),
      stabilize: q.stabilize === true,
    },
    resolution: ['source', '1080', '2160'].includes(s.resolution) ? s.resolution : '1080',
    fps: [24, 25, 30, 50, 60].includes(Number(s.fps)) ? Number(s.fps) : 30,
    mode: ['merged', 'separate', 'both'].includes(s.mode) ? s.mode : 'both',
  };
}
export function validateRange(start, end, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('영상 길이를 확인해 주세요.');
  const startSec = number(start, 0, duration, '시작 시간');
  const endSec = Math.min(number(end, 0, duration + 0.001, '끝 시간'), duration);
  if (endSec - startSec + 1e-9 < Math.min(0.1, duration)) throw new Error('끝 시간은 시작 시간보다 뒤여야 합니다.');
  return { startSec, endSec };
}
export function updateProject(project, input) {
  object(input, '프로젝트');
  const edits = new Map();
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources) || input.sources.length > 30) throw new Error('원본 영상 목록을 확인해 주세요.');
    for (const edit of input.sources) {
      object(edit, '원본 영상');
      if (edits.has(edit.id)) throw new Error('원본 영상 ID가 중복되었습니다.');
      if (!project.sources.some(source => source.id === edit.id)) throw new Error('원본 영상을 찾을 수 없습니다.');
      edits.set(edit.id, edit);
    }
  }
  const sources = project.sources.map(source => {
    const edit = edits.get(source.id);
    if (!edit) return source;
    const range = validateRange(edit.rangeStart, edit.rangeEnd, source.durationSec);
    return { ...source, rangeStart: range.startSec, rangeEnd: range.endSec };
  });
  if (input.clips !== undefined && (!Array.isArray(input.clips) || input.clips.length > 1000)) throw new Error('클립 목록 또는 개수를 확인해 주세요.');
  const known = new Map(project.clips.map(c => [c.id, c]));
  const seen = new Set();
  const clips = (input.clips || project.clips).map(clip => {
    object(clip, '클립');
    const source = sources.find(s => s.id === clip.sourceId);
    if (!source) throw new Error('원본 영상을 찾을 수 없습니다.');
    const id = typeof clip.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(clip.id) ? clip.id : randomUUID();
    if (seen.has(id)) throw new Error('클립 ID가 중복되었습니다.');
    seen.add(id);
    const saved = known.get(id);
    return { ...(saved || { score: null, ai: false, origin: 'manual', reason: '직접 선택한 구간', thumbnail: source.thumbnail }),
      id, sourceId: source.id, ...validateRange(clip.startSec, clip.endSec, source.durationSec), selected: clip.selected === true };
  });
  return { ...project, sources, clips, settings: validateSettings(input.settings, project.settings) };
}

// A high-scoring candidate may overlap a previous choice. Keep its largest unused piece
// instead of repeating the same footage, then trim the final choice to the requested time.
export function recommendClips(candidates, targetSec) {
  const result = candidates.map(c => ({ ...c, selected: false }));
  const ranked = [...result].sort((a, b) => (b.score - a.score) || (b.qualityScore - a.qualityScore) || (a.startSec - b.startSec));
  const occupied = new Map();
  let remaining = targetSec;
  for (const clip of ranked) {
    if (remaining < 0.01) break;
    let gaps = [[clip.startSec, clip.endSec]];
    for (const [start, end] of occupied.get(clip.sourceId) || []) {
      gaps = gaps.flatMap(([a,b]) => end <= a || start >= b ? [[a,b]] : [[a, Math.min(start,b)], [Math.max(end,a),b]].filter(([x,y]) => y-x >= 0.1));
    }
    const gap = gaps.sort((a,b) => (b[1]-b[0])-(a[1]-a[0]))[0];
    if (!gap || gap[1]-gap[0] < 0.1) continue;
    // Keep every chosen clip editable: a tiny target remainder must not create a
    // sub-0.1-second clip that the range validator would reject on the next save.
    if (remaining < 0.1) {
      const deficit = 0.1 - remaining;
      const previous = ranked.find(item => item.selected && item.endSec - item.startSec >= 0.1 + deficit);
      if (!previous) break;
      const range = occupied.get(previous.sourceId).find(([start,end]) => start === previous.startSec && end === previous.endSec);
      previous.endSec -= deficit;
      range[1] = previous.endSec;
      remaining = 0.1;
    }
    clip.startSec = gap[0];
    clip.endSec = Math.min(gap[1], gap[0] + remaining);
    clip.selected = true;
    remaining = Math.max(0, remaining - (clip.endSec - clip.startSec));
    const ranges = occupied.get(clip.sourceId) || [];
    ranges.push([clip.startSec, clip.endSec]);
    occupied.set(clip.sourceId, ranges);
  }
  return result;
}
