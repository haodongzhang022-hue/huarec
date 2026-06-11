// HuaRec 后台编排器(MV3 service worker, module)。
// 职责:接 popup/快捷键指令 → 取 tabCapture streamId → 拉起 offscreen 录制 →
// 注入控制条 content script → 停止时合并光标轨迹 → 存库 → 打开编辑器。
import { saveRecording, getRecording } from './lib/db.js';

const OFFSCREEN_PATH = 'offscreen.html';

// ---- 会话状态(持久化到 storage.session,抗 SW 休眠) ----
async function getState() {
  const { recState } = await chrome.storage.session.get('recState');
  return recState || { status: 'idle' }; // idle | recording | paused | saving
}
async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await chrome.storage.session.set({ recState: next });
  return next;
}
async function clearState() {
  await chrome.storage.session.set({ recState: { status: 'idle' } });
}

// ---- 轨迹缓冲(storage.session,抗 SW 休眠) ----
// tracker 每 4 秒增量上报一次,这里合并暂存;录制跨页面导航时数据不再依赖页面存活。
// 写操作串成 promise 链,避免「读-改-写」并发交错丢增量。
let trackWrite = Promise.resolve();
function appendTrack(delta) {
  trackWrite = trackWrite.then(async () => {
    const { trackBuf } = await chrome.storage.session.get('trackBuf');
    const buf = trackBuf || { cursor: [], clicks: [], acts: [], keys: [] };
    if (!buf.acts) buf.acts = [];
    if (!buf.keys) buf.keys = [];
    if (delta.cursor?.length) buf.cursor.push(...delta.cursor);
    if (delta.clicks?.length) buf.clicks.push(...delta.clicks);
    if (delta.acts?.length) buf.acts.push(...delta.acts);
    if (delta.keys?.length) buf.keys.push(...delta.keys);
    await chrome.storage.session.set({ trackBuf: buf });
  }).catch((e) => console.warn('轨迹暂存失败:', e.message));
  return trackWrite;
}
async function takeTrack() {
  await trackWrite; // 等在途的增量写完
  const { trackBuf } = await chrome.storage.session.get('trackBuf');
  const buf = trackBuf || { cursor: [], clicks: [], acts: [], keys: [] };
  buf.cursor.sort((a, b) => a.t - b.t);
  buf.clicks.sort((a, b) => a.t - b.t);
  buf.acts = (buf.acts || []).sort((a, b) => a - b);
  buf.keys = (buf.keys || []).sort((a, b) => a.t - b.t);
  return buf;
}
async function clearTrack() {
  await chrome.storage.session.remove('trackBuf');
}

// ---- offscreen 文档管理 ----
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: '在后台录制标签页视频流',
  });
}
async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// 与 offscreen 通信:发一条消息并等待指定回执类型
function askOffscreen(message, expectType, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(handler);
      reject(new Error('offscreen 无响应:' + expectType));
    }, timeout);
    function handler(msg) {
      if (msg && msg.type === expectType && msg.target === 'background') {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(handler);
        resolve(msg);
      }
    }
    chrome.runtime.onMessage.addListener(handler);
    chrome.runtime.sendMessage({ ...message, target: 'offscreen' }).catch(() => {});
  });
}

function canCapture(url) {
  return /^(https?|file):/i.test(url || '');
}

// 把底层报错翻成对花叔友好的提示
function friendlyCaptureError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('not been invoked') || m.includes('activetab') || m.includes('invoked'))
    return '需要先激活页面:请刷新这个标签页,再点 HuaRec 图标开始录制';
  if (m.includes('active stream') || m.includes('already'))
    return '这个标签页已有录制在进行中,请先停止上一段录制';
  if (m.includes('extension'))
    return '取流失败:请刷新页面后重试,或确认这是一个普通网页';
  return msg || '获取录制流失败,请刷新页面重试';
}

// 取 streamId,带一次重试(首帧偶发失败时自愈)
async function getStreamId(tabId, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          const err = chrome.runtime.lastError;
          if (err || !id) reject(new Error(err?.message || '获取录制流失败'));
          else resolve(id);
        });
      });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

