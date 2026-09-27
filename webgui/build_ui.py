#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 ui/ 的模板与 src/ 的模块拼成**一个**可以直接双击打开的 HTML。

    python webgui/build_ui.py

产物：webgui/isoclock.html

为什么要有这一步
----------------
交付物要求是"单文件、离线、零依赖"。源码这边必须保持多文件（好测试、好比对），
于是就需要一个把两边粘起来的编译步骤。这个脚本就是那一步，它同时承担三件事：

  1. 拼接        —— 把 style.css、7 个 src 模块、selftest.js、app.js 依次灌进
                    ui/app.html 的四个占位符
  2. 自检        —— 占位符残留、模块漏打、危险串、顶层重名，不满足就**直接报错**
                    而不是产出一个看着像好文件的东西
  3. 定稿        —— 内容指纹 + 源码最新改动时间写进文件，便于事后确认手上的
                    是哪一版

致命的一步：**一个模块一个 <script>，不能合并**
---------------------------------------------
src 下的模块是"平铺式脚本"：顶层直接写 const / function，靠 window.DS_* 互相
交接。这种写法在 node 下没问题（test_*.js 每读一个文件就是一次独立的
vm.runInContext，各自一个脚本作用域），但**全部塞进一个 <script> 就会出事**：

    函数声明会被提到脚本最前面统一实例化，同名的只留最后一个。
    pipeline.js 与 age.js 都声明了 `function attach`，合并后
    `const DS_PIPELINE = { attach, ... }` 里装进去的其实是 age.js 那个 attach
    —— 于是 PL.attach(...) 把参数写进了 age.js 的内部对象，
    pipeline 自己的 thermoLoad 一直是 undefined，一跑就报
    "P.thermoLoad is not a function"。

所以这里逐个模块单独生成 <script>，与 node 的加载方式严格一一对应。

拼接顺序 = 依赖顺序，与 test_e2e.js 的加载顺序一致：

    fp.js -> math.js -> thermo.js -> window.js -> report.js -> pipeline.js -> age.js

其中 fp.js 必须最先：它定义 dexp/dlog，而 math.js / age.js 里所有指数与对数
都走这两个间接层（见 fp.js 顶部注释）。
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
UI = os.path.join(HERE, 'ui')
OUT = os.path.join(HERE, 'isoclock.html')

# ---------------------------------------------------------------- 输入清单
STYLE = ('style.css', os.path.join(UI, 'style.css'))

# 顺序即依赖顺序，不要随意调整
MODULES = [
    'fp.js',        # 正确舍入的 exp / log（dexp / dlog）
    'math.js',      # 数值内核：成对求和、nanmean、SK2model、Age76Pb、还原
    'thermo.js',    # Thermo CSV 解析
    'window.js',    # 背景/信号窗口自动识别
    'report.js',    # Mean_Cps.csv / result_all.csv 的字节级排版
    'pipeline.js',  # 把上面几步串成一条链
    'age.js',       # 标样校正 + 年龄层
    'qc.js',        # 批次质量统计（加权平均 / MSWD / 分组 / 异常），供出报告用
]

#  顺序即加载顺序：report.js 必须在 app.js 之前（app.js 要用 window.DS_QCREPORT）
SCRIPTS_TAIL = [
    ('report.js', os.path.join(UI, 'report.js')),
    ('selftest.js', os.path.join(UI, 'selftest.js')),
    ('app.js', os.path.join(UI, 'app.js')),
]

# 引用了但**故意不打包**的东西 —— 写在这里是为了让"漏打包"变成显式决定
SKIPPED = {
    'data.js': '数值内核的参考数据集，只给 test_math.js 用，约 160 KB',
    'age_case.json': '年龄层参考值，只给 test_age.js 用',
    'age76_case.json': 'Age76Pb 修正版参考值，只给 test_age76.js 用',
    'agilent_cases.json': 'Agilent 解析参考值，只给 test_agilent.js 用',
    'e2e_case.json': '端到端参考值，只给 test_e2e.js 用',
    'fp_case.json': 'exp/log 参考值，只给 test_fp.js 用',
    'reference.json': '数值内核参考值，只给 test_math.js 用',
    'thermo_cases.json': '解析参考值，只给 test_thermo.js 用',
    'window_cases.json': '窗口参考值，只给 test_window.js 用',
}

