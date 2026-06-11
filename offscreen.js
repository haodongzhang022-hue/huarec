// offscreen 录制文档:持有 MediaRecorder,录制 tabCapture 流。
// 切片不堆内存:每片落地 IndexedDB(chunks 表),停止时读回合并。
// 这样长录制内存恒定,浏览器崩溃后还能凭残留切片恢复半截录像。
import { saveRecording, appendChunk, getSessionChunks, putSession, deleteSession } from './lib/db.js';
import { fixWebmDuration } from './lib/vendor/fix-webm-duration.mjs';

let recorder = null;
let stream = null;
let audioCtx = null;
// 跨标签页接力:MediaRecorder 不直接录 tabCapture 流,而是录一条恒定的「中转轨」——
// 视频帧经 MediaStreamTrackProcessor 读出、写进 MediaStreamTrackGenerator,音频混进固定的
// AudioDestination。切标签页 = 换上游,录制器全程无感,成片是一条连续视频。
const canRelay = typeof MediaStreamTrackGenerator !== 'undefined' && typeof MediaStreamTrackProcessor !== 'undefined';
let videoGen = null, genWriter = null, audioDest = null;
let curSrcNode = null;
let pumpId = 0;       // 递增代号:旧泵在下一帧发现代号变了就自杀
let hasAudioOpt = false;
let firstVp = null;   // 首个标签页的视口:全程锁同一套捕获约束,接力时帧尺寸不跳
let startTime = 0;
let pausedTotal = 0; // 累计暂停时长(ms),不计入录像时长
let pausedAt = 0;
let meta = {};
// 摄像头轨:单独录一条 WebM,不烤进屏幕画面 → 编辑器里作为可调气泡合成(位置/大小/美颜录后随便改)
let camRecorder = null;
let camStream = null;
let camStartTime = 0;
let camStopped = null; // camRecorder 完全停止(最后一片已派发)的 promise
// 麦克风轨:旁白单独录一条 opus,编辑器里和网页声音分轨调音量再混
let micRecorder = null;
let micStream = null;
let micStartTime = 0;
let micStopped = null;

// ---- 切片流式写入 ----
// 写操作串成 promise 链:保证 seq 顺序落库,停止时 await 链尾即可确认全部写完。
let session = '';
const seqs = { screen: 0, cam: 0, mic: 0 };
let writeChain = Promise.resolve();
function pushChunk(track, data) {
  const seq = ++seqs[track];
  writeChain = writeChain
    .then(() => appendChunk({ session, track, seq, data }))
    .catch((e) => console.warn('切片入库失败:', e.message));
}
// 会话行随录制进展更新(各轨起点/meta),崩溃恢复时凭它算时长与轨间偏移
function updateSession() {
  putSession({ session, createdAt: meta.createdAt || Date.now(), startTime, camStartTime, micStartTime, meta })
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

// 取某个标签页的 tabCapture 流。约束全程用 firstVp(首页视口):
// 黑边根治:tabCapture 的捕获帧若用默认比例,会把比例不同的网页 letterbox(黑边烤进像素)。
// 只设上限(maxWidth/maxHeight),且其宽高比 = 视口宽高比 → 内容按比例填满捕获帧。
// 不用 min=精确锁(易触发 OverconstrainedError 反而退回默认宽帧 → 又冒黑边)。
async function captureTab(streamId) {
  const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 30 };
  if (firstVp && firstVp.w && firstVp.h) {
    mandatory.maxWidth = firstVp.w; mandatory.maxHeight = firstVp.h;
  }
  const audio = hasAudioOpt
    ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    : false;
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { mandatory }, audio });
  } catch (e) {
    const loose = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 30 };
    return navigator.mediaDevices.getUserMedia({ video: { mandatory: loose }, audio });
  }
}

// 把一个标签页流接上中转轨(首次接入和切换共用)。旧上游停掉,新上游开泵。
function plugTab(s) {
  const my = ++pumpId;
  const track = s.getVideoTracks()[0];
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  (async () => {
    while (true) {
      let r;
      try { r = await reader.read(); } catch (_) { break; }
      if (r.done) break;
      if (pumpId !== my) { r.value.close(); break; }
      try { await genWriter.write(r.value); } catch (_) { r.value.close(); break; }
    }
    try { reader.cancel(); } catch (_) {}
  })();
  let srcNode = null;
  if (hasAudioOpt && audioCtx && s.getAudioTracks().length) {
    srcNode = audioCtx.createMediaStreamSource(s);
    if (audioDest) srcNode.connect(audioDest);     // 进录制混音
    srcNode.connect(audioCtx.destination);          // 回连扬声器,录制期间听得见
  }
  if (curSrcNode) { try { curSrcNode.disconnect(); } catch (_) {} }
  if (stream && stream !== s) stream.getTracks().forEach((t) => t.stop());
  stream = s; curSrcNode = srcNode;
}

