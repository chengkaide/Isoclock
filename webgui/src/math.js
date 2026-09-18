/* ==========================================================================
 *  math.js —— Isoclock 数值内核（从 Isoclock2.0.py 逐式移植）
 *
 *  移植原则：**代数形式逐字照抄**，不做数学等价改写。
 *  浮点不是实数：`(A/B)*C` 与 `A/(B*C)`、`mean(s-b)` 与 `mean(s)-mean(b)`
 *  在数学上相等，在二进制里不等。所以这里的括号、结合顺序、*100/100 这类
 *  看似多余的写法都刻意保留 —— 它们是为了和 Python 端逐位一致。
 *
 *  每个公式都标注了来源行/函数名，便于后人核对。
 *  移植自：G:/Isoclock/Isoclock-main/Isoclock2.0.py
 * ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
 * 一、NumPy 兼容层
 *
 * NumPy 的 sum / mean / std / average / nanmean / nanstd 全部走**成对求和**
 * （pairwise summation）：分块 128、8 路展开累加器、超过 128 再二分递归。
 * 朴素左到右累加与它结果不同 —— 实测相对差最大 1.3e-15（见 reference.json 的
 * primitives.sum 与朴素累加的对比）。要逐位一致就必须复刻这个顺序。
 *
 * 这里逐行复刻 numpy/core/src/umath/loops.c.src 里的 pairwise_sum_DOUBLE。
 * ------------------------------------------------------------------------ */

const PW_BLOCKSIZE = 128;

/**
 * 成对求和。a 被视为从 off 开始、长度 n 的一维 float64 序列。
 * 递归结构完全对应 NumPy 的 C 实现，连 `n2 -= n2 % 8` 都一致。
 */
function pwSum(a, off, n) {
  if (n < 8) {
    let res = 0.0;
    for (let i = 0; i < n; i++) res += a[off + i];
    return res;
  } else if (n <= PW_BLOCKSIZE) {
    // 8 个累加器，把块大小压到 16，便于向量化而不改变求和顺序
    let r0 = a[off], r1 = a[off + 1], r2 = a[off + 2], r3 = a[off + 3];
    let r4 = a[off + 4], r5 = a[off + 5], r6 = a[off + 6], r7 = a[off + 7];
    let i = 8;
    const lim = n - (n % 8);
    for (; i < lim; i += 8) {
      r0 += a[off + i]; r1 += a[off + i + 1];
      r2 += a[off + i + 2]; r3 += a[off + i + 3];
      r4 += a[off + i + 4]; r5 += a[off + i + 5];
      r6 += a[off + i + 6]; r7 += a[off + i + 7];
    }
    // 合并顺序也必须一致：((r0+r1)+(r2+r3)) + ((r4+r5)+(r6+r7))
    let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i++) res += a[off + i];
    return res;
  } else {
    // 二分，且把切点对齐到 8 的倍数
    let n2 = Math.floor(n / 2);
    n2 -= n2 % 8;
    return pwSum(a, off, n2) + pwSum(a, off + n2, n - n2);
  }
}

/** 一维连续数组求和（对应 np.sum）。 */
function nsum(a) {
  return pwSum(a, 0, a.length);
}

/** 对应 np.mean / np.average（无权重时 average 就是 mean）。 */
function nmean(a) {
  return pwSum(a, 0, a.length) / a.length;
}

/**
 * 对应 np.std（ddof=0）。
 * 实现与 numpy _methods._std 一致：
 *   mean = sum(a)/n;  x = a - mean;  ret = sum(x*x)/n;  sqrt(ret)
 * 注意 (a-mean)**2 是先做减法再平方，单独成数组后再求和。
 */
function nstd(a) {
  const n = a.length;
  const m = nmean(a);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = a[i] - m;
    d[i] = t * t;
  }
  return Math.sqrt(nsum(d) / n);
}

/** 对应 np.count_nonzero(np.isnan(x))。 */
function countNan(a) {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== a[i]) c++;
  return c;
}

/**
 * 对应 np.nanmean。
 *
 * numpy 的做法（nanfunctions.py::nanmean → _replace_nan(a, 0)）是：
 *   arr = a.copy(); arr[isnan] = 0;  然后 np.sum(arr) / count(!isnan)
 * 也就是**先把 NaN 换成 0，再在整个原长数组上求和**，不是在"压缩后的子集"上求和。
 * 求和对象不同、长度不同，结果就不同 —— 必须照抄这个语义。
 */
