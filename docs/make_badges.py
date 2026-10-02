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

#  "本机才测得到"的徽章。dist/ 不进仓库，CI 的 verify-node 跑在 ubuntu 上、
#  没有 exe，生成的徽章块天生比本机少这一条 —— 而本机的页面里是有的。
#  核对时把这一条摘掉再比，否则"一个本地才存在的数"会让 CI 永远红，
#  比不检还糟（红久了就没人看了）。
LOCAL_ONLY_BADGE = 'exe 单文件'

SUITES = ['test_fp.js', 'test_math.js', 'test_thermo.js', 'test_agilent.js',
          'test_window.js', 'test_e2e.js', 'test_age.js', 'test_age76.js',
          'test_agilent_e2e.js', 'test_thermo_compat.js', 'test_qc.js',
          'test_report.js', 'test_demo_real.js']

# 页面内自检的项数。真源是产物页面在 #selftest 下自己报出来的那个数
# （标题形如 `SELFTEST-OK [41/41]`）。有 Edge 时用 --selftest 现场核一遍。
SELFTEST_ITEMS = 41

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
    """真跑全部比对套件（SUITES 里有几套就跑几套），返回 (通过数, 套数)。
    任何一套失败就报错退出 —— 别让"上一版是绿的"混进这一版的徽章里。"""
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


def read_demo_facts():
    """从内置真实示例数据的产物里读标样实测值 + 内嵌体量。

    正文里"标样 AY-4 出 157.0 ± 1.4 Ma"和"压缩后 340 KB"这两句话以前是手写的
    —— 那正是本站最不能容忍的一类数：换一批数据、换一套参数，它会**悄无声息地
    变成假话**，而旁边实算的徽章还说着新数。所以改成从
    webgui/src/demo_real.js 里取（stdMeasured 本身也是 make_real_demo.py
    用真管线量出来的，不是设想的）。

    读不到就少几个键，让 substitute() 因为换不掉 {{AY4}} 而报错 ——
    宁可构建停下来，也不要印一个猜出来的标样年龄。
    """
    src = os.path.join(WEBGUI, 'src', 'demo_real.js')
    if not os.path.isfile(src):
        return {}
    txt = io.open(src, encoding='utf-8').read()
    f = {}
    gz = re.search(r'\bgzipBytes:\s*(\d+)', txt)
    if gz:
        f['GZIPKB'] = '%.0f' % (int(gz.group(1)) / 1024.0)
    m = re.search(r'stdMeasured:\s*\{([^}]*)\}', txt)
    if m:
        blk = m.group(1)

        def num(k):
            mm = re.search(r'\b%s:\s*(-?[\d.eE+]+)' % k, blk)
            return float(mm.group(1)) if mm else None

        mean, se2, mswd = num('mean'), num('se2'), num('mswd')
        if None not in (mean, se2, mswd):
            #  se2 是 2σ —— 页面上的 ± 必须连着口径说，
            #  否则跟报告里的 1σ（0.7）看着像两个数对不上。
            f.update({'AY4': '%.1f' % mean, 'AY4SE': '%.1f' % se2,
                      'AY4MSWD': '%.2f' % mswd})
    return f


def token_facts(page_bytes, guide_bytes, exe_bytes, n_pass, n_suite, n_selftest):
    """正文里可以引用的实算值 —— 写成 {{TOKEN}} 由本脚本替换。

    加这一层是因为页面正文原来那句"单文件 284 KB"是手写的：产物涨到 756 KB
    之后它变成了假话，而旁边实算的徽章说的是新数 —— 同一页对同一个事实
    说了两个数。手写的数字迟早会过期，所以正文和徽章共用同一套值。

    只放**与构建环境无关**的值。exe 的体积就是典型反例：dist/ 不进仓库，
    CI 的 ubuntu 机器上不存在这个文件，做成标记会让"核对徽章"永远失败 ——
    一个本机才存在的数不该进这一套。它的精确值只出现在徽章里（有 exe 才生成），
    正文那句写的是明确标了"约"的量级。

    少了某个键就让页面上留着 {{TOKEN}}，由 substitute() 报错 ——
    宁可构建失败，也不要印一个猜出来的数。
    """
    f = {
        'TESTS': n_pass,
        'SUITES': n_suite,
        'SELFTEST': n_selftest,
        'PAGEKB': kib(page_bytes).replace(' KB', ''),
    }
    if guide_bytes:
        f['GUIDEKB'] = kib(guide_bytes).replace(' KB', '')
    f.update(read_demo_facts())
    return f


