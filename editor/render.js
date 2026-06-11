// 渲染引擎:预览与导出共用。纯函数式,绘制单帧到 canvas。
// 坐标约定:光标/点击均为 0..1 归一化(相对录制时的视口)。
import { FilesetResolver, ImageSegmenter } from '../lib/vendor/mediapipe/vision_bundle.mjs';

// ---- 人像分割(背景虚化用):MediaPipe 自拍分割,模型打包在扩展里,本地运行不联网 ----
let segmenter = null, segLoading = null, segTs = 0;
export function initSegmenter() {
  if (segLoading) return segLoading;
  segLoading = (async () => {
    try {
      const base = chrome.runtime.getURL('lib/vendor/mediapipe');
      const fileset = await FilesetResolver.forVisionTasks(base);
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + '/selfie_segmenter.tflite', delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
      });
    } catch (e) {
      console.warn('人像分割初始化失败,背景虚化不可用:', e.message);
      segmenter = null;
    }
  })();
  return segLoading;
}
export function segmenterReady() { return !!segmenter; }

// 背景虚化:人像(置信度蒙版)保留清晰,背景整体高斯模糊。
// 在气泡分辨率的离屏画布上做,代价随气泡尺寸走,预览和导出都扛得住。
const maskCanvas = document.createElement('canvas');
const personCanvas = document.createElement('canvas');
function applyBgBlur(src, sctx, tw, th) {
  segTs = Math.max(segTs + 1, performance.now()); // segmentForVideo 要求时间戳单调递增
  const res = segmenter.segmentForVideo(src, segTs);
  const mask = res.confidenceMasks && res.confidenceMasks[0];
  if (!mask) return;
  try {
    const mw = mask.width, mh = mask.height;
    const arr = mask.getAsFloat32Array();
    maskCanvas.width = mw; maskCanvas.height = mh;
    const mctx = maskCanvas.getContext('2d');
    const img = mctx.createImageData(mw, mh);
    for (let i = 0; i < arr.length; i++) img.data[i * 4 + 3] = arr[i] * 255;
    mctx.putImageData(img, 0, 0);
    // 人像 = 原画 ∩ 蒙版
    personCanvas.width = tw; personCanvas.height = th;
    const pctx = personCanvas.getContext('2d');
    pctx.drawImage(src, 0, 0);
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(maskCanvas, 0, 0, tw, th);
    pctx.globalCompositeOperation = 'source-over';
    // 背景整体模糊,再把清晰人像贴回
    sctx.save();
    sctx.filter = `blur(${Math.max(6, tw / 24).toFixed(1)}px)`;
    sctx.drawImage(src, 0, 0);
    sctx.restore();
    sctx.drawImage(personCanvas, 0, 0);
  } finally {
    mask.close();
  }
}

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

