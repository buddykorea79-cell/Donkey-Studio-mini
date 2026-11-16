const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const seconds = (value) => Math.round(Number(value || 0) * 100) / 100;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));
function rangeProgress(value, min = 0, max = 100) {
  const span = Number(max) - Number(min);
  const progress = (Number(value) - Number(min)) / span * 100;
  return `${span > 0 && Number.isFinite(progress) ? clamp(progress, 0, 100) : 0}%`;
}
function syncRangeStyle(input) {
  input.style.setProperty('--range-progress', rangeProgress(input.value, input.min || 0, input.max || 100));
}
function time(value) {
  const sec = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(sec / 3600);
  return `${h ? `${String(h).padStart(2, '0')}:` : ''}${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
const durationLabel = (value) => value >= 60 ? `${Math.floor(value / 60)}분 ${seconds(value % 60)}초` : `${seconds(value)}초`;
const defaults = { targetSec: 30, clipSec: 5, maxCandidates: 12, model: 'auto', quality: { denoise: .25, sharpen: .25, exposure: 0, saturation: 1.03, stabilize: false }, resolution: '1080', fps: 30, mode: 'both' };
let project = { sources: [], clips: [], settings: structuredClone(defaults), exports: [] };
let system = null;
let sourceId = null;
let clipId = null;
let step = 'recommend';
let activeJob = null;
let uploading = false;
let mutationBusy = false;
let saveTimer;
let saveChain = Promise.resolve();
let saveFailure = null;
let editRevision = 0;
let savedRevision = 0;
let toastTimer;
let currentPreview = null;
let pendingVideoTime = 0;
let dragDepth = 0;
let currentUpload = null;
let uploadCanceled = false;
let initializing = true;
const player = $('player');
const busy = () => initializing || !!activeJob || uploading || mutationBusy;
const source = () => project.sources.find((item) => item.id === sourceId);
const clip = () => project.clips.find((item) => item.id === clipId);
const selected = () => project.clips.filter((item) => item.selected);
const selectedSeconds = () => selected().reduce((sum, item) => sum + item.endSec - item.startSec, 0);
function setTheme(theme) {
  const selectedTheme = ['midnight', 'white', 'bordeaux'].includes(theme) ? theme : 'midnight';
  document.documentElement.dataset.theme = selectedTheme;
  document.querySelectorAll('.theme-picker [data-theme]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.theme === selectedTheme)));
  document.querySelector('meta[name="theme-color"]').content = { midnight: '#101724', white: '#f5f6f8', bordeaux: '#24131d' }[selectedTheme];
  try { localStorage.setItem('donkey-studio-mini-theme', selectedTheme); } catch {}
}
setTheme(document.documentElement.dataset.theme || 'midnight');

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `요청을 처리하지 못했습니다 (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8500 : 5000);
}
function report(error) { toast(error?.message || String(error), true); }
function normalizeProject(value) {
  return { ...value, sources: value.sources || [], clips: value.clips || [], exports: value.exports || [], settings: { ...defaults, ...value.settings, quality: { ...defaults.quality, ...value.settings?.quality } } };
}
async function reloadProject() {
  project = normalizeProject(await api('/api/project'));
  if (!project.sources.some((item) => item.id === sourceId)) sourceId = project.sources[0]?.id || null;
  if (!project.clips.some((item) => item.id === clipId)) clipId = null;
  render();
}
function snapshot() {
  return structuredClone({ clips: project.clips, settings: project.settings, sources: project.sources.map(({ id, rangeStart, rangeEnd }) => ({ id, rangeStart, rangeEnd })) });
}
function saveSoon() {
  editRevision++;
  clearTimeout(saveTimer);
  $('save-status').textContent = '변경 사항 저장 중…';
  saveTimer = setTimeout(() => { saveNow().catch(report); }, 400);
}
async function saveNow() {
  clearTimeout(saveTimer);
  const changes = snapshot();
  const revision = editRevision;
  saveChain = saveChain.catch(() => {}).then(async () => {
    try {
      await api('/api/project', changes, 'PUT');
      saveFailure = null;
      savedRevision = revision;
      $('save-status').textContent = savedRevision === editRevision ? '로컬에 저장됨' : '변경 사항 저장 중…';
      $('retry-save').hidden = true;
    } catch (error) {
      saveFailure = error;
      $('save-status').textContent = '저장 실패 · 다시 시도해 주세요';
      $('retry-save').hidden = false;
      throw error;
    }
  });
  return saveChain;
}