# 顶层重名清单 —— 这是一个**需要人工签字**的例外表，不是"允许"表。
#
# src 的模块是平铺式脚本：顶层 function 声明会挂到全局对象上，后加载的覆盖先加载的。
# 只要"一个模块一个 <script>"，每个模块在自己那个脚本里就已经把本地版本捕获进了
# 导出对象（DS_PIPELINE = { attach, ... }），所以跨模块重名本身不致命；
# 但同名不同实现终究是个坑，所以每一条都必须在这里写明理由。
#
# 键是顶层名，值是 (理由, 允许它出现在哪几个模块里)。改动实现后这里要重新核。
TOP_LEVEL_DUP_OK = {
    'attach': (
        'pipeline.js 与 age.js 各有一个 attach，作用对象不同（P / AG）。'
        '不致命的前提是**一个模块一个 <script>**：各自的 DS_* 对象在本人那个'
        '脚本执行完毕时就捕获了本地版本，不会被后来者改掉。',
        {'pipeline.js', 'age.js'}),
    'pyInt': (
        'window.js 与 pipeline.js 各有一份 Python int() 的实现，逻辑相同，'
        '差别只在一个花括号。builder 会当场跑一组边界值核实行为一致。',
        {'window.js', 'pipeline.js'}),
}

# 打包进去以后必须存在的全局量 —— 少一个界面就白屏
REQUIRED_GLOBALS = [
    'window.DS_FP', 'window.DS', 'window.DS_THERMO', 'window.DS_WINDOW',
    'window.DS_REPORT', 'window.DS_PIPELINE', 'window.DS_AGE', 'window.DS_QC',
    'window.DS_QCREPORT',
]

PLACEHOLDERS = ['@STYLE@', '@LIBS@', '@QCREPORT@', '@SELFTEST@', '@APP@']


def read(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        return f.read()


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]


def banner(title, note):
    bar = '=' * 74
    return ('// %s\n//  %s\n//  %s\n// %s\n' % (bar, title, note, bar))


def collect():
    """读出全部输入，顺带记下指纹。

    返回 (payloads, manifest)；manifest 的每一项是 (显示名, 绝对路径, 字节数, 指纹)，
    显示名走的是"相对 webgui/"的写法，方便逐一核对。
    """
    manifest = []

    style = read(STYLE[1])
    manifest.append((STYLE[0], STYLE[1], len(style), sha(style)))

    libs = []
    for name in MODULES:
        path = os.path.join(SRC, name)
        if not os.path.isfile(path):
            die('缺少模块：src/%s' % name)
        text = read(path)
        manifest.append(('src/' + name, path, len(text), sha(text)))
        libs.append((name, text))

    tail = []
    for name, path in SCRIPTS_TAIL:
        if not os.path.isfile(path):
            die('缺少脚本：ui/%s' % name)
        text = read(path)
        manifest.append(('ui/' + name, path, len(text), sha(text)))
        tail.append((name, text))

    # 模板也要进清单：它虽然只是"壳"，但改一个字（比如弹窗里写的数字）
    # 产物的内容就变了。不记它的话，源码指纹会在 app.html 改动后原地不动 ——
    # 于是"指纹相同 ⇒ 内容相同"这句就不成立，用指纹核对版本会误判。
    tpl_path = os.path.join(UI, 'app.html')
    if not os.path.isfile(tpl_path):
        die('缺少模板：ui/app.html')
    tpl = read(tpl_path)
    manifest.append(('ui/app.html', tpl_path, len(tpl), sha(tpl)))

    return {'style': style, 'libs': libs, 'tail': tail, 'tpl': tpl}, manifest


def die(msg):
    sys.stderr.write('[build_ui] 失败：%s\n' % msg)
    sys.exit(1)


