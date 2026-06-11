import { BACKGROUNDS, getSkin, getBackground } from '../lib/presets.js';
import { drawScene, buildZoomSegments, preloadBackground, drawCamera, cameraRect } from './render.js';
import {
  getRecording, listRecordings, deleteRecording, saveRecording,
  getProject, saveProject, getAllProjects,
  getSessions, getSessionChunks, deleteSession,
} from '../lib/db.js';
import { exportMedia } from './exporter.js';

const $ = (id) => document.getElementById(id);
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// 背景色块预览:壁纸本身就是图片,直接当缩略图用,所见即所得
const RAW = { background: getBackground('none'), padding: 0, radius: 0, shadow: 0, accent: '#FF6B4A', clickFx: false, autoZoom: false, zoomLevel: 1 };

// ---- 状态 ----
let cfg, data, rawBlob, recMeta;
let video, canvas, ctx, W, H;
let beautify = false, fmtSel = 'mp4';
let videoDur = 0, total = 0;        // total = 剪辑后总时长(master 毫秒)
let viewStart = 0, viewEnd = 0;     // 时间轴可视窗口(源毫秒);滚轮缩放用,长录像也能精确到帧
let segments = [];                  // 剪辑模型:保留片段 [{s,e,speed}](源毫秒,升序、互不重叠)
let sel = null;                     // 选区 {a,b} 源毫秒;null = 无
let playSrc = 0, playIdx = 0;       // 预览:当前源位置 / 正在播放的片段下标
let seeking = false;                // 跨片段切换时的 seek 进行中标志,防止 frame() 竞态连跳
let history = [];                   // 剪辑撤销栈(segments 快照)
let exportSize = 'orig';            // 导出尺寸:orig / 1080 / 720
let playing = false, exporting = false;
let currentSkinId = 'huashu';
let camVideo = null, camDur = 0, camOffset = 0; // 摄像头轨:独立 video 元素 + 与屏幕轨的起点偏移
let camCfg = null;                              // 气泡配置 {show,x,y,size,shape,beauty,mirror,ring}
let savedCamPrefs = null;                       // 本段没有摄像头轨时,保住已存的摄像头偏好不被 savePrefs 覆盖
let proj = null, projTimer = null;              // 本段录制的编辑工程(剪辑/美化/摄像头),防抖持久化,关页不丢

const id = new URLSearchParams(location.search).get('id');
if (id) loadEditor(id); else showLibrary();

// ================= 录制库 =================
async function showLibrary() {
  $('libraryView').hidden = false;
  showStorageUsage();
  await showOrphans();
  const [rows, projects] = await Promise.all([listRecordings(), getAllProjects().catch(() => [])]);
  const pmap = new Map(projects.map((p) => [p.id, p]));
  if (!rows.length) { $('recEmpty').hidden = false; return; }
  const list = $('recList'); list.innerHTML = '';
  for (const r of rows) {
    const p = pmap.get(r.id);
    const dur = r.meta?.durationMs ? fmt(r.meta.durationMs) : '—';
    const when = r.meta?.createdAt ? new Date(r.meta.createdAt).toLocaleString('zh-CN') : '';
    const name = p?.title || `录制 · ${dur}`;
    const el = document.createElement('div');
    el.className = 'rec-item';
    el.innerHTML = `<div class="poster">${p?.poster ? `<img src="${p.poster}" alt="" />` : ''}</div>
      <div class="meta"><div class="title"></div><div class="sub">${when} · ${dur} · ${(r.size / 1048576).toFixed(1)} MB${r.meta?.recovered ? ' · 已恢复' : ''}</div></div>
      <button class="btn-ghost" data-rename title="重命名">改名</button>
      <button class="btn-primary" data-open>编辑</button><button class="btn-ghost" data-del>删除</button>`;
    el.querySelector('.title').textContent = name;
    el.querySelector('[data-open]').onclick = () => { location.search = `?id=${r.id}`; };
    el.querySelector('[data-del]').onclick = async () => { await deleteRecording(r.id); el.remove(); showStorageUsage(); };
    el.querySelector('[data-rename]').onclick = async () => {
      const t = prompt('给这段录制起个名字:', p?.title || '');
      if (t === null) return;
      const row = (await getProject(r.id).catch(() => null)) || { id: r.id };
      row.title = t.trim();
      await saveProject(row);
      el.querySelector('.title').textContent = row.title || `录制 · ${dur}`;
    };
    list.appendChild(el);
  }
}

async function showStorageUsage() {
  try {
    const est = await navigator.storage.estimate();
    const gb = (n) => (n / 1073741824).toFixed(n > 1073741824 ? 1 : 2);
    $('storageInfo').textContent = `本地已用 ${gb(est.usage)} GB / 可用约 ${gb(est.quota)} GB`;
  } catch (_) {}
}

// 孤儿会话 = 录到一半浏览器崩了留下的切片。WebM 是流式格式,半截也能拼回可播的录像。
async function showOrphans() {
  let sessions = [];
  try { sessions = await getSessions(); } catch (_) { return; }
  if (!sessions.length) return;
  // 正在录制的会话不是孤儿,别提示恢复
  const st = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null);
  if (st && st.status !== 'idle') return;
  const wrap = $('recoverList'); wrap.innerHTML = ''; wrap.hidden = false;
  for (const s of sessions) {
    const when = s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN') : '';
    const el = document.createElement('div');
    el.className = 'recover-item';
    el.innerHTML = `<span>⚠ 有一段录制中断了(${when}),已录部分仍可找回</span>
      <button class="btn-primary" data-rec>恢复</button><button class="btn-ghost" data-drop>丢弃</button>`;
    el.querySelector('[data-rec]').onclick = () => recoverSession(s, el);
    el.querySelector('[data-drop]').onclick = async () => { await deleteSession(s.session); el.remove(); showStorageUsage(); };
    wrap.appendChild(el);
  }
}

