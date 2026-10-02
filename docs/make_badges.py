# -*- coding: utf-8 -*-
"""生成落地页顶部的徽章，并把它们写成**算出来的**，不是手写的。

为什么要有这个脚本
------------------
徽章里的数字是最容易悄悄过期的东西。落地页原来那排写着 "289 KB"，
而 isoclock.html 当时已经是 290549 字节 —— 重建一次页面它就不对了，
而且没有任何东西会报错。所以这里把徽章改成**由脚本从源头算出来再写进 HTML**：

    python docs/make_badges.py            # 重算并写入
    python docs/make_badges.py --check    # 只核对，不一致就非零退出（CI 用）

数字的来源
----------
  * 文件体积     直接 `os.path.getsize()`，页面上按 KiB 显示，字节数放进 title
  * 比对项数     **真跑** webgui/test_*.js 再累加（这就是唯一真源；不引第二份数字）
  * 自检项数     取自产物页面的 #selftest 标题；没有浏览器时退回常量并在输出里说明

样式
----
刻意**不用 shields.io**：那些徽章是外部图片，会带来一次网络请求，
而这个站点的约定是零外链、离线可开（整个 docs/ 双击就能看）。
所以这里生成的是内联 HTML 药丸，跟着页面主题走深浅色。
"""

import argparse
import io
import os
import re
import shutil
import subprocess
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors='replace')
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(HERE, 'index.html')
WEBGUI = os.path.join(ROOT, 'webgui')

BEGIN = '<!-- BADGES:BEGIN 由 docs/make_badges.py 生成；改数字请改源头并重跑 -->'
END = '<!-- BADGES:END -->'

SUITES = ['test_fp.js', 'test_math.js', 'test_thermo.js', 'test_agilent.js',
          'test_window.js', 'test_e2e.js', 'test_age.js', 'test_age76.js',
          'test_agilent_e2e.js', 'test_thermo_compat.js', 'test_qc.js',
          'test_report.js']

# 页面内自检的项数。真源是产物页面在 #selftest 下自己报出来的那个数
# （标题形如 `SELFTEST-OK [37/37]`）。有 Edge 时用 --selftest 现场核一遍。
SELFTEST_ITEMS = 37

SUM_RE = re.compile(r'总计\s*(\d+)\s*项：通过\s*(\d+)，失败\s*(\d+)'
                    r'|结果：\s*(\d+)\s*通过\s*/\s*(\d+)\s*失败')


def find_node():
    exe = shutil.which('node')
    if exe:
        return exe
    cand = os.path.join(os.path.expanduser('~'), '.workbuddy', 'binaries', 'node')
    if os.path.isdir(cand):
        for v in sorted(os.listdir(cand), reverse=True):
            p = os.path.join(cand, v, 'node.exe')
            if os.path.isfile(p):
                return p
    return None


def run_suites(node):
    """真跑 12 套比对，返回 (通过数, 套数)。任何一套失败就报错退出。"""
    total_pass = 0
    for f in SUITES:
        p = subprocess.run([node, f], cwd=WEBGUI, capture_output=True, text=True,
                           errors='replace', timeout=600)
        txt = (p.stdout or '') + (p.stderr or '')
        m = None
        for m in SUM_RE.finditer(txt):
            pass
        if not m:
            raise SystemExit('!! %s 没有输出可识别的汇总行' % f)
        g = m.groups()
        if g[0] is not None:                 # 总计 N 项：通过 X，失败 Y
            n, ok, bad = int(g[0]), int(g[1]), int(g[2])
        else:                                # 结果：X 通过 / Y 失败
            ok, bad = int(g[3]), int(g[4])
            n = ok + bad
        if bad:
            raise SystemExit('!! %s 有 %d 项失败' % (f, bad))
        total_pass += ok
    return total_pass, len(SUITES)


