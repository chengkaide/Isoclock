"""为 Thermo 读取器生成测试用例与 Python 参考值。

调用**真实的** `Isoclock2.0.py::loaddata`（ele=0，即 Thermo 分支）产生参考值，
覆盖几种形态：列齐 / 缺可选列 / 列序不同 / 表头区含注释行 / 缺必需列（应报错）。

用法:
    python make_thermo_case.py
产出:
    src/thermo_cases.json   用例的 CSV 原文 + Python 端结果
"""

import io
import json
import os
import csv
import shutil
import sys
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_data import load_legacy, Stub                     # noqa: E402

TMP = r"G:/Isoclock/_thermo_cases"      # 放 G 盘：C 盘只剩 2.7G，写文件容易被静默杀掉
N_DATA = 25

HEADER_LINES = 13                       # 列名行之前的行数


def build_csv(columns, data_rows, extra_header_lines=0, header_comment_at=None,
              data_comment_at=None, first_line=None):
    """按 Thermo 的真实结构拼一个 CSV 文本。

    columns 是 (列名, 取值列表) 的有序序列；data_rows 是数据行数。
    """
    head = list(first_line if first_line is not None else
                ["Sample %s: some instrument note" % "MAD-NEW-1"])
    # 前 12 行补足机器信息
    while len(head) < HEADER_LINES - extra_header_lines:
        head.append("Thermo Fisher / iCAP  meta %d" % len(head))
    if header_comment_at is not None:
        head.insert(header_comment_at, "# a comment line inside the header region")
    while len(head) < HEADER_LINES:
        head.append("meta padding %d" % len(head))

    lines = list(head)
    lines.append(",".join(c[0] for c in columns))                    # 第 14 行：列名
    lines.append(",".join("unit" for _ in columns))                  # 第 15 行：单位

    for r in range(data_rows):
        cells = []
        for _, vals in columns:
            v = vals[r % len(vals)]
            cells.append("%.6f" % v if isinstance(v, float) else str(v))
        lines.append(",".join(cells))
        if data_comment_at is not None and r == data_comment_at:
            lines.append("# comment inside the data region")
    return "\r\n".join(lines) + "\r\n"


def col_values(name, n, seed):
    rng = np.random.default_rng(seed)
    if name == 'Time':
        return [i * 0.02 for i in range(n)]
    if name == '202Hg':
        return [float(v) for v in rng.normal(120.0, 4.0, n)]
    base = {'204Pb': 30.0, '206Pb': 5.0e5, '207Pb': 3.0e4, '208Pb': 9.0e4,
            '232Th': 4.0e6, '238U': 3.0e7}.get(name, 1000.0)
    return [float(v) for v in rng.normal(base, base * 0.02, n)]


def make_case(name, col_names, **kw):
    n = N_DATA
    # 种子必须确定性：Python 的 hash(str) 每个进程都不同（PYTHONHASHSEED 随机化），
    # 用它会让每次生成的用例都不一样，测试就不可复现了。改用 crc32。
    columns = [(c, col_values(c, n, zlib.crc32((name + '/' + c).encode()) % (2 ** 31)))
               for c in col_names]
    return name, build_csv(columns, n, **kw)