// 在时间 t(ms)求运镜状态:{scale, fx, fy}。seg.level 可覆盖全局倍数(手动逐段调)
export function zoomAt(segs, t, zoomLevel, ramp = 500) {
  if (!segs.length) return { scale: 1, fx: 0.5, fy: 0.5 };
  const seg = segs.find((s) => t >= s.start && t <= s.end);
  if (!seg) return { scale: 1, fx: 0.5, fy: 0.5 };
  const lvl = seg.level || zoomLevel;
  if (lvl <= 1.001) return { scale: 1, fx: 0.5, fy: 0.5 };
  // 动态推拉时长:短段不能全程在过渡中,至少留一段稳定的放大态(否则像没推到位就缩回)
  const r = Math.min(ramp, (seg.end - seg.start) * 0.35);
  let e = 1;
  if (t < seg.start + r) e = smoothstep((t - seg.start) / r);
  else if (t > seg.end - r) e = smoothstep((seg.end - t) / r);
  const scale = 1 + (lvl - 1) * e;
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

// ---- 壁纸图片缓存与预加载 ----
// 壁纸是打包在扩展里的真图片(assets/wallpapers/)。绘帧是同步的,图片解码是异步的:
// 没就绪时先铺 fallback 主色(本地文件通常一两帧就绪);导出前必须 await preloadBackground。
const bgImgCache = {};
export function preloadBackground(bg) {
  if (!bg || bg.type !== 'image') return Promise.resolve();
  let c = bgImgCache[bg.id];
  if (c) return c.promise;
  const img = new Image();
  c = { img, ready: false };
  c.promise = new Promise((res) => {
    img.onload = () => { c.ready = true; res(); };
    img.onerror = () => res(); // 加载失败保持 fallback 色,不阻塞
  });
  img.src = chrome.runtime.getURL(bg.file);
  bgImgCache[bg.id] = c;
  return c.promise;
}

function paintBackground(ctx, bg, W, H) {
  if (!bg || bg.type === 'none') { ctx.clearRect(0, 0, W, H); return; }
  if (bg.type === 'image') {
    const c = bgImgCache[bg.id];
    if (!c) preloadBackground(bg);
    if (c && c.ready) {
      // cover 裁切铺满:壁纸已是完成品,不叠暗角不做二次处理
      const iw = c.img.naturalWidth, ih = c.img.naturalHeight;
      const s = Math.max(W / iw, H / ih);
      const dw = iw * s, dh = ih * s;
      ctx.drawImage(c.img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = bg.fallback || '#1c1c1e';
      ctx.fillRect(0, 0, W, H);
    }
    return;
  }
  // solid 兜底(当前预设未使用,保留通用性)
  ctx.fillStyle = bg.value || '#1c1c1e';
  ctx.fillRect(0, 0, W, H);
}

// 主绘制:画一帧网页内容(含运镜/光标/点击/水印)
// videoTimeMs:相对录制起点的时间,用于查轨迹
export function drawScene(ctx, video, videoTimeMs, cfg, data, W, H) {
  const k = W / 1280;
  paintBackground(ctx, cfg.background, W, H);

  // 视频卡片矩形(留白内缩)。
  // 画布与视频同比例时:左右留白用 W 的比例、上下用 H 的比例,分轴计算,卡片 aspect == 视频 aspect。
  // 画布比例不同(竖屏 9:16 / 方形导出):卡片按视频宽高比 contain 居中,多出的方向交给壁纸。
  const padX = cfg.padding * W, padY = cfg.padding * H;
  const availW = W - padX * 2, availH = H - padY * 2;
  const VA = (video.videoWidth || W) / (video.videoHeight || H);
  let rx, ry, rw, rh;
  if (Math.abs(availW / availH - VA) < 0.005) {
    rx = padX; ry = padY; rw = availW; rh = availH;
  } else if (availW / availH > VA) {
    rh = availH; rw = rh * VA; rx = (W - rw) / 2; ry = padY;
  } else {
    rw = availW; rh = rw / VA; rx = padX; ry = (H - rh) / 2;
  }
  const radius = (cfg.padding > 0 || rw < W - 1 || rh < H - 1 ? cfg.radius : 0) * k;

  // 阴影(留白>0 或竖屏构图下卡片未铺满时生效)
  if (cfg.shadow > 0 && (cfg.padding > 0 || rw < W - 1 || rh < H - 1)) {
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

  // 路径A:补画光标(录像里没有真实光标时用;「平滑光标」录制默认开)。
  // 平滑 = 在 ±cursorSmooth 毫秒窗口内多点采样取均值,对称窗口不引入拖尾延迟;
  // 点击瞬间光标轻微下压(squish),手感接近 Screen Studio。
  if (cfg.cursor && data.cursor && data.cursor.length) {
    const cur = sampleCursorSmoothed(data.cursor, videoTimeMs, cfg.cursorSmooth || 0);
    if (cur) {
      let squish = 1;
      if (data.clicks) {
        for (const c of data.clicks) {
          const age = videoTimeMs - c.t;
          if (age >= 0 && age < 180) { squish = 1 - 0.16 * Math.sin(Math.PI * age / 180); break; }
        }
      }
      drawCursor(ctx, toScreen(cur.x, cur.y), k * z.scale * (cfg.cursorSize || 1) * squish);
    }
  }

  // 按键浮层:最近按下的快捷键画成 macOS 风按键牌,卡片底部居中,1.1s 后淡出
  if (cfg.keyFx && data.keys && data.keys.length) {
    const act = [];
    for (const kk of data.keys) {
      const age = videoTimeMs - kk.t;
      if (age >= 0 && age < 1400) act.push({ label: kk.label, age });
    }
    if (act.length) drawKeyPills(ctx, act.slice(-3), rx, ry, rw, rh, k);
  }

  ctx.restore();
}

function drawKeyPills(ctx, pills, rx, ry, rw, rh, k) {
  const fs = 21 * k, padX = 15 * k, gap = 9 * k, h = 38 * k, r = 9 * k;
  ctx.save();
  ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;
  ctx.textBaseline = 'middle';
  const widths = pills.map((p) => ctx.measureText(p.label).width + padX * 2);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (pills.length - 1);
  let x = rx + rw / 2 - total / 2;
  const y = ry + rh - 64 * k;
  pills.forEach((p, i) => {
    const a = p.age < 1100 ? 1 : 1 - (p.age - 1100) / 300;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = 'rgba(24,24,27,0.82)';
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 10 * k; ctx.shadowOffsetY = 3 * k;
    roundRect(ctx, x, y, widths[i], h, r); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1 * k;
    roundRect(ctx, x, y, widths[i], h, r); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(p.label, x + padX, y + h / 2 + 1 * k);
    x += widths[i] + gap;
  });
  ctx.restore();
}

// 平滑采样:窗口为 0 时退化为普通插值
function sampleCursorSmoothed(cursor, t, w) {
  if (!w) return sampleCursor(cursor, t);
  let x = 0, y = 0, n = 0;
  for (let i = -2; i <= 2; i++) {
    const p = sampleCursor(cursor, t + (i * w) / 2);
    if (p) { x += p.x; y += p.y; n++; }
  }
  return n ? { x: x / n, y: y / n } : null;
}

// ---- 摄像头气泡:独立于屏幕轨的浮层,预览与导出共用 ----
// cam: { show, x, y, size, shape:'circle'|'square'|'rect', beauty:0..1, mirror, ring }
// x/y 是气泡中心(0..1,相对整个画布);size 是相对 min(W,H) 的占比。

// 气泡的画布像素矩形(编辑器拖拽命中测试也用它)
export function cameraRect(cam, camVideo, W, H) {
  const d = cam.size * Math.min(W, H);
  let w = d, h = d;
  if (cam.shape === 'rect') {
    // 卡片样式按视频本身宽高比,面积与同 size 的圆形近似(√ar 配平)
    const ar = camVideo && camVideo.videoWidth ? camVideo.videoWidth / camVideo.videoHeight : 4 / 3;
    w = d * Math.sqrt(ar); h = d / Math.sqrt(ar);
  }
  return { x: cam.x * W - w / 2, y: cam.y * H - h / 2, w, h };
}

function camShapePath(ctx, r, shape) {
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
  } else {
    roundRect(ctx, r.x, r.y, r.w, r.h, shape === 'square' ? r.w * 0.22 : Math.min(r.w, r.h) * 0.12);
  }
}

// 美颜 = 边缘保护磨皮(surface blur 近似)。纯高斯模糊会把五官一起糊掉(翻车过),
// 正确做法:按「原图 vs 模糊图的亮度差」逐像素加权 —— 差小 = 皮肤纹理/噪点 → 用模糊抹平;
// 差大 = 眼睛/轮廓/发丝等边缘 → 保留原图。最后按强度轻微提亮提饱和(气色),结构不动。
const beautyCanvas = document.createElement('canvas');
function applyBeauty(tctx, tw, th, strength) {
  beautyCanvas.width = tw; beautyCanvas.height = th;
  const bctx = beautyCanvas.getContext('2d', { willReadFrequently: true });
  bctx.filter = `blur(${Math.max(2, tw / 80).toFixed(1)}px)`;
  bctx.drawImage(camCanvas, 0, 0);
  bctx.filter = 'none';
  const orig = tctx.getImageData(0, 0, tw, th);
  const blur = bctx.getImageData(0, 0, tw, th);
  const o = orig.data, b = blur.data;
  const T1 = 6, T2 = 26; // 亮度差阈值:<T1 全用模糊,>T2 全保原图,中间线性过渡
  for (let i = 0; i < o.length; i += 4) {
    const dl = Math.abs(
      (o[i] * 0.299 + o[i + 1] * 0.587 + o[i + 2] * 0.114) -
      (b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114)
    );
    let w = (dl - T1) / (T2 - T1);
    w = w < 0 ? 0 : w > 1 ? 1 : w;
    const m = (1 - w) * strength; // 混入模糊的比例
    o[i] += (b[i] - o[i]) * m;
    o[i + 1] += (b[i + 1] - o[i + 1]) * m;
    o[i + 2] += (b[i + 2] - o[i + 2]) * m;
  }
  tctx.putImageData(orig, 0, 0);
  tctx.save();
  tctx.filter = `brightness(${(1 + 0.05 * strength).toFixed(3)}) saturate(${(1 + 0.04 * strength).toFixed(3)})`;
  tctx.drawImage(camCanvas, 0, 0);
  tctx.restore();
}

const camCanvas = document.createElement('canvas');
export function drawCamera(ctx, camVideo, cam, W, H) {
  if (!cam || !cam.show || !camVideo || camVideo.readyState < 2) return;
  const r = cameraRect(cam, camVideo, W, H);
  const k = W / 1280;
  // 离屏画一份裁好的画面(cover 裁切 + 镜像 + 美颜),再整体贴回主画布
  const tw = Math.max(2, Math.round(r.w)), th = Math.max(2, Math.round(r.h));
  camCanvas.width = tw; camCanvas.height = th;
  const tctx = camCanvas.getContext('2d', { willReadFrequently: true });
  const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  const s = Math.max(tw / vw, th / vh);
  tctx.save();
  if (cam.mirror) { tctx.translate(tw, 0); tctx.scale(-1, 1); }
  tctx.drawImage(camVideo, (tw - vw * s) / 2, (th - vh * s) / 2, vw * s, vh * s);
  tctx.restore();
  // 背景虚化:人像分割就绪才生效,没就绪/失败就画原图(优雅降级)
  if (cam.blurBg && segmenter) {
    try { applyBgBlur(camCanvas, tctx, tw, th); } catch (e) { /* 单帧失败不打断渲染 */ }
  }
  // 美颜 = 边缘保护磨皮(surface blur):只抹平皮肤纹理,眼睛/轮廓/发丝保持锐利
  if (cam.beauty > 0) {
    try { applyBeauty(tctx, tw, th, cam.beauty); } catch (e) { /* 单帧失败不打断渲染 */ }
  }
  // 投影
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 30 * k;
  ctx.shadowOffsetY = 10 * k;
  ctx.fillStyle = '#000';
  camShapePath(ctx, r, cam.shape); ctx.fill();
  ctx.restore();
  // 形状裁剪贴图
  ctx.save();
  camShapePath(ctx, r, cam.shape); ctx.clip();
  ctx.drawImage(camCanvas, r.x, r.y, r.w, r.h);
  ctx.restore();
  // 白色描边
  if (cam.ring) {
    ctx.save();
    camShapePath(ctx, r, cam.shape);
    ctx.lineWidth = 2.5 * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.restore();
  }
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