async function recoverSession(s, el) {
  el.querySelector('[data-rec]').textContent = '恢复中…';
  try {
    const rows = await getSessionChunks(s.session);
    const screen = rows.filter((r) => r.track === 'screen').map((r) => r.data);
    if (!screen.length) { await deleteSession(s.session); el.remove(); return; }
    const blob = new Blob(screen, { type: 'video/webm' });
    const camParts = rows.filter((r) => r.track === 'cam').map((r) => r.data);
    const camBlob = camParts.length ? new Blob(camParts, { type: 'video/webm' }) : null;
    // durationMs 未知(=0),编辑器打开时会自动探测;摄像头偏移凭会话行里记下的两个起点算
    const meta = { ...(s.meta || {}), createdAt: s.createdAt, durationMs: 0, recovered: true };
    if (camBlob) {
      meta.hasCam = true;
      meta.camOffsetMs = s.camStartTime && s.startTime ? s.camStartTime - s.startTime : 0;
    }
    const id = 'rec_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    await saveRecording({ id, blob, camBlob, cursor: [], clicks: [], acts: [], meta });
    await deleteSession(s.session);
    location.search = `?id=${id}`;
  } catch (e) {
    alert('恢复失败:' + e.message);
    el.querySelector('[data-rec]').textContent = '恢复';
  }
}

// ================= 编辑器 =================
async function loadEditor(recId) {
  $('editorView').hidden = false;
  const rec = await getRecording(recId);
  if (!rec || !rec.blob) { alert('找不到这段录制'); location.search = ''; return; }
  rawBlob = rec.blob; recMeta = rec.meta || {};
  proj = (await getProject(recId).catch(() => null)) || { id: recId };
  // 「停止·直接下载」路径:一打开就自动存下源片,用户拿了文件可直接关页(也可留下来继续修)
  if (new URLSearchParams(location.search).get('dl') === '1') setTimeout(() => download(rawBlob, 'webm'), 300);

  canvas = $('canvas'); ctx = canvas.getContext('2d');
  video = document.createElement('video');
  video.src = URL.createObjectURL(rec.blob);
  video.preload = 'auto'; video.playsInline = true;
  video.style.cssText = 'position:fixed;left:-99999px;width:480px;';
  document.body.appendChild(video);

  await once(video, 'loadedmetadata');
  await prepDuration();
  await new Promise((res) => { video.currentTime = 0; once(video, 'seeked').then(res); });

  W = (video.videoWidth || recMeta.width || 1280); W -= W % 2;
  H = (video.videoHeight || recMeta.height || 720); H -= H % 2;
  canvas.width = W; canvas.height = H;
  videoDur = (isFinite(video.duration) ? video.duration : (recMeta.durationMs || 0) / 1000) * 1000;
  segments = [{ s: 0, e: videoDur, speed: 1 }]; playSrc = 0; playIdx = 0;
  viewStart = 0; viewEnd = videoDur;
  // 恢复上次的剪辑(工程持久化):片段裁到当前时长内,全失效就回退整段
  if (proj.segments && proj.segments.length) {
    const kept = proj.segments
      .filter((s) => s.s >= 0 && s.s < videoDur && s.e > s.s)
      .map((s) => ({ s: s.s, e: Math.min(s.e, videoDur), speed: s.speed || 1 }));
    if (kept.length) segments = kept;
  }

  data = { cursor: rec.cursor || [], clicks: rec.clicks || [], acts: rec.acts || [], zoomSegs: buildZoomSegments(rec.clicks || []) };
  // 诊断:自动放大/点击波纹都依赖录制时采到的点击;为空就直接告诉花叔,免得以为功能坏了
  const nClick = data.clicks.length;
  $('trackInfo').textContent = nClick > 0
    ? `本次录制采集到 ${nClick} 次点击,运镜与波纹生效`
    : '⚠ 本次录制没有采集到点击 — 自动放大与波纹将无效果';
  $('trackInfo').style.color = nClick > 0 ? '' : '#ff8163';

  // 载入上次皮肤(记忆)。默认直接进「美化」:这是产品的核心价值,也避免新手进来看到空面板犯懵。
  const prefs = await loadPrefs();
  applySkin(getSkin(prefs.skinId || recMeta.skinId || 'huashu'), prefs);
  beautify = true;
  // 本段录制有工程就用工程(对这一段的决定优先于全局偏好)
  if (proj.cfg) {
    const pc = proj.cfg;
    cfg = {
      background: getBackground(pc.background), padding: pc.padding, radius: pc.radius, shadow: pc.shadow,
      accent: cfg.accent, clickFx: pc.clickFx, cursor: pc.cursor, autoZoom: pc.autoZoom, zoomLevel: pc.zoomLevel,
    };
  }
  if (typeof proj.beautify === 'boolean') beautify = proj.beautify;
  document.querySelectorAll('#beautifySeg button').forEach((b) => b.classList.toggle('on', b.dataset.b === (beautify ? '1' : '0')));
  preloadBackground(cfg.background); // 壁纸解码完成后帧循环自然画上

  // 摄像头轨:有就建第二个 video,气泡浮在画面上(位置/大小/样式/美颜都在这里调)
  savedCamPrefs = prefs.camera || null;
  if (rec.camBlob) {
    camVideo = document.createElement('video');
    camVideo.src = URL.createObjectURL(rec.camBlob);
    camVideo.preload = 'auto'; camVideo.muted = true; camVideo.playsInline = true;
    camVideo.style.cssText = 'position:fixed;left:-99999px;width:240px;';
    document.body.appendChild(camVideo);
    await once(camVideo, 'loadedmetadata');
    camDur = isFinite(camVideo.duration) && camVideo.duration > 0 ? camVideo.duration * 1000 : videoDur;
    camOffset = recMeta.camOffsetMs || 0;
    // 配置优先级:本段工程 > 全局偏好 > 默认;show 只存在工程里(藏不藏是对这一段的决定)
    camCfg = { x: 0.86, y: 0.82, size: 0.24, shape: 'circle', beauty: 0.4, mirror: true, ring: true, show: true, ...(savedCamPrefs || {}), ...(proj.camCfg || {}) };
    syncCam(true);
    bindCamControls(); syncCamControls();
  }

  buildBgChips(); markBg(cfg.background.id);
  bindSegments(); bindControls(); bindTransport(); bindTimeline(); bindKeys();
  syncBeautifyUI();
  recompute(); syncControls(); render(); syncTimeline();
  requestAnimationFrame(frame);
  if (!proj.poster) makePoster(); // 录制库封面,只生成一次
  buildFilmstrip(); // 异步生成缩略图,不阻塞首屏
}

