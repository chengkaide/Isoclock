"""年龄层参考值：把真实的 Age_Calculate_average() / Age_Calculate() 跑一遍，截下它们写盘的内容。

为什么这样取参考值
------------------
这两个函数把「读 result_all.csv / Mean_Cps.csv → 算 → 写 xls」揉在一起。与其把公式
抄一遍（那就成了"拿我的实现验证我的实现"），不如**直接调原函数**，再用一个假的
`xlwt.Workbook` 顶掉写盘那一步，把 `worksheet.write(row+1, col, ...)` 全部截下来。
截到的就是 .xls 里的真实内容，也是网页版要产出的东西。

输入来自哪
----------
result_all.csv / Mean_Cps.csv 由**已经逐字节验证过的**那条链产出：
    loaddata() → instructure0 的窗口识别 → dataprocess()
所以年龄层的输入本身就是真实数据，不是另外编的。

文件顺序
--------
故意打乱（尾号 4,1,5,2,3,6）。这会让 `Mean_Cps.csv` 的行序（files_list 顺序）与
`result_all.csv` 的行序（按 No. 升序）**不一致** —— 原实现的 204Pb / 208Pb 两条路径
按行号取 date_cps，于是取到了别的样品的计数。这是真实存在的行为，故意保留在用例里，
好让移植版必须照样复现。

用法:
    python make_age_case.py
产出:
    src/age_case.json
"""

import io
import json
import logging
import math
import os
import shutil
import sys
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import pycr                                                    # noqa: E402
from make_data import load_legacy, Stub                       # noqa: E402
from make_window_case import extract_block                    # noqa: E402
from make_e2e_case import (ISONAME, WEIGHTS, N, B0, B1, MULTI,  # noqa: E402
                           profile_of, time_text, sample_name_of)

LEGACY = os.path.join(os.path.dirname(HERE), "Isoclock2.0.py")
WORK = r"G:/Isoclock/_agecase"

# 顺序刻意打乱（按 No. 排出来是 1,2,3,4,5,6,7,8，与下面这个顺序不同）。
#   · 标样 91500 测两次 → result_all 里分成两组，线性法的 A/B 插值才真正生效
#   · NIST610 也测两次 → 原代码的 `date_all[14][NIST_STD][:]` 只有在标样出现
#     **多于一次**时才拿到 Series（只出现一次会退化成标量，`[:]` 直接 IndexError）
FILES = [
    ("MAD-NEW_8.csv", "MAD-NEW", "two_plates"),
    ("NIST610_1.csv", "NIST610", "step"),
    ("91500_5.csv", "91500", "step"),
    ("MAD-NEW_2.csv", "MAD-NEW", "step"),
    ("MAD-NEW_6.csv", "MAD-NEW", "two_plates"),
    ("NIST610_3.csv", "NIST610", "step"),
    ("91500_7.csv", "91500", "step"),
    ("MAD-NEW_4.csv", "MAD-NEW", "step"),
    # 只测了一次的 NIST612：用来覆盖 coefficient() 的另一个异常分支 ——
    # `date_all[14]['NIST612']` 只匹配一行时退化为标量，尾部的 `[:]` 直接抛
    # TypeError，被 except 吞掉后系数归零。现实里"顺手插一个标样"就会这样。
    ("NIST612_9.csv", "NIST612", "step"),
]

STANDARD = "91500"
STANDARD_NAMES = {"NIST610": 1, "91500": 1, "NIST612": 1}
COMMENTS = {f: "CMT-%s" % f.split("_")[1].split(".")[0] for f, _, _ in FILES}

LAM238 = 0.000000000155125
LAM235 = 0.00000000098485
LAM232 = 0.000000000049475


