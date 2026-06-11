// offscreen 录制文档:持有 MediaRecorder,录制 tabCapture 流。
// 切片不堆内存:每片落地 IndexedDB(chunks 表),停止时读回合并。
// 这样长录制内存恒定,浏览器崩溃后还能凭残留切片恢复半截录像。
import { saveRecording, appendChunk, getSessionChunks, putSession, deleteSession } from './lib/db.js';
import { fixWebmDuration } from './lib/vendor/fix-webm-duration.mjs';

let recorder = null;
let stream = null;
let audioCtx = null;
let startTime = 0;
let pausedTotal = 0; // 累计暂停时长(ms),不计入录像时长
let pausedAt = 0;
let meta = {};
// 摄像头轨:单独录一条 WebM,不烤进屏幕画面 → 编辑器里作为可调气泡合成(位置/大小/美颜录后随便改)
let camRecorder = null;
let camStream = null;
let camStartTime = 0;
let camStopped = null; // camRecorder 完全停止(最后一片已派发)的 promise

// ---- 切片流式写入 ----
// 写操作串成 promise 链:保证 seq 顺序落库,停止时 await 链尾即可确认全部写完。
let session = '';
let seqScreen = 0, seqCam = 0;
let writeChain = Promise.resolve();
function pushChunk(track, data) {
  const seq = track === 'cam' ? ++seqCam : ++seqScreen;
  writeChain = writeChain
    .then(() => appendChunk({ session, track, seq, data }))
    .catch((e) => console.warn('切片入库失败:', e.message));
}
// 会话行随录制进展更新(startTime/camStartTime/meta),崩溃恢复时凭它算时长与摄像头偏移
function updateSession() {
  putSession({ session, createdAt: meta.createdAt || Date.now(), startTime, camStartTime, meta })
    .catch((e) => console.warn('会话登记失败:', e.message));
}

function reply(type, extra = {}) {
  chrome.runtime.sendMessage({ type, target: 'background', ...extra }).catch(() => {});
}

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

async function start(streamId, options) {
  session = 'sess_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  seqScreen = 0; seqCam = 0; writeChain = Promise.resolve();
  startTime = 0; camStartTime = 0;
  // 黑边根治:tabCapture 的捕获帧若用默认比例,会把比例不同的网页 letterbox(黑边烤进像素)。
  // 这里用 background 测得的【视口真实设备像素】把捕获盒子锁成和网页一模一样的比例和尺寸 →
  // 内容刚好填满捕获帧,不留黑边。拿不到视口尺寸时退回只限帧率(不强加任何固定比例)。
  // 只设上限(maxWidth/maxHeight),且其宽高比 = 视口宽高比:只要这个比例对,无论绝对分辨率
  // 被缩到多少,内容都按比例填满捕获帧,不会 letterbox 出黑边。不用 min=精确锁(易触发
  // OverconstrainedError 反而退回无约束的默认宽帧 → 又冒黑边)。
  const vp = options.viewport;
  const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 30 };
  if (vp && vp.w && vp.h) {
    mandatory.maxWidth = vp.w; mandatory.maxHeight = vp.h;
  }
  const audio = options.audio !== false
    ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    : false;

  // 先试带视口比例上限的约束;万一仍被拒,退回只限帧率保证能录上(极端兜底)。
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory }, audio });
  } catch (e) {
    const loose = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 30 };
    stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: loose }, audio });
  }

  // 把标签页音频回连到扬声器,否则录制期间用户听不到声音
  if (audio) {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    src.connect(audioCtx.destination);
  }

  const vset = stream.getVideoTracks()[0].getSettings();
  meta = {
    width: vset.width || 1280,
    height: vset.height || 720,
    hasAudio: !!audio,
    createdAt: Date.now(),
  };

  updateSession(); // 先登记会话:此刻起的任何崩溃,切片都有主可寻

  // 摄像头轨:取流失败(没设备/没权限/被占用)只降级为纯录屏,绝不让整次录制失败。
  camRecorder = null; camStream = null; camStopped = null;
  if (options.camera) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      const camMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      camRecorder = new MediaRecorder(camStream, { mimeType: camMime, videoBitsPerSecond: 5_000_000 });
      camRecorder.ondataavailable = (e) => { if (e.data && e.data.size) pushChunk('cam', e.data); };
      camRecorder.onstart = () => { camStartTime = Date.now(); updateSession(); };
      camStopped = new Promise((res) => { camRecorder.onstop = res; });
      camRecorder.start(1000);
    } catch (e) {
      console.warn('摄像头获取失败,本段仅录屏幕:', e.message);
      if (camStream) camStream.getTracks().forEach((t) => t.stop());
      camStream = null; camRecorder = null; camStopped = null;
    }
  }

  const mimeType = pickMime();
  // 码率随分辨率自适应:普通屏保持 8Mbps,Retina(2880×1800 等)按 0.12 bit/px/帧 拉高到上限 24M,
  // 否则高分辨率下 8M 会让滚动/弹窗等运动场景糊掉(0.051 bit/px/帧 远低于 VP9 推荐)。
  const vbps = Math.max(8_000_000, Math.min(24_000_000, Math.round(meta.width * meta.height * 30 * 0.12)));
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: vbps });
  meta.mime = mimeType;

  recorder.ondataavailable = (e) => { if (e.data && e.data.size) pushChunk('screen', e.data); };
  recorder.onstart = () => {
    startTime = Date.now();
    pausedTotal = 0; pausedAt = 0;
    updateSession();
    reply('OFFSCREEN_STARTED', { startTime });
  };
  recorder.onstop = onStop;
  recorder.start(1000); // 每秒切片,流式落库,长录制内存恒定
}