function once(el, ev) { return new Promise((res) => el.addEventListener(ev, res, { once: true })); }
function prepDuration() {
  return new Promise((res) => {
    if (isFinite(video.duration) && video.duration > 0) return res();
    const onTime = () => { if (video.currentTime > 0) { video.removeEventListener('timeupdate', onTime); res(); } };
    video.addEventListener('timeupdate', onTime); video.currentTime = 1e7;
  });
}

// ---- 工程持久化(每段录制独立,关页不丢) ----
// 与大 blob 分开存(projects 表),滑杆级高频改动只写这一小行。
function scheduleProjectSave() {
  if (!proj) return;
  clearTimeout(projTimer);
  projTimer = setTimeout(() => {
    proj.segments = segments.map((s) => ({ ...s }));
    proj.beautify = beautify;
    proj.cfg = {
      background: cfg.background.id, padding: cfg.padding, radius: cfg.radius, shadow: cfg.shadow,
      clickFx: cfg.clickFx, cursor: cfg.cursor, autoZoom: cfg.autoZoom, zoomLevel: cfg.zoomLevel,
    };
    proj.camCfg = camCfg ? { ...camCfg } : null;
    proj.savedAt = Date.now();
    saveProject(proj).catch((e) => console.warn('工程保存失败:', e.message));
  }, 800);
}

// 库列表封面:抓当前帧(刚打开时是第 0 帧)缩成小图存进工程行
function makePoster() {
  try {
    const pw = 320, ph = Math.max(2, Math.round(320 * H / W));
    const pc = document.createElement('canvas'); pc.width = pw; pc.height = ph;
    pc.getContext('2d').drawImage(video, 0, 0, pw, ph);
    proj.poster = pc.toDataURL('image/jpeg', 0.7);
    scheduleProjectSave();
  } catch (_) {}
}

// ---- 偏好持久化 ----
async function loadPrefs() { const { editorPrefs } = await chrome.storage.local.get('editorPrefs'); return editorPrefs || {}; }
function savePrefs() {
  const camera = camCfg
    ? { x: camCfg.x, y: camCfg.y, size: camCfg.size, shape: camCfg.shape, beauty: camCfg.beauty, mirror: camCfg.mirror, ring: camCfg.ring }
    : savedCamPrefs;
  chrome.storage.local.set({ editorPrefs: {
    skinId: currentSkinId, padding: cfg.padding, radius: cfg.radius, shadow: cfg.shadow,
    background: cfg.background.id, autoZoom: cfg.autoZoom, zoomLevel: cfg.zoomLevel,
    clickFx: cfg.clickFx, cursor: cfg.cursor, camera,
  } });
  scheduleProjectSave(); // 全局偏好动了,本段工程也跟着记一笔
}

function applySkin(skin, prefs = {}) {
  currentSkinId = skin.id;
  cfg = {
    background: getBackground(prefs.background || skin.background),
    padding: prefs.padding ?? skin.padding,
    radius: prefs.radius ?? skin.radius,
    shadow: prefs.shadow ?? skin.shadow,
    accent: skin.accent,
    clickFx: prefs.clickFx ?? skin.clickFx,
    cursor: prefs.cursor ?? false, // 路径A 补画光标:默认关,避免与真实光标双影
    autoZoom: prefs.autoZoom ?? skin.autoZoom,
    zoomLevel: prefs.zoomLevel ?? (skin.autoZoom ? 1.6 : 1),
  };
}

// ---- 剪辑模型(多段保留,每段可独立变速)----
function masterDur(seg) { return (seg.e - seg.s) / seg.speed; }
function masterTotal() { return segments.reduce((t, s) => t + masterDur(s), 0); }
function recompute() { total = masterTotal(); }

// master 时间 → 源毫秒(+所在片段下标)
function masterToSource(ms) {
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const d = masterDur(segments[i]);
    if (ms < acc + d || i === segments.length - 1) {
      const within = Math.max(0, Math.min(d, ms - acc));
      return { idx: i, sourceMs: segments[i].s + within * segments[i].speed };
    }
    acc += d;
  }
  return { idx: 0, sourceMs: segments.length ? segments[0].s : 0 };
}
// 源毫秒 → master 时间(落在被删区间则归到最近保留点)
function sourceToMaster(src) {
  let acc = 0;
  for (const seg of segments) {
    if (src < seg.s) return acc;
    if (src <= seg.e) return acc + (src - seg.s) / seg.speed;
    acc += masterDur(seg);
  }
  return acc;
}
// 删除源区间 [a,b](挖空中间 / 切头尾都靠这个);不允许删空
function deleteRange(a, b) {
  if (b - a < 1) return;
  const next = [];
  for (const seg of segments) {
    if (b <= seg.s || a >= seg.e) { next.push(seg); continue; }
    if (a > seg.s) next.push({ s: seg.s, e: a, speed: seg.speed });
    if (b < seg.e) next.push({ s: b, e: seg.e, speed: seg.speed });
  }
  const kept = next.filter((s) => s.e - s.s > 10);
  if (kept.length) segments = kept;
}
// 给源区间 [a,b] 设速度,再合并同速相邻段
function setSpeedRange(a, b, sp) {
  const next = [];
  for (const seg of segments) {
    if (b <= seg.s || a >= seg.e) { next.push(seg); continue; }
    const lo = Math.max(a, seg.s), hi = Math.min(b, seg.e);
    if (seg.s < lo) next.push({ s: seg.s, e: lo, speed: seg.speed });
    next.push({ s: lo, e: hi, speed: sp });
    if (hi < seg.e) next.push({ s: hi, e: seg.e, speed: seg.speed });
  }
  next.sort((x, y) => x.s - y.s);
  const merged = [];
  for (const s of next) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.e - s.s) < 1 && last.speed === s.speed) last.e = s.e;
    else merged.push({ ...s });
  }
  segments = merged;
}