def substitute(html, facts):
    """把 {{TOKEN}} 换成实算值；换不掉的标记直接报错。

    这是**故意**让它能失败：页面里留一个没被替换的 {{SOMETHING}}，
    说明有人加了新标记却忘了在 token_facts 里给值 —— 那就该让构建停下来，
    而不是把一个花括号印给读者看。
    """
    out = html
    for k, v in facts.items():
        out = out.replace('{{%s}}' % k, str(v))
    left = sorted(set(re.findall(r'\{\{(\w+)\}\}', out)))
    if left:
        raise SystemExit('!! index.html 里还有没被替换的标记：%s\n'
                         '      要么在 token_facts() 里补上实算值，要么改掉标记。\n'
                         '      注意：**注释里写字面的双花括号也会被当成标记**'
                         '（踩过 —— 解释"这里为什么不用标记"的注释里写了 %s，'
                         '结果构建直接停）。'
                         % ('、'.join(left), '{{' + '%s' % left[0] + '}}'))
    return out


def check_ui_claims(n_pass, n_suite, n_selftest):
    """页面内「结果可信到什么程度」那段里的三个数，必须与实跑的相符。

    那三个数（多少项比对 / 多少套 / 多少项自检）是给用户看的承诺，
    但它们写在 HTML 里，**没法在页面里自己算出来**（要跑 Node 才知道）。
    所以退一步：数字仍然写死在 webgui/ui/app.html，由本函数在每次 CI 里
    跟实跑结果比一次 —— 对不上就红。不这么钉住的话，加一套测试就会让
    页面上的"314 项"悄悄变成假话（已经发生过一次）。
    """
    p = os.path.join(WEBGUI, 'ui', 'app.html')
    if not os.path.isfile(p):
        raise SystemExit('!! 找不到 %s' % p)
    txt = io.open(p, encoding='utf-8').read()
    want = {'tests': n_pass, 'suites': n_suite, 'selftest': n_selftest}
    bad = []
    for k, v in want.items():
        #  量词是"项"或"套"（"13 套 test_*.js"），所以别只认"项"
        m = re.search(r'data-count="%s">\s*(\d+)\s*[项套]' % k, txt)
        if not m:
            bad.append('app.html 里找不到 data-count="%s" 的标记' % k)
        elif int(m.group(1)) != v:
            bad.append('app.html 说 %s = %s，实跑是 %d' % (k, m.group(1), v))
    if bad:
        raise SystemExit('!! 帮助弹窗里的数字与实跑不符：\n       '
                         + '\n       '.join(bad)
                         + '\n       改 webgui/ui/app.html，然后重跑 webgui/build_ui.py')
    print('  帮助弹窗里的三个数：%d 项比对 / %d 套 / %d 项自检 —— 与实跑一致'
          % (n_pass, n_suite, n_selftest))