def selftest_items_from_browser():
    """有 Edge 就用无头浏览器把产物页面跑一遍，读它自己报的项数。

    读不到就返回 None —— 不猜。调用方退回常量并**在输出里说清楚**。
    """
    edge = None
    for c in (r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
              r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'):
        if os.path.isfile(c):
            edge = c
            break
    if not edge:
        return None
    page = os.path.join(WEBGUI, 'isoclock.html')
    if not os.path.isfile(page):
        return None
    try:
        p = subprocess.run(
            [edge, '--headless=new', '--disable-gpu',
             '--user-data-dir=' + os.path.join(os.environ.get('TEMP', '.'), 'isobadge'),
             '--virtual-time-budget=60000', '--dump-dom',
             'file:///' + page.replace('\\', '/') + '#selftest'],
            capture_output=True, text=True, errors='replace', timeout=180)
        m = re.search(r'SELFTEST-(?:OK|FAIL) \[(\d+)/(\d+)\]', p.stdout or '')
        if m:
            return int(m.group(2)), int(m.group(1))     # (总项数, 通过数)
    except Exception:
        return None
    return None


def kib(nbytes):
    return '%.0f KB' % (nbytes / 1024.0)


def build_badges():
    page = os.path.join(WEBGUI, 'isoclock.html')
    if not os.path.isfile(page):
        raise SystemExit('!! 找不到 %s，先跑 webgui/build_ui.py' % page)
    page_bytes = os.path.getsize(page)
    guide = os.path.join(HERE, 'guide.html')
    guide_bytes = os.path.getsize(guide) if os.path.isfile(guide) else None

    node = find_node()
    if not node:
        raise SystemExit('!! 找不到 node，无法重算比对项数（用 --no-tests 跳过）')
    n_pass, n_suite = run_suites(node)

    st = selftest_items_from_browser()
    if st is None:
        n_selftest, st_note = SELFTEST_ITEMS, '常量（没跑成无头浏览器，未现场核对）'
    else:
        n_selftest, _stok = st
        st_note = '无头浏览器现场读到'

    exe = os.path.join(ROOT, 'dist', 'IsoclockWeb.exe')

    #  说明文案与数字一起生成 —— 免得改了数字忘了改说明
    items = [
        ('ok', '%d 项数值比对全绿' % n_pass,
         '%d 套 webgui/test_*.js，与桌面版逐位对照；本行由脚本实跑得出' % n_suite),
        ('ok', '%d 项页面内自检' % n_selftest,
         '在产物页面里点真按钮跑；项数%s' % st_note),
        ('ok', '与桌面版逐位相同',
         '含浮点最后一位；由上面那批比对保证'),
        ('pu', '单文件 %s · 离线' % kib(page_bytes),
         'isoclock.html = %d 字节；零外链、零依赖，双击即用' % page_bytes),
        ('', 'Windows / macOS 桌面程序',
         '同一个页面装进系统自带的 WebView；Windows 出 exe，macOS 出 app'),
        ('', 'Thermo + Agilent', '两种仪器导出都能读（Element 的 .fin 请用桌面版转换）'),
        ('', 'Apache-2.0', '沿用上游 sndjgm/Isoclock 的许可证'),
    ]
    if guide_bytes:
        items.insert(4, ('pu', '图解教程 %s' % kib(guide_bytes),
                         'guide.html = %d 字节，56 张内联图' % guide_bytes))
    if os.path.isfile(exe):
        items.append(('', 'exe 单文件 %.1f MB' % (os.path.getsize(exe) / 1048576.0),
                      'dist/IsoclockWeb.exe = %d 字节' % os.path.getsize(exe)))

    lines = [BEGIN]
    for cls, text, tip in items:
        attr = (' class="b %s"' % cls) if cls else ' class="b"'
        lines.append('    <span%s title="%s">%s</span>'
                     % (attr, tip.replace('"', '&quot;'), text))
    lines.append('    ' + END)
    return '\n'.join(lines), items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只核对，不一致就非零退出')
    a = ap.parse_args()

    html = io.open(INDEX, encoding='utf-8').read()
    if BEGIN not in html or END not in html:
        raise SystemExit('!! index.html 里找不到徽章标记，先手工放一对\n%s\n%s'
                         % (BEGIN, END))

    block, items = build_badges()
    print('算出来的徽章（%d 个）：' % len(items))
    for cls, text, tip in items:
        print('   [%-2s] %s' % (cls or '-', text))

    i = html.index(BEGIN)
    j = html.index(END) + len(END)
    old = html[i:j]
    if a.check:
        if old.strip() == block.strip():
            print('\n--check：页面上的徽章与实算一致。')
            return 0
        print('\n--check：**页面上的徽章已过期**，跑 `python docs/make_badges.py` 重算。')
        print('--- 页面上现在写的 ---')
        for ln in old.splitlines():
            if '<span' in ln:
                print('   ' + ln.strip())
        return 1

    if old.strip() == block.strip():
        print('\n页面上的徽章已经是最新，未改动。')
        return 0
    io.open(INDEX, 'w', encoding='utf-8', newline='').write(html[:i] + block + html[j:])
    print('\n已写入 %s' % os.path.relpath(INDEX, ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
