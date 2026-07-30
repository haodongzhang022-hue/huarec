// 新标签页录制未接力的提示浮层。
// 当 tabCapture 自动取流被 Chrome 拒绝(非用户手势上下文)时注入,
// 引导用户点击扩展图标手动完成接力。
(function () {
  if (window.__huarecToast) return;
  window.__huarecToast = true;

  const TOAST_HTML = `
    <div id="__huarecToast" style="
      position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;
      background:#1c1c1e;color:#fff;border-radius:14px;padding:12px 22px 12px 18px;
      font:13px/1.5 system-ui,-apple-system,sans-serif;
      box-shadow:0 6px 24px rgba(0,0,0,.35);
      display:flex;align-items:center;gap:12px;
      animation:__huarecToastIn .35s ease;
      user-select:none;-webkit-user-select:none;
    ">
      <span style="font-size:18px;">🎬</span>
      <span style="flex:1;">录制未自动跟随到此标签页<br><span style="color:#FFB74D;font-size:11px;">点击工具栏 <b>HuaRec</b> 图标手动切换</span></span>
      <button id="__huarecToastClose" style="
        background:none;border:none;color:#999;font-size:16px;cursor:pointer;
        padding:2px 6px;border-radius:6px;line-height:1;
        transition:color .15s;
      " title="关闭">✕</button>
    </div>
    <style>
      @keyframes __huarecToastIn {
        from { opacity:0; transform:translateX(-50%) translateY(-12px); }
        to   { opacity:1; transform:translateX(-50%) translateY(0); }
      }
    </style>`;

  document.body.insertAdjacentHTML('beforeend', TOAST_HTML);

  const toast = document.getElementById('__huarecToast');
  const closeBtn = document.getElementById('__huarecToastClose');

  closeBtn.addEventListener('click', () => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .2s';
    setTimeout(() => toast.remove(), 250);
  });

  // 8 秒后自动消失
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity .3s';
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 350);
    }
  }, 8000);

  // 监听来自 background 的关闭指令(切换成功后清理)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TOAST_DISMISS' && toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity .15s';
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 200);
    }
  });
})();
