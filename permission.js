// 摄像头授权引导页:在完整标签页里弹原生权限框(弹窗 popup 里弹框不可靠)。
// 授权给扩展 origin 后,offscreen 录制文档同样获得权限。
const $ = (id) => document.getElementById(id);

async function ask() {
  $('fail').classList.remove('on');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    $('pv').srcObject = stream;
    $('pv').classList.add('on');
    $('ok').classList.add('on');
    $('ask').style.display = 'none';
    chrome.storage.local.set({ lastCamera: true });
  } catch (e) {
    $('fail').classList.add('on');
  }
}

$('ask').addEventListener('click', ask);
ask(); // 打开页面就先请求一次,少点一下
