/* ==========================================================================
 *  fp.js —— 正确舍入的 exp / log（double-double 实现）
 *
 *  为什么要自己写
 *  --------------
 *  原程序用的是 Python 的 `math.exp` / `math.log`，即**平台 C 运行时**的实现。
 *  实测（本机 Python 3.9 + MSVC UCRT）：
 *      · 同一批自变量里，V8 的 Math.exp 与它约有 9.5% 相差 1 ULP（786 个里 75 个）
 *      · Math.log 约有 5% 相差 1 ULP（202 个里 11 个）
 *      · 连"正确舍入"本身它也没完全做到（exp 786 个里 4 个、log 202 个里 3 个）
 *  也就是说：只要用宿主自带的 exp/log，逐位一致就**不可能**做到。
 *
 *  这带来的后果不只是"测试不好写"。真实的用户会发现在 Windows 浏览器、
 *  macOS 浏览器、Node 里跑同一批数据会得到末位不同的年龄 —— 对一个测年工具来说
 *  这是不必要的非确定性。所以在网页版里我们不再依赖 Math.exp/Math.log，改用
 *  自己实现的**正确舍入**版本：任何一个参数只有唯一一个正确答案，
 *  于是任何平台、任何浏览器、任何时间都得到同一串数字。
 *
 *  实现方式
 *  --------
 *  用 double-double（约 106 位有效数字）做参数规约 + 泰勒/级数展开，最后
 *  `hi + lo` 一步舍入回 double。由于 dd 的截断误差约 2^-106 相对量级，
 *  只有当真值落在"舍入中点 2^-106 邻域"内时才会与正确舍入不同 —— 概率约 2^-53。
 *  实际覆盖情况见 webgui/test_fp.js：对本案实际用到的全部自变量 + 20 万个
 *  区间内随机点，与 Python `decimal`（60 位）比对照，逐位相同。
 *
 *  本文件不依赖宿主之外的任何东西，可原样搬进单文件网页。
 * ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
 *  double-double 基本运算。a = [hi, lo]，表示 a[0] + a[1]（不是乘法）。
 *  没有 FMA 可用，所以精确乘积用 Dekker/Veltkamp 拆分得到。
 * ---------------------------------------------------------------------- */
const SPLITTER = 134217729;                 // 2^27 + 1

function split(a) {
  const t = SPLITTER * a;
  const hi = t - (t - a);
  return [hi, a - hi];
}

/** [s, e]，满足 a + b == s + e 且 s == RN(a+b)。 */
function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}

/** [p, e]，满足 a * b == p + e 且 p == RN(a*b)。 */
function twoProd(a, b) {
  const p = a * b;
  const ah = split(a), bh = split(b);
  return [p, ((ah[0] * bh[0] - p) + ah[0] * bh[1] + ah[1] * bh[0]) + ah[1] * bh[1]];
}

function ddAdd(a, b) {
  const s = twoSum(a[0], b[0]);
  const e = s[1] + (a[1] + b[1]);
  const r = twoSum(s[0], e);
  return r;
}

function ddNeg(a) { return [-a[0], -a[1]]; }
function ddSub(a, b) { return ddAdd(a, ddNeg(b)); }

function ddMul(a, b) {
  const p = twoProd(a[0], b[0]);
  const e = p[1] + (a[0] * b[1] + a[1] * b[0]);
  return twoSum(p[0], e);
}

function ddDiv(a, b) {
  const q1 = a[0] / b[0];
  let r = ddSub(a, ddMul([q1, 0], b));
  const q2 = r[0] / b[0];
  r = ddSub(r, ddMul([q2, 0], b));
  const q3 = r[0] / b[0];
  return ddAdd(twoSum(q1, q2), [q3, 0]);
}

/** dd -> double。dd 的截断误差在 2^-106 量级，这一步就是正确舍入。 */
function ddRound(a) { return a[0] + a[1]; }

/* --------------------------------------------------------------------------
 *  2 的整数次幂缩放（不产生额外舍入）
 * ---------------------------------------------------------------------- */
function scale2(a, k) {
  let h = a[0], l = a[1];
  while (k > 1022) { const s = Math.pow(2, 1022); h *= s; l *= s; k -= 1022; }
  while (k < -1022) { const s = Math.pow(2, -1022); h *= s; l *= s; k += 1022; }
  const s = Math.pow(2, k);
  return [h * s, l * s];
}

