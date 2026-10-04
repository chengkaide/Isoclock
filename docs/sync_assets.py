#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把站点需要的"别处产出的"文件同步进 docs/，保持单一真实来源。

同步三样东西，每样只有一个上游：

  1. webgui/isoclock.html          -> docs/app/isoclock.html
     上游是 webgui/build_ui.py 的产物。构建完网页版后跑一次本脚本，
     保证站点上挂的就是最新那份，不是某个旧的手工拷贝。

  2. <workspace>/Isoclock_原理与代码解读_图解版.html -> docs/guide.html
     上游是 docbuild/ 的产物，位于作者的工作区而非本仓库，所以路径用
     --guide 指定或 GUIDESRC 环境变量给出；找不到就**保留现有** docs/guide.html
     并给出警告（不把站点弄坏）。复制时会在末尾注入一个"返回首页"的浮动链接。

     写出的文件统一用 LF（见 sync_guide 里的说明）：体积数会进徽章，
     不能让它在 Windows 和 Linux 上不一样。

  3. webgui/screenshots/*.png      -> docs/assets/*.png
     重命名为站点里引用的名字。

用法：
    python docs/sync_assets.py
    python docs/sync_assets.py --guide "D:/somewhere/图解版.html"
    python docs/sync_assets.py --check      # 只报告，不写

退出码：0 正常；1 有致命问题（如 webgui/isoclock.html 不存在）。
"""

import argparse
import io
import os
import re
import shutil
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------- 路径

HERE = Path(__file__).resolve().parent          # .../docs
REPO = HERE.parent                              # 仓库根
WEBGUI = REPO / "webgui"
SHOTS = WEBGUI / "screenshots"

DEFAULT_GUIDE = Path(
    r"C:\Users\凯凯\WorkBuddy\2026-09-17-23-54-13\Isoclock_原理与代码解读_图解版.html"
)

# 站点里引用的截图名 -> 上游截图名
SHOT_MAP = {
    "ui-signal.png": "1_信号图.png",
    "ui-ages.png": "2_年龄表.png",
    "ui-report-panel.png": "5_质量报告面板.png",
    "ui-compat.png": "6_兼容读取.png",
    "ui-report.png": "7_质量报告节选.png",
    #  8/9/10 号这三张是唯一**需要联网**的：拍之前要真去 CDN 下 webR 与 IsoplotR。
    #  上游脚本是 G:/_isohtml/shot_iso.py（走 CDP 等页面报完成再抓图，
    #  不能用 `--virtual-time-budget`，见那个脚本的文件头）。
    #  8 → 默认视图（全部样品，不含标样）；9 → 单独看标样 AY-4 时的那套 QC 对照；
    #  10 → 「更多选项」面板展开（`--more`）并摆了几个控件（`--pre`）。
    "ui-isoplotr.png": "8_IsoplotR谐和图.png",
    "ui-isoplotr-std.png": "9_IsoplotR标样QC.png",
    "ui-isoplotr-more.png": "10_IsoplotR更多选项.png",
}

# 注入到 guide.html 末尾的浮动返回链接。
# 用内联样式，避免和原文那份 <style> 抢选择器；深浅色都跟系统走。
BACKLINK = """
<a id="fork-back" href="index.html" title="返回项目首页"
   style="position:fixed;right:16px;bottom:16px;z-index:9999;
          display:inline-block;padding:7px 14px;border-radius:999px;
          font:13px/1.4 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
          text-decoration:none;border:1px solid #D3D1C7;background:#FFFFFF;color:#534AB7;
          box-shadow:0 1px 2px rgba(0,0,0,.06),0 6px 18px -8px rgba(0,0,0,.25)">
  &larr; 项目首页
</a>
<style>
@media (prefers-color-scheme:dark){
  #fork-back{background:#232321!important;border-color:#3B3B37!important;color:#B5AEF5!important}
}
@media print{ #fork-back{display:none!important} }
</style>
"""


def _mb(p):
    try:
        return p.stat().st_size / 1024.0 / 1024.0
    except OSError:
        return 0.0


def _report(label, dst, note=""):
    print("  %-26s %8.1f KB  %s%s" % (label, _mb(dst) * 1024, dst.relative_to(REPO), note))


def _replace_atomic(tmp, dst):
    """os.replace + 少量重试。目标被别的进程占着时 Windows 会抛 PermissionError，
    而这类占用往往是瞬时的（编辑器保存、杀软扫描、预览面板重建缓存）。"""
    last = None
    for _ in range(5):
        try:
            os.replace(tmp, dst)
            return
        except PermissionError as exc:
            last = exc
            time.sleep(0.25)
    raise last


def _copy_atomic(src, dst):
    """先写 .tmp 再原子替换，而不是 shutil.copyfile 直接覆盖目标。

    原因：目标文件被别的进程以**独占方式**打开时，copyfile 会抛
    PermissionError（本机 2026-10-03 实测：docs/app/isoclock.html 被预览面板
    占着，"删除+重建"不行、"改名替换"可以）。先写临时文件再 os.replace
    只需要"允许改名"的权限，能绕开这类占用；顺带也避免目标出现写了一半的中间态。
    """
    tmp = str(dst) + ".tmp"
    shutil.copyfile(src, tmp)
    _replace_atomic(tmp, dst)


def _write_text_atomic(dst, text):
    """同上，写入文本。显式 LF —— 原因见 sync_guide 里的长注释。"""
    tmp = str(dst) + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    _replace_atomic(tmp, dst)


# ---------------------------------------------------------------- 1. 网页版

def sync_app(check):
    src = WEBGUI / "isoclock.html"
    dst = HERE / "app" / "isoclock.html"
    if not src.exists():
        print("  !! 找不到 %s —— 先跑 webgui/build_ui.py" % src)
        return False
    if check:
        same = dst.exists() and dst.read_bytes() == src.read_bytes()
        print("  %-26s %s" % ("网页版 isoclock.html", "已是最新" if same else "**需要同步**"))
        return True
    dst.parent.mkdir(parents=True, exist_ok=True)
    #  内容已经一致就不写：既省一次 I/O，也避开"目标被别的进程占着"这类偶发锁
    #  （写路径上撞锁会中断后面所有步骤，而这几步之间并没有依赖关系）。
    if dst.exists() and dst.read_bytes() == src.read_bytes():
        _report("网页版 isoclock.html", dst, "  (已是最新，未改动)")
        return True
    _copy_atomic(src, dst)
    _report("网页版 isoclock.html", dst)
    return True


# ---------------------------------------------------------------- 2. 图解教程

def _guide_expected(src):
    """算出 guide.html 应该长什么样：原文 + 注入的返回首页链接。
    写入与检查两条路径共用它，否则 --check 永远报"需要同步"（曾经如此）。"""
    html = Path(src).read_text(encoding="utf-8")
    if "</body>" not in html:
        return None
    # 幂等：先抹掉上一次注入的痕迹，免得叠加
    html = re.sub(r'\n<a id="fork-back".*?</style>\n', "\n", html, flags=re.S)
    if 'id="fork-back"' in html:
        html = re.sub(r'<a id="fork-back".*</a>', "", html, flags=re.S)
    return html.replace("</body>", BACKLINK + "</body>", 1)


def sync_guide(src, check):
    dst = HERE / "guide.html"
    if src is None or not Path(src).exists():
        if dst.exists():
            print("  %-26s 上游缺失，保留现有 guide.html（%.1f KB）"
                  % ("图解教程 guide.html", _mb(dst) * 1024))
            return True
        print("  !! 上游缺失且 docs/guide.html 也不存在 —— 站点会缺一个页面")
        return False

    want = _guide_expected(src)
    if want is None:
        print("  !! 上游文件里没有 </body>，拒绝注入")
        return False

    if check:
        same = dst.exists() and dst.read_text(encoding="utf-8") == want
        print("  %-26s %s" % ("图解教程 guide.html", "已是最新" if same else "**需要同步**"))
        return True

    #  ⚠ 必须显式 newline="\n"，别用 Path.write_text() 的默认值：
    #  默认在 Windows 上会把每个 \n 翻成 \r\n，于是工作区里这份比仓库里那份
    #  **多出 692 字节**（每行 1 个字节），而 GitHub Pages 服务的是仓库里那份。
    #  后果不是"文件坏了"，而是**页面上的体积数在 Windows 和 Linux 上不一样**：
    #  docs/make_badges.py 量的是本地文件、CI（ubuntu）量的是 checkout 出来的文件，
    #  两边都往徽章里写"图解教程 xx KB"和 {{GUIDEKB}}，一旦舍入落在边界上，
    #  CI 的 --check 就会红 —— 而且只在别人机器上红，最坏的那种红。
    #  统一成 LF 之后，两边量到的是同一个数（2026-10-04 实测 482008 字节）。
    _write_text_atomic(dst, want)
    _report("图解教程 guide.html", dst, "  (注入了返回首页链接)")
    return True


# ---------------------------------------------------------------- 3. 截图

def sync_shots(check):
    ok = True
    assets = HERE / "assets"
    if not SHOTS.exists():
        print("  !! 找不到 webgui/screenshots/")
        return False
    if not check:
        assets.mkdir(parents=True, exist_ok=True)
    for new, old in SHOT_MAP.items():
        s = SHOTS / old
        d = assets / new
        if not s.exists():
            print("  !! 缺截图 %s" % s)
            ok = False
            continue
        if check:
            same = d.exists() and d.read_bytes() == s.read_bytes()
            print("  %-26s %s" % (new, "已是最新" if same else "**需要同步**"))
            continue
        _copy_atomic(s, d)
        _report(new, d)
    return ok


# ---------------------------------------------------------------- 4. .nojekyll

def sync_nojekyll(check):
    """GitHub Pages 默认跑 Jekyll，会忽略下划线开头的文件/目录。
    本站全是静态文件，用 .nojekyll 关掉处理，也省一次构建失败的风险。"""
    dst = HERE / ".nojekyll"
    if check:
        print("  %-26s %s" % (".nojekyll", "存在" if dst.exists() else "**缺失**"))
        return True
    dst.write_bytes(b"")
    print("  %-26s %s" % (".nojekyll", "就位（关闭 Jekyll 处理）"))
    return True


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="同步 docs/ 站点资源")
    ap.add_argument("--guide", default=os.environ.get("GUIDESRC") or str(DEFAULT_GUIDE),
                    help="图解版 HTML 的路径")
    ap.add_argument("--check", action="store_true", help="只检查是否需要同步，不写文件")
    a = ap.parse_args()

    print("仓库根目录: %s" % REPO)
    print("模式: %s" % ("检查" if a.check else "写入"))
    print("")

    r = [
        sync_app(a.check),
        sync_guide(a.guide, a.check),
        sync_shots(a.check),
        sync_nojekyll(a.check),
    ]

    if not a.check:
        total = sum(_mb(p) for p in HERE.rglob("*") if p.is_file())
        print("")
        print("docs/ 合计 %.2f MB，共 %d 个文件"
              % (total, sum(1 for p in HERE.rglob("*") if p.is_file())))

    return 0 if all(r) else 1


if __name__ == "__main__":
    sys.exit(main())
