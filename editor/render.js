// 渲染引擎:预览与导出共用。纯函数式,绘制单帧到 canvas。
// 坐标约定:光标/点击均为 0..1 归一化(相对录制时的视口)。

export function smoothstep(e) { e = Math.max(0, Math.min(1, e)); return e * e * (3 - 2 * e); }

// ---- 自动运镜:从点击聚类成运镜段 ----
// 返回 [{start,end, points:[{t,x,y}]}],时间单位 ms(录制时间轴)
export function buildZoomSegments(clicks, { lead = 450, tail = 1500 } = {}) {
  if (!clicks || !clicks.length) return [];
  const sorted = [...clicks].sort((a, b) => a.t - b.t);
  const segs = [];
  for (const c of sorted) {
    const s = c.t - lead, e = c.t + tail;
    const last = segs[segs.length - 1];
    if (last && s <= last.end) {
      last.end = Math.max(last.end, e);
      last.points.push({ t: c.t, x: c.x, y: c.y });
    } else {
      segs.push({ start: s, end: e, points: [{ t: c.t, x: c.x, y: c.y }] });
    }
  }
  return segs;
}

// 在时间 t(ms)求运镜状态:{scale, fx, fy}
export function zoomAt(segs, t, zoomLevel, ramp = 500) {
  if (!segs.length || zoomLevel <= 1.001) return { scale: 1, fx: 0.5, fy: 0.5 };
  const seg = segs.find((s) => t >= s.start && t <= s.end);
  if (!seg) return { scale: 1, fx: 0.5, fy: 0.5 };
  // 动态推拉时长:短段不能全程在过渡中,至少留一段稳定的放大态(否则像没推到位就缩回)
  const r = Math.min(ramp, (seg.end - seg.start) * 0.35);
  let e = 1;
  if (t < seg.start + r) e = smoothstep((t - seg.start) / r);
  else if (t > seg.end - r) e = smoothstep((seg.end - t) / r);
  const scale = 1 + (zoomLevel - 1) * e;
  // 焦点:在段内的多个点之间按时间插值,形成自动平移
  const pts = seg.points;
  let fx = pts[0].x, fy = pts[0].y;
  if (pts.length > 1) {
    if (t <= pts[0].t) { fx = pts[0].x; fy = pts[0].y; }
    else if (t >= pts[pts.length - 1].t) { fx = pts[pts.length - 1].x; fy = pts[pts.length - 1].y; }
    else {
      for (let i = 0; i < pts.length - 1; i++) {
        if (t >= pts[i].t && t <= pts[i + 1].t) {
          const k = smoothstep((t - pts[i].t) / (pts[i + 1].t - pts[i].t || 1));
          fx = pts[i].x + (pts[i + 1].x - pts[i].x) * k;
          fy = pts[i].y + (pts[i + 1].y - pts[i].y) * k;
          break;
        }
      }
    }
  }
  return { scale, fx, fy };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function paintBackground(ctx, bg, W, H) {
  if (!bg || bg.type === 'none') { ctx.clearRect(0, 0, W, H); return; }
  if (bg.type === 'solid') {
    ctx.fillStyle = bg.value; ctx.fillRect(0, 0, W, H);
  } else if (bg.type === 'aurora') {
    // ① 多停靠点对角线性渐变作底(macOS 壁纸式的色彩旅程)
    const gd = bg.grad, rad = (gd.angle || 145) * Math.PI / 180;
    const cx = W / 2, cy = H / 2, dx = Math.cos(rad) * W, dy = Math.sin(rad) * H;
    const lg = ctx.createLinearGradient(cx - dx / 2, cy - dy / 2, cx + dx / 2, cy + dy / 2);
    for (const [pos, color] of gd.stops) lg.addColorStop(pos, color);
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
    // ② 叠大而柔的径向光斑,制造光源与纵深
    if (bg.blobs) {
      const maxD = Math.max(W, H);
      for (const b of bg.blobs) {
        const r = b.r * maxD;
        const g = ctx.createRadialGradient(b.cx * W, b.cy * H, 0, b.cx * W, b.cy * H, r);
        g.addColorStop(0, hexA(b.color, b.alpha != null ? b.alpha : 0.5));
        g.addColorStop(1, hexA(b.color, 0));
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
    }
  } else {
    const rad = (bg.angle || 155) * Math.PI / 180;
    const cx = W / 2, cy = H / 2;
    const dx = Math.cos(rad) * W, dy = Math.sin(rad) * H;
    const g = ctx.createLinearGradient(cx - dx / 2, cy - dy / 2, cx + dx / 2, cy + dy / 2);
    g.addColorStop(0, bg.stops[0]); g.addColorStop(1, bg.stops[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  // 微弱径向暗角:增加层次感,避免平涂的廉价感。浅色背景几乎不压暗。
  const vg = ctx.createRadialGradient(W / 2, H * 0.4, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, bg.light ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.2)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
}

// 主绘制:画一帧网页内容(含运镜/光标/点击/水印)
// videoTimeMs:相对录制起点的时间,用于查轨迹
export function drawScene(ctx, video, videoTimeMs, cfg, data, W, H) {
  const k = W / 1280;
  paintBackground(ctx, cfg.background, W, H);

  // 视频卡片矩形(留白内缩)。
  // 关键:左右留白用 W 的比例、上下用 H 的比例,分轴计算 → 卡片 aspect 严格等于
  // 画布(=视频)aspect,drawImage 整帧映射不变形。若两轴共用 min(W,H) 会破坏宽高比 → 横向拉伸。
  const padX = cfg.padding * W, padY = cfg.padding * H;
  const rx = padX, ry = padY, rw = W - padX * 2, rh = H - padY * 2;
  const radius = (cfg.padding > 0 ? cfg.radius : 0) * k;

  // 阴影
  if (cfg.shadow > 0 && cfg.padding > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.5 * cfg.shadow})`;
    ctx.shadowBlur = 70 * cfg.shadow * k;
    ctx.shadowOffsetY = 26 * cfg.shadow * k;
    ctx.fillStyle = '#000';
    roundRect(ctx, rx, ry, rw, rh, radius); ctx.fill();
    ctx.restore();
  }

  // 运镜裁剪源区域
  const VW = video.videoWidth || W, VH = video.videoHeight || H;
  const z = cfg.autoZoom ? zoomAt(data.zoomSegs, videoTimeMs, cfg.zoomLevel) : { scale: 1, fx: 0.5, fy: 0.5 };
  const cw = VW / z.scale, ch = VH / z.scale;
  const cx0 = Math.max(0, Math.min(VW - cw, z.fx * VW - cw / 2));
  const cy0 = Math.max(0, Math.min(VH - ch, z.fy * VH - ch / 2));

  ctx.save();
  roundRect(ctx, rx, ry, rw, rh, radius); ctx.clip();
  try { ctx.drawImage(video, cx0, cy0, cw, ch, rx, ry, rw, rh); } catch (_) {}

  // 源归一化坐标 → 卡片屏幕坐标
  const toScreen = (nx, ny) => ({
    x: rx + ((nx * VW - cx0) / cw) * rw,
    y: ry + ((ny * VH - cy0) / ch) * rh,
  });

  // 点击特效(扩散环)
  if (cfg.clickFx && data.clicks) {
    for (const c of data.clicks) {
      const age = videoTimeMs - c.t;
      if (age < 0 || age > 600) continue;
      const p = toScreen(c.x, c.y);
      const e = age / 600;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, (10 + 34 * e) * k * z.scale, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(cfg.accent, 0.9 * (1 - e));
      ctx.lineWidth = 3 * k;
      // 加一圈柔和暗晕,珊瑚环在浅色/白色网页上也看得清(否则对比度不足)
      ctx.shadowColor = `rgba(0,0,0,${0.35 * (1 - e)})`; ctx.shadowBlur = 4 * k;
      ctx.stroke();
      ctx.restore();
    }
  }

  // 路径A:补画光标(仅当录像本身没有鼠标时才需要;默认关,避免与真实光标双影)
  if (cfg.cursor && data.cursor && data.cursor.length) {
    const cur = sampleCursor(data.cursor, videoTimeMs);
    if (cur) drawCursor(ctx, toScreen(cur.x, cur.y), k * z.scale);
  }

  ctx.restore();
}

// 在轨迹里按时间插值出光标位置(0..1 归一化)
function sampleCursor(cursor, t) {
  if (t <= cursor[0].t) return cursor[0];
  if (t >= cursor[cursor.length - 1].t) return cursor[cursor.length - 1];
  let lo = 0, hi = cursor.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cursor[m].t < t) lo = m + 1; else hi = m; }
  const b = cursor[lo], a = cursor[lo - 1] || b;
  const k = (t - a.t) / ((b.t - a.t) || 1);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

// 画一个 macOS 风箭头(白填充 + 暗描边 + 柔影),与录制时注入的 CSS 光标同款
function drawCursor(ctx, p, k) {
  const sc = (22 * k) / 28;
  const pts = [[7, 4], [7, 25], [12.5, 19.5], [16, 27], [19, 25.5], [15.5, 18.5], [23, 18.5]];
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * sc, pts[0][1] * sc);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * sc, pts[i][1] * sc);
  ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4 * k; ctx.shadowOffsetY = 1.5 * k;
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.6 * k; ctx.strokeStyle = '#1c1c1e'; ctx.stroke();
  ctx.restore();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
