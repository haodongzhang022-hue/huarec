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
    camStream = null; v.srcObject = null; v.hidden = true;
    return true;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    v.srcObject = camStream; v.hidden = false;
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

// 麦克风开关:勾选时做一次权限探测(立刻放掉设备,真正占用在录制开始后)
async function checkMic(interactive) {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    if (!interactive) return false;
    if (e.name === 'NotAllowedError') {
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
      window.close();
    } else {
      const err = $('error');
      err.hidden = false;
      err.textContent = '无法访问麦克风:' + (e.name === 'NotFoundError' ? '没有检测到麦克风设备' : e.message);
    }
    return false;
  }
}

// 光标三选一:原始(页面原样)/ 美化(macOS 风箭头)/ 平滑(隐形小点 + 后期重绘)
let curMode = 'enhance';
const CUR_HINTS = {
  raw: '保持页面原本的光标,不做处理',
  enhance: '画面里的光标换成干净的 macOS 风箭头',
  smooth: '录完后期重绘:大小可调、移动丝滑,教程首选',
};
function setCurMode(m, save) {
  curMode = m;
  document.querySelectorAll('#cursorSeg button').forEach((b) => b.classList.toggle('on', b.dataset.cur === m));
  $('curHint').textContent = CUR_HINTS[m];
  if (save) chrome.storage.local.set({ lastCursor: m !== 'raw', lastSmooth: m === 'smooth' });
}

async function init() {
  const { lastAudio, lastCursor, lastCamera, lastMic, lastSmooth } = await chrome.storage.local.get(['lastAudio', 'lastCursor', 'lastCamera', 'lastMic', 'lastSmooth']);
  if (lastAudio === false) $('audio').checked = false;
  setCurMode(lastSmooth === true ? 'smooth' : lastCursor === false ? 'raw' : 'enhance', false);
  document.querySelectorAll('#cursorSeg button').forEach((b) => {
    b.addEventListener('click', () => setCurMode(b.dataset.cur, true));
  });
  if (lastCamera === true) {
    $('camera').checked = true;
    setCamPreview(true, false).then((ok) => { if (!ok) $('camera').checked = false; });
  }
  if (lastMic === true) $('mic').checked = true;
  $('camera').addEventListener('change', async (e) => {
    const ok = await setCamPreview(e.target.checked, true);
    if (!ok) e.target.checked = false;
    chrome.storage.local.set({ lastCamera: $('camera').checked });
  });
  $('mic').addEventListener('change', async (e) => {
    if (e.target.checked && !(await checkMic(true))) e.target.checked = false;
    chrome.storage.local.set({ lastMic: $('mic').checked });
  });

  const st = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => ({ status: 'idle' }));
  setView(st || { status: 'idle' });

  $('start').addEventListener('click', start);
  $('switchHere').addEventListener('click', async () => {
    const r = await chrome.runtime.sendMessage({ type: 'SWITCH_RECORDING' }).catch(() => null);
    if (r && r.ok) { window.close(); return; }
    const err = $('error');
    err.hidden = false;
    err.textContent = r?.error || '切换失败,请重试';
  });
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
  $('switchGuide').hidden = true;
  if (!live) { stopTimer(); return; }

  // 当前标签页 ≠ 被录标签页 → 先尝试自动接力（打开弹窗即完成扩展授权，取流必成），
  // 只有 auto-switch 也失败才展示手动接力按钮作为最终兜底。
  $('switchHere').hidden = true;
  if (status !== 'saving' && st.tabId) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (tab && tab.id !== st.tabId && /^(https?|file):/i.test(tab.url || '')) {
        // 自动接力：弹窗已打开 → 该标签页完成了扩展授权 → 直接切
        try {
          let r = await chrome.runtime.sendMessage({ type: 'SWITCH_RECORDING' });
          if (r && r.ok) {
            // 切换成功：直接关弹窗（无需 refresh，避免在已关窗的 DOM 上操作）
            window.close();
            return;
          }
          // background 可能正在 onActivated 切换中（switching=true），稍等重试一次
          if (r?.error?.includes('正在切换中')) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            r = await chrome.runtime.sendMessage({ type: 'SWITCH_RECORDING' });
            if (r && r.ok) {
              window.close();
              return;
            }
          }
          // 自动接力失败 → 记录原因并展示引导文案 + 手动按钮
          console.warn('自动切换失败:', r?.error);
        } catch (e) {
          console.warn('自动切换异常:', e);
        }
        $('switchGuide').hidden = false;
        $('switchHere').hidden = false;
      }
    });
  }

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
  const camera = $('camera').checked;
  const mic = $('mic').checked;
  const enhanceCursor = curMode !== 'raw';
  const smoothCursor = curMode === 'smooth';
  chrome.storage.local.set({ lastAudio: audio, lastCursor: enhanceCursor, lastCamera: camera, lastMic: mic, lastSmooth: smoothCursor });
  // 先放掉弹窗占用的摄像头,offscreen 才能稳拿同一台设备
  await setCamPreview(false);
  const res = await chrome.runtime.sendMessage({ type: 'START_RECORDING', options: { audio, enhanceCursor, camera, mic, smoothCursor } });
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
