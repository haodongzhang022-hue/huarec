// 共享预设:背景壁纸 + 默认皮肤。editor 共用。
// 这是 ES module,被 editor 以 import 方式引用。

export const ACCENT = '#FF6B4A'; // HuaRec 品牌强调色(暖珊瑚)

// 背景壁纸:垫在录制视频圆角卡片后面的画布底。
// 设计取向(学 macOS 桌面壁纸:Big Sur / Monterey / Sonoma):
//   ① 一条【多停靠点对角线性渐变】作底 —— 跨画面的平滑色彩旅程(深→中→暖),这是壁纸的灵魂;
//   ② 叠 1~2 个【大而柔的径向光斑】—— 制造明确光源与纵深,不再是平涂的闷色块。
// type=aurora: { grad:{ angle, stops:[[pos,color],...] }, blobs:[{cx,cy,r,color,alpha}] }
//   stops 的 pos / blobs 的 cx,cy,r 均为 0..1 比例。light:true 表示浅色底(影响暗角与卡片文字色)。
// type=none: 透明铺满(原片直出)。
export const BACKGROUNDS = [
  { id: 'none', name: '铺满', type: 'none' },

  // —— 深色:macOS 风格的色彩旅程 + 明确光源 ——
  // 午夜蓝(Big Sur 夜):深海军蓝 → 钢蓝,右下暖色破晓微光
  { id: 'midnight', name: '午夜', type: 'aurora', grad: { angle: 145, stops: [[0, '#0e1733'], [0.55, '#1d2c5c'], [1, '#33406f']] }, blobs: [
    { cx: 0.16, cy: 0.12, r: 0.7, color: '#5878d8', alpha: 0.20 },
    { cx: 0.82, cy: 0.9, r: 0.75, color: '#ff9e6d', alpha: 0.10 },
  ] },
  // 暮光(Sonoma 黄昏):墨紫 → 品红 → 珊瑚,顶部暖光
  { id: 'dusk', name: '暮光', type: 'aurora', grad: { angle: 155, stops: [[0, '#241640'], [0.5, '#5e2a5e'], [1, '#b8584a']] }, blobs: [
    { cx: 0.8, cy: 0.18, r: 0.72, color: '#ffb27d', alpha: 0.20 },
    { cx: 0.12, cy: 0.88, r: 0.65, color: '#3a1f5c', alpha: 0.40 },
  ] },
  // 礁湖(Monterey 青):深青 → 湖绿 → 蓝绿,右下高光
  { id: 'lagoon', name: '礁湖', type: 'aurora', grad: { angle: 150, stops: [[0, '#0c2a3a'], [0.5, '#114f4e'], [1, '#1f7d7a']] }, blobs: [
    { cx: 0.85, cy: 0.82, r: 0.68, color: '#5fe6cf', alpha: 0.16 },
    { cx: 0.14, cy: 0.16, r: 0.6, color: '#1d6fa0', alpha: 0.22 },
  ] },
  // 余烬(暖夜):深褐红 → 锈橙,右上暖光
  { id: 'ember', name: '余烬', type: 'aurora', grad: { angle: 150, stops: [[0, '#241015'], [0.5, '#5c2622'], [1, '#9e4a2e']] }, blobs: [
    { cx: 0.82, cy: 0.2, r: 0.7, color: '#ffb673', alpha: 0.18 },
    { cx: 0.14, cy: 0.88, r: 0.6, color: '#2a1212', alpha: 0.4 },
  ] },

  // —— 浅色:近白的微妙渐变,让前景卡片浮起来 ——
  // 瓷(暖白):左上桃色微光 → 右下冷白
  { id: 'porcelain', name: '瓷', type: 'aurora', light: true, grad: { angle: 145, stops: [[0, '#fdfbf8'], [0.6, '#f4ece4'], [1, '#ebddd2']] }, blobs: [
    { cx: 0.18, cy: 0.15, r: 0.75, color: '#ffd9bf', alpha: 0.5 },
    { cx: 0.85, cy: 0.9, r: 0.62, color: '#dfe6f0', alpha: 0.45 },
  ] },
  // 雾(冷白):右上蓝色微光
  { id: 'mist', name: '雾', type: 'aurora', light: true, grad: { angle: 150, stops: [[0, '#fcfdff'], [0.6, '#eef3fa'], [1, '#e0e9f5']] }, blobs: [
    { cx: 0.85, cy: 0.15, r: 0.7, color: '#d4e2f7', alpha: 0.6 },
    { cx: 0.15, cy: 0.9, r: 0.6, color: '#eef1f6', alpha: 0.5 },
  ] },
  // 亚麻(暖砂):底部砂色微光
  { id: 'linen', name: '亚麻', type: 'aurora', light: true, grad: { angle: 145, stops: [[0, '#fbf7ee'], [0.55, '#f1e7d5'], [1, '#e8dcc6']] }, blobs: [
    { cx: 0.2, cy: 0.85, r: 0.65, color: '#f3e3c4', alpha: 0.5 },
    { cx: 0.82, cy: 0.16, r: 0.6, color: '#fdf6ea', alpha: 0.55 },
  ] },

  // —— 浅彩色:莫兰迪柔调,既好看又不浮夸(给小红书/教程封面用)——
  // 蜜桃(暖橙粉):奶白 → 蜜桃,右上桃色高光
  { id: 'blush', name: '蜜桃', type: 'aurora', light: true, grad: { angle: 150, stops: [[0, '#fde9e0'], [0.5, '#f6cbb8'], [1, '#eba98f']] }, blobs: [
    { cx: 0.82, cy: 0.18, r: 0.7, color: '#ffd6c0', alpha: 0.55 },
    { cx: 0.15, cy: 0.9, r: 0.6, color: '#f6d8cb', alpha: 0.5 },
  ] },
  // 薄荷(柔绿):浅白绿 → 鼠尾草,左下绿光
  { id: 'sage', name: '薄荷', type: 'aurora', light: true, grad: { angle: 150, stops: [[0, '#eaf1e6'], [0.5, '#cfe0c5'], [1, '#aecaa1']] }, blobs: [
    { cx: 0.2, cy: 0.85, r: 0.68, color: '#dcebd2', alpha: 0.55 },
    { cx: 0.85, cy: 0.16, r: 0.6, color: '#eef4e9', alpha: 0.5 },
  ] },
  // 丁香(柔紫):浅白紫 → 薰衣草,右上紫光
  { id: 'lilac', name: '丁香', type: 'aurora', light: true, grad: { angle: 150, stops: [[0, '#efeaf6'], [0.5, '#dcd2ec'], [1, '#c2b3e0']] }, blobs: [
    { cx: 0.82, cy: 0.18, r: 0.7, color: '#e4d9f3', alpha: 0.55 },
    { cx: 0.16, cy: 0.88, r: 0.6, color: '#efe9f7', alpha: 0.5 },
  ] },
];

// 默认皮肤:一键套用的整套配置(无 UI 选择器,editor 里每项仍可单独微调)。
// padding: 背景留白占比; radius: 视频圆角 px; shadow: 阴影强度 0~1
export const SKINS = [
  {
    id: 'huashu',
    name: '默认',
    background: 'midnight',
    padding: 0.07,
    radius: 20,
    shadow: 0.5,
    accent: ACCENT,
    clickFx: true,
    autoZoom: true,
  },
  {
    id: 'raw',
    name: '原始(不加工)',
    background: 'none',
    padding: 0,
    radius: 0,
    shadow: 0,
    accent: ACCENT,
    clickFx: false,
    autoZoom: false,
  },
];

export function getSkin(id) {
  return SKINS.find((s) => s.id === id) || SKINS[0];
}

export function getBackground(id) {
  return BACKGROUNDS.find((b) => b.id === id) || BACKGROUNDS[0];
}
