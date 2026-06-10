// 导出引擎:WebCodecs 离线编码(比实时快很多)。支持 MP4 / WebM / GIF。
// 音频统一用 Opus(mp4/webm 都支持),WebCodecs 不可用时回退 MediaRecorder 实时录制。
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from '../lib/vendor/mp4-muxer.mjs';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from '../lib/vendor/webm-muxer.mjs';
import { GIFEncoder, quantize, applyPalette } from '../lib/vendor/gifenc.mjs';

const hasWebCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

async function pickVideoCodec(format, width, height, fps) {
  const candidates = format === 'mp4'
    ? [{ codec: 'avc1.640028', muxer: 'avc' }, { codec: 'avc1.42E01E', muxer: 'avc' }]
    : [{ codec: 'vp09.00.10.08', muxer: 'V_VP9' }, { codec: 'vp8', muxer: 'V_VP8' }];
  for (const c of candidates) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, framerate: fps });
      if (s && s.supported) return c;
    } catch (_) {}
  }
  return null;
}

// 主导出。opts: { canvas, drawAt(masterMs)->Promise, durationMs, fps, format, audio, onProgress }
export async function exportMedia(opts) {
  if (opts.format === 'gif') return exportGif(opts);
  if (hasWebCodecs) {
    try { return await exportWebCodecs(opts); }
    catch (e) { console.warn('WebCodecs 导出失败,回退实时录制:', e.message); }
  }
  return exportRealtime(opts);
}

async function exportWebCodecs({ canvas, drawAt, durationMs, fps, format, audio, onProgress }) {
  const width = canvas.width, height = canvas.height;
  const vc = await pickVideoCodec(format, width, height, fps);
  if (!vc) throw new Error('无可用视频编码器');

  const target = format === 'mp4' ? new Mp4Target() : new WebmTarget();
  const muxerOpts = {
    target,
    video: { codec: vc.muxer, width, height, frameRate: fps },
    firstTimestampBehavior: 'offset',
  };
  if (audio) muxerOpts.audio = { codec: format === 'mp4' ? 'opus' : 'A_OPUS', numberOfChannels: audio.channels.length, sampleRate: audio.sampleRate };
  if (format === 'mp4') muxerOpts.fastStart = 'in-memory';
  const muxer = format === 'mp4' ? new Mp4Muxer(muxerOpts) : new WebmMuxer(muxerOpts);

  // 视频编码
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('venc', e),
  });
  // 与录制端上限(offscreen.js 24M)对齐,避免高分辨率源在导出端被多压一档
  const bitrate = Math.min(24_000_000, Math.round(width * height * fps * 0.12));
  venc.configure({ codec: vc.codec, width, height, framerate: fps, bitrate, latencyMode: 'quality' });

  const total = Math.max(1, Math.round((durationMs / 1000) * fps));
  const frameDurUs = 1e6 / fps;
  for (let i = 0; i < total; i++) {
    await drawAt((i / fps) * 1000);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameDurUs), duration: Math.round(frameDurUs) });
    venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    if (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    if (onProgress && i % 5 === 0) onProgress(i / total * (audio ? 0.85 : 1));
  }
  await venc.flush();
  venc.close();

  // 音频编码(Opus)
  if (audio) {
    await encodeAudio(audio, format, muxer, onProgress);
  }

  muxer.finalize();
  if (onProgress) onProgress(1);
  const mime = format === 'mp4' ? 'video/mp4' : 'video/webm';
  return new Blob([target.buffer], { type: mime });
}

async function encodeAudio(audio, format, muxer, onProgress) {
  const { channels, sampleRate } = audio;
  const numCh = channels.length;
  const aenc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error('aenc', e),
  });
  aenc.configure({ codec: 'opus', sampleRate, numberOfChannels: numCh, bitrate: 128000 });

  const totalSamples = channels[0].length;
  const chunkSamples = 48000; // 1s 块
  // 交错成 f32-planar(AudioData planar 需要按通道连续排列)
  for (let off = 0; off < totalSamples; off += chunkSamples) {
    const n = Math.min(chunkSamples, totalSamples - off);
    const planar = new Float32Array(n * numCh);
    for (let ch = 0; ch < numCh; ch++) planar.set(channels[ch].subarray(off, off + n), ch * n);
    const data = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: numCh,
      timestamp: Math.round((off / sampleRate) * 1e6), data: planar,
    });
    aenc.encode(data);
    data.close();
    if (aenc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    // 音频占进度条尾段 0.85→0.99,避免视频编完后卡在 85% 不动。
    if (onProgress) onProgress(0.85 + 0.14 * Math.min(1, (off + n) / totalSamples));
  }
  await aenc.flush();
  aenc.close();
}

