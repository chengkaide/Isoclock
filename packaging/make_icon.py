# -*- coding: utf-8 -*-
"""生成应用图标（PNG + ICO）。macOS 的 .icns 由 PyInstaller 从 PNG 转换。

图案：**协和线上的三个点** —— 这正是这个程序在算的东西。
深蓝底 + 暖金曲线 + 白点，缩到 16×16 也能认出来。

曲线用真实的衰变常数算，坐标朝向按项目约定
（横轴 ²⁰⁷Pb/²³⁵U、纵轴 ²⁰⁶Pb/²³⁸U），所以它是一条**斜率由陡变缓**的凹曲线。

用法:  python packaging/make_icon.py
产出:  packaging/icons/icon.png (1024) 、icon.ico (多尺寸)
"""

import math
import os
import sys

from PIL import Image, ImageDraw

L238 = 1.55125e-10          # ²³⁸U 衰变常数
L235 = 9.8485e-10           # ²³⁵U 衰变常数
RATIO = 137.818             # ²³⁸U/²³⁵U

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'icons')

BG = (14, 32, 52, 255)
EDGE = (32, 66, 100, 255)
CURVE = (235, 179, 74, 255)
DOT = (255, 255, 255, 255)


def concordia(t_ma):
    """t(Ma) -> (²⁰⁷Pb/²³⁵U, ²⁰⁶Pb/²³⁸U)"""
    t = t_ma * 1e6
    return (math.exp(L235 * t) - 1.0) / RATIO, math.exp(L238 * t) - 1.0


def _band(pts, half):
    """把折线加粗成**多边形带**。

    直接用 ImageDraw.line + joint='curve' 画 400 个点的折线，接头处会出现锯齿
    （一大片"梳齿"），缩小后更明显。改成沿法线偏移出左右两条边界再合成多边形，
    边缘就干净了 —— 端点另外补两个圆当圆头。
    """
    left, right = [], []
    n = len(pts)
    for i, (px, py) in enumerate(pts):
        # 用相邻点估切线，端点用单侧差分
        i0, i1 = max(0, i - 1), min(n - 1, i + 1)
        tx, ty = pts[i1][0] - pts[i0][0], pts[i1][1] - pts[i0][1]
        L = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / L, tx / L
        left.append((px + nx * half, py + ny * half))
        right.append((px - nx * half, py - ny * half))
    return left + right[::-1]


def render(size=1024, ss=3):
    S = size * ss
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # 圆角底 + 一圈内描边
    pad = S * 0.052
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=S * 0.212, fill=BG)
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=S * 0.212,
                        outline=EDGE, width=max(1, int(S * 0.006)))

    # 绘图区（留出四周空白）
    x0, y0 = S * 0.190, S * 0.800
    x1, y1 = S * 0.845, S * 0.215
    tmax = 4400.0
    xmax, ymax = concordia(tmax)

    def at(t):
        cx, cy = concordia(t)
        return (x0 + (x1 - x0) * (cx / xmax), y0 + (y1 - y0) * (cy / ymax))

    n = 240
    pts = [at(tmax * i / n) for i in range(n + 1)]

    half = S * 0.033
    d.polygon(_band(pts, half), fill=CURVE)
    for end in (pts[0], pts[-1]):                     # 圆头
        d.ellipse([end[0] - half, end[1] - half, end[0] + half, end[1] + half], fill=CURVE)

    # 三个落在曲线上的点：一致（concordant）的数据点
    r = S * 0.050
    for t in (800.0, 2100.0, 3500.0):
        px, py = at(t)
        d.ellipse([px - r, py - r, px + r, py + r], fill=DOT)

    return im.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    base = render(1024)
    png = os.path.join(OUT, 'icon.png')
    base.save(png)

    ico = os.path.join(OUT, 'icon.ico')
    base.save(ico, format='ICO',
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64),
                     (128, 128), (256, 256)])

    # 顺便看一眼 16×16 还认不认得出来
    base.resize((32, 32), Image.LANCZOS).resize((256, 256), Image.NEAREST).save(
        os.path.join(OUT, '_preview32.png'))

    for p in (png, ico):
        print('%-46s %8.1f KB' % (os.path.relpath(p, HERE), os.path.getsize(p) / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
