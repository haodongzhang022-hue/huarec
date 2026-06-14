// 摄像头/麦克风授权引导页:在完整标签页里弹原生权限框(弹窗 popup 里弹框不可靠)。
// 授权给扩展 origin 后,offscreen 录制文档同样获得权限。
// 两个设备分开请求只有麦克风没摄像头(或反过来)的机器也能各授各的。
const $ = (id) => document.getElementById(id);

async function ask() {
  $('fail').classList.remove('on');
  let okCam = false, okMic = false;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    $('pv').srcObject = s;
    $('pv').classList.add('on');
    okCam = true;
    chrome.storage.local.set({ lastCamera: true });
  } catch (e) { /* 没摄像头或被拒,看下面的状态行 */ }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
    okMic = true;
    chrome.storage.local.set({ lastMic: true });
  } catch (e) { /* 同上 */ }

  $('stCam').textContent = okCam ? '✓ 摄像头已授权' : '✗ 摄像头未授权';
  $('stMic').textContent = okMic ? '✓ 麦克风已授权' : '✗ 麦克风未授权';
  $('stCam').className = 'st ' + (okCam ? 'good' : 'bad');
  $('stMic').className = 'st ' + (okMic ? 'good' : 'bad');

  if (okCam || okMic) {
    $('ok').classList.add('on');
    $('ask').textContent = '重新检测';
  }
  if (!okCam || !okMic) $('fail').classList.add('on');
}

$('ask').addEventListener('click', ask);
ask(); // 打开页面就先请求一次,少点一下
