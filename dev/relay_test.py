# 跨标签页接力录制端到端测试:
# A 页(纯红)起录 → 切到 B 页(纯蓝)→ 停止 → 校验成片在 1s 处是红、4.5s 处是蓝、无孤儿会话。
# 用 --allowlisted-extension-id 绕过 tabCapture 的「必须先点扩展」限制(仅测试环境)。
import time, pathlib, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
A = pathlib.Path("/tmp/hua_a.html"); A.write_text("<body style='background:#e02020'><h1 style='color:#fff'>PAGE A</h1></body>")
B = pathlib.Path("/tmp/hua_b.html"); B.write_text("<body style='background:#2040e0'><h1 style='color:#fff'>PAGE B</h1></body>")

CHECK = """
async () => {
  const db = await import(chrome.runtime.getURL('lib/db.js'));
  const rows = await db.listRecordings();
  const sessions = await db.getSessions();
  if (!rows.length) return { ok: false, why: 'no recording saved', sessions: sessions.length };
  const rec = await db.getRecording(rows[0].id);
  const url = URL.createObjectURL(rec.blob);
  const v = document.createElement('video');
  v.src = url; v.muted = true;
  await new Promise((res) => { v.onloadedmetadata = res; v.onerror = () => res(); });
  const seek = (t) => new Promise((res) => { v.onseeked = res; v.currentTime = t; });
  const pick = () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.drawImage(v, v.videoWidth/2 - 32, v.videoHeight/2 - 32, 64, 64, 0, 0, 64, 64);
    const d = x.getImageData(32, 32, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  // 触发时长探测(MediaRecorder webm 可能无 duration)
  if (!isFinite(v.duration)) { await new Promise((res)=>{ v.ontimeupdate = () => { if (v.currentTime > 0) res(); }; v.currentTime = 1e7; }); }
  const dur = v.duration;
  await seek(1.0); const early = pick();
  await seek(Math.max(2, Math.min(dur - 0.4, 4.5))); const late = pick();
  return { ok: true, durationMs: rows[0].meta?.durationMs, dur, early, late, sessions: sessions.length, size: rows[0].size };
}
"""

with sync_playwright() as p:
    # 第一阶段:拿扩展 ID(由路径决定,稳定)
    ctx = p.chromium.launch_persistent_context("/tmp/hua-relay-id", headless=True, channel="chromium",
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"])
    sws = ctx.service_workers
    sw = sws[0] if sws else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    ctx.close()

    # 第二阶段:带 allowlist 启动,真测
    ctx = p.chromium.launch_persistent_context(f"/tmp/hua-relay-{int(time.time())}", headless=True, channel="chromium",
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}",
              f"--allowlisted-extension-id={ext_id}", f"--whitelisted-extension-id={ext_id}"])
    sws = ctx.service_workers
    sw = sws[0] if sws else ctx.wait_for_event("serviceworker")

    ctrl = ctx.new_page()  # 控制页(扩展页,用来发消息/查库)
    ctrl.goto(f"chrome-extension://{ext_id}/editor/editor.html")

    pa = ctx.new_page(); pa.goto(A.as_uri())
    pb = ctx.new_page(); pb.goto(B.as_uri())

    pa.bring_to_front(); pa.wait_for_timeout(400)
    r = ctrl.evaluate("() => chrome.runtime.sendMessage({type:'START_RECORDING', options:{audio:false, enhanceCursor:false}})")
    print("START:", json.dumps(r, ensure_ascii=False))
    if not (r or {}).get("ok"):
        ctx.close(); raise SystemExit("start failed")

    pa.wait_for_timeout(2500)      # A 页录 2.5s
    pb.bring_to_front()            # 切到 B → 应自动接力
    pb.wait_for_timeout(3500)      # B 页录 3.5s

    st = ctrl.evaluate("() => chrome.runtime.sendMessage({type:'GET_STATE'})")
    print("STATE before stop:", json.dumps(st, ensure_ascii=False))
    r = ctrl.evaluate("() => chrome.runtime.sendMessage({type:'STOP_RECORDING'})")
    print("STOP:", json.dumps(r, ensure_ascii=False))
    ctrl.wait_for_timeout(1200)

    out = ctrl.evaluate(CHECK)
    print("CHECK:", json.dumps(out, ensure_ascii=False))
    ctx.close()

    e, l = out.get("early"), out.get("late")
    red = e and e[0] > 150 and e[2] < 100
    blue = l and l[2] > 150 and l[0] < 100
    print("EARLY is RED:", red, "| LATE is BLUE:", blue, "| orphan sessions:", out.get("sessions"))
    print("RELAY-TEST:", "PASS" if (out.get("ok") and red and blue and out.get("sessions") == 0) else "PARTIAL/FAIL")
