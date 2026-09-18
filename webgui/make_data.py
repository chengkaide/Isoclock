"""为网页版生成测试数据与 Python 参考值。

这个脚本是「数值一致性」的证据来源：它在 Python 端调用**真实的**
`Isoclock2.0.py`（用 stub 顶掉 tkinter / xlwt 等），把结果写成 reference.json；
Node 端的 `test_math.js` 再拿 JS 移植版去比对。

因此这里**绝不能**复写一遍算法 —— 那样就成了「拿我的实现验证我的实现」。

用法:
    python make_data.py
产出:
    src/data.js       测试用通道数据（base64 编码的 float64，逐位无损）
    src/reference.json Python 端算出的参考值
"""

import base64
import importlib.util
import io
import json
import os
import struct
import sys
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, "src")
LEGACY = os.path.join(os.path.dirname(HERE), "Isoclock2.0.py")

CHANNELS = ("Hg202", "Hg204", "Pb206", "Pb207", "Pb208", "Th232", "U238")

# 背景 180 点 / 信号 540 点：总长 720，跨过 NumPy 成对求和的 128 分块边界多次
N_BG = 180
N_SIG = 540

# 每路样品的通道强度（cps）：背景弱、信号强，比值落在真实 LA-ICP-MS 范围内
LEVELS = (1e2, 3e1, 5e5, 3e4, 9e4, 4e6, 3e7)

# 样品名必须与软件显示一致，dataprocess 靠它判断是标样还是样品
SAMPLES = [
    ("NIST610_1.csv", "NIST610"),
    ("91500_3.csv", "91500"),
    ("MAD-NEW_5.csv", "MAD-NEW"),
]

METHODS = ["sample", "std207", "std_cal204", "std204", "std208"]


# --------------------------------------------------------------------------
#  加载真实的 Isoclock2.0.py
# --------------------------------------------------------------------------
class Stub:
    """冒充 Tk 变量，只提供 .get()。"""

    def __init__(self, value):
        self._v = value

    def get(self):
        return self._v


def install_stubs():
    """顶掉 GUI 与不装也能跑的第三方库。

    这里**无条件覆盖**，不能用 `if not hasattr(...)` —— 本机 G:\\Python39 自带
    真正的 tkinter，那个写法会让 messagebox 真去弹窗，在无头环境里把进程搞死。
    """
    for name in ("tkinter", "tkinter.messagebox", "tkinter.filedialog",
                 "tkinter.simpledialog", "tkinter.ttk", "xlwt", "xlrd"):
        m = types.ModuleType(name)
        for attr in ("askdirectory", "askopenfilename", "askstring", "askfloat",
                     "askyesno", "showinfo", "showerror", "askokcancel",
                     "Tk", "Frame", "Button", "Label", "Entry", "Canvas",
                     "Text", "Scrollbar", "Toplevel"):
            setattr(m, attr, lambda *a, **k: None)
        sys.modules[name] = m
    tk = sys.modules["tkinter"]
    tk.messagebox = sys.modules["tkinter.messagebox"]
    tk.filedialog = sys.modules["tkinter.filedialog"]
    tk.simpledialog = sys.modules["tkinter.simpledialog"]
    tk.ttk = sys.modules["tkinter.ttk"]