def comparable(html):
    """摘掉"本机才测得到"的那几行，用来比对页面是否需要重算。

    只摘徽章行，不动正文 —— 正文里没有 {{EXEMB}} 这类环境相关的标记
    （见 token_facts 的说明）。
    """
    return '\n'.join(ln for ln in html.splitlines()
                     if LOCAL_ONLY_BADGE not in ln)


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
    facts = token_facts(page_bytes, guide_bytes,
                        os.path.getsize(exe) if os.path.isfile(exe) else None,
                        n_pass, n_suite, n_selftest)
    check_ui_claims(n_pass, n_suite, n_selftest)
    return '\n'.join(lines), items, facts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只核对，不一致就非零退出')
    ap.add_argument('--list-suites', action='store_true',
                    help='打印比对套件文件名（给 CI 用：清单只写在本文件的 SUITES 里）')
    a = ap.parse_args()

    if a.list_suites:
        #  CI 那个"跑全部比对套件"的步骤原来自己抄了一份文件清单 ——
        #  加了 test_demo_real.js 之后它没跟上，等于新套件在 CI 上从没被点名跑过。
        #  现在清单的唯一来源就是本文件的 SUITES。
        print(' '.join(SUITES))
        return 0

    html = io.open(INDEX, encoding='utf-8').read()
    if BEGIN not in html or END not in html:
        raise SystemExit('!! index.html 里找不到徽章标记，先手工放一对\n%s\n%s'
                         % (BEGIN, END))

    block, items, facts = build_badges()
    print('算出来的徽章（%d 个）：' % len(items))
    for cls, text, tip in items:
        print('   [%-2s] %s' % (cls or '-', text))
    print('正文可引用的实算值：' + '、'.join(
        '%s=%s' % (k, v) for k, v in sorted(facts.items())))

    i = html.index(BEGIN)
    j = html.index(END) + len(END)
    old = html[i:j]
    #  ⚠ 写回的是 **`html[:i] + block + html[j:]`**，不是替换过 {{TOKEN}} 的那份。
    #  踩过一次：早先直接写 want，第一次跑完正文里的 {{TESTS}} 就变成了"334"
    #  这个字面量，于是**第二次运行再也刷不动正文**（substitute 找不到标记、
    #  不报错，页面静静地停留在旧数字上）。保留标记，正文才能真正跟着实算走；
    #  而徽章块是物化的，所以单看文件它本身就是个能打开的成品页。
    new_url = html[:i] + block + html[j:]
    #  两边都用**同一套 facts** 替换后再比 —— 这样比的是"要不要重写"，
    #  而不是"标记还在不在"。substitute() 同时充当守卫：哪个标记没有实算值，
    #  这里就抛错，构建停下来。
    want = substitute(new_url, facts)
    have = substitute(html, facts)
    #  两种比对口径，**故意不一样**：
    #   · 核对（--check）用 comparable()：把"本机才测得到"的徽章（exe 体积）摘掉，
    #     否则 CI 上算出 8 枚、页面里存着 9 枚，永远不等；
    #   · 写入用严格相等：exe 徽章也在比。不这样的话，exe 重建后它的体积/tooltip
    #     会**永远停在旧值**（踩过：tooltip 停在 10245209，而文件已是 10245857），
    #     因为那一行压根没参与比对。
    same_check = comparable(want) == comparable(have)
    same_write = want == have

    if a.check:
        if same_check:
            print('\n--check：页面与实算一致（徽章 %d 个 + 正文标记 %d 种）。'
                  % (len(items), len(facts)))
            return 0
        print('\n--check：**页面已过期**，跑 `python docs/make_badges.py` 重算。')
        if old.strip() != block.strip():
            print('--- 页面上现在写的徽章 ---')
            for ln in old.splitlines():
                if '<span' in ln:
                    print('   ' + ln.strip())
        return 1

    if same_write:
        print('\n页面已经是最新，未改动。')
        return 0
    io.open(INDEX, 'w', encoding='utf-8', newline='').write(new_url)
    marks = re.findall(r'\{\{\w+\}\}', new_url)
    print('\n已写入 %s（徽章物化；正文保留 %d 个标记 / %d 种，'
          % (os.path.relpath(INDEX, ROOT), len(marks), len(set(marks))))
    print('       每次跑本脚本按实算值替换它们，替换不了的标记会直接报错）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