// ---- 渲染 ----
function curCfg() { return beautify ? cfg : RAW; }
function render() {
  if (!ctx || exporting) return;
  drawScene(ctx, video, video.currentTime * 1000, curCfg(), data, W, H);
  if (camVideo && camCfg) drawCamera(ctx, camVideo, camCfg, W, H);
}

// ---- 摄像头轨同步:摄像头时间 = 屏幕源时间 - 起点偏移 ----
function camTimeFor(srcMs) { return Math.max(0, Math.min(camDur - 30, srcMs - camOffset)) / 1000; }
// 暂停态强制对齐;播放态只纠 >150ms 的漂移,避免每帧 seek 卡顿
function syncCam(force = false) {
  if (!camVideo) return;
  const want = camTimeFor(video.currentTime * 1000);
  if (force || Math.abs(camVideo.currentTime - want) > 0.15) camVideo.currentTime = want;
}

function frame() {
  requestAnimationFrame(frame);
  if (exporting) return;
  if (playing) {
    const seg = segments[playIdx];
    if (!seg) { finishPlayback(); }
    else if (!seeking) { // seek 未落定前不检测边界,避免 currentTime 滞后导致连跳几段
      if (video.paused) { video.playbackRate = seg.speed; video.play().catch(() => {}); }
      const src = video.currentTime * 1000;
      if (video.ended || src >= seg.e - 15) {
        if (playIdx + 1 < segments.length) {
          playIdx++; playSrc = segments[playIdx].s;
          seeking = true;
          once(video, 'seeked').then(() => { seeking = false; });
          video.currentTime = playSrc / 1000; video.playbackRate = segments[playIdx].speed;
        } else { playSrc = seg.e; finishPlayback(); }
      } else { playSrc = src; }
      if (camVideo) {
        if (camVideo.paused) camVideo.play().catch(() => {});
        if (camVideo.playbackRate !== video.playbackRate) camVideo.playbackRate = video.playbackRate;
        syncCam();
      }
    }
  }
  render(); syncTimeline();
}

function finishPlayback() { playing = false; video.pause(); if (camVideo) camVideo.pause(); $('play').textContent = '▶'; }
function pausePlayback() { if (playing) { playing = false; video.pause(); if (camVideo) camVideo.pause(); $('play').textContent = '▶'; } }
function seekVideo(ms) { const t = Math.max(0, Math.min(videoDur - 30, ms)) / 1000; if (isFinite(t)) { video.currentTime = t; if (camVideo) camVideo.currentTime = camTimeFor(t * 1000); } }

function syncTimeline() {
  const dur = videoDur || 1;
  const span = (viewEnd - viewStart) || dur;
  const pct = (ms) => ((ms - viewStart) / span * 100) + '%';
  // 胶片图按可视窗口缩放/平移(背景图覆盖整段,用 size+position 取子区间,不必重新生成缩略图)
  const fs = $('filmstrip');
  if (span < dur - 1) { fs.style.backgroundSize = (dur / span * 100) + '% 100%'; fs.style.backgroundPositionX = (viewStart / (dur - span) * 100) + '%'; }
  else { fs.style.backgroundSize = '100% 100%'; fs.style.backgroundPositionX = '0%'; }
  const gaps = $('gaps'), tags = $('speedTags');
  gaps.innerHTML = ''; tags.innerHTML = '';
  // 被删区间 = [0,videoDur] 中未被任何保留片段覆盖的部分 → 斜纹
  let cur = 0;
  const sorted = [...segments].sort((a, b) => a.s - b.s);
  for (const seg of sorted) {
    if (seg.s > cur) gaps.appendChild(makeBox('gap', pct(cur), pct(seg.s - cur)));
    if (seg.speed !== 1) { const t = makeBox('speed-tag', pct(seg.s), pct(seg.e - seg.s)); t.innerHTML = `<span>${seg.speed}×</span>`; tags.appendChild(t); }
    cur = Math.max(cur, seg.e);
  }
  if (cur < dur) gaps.appendChild(makeBox('gap', pct(cur), pct(dur - cur)));
  const band = $('selBand');
  if (sel) { band.hidden = false; band.style.left = pct(sel.a); band.style.width = pct(sel.b - sel.a); }
  else band.hidden = true;
  $('playhead2').style.left = pct(playSrc);
  $('curTime').textContent = fmt(sourceToMaster(playSrc));
  $('durTime').textContent = fmt(total);
}
function makeBox(cls, left, width) { const d = document.createElement('div'); d.className = cls; d.style.left = left; d.style.width = width; return d; }

// 生成胶片缩略图(看得见在剪哪一段)。会临时 seek 视频,完成后跳回 playSrc。
async function buildFilmstrip() {
  // 帧数随时长加密:短片 14 帧够,长片到 24 帧(更密则首屏 seek 太慢,不值)
  const N = Math.min(24, Math.max(14, Math.floor(videoDur / 4000))), tw = 160, th = Math.max(2, Math.round(160 * H / W));
  const strip = document.createElement('canvas'); strip.width = tw * N; strip.height = th;
  const sctx = strip.getContext('2d');
  for (let i = 0; i < N; i++) {
    await seekTo(Math.max(0, Math.min(videoDur / 1000 - 0.05, (i + 0.5) / N * (videoDur / 1000))));
    try { sctx.drawImage(video, i * tw, 0, tw, th); } catch (_) {}
  }
  try { $('filmstrip').style.backgroundImage = `url(${strip.toDataURL('image/jpeg', 0.62)})`; } catch (_) {}
  await seekTo(playSrc / 1000); syncCam(true); render(); syncTimeline();
}