// ---- 开始录制 ----
async function startRecording(options = {}) {
  const st = await getState();
  if (st.status !== 'idle') return { ok: false, error: '已经在录制中' };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !canCapture(tab.url)) {
    return { ok: false, error: '当前页面无法录制(仅支持 http / https / file 页面,不支持 chrome:// 或新标签页)' };
  }

  // 测量视口真实设备像素 → 用它锁定捕获分辨率/比例,避免 tabCapture 用默认比例 letterbox 出黑边。
  let viewport = null;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        w: Math.round(window.innerWidth * window.devicePixelRatio),
        h: Math.round(window.innerHeight * window.devicePixelRatio),
      }),
    });
    if (r && r.result && r.result.w && r.result.h) viewport = r.result;
  } catch (_) {}

  // 取 streamId(带一次重试)
  let streamId;
  try {
    streamId = await getStreamId(tab.id, 2);
  } catch (e) {
    return { ok: false, error: friendlyCaptureError(e.message) };
  }

  await ensureOffscreen();
  await clearTrack();
  await setState({ status: 'starting', tabId: tab.id, options });

  // 启动 offscreen 录制,拿到真实起始时间
  let started;
  try {
    started = await askOffscreen(
      { type: 'OFFSCREEN_START', streamId, options: { ...options, viewport } },
      'OFFSCREEN_STARTED'
    );
  } catch (e) {
    await closeOffscreen();
    await clearState();
    return { ok: false, error: e.message };
  }
  if (started.error) {
    await closeOffscreen();
    await clearState();
    return { ok: false, error: friendlyCaptureError(started.error) };
  }

  // 注入【隐形】光标追踪器(不渲染 UI,所以不会被录进画面)
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/tracker.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'REC_START', startTime: started.startTime, enhanceCursor: options.enhanceCursor !== false, hideCursor: options.smoothCursor === true });
  } catch (e) {
    console.warn('注入追踪器失败:', e.message);
  }

  await setState({ status: 'recording', startTime: started.startTime });
  // 录制期间用 alarm 周期性唤醒 service worker,避免 MV3 SW 休眠后停止/状态链路出意外(兜底)。
  chrome.alarms.create('huarec-keepalive', { periodInMinutes: 0.5 });
  // 控制(计时/暂停/停止)全部放在工具栏弹窗(popup)里 —— 不属于被录标签页、不会进画面、无跳转。
  // 这里只点亮工具栏角标提示「录制中」。
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF6B4A' });
  return { ok: true };
}

// ---- 暂停 / 恢复 ----
async function pauseRecording() {
  const st = await getState();
  if (st.status !== 'recording') return;
  await askOffscreen({ type: 'OFFSCREEN_PAUSE' }, 'OFFSCREEN_PAUSED').catch(() => {});
  if (st.tabId) chrome.tabs.sendMessage(st.tabId, { type: 'REC_PAUSE' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'REC_PAUSE' }).catch(() => {}); // 通知 popup(若开着)
  await setState({ status: 'paused', pausedAt: Date.now() });
  chrome.action.setBadgeText({ text: 'II' });
}
async function resumeRecording() {
  const st = await getState();
  if (st.status !== 'paused') return;
  await askOffscreen({ type: 'OFFSCREEN_RESUME' }, 'OFFSCREEN_RESUMED').catch(() => {});
  if (st.tabId) chrome.tabs.sendMessage(st.tabId, { type: 'REC_RESUME' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'REC_RESUME' }).catch(() => {}); // 通知 popup(若开着)
  const pausedTotal = (st.pausedTotal || 0) + (Date.now() - (st.pausedAt || Date.now()));
  await setState({ status: 'recording', pausedTotal, pausedAt: null });
  chrome.action.setBadgeText({ text: 'REC' });
}

