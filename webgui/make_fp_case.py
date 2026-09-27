"""fp 用例：给 crExp / crLog 准备一批固定、可复现的自变量与正确舍入结果。

自变量覆盖本项目真正会出现的取值范围：
    exp  0.00098485·T / 0.000155125·T    T ∈ [0.001, 4560]   （Age76Pb 的割线迭代）
         0.155125·T/1000 等三种               同上           （SK2model）
         log(…) 的结果                        [0, 12]        （exp(λ·age·1e6) 那一族）
    log  1+r     r ∈ [1e-4, 12]                             （各条 age=ln(1+R)/λ）
         比值本身（1/r、R68 之类）        [1e-6, 1e4]
另加一些负值与极端值，确认边界行为也一致。

结果用 decimal（60 位有效数字）算出来再舍入到 double —— 那就是"正确舍入"的定义。
自变量与结果都存成 16 位十六进制，避免任何十进制文本转换引入歧义。

用法: python make_fp_case.py   ->  src/fp_case.json
"""

import io
import json
import os
import struct
import sys

import pycr

HERE = os.path.dirname(os.path.abspath(__file__))


def hx(x):
    return struct.pack(">d", float(x)).hex()


def grid_exp():
    out = []
    n = 1200
    for i in range(1, n + 1):
        t = 0.001 + (4560.0 - 0.001) * i / n
        out += [0.00098485 * t, 0.000155125 * t,
                0.155125 * t / 1000, 0.98485 * t / 1000, 0.049475 * t / 1000]
    out += [0.155125 * 3.7, 0.98485 * 3.7, 0.049475 * 3.7, 0.0, 1.0, -1.0]
    # exp(λ·age·1e6) 这一族：参数就是 log(...) 的结果，量级 0..12
    for i in range(0, 801):
        x = 12.0 * i / 800
        out += [x, -x]
    return out


def grid_log():
    out = []
    n = 700
    for i in range(0, n + 1):                       # 1+r，r ∈ [1e-4, 12]
        r = 1e-4 + (12.0 - 1e-4) * i / n
        out += [1.0 + r, 1.0 / (1.0 + r), r]
    for i in range(0, 401):                          # 比值本身，跨度大一些
        out.append(1e-6 * (10 ** (10.0 * i / 400)))
    out += [1.0, 2.0, 0.5, 1e300, 1e-300]
    return out


def main():
    exp_args = grid_exp()
    log_args = grid_log()
    doc = {
        "meta": {
            "generated_by": "webgui/make_fp_case.py",
            "python": sys.version.split()[0],
            "decimals": 60,
            "exp_count": len(exp_args),
            "log_count": len(log_args),
        },
        "exp": [[hx(x), hx(pycr.cr_exp(x))] for x in exp_args],
        "log": [[hx(x), hx(pycr.cr_log(x))] for x in log_args],
    }
    path = os.path.join(HERE, "src", "fp_case.json")
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, separators=(",", ":"))
    print("exp %d 个点 / log %d 个点 -> src/fp_case.json (%.1f KB)"
          % (len(exp_args), len(log_args), os.path.getsize(path) / 1024.0))


if __name__ == "__main__":
    main()
