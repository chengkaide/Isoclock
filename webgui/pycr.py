"""正确舍入的 exp / log —— 参考值生成器的 Python 侧定义。

为什么需要它
------------
原程序用的是宿主 C 运行时的 `math.exp` / `math.log`，而**不同运行时之间本来就
允许差 1 ULP**（实测：V8 的 Math.exp 与本机 MSVC 在约 9.5% 的自变量上不同；
连"正确舍入"两边的实现都各做不到 0.5% 左右）。

如果参考值用宿主实现、网页版用自己的实现，"逐位一致"就是不可能达成的目标，
验收只能退化成"容差比对"。所以两边都改成**正确舍入**的定义：一个自变量只有
唯一一个正确答案，任何平台、任何时间都得到同一串数字。

    · 网页版：webgui/src/fp.js（double-double 算术 + 泰勒/级数，已用本模块
      在 6.5 万个点上验证为正确舍入）
    · 参考值：本模块（直接调 decimal 以 60 位有效数字算，再舍入到 double）

用法
----
    import pycr
    pycr.install(mod)       # 把 mod.exp / mod.log 换成正确舍入版本
    pycr.cr_exp(x)          # 直接调用
"""

import math
from decimal import Decimal, getcontext

getcontext().prec = 60

_cache = {}


def cr_exp(x):
    """正确舍入的 exp。x 为 NaN / ±Inf 时与 math.exp 行为一致。"""
    x = float(x)
    if math.isnan(x):
        return math.nan
    if x == math.inf:
        return math.inf
    if x == -math.inf:
        return 0.0
    key = ("e", x)
    v = _cache.get(key)
    if v is None:
        try:
            v = float(Decimal(x).exp())
        except (OverflowError, ValueError):
            v = math.exp(x)                     # 溢出等边界退回宿主
        _cache[key] = v
    return v


def cr_log(x):
    """正确舍入的 log。x <= 0 时与 math.log 一样抛 ValueError。"""
    x = float(x)
    if math.isnan(x) or x <= 0:
        return math.log(x)                      # 交给宿主抛 ValueError / 返回 -inf
    key = ("l", x)
    v = _cache.get(key)
    if v is None:
        v = float(Decimal(x).ln())
        _cache[key] = v
    return v


def install(mod):
    """把模块全局里的 exp / log 换成正确舍入版本。

    原代码是 `from math import *`，所以 `exp` / `log` 是模块字典里的两个名字，
    函数体里读的就是它们 —— 换掉这两个就够了。
    """
    mod.exp = cr_exp
    mod.log = cr_log
    return mod


def selfcheck(pairs_exp, pairs_log):
    """给定 {(自变量, 结果)} 直接核对；返回 (错的数量, 前几个例子)。

    这里比对的对象是宿主实现，用来量"宿主离正确舍入有多远"。"""
    bad = []
    for x, r in pairs_exp:
        if cr_exp(x) != r:
            bad.append(("exp", x, r, cr_exp(x)))
    for x, r in pairs_log:
        if x > 0 and cr_log(x) != r:
            bad.append(("log", x, r, cr_log(x)))
    return bad