function renderSources() {
  $('source-count').textContent = project.sources.length;
  $('source-list').innerHTML = project.sources.map((item) => `<div class="source-item ${item.id === sourceId ? 'active' : ''}" data-source="${esc(item.id)}" tabindex="0" role="button" aria-label="${esc(item.name)} 미리보기" aria-pressed="${item.id === sourceId}">
    ${item.thumbnail ? `<img class="source-thumb" src="${esc(item.thumbnail)}" alt="">` : `<span class="source-thumb">${icon('video')}</span>`}
    <div class="source-info"><strong title="${esc(item.name)}">${esc(item.name)}</strong><small>${time(item.durationSec)} · ${item.width} × ${item.height}</small></div>
    <button class="source-delete edit-control" data-action="remove-source" data-id="${esc(item.id)}" aria-label="${esc(item.name)} 작업에서 빼기">${icon('close')}</button></div>`).join('');
}
function renderSelectionSummary() {
  $('selection-summary').textContent = project.clips.length ? `${selected().length}개 선택 · ${durationLabel(selectedSeconds())} / 목표 ${durationLabel(project.settings.targetSec)}` : '추천받은 장면을 확인하고 자유롭게 조정하세요.';
  const exportLength = document.querySelector('.export-summary strong');
  if (exportLength) exportLength.textContent = durationLabel(selectedSeconds());
}
function renderClips() {
  $('clip-count').textContent = project.clips.length;
  renderSelectionSummary();
  $('add-clip-btn').disabled = !source() || busy();
  $('clip-list').innerHTML = project.clips.length ? project.clips.map((item, index) => {
    const media = project.sources.find((entry) => entry.id === item.sourceId);
    return `<article class="clip-card ${item.id === clipId ? 'active' : ''} ${item.selected ? '' : 'unselected'}" data-clip="${esc(item.id)}">
      <input class="edit-control" type="checkbox" data-action="select-clip" data-id="${esc(item.id)}" ${item.selected ? 'checked' : ''} aria-label="클립 ${index + 1} 내보내기에 포함">
      <button class="clip-thumbnail" data-action="play-clip" data-id="${esc(item.id)}" aria-label="클립 ${index + 1} 미리보기">${item.thumbnail || media?.thumbnail ? `<img src="${esc(item.thumbnail || media.thumbnail)}" alt="">` : ''}${icon('play')}</button>
      <div class="clip-info"><div class="clip-meta"><span class="kind">${item.origin === 'manual' ? '직접 선택' : item.ai ? 'AI 추천' : '화질 점수'}</span>${item.origin !== 'manual' ? `<span class="score">${Math.round(item.score || 0)}점</span>` : ''}<span>CLIP ${String(index + 1).padStart(2, '0')}</span></div>
      <strong title="${esc(media?.name)}">${esc(media?.name || '원본 영상')}</strong><p title="${esc(item.aiError ? `AI 분석 실패: ${item.aiError}. 화질 점수로 표시합니다.` : item.reason)}">${esc(item.aiError ? 'AI 연결 오류 · 화질 점수로 선별' : item.reason || '직접 고른 구간')}</p>
      <div class="clip-range"><input class="edit-control" type="number" min="0" max="${media?.durationSec || 0}" step="any" value="${item.startSec}" data-clip-bound="startSec" data-id="${esc(item.id)}" aria-label="클립 ${index + 1} 시작 초"><span>—</span><input class="edit-control" type="number" min="${Math.min(.1, media?.durationSec || .1)}" max="${media?.durationSec || 0}" step="any" value="${item.endSec}" data-clip-bound="endSec" data-id="${esc(item.id)}" aria-label="클립 ${index + 1} 끝 초"><span>초</span><span class="clip-seconds">· ${durationLabel(item.endSec - item.startSec)}</span></div></div>
      <div class="clip-actions"><button class="icon-button edit-control" data-action="move-clip-up" data-id="${esc(item.id)}" ${index === 0 ? 'disabled data-always-disabled' : ''} aria-label="클립 ${index + 1} 앞으로">${icon('up')}</button><button class="icon-button edit-control" data-action="move-clip-down" data-id="${esc(item.id)}" ${index === project.clips.length - 1 ? 'disabled data-always-disabled' : ''} aria-label="클립 ${index + 1} 뒤로">${icon('down')}</button><button class="icon-button danger edit-control" data-action="remove-clip" data-id="${esc(item.id)}" aria-label="클립 ${index + 1} 삭제">${icon('trash')}</button></div></article>`;
  }).join('') : `<div class="empty-clips"><span class="empty-line"></span><p>아직 선택한 장면이 없어요.</p><small>${project.sources.length ? '오른쪽에서 목표 길이를 정하고 추천을 시작하세요.' : '영상을 가져온 뒤 오른쪽에서 추천을 시작하세요.'}</small></div>`;
}
function rangeInput(key, title, min, max, stepValue, formatter) {
  const value = project.settings.quality[key];
  return `<label class="slider-field field"><span class="range-header">${title}<output id="value-${key}">${formatter(value)}</output></span><input class="edit-control" data-quality="${key}" type="range" min="${min}" max="${max}" step="${stepValue}" value="${value}" style="--range-progress:${rangeProgress(value, min, max)}" aria-label="${title}"></label>`;
}
function modelOptions() {
  const model = project.settings.model;
  const models = system?.ollama?.models || [];
  const all = [{ name: 'auto', label: '설치된 비전 AI 자동 선택' }, { name: '', label: 'AI 없이 · 화질 점수로 선별' }, ...models.map((item) => ({ name: item.name, label: `${item.name}${item.parameterSize ? ` · ${item.parameterSize}` : ''}` }))];
  if (model && model !== 'auto' && !models.some((item) => item.name === model)) all.push({ name: model, label: `${model} · 연결 확인 필요` });
  return all.map((item) => `<option value="${esc(item.name)}" ${item.name === model ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
}
function modelDescription() {
  return project.settings.model === '' ? '밝기·선명도·움직임을 계산해 고릅니다. AI 장면 해석은 사용하지 않습니다.' : system?.ollama?.available ? '기존 프로젝트의 Ollama 연결을 사용합니다. 영상 프레임은 내 컴퓨터에서 분석됩니다.' : 'Ollama 연결을 확인해 주세요. 연결 없이 진행하려면 ‘화질 점수로 선별’을 선택하세요.';
}
function renderInspector() {
  const current = source();
  const settings = project.settings;
  if (step === 'recommend') {
    $('inspector-content').innerHTML = `<p class="eyebrow">01 / FIND YOUR MOMENTS</p><h2>장면을 발견하세요.</h2><p class="intro">필요한 길이를 알려 주세요.<br> 좋은 장면을 고르는 일은 AI에 맡기세요.</p>
    <label class="field"><span>완성할 영상의 총길이</span><div class="input-unit"><input class="edit-control" type="number" min="1" max="3600" step="1" value="${settings.targetSec}" data-setting="targetSec" aria-label="완성할 영상의 총길이 초"><span>초</span></div><small>여러 원본에서 고른 클립의 합계입니다.</small></label>
    <label class="field"><span class="range-header">클립 한 개의 길이 <output id="clip-length-value">${settings.clipSec}초</output></span><input class="edit-control" data-setting="clipSec" type="range" min="2" max="20" step="1" value="${settings.clipSec}" style="--range-progress:${rangeProgress(settings.clipSec, 2, 20)}" aria-label="클립 한 개의 길이"><span class="range-endpoints"><span>2초 · 빠르게</span><span>20초 · 여유롭게</span></span></label>
    <div class="divider"></div><div class="section-label">분석할 원본 범위 <small>현재 영상</small></div>
    ${current ? `<div class="range-fields"><label>시작 (초)<input class="edit-control" data-source-bound="rangeStart" type="number" min="0" max="${current.durationSec}" step="any" value="${current.rangeStart ?? 0}"></label><label>끝 (초)<input class="edit-control" data-source-bound="rangeEnd" type="number" min="${Math.min(.1, current.durationSec)}" max="${current.durationSec}" step="any" value="${current.rangeEnd ?? current.durationSec}"></label></div><p class="hint">${esc(current.name)}<br> 원본을 선택해 영상마다 분석 범위를 정하세요.</p>` : '<p class="hint">영상을 가져오면 분석 범위를 정할 수 있어요.</p>'}
    <div class="divider"></div><label class="field"><span>탐색 밀도</span><select class="edit-control" data-setting="maxCandidates" aria-label="탐색 밀도"><option value="12" ${settings.maxCandidates === 12 ? 'selected' : ''}>빠르게 · 원본당 최대 12구간</option><option value="24" ${settings.maxCandidates === 24 ? 'selected' : ''}>균형 있게 · 최대 24구간</option><option value="48" ${settings.maxCandidates === 48 ? 'selected' : ''}>촘촘하게 · 최대 48구간</option></select><small>긴 영상에서 더 많은 장면을 찾으려면 높이세요.</small></label>
    <label class="field"><span>장면 분석 모델</span><select class="edit-control" data-setting="model" aria-label="장면 분석 모델">${modelOptions()}</select></label>
    <div class="ai-description ${settings.model !== '' && system && !system.ollama?.available ? 'warning' : ''}">${modelDescription()}</div>
    <button class="primary full edit-control" data-action="analyze" ${!project.sources.length ? 'disabled data-always-disabled' : ''}>${icon('spark')}추천 클립 만들기</button><p class="hint">총 ${project.sources.length}개 원본에서 추천합니다.<br> 다시 분석하면 기존 클립 모음을 교체합니다.</p>`;
  } else if (step === 'enhance') {
    $('inspector-content').innerHTML = `<p class="eyebrow">02 / A CLEARER PICTURE</p><h2>더 선명한 순간.</h2><p class="intro">노이즈와 색감을 다듬어 주세요.<br> 선택한 클립에 같은 보정을 적용합니다.</p>
    <div class="preset-row"><button class="preset edit-control" data-preset="natural">자연스럽게</button><button class="preset edit-control" data-preset="clear">선명하게</button><button class="preset edit-control" data-preset="lowlight">저조도</button></div>
    ${rangeInput('denoise', '노이즈 감소', 0, 1, .05, (value) => `${Math.round(value * 100)}%`)}
    ${rangeInput('sharpen', '선명도', 0, 1, .05, (value) => `${Math.round(value * 100)}%`)}
    ${rangeInput('exposure', '밝기', -.2, .2, .01, (value) => `${value > 0 ? '+' : ''}${Math.round(value * 100)}`)}
    ${rangeInput('saturation', '채도', .5, 1.5, .01, (value) => `${Math.round(value * 100)}%`)}
    <label class="check-row"><input class="edit-control" data-quality="stabilize" type="checkbox" ${settings.quality.stabilize ? 'checked' : ''}>가벼운 흔들림 보정</label><p class="quality-notice">실제 영상에 노이즈 감소·선명도·색감 보정을 적용합니다. AI 초해상도 복원 기능은 아닙니다.</p>
    <div class="divider"></div><button class="secondary full edit-control" data-action="preview" ${!project.clips.length ? 'disabled data-always-disabled' : ''}>${icon('play')}4초 보정 미리보기</button><p class="hint">현재 클립 또는 첫 번째 선택 클립으로 비교합니다. 보정 미리보기는 짧은 영상을 직접 렌더링합니다.</p><button class="primary full" data-step="export" style="margin-top:20px">내보내기로${icon('arrow')}</button>`;
  } else {
    $('inspector-content').innerHTML = `<p class="eyebrow">03 / READY TO GO</p><h2>원하는 방식으로.</h2><p class="intro">한 편의 영상으로 이어 붙이거나,<br> 각각의 클립으로 저장하세요.</p>
    <div class="field"><span>저장 방식</span>${[['merged', '한 편으로 합치기', '클립 순서대로 이어 붙인 MP4 1개'], ['separate', '클립 각각 저장', '선택한 구간마다 개별 MP4'], ['both', '합친 영상 + 개별 클립', '두 가지 결과를 함께 저장']].map(([value, title, description]) => `<label class="export-choice"><input class="edit-control" type="radio" name="mode" value="${value}" data-setting="mode" ${settings.mode === value ? 'checked' : ''}><div><strong>${title}</strong><small>${description}</small></div></label>`).join('')}</div>
    <label class="field"><span>출력 해상도</span><select class="edit-control" data-setting="resolution" aria-label="출력 해상도"><option value="source" ${settings.resolution === 'source' ? 'selected' : ''}>첫 번째 원본 크기</option><option value="1080" ${settings.resolution === '1080' ? 'selected' : ''}>Full HD · 1080p</option><option value="2160" ${settings.resolution === '2160' ? 'selected' : ''}>4K · 2160p</option></select><small>서로 다른 원본은 비율을 유지해 같은 화면에 맞춥니다. 해상도를 높여도 원본에 없는 디테일이 복원되지는 않습니다.</small></label>
    <label class="field"><span>프레임레이트</span><select class="edit-control" data-setting="fps" aria-label="프레임레이트">${[24, 30, 60].map((fps) => `<option value="${fps}" ${settings.fps === fps ? 'selected' : ''}>${fps} fps</option>`).join('')}</select></label>
    <div class="export-summary"><span>${selected().length}개 클립 · 총길이</span><strong>${durationLabel(selectedSeconds())}</strong></div>
    <button class="primary full edit-control" data-action="export" ${!selected().length ? 'disabled data-always-disabled' : ''}>${icon('download')}영상 만들기</button><p class="hint">MP4 · H.264 / AAC<br> 원본 소리는 유지하며, 소리 없는 영상은 무음으로 연결합니다.</p>`;
  }
}
function renderRange() {
  const media = source();
  const current = clip();
  $('range-editor').hidden = !media || !!currentPreview;
  if (!media) return;
  const start = current?.startSec ?? media.rangeStart ?? 0;
  const end = current?.endSec ?? media.rangeEnd ?? media.durationSec;
  const percent = (value) => Math.max(0, Math.min(100, value / media.durationSec * 100));
  $('range-editor').innerHTML = `<div class="range-caption"><span>${current ? '현재 클립 구간 · 핸들로 조정' : '현재 원본의 분석 범위'}</span><span>${time(start)} — ${time(end)} <span class="badge">${durationLabel(end - start)}</span></span></div><div class="source-timeline" aria-hidden="true"><div class="range-window" style="left:${percent(start)}%;width:${percent(end - start)}%"></div>${project.clips.filter((item) => item.sourceId === media.id).map((item) => `<span class="clip-tick ${item.id === clipId ? 'active' : ''}" style="left:${percent(item.startSec)}%;width:${percent(item.endSec - item.startSec)}%"></span>`).join('')}</div><div class="trim-sliders"><label>시작<input class="edit-control" type="range" min="0" max="${media.durationSec}" step="0.1" value="${start}" style="--range-progress:${rangeProgress(start, 0, media.durationSec)}" data-trim="start" aria-label="${current ? '클립' : '분석 범위'} 시작"></label><label>끝<input class="edit-control" type="range" min="0" max="${media.durationSec}" step="0.1" value="${end}" style="--range-progress:${rangeProgress(end, 0, media.durationSec)}" data-trim="end" aria-label="${current ? '클립' : '분석 범위'} 끝"></label></div>`;
}
function renderOutputs() {
  const exports = project.exports || [];
  const latest = exports.at(-1);
  $('outputs').hidden = !latest?.files?.length;
  if (!latest?.files?.length) return;
  $('outputs').innerHTML = `<h2>${icon('check')}영상이 준비되었어요.</h2><p>최근 내보내기 · ${latest.files.length}개 파일. 로컬 출력 폴더에도 저장되어 있습니다.</p>${latest.files.map((file) => `<a class="output-link" href="${esc(file.url)}${file.url.includes('?') ? '&' : '?'}download=1" download="${esc(file.name)}">${icon('download')}<span>${esc(file.name)}</span><small>${file.kind === 'merged' ? '합친 영상' : '개별 클립'}${file.durationSec ? ` · ${time(file.durationSec)}` : ''}</small></a>`).join('')}`;
}
function renderBusy() {
  document.querySelectorAll('.edit-control').forEach((element) => { element.disabled = busy() || element.hasAttribute('data-always-disabled'); });
  $('add-clip-btn').disabled = !source() || busy();
  $('file-input').disabled = busy();
}
function render() {
  renderSources(); renderClips(); renderInspector(); renderRange(); renderOutputs(); renderBusy();
  document.querySelectorAll('[data-step]').forEach((button) => {
    const active = button.dataset.step === step;
    button.classList.toggle('active', active);
    if (button.classList.contains('step')) active ? button.setAttribute('aria-current', 'step') : button.removeAttribute('aria-current');
  });
  const media = source();
  $('viewer-eyebrow').textContent = currentPreview ? 'ENHANCEMENT PREVIEW' : clip() ? `CLIP ${String(project.clips.indexOf(clip()) + 1).padStart(2, '0')} / PREVIEW` : 'YOUR FOOTAGE, REFINED';
  $('viewer-title').textContent = media?.name || '긴 영상에서, 기억할 장면으로.';
  $('viewer-title').title = media?.name || '';
  $('viewer-meta').textContent = media ? `${media.width} × ${media.height} · ${Math.round(media.fps)} fps` : '';
  $('viewer-empty').hidden = !!media;
  $('player').hidden = !media;
  $('player-controls').hidden = !media;
  $('preview-badge').hidden = !currentPreview;
  $('original-btn').hidden = !currentPreview;
  if (!media) { player.pause(); player.removeAttribute('src'); player.load(); $('video-error').hidden = true; }
}

function loadVideo(url, at = 0) {
  $('video-error').hidden = true;
  pendingVideoTime = at;
  if (player.getAttribute('src') !== url) { player.src = url; player.load(); }
  else { player.currentTime = at; updatePlayTime(); }
}
function showSource(id, at = 0) {
  player.pause(); sourceId = id; clipId = null; currentPreview = null;
  const media = source();
  render();
  if (media) loadVideo(media.previewUrl || media.url, at);
}
function showClip(id, play = false) {
  const item = project.clips.find((entry) => entry.id === id);
  if (!item) return;
  player.pause(); clipId = id; sourceId = item.sourceId; currentPreview = null;
  const media = source();
  render();
  loadVideo(media.previewUrl || media.url, item.startSec);
  if (play) player.play().catch(() => {});
}
function updatePlayTime() {
  const duration = Number.isFinite(player.duration) ? player.duration : currentPreview ? 4 : source()?.durationSec || 0;
  $('play-time').textContent = `${time(player.currentTime)} / ${time(duration)}`;
  const seek = $('seek');
  seek.max = String(duration || 1);
  seek.value = String(player.currentTime || 0);
  syncRangeStyle(seek);
}
player.addEventListener('loadedmetadata', () => { player.currentTime = Math.min(pendingVideoTime, player.duration || pendingVideoTime); updatePlayTime(); });
player.addEventListener('timeupdate', () => {
  if (!currentPreview && clip() && !player.paused && player.currentTime >= clip().endSec) player.pause();
  updatePlayTime();
});
player.addEventListener('play', () => { $('play-btn').innerHTML = icon('pause'); $('play-btn').setAttribute('aria-label', '일시 정지'); });
player.addEventListener('pause', () => { $('play-btn').innerHTML = icon('play'); $('play-btn').setAttribute('aria-label', '재생'); });
player.addEventListener('error', () => {
  if (!source()) return;
  if (currentPreview) { toast('보정 미리보기를 재생하지 못했습니다. 원본 보기로 돌아가 다시 시도해 주세요.', true); return; }
  $('video-error').hidden = false;
});
$('play-btn').addEventListener('click', () => {
  if (!source()) return;
  if (player.paused) {
    if (!currentPreview && clip() && (player.currentTime < clip().startSec || player.currentTime >= clip().endSec - .02)) player.currentTime = clip().startSec;
    player.play().catch(() => { $('video-error').hidden = false; });
  } else player.pause();
});
$('seek').addEventListener('input', (event) => { player.currentTime = Number(event.target.value); updatePlayTime(); });
$('original-btn').addEventListener('click', () => clipId ? showClip(clipId) : showSource(sourceId));
$('fullscreen-btn').addEventListener('click', () => player.requestFullscreen?.().catch(report));

function changeClipRange(id, bound, value) {
  const item = project.clips.find((entry) => entry.id === id);
  const media = project.sources.find((entry) => entry.id === item?.sourceId);
  if (!item || !media) return;
  if (value === '' || !Number.isFinite(Number(value))) value = item[bound];
  const minimum = Math.min(.1, media.durationSec);
  if (bound === 'startSec') item.startSec = clamp(value, 0, item.endSec - minimum);
  else item.endSec = clamp(value, item.startSec + minimum, media.durationSec);
  // Commit in place: replacing the card on blur discards the button about to
  // receive the user's click (play, select, delete, or another input).
  document.querySelectorAll('[data-clip-bound]').forEach((input) => {
    if (input.dataset.id === id) input.value = String(item[input.dataset.clipBound]);
  });
  const card = document.querySelector(`[data-clip="${CSS.escape(id)}"]`);
  const label = card?.querySelector('.clip-seconds');
  if (label) label.textContent = `· ${durationLabel(item.endSec - item.startSec)}`;
  if (item.id === clipId) {
    currentPreview = null;
    $('viewer-eyebrow').textContent = `CLIP ${String(project.clips.indexOf(item) + 1).padStart(2, '0')} / PREVIEW`;
    $('preview-badge').hidden = true; $('original-btn').hidden = true;
    player.pause(); loadVideo(media.previewUrl || media.url, item.startSec);
  }
  renderSelectionSummary(); renderRange(); renderBusy();
  saveSoon();
}
function changeSourceRange(bound, value) {
  const media = source();
  if (!media) return;
  if (value === '' || !Number.isFinite(Number(value))) value = media[bound] ?? (bound === 'rangeStart' ? 0 : media.durationSec);
  const minimum = Math.min(.1, media.durationSec);
  if (bound === 'rangeStart') media.rangeStart = clamp(value, 0, (media.rangeEnd ?? media.durationSec) - minimum);
  else media.rangeEnd = clamp(value, (media.rangeStart ?? 0) + minimum, media.durationSec);
  document.querySelectorAll('[data-source-bound]').forEach((input) => { input.value = String(media[input.dataset.sourceBound]); });
  renderRange(); renderBusy(); saveSoon();
}
document.addEventListener('change', (event) => {
  const element = event.target;
  if (busy()) return;
  if (element.dataset.setting) {
    const key = element.dataset.setting;
    const values = { targetSec: [1, 3600], clipSec: [2, 20], maxCandidates: [1, 48], fps: [24, 60] };
    const value = key in values ? element.value === '' ? project.settings[key] : clamp(element.value, ...values[key]) : element.value;
    if (typeof value === 'number' && !Number.isFinite(value)) return renderInspector();
    project.settings[key] = value;
    element.value = String(value);
    if (element.type === 'range') syncRangeStyle(element);
    saveSoon(); renderSelectionSummary();
    if (element.type !== 'number' && element.type !== 'range') renderInspector();
    renderBusy();
  } else if (element.dataset.quality) {
    project.settings.quality[element.dataset.quality] = element.type === 'checkbox' ? element.checked : Number(element.value);
    saveSoon();
  } else if (element.dataset.sourceBound) changeSourceRange(element.dataset.sourceBound, element.value);
  else if (element.dataset.clipBound) changeClipRange(element.dataset.id, element.dataset.clipBound, element.value);
  else if (element.dataset.trim) {
    const bound = element.dataset.trim === 'start' ? 'startSec' : 'endSec';
    if (clip()) changeClipRange(clipId, bound, element.value);
    else changeSourceRange(bound === 'startSec' ? 'rangeStart' : 'rangeEnd', element.value);
  } else if (element.dataset.action === 'select-clip') {
    const item = project.clips.find((entry) => entry.id === element.dataset.id);
    if (item) item.selected = element.checked;
    saveSoon(); renderClips(); renderInspector(); renderBusy();
  }
});
document.addEventListener('input', (event) => {
  const element = event.target;
  if (element.type === 'range') syncRangeStyle(element);
  if (busy()) return;
  // Native number fields fire change only on blur. Keep valid drafts in state on
  // input as well, so a delayed connection response cannot redraw an old value.
  if (element.dataset.setting) {
    const key = element.dataset.setting;
    if (element.type === 'number' || element.type === 'range') {
      const value = Number(element.value);
      if (element.value !== '' && Number.isFinite(value) && value >= Number(element.min || 0) && value <= Number(element.max || Infinity)) {
        project.settings[key] = value;
        saveSoon();
      }
    } else if (element.type !== 'radio' || element.checked) {
      project.settings[key] = ['maxCandidates', 'fps'].includes(key) ? Number(element.value) : element.value;
      saveSoon();
    }
  }
  if (element.dataset.quality) {
    project.settings.quality[element.dataset.quality] = element.type === 'checkbox' ? element.checked : Number(element.value);
    saveSoon();
  }
  if (element.dataset.sourceBound || element.dataset.clipBound) {
    const item = element.dataset.sourceBound ? source() : project.clips.find((entry) => entry.id === element.dataset.id);
    const media = element.dataset.sourceBound ? item : project.sources.find((entry) => entry.id === item?.sourceId);
    const key = element.dataset.sourceBound || element.dataset.clipBound;
    const value = Number(element.value);
    if (item && media && element.value !== '' && Number.isFinite(value)) {
      const start = key === 'rangeStart' || key === 'startSec' ? value : item.rangeStart ?? item.startSec;
      const end = key === 'rangeEnd' || key === 'endSec' ? value : item.rangeEnd ?? item.endSec;
      if (start >= 0 && end <= media.durationSec && end - start >= Math.min(.1, media.durationSec)) { item[key] = value; saveSoon(); }
    }
  }
  if (element.dataset.setting === 'clipSec') $('clip-length-value').textContent = `${element.value}초`;
  if (element.dataset.quality && element.type === 'range') {
    const key = element.dataset.quality;
    const value = Number(element.value);
    const output = $(`value-${key}`);
    if (output) output.textContent = key === 'exposure' ? `${value > 0 ? '+' : ''}${Math.round(value * 100)}` : `${Math.round(value * 100)}%`;
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (button?.disabled) return;
  if (button?.dataset.theme) { setTheme(button.dataset.theme); return; }
  const nextStep = button?.dataset.step;
  if (nextStep) { step = nextStep; render(); return; }
  const preset = button?.dataset.preset;
  if (preset && !busy()) {
    const presets = { natural: { denoise: .25, sharpen: .25, exposure: 0, saturation: 1.03 }, clear: { denoise: .2, sharpen: .65, exposure: .01, saturation: 1.15 }, lowlight: { denoise: .65, sharpen: .2, exposure: .08, saturation: 1.05 } };
    Object.assign(project.settings.quality, presets[preset]); saveSoon(); renderInspector(); renderBusy();
    document.querySelector(`[data-preset="${preset}"]`)?.classList.add('active'); return;
  }
  const action = button?.dataset.action;
  const id = button?.dataset.id;
  if (action === 'play-clip') { showClip(id, true); return; }
  if (busy() && action) return;
  try {
    if (action === 'import') { $('file-input').click(); return; }
    if (action === 'remove-source') {
      mutationBusy = true; renderBusy(); await saveNow();
      project = normalizeProject(await api(`/api/sources/${encodeURIComponent(id)}`, undefined, 'DELETE'));
      if (id === sourceId) showSource(project.sources[0]?.id || null);
      mutationBusy = false; render(); return;
    }
    if (action === 'add-clip') {
      const media = source(); if (!media) return;
      const length = Math.min(project.settings.clipSec, media.durationSec);
      const playhead = currentPreview ? (clip()?.startSec || 0) + player.currentTime : player.currentTime;
      const startSec = clamp(playhead, 0, Math.max(0, media.durationSec - length));
      const item = { id: crypto.randomUUID(), sourceId, startSec, endSec: Math.min(media.durationSec, startSec + length), selected: true, origin: 'manual', ai: false, score: 0, reason: '직접 고른 구간', thumbnail: media.thumbnail || null };
      project.clips.push(item); showClip(item.id); saveSoon(); return;
    }
    if (action === 'remove-clip') {
      project.clips = project.clips.filter((item) => item.id !== id);
      if (id === clipId) showSource(sourceId);
      saveSoon(); render(); return;
    }
    if (action === 'move-clip-up' || action === 'move-clip-down') {
      const index = project.clips.findIndex((item) => item.id === id);
      const next = index + (action === 'move-clip-up' ? -1 : 1);
      if (index >= 0 && next >= 0 && next < project.clips.length) [project.clips[index], project.clips[next]] = [project.clips[next], project.clips[index]];
      saveSoon(); render(); return;
    }
    if (action === 'analyze') {
      if (project.settings.model !== '' && system && !system.ollama?.available) throw new Error('Ollama를 실행하거나 ‘AI 없이 · 화질 점수로 선별’을 선택해 주세요.');
      await startJob('analyze', {}); return;
    }
    if (action === 'export') { if (!selected().length) throw new Error('먼저 저장할 클립을 선택해 주세요.'); await startJob('export', {}); return; }
    if (action === 'preview') {
      const item = clip() || selected()[0] || project.clips[0];
      if (!item) throw new Error('보정할 클립을 먼저 선택해 주세요.');
      showClip(item.id); await startJob('preview', { clipId: item.id, quality: project.settings.quality }); return;
    }
    if (action === 'proxy') { if (source()) await startJob('proxy', { sourceId }); return; }
    const sourceElement = event.target.closest('[data-source]');
    if (sourceElement) showSource(sourceElement.dataset.source);
  } catch (error) { report(error); mutationBusy = false; renderBusy(); }
});
document.addEventListener('keydown', (event) => {
  if (event.target.matches('[data-source]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); showSource(event.target.dataset.source); }
});

function renderJob(job) {
  $('job-panel').hidden = false;
  const names = { analyze: '좋은 장면을 찾고 있어요', export: '영상을 만들고 있어요', preview: '보정 미리보기 생성 중', proxy: '호환 미리보기 생성 중', upload: '원본 영상 가져오는 중' };
  $('job-title').textContent = names[job.type] || '작업 중';
  const percent = Math.round((job.progress || 0) * 100);
  $('job-percent').textContent = `${percent}%`;
  $('job-progress').value = job.progress || 0;
  $('job-message').textContent = job.message || '잠시만 기다려 주세요.';
}
async function startJob(type, body) {
  if (busy()) return;
  mutationBusy = true; renderBusy();
  try {
    await saveNow();
    const { jobId } = await api(`/api/${type}`, body);
    activeJob = { id: jobId, type, clipId: body.clipId };
    mutationBusy = false; renderBusy();
    renderJob({ type, progress: 0, message: '작업을 준비합니다.' });
    pollJob().catch(report);
  } catch (error) { mutationBusy = false; renderBusy(); throw error; }
}
async function pollJob() {
  if (!activeJob) return;
  const context = activeJob;
  const id = context.id;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (activeJob?.id !== id) return;
    renderJob(job);
    if (job.status === 'running' || job.status === 'queued') { setTimeout(() => { pollJob().catch(report); }, 1000); return; }
    // Keep the editor locked until the terminal job's project is loaded. A
    // slow refresh must never overwrite edits made just after completion.
    await reloadProject();
    activeJob = null; $('job-panel').hidden = true; renderBusy();
    if (job.status === 'error') throw new Error(job.error || job.message || '작업을 완료하지 못했습니다. 설정을 확인하고 다시 시도해 주세요.');
    if (job.status === 'canceled') { toast('작업을 취소했습니다. 원본과 저장된 작업은 유지됩니다.'); return; }
    const result = job.result || {};
    if (job.type === 'analyze') {
      if (project.clips.length) showClip(project.clips.find((item) => item.selected)?.id || project.clips[0].id);
      const count = result.aiCount || 0;
      const fallback = result.fallbackCount || 0;
      toast(`${count ? `AI 분석 ${count}구간` : '화질 점수 분석 완료'}${fallback ? ` · 화질 점수 대체 ${fallback}구간` : ''} · ${durationLabel(result.actualSec ?? selectedSeconds())} 선택${(result.actualSec ?? selectedSeconds()) + .1 < project.settings.targetSec ? ' (후보가 부족해 목표 길이보다 짧습니다)' : ''}`);
    } else if (job.type === 'preview') {
      const file = result.files?.[0];
      if (!file?.url) throw new Error('미리보기 파일을 찾지 못했습니다. 다시 생성해 주세요.');
      const previewClip = project.clips.find((item) => item.id === (result.clipId || context.clipId));
      if (!previewClip) throw new Error('미리보기의 원본 클립을 찾지 못했습니다. 클립을 선택해 다시 생성해 주세요.');
      showClip(previewClip.id);
      currentPreview = file.url; render(); loadVideo(file.url); player.play().catch(() => {});
    } else if (job.type === 'proxy') {
      const media = project.sources.find((item) => item.id === result.sourceId);
      if (media && result.url) media.previewUrl = result.url;
      if (sourceId === result.sourceId) clip() ? showClip(clipId) : showSource(sourceId, player.currentTime);
      toast('호환 미리보기가 준비되었습니다. 내보내기는 원본 영상으로 처리합니다.');
    } else if (job.type === 'export') {
      if (result.files?.length && !project.exports.some((entry) => entry.files?.some((file) => file.url === result.files[0].url))) project.exports.push({ id, files: result.files });
      renderOutputs(); $('outputs').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); toast('영상을 저장했습니다. 완성된 파일을 내려받을 수 있어요.');
    }
  } catch (error) {
    // A transient fetch failure must not unlock edits while the server job is running.
    if (activeJob?.id === id) {
      if (error.status === 404) {
        try {
          await reloadProject();
          activeJob = project.activeJob || null;
          $('job-panel').hidden = !activeJob;
          renderBusy();
          if (activeJob) { pollJob().catch(report); return; }
          toast('서버가 다시 시작되어 작업 상태가 초기화되었습니다. 저장된 클립으로 작업을 다시 시작해 주세요.', true);
          return;
        } catch (refreshError) { error = refreshError; }
      }
      $('job-message').textContent = `작업 상태 연결이 끊겼습니다. 3초 후 다시 확인합니다. (${error.message})`;
      setTimeout(() => { pollJob().catch(report); }, 3000);
    } else report(error);
  }
}
$('cancel-job').addEventListener('click', async () => {
  try {
    if (uploading) { uploadCanceled = true; currentUpload?.abort(); $('job-message').textContent = '영상 가져오기를 취소하고 있습니다…'; return; }
    if (!activeJob) return;
    $('cancel-job').disabled = true;
    await api(`/api/jobs/${encodeURIComponent(activeJob.id)}/cancel`, {});
    $('job-message').textContent = '작업을 정리하고 있습니다…';
  } catch (error) { report(error); }
  finally { $('cancel-job').disabled = false; }
});

function uploadFile(file, index, count) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); currentUpload = xhr;
    xhr.open('POST', '/api/import');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.addEventListener('progress', (event) => {
      renderJob({ type: 'upload', progress: (index + (event.lengthComputable ? event.loaded / event.total : 0)) / count, message: `${index + 1}/${count} · ${file.name}${event.loaded === event.total ? ' · 영상 정보 확인 중…' : ''}` });
    });
    xhr.addEventListener('load', () => {
      currentUpload = null;
      let result; try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('가져오기 응답을 읽지 못했습니다.')); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(new Error(result.error || '영상을 가져오지 못했습니다.'));
    });
    xhr.addEventListener('error', () => { currentUpload = null; reject(new Error('영상 가져오기 연결이 끊겼습니다. 로컬 서버를 확인해 주세요.')); });
    xhr.addEventListener('abort', () => { currentUpload = null; reject(new Error('영상 가져오기를 취소했습니다.')); });
    xhr.send(file);
  });
}
async function importFiles(files) {
  if (busy() || !files.length) return;
  uploading = true; uploadCanceled = false; renderBusy();
  renderJob({ type: 'upload', progress: 0, message: `${files.length}개 영상을 준비합니다.` });
  let imported = 0;
  try {
    await saveNow();
    for (let index = 0; index < files.length; index++) {
      if (uploadCanceled) break;
      const item = await uploadFile(files[index], index, files.length);
      await reloadProject();
      showSource(item.id || project.sources.at(-1)?.id);
      imported++;
    }
    toast(uploadCanceled ? `가져오기를 취소했습니다.${imported ? ` 완료된 ${imported}개 영상은 유지됩니다.` : ''}` : `${imported}개 영상을 가져왔습니다. 분석할 길이와 범위를 정해 주세요.`);
  } catch (error) {
    if (uploadCanceled) toast(`가져오기를 취소했습니다.${imported ? ` 완료된 ${imported}개 영상은 유지됩니다.` : ''}`);
    else report(error);
  }
  finally { uploading = false; uploadCanceled = false; currentUpload = null; $('job-panel').hidden = true; $('file-input').value = ''; renderBusy(); }
}
$('file-input').addEventListener('change', (event) => importFiles([...event.target.files]));
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); dragDepth++;
  if (!busy()) $('drop-overlay').hidden = false;
});
document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
document.addEventListener('drop', (event) => {
  event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
  if (event.dataTransfer?.files.length) importFiles([...event.dataTransfer.files]);
});

function renderConnection() {
  const ollama = system?.ollama;
  const ffmpeg = system?.ffmpeg;
  $('connection-label').textContent = !system ? '연결 확인 중' : ollama?.available ? 'Ollama 연결됨' : 'Ollama 확인 필요';
  $('connection-btn').querySelector('.status-dot').classList.toggle('off', !!system && !ollama?.available);
  $('connection-detail').innerHTML = `<div class="connection-entry"><strong>Ollama 비전 AI <span>${!system ? '확인 중…' : ollama?.available ? '연결됨' : '연결되지 않음'}</span></strong><p>기존 프로젝트에서 사용하던 로컬 비전 모델을 그대로 연결합니다. 원본 영상은 외부로 전송하지 않습니다.</p><code>${esc(ollama?.baseUrl || 'http://127.0.0.1:11434')}</code>${ollama?.models?.length ? `<ul>${ollama.models.map((item) => `<li>${esc(item.name)}${item.parameterSize ? ` · ${esc(item.parameterSize)}` : ''}</li>`).join('')}</ul>` : '<p>설치된 비전 모델이 확인되지 않았습니다. Ollama를 실행한 뒤 다시 확인해 주세요.</p>'}${ollama?.error ? `<p class="error">${esc(ollama.error)}</p>` : ''}</div><div class="connection-entry"><strong>영상 처리 엔진 <span>${ffmpeg?.available ? 'FFmpeg 준비됨' : !system ? '확인 중…' : '설치 확인 필요'}</span></strong><code>${esc(ffmpeg?.path || 'FFmpeg 경로를 확인하고 있습니다.')}</code></div><div class="connection-entry"><strong>로컬 출력 폴더</strong><code>${esc(system?.outputDir || '확인 중…')}</code><p>작업은 자동으로 저장되며 다음 실행 때 이어집니다.</p></div>`;
}
async function refreshStatus() {
  $('refresh-connection').disabled = true;
  try {
    system = await api('/api/status');
    renderConnection();
    if (step === 'recommend') {
      const modelSelect = document.querySelector('[data-setting="model"]');
      if (modelSelect && modelSelect !== document.activeElement) modelSelect.innerHTML = modelOptions();
      const description = document.querySelector('.ai-description');
      if (description) {
        description.textContent = modelDescription();
        description.classList.toggle('warning', project.settings.model !== '' && !system.ollama?.available);
      }
    }
  }
  catch (error) { $('connection-label').textContent = '연결 확인 실패'; report(error); }
  finally { $('refresh-connection').disabled = false; }
}
$('connection-btn').addEventListener('click', () => { renderConnection(); $('connection-dialog').showModal(); });
$('close-connection').addEventListener('click', () => $('connection-dialog').close());
$('refresh-connection').addEventListener('click', refreshStatus);
$('retry-save').addEventListener('click', () => { if (!busy()) saveNow().catch(report); });
$('connection-dialog').addEventListener('click', (event) => {
  if (event.target !== $('connection-dialog')) return;
  const bounds = event.target.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('connection-dialog').close();
});
window.addEventListener('beforeunload', (event) => {
  if (uploading || mutationBusy || saveFailure || editRevision !== savedRevision) { event.preventDefault(); event.returnValue = ''; }
});

render();
refreshStatus();
async function initializeProject(retrying = false) {
  try {
    await reloadProject();
    initializing = false;
    $('save-status').textContent = '로컬에 저장됨';
    if (sourceId) showSource(sourceId);
    if (project.activeJob) { activeJob = project.activeJob; renderBusy(); pollJob().catch(report); }
    else renderBusy();
  } catch (error) {
    // A temporary startup disconnect must not leave a permanently locked,
    // empty workspace, nor allow that empty state to replace saved work.
    $('save-status').textContent = '작업 불러오기 재시도 중…';
    if (!retrying) report(error);
    setTimeout(() => { initializeProject(true); }, 3000);
  }
}
initializeProject();
