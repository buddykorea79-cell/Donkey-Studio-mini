import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { probeVideo, analyzeWindow, sourceThumbnail, listVisionModels, resolveOllamaBaseUrl, candidateWindows } from './vclip-core.mjs';
import { DEFAULT_SETTINGS, validateSettings, updateProject, recommendClips } from './project.mjs';
import { renderClips, createProxy, renderPreview } from './media.mjs';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VIDEO_EXT = new Set(['.mp4','.mov','.m4v','.mkv','.webm','.avi','.mts','.m2ts','.mpeg','.mpg']);
export function findFfmpeg() {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  const first = found.stdout?.trim().split(/\r?\n/)[0];
  if (first && existsSync(first)) return first;
  const bundled = path.resolve(process.env.DONQUI_STUDIO_PATH || 'D:/Donqui-Studio', 'electron/native/bin/win32-x64/ffmpeg-shared.exe');
  return existsSync(bundled) ? bundled : null;
}
async function jsonBody(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw new Error('요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('요청은 JSON 객체여야 합니다.');
  return body;
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function sendFile(req, res, file, type, download) {
  const info = await stat(file);
  let start = 0, end = info.size - 1;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  if (download) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(download);
  let status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': 'bytes */' + info.size }); res.end(); return; }
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    else start = Math.max(0, info.size - Number(range[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + info.size }); res.end(); return;
    }
    status = 206; headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + info.size;
  }
  headers['Content-Length'] = Math.max(0, end-start+1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
  await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
}
export async function createMiniServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.MINI_DATA_DIR || path.join(APP_ROOT, 'data'));
  const outputDir = path.resolve(options.outputDir || process.env.MINI_OUTPUT_DIR || path.join(APP_ROOT, 'output'));
  const sourceDir = path.join(dataDir, 'sources'), cacheDir = path.join(dataDir, 'cache');
  await Promise.all([sourceDir, cacheDir, outputDir].map(p => mkdir(p, { recursive: true })));
  const ffmpeg = options.ffmpeg || findFfmpeg();
  if (ffmpeg) process.env.MINI_FFMPEG = ffmpeg;
  const ollamaBaseUrl = resolveOllamaBaseUrl();
  const projectFile = path.join(dataDir, 'project.json');
  let project = { sources: [], clips: [], settings: structuredClone(DEFAULT_SETTINGS), exports: [] };
  try {
    const saved = JSON.parse(await readFile(projectFile, 'utf8'));
    if (!Array.isArray(saved.sources) || !Array.isArray(saved.clips)) throw new Error('저장 형식이 올바르지 않습니다.');
    project = { ...project, ...saved, settings: validateSettings(saved.settings) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('작업 파일을 읽을 수 없습니다. data/project.json을 확인해 주세요: ' + error.message);
  }
  let saving = Promise.resolve();
  function saveProject(next, signal, owner = activeJob) {
    const body = JSON.stringify(next, null, 2);
    saving = saving.catch(() => {}).then(async () => {
      const temp = projectFile + '.tmp';
      signal?.throwIfAborted();
      await writeFile(temp, body, 'utf8');
      if (signal?.aborted) { await unlink(temp).catch(() => {}); signal.throwIfAborted(); }
      // Renaming is the commit point. A cancellation arriving after this point must
      // not report a canceled job whose project was nevertheless committed.
      if (owner) owner.committing = true;
      try {
        await rename(temp, projectFile);
        project = next;
        if (owner) owner.committed = true;
      } finally { if (owner) owner.committing = false; }
    });
    return saving;
  }
  const publicProject = () => ({ ...project, activeJob: activeJob ? { id: activeJob.id, type: activeJob.type } : null, sources: project.sources.map(({ path: sourcePath, ...source }) => source) });
  const jobs = new Map();
  let activeJob = null, importing = null, mutating = false, stopping = false;
  const idle = () => {
    if (stopping) { const e = new Error('앱을 종료하는 중입니다.'); e.status = 503; throw e; }
    if (activeJob || importing || mutating) { const e = new Error('진행 중인 작업이 끝난 뒤 시도해 주세요.'); e.status = 409; throw e; }
  };
  const requireFfmpeg = () => { if (!ffmpeg) throw new Error('FFmpeg를 찾지 못했습니다. FFMPEG_PATH를 지정해 주세요.'); };
  function startJob(type, work) {
    idle(); requireFfmpeg();
    const id = randomUUID(), controller = new AbortController();
    const job = { id, type, status: 'running', progress: 0, message: '준비 중…', controller };
    jobs.set(id, job); activeJob = job;
    const progress = update => {
      job.progress = Math.max(0, Math.min(1, Number(update.progress) || 0));
      job.message = update.stage || update.message || job.message;
    };
    job.promise = Promise.resolve().then(() => work(controller.signal, progress, id)).then(result => {
      if (controller.signal.aborted) { job.status = 'canceled'; job.message = '작업을 취소했습니다.'; }
      else { job.status = 'done'; job.progress = 1; job.message = '완료'; job.result = result; }
    }).catch(error => {
      job.status = controller.signal.aborted ? 'canceled' : 'error';
      job.error = controller.signal.aborted ? '작업을 취소했습니다.' : error.message;
      job.message = job.error;
    }).finally(() => { if (activeJob === job) activeJob = null; });
    if (jobs.size > 80) for (const [key,value] of jobs) { if (value !== activeJob) { jobs.delete(key); break; } }
    return id;
  }
  const sourceById = id => {
    const source = project.sources.find(s => s.id === id);
    if (!source) { const e = new Error('영상을 찾을 수 없습니다.'); e.status = 404; throw e; }
    return source;
  };
  function outputFiles(files, jobId) {
    return files.map(({ path: filePath, ...file }) => ({ ...file, url: '/output/' + jobId + '/' + encodeURIComponent(path.basename(filePath)) }));
  }
  const server = http.createServer(async (req,res) => {
    try {
      res.setHeader('X-Content-Type-Options','nosniff');
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return json(res,403,{error:'로컬 접속만 허용됩니다.'});
      if (req.headers.origin && !['http://' + host, 'https://' + host].includes(req.headers.origin)) return json(res,403,{error:'다른 사이트에서는 이 앱에 접근할 수 없습니다.'});
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res,403,{error:'로컬 앱에서 다시 시도해 주세요.'});
      if (stopping) return json(res,503,{error:'앱을 종료하는 중입니다.'});
      const url = new URL(req.url, 'http://' + host);
      const route = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && route === '/api/health') return json(res,200,{app:'donkey-studio-mini',pid:process.pid});
      if (req.method === 'POST' && route === '/api/shutdown') {
        json(res,200,{ok:true});
        setTimeout(() => close().catch(console.error),25);
        return;
      }
      if (req.method === 'GET' && route === '/api/status') {
        return json(res,200,{ffmpeg:{available:!!ffmpeg,path:ffmpeg},ollama:await listVisionModels(ollamaBaseUrl),outputDir});
      }
      if (req.method === 'GET' && route === '/api/project') return json(res,200,publicProject());
      if (req.method === 'PUT' && route === '/api/project') {
        const input = await jsonBody(req);
        idle();
        const next = updateProject(project,input);
        mutating = true;
        try { await saveProject(next); return json(res,200,publicProject()); }
        finally { mutating = false; }
      }
      if (req.method === 'POST' && route === '/api/import') {
        idle(); requireFfmpeg();
        if (project.sources.length >= 30) throw new Error('한 작업에는 영상 30개까지 추가할 수 있습니다.');
        const name = path.basename(decodeURIComponent(req.headers['x-filename'] || 'video.mp4').replaceAll('\\','/'));
        const ext = path.extname(name).toLowerCase();
        if (!VIDEO_EXT.has(ext)) throw new Error('MP4, MOV, MKV, WebM 등 영상 파일을 선택해 주세요.');
        const id = randomUUID(), file = path.join(sourceDir,id+ext);
        const upload = {controller:new AbortController(),promise:null};
        importing = upload;
        const abort = () => { if (!upload.committing && !upload.committed) upload.controller.abort(); };
        const disconnected = () => { if (!res.writableFinished) abort(); };
        req.once('aborted',abort); res.once('close',disconnected);
        upload.promise = (async () => { try {
          const signal = upload.controller.signal;
          let total = 0;
          const limit = new Transform({transform(chunk,encoding,done) {
            total += chunk.length;
            done(total > 32*1024**3 ? new Error('파일은 32GB 이하로 선택해 주세요.') : null,chunk);
          }});
          await pipeline(req,limit,createWriteStream(file,{flags:'wx'}),{signal});
          const probe = await probeVideo(file,signal);
          signal.throwIfAborted();
          const thumbnail = await sourceThumbnail(file,Math.min(probe.durationSec/2,1),cacheDir,signal);
          signal.throwIfAborted();
          const source = {id,name,path:file,...probe,rangeStart:0,rangeEnd:probe.durationSec,url:'/media/'+id,thumbnail};
          await saveProject({...project,sources:[...project.sources,source]},signal,upload);
          const {path: omitted,...result} = source;
          return json(res,201,result);
        } catch(error) { await unlink(file).catch(()=>{}); throw error; }
        finally { req.off('aborted',abort); res.off('close',disconnected); importing=null; } })();
        return await upload.promise;
      }
      const sourceRoute = /^\/api\/sources\/([a-f0-9-]+)$/.exec(route);
      if (req.method === 'DELETE' && sourceRoute) {
        idle(); const source = sourceById(sourceRoute[1]);
        const next = {...project,sources:project.sources.filter(s=>s.id!==source.id),clips:project.clips.filter(c=>c.sourceId!==source.id)};
        mutating = true;
        try { await saveProject(next); return json(res,200,publicProject()); }
        finally { mutating = false; }
      }
      if (req.method === 'POST' && route === '/api/analyze') {
        await jsonBody(req);
        if (!project.sources.length) throw new Error('먼저 영상을 추가해 주세요.');
        const jobId = startJob('analyze',async(signal,progress,id)=>{
          const s = project.settings;
          const fetchModels = (url,options={}) => fetch(url,{...options,signal:AbortSignal.any([signal,options.signal].filter(Boolean))});
          const models = s.model ? await listVisionModels(ollamaBaseUrl,fetchModels) : {models:[]};
          signal.throwIfAborted();
          const model = s.model === '' ? null : s.model === 'auto' ? models.models[0]?.name || null : s.model;
          if (s.model && !model) throw new Error('Ollama 비전 모델에 연결되지 않았습니다. AI 설정을 확인하거나 화질 점수 분석을 선택해 주세요.');
          const windows = project.sources.flatMap(source => {
            const count = Math.min(Math.max(s.maxCandidates,Math.ceil(s.targetSec/s.clipSec/project.sources.length)),Math.max(2,Math.floor(240/project.sources.length)));
            return candidateWindows(source.rangeEnd-source.rangeStart,s.clipSec,count).map(window=>({
              source, startSec:window.startSec+source.rangeStart,endSec:window.endSec+source.rangeStart,
            }));
          });
          const candidates = [];
          for (const [index,window] of windows.entries()) {
            signal.throwIfAborted();
            progress({progress:index/windows.length,stage:window.source.name+' · '+(index+1)+' / '+windows.length+' 구간 분석'});
            const analysis = await analyzeWindow({jobId:id,sourcePath:window.source.path,startSec:window.startSec,endSec:window.endSec,model,title:window.source.name},
              {cacheDir,ollamaBaseUrl,signal});
            candidates.push({id:randomUUID(),sourceId:window.source.id,...analysis,ai:!!analysis.ai,origin:'auto',selected:false});
          }
          signal.throwIfAborted();
          const chosen = recommendClips(candidates,s.targetSec);
          await saveProject({...project,clips:[...project.clips.filter(c=>c.origin==='manual').map(c=>({...c,selected:false})),...chosen]},signal);
          return {clips:project.clips,actualSec:chosen.filter(c=>c.selected).reduce((n,c)=>n+c.endSec-c.startSec,0),targetSec:s.targetSec,
            aiCount:candidates.filter(c=>c.ai).length,fallbackCount:candidates.filter(c=>!c.ai).length};
        });
        return json(res,202,{jobId});
      }
      if (req.method === 'POST' && route === '/api/export') {
        await jsonBody(req);
        const clips = project.clips.filter(c=>c.selected);
        if (!clips.length) throw new Error('저장할 클립을 선택해 주세요.');
        const jobId = startJob('export',async(signal,onProgress,id)=>{
          const rendered = await renderClips({ffmpeg,sources:project.sources,clips,...project.settings,outputDir:path.join(outputDir,id),signal,onProgress});
          const result = {files:outputFiles(rendered.files,id)};
          await saveProject({...project,exports:[...(project.exports||[]),{id,createdAt:new Date().toISOString(),...result}].slice(-30)},signal);
          return result;
        });
        return json(res,202,{jobId});
      }
      if (req.method === 'POST' && route === '/api/proxy') {
        const {sourceId} = await jsonBody(req); const source = sourceById(sourceId);
        const jobId = startJob('proxy',async(signal,onProgress,id)=>{
          const target = path.join(outputDir,id); await mkdir(target,{recursive:true});
          await createProxy({ffmpeg,source,outputPath:path.join(target,'preview.mp4'),signal,onProgress});
          const previewUrl='/output/'+id+'/preview.mp4';
          await saveProject({...project,sources:project.sources.map(item=>item.id===sourceId?{...item,previewUrl}:item)},signal);
          return {sourceId,url:previewUrl};
        });
        return json(res,202,{jobId});
      }
      if (req.method === 'POST' && route === '/api/preview') {
        const {clipId,quality} = await jsonBody(req);
        const clip=project.clips.find(c=>c.id===clipId);
        if (!clip) throw new Error('미리 볼 클립을 먼저 선택해 주세요.');
        const source=sourceById(clip.sourceId);
        const validated = updateProject(project,{settings:{quality}}).settings.quality;
        const jobId=startJob('preview',async(signal,onProgress,id)=>{
          const target=path.join(outputDir,id); await mkdir(target,{recursive:true});
          const file=path.join(target,'enhanced-preview.mp4');
          await renderPreview({ffmpeg,source,clip,quality:validated,outputPath:file,signal,onProgress});
          return {clipId:clip.id,sourceId:source.id,files:[{name:'보정 미리보기',kind:'preview',url:'/output/'+id+'/enhanced-preview.mp4'}]};
        });
        return json(res,202,{jobId});
      }
      const jobRoute=/^\/api\/jobs\/([a-f0-9-]+)(\/cancel)?$/.exec(route);
      if(jobRoute){
        const job=jobs.get(jobRoute[1]);
        if(!job) return json(res,404,{error:'작업을 찾을 수 없습니다.'});
        if(req.method==='POST'&&jobRoute[2]) { if(job.status==='running'&&!job.committing&&!job.committed)job.controller.abort(); return json(res,200,{ok:true}); }
        if(req.method==='GET'&&!jobRoute[2]) { const {controller,promise,committing,committed,...info}=job; return json(res,200,info); }
      }
      const mediaRoute=/^\/media\/([a-f0-9-]+)$/.exec(route);
      if((req.method==='GET'||req.method==='HEAD')&&mediaRoute) {
        const source=sourceById(mediaRoute[1]);
        return await sendFile(req,res,source.path,path.extname(source.path)==='.webm'?'video/webm':'video/mp4');
      }
      const outputRoute=/^\/output\/([a-f0-9-]+)\/([^/\\]+\.mp4)$/.exec(route);
      if((req.method==='GET'||req.method==='HEAD')&&outputRoute) {
        const file=path.join(outputDir,outputRoute[1],outputRoute[2]);
        return await sendFile(req,res,file,'video/mp4',url.searchParams.has('download')?outputRoute[2]:null);
      }
      const staticFiles={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/donkey.svg':'donkey.svg'};
      if((req.method==='GET'||req.method==='HEAD')&&staticFiles[route]){
        const type=route.endsWith('.svg')?'image/svg+xml':route.endsWith('.js')?'text/javascript; charset=utf-8':route.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
        return await sendFile(req,res,path.join(APP_ROOT,'public',staticFiles[route]),type);
      }
      json(res,404,{error:'경로를 찾을 수 없습니다.'});
    }catch(error){
      if(!res.headersSent&&!res.destroyed)json(res,error.status|| (error.code==='ENOENT'?404:400),{error:error.message});
      else if(!res.destroyed)res.end();
    }
  });
  server.requestTimeout=0;
  let closing = null;
  function close() {
    if (!closing) {
      stopping = true;
      closing = (async () => {
        const job = activeJob, upload = importing;
        if (job && !job.committing && !job.committed) job.controller.abort();
        if (upload && !upload.committing && !upload.committed) upload.controller.abort();
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await Promise.allSettled([job?.promise,upload?.promise,saving]);
        await closed;
      })();
    }
    return closing;
  }
  return {server,ffmpeg,close};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createMiniServer();
  const port=Number(process.env.PORT||4310);
  app.server.listen(port,'127.0.0.1',()=>console.log('Donkey-Studio Mini: http://127.0.0.1:'+port));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit()));
  app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'이미 실행 중이거나 포트가 사용 중입니다: '+port:error.message);process.exitCode=1;});
}
