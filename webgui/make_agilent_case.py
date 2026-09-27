"""为 Agilent 读取器生成测试用例与 Python 参考值。

调用**真实的** `Isoclock2.0.py::_load_agilent`（重构版 loaddata 的 mode 1 内核）
产生参考值，覆盖三种形态：
    A  列名行在原始第 4 行（skiprows=3），列全
    B  列名行在原始第 3 行（skiprows=2），列全
    C  缺 202/204 列（应补零）、缺 232 列（应补零并提示 '232Th Not found!'）

用法:
    python make_agilent_case.py
产出:
    src/agilent_cases.json   用例的 CSV 原文 + Python 端结果（hex 浮点）
"""

import io
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_data import load_legacy, Stub, install_stubs        # noqa: E402

TMP = r"G:/Isoclock/_agilent_cases"
N = 20
ISONAME = ['时间 [s]', '202', '204', '206', '207', '208', '232', '238']


def hexf(v):
    """float64 的 16 进制表示（NaN/Inf 也能表达），用于逐位比对。"""
    return struct.pack('>d', float(v)).hex()


def value(col, i):
    """确定性的伪数据：各列量级不同，带小数，逼出解析差异。"""
    return (col + 1) * 1000.0 + i * 0.25 + math.sin(col * 7 + i * 3) * 0.125


def build_csv(cols, lead_lines):
    """cols: [(列名, 取值函数列号)]；lead_lines: 列名行之前的行数。"""
    lines = ['batch note line %d' % (k + 1) for k in range(lead_lines)]
    lines.append(','.join(name for name, _ in cols))
    lines.append(','.join('cps' for _ in cols))
    for i in range(N):
        lines.append(','.join(repr(value(cid, i)) for _, cid in cols))
    return '\r\n'.join(lines) + '\r\n'


def main():
    os.makedirs(TMP, exist_ok=True)
    mod = load_legacy()
    install_stubs()

    full = [('时间 [s]', 0), ('202', 1), ('204Pb', 2), ('206Pb', 3),
            ('207Pb', 4), ('208Pb', 5), ('232Th', 6), ('238U', 7), ('extra', 8)]
    nohg = [c for c in full if c[1] not in (1, 2)]          # 缺 202 / 204
    noth = [c for c in full if c[1] != 6]                   # 缺 232

    cases = []
    for name, cols, lead in [
        ('A_skip3', full, 3),
        ('B_skip2', full, 2),
        ('C_nohg', nohg, 3),
        ('D_noth', noth, 3),
    ]:
        skip = lead                       # _load_agilent 的 skiprows = 列名行之前行数
        text = build_csv(cols, lead)
        path = os.path.join(TMP, name + '.csv')
        with io.open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write(text)
        x, y1, y2, y3, y4, y5, y6, y7 = mod._load_agilent(path, ISONAME, skip)
        cases.append({
            'name': name,
            'csv': text,
            'isoname': ISONAME,
            'notes': ['232Th Not found!'] if name == 'D_noth' else [],
            'hex': {
                'x': [hexf(v) for v in x],
                'y1': [hexf(v) for v in y1],
                'y2': [hexf(v) for v in y2],
                'y3': [hexf(v) for v in y3],
                'y4': [hexf(v) for v in y4],
                'y5': [hexf(v) for v in y5],
                'y6': [hexf(v) for v in y6],
                'y7': [hexf(v) for v in y7],
            },
        })
        print('  %s: %d 点，y1[0]=%s y2[0]=%s' % (name, len(x), hexf(y1[0]), hexf(y2[0])))

    out = os.path.join(HERE, 'src', 'agilent_cases.json')
    with io.open(out, 'w', encoding='utf-8') as fh:
        json.dump(cases, fh, ensure_ascii=False, indent=1)
    print('写入 %s（%d 个用例）' % (out, len(cases)))


if __name__ == '__main__':
    main()