function nnanmean(a) {
  const n = a.length;
  let cnt = 0;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (a[i] !== a[i]) { t[i] = 0; } else { t[i] = a[i]; cnt++; }
  }
  if (cnt === 0) return NaN;
  return nsum(t) / cnt;
}

/**
 * 对应 np.nanstd（ddof=0）。
 *
 * 这一段是踩坑最久的地方，numpy 的实际做法（lib/nanfunctions.py::nanvar）是：
 *
 *     arr, mask = _replace_nan(a, 0)          # NaN -> 0，并记下位置
 *     cnt = sum(~mask)                         # 有效点数
 *     avg = sum(arr) / cnt                     # 在**原长数组**上求和
 *     np.subtract(arr, avg, out=arr)           # 全部位置都减 avg
 *     arr = _copyto(arr, 0, mask)              # ★ 被掩位置**重置回 0**
 *     var = sum(arr*arr) / cnt                 # 仍在**原长数组**上求和
 *
 * 第 5 行是关键：被掩位置对平方和贡献的是 **0**，不是 (0-avg)^2。
 * 少了这一步，实测相对差可达 4e-3（!）。
 *
 * 另外注意求和的数组长度是 n（原长，含一堆 0），**不是**压缩后的 cnt ——
 * 长度不同会让成对求和的分块与递归结构不同，仍会差约 0.5 ULP。
 * 所以这里既不能把 NaN 当 -avg 处理，也不能先压缩数组。
 */
function nnanstd(a) {
  const n = a.length;
  let cnt = 0;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (a[i] !== a[i]) { t[i] = 0; } else { t[i] = a[i]; cnt++; }
  }
  if (cnt === 0) return NaN;
  const m = nsum(t) / cnt;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // 对应 _copyto(arr, 0, mask)：被掩位置在减完均值后被打回 0
    d[i] = (a[i] !== a[i]) ? 0 : (t[i] - m);
    d[i] = d[i] * d[i];
  }
  return Math.sqrt(nsum(d) / cnt);
}

/** 对应 np.where(cond, x, nan)。 */
function whereNan(cond, x) {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = cond[i] ? x[i] : NaN;
  return out;
}

/* --------------------------------------------------------------------------
 * 二、基础数学
 *
 * 说明：Python 端 `from math import *`，所以用的是 C libm 的 exp/log/sqrt，
 * 不是 numpy 的向量版。JS 侧对应 Math.exp / Math.log / Math.sqrt。
 *   * Math.sqrt 由 IEEE-754 规定为正确舍入，与 libm 的 sqrt 逐位相同；
 *   * exp / log 各语言实现允许有 ~1 ULP 差异，这是移植中唯一无法消除的误差源，
 *     实测偏差记录在 test_math.js 的输出里。
 *
 * pow(x, 2)：Python 的 pow(x, 2) 对整数指数 2 是正确舍入的，等于 x*x，
 * 所以这里直接写 x*x —— 这比 Math.pow 更可靠（V8 的 Math.pow 不保证正确舍入）。
 * ---------------------------------------------------------------------- */

/** SK2model()，Isoclock2.0.py:40。Stacey & Kramers (1975) 两阶段模式铅。 */
function sk2model(age) {
  const Pbc_64 = 11.152 + 9.74 * (Math.exp(0.155125 * 3.7) - Math.exp(0.155125 * age / 1000));
  const Pbc_74 = 12.998 + (9.74 / 137.818) * (Math.exp(0.98485 * 3.7) - Math.exp(0.98485 * age / 1000));
  const Pbc_84 = 31.23 + 36.84 * (Math.exp(0.049475 * 3.7) - Math.exp(0.049475 * age / 1000));
  return [Pbc_64, Pbc_74, Pbc_84, Pbc_64 / Pbc_84, Pbc_74 / Pbc_84];
}

/** 207Pb/206Pb -> 年龄。Isoclock2.0.py:48。 */
function rap76(t) {
  return (Math.exp(0.00098485 * t) - 1) / (Math.exp(0.000155125 * t) - 1) / 137.818;
}

