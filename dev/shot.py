# 设计自校验截图器:以未打包扩展启动 Chromium,注入一段合成录像,
# 截 popup / 录制库 / 编辑器 三张图。用法:python3 dev/shot.py [输出后缀]
import sys, time, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dev" / "shots"
OUT.mkdir(parents=True, exist_ok=True)
suffix = f"-{sys.argv[1]}" if len(sys.argv) > 1 else ""

MAKE_DEMO = """
async () => {
  const db = await import(chrome.runtime.getURL('lib/db.js'));
  const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
  const cx = cv.getContext('2d');
  const stream = cv.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => (rec.onstop = r));
  rec.start(200);
  const t0 = performance.now();
  await new Promise((res) => {
    (function draw() {
      const t = performance.now() - t0;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, 1280, 720);
      cx.fillStyle = '#1a73e8'; cx.fillRect(0, 0, 1280, 64);
      cx.fillStyle = '#fff'; cx.font = '700 24px sans-serif'; cx.fillText('Demo Page', 32, 40);
      cx.fillStyle = '#202124'; cx.font = '400 18px sans-serif';
      for (let i = 0; i < 12; i++) cx.fillText('这是一行示意正文内容,用来让缩略图看起来像真实网页。', 60, 130 + i * 44);
      cx.fillStyle = '#FF6B4A';
      cx.beginPath(); cx.arc(300 + (t / 3000) * 600, 400, 24, 0, Math.PI * 2); cx.fill();
      if (t < 3000) requestAnimationFrame(draw); else res();
    })();
  });
  rec.stop(); await done;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const cursor = [];
  for (let t = 0; t < 3000; t += 40) cursor.push({ t, x: 0.3 + 0.4 * (t / 3000), y: 0.45 + 0.1 * Math.sin(t / 300) });
  await db.saveRecording({
    id: 'demo1', blob, cursor,
    clicks: [{ t: 700, x: 0.4, y: 0.5 }, { t: 1800, x: 0.7, y: 0.4 }],
    acts: [], keys: [{ t: 1200, label: '\\u2318K' }],
    meta: { width: 1280, height: 720, durationMs: 3000, hasAudio: false, createdAt: Date.now() },
  });
  return 'ok';
}
"""

UNHIDE = """
() => {
  for (const id of ['gCam', 'gAudio', 'rowTabVol', 'rowMicVol']) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
}
"""

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        f"/tmp/huarec-prof-{int(time.time()*1000)}",
        headless=True,
        channel="chromium",  # 新版 headless 才支持扩展;默认 headless shell 不行
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
    )
    sws = ctx.service_workers
    sw = sws[0] if sws else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]

    page = ctx.new_page()
    page.set_viewport_size({"width": 1440, "height": 900})

    page.goto(f"chrome-extension://{ext_id}/popup/popup.html")
    page.wait_for_timeout(400)
    page.locator("#app").screenshot(path=str(OUT / f"popup{suffix}.png"))

    page.goto(f"chrome-extension://{ext_id}/editor/editor.html")
    page.wait_for_timeout(300)
    page.evaluate(MAKE_DEMO)

    page.reload()
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / f"library{suffix}.png"))

    page.goto(f"chrome-extension://{ext_id}/editor/editor.html?id=demo1")
    page.wait_for_timeout(2800)
    page.evaluate(UNHIDE)
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / f"editor{suffix}.png"))

    ctx.close()
print("shots saved to", OUT)