// ---- 播放控制 ----
function bindTransport() {
  $('play').onclick = togglePlay;
  $('export').onclick = doExport;
  $('downloadRaw').onclick = () => download(rawBlob, 'webm');
}
function togglePlay() {
  if (exporting) return;
  if (!playing) { locatePlay(playSrc); playing = true; $('play').textContent = '❚❚'; }
  else pausePlayback();
}
// 把 playSrc 对齐到某个保留片段:落在 gap 里推进到下一段开头,超尾则从头
function locatePlay(src) {
  for (let i = 0; i < segments.length; i++) {
    if (src < segments[i].s) { playIdx = i; playSrc = segments[i].s; seekVideo(playSrc); return; }
    if (src <= segments[i].e - 15) { playIdx = i; playSrc = src; seekVideo(playSrc); return; }
  }
  playIdx = 0; playSrc = segments[0].s; seekVideo(playSrc);
}

// 跳转预览到某个源位置(暂停态)
function seekPreview(src) {
  playSrc = Math.max(0, Math.min(videoDur, src));
  once(video, 'seeked').then(() => { render(); syncTimeline(); });
  seekVideo(playSrc); render(); syncTimeline();
}

// ---- 时间轴交互:拖选区 / 单击定位 / 双击全选 / 选区操作 ----
function bindTimeline() {
  const wrap = $('stripWrap');
  const xToMs = (clientX) => {
    const r = wrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return viewStart + frac * ((viewEnd - viewStart) || videoDur);
  };
  // 滚轮缩放:以指针处为锚点放大/缩小可视窗口(长录像可精确到帧),滚到底自动复位整段
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const span = (viewEnd - viewStart) || videoDur;
    const anchor = viewStart + frac * span;
    const nspan = Math.min(videoDur, Math.max(400, span * (e.deltaY < 0 ? 0.8 : 1.25)));
    let ns = anchor - frac * nspan, ne = ns + nspan;
    if (ns < 0) { ns = 0; ne = nspan; }
    if (ne > videoDur) { ne = videoDur; ns = videoDur - nspan; }
    viewStart = Math.max(0, ns); viewEnd = Math.min(videoDur, ne);
    syncTimeline();
  }, { passive: false });
  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault(); wrap.setPointerCapture(e.pointerId);
    pausePlayback();
    const startX = e.clientX, start = xToMs(e.clientX); let moved = false;
    const mv = (ev) => {
      // 拖动阈值用【屏幕像素】(>4px),不用源毫秒 —— 否则长录像里 80ms ≈ 0px,单击永远变拖拽
      if (Math.abs(ev.clientX - startX) > 4) moved = true;
      if (moved) { const m = xToMs(ev.clientX); sel = { a: Math.min(start, m), b: Math.max(start, m) }; syncSelBar(); syncTimeline(); }
    };
    const up = () => {
      wrap.releasePointerCapture(e.pointerId);
      wrap.removeEventListener('pointermove', mv); wrap.removeEventListener('pointerup', up);
      if (!moved) { sel = null; syncSelBar(); seekPreview(start); } // 单击=定位播放头
    };
    wrap.addEventListener('pointermove', mv); wrap.addEventListener('pointerup', up);
  });
  wrap.addEventListener('dblclick', () => { sel = { a: 0, b: videoDur }; syncSelBar(); syncTimeline(); });

  // 自动剪空白:没有操作也没有声音的片段一键剪掉
  wireSeg('idleSeg', (v) => { idleThreshold = +v; }, 'idle');
  $('autoTrim').onclick = trimIdle;

  $('selDelete').onclick = () => { if (sel) { pushHistory(); deleteRange(sel.a, sel.b); sel = null; recompute(); afterEdit(); } };
  $('selClear').onclick = () => { sel = null; syncSelBar(); syncTimeline(); };
  wireSeg('selSpeedSeg', (v) => { if (sel) { pushHistory(); setSpeedRange(sel.a, sel.b, +v); recompute(); afterEdit(); } }, 'sp');
  $('resetEdits').onclick = () => { pushHistory(); segments = [{ s: 0, e: videoDur, speed: 1 }]; sel = null; recompute(); afterEdit(); };
}
function afterEdit() { syncSelBar(); seekPreview(Math.min(playSrc, videoDur)); scheduleProjectSave(); }

// ---- 自动剪空白 ----
// 活动信号取并集:光标移动 / 点击 / 键盘·滚轮心跳 / 音频能量(有声音=有内容,网页在播视频时不会被误剪)。
// 连续 ≥ idleThreshold 没有任何信号即空白段,两端各留呼吸边距再剪。
let idleThreshold = 3000;
const IDLE_PAD = 400;       // 剪切边距:保住空白前后的最后一拍动作/话音尾
const IDLE_MIN_CUT = 800;   // 剪出来不足 0.8s 的碎段不值得剪

// 音频活动时间点:按 100ms 窗算 RMS,阈值取「底噪 ×3」与绝对下限的较大者(纯静音底噪≈0 → 不会把噪声当说话)
async function audioActiveTimes() {
  if (!recMeta.hasAudio) return [];
  try {
    const arr = await rawBlob.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ac.decodeAudioData(arr);
    ac.close();
    const ch = buf.getChannelData(0);
    const sr = buf.sampleRate, win = Math.round(sr * 0.1);
    const n = Math.floor(ch.length / win);
    if (!n) return [];
    const rms = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0; const o = i * win;
      for (let j = 0; j < win; j += 4) s += ch[o + j] * ch[o + j];
      rms[i] = Math.sqrt(s / (win / 4));
    }
    const sorted = Float32Array.from(rms).sort();
    const floor = sorted[Math.floor(n * 0.2)];
    const th = Math.max(0.01, floor * 3);
    const times = [];
    for (let i = 0; i < n; i++) if (rms[i] > th) times.push(i * 100 + 50);
    return times;
  } catch (e) { console.warn('音频活动分析失败,仅按操作轨迹判定:', e.message); return []; }
}