async function start(streamId, options) {
  session = 'sess_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  seqs.screen = 0; seqs.cam = 0; seqs.mic = 0; writeChain = Promise.resolve();
  startTime = 0; camStartTime = 0; micStartTime = 0;
  hasAudioOpt = options.audio !== false;
  firstVp = options.viewport || null;

  const tabStream = await captureTab(streamId);
  let recStream;
  if (canRelay) {
    videoGen = new MediaStreamTrackGenerator({ kind: 'video' });
    genWriter = videoGen.writable.getWriter();
    audioCtx = new AudioContext();
    audioDest = hasAudioOpt ? audioCtx.createMediaStreamDestination() : null;
    recStream = new MediaStream([videoGen]);
    if (audioDest) audioDest.stream.getAudioTracks().forEach((t) => recStream.addTrack(t));
    plugTab(tabStream);
  } else {
    // 老环境兜底:直接录 tabCapture 流(不支持跨标签页接力)
    recStream = tabStream;
    stream = tabStream;
    if (hasAudioOpt) {
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(tabStream).connect(audioCtx.destination);
    }
  }

  const vset = tabStream.getVideoTracks()[0].getSettings();
  meta = {
    width: vset.width || 1280,
    height: vset.height || 720,
    hasAudio: !!audio,
    hiddenCursor: options.smoothCursor === true, // 真实光标已缩成小点,编辑器默认开补画
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

  // 麦克风轨:开浏览器自带的回声消除/降噪/自动增益;失败同样只降级,不连坐
  micRecorder = null; micStream = null; micStopped = null;
  if (options.mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      micRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
      micRecorder.ondataavailable = (e) => { if (e.data && e.data.size) pushChunk('mic', e.data); };
      micRecorder.onstart = () => { micStartTime = Date.now(); updateSession(); };
      micStopped = new Promise((res) => { micRecorder.onstop = res; });
      micRecorder.start(1000);
    } catch (e) {
      console.warn('麦克风获取失败,本段无旁白:', e.message);
      if (micStream) micStream.getTracks().forEach((t) => t.stop());
      micStream = null; micRecorder = null; micStopped = null;
    }
  }

  const mimeType = pickMime();
  // 码率随分辨率自适应:普通屏保持 8Mbps,Retina(2880×1800 等)按 0.12 bit/px/帧 拉高到上限 24M,
  // 否则高分辨率下 8M 会让滚动/弹窗等运动场景糊掉(0.051 bit/px/帧 远低于 VP9 推荐)。
  const vbps = Math.max(8_000_000, Math.min(24_000_000, Math.round(meta.width * meta.height * 30 * 0.12)));
  recorder = new MediaRecorder(recStream, { mimeType, videoBitsPerSecond: vbps });
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
  // 摄像头/麦克风轨收尾:stop() 会先派发最后一片再触发 onstop,等停稳切片才齐
  if (camRecorder) {
    try {
      if (camRecorder.state !== 'inactive') camRecorder.stop();
      await camStopped;
    } catch (e) { console.warn('摄像头轨停止异常:', e.message); }
  }
  if (micRecorder) {
    try {
      if (micRecorder.state !== 'inactive') micRecorder.stop();
      await micStopped;
    } catch (e) { console.warn('麦克风轨停止异常:', e.message); }
  }
  await writeChain; // 全部切片落库完毕
  let blob = null, camBlob = null, micBlob = null;
  try {
    const rows = await getSessionChunks(session);
    blob = new Blob(rows.filter((r) => r.track === 'screen').map((r) => r.data), { type: 'video/webm' });
    const camParts = rows.filter((r) => r.track === 'cam').map((r) => r.data);
    if (camParts.length) {
      camBlob = new Blob(camParts, { type: 'video/webm' });
      meta.hasCam = true;
      meta.camOffsetMs = camStartTime - startTime;
    }
    const micParts = rows.filter((r) => r.track === 'mic').map((r) => r.data);
    if (micParts.length) {
      micBlob = new Blob(micParts, { type: 'audio/webm' });
      meta.hasMic = true;
      meta.micOffsetMs = micStartTime - startTime;
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
    await saveRecording({ id, blob, camBlob, micBlob, cursor: [], clicks: [], meta });
    await deleteSession(session).catch(() => {}); // 成品已落库,切片使命完成
    reply('OFFSCREEN_STOPPED', { id, meta });
  } catch (e) {
    reply('OFFSCREEN_STOPPED', { id: null, error: e.message });
  }
  cleanup();
}

function cleanup() {
  pumpId++; // 让在跑的帧泵退出
  if (genWriter) { try { genWriter.close().catch(() => {}); } catch (_) {} }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  stream = null; audioCtx = null; recorder = null;
  videoGen = null; genWriter = null; audioDest = null; curSrcNode = null;
  camStream = null; camRecorder = null; camStopped = null;
  micStream = null; micRecorder = null; micStopped = null;
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
      if (micRecorder && micRecorder.state === 'recording') micRecorder.pause();
      reply('OFFSCREEN_PAUSED');
      break;
    case 'OFFSCREEN_RESUME':
      if (recorder && recorder.state === 'paused') { recorder.resume(); if (pausedAt) { pausedTotal += Date.now() - pausedAt; pausedAt = 0; } }
      if (camRecorder && camRecorder.state === 'paused') camRecorder.resume();
      if (micRecorder && micRecorder.state === 'paused') micRecorder.resume();
      reply('OFFSCREEN_RESUMED');
      break;
    case 'OFFSCREEN_SWITCH':
      // 跨标签页接力:对新标签页取流,换到中转轨上游;失败则保持录原页
      (async () => {
        if (!canRelay || !videoGen) throw new Error('当前环境不支持跨标签页接力');
        plugTab(await captureTab(msg.streamId));
      })()
        .then(() => reply('OFFSCREEN_SWITCHED'))
        .catch((e) => reply('OFFSCREEN_SWITCHED', { error: e.message }));
      break;
    case 'OFFSCREEN_STOP':
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else reply('OFFSCREEN_STOPPED', { id: null, error: '没有进行中的录制' });
      break;
  }
});