// GIF 导出:面向网页录制内容优化。
// 网页内容 = 大面积纯色 UI + 大量小字,清晰度几乎全靠【分辨率】(720px 会让文字糊成一团)。
// 体积主要由 帧数(fps) × 分辨率 × 画面复杂度 决定。策略:
//   ① 分辨率拉高到能看清文字,但按时长自适应回收(长片单帧预算更紧),守住 ~10MB/20s;
//   ② 帧率 12(网页演示的运动足够顺,比 14 省 ~15% 体积,换更高分辨率);
//   ③ 全局共享调色板:先采样若干帧算一套 256 色,所有帧复用 → 消除帧间色彩闪烁,
//      且相同色映射成相同 index,LZW 压得更狠(体积更小)。逐帧独立量化才是闪烁+变大的元凶。
async function exportGif({ canvas, drawAt, durationMs, fps: optFps, maxW: optMaxW, onProgress }) {
  const fps = optFps || 12;
  const seconds = Math.max(1, durationMs / 1000);
  // 用户显式选了导出尺寸(1080p/720p)→ optMaxW 优先,尊重其选择;
  // 选「原尺寸」时才用按时长自适应的上限(短片优先清晰,长片优先体积)。
  const maxW = optMaxW || (seconds > 20 ? 880 : seconds > 10 ? 1000 : 1120);
  const scale = Math.min(1, maxW / canvas.width); // 绝不放大
  const w = Math.round(canvas.width * scale / 2) * 2;
  const h = Math.round(canvas.height * scale / 2) * 2;
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
  const enc = GIFEncoder();
  const total = Math.max(1, Math.round((durationMs / 1000) * fps));
  const delay = Math.round(1000 / fps);

  // 第一遍:在全片均匀采样若干帧,合并像素算一套全局调色板。
  const nSample = Math.min(total, 16);
  const grab = async (i) => { await drawAt((i / fps) * 1000); tctx.drawImage(canvas, 0, 0, w, h); return tctx.getImageData(0, 0, w, h).data; };
  const samples = [];
  for (let s = 0; s < nSample; s++) { samples.push(await grab(Math.floor((s + 0.5) / nSample * total))); if (onProgress) onProgress((s / nSample) * 0.25); }
  const merged = new Uint8ClampedArray(samples.reduce((n, a) => n + a.length, 0));
  let mo = 0; for (const a of samples) { merged.set(a, mo); mo += a.length; }
  // 量化到 255 色,留下 index 255 作专用透明位(差分帧用);补满 256 保证可寻址。
  const palette = quantize(merged, 255);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const TI = 255;

  // 第二遍:全局调色板 + 帧间差分。与上一帧颜色【索引完全相同】的像素写成透明,
  // 露出上一帧 → 大面积静止的网页 GIF 只需存变化区域,LZW 之外再省 30-50% 体积。透明判定基于
  // 量化后的 index,所以露出的就是同色,绝不产生残影/错位。
  let prevIndex = null;
  for (let i = 0; i < total; i++) {
    const data = await grab(i);
    const idx = applyPalette(data, palette); // 0..254
    if (i === 0) {
      enc.writeFrame(idx, w, h, { palette, delay, dispose: 1 });
      prevIndex = idx;
    } else {
      const real = idx.slice();
      for (let p = 0; p < idx.length; p++) if (idx[p] === prevIndex[p]) idx[p] = TI;
      enc.writeFrame(idx, w, h, { palette, delay, transparent: true, transparentIndex: TI, dispose: 1 });
      prevIndex = real;
    }
    if (onProgress) onProgress(0.25 + (i / total) * 0.75);
  }
  enc.finish();
  if (onProgress) onProgress(1);
  return new Blob([enc.bytes()], { type: 'image/gif' });
}

// 兜底:MediaRecorder 实时录制(WebCodecs 不可用时)
async function exportRealtime({ canvas, drawAt, durationMs, fps, format, audio, onProgress }) {
  const mimes = format === 'mp4'
    ? ['video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm'];
  const mime = mimes.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const stream = canvas.captureStream(fps);
  // 把音频接入流,否则回退路径会丢声音(WebCodecs 不可用时静默无声是严重 bug)
  let ac = null, audioNode = null;
  if (audio && audio.channels && audio.channels.length) {
    try {
      ac = new AudioContext({ sampleRate: audio.sampleRate });
      const ab = ac.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate);
      audio.channels.forEach((ch, i) => ab.copyToChannel(ch, i));
      const dest = ac.createMediaStreamDestination();
      audioNode = ac.createBufferSource(); audioNode.buffer = ab; audioNode.connect(dest); // 推迟到 rec.start() 再播,避免头部错位
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (e) { console.warn('回退录制音频接入失败,将无声:', e.message); }
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const buf = [];
  rec.ondataavailable = (e) => { if (e.data.size) buf.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start();
  if (audioNode) audioNode.start(); // 与录制起点对齐,音视频不偏移
  const start = performance.now();
  // 按真实时间推进绘制
  let elapsed = 0;
  while ((elapsed = performance.now() - start) < durationMs) {
    await drawAt(elapsed);
    if (onProgress) onProgress(Math.min(0.99, elapsed / durationMs));
    await new Promise((r) => requestAnimationFrame(r));
  }
  rec.stop();
  await done;
  if (ac) ac.close().catch(() => {});
  stream.getTracks().forEach((t) => t.stop());
  if (onProgress) onProgress(1);
  return new Blob(buf, { type: mime.split(';')[0] });
}