// 在源时间轴上找空白区间,并与现存保留片段求交(已删掉的部分不重复计数)
function findIdleRanges(minIdleMs, audioTimes) {
  const ts = [];
  for (const c of data.cursor) ts.push(c.t);
  for (const c of data.clicks) ts.push(c.t);
  for (const t of data.acts) ts.push(t);
  for (const t of audioTimes) ts.push(t);
  ts.sort((a, b) => a - b);
  const gaps = [];
  let prev = 0;
  for (const t of ts) {
    if (t - prev >= minIdleMs) gaps.push([prev, t]);
    if (t > prev) prev = t;
  }
  if (videoDur - prev >= minIdleMs) gaps.push([prev, videoDur]);
  const out = [];
  for (const [a, b] of gaps) {
    // 只在内侧留边距:头尾贴边的空白(开播前/收尾后)整段剪掉
    const a2 = a <= 1 ? 0 : a + IDLE_PAD;
    const b2 = b >= videoDur - 1 ? videoDur : b - IDLE_PAD;
    for (const seg of segments) {
      const lo = Math.max(a2, seg.s), hi = Math.min(b2, seg.e);
      if (hi - lo >= IDLE_MIN_CUT) out.push([lo, hi]);
    }
  }
  return out;
}

async function trimIdle() {
  const btn = $('autoTrim');
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1'; btn.textContent = '分析中…';
  const audio = await audioActiveTimes();
  const ranges = findIdleRanges(idleThreshold, audio);
  delete btn.dataset.busy; btn.textContent = '剪除空白';
  const info = $('trimInfo');
  if (!ranges.length) { info.textContent = `没有 ≥${idleThreshold / 1000}s 的空白段(操作和声音都算「有内容」)`; return; }
  pushHistory();
  let total = 0;
  for (const [a, b] of ranges) { deleteRange(a, b); total += b - a; }
  sel = null; recompute(); afterEdit();
  info.textContent = `已剪除 ${ranges.length} 段空白 · 共 ${(total / 1000).toFixed(1)}s(⌘Z 可撤销)`;
}
// ---- 撤销 ----
function pushHistory() { history.push(JSON.stringify(segments)); if (history.length > 40) history.shift(); }
function undo() { if (!history.length) return; segments = JSON.parse(history.pop()); sel = null; recompute(); afterEdit(); }
function syncSelBar() {
  if (sel) { $('selBar').hidden = false; $('selInfo').textContent = '已选 ' + ((sel.b - sel.a) / 1000).toFixed(1) + 's'; }
  else $('selBar').hidden = true;
}

// ---- 键盘快捷键 ----
function bindKeys() {
  // 导出进行中误关页面 → 拦一下,别让进度白跑
  window.addEventListener('beforeunload', (e) => { if (exporting) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', (e) => {
    if (exporting) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const step = 1000 / 30;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); pausePlayback(); seekPreview(playSrc - (e.shiftKey ? 1000 : step)); break;
      case 'ArrowRight': e.preventDefault(); pausePlayback(); seekPreview(playSrc + (e.shiftKey ? 1000 : step)); break;
      case 'i': case 'I': { const b = sel ? sel.b : videoDur; sel = { a: playSrc, b: Math.max(playSrc + 200, b) }; syncSelBar(); syncTimeline(); break; }
      case 'o': case 'O': { const a = sel ? sel.a : 0; sel = { a: Math.min(a, Math.max(0, playSrc - 200)), b: playSrc }; syncSelBar(); syncTimeline(); break; }
      case 'Delete': case 'Backspace': if (sel) { e.preventDefault(); pushHistory(); deleteRange(sel.a, sel.b); sel = null; recompute(); afterEdit(); } break;
      case 'Escape': sel = null; syncSelBar(); syncTimeline(); break;
    }
  });
}

// ---- 分段控制器 ----
function bindSegments() {
  wireSeg('beautifySeg', (v) => { beautify = v === '1'; syncBeautifyUI(); render(); scheduleProjectSave(); });
  wireSeg('fmtSeg', (v) => { fmtSel = v; }, 'fmt');
  wireSeg('sizeSeg', (v) => { exportSize = v; }, 'sz');
}
function wireSeg(segId, fn, attr = 'b') {
  const seg = $(segId);
  seg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); fn(b.dataset[attr]); };
  });
}
function syncBeautifyUI() {
  document.querySelectorAll('.beautify-only').forEach((g) => g.classList.toggle('dim', !beautify));
}

// ---- 面板 ----
function buildBgChips() {
  const wrap = $('bgChips'); wrap.innerHTML = '';
  // 壁纸大图卡两列铺开,名字走 tooltip;「不要背景」是顶部一条窄条(BACKGROUNDS[0])
  BACKGROUNDS.forEach((b) => {
    const el = document.createElement('div');
    el.className = 'chip' + (b.type === 'none' ? ' none' : '');
    el.dataset.bg = b.id; el.title = b.name;
    const pv = document.createElement('div'); pv.className = 'pv';
    if (b.type === 'image') pv.style.backgroundImage = `url(${chrome.runtime.getURL(b.file)})`;
    el.append(pv);
    el.onclick = () => { cfg.background = b; preloadBackground(b).then(render); markBg(b.id); savePrefs(); render(); };
    wrap.appendChild(el);
  });
}
function markBg(v) { document.querySelectorAll('#bgChips .chip').forEach((c) => c.classList.toggle('sel', c.dataset.bg === v)); }

// 滑杆进度填充:已走过的轨道涂强调色(CSS 用 --p 画填充),原生 range 做不到
const RANGE_IDS = ['padding', 'radius', 'shadow', 'zoomLevel'];
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', ((el.value - min) / (max - min)) * 100 + '%');
}

function bindControls() {
  const rr = () => { savePrefs(); render(); };
  const on = (i, ev, fn) => $(i).addEventListener(ev, fn);
  RANGE_IDS.forEach((id) => on(id, 'input', (e) => paintRange(e.target)));
  on('padding', 'input', (e) => { cfg.padding = +e.target.value / 100; $('vPad').textContent = e.target.value; rr(); });
  on('radius', 'input', (e) => { cfg.radius = +e.target.value; $('vRad').textContent = e.target.value; rr(); });
  on('shadow', 'input', (e) => { cfg.shadow = +e.target.value / 100; $('vSha').textContent = e.target.value; rr(); });
  on('autoZoom', 'change', (e) => { cfg.autoZoom = e.target.checked; rr(); });
  on('zoomLevel', 'input', (e) => { cfg.zoomLevel = +e.target.value / 100; $('vZoom').textContent = (cfg.zoomLevel).toFixed(2) + '×'; rr(); });
  on('clickFx', 'change', (e) => { cfg.clickFx = e.target.checked; rr(); });
  on('cursorOn', 'change', (e) => { cfg.cursor = e.target.checked; rr(); });
}

