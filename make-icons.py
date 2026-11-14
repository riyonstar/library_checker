# アイコン生成 (Pillow)。  使い方: python3 make-icons.py
from PIL import Image, ImageDraw
def draw(size, maskable=False):
    S = size
    im = Image.new('RGBA', (S, S), (59, 37, 23, 255))
    d = ImageDraw.Draw(im)
    pad = int(S * (0.20 if maskable else 0.10))
    # 木目の背景
    for x in range(0, S, max(6, S // 28)):
        d.line([(x, 0), (x, S)], fill=(70, 44, 28, 255), width=max(1, S // 160))
    if not maskable:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.2), outline=(201, 162, 75, 255), width=max(2, S // 64))
    # 棚板
    shelf_y = int(S * 0.74)
    d.rectangle([pad, shelf_y, S - pad, shelf_y + int(S * 0.06)], fill=(132, 89, 58, 255))
    # 本(背表紙)
    cols = [(122, 46, 46), (47, 90, 69), (201, 162, 75), (53, 80, 122), (155, 61, 82), (138, 106, 28)]
    heights = [0.40, 0.50, 0.34, 0.46, 0.38, 0.44]
    n = len(cols)
    inner = S - 2 * pad
    w = inner // (n + 1)
    x = pad + w // 2
    for c, h in zip(cols, heights):
        hh = int(S * h)
        d.rectangle([x, shelf_y - hh, x + w - 3, shelf_y], fill=c + (255,))
        d.rectangle([x, shelf_y - hh + int(S*0.05), x + w - 3, shelf_y - hh + int(S*0.065)], fill=(255, 223, 140, 255))
        x += w
    # ハート
    cx, cy, r = int(S * 0.5), int(S * 0.27), int(S * 0.075)
    d.ellipse([cx - 2 * r, cy - r, cx, cy + r], fill=(214, 40, 95, 255))
    d.ellipse([cx, cy - r, cx + 2 * r, cy + r], fill=(214, 40, 95, 255))
    d.polygon([(cx - 2 * r + 2, cy + int(r * 0.35)), (cx + 2 * r - 2, cy + int(r * 0.35)), (cx, cy + int(r * 2.5))], fill=(214, 40, 95, 255))
    return im
draw(512).save('icon-512.png')
draw(192).save('icon-192.png')
draw(180).convert('RGB').save('apple-touch-icon.png')   # iOSは透過不可
draw(512, maskable=True).save('icon-maskable-512.png')
print('icons ok')
