"""端到端参考值：同一批合成 Thermo 数据，跑**真实的桌面版链路**。

链路（全部调用 Isoclock2.0.py 里的原函数/原代码）：
    loaddata()（ele=0，Thermo）
    → instructure0 里那段窗口识别源码（按行号取出后原样 exec）
    → dataprocess()（切段、还原、写 Mean_Cps.csv / result_all.csv）

输入 CSV 的文本不写进 JSON，而是由**一条共享公式**在两侧各自生成：
    profile[i]  由 shape 决定（整数）
    y_j[i]      = W[j]*profile[i] + (W[j]%7)*((i*13+j*5)%9)      （整数）
    Time[i]     由整数运算排版成 d.dd，避免 %.2f 的进位差异
两侧生成的文本必须逐字节相同。

用法:
    python make_e2e_case.py
产出:
    src/e2e_case.json
"""

import csv
import hashlib
import io
import json
import os
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_data import load_legacy, Stub                    # noqa: E402
from make_window_case import extract_block                 # noqa: E402

LEGACY = os.path.join(os.path.dirname(HERE), "Isoclock2.0.py")
WORK = r"G:/Isoclock/_e2e"          # G 盘：C 盘只剩 2.7G，写文件容易被静默杀掉

ISONAME = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U']
WEIGHTS = [5, 1, 30, 2, 6, 200, 1500]

N = 1200
B0, B1, MULTI = 1.0, 5.0, 8
CTX = {"Q8": 0.05090, "R8": 0.05320, "S8": 0.01570,
       "P382": 0.05320, "Pbc": 0.84218, "Standard_age": 1062.0}
STANDARD_NAMES = {"NIST610": 1, "91500": 1}

# (文件名, 样品名(第一行冒号之前), shape)
# 顺序故意打乱（文件名尾号 6,1,3,5），好让 result_all.csv 的排序真正被检验：
#   Mean_Cps.csv    按 files_list 顺序（原实现不排序）
#   result_all.csv  按 No. 升序（原实现 sort(key=lambda x: x[0])）
FILES = [
    ("MAD-NEW_6.csv", "MAD-NEW", "two_plates"),
    ("NIST610_1.csv", "NIST610", "step"),
    ("91500_3.csv", "91500", "step"),
    ("MAD-NEW_5.csv", "MAD-NEW", "step"),
]


def profile_of(shape, n):
    """背景占前 25%，信号 25%-75%，之后回到背景。

    背景窗口是 1-5 秒 ≈ 第 50-250 点，必须落在背景平台内（<0.25n=300），
    否则阈值会被信号抬高，识别结果就没有代表性了。
    """
    p = [100] * n
    a, b = int(n * 0.25), int(n * 0.75)
    if shape == 'step':
        for i in range(n):
            p[i] = 100 if i < a else (9000 if i < b else 100)
    elif shape == 'two_plates':
        for i in range(n):
            if i < a:
                p[i] = 100
            elif i < int(n * 0.5):
                p[i] = 8000
            elif i < int(n * 0.6):
                p[i] = 100
            elif i < b:
                p[i] = 9000
            else:
                p[i] = 100
    else:
        raise ValueError(shape)
    return p


def col_of(j, shape, n):
    """第 j 个通道（0 基）。整数，两个语言算出来完全一样。"""
    prof = profile_of(shape, n)
    w = WEIGHTS[j]
    c = w % 7
    return [w * prof[i] + c * ((i * 13 + j * 5) % 9) for i in range(n)]


