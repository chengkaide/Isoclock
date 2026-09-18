"""为「积分窗口自动识别」生成测试用例与 Python 参考值。

参考值不是重写的，而是把 **Isoclock2.0.py 里 instructure0 那段 64 行源码原样取出来
exec**（首尾行有断言，错位就报错）。逻辑一个字没动，只换了执行位置 —— 这样才叫
"用原代码验证移植版"。

那段代码内部会用 y1..y7 重建 y8（`y8=[]` 后逐点求和），所以喂进去的是 7 个通道。

通道数据不写进 JSON，而是由**一条共享的整数公式**在两侧各自生成：
  profile[i]  由 shape 决定（整数）
  y_j[i] = W[j]*profile[i] + (W[j]%7)*((i*13+j*5)%9)/10.0
整数乘法与 /10.0 的 IEEE 除法在两个语言里逐位相同，而 1500 与 5 相差 300 倍，
使得 y8 的求和顺序会真正影响末位 —— 这就顺便验证了求和顺序。

用法:
    python make_window_case.py
产出:
    src/window_cases.json
"""

import io
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

LEGACY = os.path.join(os.path.dirname(HERE), "Isoclock2.0.py")

# instructure0（Thermo）里"由信号自动定积分窗口"的那一段，1 基闭区间
BLOCK_FIRST = '            b0=bcg_from'
BLOCK_LAST = '            else:num[name]=[Numbers,b0,b1,s1+1,s0-1]'

WEIGHTS = [5, 1, 30, 2, 6, 200, 1500]      # y1..y7（Hg202/204Pb/206Pb/207Pb/208Pb/232Th/238U）


def extract_block(path):
    lines = io.open(path, encoding='utf-8', newline='').read().replace('\r\n', '\n').split('\n')
    starts = [i for i, l in enumerate(lines) if l.rstrip() == BLOCK_FIRST]
    if len(starts) != 1:
        raise SystemExit('首行匹配到 %d 处（应为 1）：%r' % (len(starts), BLOCK_FIRST))
    i0 = starts[0]
    i1 = None
    for j in range(i0, len(lines)):
        if lines[j].rstrip() == BLOCK_LAST:
            i1 = j
            break
    if i1 is None:
        raise SystemExit('未找到末行：%r' % BLOCK_LAST)
    return i0 + 1, i1 + 1, lines[i0:i1 + 1]


def profile_of(shape, n):
    """总信号轮廓（整数）。JS 侧必须算出完全一样的值。"""
    p = [100] * n
    if shape == 'flat':
        pass
    elif shape == 'step':
        for i in range(n):
            p[i] = 100 if i < int(n * 0.15) else (9000 if i < int(n * 0.75) else 100)
    elif shape == 'two_plates':
        for i in range(n):
            if i < int(n * 0.2):
                p[i] = 100
            elif i < int(n * 0.4):
                p[i] = 8000
            elif i < int(n * 0.5):
                p[i] = 100
            elif i < int(n * 0.8):
                p[i] = 9000
            else:
                p[i] = 100
    elif shape == 'ramp':
        for i in range(n):
            p[i] = 100 + (i * 8900) // (n - 1) if n > 1 else 100
    elif shape == 'spike':
        p = [100] * n
        p[n // 2] = 900000
    else:
        raise ValueError(shape)
    return p


def channels_of(shape, n):
    """7 个通道。返回 list of list（y1..y7），元素是 float。"""
    prof = profile_of(shape, n)
    out = []
    for j, w in enumerate(WEIGHTS):
        c = (w % 7)
        col = [float(w * prof[i] + c * ((i * 13 + j * 5) % 9) / 10.0) for i in range(n)]
        out.append(col)
    return out


CASES = [
    # (名字, shape, n, b0, b1, timeinternal, multi)
    # n 用 2000：真实 Thermo 文件是几千点，timeinternal≈0.02s，
    # 背景窗口 1-5s 才落在开头那段背景平台上；用 200 点会让窗口跑到信号区，
    # 大部分用例就只会走 except 兜底，失去分辨力。
    ('normal_step',        'step',       2000,  1.0,  5.0,  0.02,  8),
    ('two_plates',         'two_plates', 2000,  1.0,  5.0,  0.02,  8),
    ('single_crossing',    'step',       2000,  1.0,  2.0,  0.02,  8),
    ('flat_no_crossing',   'flat',       2000,  1.0,  5.0,  0.02,  8),
    ('huge_multi',         'step',       2000,  1.0,  5.0,  0.02,  500),
    ('ramp',               'ramp',       2000,  1.0,  5.0,  0.02,  8),
    ('spike',              'spike',      2000,  1.0,  5.0,  0.02,  8),
    ('bg_window_wide',     'step',       2000,  1.0, 30.0,  0.02,  8),   # b1/ti 很大 -> 走 starts[posi+1]
    ('bg_window_reversed', 'step',       2000,  5.0,  1.0,  0.02,  8),
    ('bg_window_empty',    'step',       2000,  3.0,  3.0,  0.02,  8),
    ('bg_beyond_data',     'step',       2000, 50.0, 60.0,  0.02,  8),
    ('sig_starts_early',   'step',        120,  1.6,  1.9,  0.02,  8),
    ('neg_timeinternal',   'step',       2000,  1.0,  5.0, -0.02,  8),
    ('big_timeinternal',   'step',       2000,  1.0,  5.0,  0.5,   8),
    ('short_series',       'step',         30,  1.0,  5.0,  0.02,  8),
    ('zero_timeinternal',  'step',       2000,  1.0,  5.0,  0.0,   8),
]


def main():
    print('[1/3] 从 Isoclock2.0.py 取窗口识别源码块 ...')
    a, b, block = extract_block(LEGACY)
    print('      行 %d-%d（%d 行），首尾行已校验' % (a, b, b - a + 1))
    body = '\n'.join(l[12:] if l.startswith(' ' * 12) else l for l in block)

    print('[2/3] 逐例执行原代码（用 y1..y7 喂入，块内部自己重建 y8）...')
    out = []
    for (name, shape, n, b0, b1, ti, multi) in CASES:
        chans = channels_of(shape, n)
        ns = {
            'np': np, 'name': name + '.csv', 'Numbers': n, 'x': [0.0] * n,
            'bcg_from': b0, 'bcg_to': b1, 'Timeinternal': ti, 'multi': multi,
            'num': {},
        }
        for j, col in enumerate(chans):
            ns['y%d' % (j + 1)] = col
        err = None
        try:
            exec(compile(body, '<legacy-window-block>', 'exec'), ns)
        except BaseException as e:                        # noqa: BLE001
            err = '%s: %s' % (type(e).__name__, e)
        key = name + '.csv'
        rec = {
            "name": name, "shape": shape, "n": n,
            "b0": b0, "b1": b1, "timeinternal": ti, "multi": multi,
            "error": err,
            "num": ns['num'].get(key),
        }
        out.append(rec)
        print('      %-20s -> %s' % (name, rec['num'] if rec['num'] is not None else err))

    docs = {
        "meta": {
            "source_block_lines": [a, b],
            "weights": WEIGHTS,
            "python": sys.version.split()[0],
            "numpy": np.__version__,
        },
        "cases": out,
    }
    path = os.path.join(HERE, 'src', 'window_cases.json')
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(docs, f, ensure_ascii=False, indent=1)
    print('[3/3] -> src/window_cases.json  (%.1f KB)'
          % (os.path.getsize(path) / 1024))
    print('完成。')


if __name__ == '__main__':
    main()
