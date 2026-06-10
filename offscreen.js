// offscreen 录制文档:持有 MediaRecorder,录制 tabCapture 流。
import { saveRecording } from './lib/db.js';

let recorder = null;
let chunks = [];
let stream = null;
let audioCtx = null;
let startTime = 0;
let pausedTotal = 0; // 累计暂停时长(ms),不计入录像时长
let pausedAt = 0;
let meta = {};

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
  chunks = [];
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

  const mimeType = pickMime();
  // 码率随分辨率自适应:普通屏保持 8Mbps,Retina(2880×1800 等)按 0.12 bit/px/帧 拉高到上限 24M,
  // 否则高分辨率下 8M 会让滚动/弹窗等运动场景糊掉(0.051 bit/px/帧 远低于 VP9 推荐)。
  const vbps = Math.max(8_000_000, Math.min(24_000_000, Math.round(meta.width * meta.height * 30 * 0.12)));
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: vbps });
  meta.mime = mimeType;

  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstart = () => {
    startTime = Date.now();
    pausedTotal = 0; pausedAt = 0;
    reply('OFFSCREEN_STARTED', { startTime });
  };
  recorder.onstop = onStop;
  recorder.start(1000); // 每秒切片,便于长录制
}

async function onStop() {
  const blob = new Blob(chunks, { type: 'video/webm' });
  const id = 'rec_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  if (pausedAt) { pausedTotal += Date.now() - pausedAt; pausedAt = 0; }
  meta.durationMs = Date.now() - startTime - pausedTotal;
  try {
    await saveRecording({ id, blob, cursor: [], clicks: [], meta });
    reply('OFFSCREEN_STOPPED', { id, meta });
  } catch (e) {
    reply('OFFSCREEN_STOPPED', { id: null, error: e.message });
  }
  cleanup();
}

function cleanup() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  stream = null; audioCtx = null; recorder = null; chunks = [];
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
      reply('OFFSCREEN_PAUSED');
      break;
    case 'OFFSCREEN_RESUME':
      if (recorder && recorder.state === 'paused') { recorder.resume(); if (pausedAt) { pausedTotal += Date.now() - pausedAt; pausedAt = 0; } }
      reply('OFFSCREEN_RESUMED');
      break;
    case 'OFFSCREEN_STOP':
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else reply('OFFSCREEN_STOPPED', { id: null, error: '没有进行中的录制' });
      break;
  }
});