async function onStop() {
  const id = 'rec_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const stopAt = Date.now();
  if (pausedAt) { pausedTotal += stopAt - pausedAt; pausedAt = 0; }
  meta.durationMs = stopAt - startTime - pausedTotal;
  // 摄像头轨收尾:stop() 会先派发最后一片再触发 onstop,等它停稳切片才齐
  if (camRecorder) {
    try {
      if (camRecorder.state !== 'inactive') camRecorder.stop();
      await camStopped;
    } catch (e) { console.warn('摄像头轨停止异常:', e.message); }
  }
  await writeChain; // 全部切片落库完毕
  let blob = null, camBlob = null;
  try {
    const rows = await getSessionChunks(session);
    blob = new Blob(rows.filter((r) => r.track === 'screen').map((r) => r.data), { type: 'video/webm' });
    const camParts = rows.filter((r) => r.track === 'cam').map((r) => r.data);
    if (camParts.length) {
      camBlob = new Blob(camParts, { type: 'video/webm' });
      meta.hasCam = true;
      meta.camOffsetMs = camStartTime - startTime;
    }
  } catch (e) {
    reply('OFFSCREEN_STOPPED', { id: null, error: '读取录制切片失败:' + e.message });
    cleanup();
    return;
  }
  // MediaRecorder 的 WebM 没有 Duration 元数据 → 播放器拖不动进度条,编辑器要 seek 到末尾探测时长。
  // 存库前补写;失败就保留原 blob(老行为),不阻塞保存。
  try { blob = await fixWebmDuration(blob, meta.durationMs, { logger: false }); } catch (_) {}
  if (camBlob) {
    const camDur = stopAt - camStartTime - pausedTotal;
    try { camBlob = await fixWebmDuration(camBlob, camDur, { logger: false }); } catch (_) {}
  }
  try {
    await saveRecording({ id, blob, camBlob, cursor: [], clicks: [], meta });
    await deleteSession(session).catch(() => {}); // 成品已落库,切片使命完成
    reply('OFFSCREEN_STOPPED', { id, meta });
  } catch (e) {
    reply('OFFSCREEN_STOPPED', { id: null, error: e.message });
  }
  cleanup();
}

function cleanup() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  stream = null; audioCtx = null; recorder = null;
  camStream = null; camRecorder = null; camStopped = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'OFFSCREEN_START':
      start(msg.streamId, msg.options || {}).catch((e) => {
        reply('OFFSCREEN_STARTED', { startTime: 0, error: e.message });
      });
      break;
    case 'OFFSCREEN_PAUSE':
      if (recorder && recorder.state === 'recording') { recorder.pause(); pausedAt = Date.now(); }
      if (camRecorder && camRecorder.state === 'recording') camRecorder.pause();
      reply('OFFSCREEN_PAUSED');
      break;
    case 'OFFSCREEN_RESUME':
      if (recorder && recorder.state === 'paused') { recorder.resume(); if (pausedAt) { pausedTotal += Date.now() - pausedAt; pausedAt = 0; } }
      if (camRecorder && camRecorder.state === 'paused') camRecorder.resume();
      reply('OFFSCREEN_RESUMED');
      break;
    case 'OFFSCREEN_STOP':
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else reply('OFFSCREEN_STOPPED', { id: null, error: '没有进行中的录制' });
      break;
  }
});