# --------------------------------------------------------------------------
#  合成 Thermo CSV
#
#  与 make_e2e_case 的生成器只差一点：**每个文件给每个通道一个固定倍数**。
#  不加这个倍数的话，所有样品的同位素比值完全一样（同一个 profile 只差一个
#  整数的零头），五条校正路径、八个样品的所有「比值」列会挤在同一批数字上，
#  用例就失去分辨力了。倍数由 (文件号, 通道号) 决定，两端各自实现同一条公式。
# --------------------------------------------------------------------------
def channel_weight(k, j):
    """(文件号, 通道号) -> 该通道的强度倍数。

    用 `(k*7 + j*11) % 13`：11 与 13 互质，所以固定 k 时 j=0..6 走遍 13 个不同余数；
    而不同 k 之间相差 7k，对 k=0..7 取模 13 互不相同 —— 于是**每个文件得到一组
    不同的倍数**，同位素比值也就各不相同。
    """
    return int(round(WEIGHTS[j] * (0.55 + 0.075 * ((k * 7 + j * 11) % 13))))


def col_of(k, j, shape, n):
    prof = profile_of(shape, n)
    w = channel_weight(k, j)
    c = w % 7
    return [w * prof[i] + c * ((i * 13 + j * 5) % 9) for i in range(n)]


def make_csv(sname, shape, n, k):
    lines = ["%s: synthetic test export" % sname]
    for i in range(1, 13):
        lines.append("Thermo Fisher iCAP  meta line %02d" % i)
    lines.append(",".join(ISONAME + ["Note"]))
    lines.append(",".join(["sec"] + ["cps"] * 7 + ["txt"]))
    cols = [col_of(k, j, shape, n) for j in range(7)]
    for i in range(n):
        cells = [time_text(i)] + [str(cols[j][i]) for j in range(7)] + ["ok"]
        lines.append(",".join(cells))
    return "\r\n".join(lines) + "\r\n"


# --------------------------------------------------------------------------
#  假 xlwt：把 worksheet.write 截下来
# --------------------------------------------------------------------------
class FakeSheet:
    def __init__(self):
        self.cells = {}

    def write(self, row, col, value):
        self.cells[(row, col)] = value


class FakeWorkbook:
    def __init__(self):
        self.sheets = {}

    def add_sheet(self, name, cell_overwrite_ok=False):
        ws = FakeSheet()
        self.sheets[name] = ws
        return ws

    def save(self, path):
        self.saved = path


# --------------------------------------------------------------------------
#  为什么参考值要出两份
#  --------------------
#  原程序用的是宿主 C 运行时的 exp/log，而**不同运行时之间本来就允许差 1 ULP**
#  （实测：V8 与 MSVC 在约 9.5% 的 exp 自变量上不同，连"正确舍入"它俩都各做不到
#  一小部分）。于是"网页版逐位等于桌面版"在用了宿主 exp/log 的前提下是不可能达成的。
#
#  所以这里出两份参考：
#      expected    —— 宿主 exp/log 下的真实桌面版输出（用于量"与桌面版差多少"）
#      expectedCR  —— 正确舍入 exp/log 下的输出（网页版用同一定义，于是可以逐位比）
#  网页版 fp.js 的实现已用 decimal 在 6.5 万个点上验证过是正确舍入的，
#  所以 expectedCR 与网页版之间只应剩"移植本身的错"。
# --------------------------------------------------------------------------
class ShowInfo:
    """记录 messagebox.showinfo 的内容 —— 用来发现被 except 吞掉的错误。"""

    def __init__(self):
        self.messages = []

    def __call__(self, title=None, message=None, **kw):
        self.messages.append((title, message))


class ErrorLog(logging.Handler):
    """收集 ERROR 及以上的日志 —— `logging.exception` 说明有异常被内部吞了。"""

    def __init__(self):
        super().__init__(level=logging.ERROR)
        self.records = []

    def emit(self, record):
        self.records.append("%s: %s" % (record.getMessage(), record.exc_text or ""))


# --------------------------------------------------------------------------
#  输入：跑真实链路产出 result_all.csv / Mean_Cps.csv
# --------------------------------------------------------------------------
CALTXT = {}