function syncControls() {
  $('padding').value = Math.round(cfg.padding * 100); $('vPad').textContent = Math.round(cfg.padding * 100);
  $('radius').value = cfg.radius; $('vRad').textContent = cfg.radius;
  $('shadow').value = Math.round(cfg.shadow * 100); $('vSha').textContent = Math.round(cfg.shadow * 100);
  $('autoZoom').checked = cfg.autoZoom;
  $('zoomLevel').value = Math.round(cfg.zoomLevel * 100); $('vZoom').textContent = cfg.zoomLevel.toFixed(2) + '×';
  $('clickFx').checked = cfg.clickFx;
  $('cursorOn').checked = !!cfg.cursor;
  if (cfg.background) markBg(cfg.background.id);
  RANGE_IDS.forEach((id) => paintRange($(id)));
}

// ---- 摄像头气泡控件 ----
function bindCamControls() {
  $('gCam').hidden = false;
  const rr = () => { savePrefs(); render(); };
  $('camShow').onchange = (e) => { camCfg.show = e.target.checked; rr(); };
  wireSeg('camShapeSeg', (v) => { camCfg.shape = v; clampCam(); rr(); }, 'shape');
  wireSeg('camPosSeg', (v) => { setCamPos(v); rr(); }, 'pos');
  $('camSize').addEventListener('input', (e) => { paintRange(e.target); camCfg.size = +e.target.value / 100; $('vCamSize').textContent = e.target.value; clampCam(); rr(); });
  $('camBeauty').addEventListener('input', (e) => { paintRange(e.target); camCfg.beauty = +e.target.value / 100; $('vCamBeauty').textContent = e.target.value; rr(); });
  $('camMirror').onchange = (e) => { camCfg.mirror = e.target.checked; rr(); };
  $('camRing').onchange = (e) => { camCfg.ring = e.target.checked; rr(); };
  bindCamDrag();
}
function syncCamControls() {
  $('camShow').checked = camCfg.show;
  $('camSize').value = Math.round(camCfg.size * 100); $('vCamSize').textContent = Math.round(camCfg.size * 100);
  $('camBeauty').value = Math.round(camCfg.beauty * 100); $('vCamBeauty').textContent = Math.round(camCfg.beauty * 100);
  $('camMirror').checked = camCfg.mirror; $('camRing').checked = camCfg.ring;
  document.querySelectorAll('#camShapeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.shape === camCfg.shape));
  paintRange($('camSize')); paintRange($('camBeauty'));
}
// 改大小/形状后把中心拉回画布内,气泡不出界
function clampCam() {
  const r = cameraRect(camCfg, camVideo, W, H);
  camCfg.x = Math.max(r.w / 2 / W, Math.min(1 - r.w / 2 / W, camCfg.x));
  camCfg.y = Math.max(r.h / 2 / H, Math.min(1 - r.h / 2 / H, camCfg.y));
}
// 四角快速摆位(留一圈呼吸边距)
function setCamPos(key) {
  const r = cameraRect(camCfg, camVideo, W, H);
  const m = 0.035 * Math.min(W, H);
  camCfg.x = key[0] === 'l' ? (r.w / 2 + m) / W : 1 - (r.w / 2 + m) / W;
  camCfg.y = key[1] === 't' ? (r.h / 2 + m) / H : 1 - (r.h / 2 + m) / H;
}
function clearPosSeg() { document.querySelectorAll('#camPosSeg button').forEach((b) => b.classList.remove('on')); }
// 在预览画布上直接拖动气泡(Screen Studio 式自由摆位)
function bindCamDrag() {
  let dragging = false;
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  };
  const hit = (p) => {
    if (!camCfg || !camCfg.show) return false;
    const r = cameraRect(camCfg, camVideo, W, H);
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  };
  canvas.addEventListener('pointermove', (e) => { if (!dragging) canvas.style.cursor = hit(toCanvas(e)) ? 'grab' : ''; });
  canvas.addEventListener('pointerdown', (e) => {
    const p = toCanvas(e);
    if (!hit(p)) return;
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    dragging = true; canvas.style.cursor = 'grabbing';
    const dx = camCfg.x - p.x / W, dy = camCfg.y - p.y / H;
    const mv = (ev) => {
      const q = toCanvas(ev);
      camCfg.x = q.x / W + dx; camCfg.y = q.y / H + dy;
      clampCam(); clearPosSeg(); render();
    };
    const up = () => {
      dragging = false; canvas.style.cursor = 'grab';
      canvas.releasePointerCapture(e.pointerId);
      canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerup', up);
      savePrefs();
    };
    canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerup', up);
  });
}

