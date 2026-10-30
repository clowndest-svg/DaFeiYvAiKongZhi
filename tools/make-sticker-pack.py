from PIL import Image, ImageDraw, ImageFont, ImageFilter
import json
import os
import random

from pathlib import Path
ROOT = str(Path(__file__).resolve().parent.parent)
SRC = os.path.join(ROOT, "assets", "char")
OUT = os.path.join(ROOT, "assets", "stickers", "deepseek-whale")
os.makedirs(OUT, exist_ok=True)

FONT = "C:/Windows/Fonts/msyhbd.ttc"

CAPTIONS = {
    "happy": ["在呢", "好耶", "贴贴", "收到", "想你了", "嘿嘿"],
    "shy": ["哼", "才不是", "别看我", "脸红了", "晚安", "谢谢"],
    "surprised": ["欸？", "真的假的", "救命", "不会吧", "看戏", "哇"],
    "blink": ["笨蛋", "摸摸头", "别熬夜", "加油", "看我的", "溜了"],
    "normal": ["嗯嗯", "知道了", "随便", "好吧", "在忙", "等你"],
}

random.seed(20261029)


def gradient(size):
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    top = (7, 18, 37)
    bottom = (19, 70, 126)
    for y in range(h):
        t = y / (h - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = color
    return img.convert("RGBA")


def make_sticker(expr, caption, index):
    base = gradient((512, 512))

    glow = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((55, 5, 457, 407), fill=(70, 150, 255, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(38))
    base = Image.alpha_composite(base, glow)

    # 几颗很淡的星点，让底色不那么死
    decor = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    dd = ImageDraw.Draw(decor)
    for _ in range(18):
        x = random.randint(20, 492)
        y = random.randint(20, 380)
        r = random.choice([1, 1, 2])
        dd.ellipse((x - r, y - r, x + r, y + r), fill=(150, 210, 255, random.randint(25, 80)))
    base = Image.alpha_composite(base, decor)

    char = Image.open(os.path.join(SRC, f"{expr}.png")).convert("RGBA")
    w, h = char.size
    box = (int(w * 0.24), int(h * 0.05), int(w * 0.76), int(h * 0.46))
    face = char.crop(box).resize((440, 440), Image.LANCZOS)
    base.alpha_composite(face, (36, -6))

    bubble = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bubble)
    bd.rounded_rectangle((20, 402, 492, 492), radius=26, fill=(6, 16, 34, 225), outline=(95, 170, 255, 130), width=2)
    bd.rounded_rectangle((36, 414, 476, 480), radius=18, outline=(30, 70, 120, 80), width=1)
    base = Image.alpha_composite(base, bubble)

    draw = ImageDraw.Draw(base)
    font = ImageFont.truetype(FONT, 44, index=0)
    bbox = draw.textbbox((0, 0), caption, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (512 - tw) / 2
    ty = 447 - th / 2 - bbox[1]
    draw.text((tx + 1, ty + 2), caption, font=font, fill=(0, 0, 0, 120))
    draw.text((tx, ty), caption, font=font, fill=(233, 246, 255, 255))

    # 左上角一个小蓝点，像状态灯
    draw.ellipse((24, 24, 34, 34), fill=(110, 220, 255, 220))

    filename = f"{expr}-{index:02d}.jpg"
    base.convert("RGB").save(os.path.join(OUT, filename), "JPEG", quality=92, optimize=True)
    return filename


items = []
for expr, captions in CAPTIONS.items():
    for i, caption in enumerate(captions, 1):
        file = make_sticker(expr, caption, i)
        items.append({"file": file, "expression": expr, "caption": caption})

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(
        {
            "name": "DS 蓝色大肥鱼",
            "note": "Generated from the user's licensed 大肥鱼 character art; not scraped from the web.",
            "items": items,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

# 预览拼图
cols, rows = 5, 6
thumb = 200
sheet = Image.new("RGB", (cols * thumb, rows * thumb), (5, 10, 20))
for idx, item in enumerate(items):
    im = Image.open(os.path.join(OUT, item["file"])).resize((thumb, thumb), Image.LANCZOS)
    sheet.paste(im, ((idx % cols) * thumb, (idx // cols) * thumb))
sheet.save(os.path.join(ROOT, "data", "sticker-pack-preview.jpg"), quality=88)
print("generated", len(items), "stickers")