def cal_age(age):
    """Age_Calculate_* 依赖的 P382/a/b/c/Pbc（原 main() 内 Cal_age 的公式）。

    这里**只用来造输入**，不是被验证的对象；被验证的对象是 JS 移植版与原函数的比对。
    """
    a = np.exp(LAM238 * age * 1e6) - 1
    b = np.exp(LAM235 * age * 1e6) - 1
    c = np.exp(LAM232 * age * 1e6) - 1
    R8 = 15.628 - b * (9.735 / 137.818)
    Q8 = 18.700 - a * 9.735
    return {"P382": 1 / 137.818 * (b / a), "a": a, "b": b, "c": c,
            "Pbc": R8 / Q8, "R8": R8, "Q8": Q8,
            "S8": 38.630 - c * 36.837, "Standard_age": float(age)}


def build_inputs(mod):
    indir = os.path.join(WORK, "in")
    outdir = os.path.join(WORK, "out")
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(indir, exist_ok=True)
    os.makedirs(outdir, exist_ok=True)

    texts = {}
    for k, (fname, sname, shape) in enumerate(FILES):
        texts[fname] = make_csv(sname, shape, N, k)
        with io.open(os.path.join(indir, fname), "w", encoding="utf-8",
                     newline="") as f:
            f.write(texts[fname])

    mod.ele = Stub(0)
    mod.inputpath = indir
    mod.outputpath = outdir
    a, b, block = extract_block(LEGACY)
    body = "\n".join(l[12:] if l.startswith(" " * 12) else l for l in block)

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
        ns = {"np": np, "name": fname, "Numbers": n, "x": x,
              "bcg_from": B0, "bcg_to": B1, "Timeinternal": ti,
              "multi": MULTI, "num": num}
        for j, col in enumerate(ys):
            ns["y%d" % (j + 1)] = col
        exec(compile(body, "<legacy-window-block>", "exec"), ns)
        num = ns["num"]
        np.save(outdir + "//" + fname + "_x", x)
        for j, col in enumerate(ys):
            np.save(outdir + "//" + fname + "_y%d" % (j + 1), col)
        sampleslist[fname] = sample_name_of(texts[fname])

    np.save(outdir + "//Time_setting", num)

    os.chdir(outdir)
    mod.sampleslist = sampleslist
    mod.Timeinternal = ti_last
    mod.stdcor = Stub(0)
    mod.Pb207Corr = Stub(0)
    mod.Standard_names = STANDARD_NAMES
    ctx = cal_age(1062.0)
    # 原 main() 里 Cal_age() 一次性写进模块全局；年龄层两个函数都直接读它们
    mod.Q8, mod.R8, mod.S8 = ctx["Q8"], ctx["R8"], ctx["S8"]
    mod.P382, mod.Pbc = ctx["P382"], ctx["Pbc"]
    mod.a, mod.b, mod.c = ctx["a"], ctx["b"], ctx["c"]
    mod.Standard_age = ctx["Standard_age"]
    mod.dataprocess()

    np.save(outdir + "//Coments", COMMENTS)

    result_all = io.open(os.path.join(outdir, "result_all.csv"),
                         encoding="utf-8", newline="").read()
    mean_cps = io.open(os.path.join(outdir, "Mean_Cps.csv"),
                       encoding="utf-8", newline="").read()
    os.chdir(HERE)
    return outdir, result_all, mean_cps, ctx


def load_tables(outdir):
    """按原代码的 np.loadtxt 参数把两张表读成数组。"""
    ra = os.path.join(outdir, "result_all.csv")
    mc = os.path.join(outdir, "Mean_Cps.csv")
    name = np.loadtxt(ra, dtype=str, delimiter=",", skiprows=1, usecols=(2))
    for i in range(len(name)):
        name[i] = name[i].strip()
    fname = np.loadtxt(ra, dtype=str, delimiter=",", skiprows=1, usecols=(1))
    date = np.loadtxt(ra, delimiter=",", skiprows=1,
                      usecols=(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
                               18, 19, 20, 21, 22))
    cps = np.loadtxt(mc, delimiter=",", skiprows=1,
                     usecols=(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15))
    if date.ndim == 1:
        date = date.reshape(1, -1)
    if cps.ndim == 1:
        cps = cps.reshape(1, -1)
    return {
        "name": [str(v) for v in name],
        "fileName": [str(v) for v in fname],
        "dateAll": [[float(v) for v in row] for row in date.T],
        "dateCps": [[float(v) for v in row] for row in cps.T],
    }