/**
 * Age76Pb(Rap76)，Isoclock2.0.py:48。
 *
 * 【已知缺陷，原样移植】循环条件里的 Rap 在循环体内**从未更新**，收敛判据
 * 一旦为真便永远为真，循环只能靠 N < 10 退出 —— 等价于固定迭代 10 次的试位法。
 * 在 1.5-2.2 Ga 区间造成最大约 +35 Ma 的相对偏差。
 * 这里不修，因为目标是复现原软件的结果；要修的地方在别处（见 README 的 Known issues）。
 */
function age76Pb(Rap76) {
  let Age = 0;
  let Tmin = 0.001;
  let Tmax = 4556;
  let N = 0;
  if (Rap76 > 0.0460455) {
    let Tm = (Tmax + Tmin) / 2;
    let Rap = (Math.exp(0.00098485 * Tm) - 1) / (Math.exp(0.000155125 * Tm) - 1) / 137.818;
    while (Math.abs(Rap76 - Rap) > 0.00005 && N < 10) {
      if (Rap < Rap76) { Tmin = Tm; } else { Tmax = Tm; }
      const Rapi = (Math.exp(0.00098485 * Tmin) - 1) / (Math.exp(0.000155125 * Tmin) - 1) / 137.818;
      const Raps = (Math.exp(0.00098485 * Tmax) - 1) / (Math.exp(0.000155125 * Tmax) - 1) / 137.818;
      Tm = Tmin + (Tmax - Tmin) * (Rap76 - Rapi) / (Raps - Rapi);
      Age = Tm;
      N = N + 1;
    }
  } else {
    Age = 0;
  }
  return Age;
}

/* 衰变常数（1/yr）。原实现在代码里以字面量出现，这里集中但不改数值。 */
const LAM238 = 0.000000000155125;   // 1.55125e-10
const LAM235 = 0.00000000098485;    // 9.8485e-10
const LAM232 = 0.000000000049475;   // 4.9475e-11

/** 由比值反解年龄（Ma）：t = ln(r+1)/λ/1e6。 */
function ageFromRatio(r, lam) {
  return Math.log(r + 1) / lam / 1e6;
}

/* --------------------------------------------------------------------------
 * 三、还原骨架（原 Isoclock2.0.py 的共享骨架部分）
 * ---------------------------------------------------------------------- */

const METHODS = ['sample', 'std207', 'std_cal204', 'std204', 'std208'];
const TOTAL_KEYS = ['U238', 'Th232', 'Pb208', 'Pb207', 'Pb206'];
const CHANNELS = ['Hg202', 'Hg204', 'Pb206', 'Pb207', 'Pb208', 'Th232', 'U238'];

/** _filter_2s()，Isoclock2.0.py:1451。2σ 离群过滤，保留 NaN 占位。 */
function filter2s(x) {
  const avg = nmean(x);
  const sd = nstd(x);
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.abs(x[i] - avg) < 2.0 * sd ? x[i] : NaN;
  }
  return out;
}

/**
 * _mean_2sem()，Isoclock2.0.py:1456。(均值, 2 倍标准误)。
 * 分母用 n（有效点数，即去掉 NaN 之后的个数），与原实现一致 —— 不是 n-1。
 */
function mean2sem(filtered) {
  const n = filtered.length - countNan(filtered);
  if (n === 0) return [NaN, NaN];
  return [nnanmean(filtered), 2.0 * nnanstd(filtered) / Math.sqrt(n)];
}

/** _net_signal()，Isoclock2.0.py:1487。背景扣除后的净信号。 */
function netSignal(sig) {
  return {
    n6: subMean(sig.Pb206_s, sig.Pb206_b),
    n7: subMean(sig.Pb207_s, sig.Pb207_b),
    n8: subMean(sig.Pb208_s, sig.Pb208_b),
    n2: subMean(sig.Th232_s, sig.Th232_b),
    nU: subMean(sig.U238_s, sig.U238_b),
    // 204 通道：直接原始减背景，**未做 Hg 干扰扣除**
    // （源码里那段 Hg204 校正恒为 0 且结果未被引用，见评审报告 P1-1）
    pb204: nmean(sig.Hg204_s) - nmean(sig.Hg204_b),
  };
}

/** X_s - avg(X_b) 的逐元素结果（新数组，不是标量）。 */
function subMean(s, b) {
  const m = nmean(b);
  const n = s.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = s[i] - m;
  return out;
}

