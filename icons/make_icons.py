"""生成 HuaRec 图标:深底圆角方 + 珊瑚色录制环 + 镜头点。4x 超采样抗锯齿。"""
from PIL import Image, ImageDraw

BG = (22, 22, 26, 255)      # #16161A
ACCENT = (255, 107, 74, 255)  # #FF6B4A
WHITE = (245, 245, 247, 255)

def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)

def make(size):
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 圆角底
    rounded(d, [0, 0, s - 1, s - 1], int(s * 0.22), BG)
    cx, cy = s / 2, s / 2
    # 录制环(珊瑚)
    ring_r = s * 0.30
    ring_w = max(2, int(s * 0.07))
    d.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
              outline=ACCENT, width=ring_w)
    # 中心镜头点
    dot_r = s * 0.13
    d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)

for sz in (16, 32, 48, 128):
    make(sz).save(f"icon{sz}.png")
print("icons generated")