# --------------------------------------------------------------------------
#  跑一次原函数，截下它写盘的内容
# --------------------------------------------------------------------------
_ORIG_EXP = None
_ORIG_LOG = None


def run_legacy(mod, algo, method, tables, params, excess_v, stan, nist,
               self_exp=False):
    global _ORIG_EXP, _ORIG_LOG
    if _ORIG_EXP is None:
        _ORIG_EXP, _ORIG_LOG = mod.exp, mod.log
    if self_exp:
        # 把模块全局的 exp/log 换成正确舍入版本 —— Age76Pb / SK2model /
        # Age_Calculate* 都直接读这两个全局名，所以这一换就够
        pycr.install(mod)
    else:
        mod.exp, mod.log = _ORIG_EXP, _ORIG_LOG

    sheet = FakeSheet()
    mod.xlwt.Workbook = lambda: _WB(sheet)
    mod.xlwt.XFStyle = lambda: types.SimpleNamespace(font=None)
    mod.xlwt.Font = lambda: types.SimpleNamespace()
    mod.var5 = Stub(excess_v * 100.0)
    mod.PbCorrS = Stub(method)
    # `standard` 是模块全局，按界面上"分馏校正用哪个标样"来设；默认 91500，
    # 但可以指向样品名（原界面允许），这时整批因子都会跟着变
    mod.standard = stan
    mod.Standard_names = STANDARD_NAMES
    mod.NIST_STD = None
    mod.age = params["age"]
    for k, v in params.items():
        setattr(mod, k, v)

    # NIST_STD 是函数内部通过对话框拿到的（askyesno -> askstring），所以桩函数
    # 必须把 nist 真的回出去；nist is None 表示用户在"是否算微量元素"上选了否。
    shown = ShowInfo()
    sys.modules["tkinter.messagebox"].showinfo = shown
    sys.modules["tkinter.messagebox"].askyesno = lambda *a, **k: nist is not None
    sys.modules["tkinter.simpledialog"].askstring = lambda *a, **k: nist

    errlog = ErrorLog()
    logging.getLogger().addHandler(errlog)

    cwd = os.getcwd()
    os.chdir(mod.outputpath)
    try:
        if algo == "avg":
            mod.Age_Calculate_average()
        else:
            mod.Age_Calculate()
    finally:
        os.chdir(cwd)
        logging.getLogger().removeHandler(errlog)

    rows = 0
    for (r, c) in sheet.cells:
        rows = max(rows, r)
    grid = [[None] * 51 for _ in range(rows)]
    for (r, c), v in sheet.cells.items():
        if r >= 1 and c < 51:
            grid[r - 1][c] = v
    return grid, shown.messages, errlog.records


class _WB:
    """一次性供应商：让 mod.xlwt.Workbook() 返回同一个 sheet 记录器。"""

    def __init__(self, sheet):
        self._sheet = sheet

    def add_sheet(self, name, cell_overwrite_ok=False):
        return self._sheet

    def save(self, path):
        pass


# --------------------------------------------------------------------------
#  JSON 编码（NaN / Infinity 不能出现在合法 JSON 里）
# --------------------------------------------------------------------------
def enc(v):
    if isinstance(v, str):
        return v
    if isinstance(v, (bool,)):
        return v
    if isinstance(v, (int, np.integer)):
        return int(v)
    f = float(v)
    if np.isnan(f):
        return "NaN"
    if np.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    return f