/** _total_means()，Isoclock2.0.py:1501。五个"总量"输出值。 */
function totalMeans(sig, asArray) {
  const out = [];
  for (let k = 0; k < TOTAL_KEYS.length; k++) {
    const key = TOTAL_KEYS[k];
    if (asArray) {
      // avg(X_s - avg(X_b))：先逐点减，再求均值 —— 与下一行的写法浮点路径不同
      out.push(nmean(subMean(sig[key + '_s'], sig[key + '_b'])));
    } else {
      out.push(nmean(sig[key + '_s']) - nmean(sig[key + '_b']));
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * 四、五条校正路径的比值算式
 *
 * 只写各自不同的那几行，**代数形式照抄原文**。
 * 原实现里几处彼此不一致的写法一律保留（否则会改变已发表结果）：
 *   * 207Pb 法：输出列用校正后的 7/6，误差列却用未校正的那一路
 *   * Cal204Pb 法：7/6 的 2s 用另一个表达式，且分母是有效点数
 *   * 208Pb 法：五个"总量"列用 avg(X_s - avg(X_b))，其余四个用 avg(X_s)-avg(X_b)
 * ---------------------------------------------------------------------- */

function ratiosSample(net, sig) {
  const n6 = net.n6, n7 = net.n7, n8 = net.n8, n2 = net.n2;
  const r = {
    r76: divArr(n7, n6),
    r68: divArr(n6, net.nU),
    r82: divArr(n8, n2),
    r86: divArr(n8, n6),
    r26: divArr(sig.Th232_s, sig.Pb206_s),
    r84: divScalar(n8, net.pb204),   // pb204 是标量（numpy 的 数组/标量）
  };
  return r;
}

/** 207Pb 法，Isoclock2.0.py:1526。 */
function ratiosStd207(net, sig, ctx) {
  const r = ratiosSample(net, sig);
  const n6 = net.n6, n7 = net.n7, nU = net.nU;
  // rr 既是"未校正的 7/6"，也是 f206 的分子；算一次复用，避免引入额外浮点路径
  const rr = divArr(n7, n6);
  const f = new Float64Array(n6.length);
  const den = ctx.Pbc - ctx.P382;
  for (let i = 0; i < n6.length; i++) f[i] = (rr[i] - ctx.P382) / den;

  const r76 = new Float64Array(n6.length);
  const r68 = new Float64Array(n6.length);
  const r26 = new Float64Array(n6.length);
  for (let i = 0; i < n6.length; i++) {
    const fi = f[i];
    // 原文：输出列用校正后的 7/6
    r76[i] = (n7[i] - n6[i] * ctx.Pbc * fi) / (n6[i] * (1.0 - fi));
    // 原文：先除后乘，不是 n6*(1-f206)/nU
    r68[i] = (n6[i] / nU[i]) * (1.0 - fi);
    r26[i] = sig.Th232_s[i] / (sig.Pb206_s[i] * (1.0 - fi));
  }
  r.r76 = r76;
  r.r68 = r68;
  r.r26 = r26;
  r._r76_err = rr;          // 专供误差列：未校正的 7/6，非笔误
  return r;
}

/** 标定 204Pb 法（Chew et al. 2014），Isoclock2.0.py:1539。 */
function ratiosStdCal204(net, sig, ctx) {
  const r = ratiosSample(net, sig);
  const n6 = net.n6, n7 = net.n7, n8 = net.n8, n2 = net.n2, nU = net.nU;
  const len = n6.length;
  const avgB206 = nmean(sig.Pb206_b);
  const avgB207 = nmean(sig.Pb207_b);
  // r76_std 在原文里是 np.ones(n)*P382，即常数数组；标量等价且乘法可交换
  const denom = ctx.Q8 * ctx.P382 - ctx.R8;

  const n383 = new Float64Array(len);
  const r76 = new Float64Array(len);
  const r68 = new Float64Array(len);
  const r82 = new Float64Array(len);
  const r86 = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    // (P382*Pb206_s - avgB206*P382 - Pb207_s + avgB207) / (Q8*P382 - R8)
    n383[i] = (ctx.P382 * sig.Pb206_s[i] - avgB206 * ctx.P382
               - sig.Pb207_s[i] + avgB207) / denom;
    r76[i] = (n7[i] - n383[i] * ctx.R8) / (n6[i] - n383[i] * ctx.Q8);
    r68[i] = (n6[i] - n383[i] * ctx.Q8) / nU[i];
    r82[i] = (n8[i] - n383[i] * ctx.S8) / n2[i];
    r86[i] = (n8[i] - n383[i] * ctx.S8) / n6[i];
  }
  r.r76 = r76; r.r68 = r68; r.r82 = r82; r.r86 = r86;
  return r;
}

/** 204Pb 法，Isoclock2.0.py:1555。 */
function ratiosStd204(net, sig, ctx) {
  const r = ratiosSample(net, sig);
  const n6 = net.n6, nU = net.nU;
  const len = n6.length;
  const avgB206 = nmean(sig.Pb206_b);
  const avgB207 = nmean(sig.Pb207_b);
  const m74 = (nmean(sig.Pb207_s) - avgB207) / net.pb204;
  const m64 = (nmean(sig.Pb206_s) - avgB206) / net.pb204;

  const r76 = new Float64Array(len);
  const r68 = new Float64Array(len);
  const c74 = (m74 - ctx.R8) / m74;
  const c64 = (m64 - ctx.Q8) / m64;
  for (let i = 0; i < len; i++) {
    // 两个易错点，都按原文保留：
    //  * 分子用**原始信号** sig.Pb207_s，不是扣过背景的 n7
    //  * `A / B * C` 是左结合 = (A/B)*C，不是 A/(B*C)
    r76[i] = ((sig.Pb207_s[i] - avgB207 * c74) / n6[i]) * c64;
    r68[i] = (n6[i] * c64) / nU[i];
  }
  r.r76 = r76; r.r68 = r68;
  return r;
}

/** 208Pb 法（Zack et al. 2011），Isoclock2.0.py:1573。 */
function ratiosStd208(net, sig, ctx) {
  const r = ratiosSample(net, sig);
  const len = net.n6.length;
  const sk = sk2model(ctx.Standard_age);
  const Pbc_68 = sk[3], Pbc_78 = sk[4];

  const pb207t = subMean(sig.Pb207_s, sig.Pb207_b);
  const pb206t = subMean(sig.Pb206_s, sig.Pb206_b);
  const pb208t = subMean(sig.Pb208_s, sig.Pb208_b);

  const r76 = new Float64Array(len);
  const r68 = new Float64Array(len);

  // 判据：净 207Pb 均值是否恰好等于净 208Pb 均值乘模式铅 207/208。
  // 实测该条件在正常数据下恒为假，实走 else 分支；两条都保留以维持行为不变。
  if (nmean(pb207t) === nmean(pb208t) * Pbc_78
      || nmean(pb206t) === nmean(pb208t) * Pbc_68) {
    const m78 = divArr(pb207t, pb208t);
    const m68 = divArr(pb206t, pb208t);
    const avgB207 = nmean(sig.Pb207_b);
    for (let i = 0; i < len; i++) {
      const c78 = (m78[i] - Pbc_78) / m78[i];
      const c68 = (m68[i] - Pbc_68) / m68[i];
      // 分子同样用原始信号 sig.Pb207_s（见 ratiosStd204 的说明）
      r76[i] = ((sig.Pb207_s[i] - avgB207 * c78) / pb206t[i]) * c68;
      r68[i] = (pb206t[i] * c68) / net.nU[i];
    }
  } else {
    for (let i = 0; i < len; i++) {
      r76[i] = (pb207t[i] - pb208t[i] * Pbc_78) / (pb206t[i] - pb208t[i] * Pbc_68);
      r68[i] = (pb206t[i] - pb208t[i] * Pbc_68) / net.nU[i];
    }
  }
  r.r76 = r76; r.r68 = r68;
  return r;
}

const RATIOS = {
  sample: ratiosSample,
  std207: ratiosStd207,
  std_cal204: ratiosStdCal204,
  std204: ratiosStd204,
  std208: ratiosStd208,
};

function divArr(a, b) {
  // 防呆：把标量当数组传进来会得到一片 NaN 而不报错，很难查。宁可当场炸掉。
  if (typeof b === 'number' || typeof a === 'number') {
    throw new TypeError('divArr 收到标量；逐元素除法请用 divScalar，'
      + '标量在分子请用 mulScalar');
  }
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] / b[i];
  return out;
}

/** 对应 numpy 的 数组 / 标量。 */
function divScalar(a, s) {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] / s;
  return out;
}