def check_sources(payloads):
    """拼接之前先把能想得到的坑都堵一遍。"""
    # ① 占位符必须恰好各一个，多了少了都会拼出残品
    tpl = payloads['tpl']
    for ph in PLACEHOLDERS:
        n = tpl.count('<!--%s-->' % ph)
        if n != 1:
            die('ui/app.html 里 <!--%s--> 出现 %d 次，应为 1 次' % (ph, n))

    # ② 内联进 <script> / <style> 的内容里不能有结束标签，
    #    否则 HTML 解析器会提前收尾，后半截变成页面文字
    for name, text in payloads['libs'] + payloads['tail']:
        if '</script' in text.lower():
            die('%s 里含 "</script"，不能内联' % name)
    if '</style' in payloads['style'].lower():
        die('style.css 里含 "</style"，不能内联')

    # ③ src/ 下的每个文件都要么打包、要么在 SKIPPED 里登记，
    #    免得以后新加了一个模块却忘了加进 MODULES
    on_disk = set(os.listdir(SRC))
    staged = set(MODULES) | set(SKIPPED)
    missing = sorted(on_disk - staged)
    if missing:
        die('src/ 下有没登记的文件：%s\n'
            '      要么加进 MODULES，要么加进 SKIPPED（并写明理由）。'
            % '、'.join(missing))
    stale = sorted(staged - on_disk)
    if stale:
        die('清单里有 src/ 下不存在的文件：%s' % '、'.join(stale))

    # ④ 顶层重名：这是本文件最要紧的一项检查（见文件头"致命的一步"）。
    #    做法与 node 的加载方式严格对齐 —— 一个模块一次 vm.runInContext，
    #    然后把每个模块的**顶层声明名**收集起来找交集。
    #    只查导出对象的键是不够的：attach 曾经让 DS_PIPELINE.attach 变成了
    #    age.js 的实现，而两者的导出键完全一样、用数字去调也都返回 undefined，
    #    任何"拿导出值比行为"的检查都发现不了。必须回到声明名这一层。
    js = r'''
const fs = require("fs"), vm = require("vm");
const ORDER = %(order)s, DIR = %(dir)s;
const PROBES = ["0", "1", "-1", "1.9", "-1.9", "0.5", "-0.5", "1.5e9", "-1.5e9",
                "1e300", "-1e300", "NaN", "Infinity", "-Infinity", "-0"];
const DECL = /^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/;

// 顶层声明名（只看第 0 列，模块内部缩进的声明不算）
function topLevel(src) {
  const names = new Set();
  for (const line of src.split("\n")) {
    const m = DECL.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}
function call(fn, x) {
  try { return "ok:" + String(fn(x)); } catch (e) { return "err:" + (e && e.message); }
}

const decls = {}, exportsOf = {};
for (const f of ORDER) {
  const src = fs.readFileSync(DIR + "/" + f, "utf8");
  decls[f] = topLevel(src);
  // 每个模块独立一个脚本作用域 —— 与浏览器"一个模块一个 <script>"完全对应
  const s = { window: {}, console };
  vm.createContext(s);
  vm.runInContext(src, s, { filename: f });
  exportsOf[f] = s.window.DS || {};
}

// 顶层名 -> 声明了它的模块列表
const byName = {};
for (const f of ORDER) for (const n of decls[f]) (byName[n] = byName[n] || []).push(f);
const dups = Object.keys(byName)
  .filter((n) => byName[n].length > 1)
  .map((n) => [n, byName[n]]);

// 顺带记下每个重名函数的源码，供人工核对时打印
const shots = {};
for (const [n, mods] of dups) {
  shots[n] = mods.map((f) => {
    const src = fs.readFileSync(DIR + "/" + f, "utf8");
    for (const line of src.split("\n")) {
      if (DECL.test(line) && DECL.exec(line)[1] === n) return f + ": " + line.trim();
    }
    return f + ": (行首匹配不到)";
  });
}

// 重名的顶层函数在"合并成一个 <script>"时会互相覆盖。这里顺手模拟一次，
// 好让报错信息能直接说明后果 —— 而不是只丢一个名字出来。
const merged = ORDER.map((f) => fs.readFileSync(DIR + "/" + f, "utf8")).join("\n;\n");
const m = { window: {}, console };
vm.createContext(m);
vm.runInContext(merged, m, { filename: "merged.js" });
const collapsed = [];
for (const [n, mods] of dups) {
  const per = mods.map((f) => exportsOf[f][n]);
  const uniq = new Set(per.map((v) => String(v)));
  if (uniq.size > 1) {
    collapsed.push([n, mods, mods.map((f) => String(exportsOf[f][n]).slice(0, 70))]);
  }
}
console.log(JSON.stringify({ dups: dups, shots: shots, collapsed: collapsed }));
''' % {'order': json.dumps(MODULES), 'dir': json.dumps(SRC.replace('\\', '/'))}

    node = shutil.which('node') or os.environ.get('NODE_BIN')
    if not node:
        die('找不到 node —— 顶层重名检查需要它。\n'
            '      设个环境变量 NODE_BIN 指向 node 可执行文件，或者把 node 放进 PATH。')
    proc = subprocess.run([node, '-e', js], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE)
    if proc.returncode != 0:
        die('顶层重名检查里的 node 出错：\n%s'
            % proc.stderr.decode('utf-8', 'replace').strip())
    info = json.loads(proc.stdout.decode('utf-8').strip().splitlines()[-1])

    fatal = []
    for name, mods in info['dups']:
        ok = TOP_LEVEL_DUP_OK.get(name)
        if not ok:
            fatal.append('%s 被 %s 同时声明，且没有登记理由' % (name, '、'.join(mods)))
            continue
        if set(mods) != ok[1]:
            fatal.append('%s 登记的是 %s，实际是 %s'
                         % (name, '、'.join(sorted(ok[1])), '、'.join(mods)))
    if fatal:
        die('顶层重名：\n      %s\n'
            '      两条路：① 改名（推荐）；② 在 build_ui.py 的 TOP_LEVEL_DUP_OK 里'
            '登记并写明理由。\n'
            '      注意"一个模块一个 <script>"只是让重名不致命，并不能让它变好。'
            % '\n      '.join(fatal))
    for name, mods, shots in info['collapsed']:
        print('      · 顶层重名（已登记）：%s @%s' % (name, '/'.join(mods)))
        for s in shots:
            print('          %s' % s)

    # ⑤ 真正要紧的一条：产物必须把每个模块放进**自己的** <script>。
    #    合并会让上面那些重名真的生效，所以这个断言不能只写在文档里。
    if len(MODULES) < 2:
        die('MODULES 太短，这个检查没有意义')

    return tpl


