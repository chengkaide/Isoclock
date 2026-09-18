/* ==========================================================================
 *  window.js —— 积分窗口的自动识别
 *                （对应 Isoclock2.0.py instructure0 里第 1853-1916 行）
 *
 *  这段代码是桌面版的默认行为：由总信号自动找样品信号的起止时间。网页版必须
 *  对齐它，否则同一批数据两边给出的默认窗口不同，结果就对不上，
 *  「两个实现相互对照」也就失去意义。
 *
 *  【原样保留，不顺手修】以下几处看着别扭，但都是既有行为：
 *
 *   1. 决定 s0/s1 的循环里 `posi=0` / `posj=0` 每次迭代都被重置，所以
 *      **只有 starts/ends 的最后一个元素起作用**，其余迭代白跑。
 *      看上去作者本想"逐段比较"，但实际不是。改掉会改变所有既有结果。
 *   2. 落进 except 时固定 s0=30 / s1=60。
 *   3. `bcg_s=int(b0/Timeinternal)` 在 try 之外，Timeinternal 为 0 时抛
 *      ZeroDivisionError 且不被捕获 —— 也就是程序会直接崩，不会走默认窗口。
 *   4. y8 是块内自己重建的（`y8=[]` 后逐点 Y1+...+Y7），所以喂进来的是 7 个通道。
 * ========================================================================== */
'use strict';

/**
 * Python 的 int()：截断向零，不是向下取整。
 * int(-1.7) === -1（Math.floor(-1.7) === -2 是错的）。
 */
function pyInt(v) {
  if (!Number.isFinite(v)) {
    // Python 里 int(nan) 抛 ValueError、int(inf) 抛 OverflowError
    throw new Error('cannot convert ' + v + ' to int');
  }
  return Math.trunc(v);
}

/**
 * Python 的 arr[start:stop] 索引归一化（支持负数、越界钳制）。
 * 返回 [s, e)，e <= s 时为空切片。
 */
function pySliceBounds(len, start, stop) {
  let s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let e = stop < 0 ? Math.max(len + stop, 0) : Math.min(stop, len);
  if (e < s) e = s;
  return [s, e];
}

/** 供依赖注入的数值层（默认用 math.js 的成对求和实现）。 */
let NUM = null;
function num() {
  if (NUM) return NUM;
  if (typeof window !== 'undefined' && window.DS) return (NUM = window.DS);
  throw new Error('window.js 需要一个数值层：先载入 math.js，或用 setNumeric() 注入');
}
function setNumeric(n) { NUM = n; }

/**
 * 由 7 个通道算出 y8[i] = y1[i]+y2[i]+y3[i]+y4[i]+y5[i]+y6[i]+y7[i]。
 * 加法顺序原样保留（左到右），不做任何重排 —— 浮点加法不满足结合律。
 */
function buildY8(channels) {
  const n = channels[0].length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = channels[0][i] + channels[1][i] + channels[2][i] + channels[3][i]
      + channels[4][i] + channels[5][i] + channels[6][i];
  }
  return out;
}

/**
 * 对应 instructure0 那 64 行。返回 { num, error }。
 *
 * @param {object} cfg
 *   n           Numbers = len(x)
 *   channels    [y1..y7]，每个是 Float64Array
 *   b0, b1      背景窗口（秒）= bcg_from / bcg_to
 *   timeinternal Timeinternal
 *   multi       multi
 */
function detectSignalWindow(cfg) {
  const N = num();
  const channels = cfg.channels;
  const n = cfg.n;

  // ---- b0/b1 与窗口下标（在 try 之外，异常不被吞掉）----
  const b0 = cfg.b0;
  const b1 = cfg.b1;
  const bcgS = pyInt(b0 / cfg.timeinternal);       // ZeroDivisionError 在此处外泄
  const bcgE = pyInt(b1 / cfg.timeinternal);

  // ---- y8 重建 ----
  const y8 = buildY8(channels);

  // ---- signal_bcg = np.array(y8)[bcg_s:bcg_e] ----
  const [s, e] = pySliceBounds(n, bcgS, bcgE);
  const segLen = e - s;
  const seg = new Float64Array(segLen);
  for (let i = 0; i < segLen; i++) seg[i] = y8[s + i];

  // ---- np.where(|seg-avg| < 2*std, seg, avg) ----
  // 注意 avg 与 std 都取自**未过滤**的那一段
  const avg = segLen === 0 ? NaN : N.nmean(seg);
  const sd = segLen === 0 ? NaN : N.nstd(seg);
  const filtered = new Float64Array(segLen);
  for (let i = 0; i < segLen; i++) {
    filtered[i] = Math.abs(seg[i] - avg) < 2.0 * sd ? seg[i] : avg;
  }

  // ---- bcg = filtered.mean()  ;  std = np.std(y8[bcg_s:bcg_e])（未过滤）----
  const bcg = segLen === 0 ? NaN : N.nmean(filtered);
  const std = segLen === 0 ? NaN : N.nstd(seg);
  const sdmul = cfg.multi;
  const thr = bcg + sdmul * std;

  // ---- 阈值穿越点 ----
  const ind = new Uint8Array(n);
  for (let i = 0; i < n; i++) ind[i] = y8[i] > thr ? 1 : 0;
  const index = [];
  for (let i = 0; i < n; i++) {
    const next = (i + 1 < n) ? ind[i + 1] : 0;   // ind2 = ind[1:] + [False]
    if (ind[i] !== next) index.push(i);
  }
  const starts = [];
  const ends = [];
  for (let i = 0; i < index.length; i++) {
    (i % 2 === 0 ? starts : ends).push(index[i]);
  }

  // ---- 定 s0 / s1（原实现的 posi=0 重置行为原样保留）----
  let s0, s1;
  try {
    if (ends.length > 1 && starts.length > 1) {
      for (let i = 0; i < starts.length; i++) {
        const posi = 0;
        if (starts[i] < b1 / cfg.timeinternal) {
          if (posi + 1 >= starts.length) throw new Error('list index out of range');
          s0 = starts[posi + 1] * Math.abs(cfg.timeinternal);
        } else {
          s0 = starts[posi] * Math.abs(cfg.timeinternal);
        }
      }
      for (let j = 0; j < ends.length; j++) {
        const posj = 0;
        if (ends[j] < b1 / cfg.timeinternal) {
          if (posj + 1 >= ends.length) throw new Error('list index out of range');
          s1 = ends[posj + 1] * Math.abs(cfg.timeinternal);
        } else {
          s1 = ends[posj] * Math.abs(cfg.timeinternal);
        }
      }
    } else {
      // ends[0] / starts[0]：空列表时 Python 抛 IndexError，这里必须同样抛
      if (ends.length < 1 || starts.length < 1) throw new Error('list index out of range');
      s1 = ends[0] * Math.abs(cfg.timeinternal);
      s0 = starts[0] * Math.abs(cfg.timeinternal);
    }
  } catch (err) {
    s0 = 30;                                   // 裸 except 的兜底值
    s1 = 60;
  }

  const diff = (s1 - 1) - (s0 + 1);
  const nums = n;
  return {
    num: diff > 0
      ? [nums, b0, b1, s0 + 1, s1 - 1]
      : [nums, b0, b1, s1 + 1, s0 - 1],
    error: null,
  };
}

const DS_WINDOW = {
  pyInt, pySliceBounds, buildY8, detectSignalWindow, setNumeric,
};
if (typeof window !== 'undefined') {
  window.DS_WINDOW = DS_WINDOW;
  Object.assign(window.DS = window.DS || {}, DS_WINDOW);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_WINDOW;