/* --------------------------------------------------------------------------
 * 五、还原主函数
 * ---------------------------------------------------------------------- */

/**
 * reduce_sample()，Isoclock2.0.py:1607。把一路样品的 8 个通道还原成 23 列。
 *
 * @param {string} name   文件名，如 "MAD-NEW_5.csv"
 * @param {object} sig    {Pb206_b, Pb206_s, ...}，值为 Float64Array
 * @param {string} method 'sample' | 'std207' | 'std_cal204' | 'std204' | 'std208'
 * @param {object} ctx    标样参数 {Q8, R8, S8, P382, Pbc, Standard_age}
 * @param {object} opts   {eleIndex, samplesMap}
 */
function reduceSample(name, sig, method, ctx, opts) {
  opts = opts || {};
  ctx = ctx || {};
  const net = netSignal(sig);
  const ratios = RATIOS[method](net, sig, ctx);

  const r76 = ratios.r76;
  const r68 = ratios.r68;
  const f68 = filter2s(r68);
  const a68 = mean2sem(f68);
  const m68 = a68[0], s68 = a68[1];
  const a82 = mean2sem(filter2s(ratios.r82));
  const m82 = a82[0], s82 = a82[1];
  const a86 = mean2sem(filter2s(ratios.r86));
  const m86 = a86[0], s86 = a86[1];
  const a26 = mean2sem(filter2s(ratios.r26));
  const m26 = a26[0], s26 = a26[1];
  const a84 = mean2sem(filter2s(ratios.r84));
  const m84 = a84[0], s84 = a84[1];

  const m76_out = mean2sem(filter2s(r76))[0];
  const err76 = mean2sem(filter2s(ratios._r76_err !== undefined ? ratios._r76_err : r76));
  const m76_err = err76[0], s76_err = err76[1];

  const r75 = m76_out * m68 * 137.818;

  // Cal204Pb 路径的 207Pb/206Pb 2s 用的是另一个表达式（原 Std_method 独有）。
  // 分母是**有效点数**（去掉被过滤掉的 NaN），不是数组总长度。
  let s76_out;
  if (method === 'std_cal204') {
    const n68 = f68.length - countNan(f68);
    // r75 是标量；逐元素算 (r75/f68[i])/137.818 —— 左结合，与原式一致
    const tmp = new Float64Array(f68.length);
    for (let i = 0; i < f68.length; i++) tmp[i] = r75 / f68[i] / 137.818;
    s76_out = 2.0 * nnanstd(tmp) / Math.sqrt(n68);
  } else {
    s76_out = s76_err;
  }

  // 注意 *100/100 不是恒等：x*100 再 /100 可能不等于 x。原样保留。
  const t1 = r75 * (s68 / m68) * 100 / 100;
  const t2 = r75 * (s76_err / m76_err) * 100 / 100;
  const s75 = Math.sqrt(t1 * t1 + t2 * t2);

  let no;
  if (opts.eleIndex === 0) {
    no = parseInt(name.split('_').pop().split('.')[0], 10);
  } else {
    no = name;
  }
  const samplesMap = opts.samplesMap || {};

  return [
    no, name, samplesMap[name],
    m76_out, s76_out,
    m68, s68,
    r75, s75,
    m82, s82,
    m86, s86,
    m26, s26,
    m84, s84,
    '------',
  ].concat(totalMeans(sig, method === 'std208'));
}

/* 暴露给浏览器与 Node 测试 */
const DS = {
  PW_BLOCKSIZE, pwSum, nsum, nmean, nstd, nnanmean, nnanstd, countNan, whereNan,
  sk2model, age76Pb, rap76, ageFromRatio, LAM238, LAM235, LAM232,
  filter2s, mean2sem, netSignal, subMean, totalMeans, divArr, divScalar,
  ratiosSample, ratiosStd207, ratiosStdCal204, ratiosStd204, ratiosStd208,
  reduceSample, METHODS, TOTAL_KEYS, CHANNELS, RATIOS,
};
if (typeof window !== 'undefined') window.DS = DS;
if (typeof module !== 'undefined' && module.exports) module.exports = DS;
