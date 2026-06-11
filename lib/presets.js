// 共享预设:背景壁纸 + 默认皮肤。editor 共用。
// 这是 ES module,被 editor 以 import 方式引用。

export const ACCENT = '#FF6B4A'; // HuaRec 品牌强调色(暖珊瑚)

// 背景壁纸:垫在录制视频圆角卡片后面的画布底。
// v0.5 起改用 GPT-image 生成的【真壁纸图片】(assets/wallpapers/),不再用程序化渐变——
// 代码画的渐变怎么调都有平涂感,真壁纸的细腻色彩过渡和光感是程序化画不出来的。
// type=image: { file: 扩展内路径, fallback: 图片解码完成前先铺的近似主色, light: 浅色底 }
// type=none: 透明铺满(原片直出)。
export const BACKGROUNDS = [
  { id: 'none', name: '铺满', type: 'none' },

  // —— 深色 ——
  { id: 'midnight', name: '午夜', type: 'image', file: 'assets/wallpapers/midnight.jpg', fallback: '#16244e' },
  { id: 'dusk', name: '暮光', type: 'image', file: 'assets/wallpapers/dusk.jpg', fallback: '#4a2456' },
  { id: 'lagoon', name: '礁湖', type: 'image', file: 'assets/wallpapers/lagoon.jpg', fallback: '#0d3d40' },
  { id: 'ember', name: '余烬', type: 'image', file: 'assets/wallpapers/ember.jpg', fallback: '#46201a' },

  // —— 浅色 ——
  { id: 'porcelain', name: '瓷', type: 'image', light: true, file: 'assets/wallpapers/porcelain.jpg', fallback: '#f6efe6' },
  { id: 'mist', name: '雾', type: 'image', light: true, file: 'assets/wallpapers/mist.jpg', fallback: '#eef3fa' },
  { id: 'blush', name: '蜜桃', type: 'image', light: true, file: 'assets/wallpapers/blush.jpg', fallback: '#f8d9c9' },
  { id: 'sage', name: '薄荷', type: 'image', light: true, file: 'assets/wallpapers/sage.jpg', fallback: '#dde8d4' },
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