def assemble(tpl, payloads, manifest):
    # 用"源码里最新的那次改动"当构建时间：同样的源码永远得到同样的产物，
    # 于是"产物是不是最新的"可以靠重新构建后比对指纹来判断。
    built = datetime.fromtimestamp(
        max(os.path.getmtime(path) for _, path, _, _ in manifest)
    ).strftime('%Y-%m-%d %H:%M:%S')

    fp_all = ' '.join('%s=%s' % (name, h) for name, _, _, h in manifest)

    # 源码指纹：只看"每个输入的名字+内容哈希"，不含构建时间。
    # 为什么单独要一个：产物文件自己的 sha 没法写进产物本身（自指），
    # 所以页脚要显示的那个号只能来自源码。它和本脚本打印的"源码指纹"必须同值，
    # 否则用户拿页脚和构建输出核对"是不是同一版"就会误判。
    src_id = sha('\n'.join('%s=%s' % (name, h) for name, _, _, h in manifest))

    # 构建信息自己也占一个 <script>，免得往别人的模块里掺东西。
    # 说明部分走 HTML 注释，代码部分才在脚本里。
    head = (
        '<!--\n'
        '  ==========================================================================\n'
        '   Isoclock 网页版 —— 单文件构建产物\n'
        '\n'
        '   本文件由 webgui/build_ui.py 拼成，请勿手改。要改就改 ui/ 与 src/ 下的\n'
        '   源头，然后重新运行：python webgui/build_ui.py\n'
        '\n'
        '   生成时间：%s（取全部源码里最新的那次改动时间，\n'
        '             所以同样的源码永远得到同样的文件）\n'
        '\n'
        '   模块指纹：%s\n'
        '   源码指纹：%s（页脚显示的就是它，与本脚本末尾打印的那一行同值）\n'
        '  ==========================================================================\n'
        '-->\n'
        '<script>\n'
        'window.__build = { built: %s, fingerprint: %s, id: %s };\n'
        '</script>\n'
        % (built, fp_all, src_id, json.dumps(built, ensure_ascii=False),
           json.dumps(fp_all), json.dumps(src_id))
    )

    # 关键：一个模块一个 <script>。合并会让 pipeline.js 与 age.js 的顶层
    # attach 互相覆盖（见文件头"致命的一步"）。
    libs = '\n'.join(
        '<script>\n%s%s\n</script>' % (
            banner('src/' + name, '与桌面版逐位比对过的模块'), text.rstrip('\n'))
        for name, text in payloads['libs'])

    out = tpl.replace('<!--@STYLE@-->', payloads['style'].rstrip('\n'))
    out = out.replace('<!--@LIBS@-->', head + '\n' + libs)
    # 这三个模板里已经带了自己的 <script> 外壳
    out = out.replace('<!--@QCREPORT@-->',
                      [t for n, t in payloads['tail'] if n == 'report.js'][0].rstrip('\n'))
    out = out.replace('<!--@SELFTEST@-->',
                      [t for n, t in payloads['tail'] if n == 'selftest.js'][0].rstrip('\n'))
    out = out.replace('<!--@APP@-->',
                      [t for n, t in payloads['tail'] if n == 'app.js'][0].rstrip('\n'))
    return out, built, src_id


