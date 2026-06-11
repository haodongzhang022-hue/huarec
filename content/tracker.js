// 注入被录制标签页的【隐形】光标/点击追踪器。不渲染任何可见 UI,
// 所以不会被 tabCapture 录进画面。控制(计时/暂停/停止)在工具栏弹窗(popup)里。
// 轨迹不在页面里攒到最后:每 4 秒增量 flush 给 background(页面卸载前再 flush 一次),
// 这样录制中途跳转/刷新页面,已采的轨迹不丢;background 在新页面加载完会重新注入本脚本。
(function () {
  if (window.__huarecTracker) return;
  window.__huarecTracker = true;

  const state = { active: false, paused: false, startTime: 0, pausedTotal: 0, pauseStart: 0, lastSample: 0, lastAct: 0, cursor: [], clicks: [], acts: [], keys: [] };
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

  // 活动心跳:键盘/滚轮也算「有动静」。只记时间戳,绝不记按键内容。
  // 这是编辑器「自动剪空白」的原料——打字、滚动页面的片段不该被当成空白剪掉。
  function onAct() {
    if (!state.active || state.paused) return;
    const now = Date.now();
    if (now - state.lastAct < 300) return;
    state.lastAct = now;
    state.acts.push(recTime());
  }
  window.addEventListener('keydown', onAct, { capture: true, passive: true });
  window.addEventListener('wheel', onAct, { capture: true, passive: true });

  // 按键可视化原料:只记「带修饰键的组合键」和非输入场景的特殊键。
  // 纯打字(含 Shift+字母)一律不记 —— 隐私默认值要硬,打的字绝不进轨迹。
  const KEY_SYMBOL = { ' ': 'Space', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const isTyping = (el) => {
    const t = (el && el.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || (el && el.isContentEditable);
  };
  function onKey(e) {
    if (!state.active || state.paused) return;
    const k = e.key;
    if (k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift') return; // 单按修饰键不算
    const mods = (e.metaKey ? '⌘' : '') + (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '');
    let label = null;
    if (e.metaKey || e.ctrlKey || e.altKey) {
      label = mods + (KEY_SYMBOL[k] || (k.length === 1 ? k.toUpperCase() : k));
    } else if (KEY_SYMBOL[k] && !isTyping(e.target)) {
      label = (e.shiftKey ? '⇧' : '') + KEY_SYMBOL[k]; // 非输入场景的 Esc/回车/方向键等
    }
    if (label) state.keys.push({ t: recTime(), label });
  }
  window.addEventListener('keydown', onKey, { capture: true, passive: true });

  // —— 增量上报:把已采轨迹交给 background 后清空本地,数据所有权在 background ——
  let flushTimer = null;
  function flush() {
    if (!state.cursor.length && !state.clicks.length && !state.acts.length && !state.keys.length) return;
    const delta = { type: 'TRACK_FLUSH', cursor: state.cursor, clicks: state.clicks, acts: state.acts, keys: state.keys };
    state.cursor = []; state.clicks = []; state.acts = []; state.keys = [];
    try { chrome.runtime.sendMessage(delta).catch(() => {}); } catch (_) {}
  }
  function startFlushTimer() {
    if (!flushTimer) flushTimer = setInterval(flush, 4000);
  }
  function stopFlushTimer() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  }
  // 页面即将卸载(跳转/刷新/关闭)→ 最后一次 flush,别等定时器
  window.addEventListener('pagehide', flush);

  // —— 路径B:录制时把页面默认光标换成一个干净的 macOS 风箭头 ——
  // 原理:CSS cursor 改的是「同一个」光标(你看到的=被录进去的),所以画面里只有一个、更好看的光标,
  // 不会双影,你全程也看得见。cursor 是可继承属性:设在 :root 上,普通区域继承我们的箭头,
  // 而按钮的手型 / 输入框竖线(元素自带 cursor)照常保留,语义不丢。
  const CURSOR_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='30' viewBox='0 0 28 30'>" +
    "<path d='M7 4 L7 25 L12.5 19.5 L16 27 L19 25.5 L15.5 18.5 L23 18.5 Z' fill='#000' opacity='0.3' transform='translate(1.3,1.7)'/>" +
    "<path d='M7 4 L7 25 L12.5 19.5 L16 27 L19 25.5 L15.5 18.5 L23 18.5 Z' fill='#fff' stroke='#1c1c1e' stroke-width='1.6' stroke-linejoin='round'/>" +
    "</svg>";
  // —— 平滑光标模式:把所有光标缩成一个近隐形小点 ——
  // tabCapture 会把真实光标录进画面;后期要重绘平滑大光标,真实光标就得从画面里"消失"。
  // 完全 cursor:none 用户录制时就找不到自己的鼠标了,所以折中成 6px 半透明小点:
  // 用户能定位,画面里几乎看不见,导出时上面还会盖一个重绘的光标。
  const DOT_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='6' height='6'>" +
    "<circle cx='3' cy='3' r='2.6' fill='#888' fill-opacity='0.55'/></svg>";

  let cursorStyleEl = null;
  function setCursorStyle(css) {
    if (cursorStyleEl) { cursorStyleEl.remove(); cursorStyleEl = null; }
    if (!css) return;
    cursorStyleEl = document.createElement('style');
    cursorStyleEl.id = '__huarecCursor';
    cursorStyleEl.textContent = css;
    (document.head || document.documentElement).appendChild(cursorStyleEl);
  }
  function enhanceCursor() {
    // html+body 都加 !important:页面若显式设了 body{cursor} 也能压过;按钮/输入框自带的 pointer/text
    // 是元素自身声明,不受影响,语义光标照常保留。
    const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(CURSOR_SVG)}") 7 4, auto`;
    setCursorStyle(`html,body{cursor:${url} !important}`);
  }
  function dotCursor() {
    // 用 * 覆盖元素自带光标(pointer/text 一并压成小点),画面里才不会冒出手型/竖线
    const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(DOT_SVG)}") 3 3, none`;
    setCursorStyle(`*{cursor:${url} !important}`);
  }
  function restoreCursor() { setCursorStyle(null); }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'REC_START': {
        // 导航后重注入会再收到一次 REC_START(带同一个 startTime):只同步状态,不清未上报数据
        const sameSession = state.active && state.startTime === (msg.startTime || 0);
        state.active = true;
        state.startTime = msg.startTime || Date.now();
        state.pausedTotal = msg.pausedTotal || 0;
        state.paused = !!msg.paused;
        state.pauseStart = state.paused ? (msg.pausedAt || Date.now()) : 0;
        if (!sameSession) { state.cursor = []; state.clicks = []; state.acts = []; state.keys = []; }
        if (msg.hideCursor) dotCursor();
        else if (msg.enhanceCursor) enhanceCursor();
        else restoreCursor();
        startFlushTimer();
        break;
      }
      case 'REC_PAUSE':
        state.paused = true; state.pauseStart = Date.now();
        break;
      case 'REC_RESUME':
        if (state.pauseStart) state.pausedTotal += Date.now() - state.pauseStart;
        state.paused = false; state.pauseStart = 0;
        break;
      case 'REQUEST_TRACK': {
        // 停止时 background 来收尾:交出最后一段未上报的增量(全量轨迹由 background 合并)
        const delta = { cursor: state.cursor, clicks: state.clicks, acts: state.acts, keys: state.keys };
        state.cursor = []; state.clicks = []; state.acts = []; state.keys = [];
        sendResponse(delta);
        return true;
      }
      case 'REC_TEARDOWN':
        state.active = false; stopFlushTimer(); restoreCursor();
        break;
    }
  });
})();