def load_legacy():
    install_stubs()
    spec = importlib.util.spec_from_file_location("isoclock_legacy", LEGACY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# --------------------------------------------------------------------------
#  合成数据
# --------------------------------------------------------------------------
def make_signal(rng, scale):
    """背景段 + 信号段，带计数统计噪声。"""
    bg = rng.normal(scale * 0.004, scale * 0.0008, N_BG)
    sig = rng.normal(scale, scale * 0.03, N_SIG)
    return np.ascontiguousarray(bg), np.ascontiguousarray(sig)


def build_dataset():
    """返回 {sample_key: {'<ch>_b': array, '<ch>_s': array}}。

    故意让不同样品有不同的实现强度与噪声，避免五条校正路径算出完全一样的比值
    （那样测试会失去分辨力）。
    """
    data = {}
    for k, (fname, sname) in enumerate(SAMPLES):
        rng = np.random.default_rng(20260918 + k)
        # 标样刻意做得更"干净"，样品加点离群点，好把 2σ 过滤真正走到
        jitter = 0.0 if k < 2 else 0.02
        ch = {}
        for ci, lv in enumerate(LEVELS):
            b, s = make_signal(rng, lv * (0.7 + 0.3 * k))
            if jitter:
                # 信号段与背景段各自抽下标 —— 两段长度不同，不能共用一个索引数组
                idx_s = rng.integers(0, s.size, size=max(3, s.size // 90))
                s = s.copy()
                s[idx_s] *= rng.uniform(1.5, 2.5, size=idx_s.size)
                idx_b = rng.integers(0, b.size, size=max(2, b.size // 60))
                b = b.copy()
                b[idx_b] *= rng.uniform(1.4, 2.0, size=idx_b.size)
            ch[CHANNELS[ci] + "_b"] = np.ascontiguousarray(b)
            ch[CHANNELS[ci] + "_s"] = np.ascontiguousarray(s)
        data[fname] = ch
    return data


def b64(arr):
    """float64 数组 -> base64（小端，与 JS DataView 一致）。"""
    return base64.b64encode(np.ascontiguousarray(arr, dtype="<f8").tobytes()).decode()


# --------------------------------------------------------------------------
#  参考值
# --------------------------------------------------------------------------
def primitive_references():
    """覆盖成对求和的三种分支：n<8 / 8<=n<=128 / n>128。"""
    rng = np.random.default_rng(4242)
    sizes = [1, 2, 5, 7, 8, 9, 16, 127, 128, 129, 200, 256, 257, 720, 1000]
    out = {"sum": [], "mean": [], "std": [], "average": []}
    for n in sizes:
        # 用跨度大的数，放大求和顺序的差异（1e8 与 1 相加会丢精度）
        x = rng.normal(0, 1, n) * (10.0 ** rng.integers(0, 9, n))
        out["sum"].append({"n": n, "x": x.tolist(), "v": float(np.sum(x))})
        out["mean"].append({"n": n, "x": x.tolist(), "v": float(np.mean(x))})
        out["std"].append({"n": n, "x": x.tolist(), "v": float(np.std(x))})
        out["average"].append({"n": n, "x": x.tolist(), "v": float(np.average(x))})

    # nan 版本：含 NaN 的数组，走 np.nanmean / np.nanstd 路径
    nan_cases = []
    for n in [8, 129, 720]:
        x = rng.normal(0, 1, n) * 1e6
        idx = rng.choice(n, size=max(1, n // 7), replace=False)
        x = x.copy()
        x[idx] = np.nan
        nan_cases.append({
            "n": n,
            "x": [None if np.isnan(v) else float(v) for v in x],
            "count_nonzero_isnan": int(np.count_nonzero(np.isnan(x))),
            "nanmean": float(np.nanmean(x)),
            "nanstd": float(np.nanstd(x)),
        })

    # 2σ 过滤 + (均值, 2 倍标准误)
    filt = []
    for n in [8, 129, 540]:
        x = rng.normal(1.0, 0.05, n)
        idx = rng.choice(n, size=max(1, n // 20), replace=False)
        x = x.copy()
        x[idx] *= rng.uniform(1.5, 3.0, size=idx.size)
        f = np.where(np.abs(x - np.average(x)) < 2.0 * np.std(x), x, np.nan)
        kept = f.size - np.count_nonzero(np.isnan(f))
        filt.append({
            "n": n,
            "x": x.tolist(),
            "filtered": [None if np.isnan(v) else float(v) for v in f],
            "kept": int(kept),
            "mean": float(np.nanmean(f)),
            "twosem": float(2.0 * np.nanstd(f) / np.sqrt(kept)),
        })

    return {"sum": out["sum"], "mean": out["mean"], "std": out["std"],
            "average": out["average"], "nan": nan_cases, "filter2s": filt}


def model_references(mod):
    ages = [0.0, 1.0, 100.0, 1062.0, 2000.0, 4560.0]
    sk = [{"age": a, "out": [float(v) for v in mod.SK2model(a)]} for a in ages]

    ratios = [0.046, 0.0460455, 0.0460456, 0.05, 0.058, 0.07, 0.1, 0.15, 0.2, 0.3]
    age76 = []
    for r in ratios:
        try:
            v = float(mod.Age76Pb(r))
            err = None
        except Exception as e:                      # noqa: BLE001 - 记录真实异常
            v, err = None, type(e).__name__
        age76.append({"r": r, "age": v, "error": err})

    # 从比值反解年龄的三条闭式公式（log1p 形式）
    lam = {"238": 1.55125e-10, "235": 9.8485e-10, "232": 4.9475e-11}
    conv = []
    for r in [0.01, 0.05, 0.1, 0.2, 0.5, 0.8, 0.95]:
        conv.append({
            "r": r,
            "pb206_u238": float(np.log(r + 1) / lam["238"] / 1e6),
            "pb207_u235": float(np.log(r + 1) / lam["235"] / 1e6),
            "pb208_th232": float(np.log(r + 1) / lam["232"] / 1e6),
        })
    return {"sk2model": sk, "age76": age76, "ratio_to_age": conv}


def reduction_references(mod, data):
    """调真实 reduce_sample，产出全部 5 条路径 × 3 路样品的 23 列。"""
    mod.ele = Stub(0)
    mod.sampleslist = {fname: sname for fname, sname in SAMPLES}
    mod.Q8, mod.R8, mod.S8 = 0.05090, 0.05320, 0.01570
    mod.P382, mod.Pbc, mod.Standard_age = 0.05320, 0.84218, 1062.0

    ctx = {"Q8": 0.05090, "R8": 0.05320, "S8": 0.01570,
           "P382": 0.05320, "Pbc": 0.84218, "Standard_age": 1062.0}

    out = {}
    for fname, _ in SAMPLES:
        ch = data[fname]
        sig = {}
        for key in CHANNELS:
            sig[key + "_b"] = ch[key + "_b"]
            sig[key + "_s"] = ch[key + "_s"]
        row = {}
        for m in METHODS:
            r = mod.reduce_sample(fname, sig, m, ctx)
            row[m] = [_jsonable(v) for v in r]
        out[fname] = row
    return {"ctx": ctx, "ele": 0, "rows": out}


def _jsonable(v):
    if isinstance(v, (int, str)):
        return v
    f = float(v)
    if np.isnan(f):
        return "NaN"
    if np.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    return f


def main():
    os.makedirs(SRC_DIR, exist_ok=True)

    print("[1/4] 合成通道数据 ...")
    data = build_dataset()

    print("[2/4] 加载真实的 Isoclock2.0.py ...")
    mod = load_legacy()
    print("      ->", os.path.basename(LEGACY), "已加载")

    print("[3/4] 计算参考值 ...")
    ref = {
        "meta": {
            "generated_by": "webgui/make_data.py",
            "numpy": np.__version__,
            "python": sys.version.split()[0],
            "n_bg": N_BG,
            "n_sig": N_SIG,
            "channels": list(CHANNELS),
            "samples": [list(s) for s in SAMPLES],
            "methods": METHODS,
        },
        "primitives": primitive_references(),
        "models": model_references(mod),
        "reduction": reduction_references(mod, data),
    }

    # 参考值的定义域
    for s in ref["primitives"]["filter2s"]:
        assert s["kept"] > 0, f"n={s['n']} 的 2σ 过滤把点全滤掉了，用例不健康"
    for fname in ref["reduction"]["rows"]:
        for m, row in ref["reduction"]["rows"][fname].items():
            assert len(row) == 23, f"{fname}/{m} 列数 {len(row)} != 23"

    with io.open(os.path.join(SRC_DIR, "reference.json"), "w",
                 encoding="utf-8", newline="\n") as f:
        json.dump(ref, f, ensure_ascii=False, indent=1, sort_keys=False)
    print("      -> src/reference.json")

    print("[4/4] 导出测试数据 ...")
    parts = ["// 由 webgui/make_data.py 生成，请勿手改。",
             "// 通道数据以 base64 编码的 float64（小端）存储，逐位无损。",
             "const ISO_DATA = {"]
    parts.append("  nBg: %d, nSig: %d," % (N_BG, N_SIG))
    parts.append("  channels: %s," % json.dumps(list(CHANNELS)))
    parts.append("  samples: [")
    for fname, sname in SAMPLES:
        parts.append("    { file: %s, name: %s, ch: {" % (json.dumps(fname), json.dumps(sname)))
        for key in CHANNELS:
            for phase in ("b", "s"):
                arr = data[fname][key + "_" + phase]
                parts.append("      %s: \"%s\"," % (key + "_" + phase, b64(arr)))
        # 两个右括号：先闭合 ch 对象，再闭合样品对象
        parts.append("    } },")
    parts.append("  ],")
    parts.append("};")
    parts.append("if (typeof window !== 'undefined') window.ISO_DATA = ISO_DATA;")
    parts.append("")
    text = "\n".join(parts)
    with io.open(os.path.join(SRC_DIR, "data.js"), "w",
                 encoding="utf-8", newline="\n") as f:
        f.write(text)
    size = os.path.getsize(os.path.join(SRC_DIR, "data.js"))
    print("      -> src/data.js  (%.1f KB)" % (size / 1024))
    print()
    print("完成。")


if __name__ == "__main__":
    main()
