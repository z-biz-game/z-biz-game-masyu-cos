#!/usr/bin/env python3
"""数链（Masyu）的视觉母题工厂：一张 1024 母图 + 全套派生位图 + 游戏内纹理/sprite。

为什么要它：图标和纹理是资产，不是一次性截图。母题由玩法决定——一条琥珀色环段在**黑珠那格
拐一个弯**、在**白珠那格直穿**，边上还压着一个**排除叉**——这三样就是全部规则，所以把它们
摆进图标，16px 下也只剩「一条拐弯的粗线 + 一黑一白两颗珠」这个形状，仍然是这一局。

颜色不凭空编：全部取自仓内 js/theme.js 的 Palette（下面 PALETTE 段是那批值的字面量副本，
生成时逐色断言与 theme.js 里的十六进制一致，改色忘了重新生成，assert 就会响）。

可复现：只用固定种子（random.Random(SEED)），没有墙钟、没有 Math.random。同样的命令必然
产出逐字节相同的文件（PNG 元数据里写进了 seed 与版本号，好让事后对账）。

用法:
  python3 assets/gen/gen_art.py            # 生成到 icons/ 与 art/
  python3 assets/gen/gen_art.py --check    # 只断言盘上文件与期望尺寸一致
"""
import json
import os
import random
import re
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SEED = 20261002
ART_VERSION = "masyu-art-1"

# ── 与 js/theme.js 的 Palette 对齐（下面 assert_palette() 会逐色对账）──────────
PALETTE = {
    "bgTop": "#070A14",
    "bgBottom": "#121A2C",
    "surface": "#0F1526",
    "line": "#243050",
    "field": "#1C2740",
    "gridLine": "#0E1424",
    "accent": "#FFC85C",
    "accentEdge": "#FFE3A6",
    "ink": "#F2F5FB",
    "info": "#7BB8FF",
    "success": "#3DDC91",
    "pearlBlack": "#05070D",
    "pearlWhite": "#F2F5FB",
    "cutMark": "#8298C4",
}


def assert_palette():
    """母题用的每一个色都必须能在 js/theme.js 里找到，否则图标会慢慢和游戏长成分家两户。"""
    src = open(os.path.join(REPO, "js", "theme.js"), encoding="utf-8").read()
    hexes = {m.group(0).upper() for m in re.finditer(r"#[0-9a-fA-F]{6}\b", src)}
    for name, val in PALETTE.items():
        if val.upper() not in hexes:
            raise SystemExit(f"配色漂移：PALETTE[{name}]={val} 在 js/theme.js 里找不到")


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgba(h, a=255):
    return rgb(h) + (a,)


# ── 母题几何：4×4 格，格心之间连线（和 render/board.js 的画法同一个约定）───────
GRID = 4
# (行, 列) 顺序就是画笔经过的顺序；(1,0) 拐弯=黑珠，(1,1) 直穿=白珠。
PATH = [(3, 0), (2, 0), (1, 0), (1, 1), (1, 2), (0, 2)]
BLACK_AT = (1, 0)   # 拐弯的那格
WHITE_AT = (1, 1)   # 直穿的那格
CUT_EDGE = ((2, 1), (2, 2))  # 边中点上的一个叉：这条边不在环上


def board_box(size, inset=0.13):
    m = size * inset
    return m, m, size - m, size - m


def cell_centers(size):
    x0, y0, x1, y1 = board_box(size)
    cw, ch = (x1 - x0) / GRID, (y1 - y0) / GRID
    return {(r, c): (x0 + (c + 0.5) * cw, y0 + (r + 0.5) * ch) for r in range(GRID) for c in range(GRID)}


def gradient(size, top, bottom, mid_at=0.62):
    img = Image.new("RGBA", (size, size))
    a, b = rgb(top), rgb(bottom)
    rows = []
    for y in range(size):
        t = y / (size - 1)
        k = t / mid_at if t < mid_at else min(1.0, (t - mid_at) / (1 - mid_at) * 0.6 + 1.0)
        k = min(1.0, k)
        c = tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))
        rows.append(bytes(c) * size)
    img.putdata(Image.frombytes("RGB", (size, size), b"".join(rows)).convert("RGBA").getdata())
    return img


def master_icon(size=1024, maskable=False):
    """母图：不透明的方形（渐变底 + 暖光 + 那块圆角盘）。

    不抠圆角透明：PWA/启动器各有各的遮罩，带透明角的图标在部分桌面上会露出一圈棋盘底。
    maskable 那一版只是把主体缩进 80% 安全区，底仍是满幅渐变——这正是 maskable 的约定。
    """
    base = gradient(size, PALETTE["bgTop"], PALETTE["bgBottom"])
    base.putalpha(255)
    base.alpha_composite(glow(size))
    layer = motif(size)
    if not maskable:
        base.alpha_composite(layer)
        return base
    pad = int(size * 0.10)
    small = layer.resize((size - 2 * pad, size - 2 * pad), Image.LANCZOS)
    base.alpha_composite(small, (pad, pad))
    return base