def main():
    os.makedirs(TMP, exist_ok=True)
    os.makedirs(os.path.join(HERE, 'src'), exist_ok=True)

    os.path.abspath(HERE)
    ISONAME = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U']

    cases = []
    cases.append(make_case('full', ISONAME + ['extraCol'],
                           data_comment_at=7))
    cases.append(make_case('no_202Hg', [c for c in ISONAME if c != '202Hg']))
    cases.append(make_case('no_204Pb', [c for c in ISONAME if c != '204Pb']))
    cases.append(make_case('no_optional',
                           [c for c in ISONAME if c not in ('202Hg', '204Pb')]))
    cases.append(make_case('reordered',
                           ['Time', '238U', '232Th', '208Pb', '207Pb', '206Pb', '204Pb', '202Hg']))
    cases.append(make_case('header_comment', ISONAME, header_comment_at=5))
    cases.append(make_case('no_238U', [c for c in ISONAME if c != '238U']))

    print('[1/3] 加载真实的 Isoclock2.0.py ...')
    mod = load_legacy()
    mod.ele = Stub(0)                       # 0 = Thermo
    mod.inputpath = TMP
    print('      -> 已加载，ele=0（Thermo）')

    print('[2/3] 逐例调用真实 loaddata() ...')
    ref = {"meta": {"n_data": N_DATA, "header_lines": HEADER_LINES,
                    "isoname": ISONAME, "python": sys.version.split()[0],
                    "numpy": np.__version__},
           "cases": []}
    for cname, text in cases:
        fname = cname + '.csv'
        with io.open(os.path.join(TMP, fname), 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        rec = {"name": cname, "file": fname, "csv": text}
        try:
            out = mod.loaddata(fname, ISONAME)
            rec["error"] = None
            rec["channels"] = {}
            for key, arr in zip(
                    ("x", "y1", "y2", "y3", "y4", "y5", "y6", "y7"), out):
                a = np.asarray(arr, dtype=float)
                rec["channels"][key] = [None if np.isnan(v) else float(v)
                                        for v in a]
        except Exception as e:                                  # noqa: BLE001
            rec["error"] = type(e).__name__
            rec["channels"] = None
        ref["cases"].append(rec)
        tag = rec["error"] or ("%d 点 × %d 通道" % (len(rec["channels"]["x"]),
                                                   len(rec["channels"])))
        print('      %-16s -> %s' % (cname, tag))

    out_path = os.path.join(HERE, 'src', 'thermo_cases.json')
    with io.open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(ref, f, ensure_ascii=False, indent=1)
    print('[3/3] -> src/thermo_cases.json  (%.1f KB)'
          % (os.path.getsize(out_path) / 1024))

    shutil.rmtree(TMP, ignore_errors=True)
    print('完成。')


def sample_name_reference():
    """样品名提取的参考值。

    对应 instructure0 里 1928-1937 那 5 行：
        info = open(inputpath + '\\' + name)
        headreader = csv.reader(info)
        for j, row in enumerate(headreader):
            if j == 0:
                ss = str(row[0]); ss = ss.split(':'); sampleslist[name] = ss[0]

    规则：取第一行的**第 0 个 CSV 字段**（csv.reader 会正确处理引号），
    再按 ':' 切开取第一段。所以 `Sample MAD-NEW-1: note` 得到的是
    "Sample MAD-NEW-1" 而不是 MAD-NEW-1 —— 冒号前的任何字都会成为名字的一部分。
    用真实的 csv.reader 跑一遍，别靠猜。
    """
    first_lines = [
        'Sample MAD-NEW-1: some note',
        '91500: zircon standard',
        'NIST610',
        'MAD-NEW-3:',
        ': leading colon',
        '  spaced name  : note',
        '"quoted, with comma": note',
        '"has ""inner"" quotes": note',
        'Trailing:colon:again',
        '',
    ]
    out = []
    for line in first_lines:
        rows = list(csv.reader(io.StringIO(line + '\n')))
        field0 = str(rows[0][0]) if rows and rows[0] else ''
        out.append({"line": line, "field0": field0, "name": field0.split(':')[0]})
    return out


def merge_sample_names():
    """把样品名参考值并进 thermo_cases.json。"""
    path = os.path.join(HERE, 'src', 'thermo_cases.json')
    with io.open(path, encoding='utf-8') as f:
        ref = json.load(f)
    ref["sample_names"] = sample_name_reference()
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(ref, f, ensure_ascii=False, indent=1)
    print('已并入 %d 条样品名参考值。' % len(ref["sample_names"]))


if __name__ == '__main__':
    main()
    merge_sample_names()