# --------------------------------------------------------------------------
#  用例清单
# --------------------------------------------------------------------------
def param_sets():
    """每条路径需要的那组普通铅参数（取界面上"直接输入同位素"的默认值）。

    待校正样品年龄统一取 100 Ma —— 这是 SK2model(age) 与 Cal204Pb 那两条路径用的初值。
    """
    p = cal_age(100.0)
    return {
        0: {"age": 100.0},
        1: {"age": 100.0,
            "Radioactive_Pb": 0.048015, "common_Pb": 0.842185},
        2: {"age": 100.0,
            "common_Pb206_208": 0.48240, "common_Pb207_208": 0.40628},
        3: {"age": 100.0,
            "common_Pb207_204": 15.6207, "common_Pb206_204": 18.5478},
        4: {"age": 100.0,
            "common_Pb207_204": 15.6207, "common_Pb206_204": 18.5478,
            "common_Pb208_204": p["S8"], "radioactiveS_Pb207_206": p["P382"]},
    }


def main():
    print("[1/5] 跑真实链路产出 result_all.csv / Mean_Cps.csv ...")
    mod = load_legacy()
    outdir, result_all, mean_cps, ctx = build_inputs(mod)
    tables = load_tables(outdir)
    n = len(tables["name"])
    print("      %d 行；result_all %d 字节，Mean_Cps %d 字节"
          % (n, len(result_all), len(mean_cps)))
    print("      result_all 行序：", tables["name"])
    print("      Mean_Cps  行序：", [f.split(".")[0] for f in _cps_order(outdir)])

    print("[2/5] 逐条路径跑原函数 ...")
    psets = param_sets()
    runs = []
    for method in range(5):
        for algo in ("avg", "lin"):
            runs.append({"tag": "%s-m%d" % (algo, method), "algo": algo,
                         "method": method, "excessV": 0.05,
                         "nist": "NIST610", "standard": STANDARD,
                         "params": psets[method]})
    # 追加：换 NIST 标样名（数据里没有 → 系数走 NaN 分支）、换 excess_V
    runs.append({"tag": "avg-m1-e0", "algo": "avg", "method": 1,
                 "excessV": 0.0, "nist": "NIST610", "standard": STANDARD,
                 "params": psets[1]})
    runs.append({"tag": "lin-m1-e15", "algo": "lin", "method": 1,
                 "excessV": 0.15, "nist": "NIST610", "standard": STANDARD,
                 "params": psets[1]})
    # 分馏校正的标样换成样品名（整批因子跟着变，且线性法的分组也变）
    runs.append({"tag": "avg-m2-otherstd", "algo": "avg", "method": 2,
                 "excessV": 0.05, "nist": "NIST610", "standard": "MAD-NEW",
                 "params": psets[2]})
    # ---- coefficient() 的四种取值情形 --------------------------------------
    # 名字在别名表里但整批一行都没有（数据里只有 NIST610/612/91500）
    runs.append({"tag": "avg-m0-nist614", "algo": "avg", "method": 0,
                 "excessV": 0.05, "nist": "NIST614", "standard": STANDARD,
                 "expectErr": "coefficient", "params": psets[0]})
    # 名字在别名表里且只匹配一行 -> pandas 返回标量 -> `[:]` 抛 IndexError
    runs.append({"tag": "avg-m0-nist612", "algo": "avg", "method": 0,
                 "excessV": 0.05, "nist": "NIST612", "standard": STANDARD,
                 "expectErr": "coefficient", "params": psets[0]})
    runs.append({"tag": "lin-m0-nist612", "algo": "lin", "method": 0,
                 "excessV": 0.05, "nist": "NIST612", "standard": STANDARD,
                 "expectErr": "coefficient", "params": psets[0]})
    # 名字根本不在别名表里 -> 直接走 else 分支，不抛异常
    runs.append({"tag": "lin-m0-noname", "algo": "lin", "method": 0,
                 "excessV": 0.05, "nist": "NoSuchStd", "standard": STANDARD,
                 "params": psets[0]})
    # 用户回答"不算微量元素" -> NIST_STD=None -> else 分支，系数全 0
    runs.append({"tag": "avg-m0-nonist", "algo": "avg", "method": 0,
                 "excessV": 0.05, "nist": None, "standard": STANDARD,
                 "params": psets[0]})
    runs.append({"tag": "lin-m0-nonist", "algo": "lin", "method": 0,
                 "excessV": 0.05, "nist": None, "standard": STANDARD,
                 "params": psets[0]})

    out = []
    for r in runs:
        grids = {}
        for label, self_exp in (("expected", False), ("expectedCR", True)):
            grid, msgs, errs = run_legacy(mod, r["algo"], r["method"], tables,
                                          r["params"], r["excessV"],
                                          r["standard"], r["nist"],
                                          self_exp=self_exp)
            if errs:
                # coefficient() 内部的异常是**被它自己吞掉**的（系数退回 0，函数
                # 照常完成并写盘），所以这种日志是预期内的；别的异常才是跑歪了。
                if r.get("expectErr") != "coefficient" or \
                        any("coefficient" not in e for e in errs):
                    raise SystemExit("!! %s 原函数内部抛异常：%s"
                                     % (r["tag"], errs[:1]))
            bad = [m for m in msgs if m[1] and "successful" not in str(m[1])]
            if bad:
                raise SystemExit("!! %s 原函数报错：%s" % (r["tag"], bad[:1]))
            if not grid:
                raise SystemExit("!! %s 没有产出任何行" % r["tag"])
            grid = [[enc(v) for v in row] for row in grid]
            if label == "expectedCR" and len(grid) != len(grids["expected"]):
                raise SystemExit("!! %s 两种 exp/log 下行数不同" % r["tag"])
            grids[label] = grid
        if r.get("expectErr"):
            print("      %-16s （预期内：coefficient() 抛异常后归零）" % r["tag"])
        grid = grids["expected"]
        print("      %-16s 行数 %d  首行前 6 列 %s"
              % (r["tag"], len(grid), [round(v, 6) if isinstance(v, float) else v
                                       for v in grid[0][:6]]))
        out.append({"tag": r["tag"], "algo": r["algo"], "method": r["method"],
                    "excessV": r["excessV"], "nist": r["nist"],
                    "standard": r["standard"], "params": r["params"],
                    "expected": grids["expected"],
                    "expectedCR": grids["expectedCR"]})

    print("[3/5] 自检用例健康度 ...")
    for r in out:
        assert r["expected"], "%s 没有产出任何行" % r["tag"]
        for key in ("expected", "expectedCR"):
            for row in r[key]:
                assert len(row) == 51, \
                    "%s[%s] 行宽 %d != 51" % (r["tag"], key, len(row))
        assert len(r["expected"]) == len(r["expectedCR"]), \
            "%s 两份参考行数不同" % r["tag"]
    # 两份参考必须真的不同，否则 expectedCR 没起到"去掉宿主 exp/log"的作用
    diff_runs = sum(1 for r in out if r["expected"] != r["expectedCR"])
    assert diff_runs > 0, "两份参考完全相同，说明 exp/log 根本没被替换掉"
    print("      两份参考在 %d/%d 次运行中有差异（exp/log 替换确实生效）"
          % (diff_runs, len(out)))

    # 用例必须有分辨力，否则"全部通过"说明不了什么
    base = [r for r in out if r["algo"] == "avg" and r["nist"] == "NIST610"
            and r["standard"] == STANDARD and r["excessV"] == 0.05]
    a68 = {r["method"]: [row[17] for row in r["expected"]] for r in base}
    r76 = [row[2] for row in base[0]["expected"]]
    print("      各行 206Pb/238U 年龄：", [round(v, 3) for v in a68[0]])
    print("      各行校正后 207Pb/206Pb：", [round(v, 5) for v in r76])
    assert len(set(a68[0])) == len(a68[0]), "所有样品的年龄完全一样，用例没有分辨力"
    # Age76Pb 有两个分支：比值 <= 0.0460455 直接返回 0，否则走 10 次割线迭代。
    # 两条都要覆盖到，所以既要有高于阈值的、也要有低于阈值的。
    assert max(r76) > 0.0460455, "207Pb/206Pb 全在阈值以下，Age76Pb 的迭代分支没被走到"
    assert min(r76) < 0.0460455, "207Pb/206Pb 全在阈值以上，Age76Pb 的平凡分支没被走到"
    # 三条未校正年龄列（字段 18-23）本来就与路径无关，真正区分的在 28-31 / 52-57
    # （写盘只取前 51 列，故 52-57 用内部全行判断 —— 这里改用写盘的 27-30）
    for m in range(1, 5):
        assert base[m]["expected"] != base[0]["expected"], \
            "方法 %d 与方法 0 的整行相同" % m
    for m in (2, 3, 4):
        assert base[m]["expected"] != base[1]["expected"], \
            "方法 %d 与方法 1 的整行相同" % m
    by_tag = {r["tag"]: r["expected"] for r in out}
    # 四种系数取值情形，前三种最终都必须让系数三列(47,48,49)归零：
    #   avg-m0-nist614  名字在别名表里但一行都没有 -> KeyError
    #   *-m0-nist612    名字在别名表里且只匹配一行 -> IndexError（标量上取 [:])
    #   lin-m0-noname   名字不在别名表里           -> else 分支
    #   *-m0-nonist     用户回答"不算微量元素"     -> NIST_STD=None
    for tag, ref_tag in (("avg-m0-nist614", "avg-m0"),
                         ("avg-m0-nist612", "avg-m0"),
                         ("lin-m0-nist612", "lin-m0"),
                         ("lin-m0-noname", "lin-m0"),
                         ("avg-m0-nonist", "avg-m0"),
                         ("lin-m0-nonist", "lin-m0")):
        row = by_tag[tag]
        assert all(v == 0 for rr in row for v in rr[47:50]), \
            "%s 的系数列没有归零" % tag
        assert row != by_tag[ref_tag], \
            "%s 与 %s 完全相同，分支没被区分" % (tag, ref_tag)
    # 行数：平均法逐行输出全部样品（含标样）；线性法每个非标样一行
    n_std = sum(1 for v in tables["name"] if v == STANDARD)
    n_sample = n - n_std
    for r in out:
        want = n if r["algo"] == "avg" else n_sample
        assert len(r["expected"]) == want, \
            "%s 行数 %d != 期望 %d" % (r["tag"], len(r["expected"]), want)
    print("      行数：平均法 %d 行，线性法 %d 行（标样 %d 行）"
          % (n, n_sample, n_std))
    # 线性法的插值因子必须真的不同（A != B），否则 SSB 没被走到
    lin1 = [r for r in out if r["tag"] == "lin-m1-e15"][0]
    avg1 = base[1]["expected"]
    lin1e = [r for r in out if r["tag"] == "lin-m1"][0]["expected"]
    assert avg1 != lin1e, "线性法与平均法结果相同，说明插值没生效"

    print("[4/5] 写 src/age_case.json ...")
    doc = {
        "meta": {
            "generated_by": "webgui/make_age_case.py",
            "numpy": np.__version__,
            "python": sys.version.split()[0],
            "lines": {"Age_Calculate_average": [244, 850],
                      "Age_Calculate": [852, 1298]},
            "files": [f for f, _, _ in FILES],
            "order_by_no": tables["fileName"],
            "b0": B0, "b1": B1, "multi": MULTI,
            "standardNames": sorted(STANDARD_NAMES.keys()),
            "ctx": ctx,
            "channelWeights": [[channel_weight(k, j) for j in range(7)]
                               for k in range(len(FILES))],
        },
        "tables": tables,
        "comments": COMMENTS,
        "resultAllCsv": result_all,
        "meanCpsCsv": mean_cps,
        "runs": out,
    }
    path = os.path.join(HERE, "src", "age_case.json")
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print("      -> src/age_case.json  (%.1f KB)" % (os.path.getsize(path) / 1024))
    print("[5/5] 完成。")
    shutil.rmtree(WORK, ignore_errors=True)


def _cps_order(outdir):
    """Mean_Cps.csv 的行序（原实现按 files_list 顺序写，这里还原出来用于打印）。"""
    rows = io.open(os.path.join(outdir, "Mean_Cps.csv"), encoding="utf-8",
                   newline="").read().split("\r\n")[1:]
    return [r.split(",")[0] for r in rows if r]


if __name__ == "__main__":
    main()