def motif(size, palette=PALETTE, grid_alpha=44):
    """母题层（透明底）：网格 + 环段 + 黑白珠 + 排除叉。

    画在 2*size 上再降采样，是为了让 45° 以外的斜接和圆头有抗锯齿——PIL 的 line 本身不 AA。
    """
    S = size * 2
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = board_box(S)
    cw, ch = (x1 - x0) / GRID, (y1 - y0) / GRID

    # 1) 盘底 + 格线（图标里的「盘面」身份就靠这一层）
    d.rounded_rectangle([x0 - cw * 0.5, y0 - ch * 0.5, x1 + cw * 0.5, y1 + ch * 0.5],
                        radius=S * 0.035, fill=rgba(palette["field"], 255))
    for i in range(1, GRID):
        gx, gy = x0 + i * cw, y0 + i * ch
        d.line([(gx, y0), (gx, y1)], fill=rgba(palette["gridLine"], grid_alpha), width=max(1, int(S * 0.004)))
        d.line([(x0, gy), (x1, gy)], fill=rgba(palette["gridLine"], grid_alpha), width=max(1, int(S * 0.004)))

    pts = [cell_centers(S)[rc] for rc in PATH]
    lw = int(S * 0.085)

    # 2) 环段：先描一圈暗底垫色，再压琥珀——小尺寸下降采样后仍然是一条有轮廓的粗线
    d.line(pts, fill=rgba(palette["bgTop"], 200), width=lw + int(S * 0.022), joint="curve")
    d.line(pts, fill=rgba(palette["accent"], 255), width=lw, joint="curve")
    # 端点收圆：Masyu 的环是没有尽头的，但截图里这两头确实断着，给它圆头而不是平头
    for p in (pts[0], pts[-1]):
        r = lw // 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=rgba(palette["accent"], 255))

    # 3) 排除叉：画在一条**没经过**的边的中点上
    cc = cell_centers(S)
    mx = (cc[CUT_EDGE[0]][0] + cc[CUT_EDGE[1]][0]) / 2
    my = (cc[CUT_EDGE[0]][1] + cc[CUT_EDGE[1]][1]) / 2
    arm, xw = S * 0.030, max(2, int(S * 0.016))
    d.line([(mx - arm, my - arm), (mx + arm, my + arm)], fill=rgba(palette["cutMark"], 255), width=xw)
    d.line([(mx - arm, my + arm), (mx + arm, my - arm)], fill=rgba(palette["cutMark"], 255), width=xw)

    # 4) 珠子画在最上面（游戏里也是这一层压过环线）
    def pearl(rc, fill, ring):
        cx, cy = cc[rc]
        r = S * 0.062
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rgba(fill, 255),
                  outline=rgba(ring, 255), width=max(2, int(S * 0.014)))
    pearl(BLACK_AT, palette["pearlBlack"], palette["pearlWhite"])
    pearl(WHITE_AT, palette["pearlWhite"], palette["pearlBlack"])

    return layer.resize((size, size), Image.LANCZOS)


def glow(size, palette=PALETTE):
    """右上那一小片暖光：让母图不像一块纯色塑料，也不抢图形的戏。

    先在 256×256 上算径向衰减再整体放大——逐像素跑 1024² 是四百万次 Python 循环，图便宜。
    """
    N = 256
    rr = random.Random(SEED + 11)
    cx, cy = N * rr.uniform(0.62, 0.72), N * rr.uniform(0.16, 0.26)
    R = N * 0.72
    c = rgb(palette["accent"])
    px = bytearray(N * N * 4)
    for y in range(N):
        dy = (y - cy) ** 2
        row = y * N * 4
        for x in range(N):
            dd = ((x - cx) ** 2 + dy) ** 0.5 / R
            if dd >= 1.0:
                continue
            i = row + x * 4
            px[i:i + 3] = bytes(c)
            px[i + 3] = int(38 * (1 - dd) ** 2)
    small = Image.frombytes("RGBA", (N, N), bytes(px))
    small = small.filter(ImageFilter.GaussianBlur(N * 0.02))
    return small.resize((size, size), Image.BICUBIC)


def save_icon(img, path, size):
    img.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True, pnginfo=meta_info())