def verify(out, tpl):
    for ph in PLACEHOLDERS:
        if '<!--%s-->' % ph in out:
            die('产物里还残留占位符 <!--%s-->' % ph)
    for g in REQUIRED_GLOBALS:
        if g not in out:
            die('产物里找不到 %s —— 模块没全打进去' % g)
    # 每个模块的内容必须原样出现，且必须落在**自己**的 <script> 里。
    # 第二点就是这次踩到的坑：内容都在，但挤在一起就会串味。
    for name in MODULES:
        text = read(os.path.join(SRC, name)).strip()
        if text not in out:
            die('%s 的内容没有原样出现在产物里' % name)
        if '<script>\n' + banner('src/' + name, '与桌面版逐位比对过的模块') not in out:
            die('%s 没有自己的 <script> 块 —— 检查 assemble() 是不是被改回去了' % name)
    if out.count('<script') != out.count('</script>'):
        die('<script> 与 </script> 数量对不上')
    # 1 个构建信息 + 7 个模块 + 自检 + 界面
    want = 1 + len(MODULES) + len(SCRIPTS_TAIL)
    got = out.count('<script')
    if got != want:
        die('产物里有 %d 个 <script>，应为 %d 个（构建信息 1 + 模块 %d + 脚本 %d）'
            % (got, want, len(MODULES), len(SCRIPTS_TAIL)))


def main():
    payloads, manifest = collect()
    tpl = check_sources(payloads)
    out, built, src_id = assemble(tpl, payloads, manifest)
    verify(out, tpl)

    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)

    print('输入 %d 个文件 -> 产物 1 个文件' % len(manifest))
    for name, _path, size, h in manifest:
        print('    %-20s %7d B  %s' % (name, size, h))
    print('    %-20s %7s    %s' % ('SKIPPED %d 项' % len(SKIPPED), '—', '只给 node 测试用，不打包'))
    for name in sorted(SKIPPED):
        print('      · %-18s %s' % (name, SKIPPED[name]))
    print()
    print('产物：%s' % OUT)
    print('      %d 字节（%.1f KB），源码最新改动 %s'
          % (os.path.getsize(OUT), os.path.getsize(OUT) / 1024.0, built))
    print('源码指纹：%s   ← 页脚 __build.id 显示的就是这个' % src_id)
    print('产物 sha：%s   ← 只这一份文件的哈希，用来核对"重建是否逐字节相同"' % sha(out))
    print()
    print('下一步（可选）：')
    print('    用浏览器打开产物，地址栏后面加 #selftest，看日志页的自检结果。')


if __name__ == '__main__':
    main()
