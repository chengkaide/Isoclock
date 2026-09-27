"""为 age76PbFixed（Age76Pb 收敛修正版）生成 Python 参考值。

修正是补上循环体内缺失的 `Rap` 更新，其余运算顺序与原实现逐位对应。
exp/log 用 pycr 的正确舍入实现（与 JS 端 dexp/dlog 同一定义），
因此两侧可以逐位比对。

用法:
    python make_age76_case.py
产出:
    src/age76_case.json
"""

import io
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pycr                                               # noqa: E402


def age76_fixed(rap76):
    """与 src/math.js 的 age76PbFixed 同序实现（Rap 在循环体内更新）。"""
    Age = 0
    Tmin = 0.001
    Tmax = 4556
    N = 0
    if rap76 > 0.0460455:
        Tm = (Tmax + Tmin) / 2
        Rap = (pycr.cr_exp(0.00098485 * Tm) - 1) / (pycr.cr_exp(0.000155125 * Tm) - 1) / 137.818
        while abs(rap76 - Rap) > 0.00005 and N < 10:
            if Rap < rap76:
                Tmin = Tm
            else:
                Tmax = Tm
            Rapi = (pycr.cr_exp(0.00098485 * Tmin) - 1) / (pycr.cr_exp(0.000155125 * Tmin) - 1) / 137.818
            Raps = (pycr.cr_exp(0.00098485 * Tmax) - 1) / (pycr.cr_exp(0.000155125 * Tmax) - 1) / 137.818
            Tm = Tmin + (Tmax - Tmin) * (rap76 - Rapi) / (Raps - Rapi)
            Rap = (pycr.cr_exp(0.00098485 * Tm) - 1) / (pycr.cr_exp(0.000155125 * Tm) - 1) / 137.818
            Age = Tm
            N += 1
    return Age


def rap76(t):
    return (pycr.cr_exp(0.00098485 * t) - 1) / (pycr.cr_exp(0.000155125 * t) - 1) / 137.818


def age76_legacy(rap76v):
    """原实现（Rap 不更新），用于量化差异。"""
    Age = 0
    Tmin = 0.001
    Tmax = 4556
    N = 0
    if rap76v > 0.0460455:
        Tm = (Tmax + Tmin) / 2
        Rap = (pycr.cr_exp(0.00098485 * Tm) - 1) / (pycr.cr_exp(0.000155125 * Tm) - 1) / 137.818
        while abs(rap76v - Rap) > 0.00005 and N < 10:
            if Rap < rap76v:
                Tmin = Tm
            else:
                Tmax = Tm
            Rapi = (pycr.cr_exp(0.00098485 * Tmin) - 1) / (pycr.cr_exp(0.000155125 * Tmin) - 1) / 137.818
            Raps = (pycr.cr_exp(0.00098485 * Tmax) - 1) / (pycr.cr_exp(0.000155125 * Tmax) - 1) / 137.818
            Tm = Tmin + (Tmax - Tmin) * (rap76v - Rapi) / (Raps - Rapi)
            Age = Tm
            N += 1
    return Age


def hexf(v):
    return struct.pack('>d', float(v)).hex()


def main():
    cases = []
    # 真实年龄网格 1~4556 Ma（年龄 -> 比值 -> 反解），加阈值附近的边界值
    ts = [1.0 * i for i in range(1, 4556)]
    ts += [4556.0]
    args = [rap76(t) for t in ts]
    args += [0.0460455, 0.04604550001, 0.0460456, 0.046, 0.0, 1e-6]
    max_legacy_gap = 0.0
    for r in args:
        fixed = age76_fixed(r)
        try:
            legacy = age76_legacy(r)
        except ZeroDivisionError:
            # 原实现在极端自变量下 Raps==Rapi，除零崩溃 —— 这也是要修它的原因之一。
            # 参考值记 null，比对时跳过这一项。
            legacy = None
        if r > 0.0460455 and 1000 <= fixed <= 4556 and legacy is not None:
            max_legacy_gap = max(max_legacy_gap, abs(fixed - legacy))
        cases.append({'arg': hexf(r), 'fixed': hexf(fixed), 'legacy':
                      None if legacy is None else hexf(legacy)})

    out = os.path.join(HERE, 'src', 'age76_case.json')
    with io.open(out, 'w', encoding='utf-8') as fh:
        json.dump(cases, fh, indent=0)
    print('写入 %s（%d 个自变量）' % (out, len(cases)))
    print('修正版与原实现的最大差（0.1~4.556 Ga）：%.1f Ma' % max_legacy_gap)


if __name__ == '__main__':
    main()