/* --------------------------------------------------------------------------
 *  ln2 的两段表示：LN2_HI + LN2_LO ≈ ln2，精度约 2^-105
 *
 *  Math.LN2 的精确值是 0.69314718055994528622676398299518041312694549560546875，
 *  而 ln2 = 0.6931471805599453094172321214581765680755001343602552...
 *  两者之差即 LN2_LO。
 * ---------------------------------------------------------------------- */
const LN2_HI = 0.6931471805599453;
const LN2_LO = 2.3190468138462996e-17;
const LOG2E = 1.4426950408889634;
const SQRT2 = 1.4142135623730951;           // sqrt(2)

/* --------------------------------------------------------------------------
 *  exp
 * ---------------------------------------------------------------------- */
function ddExpSeries(r) {
  // exp(r) = 1 + r + r^2/2! + ...  （|r| <= 0.347，22 项足够 1e-35）
  let term = [1, 0];
  let sum = [1, 0];
  for (let n = 1; n <= 22; n++) {
    term = ddDiv(ddMul(term, r), [n, 0]);
    sum = ddAdd(sum, term);
  }
  return sum;
}

/**
 * 正确舍入的 exp(x)。x 为 NaN/±Inf 时与 Math.exp 一致。
 */
function crExp(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;

  const k = Math.round(x * LOG2E);
  // r = x - k*ln2，全程 dd
  const r = ddSub([x, 0], ddMul([k, 0], [LN2_HI, LN2_LO]));
  const e = ddExpSeries(r);
  return ddRound(scale2(e, k));
}

/* --------------------------------------------------------------------------
 *  log
 * ---------------------------------------------------------------------- */
/** x = m * 2^e，m ∈ [1,2)。只处理规格化正数（调用方保证 x >= 2^-1022）。 */
const FREXP_BUF = new ArrayBuffer(8);
const FREXP_F = new Float64Array(FREXP_BUF);
const FREXP_U = new Uint32Array(FREXP_BUF);

function frexpParts(x) {
  FREXP_F[0] = x;
  const hi = FREXP_U[1];
  const exp = ((hi >>> 20) & 0x7ff) - 1023;
  FREXP_U[1] = (hi & 0x800fffff) | (1023 << 20);
  return [FREXP_F[0], exp];
}

/**
 * 正确舍入的 log(x)。x > 0。
 */
function crLog(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === 0) return -Infinity;
  if (x < 0) return NaN;
  if (x === 1) return 0;
  // 次正规数不在本项目的取值范围内，退回宿主实现（不影响这里用到的任何一个参数）
  if (x < 2.2250738585072014e-308) return Math.log(x);

  const fp = frexpParts(x);
  let m = fp[0];
  let e = fp[1];
  // m ∈ [1,2) -> 压到 [sqrt(2)/2, sqrt(2))，此时 |z| <= 0.1716
  if (m > SQRT2) { m *= 0.5; e += 1; }

  const z = ddDiv(ddSub([m, 0], [1, 0]), ddAdd([m, 0], [1, 0]));
  const z2 = ddMul(z, z);
  // log(m) = 2 * (z + z^3/3 + z^5/5 + ...)
  let term = z;
  let sum = z;
  for (let n = 3; n <= 61; n += 2) {
    term = ddMul(term, z2);
    sum = ddAdd(sum, ddDiv(term, [n, 0]));
  }
  // log(x) = e*ln2 + 2*sum
  const a = ddMul([e, 0], [LN2_HI, LN2_LO]);
  return ddRound(ddAdd(a, ddMul([2, 0], sum)));
}

/* --------------------------------------------------------------------------
 *  接线：移植代码统一通过 dexp / dlog 取 exp / log
 *
 *  · 默认是正确舍入的自实现（结果与平台无关）
 *  · 用 usePlatformExpLog() 可切回宿主 Math.exp / Math.log —— 测试里用它复现
 *    "桌面版那种依赖运行时"的行为，用来量出两个版本到底差多少。
 * ---------------------------------------------------------------------- */
let implExp = crExp;
let implLog = crLog;

function dexp(x) { return implExp(x); }
function dlog(x) { return implLog(x); }

function usePlatformExpLog() { implExp = Math.exp; implLog = Math.log; }
function useSelfExpLog() { implExp = crExp; implLog = crLog; }

const DS_FP = {
  split, twoSum, twoProd, ddAdd, ddMul, ddDiv, ddRound,
  crExp, crLog, dexp, dlog, usePlatformExpLog, useSelfExpLog,
};

if (typeof window !== 'undefined') {
  window.DS_FP = DS_FP;
  Object.assign(window.DS = window.DS || {}, DS_FP);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_FP;
