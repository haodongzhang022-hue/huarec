const $ = (id) => document.getElementById(id);
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let timer = null;
let camStream = null;

// 摄像头预览开/关。interactive=false 用于打开弹窗时静默恢复上次勾选:
// 失败(权限被收回/设备被占用)只悄悄取消勾选,不弹授权页打扰。
async function setCamPreview(on, interactive) {
  const v = $('camPreview');
  if (!on) {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null; v.srcObject = null; v.hidden = true; $('camHint').hidden = true;
    return true;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    v.srcObject = camStream; v.hidden = false; $('camHint').hidden = false;
    return true;
  } catch (e) {
    if (!interactive) return false;
    // 弹窗里弹原生权限框不可靠(弹窗可能被顶掉)→ 没权限时开一个专门的授权页引导
    if (e.name === 'NotAllowedError') {
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
      window.close();
    } else {
      const err = $('error');
      err.hidden = false;
      err.textContent = '无法访问摄像头:' + (e.name === 'NotFoundError' ? '没有检测到摄像头设备' : e.message);
    }
    return false;
  }
}

async function init() {
  const { lastAudio, lastCursor, lastCamera } = await chrome.storage.local.get(['lastAudio', 'lastCursor', 'lastCamera']);
  if (lastAudio === false) $('audio').checked = false;
  if (lastCursor === false) $('cursor').checked = false;
  if (lastCamera === true) {
    $('camera').checked = true;
    setCamPreview(true, false).then((ok) => { if (!ok) $('camera').checked = false; });
  }
  $('camera').addEventListener('change', async (e) => {
    const ok = await setCamPreview(e.target.checked, true);
    if (!ok) e.target.checked = false;
    chrome.storage.local.set({ lastCamera: $('camera').checked });
  });

  const st = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => ({ status: 'idle' }));
  setView(st || { status: 'idle' });

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => stop(false));
  $('stopDl').addEventListener('click', () => stop(true));
  $('pause').addEventListener('click', togglePause);
  $('library').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
    window.close();
  });

  // 录制中若 background 广播暂停/恢复(例如快捷键触发),同步弹窗 UI
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'REC_PAUSE' || msg.type === 'REC_RESUME') refresh();
  });
}

function setView(st) {
  const status = st.status || 'idle';
  const live = status === 'recording' || status === 'paused' || status === 'saving';
  $('idle').hidden = live;
  $('live').hidden = !live;
  if (!live) { stopTimer(); return; }

  const paused = status === 'paused';
  const saving = status === 'saving';
  $('livedot').classList.toggle('paused', paused);
  $('pause').textContent = paused ? '继续' : '暂停';
  $('livetext').textContent = saving ? '保存中…' : (paused ? '已暂停' : '录制中');
  $('pause').disabled = saving; $('stop').disabled = saving;
  $('pause').style.opacity = saving ? '.5' : '1';

  // 计时:elapsed = now - startTime - 累计暂停 - (暂停中则加上当前这段暂停)
  const tick = () => {
    const extra = (paused && st.pausedAt) ? (Date.now() - st.pausedAt) : 0;
    const ms = (st.startTime ? Date.now() - st.startTime : 0) - (st.pausedTotal || 0) - extra;
    $('liveTime').textContent = fmt(ms);
  };
  tick();
  stopTimer();
  if (!paused && !saving) timer = setInterval(tick, 250);
}

function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null);
  if (st) setView(st);
}

async function start() {
  const audio = $('audio').checked;
  const enhanceCursor = $('cursor').checked;
  const camera = $('camera').checked;
  chrome.storage.local.set({ lastAudio: audio, lastCursor: enhanceCursor, lastCamera: camera });
  // 先放掉弹窗占用的摄像头,offscreen 才能稳拿同一台设备
  await setCamPreview(false);
  const res = await chrome.runtime.sendMessage({ type: 'START_RECORDING', options: { audio, enhanceCursor, camera } });
  if (res && res.ok) {
    window.close();
  } else {
    const err = $('error');
    err.hidden = false;
    err.textContent = res?.error || '启动失败,请重试';
  }
}

async function togglePause() {
  const st = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null);
  const type = st?.status === 'paused' ? 'RESUME_RECORDING' : 'PAUSE_RECORDING';
  await chrome.runtime.sendMessage({ type });
  refresh();
}

async function stop(download) {
  $('livetext').textContent = '保存中…';
  $('stop').disabled = true; $('pause').disabled = true; $('stopDl').disabled = true;
  stopTimer();
  const res = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING', download: !!download }).catch(() => null);
  if (res && res.ok) { window.close(); return; }
  // 失败不静默关闭:录像通常已存库,给用户明确指引,别让人以为录像没了
  const err = $('error');
  err.hidden = false;
  err.textContent = '保存遇到问题。录像一般已存入录制库,点右上「最近」即可找到。';
  $('stop').disabled = false; $('pause').disabled = false; $('stopDl').disabled = false;
  $('livetext').textContent = '已停止';
}

init();