def time_text(i):
    """i*0.02 秒，用整数排版成 d.dd —— 避开 %.2f 的进位差异。"""
    t = i * 2
    return "%d.%02d" % (t // 100, t % 100)


def make_thermo_csv(sample_name, shape, n):
    """生成一个 Thermo 风格的 CSV 文本（CRLF）。"""
    lines = []
    lines.append("%s: synthetic test export" % sample_name)      # 第 1 行：样品名来源
    for k in range(1, 13):                                       # 第 2-13 行：仪器信息
        lines.append("Thermo Fisher iCAP  meta line %02d" % k)
    lines.append(",".join(ISONAME + ["Note"]))                   # 第 14 行：列名
    lines.append(",".join(["sec"] + ["cps"] * 7 + ["txt"]))      # 第 15 行：单位
    cols = [col_of(j, shape, n) for j in range(7)]
    for i in range(n):
        cells = [time_text(i)] + [str(cols[j][i]) for j in range(7)] + ["ok"]
        lines.append(",".join(cells))
    return "\r\n".join(lines) + "\r\n"


def repr_probes():
    """float -> Python repr 的探针表。

    逐字节比对前先单独验证浮点排版：CSV 里每个数都是 repr(float)，
    排版规则不一致会让"数值全对但字节不同"，届时要能一眼分清是哪一层的问题。
    指数/定点切换的边界（decpt>16、decpt<=-4）都要覆盖。
    """
    values = [
        0.0, -0.0, 1.0, -1.0, 0.1, 0.1 + 0.2, 1.0 / 3.0, 2.0 / 3.0,
        1e-4, 1e-5, 1e-7, 2.5e-4, 0.00012345, 12345.678, 123456789.123456,
        3.0, 100.0, 1000.0, 1e14, 1e15, 1e16, 1e17, 1e21, 1e22, 1e100,
        1.5e300, 5e-324, 1.7976931348623157e308, 2.2250738585072014e-308,
        9.999999999999999e22, -12345.678, 1e-3, 1e-2, 0.5, 1.25,
    ]
    out = []
    for v in values:
        out.append({"kind": "finite", "v": v, "r": repr(float(v))})
    for v, tag in ((float('nan'), 'nan'), (float('inf'), 'inf'),
                   (float('-inf'), '-inf')):
        out.append({"kind": tag, "r": repr(v)})
    return out


def sample_name_of(text):
    """对应 instructure0 1928-1937：第一行第 0 个字段按 ':' 切开取 [0]。"""
    rows = list(csv.reader(io.StringIO(text)))
    return str(rows[0][0]).split(':')[0]


def main():
    outdir = os.path.join(WORK, 'out')
    indir = os.path.join(WORK, 'in')
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(indir, exist_ok=True)
    os.makedirs(outdir, exist_ok=True)

    print('[1/5] 生成合成 Thermo 数据 ...')
    texts = {}
    for fname, sname, shape in FILES:
        texts[fname] = make_thermo_csv(sname, shape, N)
        with io.open(os.path.join(indir, fname), 'w', encoding='utf-8', newline='') as f:
            f.write(texts[fname])
    print('      %d 个文件 × %d 点' % (len(FILES), N))

    print('[2/5] 加载真实 Isoclock2.0.py + 取出窗口识别源码块 ...')
    mod = load_legacy()
    mod.ele = Stub(0)                     # 0 = Thermo
    mod.inputpath = indir
    mod.outputpath = outdir
    a, b, block = extract_block(LEGACY)
    body = '\n'.join(l[12:] if l.startswith(' ' * 12) else l for l in block)
    print('      窗口块：第 %d-%d 行' % (a, b))

    print('[3/5] 逐步执行桌面链路 ...')
    num = {}
    sampleslist = {}
    ti_last = None
    for fname, sname, shape in FILES:
        out = mod.loaddata(fname, ISONAME)
        x = np.asarray(out[0], dtype=float)
        ys = [np.asarray(v, dtype=float) for v in out[1:]]
        n = len(x)
        ti = (x[n - 1] - x[0]) / n
        ti_last = ti
        ns = {'np': np, 'name': fname, 'Numbers': n, 'x': x,
              'bcg_from': B0, 'bcg_to': B1, 'Timeinternal': ti,
              'multi': MULTI, 'num': num}
        for j, col in enumerate(ys):
            ns['y%d' % (j + 1)] = col
        exec(compile(body, '<legacy-window-block>', 'exec'), ns)
        num = ns['num']
        # 保存通道（dataprocess 会以 name+'_yN.npy' 读取）
        np.save(outdir + '//' + fname + '_x', x)
        for j, col in enumerate(ys):
            np.save(outdir + '//' + fname + '_y%d' % (j + 1), col)
        sampleslist[fname] = sample_name_of(texts[fname])
        print('      %-16s n=%-5d ti=%.8f  窗口=%s  样品=%s'
              % (fname, n, ti, num[fname], sampleslist[fname]))

    np.save(outdir + '//Time_setting', num)
    np.save(outdir + '//Coments', {})

    print('[4/5] 调用真实 dataprocess() ...')
    os.chdir(outdir)                       # dataprocess 用相对路径读 Time_setting.npy
    mod.sampleslist = sampleslist
    mod.Timeinternal = ti_last             # 全局量：最后一个文件的值
    mod.stdcor = Stub(0)                   # 0 = 标样做 Pb 校正
    mod.Pb207Corr = Stub(0)                # 0 = 207Pb 法
    mod.Standard_names = STANDARD_NAMES
    mod.Q8, mod.R8, mod.S8 = CTX['Q8'], CTX['R8'], CTX['S8']
    mod.P382, mod.Pbc = CTX['P382'], CTX['Pbc']
    mod.Standard_age = CTX['Standard_age']
    mod.dataprocess()

    mean_cps = io.open(os.path.join(outdir, 'Mean_Cps.csv'), encoding='utf-8',
                       newline='').read()
    result_all = io.open(os.path.join(outdir, 'result_all.csv'), encoding='utf-8',
                         newline='').read()
    print('      Mean_Cps.csv   %d 行 / %d 字节' % (mean_cps.count('\r\n'), len(mean_cps)))
    print('      result_all.csv %d 行 / %d 字节' % (result_all.count('\r\n'), len(result_all)))

    # 输入 CSV 的哈希：JS 侧生成的文本必须与这里逐字节相同，否则比对没有意义
    input_sha = {f: hashlib.sha256(texts[f].encode('utf-8')).hexdigest() for f, _, _ in FILES}

    print('[5/5] 写出 src/e2e_case.json ...')
    docs = {
        "meta": {
            "n": N, "weights": WEIGHTS, "isoname": ISONAME,
            "b0": B0, "b1": B1, "multi": MULTI,
            "stdcor": 0, "method": 0, "ele_index": 0,
            "ctx": CTX, "standard_names": sorted(STANDARD_NAMES.keys()),
            "python": sys.version.split()[0], "numpy": np.__version__,
            "window_block_lines": [a, b],
        },
        "files": [{"file": f, "sample": s, "shape": sh, "n": N} for f, s, sh in FILES],
        "order": [f for f, _, _ in FILES],
        "input_sha256": input_sha,
        "repr_probes": repr_probes(),
        "expected": {"Mean_Cps.csv": mean_cps, "result_all.csv": result_all},
    }
    path = os.path.join(HERE, 'src', 'e2e_case.json')
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(docs, f, ensure_ascii=False, indent=1)
    print('      -> src/e2e_case.json  (%.1f KB)' % (os.path.getsize(path) / 1024))
    shutil.rmtree(WORK, ignore_errors=True)
    print('完成。')


if __name__ == '__main__':
    main()
