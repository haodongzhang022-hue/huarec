// 注入被录制标签页的【隐形】光标/点击追踪器。不渲染任何可见 UI,
// 所以不会被 tabCapture 录进画面。控制(计时/暂停/停止)在工具栏弹窗(popup)里。
(function () {
  if (window.__huarecTracker) return;
  window.__huarecTracker = true;

  const state = { active: false, paused: false, startTime: 0, pausedTotal: 0, pauseStart: 0, lastSample: 0, cursor: [], clicks: [] };
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const recTime = () => Date.now() - state.startTime - state.pausedTotal;
  // 用 clientWidth/Height(不含滚动条),否则有滚动条的页面 innerWidth 偏大 → 归一化坐标系统性偏左/偏上
  const vw = () => document.documentElement.clientWidth || window.innerWidth;
  const vh = () => document.documentElement.clientHeight || window.innerHeight;

  function onMove(e) {
    if (!state.active || state.paused) return;
    const now = Date.now();
    if (now - state.lastSample < 33) return;
    state.lastSample = now;
    state.cursor.push({ t: recTime(), x: clamp01(e.clientX / vw()), y: clamp01(e.clientY / vh()) });
  }
  function onDown(e) {
    if (!state.active || state.paused) return;
    state.clicks.push({ t: recTime(), x: clamp01(e.clientX / vw()), y: clamp01(e.clientY / vh()) });
  }
  window.addEventListener('mousemove', onMove, { capture: true, passive: true });
  window.addEventListener('mousedown', onDown, { capture: true, passive: true });

  // —— 路径B:录制时把页面默认光标换成一个干净的 macOS 风箭头 ——
  // 原理:CSS cursor 改的是「同一个」光标(你看到的=被录进去的),所以画面里只有一个、更好看的光标,
  // 不会双影,你全程也看得见。cursor 是可继承属性:设在 :root 上,普通区域继承我们的箭头,
  // 而按钮的手型 / 输入框竖线(元素自带 cursor)照常保留,语义不丢。
  const CURSOR_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='30' viewBox='0 0 28 30'>" +
    "<path d='M7 4 L7 25 L12.5 19.5 L16 27 L19 25.5 L15.5 18.5 L23 18.5 Z' fill='#000' opacity='0.3' transform='translate(1.3,1.7)'/>" +
    "<path d='M7 4 L7 25 L12.5 19.5 L16 27 L19 25.5 L15.5 18.5 L23 18.5 Z' fill='#fff' stroke='#1c1c1e' stroke-width='1.6' stroke-linejoin='round'/>" +
    "</svg>";
  let cursorStyleEl = null;
  function enhanceCursor() {
    if (cursorStyleEl) return;
    cursorStyleEl = document.createElement('style');
    cursorStyleEl.id = '__huarecCursor';
    // html+body 都加 !important:页面若显式设了 body{cursor} 也能压过;按钮/输入框自带的 pointer/text
    // 是元素自身声明,不受影响,语义光标照常保留。
    const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(CURSOR_SVG)}") 7 4, auto`;
    cursorStyleEl.textContent = `html,body{cursor:${url} !important}`;
    (document.head || document.documentElement).appendChild(cursorStyleEl);
  }
  function restoreCursor() { if (cursorStyleEl) { cursorStyleEl.remove(); cursorStyleEl = null; } }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'REC_START':
        state.active = true; state.paused = false;
        state.startTime = msg.startTime || Date.now();
        state.pausedTotal = 0; state.cursor = []; state.clicks = [];
        if (msg.enhanceCursor) enhanceCursor(); else restoreCursor();
        break;
      case 'REC_PAUSE':
        state.paused = true; state.pauseStart = Date.now();
        break;
      case 'REC_RESUME':
        if (state.pauseStart) state.pausedTotal += Date.now() - state.pauseStart;
        state.paused = false; state.pauseStart = 0;
        break;
      case 'REQUEST_TRACK':
        sendResponse({ cursor: state.cursor, clicks: state.clicks });
        return true;
      case 'REC_TEARDOWN':
        state.active = false; restoreCursor();
        break;
    }
  });
})();
