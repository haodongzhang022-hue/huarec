const $ = (id) => document.getElementById(id);
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let timer = null;

async function init() {
  const { lastAudio, lastCursor } = await chrome.storage.local.get(['lastAudio', 'lastCursor']);
  if (lastAudio === false) $('audio').checked = false;
  if (lastCursor === false) $('cursor').checked = false;

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
  chrome.storage.local.set({ lastAudio: audio, lastCursor: enhanceCursor });
  const res = await chrome.runtime.sendMessage({ type: 'START_RECORDING', options: { audio, enhanceCursor } });
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