// ---- 停止 + 保存 ----
async function stopRecording(opts = {}) {
  const st = await getState();
  if (st.status !== 'recording' && st.status !== 'paused') return { ok: false };
  await setState({ status: 'saving' });

  // 向追踪器收最后一段未上报的增量,再取 background 侧合并好的全量轨迹。
  // 页面若已导航/关闭(sendMessage 失败),已上报的部分仍然都在 trackBuf 里。
  if (st.tabId) {
    try {
      const resp = await chrome.tabs.sendMessage(st.tabId, { type: 'REQUEST_TRACK' });
      if (resp) await appendTrack(resp);
    } catch (_) {}
  }
  const track = await takeTrack();

  // 停止 offscreen,拿到已存库的 id
  let stopped;
  try {
    stopped = await askOffscreen({ type: 'OFFSCREEN_STOP' }, 'OFFSCREEN_STOPPED', 20000);
  } catch (e) {
    await teardown(st.tabId);
    return { ok: false, error: e.message };
  }
  if (!stopped.id) {
    await teardown(st.tabId);
    return { ok: false, error: stopped.error || '保存失败' };
  }

  // 合并光标轨迹进记录
  try {
    const rec = await getRecording(stopped.id);
    if (rec) {
      rec.cursor = track.cursor || [];
      rec.clicks = track.clicks || [];
      rec.acts = track.acts || [];
      rec.keys = track.keys || [];
      rec.meta = { ...rec.meta, skinId: st.options?.skinId || 'huashu' };
      await saveRecording(rec);
    }
  } catch (e) {
    console.warn('合并轨迹失败:', e.message);
  }

  await teardown(st.tabId);
  // 打开编辑器;若用户选了「停止·直接下载」,带 dl=1 让编辑器一打开就自动下载源片
  const dl = opts.download ? '&dl=1' : '';
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${stopped.id}${dl}`) });
  return { ok: true, id: stopped.id };
}

async function teardown(tabId) {
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'REC_TEARDOWN' }).catch(() => {});
  await closeOffscreen();
  await clearState();
  await clearTrack();
  chrome.alarms.clear('huarec-keepalive').catch(() => {});
  chrome.action.setBadgeText({ text: '' });
}

// ---- 切换(快捷键) ----
async function toggle() {
  const st = await getState();
  if (st.status === 'idle') {
    // 沿用 popup 里的偏好,保证快捷键起录与点按钮一致(音频/光标默认开,摄像头/麦克风默认关)
    const { lastAudio, lastCursor, lastCamera, lastMic, lastSmooth } = await chrome.storage.local.get(['lastAudio', 'lastCursor', 'lastCamera', 'lastMic', 'lastSmooth']);
    await startRecording({ audio: lastAudio !== false, enhanceCursor: lastCursor !== false, camera: lastCamera === true, mic: lastMic === true, smoothCursor: lastSmooth === true });
  } else await stopRecording();
}

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'START_RECORDING':
      startRecording(msg.options).then(sendResponse);
      return true;
    case 'STOP_RECORDING':
      stopRecording({ download: !!msg.download }).then(sendResponse);
      return true;
    case 'PAUSE_RECORDING':
      pauseRecording().then(() => sendResponse({ ok: true }));
      return true;
    case 'RESUME_RECORDING':
      resumeRecording().then(() => sendResponse({ ok: true }));
      return true;
    case 'GET_STATE':
      getState().then(sendResponse);
      return true;
    case 'TRACK_FLUSH':
      // 只收被录标签页的增量(防其他页面残留的旧 tracker 串数据)
      getState().then((st) => {
        if (sender.tab && sender.tab.id === st.tabId && st.status !== 'idle') appendTrack(msg);
      });
      return false;
  }
});

// 录制中跨页面导航:新页面加载完成 → 重新注入追踪器并恢复会话(原 startTime / 暂停状态),
// 光标美化也一并恢复。之前导航会让追踪器连同轨迹一起消失,运镜与波纹从那一刻起全部失效。
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const st = await getState();
  if ((st.status !== 'recording' && st.status !== 'paused') || tabId !== st.tabId) return;
  if (!canCapture(tab.url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/tracker.js'] });
    await chrome.tabs.sendMessage(tabId, {
      type: 'REC_START',
      startTime: st.startTime,
      pausedTotal: st.pausedTotal || 0,
      paused: st.status === 'paused',
      pausedAt: st.pausedAt || 0,
      enhanceCursor: st.options?.enhanceCursor !== false,
      hideCursor: st.options?.smoothCursor === true,
    });
  } catch (e) {
    console.warn('导航后重注入追踪器失败:', e.message);
  }
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-recording') toggle();
});

// 录制期间的保活 alarm:醒来读一次状态即可,目的就是把 SW 唤醒、维持录制链路可靠
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'huarec-keepalive') getState();
});