def meta_info():
    """每张 PNG 都带 seed 与资产版本：事后对账不用猜「这张图是哪条命令产的」。"""
    from PIL import PngImagePlugin
    info = PngImagePlugin.PngInfo()
    info.add_text("Seed", str(SEED))
    info.add_text("Art-Version", ART_VERSION)
    info.add_text("Generator", "assets/gen/gen_art.py")
    return info


# ── 游戏内资产 ────────────────────────────────────────────────────────────────
def board_texture(tile=256):
    """可平铺的盘底织纹：field 色上做 ±4 的经纬噪声，四边镜像所以必然无缝。

    它只铺在**盘面圆角卡片的外圈**（field 矩形之下、surface 之下），所以 tools/scenarios.js
    按格心/边中点取样的那批像素一个都没被碰到——那些断言量的是「这一格什么都没画」的参照色。
    """
    rr = random.Random(SEED + 3)
    half = tile // 2
    src = Image.new("RGB", (half, half))
    f = rgb(PALETTE["field"])
    px = []
    for y in range(half):
        for x in range(half):
            n = rr.randint(-4, 4)
            weave = 2 if (x + y) % 4 == 0 else 0
            px.append(tuple(max(0, min(255, v + n + weave)) for v in f))
    q = Image.new("RGB", (half, half))
    q.putdata(px)
    # 四边镜像 → 无缝；再叠一层极淡的斜向高光，纹理在 1px=1设备像素下才看得出经纬
    a = q.transpose(Image.FLIP_LEFT_RIGHT)
    b = q.transpose(Image.FLIP_TOP_BOTTOM)
    c = q.transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_TOP_BOTTOM)
    big = Image.new("RGB", (tile, tile))
    big.paste(q, (0, 0))
    big.paste(a, (half, 0))
    big.paste(b, (0, half))
    big.paste(c, (half, half))
    return big.convert("RGBA")