// ---- 导出 ----
// WSOLA 时间拉伸:改变时长但【保持音高】(变速不变调,告别花栗鼠声)。
// s = 输出/输入 长度比(2× 加速 → s=0.5)。靠互相关搜索对齐相邻帧,最小化相位断裂。
function timeStretch(x, s, sr) {
  if (Math.abs(s - 1) < 0.01 || x.length < 2048) return Float32Array.from(x);
  const N = Math.max(256, Math.round(0.046 * sr));   // 帧长 ~46ms
  const Hs = N >> 1;                                  // 合成跳距(50% 重叠)
  const Ha = Math.max(1, Math.round(Hs / s));         // 分析跳距(决定快慢)
  const seek = Math.max(1, Math.round(0.008 * sr));   // ±8ms 相似度搜索
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const outLen = Math.max(N, Math.floor(x.length * s) + N);
  const out = new Float32Array(outLen), norm = new Float32Array(outLen);
  let ia = 0, os = 0, tmpl = null;
  while (os + N < outLen && ia + N < x.length) {
    let off = 0;
    if (tmpl) { // 在 ±seek 内找与「期望延续」最相关的起点,保住周期相位
      let best = -Infinity;
      for (let d = -seek; d <= seek; d++) {
        const p = ia + d; if (p < 0 || p + N >= x.length) continue;
        let c = 0; for (let i = 0; i < N; i += 2) c += x[p + i] * tmpl[i];
        if (c > best) { best = c; off = d; }
      }
    }
    const st = ia + off;
    for (let i = 0; i < N; i++) { out[os + i] += x[st + i] * w[i]; norm[os + i] += w[i]; }
    tmpl = new Float32Array(N);
    for (let i = 0; i < N; i++) { const idx = st + Hs + i; tmpl[i] = idx < x.length ? x[idx] : 0; }
    os += Hs; ia += Ha;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
  return out.subarray(0, Math.max(1, Math.floor(x.length * s)));
}

async function buildAudio() {
  if (!recMeta.hasAudio) return null;
  try {
    const arr = await rawBlob.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ac.decodeAudioData(arr);
    const sr = buf.sampleRate, numCh = buf.numberOfChannels;
    // 逐保留片段:speed==1 原样拷贝;变速段走 WSOLA 时间拉伸(保音高)后拼接。
    const channels = [];
    for (let c = 0; c < numCh; c++) {
      const src = buf.getChannelData(c);
      const parts = [];
      for (const seg of segments) {
        const s0 = Math.max(0, Math.floor(seg.s / 1000 * sr));
        const s1 = Math.min(src.length, Math.floor(seg.e / 1000 * sr));
        const slice = src.subarray(s0, Math.max(s0, s1));
        parts.push(Math.abs(seg.speed - 1) < 0.01 ? Float32Array.from(slice) : timeStretch(slice, 1 / seg.speed, sr));
      }
      const outLen = parts.reduce((n, p) => n + p.length, 0);
      const out = new Float32Array(outLen);
      let off = 0; for (const pt of parts) { out.set(pt, off); off += pt.length; }
      channels.push(out);
    }
    ac.close();
    return { channels, sampleRate: sr };
  } catch (e) { console.warn('音频处理失败,导出无声:', e.message); return null; }
}

// 导出画布(可缩到 1080p/720p);默认就是主预览画布。
let expCanvas = null, expCtx = null, expW = 0, expH = 0;
async function drawExportFrame(masterMs) {
  const { sourceMs } = masterToSource(masterMs);
  await seekTo(sourceMs / 1000);
  if (camVideo && camCfg && camCfg.show) await camSeekTo(camTimeFor(sourceMs));
  drawScene(expCtx, video, sourceMs, curCfg(), data, expW, expH);
  if (camVideo && camCfg) drawCamera(expCtx, camVideo, camCfg, expW, expH);
}
function seekTo(sec) {
  return new Promise((res) => {
    if (!(videoDur > 0)) return res(); // 损坏录制 videoDur=0 时不发无效 seek,避免 Promise 永久挂起
    const target = Math.max(0, Math.min(sec, videoDur / 1000 - 0.001));
    if (Math.abs(video.currentTime - target) < 0.0005) return res();
    const h = () => { video.removeEventListener('seeked', h); res(); };
    video.addEventListener('seeked', h); video.currentTime = target;
  });
}
function camSeekTo(sec) {
  return new Promise((res) => {
    if (!camVideo || !(camDur > 0)) return res();
    const target = Math.max(0, Math.min(sec, camDur / 1000 - 0.001));
    if (Math.abs(camVideo.currentTime - target) < 0.0005) return res();
    const h = () => { camVideo.removeEventListener('seeked', h); res(); };
    camVideo.addEventListener('seeked', h); camVideo.currentTime = target;
  });
}

async function doExport() {
  if (exporting) return;
  recompute(); // 确保总时长是最新剪辑结果
  exporting = true; playing = false; video.pause(); if (camVideo) camVideo.pause();
  // 按所选尺寸决定导出分辨率(控制体积):原始 / 1080p / 720p,绝不放大
  const targetH = exportSize === '1080' ? 1080 : exportSize === '720' ? 720 : H;
  const sc = Math.min(1, targetH / H);
  expW = Math.round(W * sc / 2) * 2; expH = Math.round(H * sc / 2) * 2;
  if (sc === 1) { expCanvas = canvas; expCtx = ctx; }
  else { expCanvas = document.createElement('canvas'); expCanvas.width = expW; expCanvas.height = expH; expCtx = expCanvas.getContext('2d'); }
  $('exportMask').hidden = false; $('exportBar').style.width = '0%';
  $('exportLabel').textContent = '正在导出 ' + fmtSel.toUpperCase() + ' …';
  try {
    await preloadBackground(curCfg().background); // 壁纸必须就绪,否则导出帧会画成 fallback 纯色
    const audio = fmtSel === 'gif' ? null : await buildAudio();
    const blob = await exportMedia({
      canvas: expCanvas, drawAt: drawExportFrame, durationMs: total, fps: fmtSel === 'gif' ? 12 : 30,
      format: fmtSel, audio, maxW: exportSize === 'orig' ? null : expW, // GIF:显式尺寸优先于自适应上限
      onProgress: (p) => { $('exportBar').style.width = Math.round(p * 100) + '%'; },
    });
    // 扩展名按实际产出 mime 取(WebCodecs 失败回退到 WebM 时,不会出现 .mp4 装着 webm 的坑)
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('gif') ? 'gif' : 'webm';
    download(blob, ext);
  } catch (e) {
    console.error(e); alert('导出失败:' + e.message);
  }
  exporting = false; $('exportMask').hidden = true;
  expCanvas = null; expCtx = null;
  // 恢复预览
  await seekTo(Math.max(0, Math.min(videoDur, playSrc)) / 1000);
  syncCam(true);
  render(); syncTimeline();
}

function download(blob, ext) {
  const a = document.createElement('a'); const url = URL.createObjectURL(blob);
  a.href = url; a.download = `huarec-${Date.now()}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