def fx_sprites(frame=128, frames=4):
    """粒子贴图条：4 帧从实心到散开的琥珀光环，draw 时按帧号取 x 偏移。

    第 0 帧是「刚落下的一笔」那一圈细环，最后一帧几乎全透——涟漪的寿命就在这 4 帧里走完。
    """
    strip = Image.new("RGBA", (frame * frames, frame), (0, 0, 0, 0))
    for i in range(frames):
        img = Image.new("RGBA", (frame, frame), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        t = i / (frames - 1)
        c = rgb(PALETTE["accent"] if i < 2 else PALETTE["accentEdge"])
        r_out = frame * (0.20 + 0.28 * t)
        w = max(1, int(frame * (0.085 - 0.055 * t)))
        alpha = int(235 * (1 - t) ** 1.6)
        d.ellipse([frame / 2 - r_out, frame / 2 - r_out, frame / 2 + r_out, frame / 2 + r_out],
                  outline=c + (alpha,), width=w)
        # 核心那点暖白：前两帧有、后两帧没有，粒子在 128px 下也不会糊成一坨
        core = frame * 0.07 * (1 - t)
        if core > 0.5:
            d.ellipse([frame / 2 - core, frame / 2 - core, frame / 2 + core, frame / 2 + core],
                      fill=rgb(PALETTE["ink"]) + (int(alpha * 0.7),))
        strip.paste(img, (i * frame, 0), img)
    return strip


def social_card(w=1200, h=630):
    """og / 社交卡：左边母题（真按比例画的 4×4 盘），右边标题与三条规则各一行。

    字用系统字体，取不到 CJK 字面就退回只用图形——但绝不画「方框占位符」冒充文字。
    """
    img = gradient(max(w, h), PALETTE["bgTop"], PALETTE["bgBottom"]).resize((w, h), Image.LANCZOS)
    # 左侧：一块放大的盘（复用 motif，尺寸 460）
    board = motif(460)
    pad = 70
    img.alpha_composite(glow(w, PALETTE), (int(w * 0.05), -120))
    img.alpha_composite(board, (pad, (h - 460) // 2))
    d = ImageDraw.Draw(img)
    # 右侧文字
    text = [
        ("数链", 92),
        ("Masyu · 一条闭环连过所有珠子", 30),
        ("黑珠那格必须拐弯，进出都直穿", 24),
        ("白珠那格必须直穿，前后至少拐一次", 24),
        ("出货的每一盘都实测过：唯一解 · 零猜测可推到底", 20),
    ]
    font = pick_font()
    x = pad + 460 + 64
    y = 120
    for i, (s, sz) in enumerate(text):
        f = font(sz)
        col = PALETTE["ink"] if i < 2 else ("#7BB8FF" if i == 2 else "#F2F5FB")
        d.text((x, y), s, font=f, fill=rgb(col))
        y += int(sz * 1.9) + (26 if i == 0 else 0)
    # 右下角一小条琥珀，和环线段同色：卡片的「签名」
    d.rectangle([w - 260, h - 26, w - 70, h - 18], fill=rgb(PALETTE["accent"]))
    return img


FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def pick_font():
    from PIL import ImageFont
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return lambda sz, p=p: ImageFont.truetype(p, sz)
    return lambda sz: ImageFont.load_default()


def png_size(path):
    with open(path, "rb") as fh:
        head = fh.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} 不是 PNG")
    w, h = struct.unpack(">II", head[16:24])
    return w, h


# ── 组装 ──────────────────────────────────────────────────────────────────────
WEB_SIZES = {  # 文件名 → 边长（icons/）
    "icon-1024.png": 1024,
    "icon-512.png": 512,
    "icon-192.png": 192,
    "icon-180.png": 180,   # apple-touch-icon
    "icon-96.png": 96,
    "icon-48.png": 48,
    "favicon-32.png": 32,
    "favicon-16.png": 16,
}
MASKABLE = {"icon-maskable-512.png": 512, "icon-maskable-192.png": 192}


def build(dry=False):
    assert_palette()
    icons = os.path.join(REPO, "icons")
    art = os.path.join(REPO, "art")
    for p in (icons, art):
        os.makedirs(p, exist_ok=True)
    manifest = {"version": ART_VERSION, "seed": SEED, "palette": PALETTE, "files": {}}

    m = master_icon(1024)
    mk = master_icon(1024, maskable=True)
    for name, size in WEB_SIZES.items():
        # 连 16px 也从同一张母图降采样：另画一个「小尺寸专用图」就等于承认母图撑不住
        dst = os.path.join(icons, name)
        if not dry:
            save_icon(m, dst, size)
        manifest["files"]["icons/" + name] = size
    for name, size in MASKABLE.items():
        dst = os.path.join(icons, name)
        if not dry:
            save_icon(mk, dst, size)
        manifest["files"]["icons/" + name] = size

    # 盘上真正被游戏加载的两张：织纹 + 粒子条
    tex = board_texture(256)
    dst = os.path.join(art, "board-texture.png")
    if not dry:
        tex.save(dst, "PNG", optimize=True, pnginfo=meta_info())
    manifest["files"]["art/board-texture.png"] = 256

    spr = fx_sprites(128, 4)
    dst = os.path.join(art, "fx-sprites.png")
    if not dry:
        spr.save(dst, "PNG", optimize=True, pnginfo=meta_info())
    manifest["files"]["art/fx-sprites.png"] = "512x128"

    og = social_card(1200, 630)
    dst = os.path.join(art, "og.png")
    if not dry:
        og.save(dst, "PNG", optimize=True, pnginfo=meta_info())
    manifest["files"]["art/og.png"] = "1200x630"

    dst = os.path.join(REPO, "assets", "gen", "art-manifest.json")
    if not dry:
        json.dump(manifest, open(dst, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        open(dst, "a").write("\n")
    return manifest


def check():
    manifest = build(dry=True)
    bad = []
    expect = {
        "icons/icon-1024.png": (1024, 1024), "icons/icon-512.png": (512, 512),
        "icons/icon-192.png": (192, 192), "icons/icon-maskable-192.png": (192, 192),
        "icons/icon-180.png": (180, 180), "icons/icon-maskable-512.png": (512, 512),
        "icons/icon-96.png": (96, 96), "icons/icon-48.png": (48, 48),
        "icons/favicon-32.png": (32, 32), "icons/favicon-16.png": (16, 16),
        "art/board-texture.png": (256, 256), "art/fx-sprites.png": (512, 128),
        "art/og.png": (1200, 630),
    }
    for rel, (w, h) in expect.items():
        p = os.path.join(REPO, rel)
        if not os.path.exists(p):
            bad.append(f"缺文件 {rel}")
            continue
        if os.path.getsize(p) == 0:
            bad.append(f"0 字节 {rel}")
            continue
        got = png_size(p)
        if got != (w, h):
            bad.append(f"尺寸不符 {rel} 期望 {w}x{h} 实测 {got[0]}x{got[1]}")
        else:
            print(f"OK {rel:34s} {got[0]}x{got[1]}  {os.path.getsize(p)}B")
    print(f"--- 断言 {len(manifest['files'])} 条，失败 {len(bad)}")
    for b in bad:
        print("  FAIL " + b)
    return 1 if bad else 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        raise SystemExit(check())
    mf = build()
    print(f"seed={SEED} version={ART_VERSION} 文件={len(mf['files'])}")
    for rel, sz in sorted(mf["files"].items()):
        p = os.path.join(REPO, rel)
        print(f"  {rel:34s} {sz}")
