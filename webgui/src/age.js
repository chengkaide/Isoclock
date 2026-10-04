/* ==========================================================================
 *  age.js —— 年龄层：Age_Calculate_average() / Age_Calculate() 的移植
 *
 *  对应 Isoclock2.0.py：
 *      Age_Calculate_average()   244-850    「平均法」：单一分馏因子（全批标样均值）
 *      Age_Calculate()           852-1298   「线性法」：相邻标样插值（SSB）
 *
 *  两个函数把「读文件 + 算数 + 弹窗 + 写 xls」揉在一起。移植时只保留算数，
 *  输入输出显式传递；弹窗与写盘由调用方负责。
 *
 *  本文件里的 exp / log 一律走 fp.js 的 dexp / dlog（正确舍入），不用 Math.exp /
 *  Math.log。理由见 fp.js 顶部：宿主 libm 之间本就允许差 1 ULP，直接用会让结果
 *  依赖平台；正确舍入的版本则处处一致，同时也让逐位比对成为可用的强判据。
 *
 *  移植原则与 math.js 一致：**复现原实现的结果，不修正它**。
 *      · 分支间那几处"写法不同、数学等价"的表达式原样保留
 *        （平均法用 `date_all[2][i]*f206_238`，线性法用 `result_cal_206Pb_238U`；
 *          线性法 207Pb 法的误差用**未校正**比值 `date_all[4][i]`）
 *      · 乘除的**结合顺序**照抄 —— 浮点下 `((a*b)*c)*d` 与 `(a*b)*(c*d)` 可以差一位
 *      · 只产出前 51 列（原代码 `for col in range(51)`）；第 52-56 列不落盘
 *      · 平均法的 204Pb / 208Pb 路径里 `rho_c`、`Corr_7_6` 等是**算了但没用**的
 *        中间量（无副作用），这里省略
 *
 *  依赖通过 attach() 注入。
 * ========================================================================== */
'use strict';

const AG = {};
function attach(mods) { Object.assign(AG, mods); }

const AG_LAM238 = 0.000000000155125;
const AG_LAM235 = 0.00000000098485;
const AG_LAM232 = 0.000000000049475;
const AG_R_U = 137.818;

/* --------------------------------------------------------------------------
 *  pandas 的 Series.mean() / Series.std(ddof=1)
 *
 *  pandas 1.5.3 未装 bottleneck 时两者都退到 numpy 的成对求和：
 *      mean = sum(x)/n
 *      var  = sum((x-mean)^2)/(n-1)        ← pandas 默认 ddof=1（numpy 是 0）
 *  NaN 处理同 numpy：替换为 0 后在**原长数组**上求和，除数用有效点数。
 * ---------------------------------------------------------------------- */
function pMean(v) { return AG.nnanmean(v); }

function pStd1(v) {
  let cnt = 0;
  for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) cnt++;
  if (cnt <= 1) return NaN;
  const filled = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) filled[i] = Number.isNaN(v[i]) ? 0 : v[i];
  const m = AG.pwSum(filled, 0, filled.length) / cnt;
  const d = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    // 被掩位置贡献 0，不是 (0-mean)^2 —— 对应 numpy 的 _copyto(arr, 0, mask)
    d[i] = Number.isNaN(v[i]) ? 0 : (filled[i] - m) * (filled[i] - m);
  }
  return Math.sqrt(AG.pwSum(d, 0, d.length) / (cnt - 1));
}

/** pandas 的 Series[a:b].mean()（位置切片，空切片给 NaN）。 */
function pMeanRange(col, a, b) {
  const lo = Math.max(0, a);
  const hi = Math.min(b, col.length);
  if (hi <= lo) return NaN;
  const v = new Float64Array(hi - lo);
  for (let i = lo; i < hi; i++) v[i - lo] = col[i];
  return pMean(v);
}

/* --------------------------------------------------------------------------
 *  输入整理
 * ---------------------------------------------------------------------- */
function prep(input) {
  const c = input.cfg || {};
  return {
    dateAll: input.dateAll,
    dateCps: input.dateCps,
    names: input.name,
    fileNames: input.fileName,
    comments: input.comments || {},
    n: input.name.length,
    cfg: {
      method: c.method | 0, excessV: c.excessV,
      nistStd: c.nistStd, standard: c.standard,
      P382: c.P382, a: c.a, b: c.b, c: c.c, Pbc: c.Pbc,
      commonPb: c.commonPb, radioactivePb: c.radioactivePb,
      commonPb207_208: c.commonPb207_208, commonPb206_208: c.commonPb206_208,
      commonPb207_204: c.commonPb207_204, commonPb206_204: c.commonPb206_204,
      commonPb208_204: c.commonPb208_204,
      radioactiveSPb207_206: c.radioactiveSPb207_206,
      age: c.age,
    },
  };
}

function pickByName(ctx, k, key) {
  const out = [];
  for (let i = 0; i < ctx.n; i++) if (ctx.names[i] === key) out.push(ctx.dateAll[k][i]);
  return out;
}

/** pandas 的 date_all[k][索引为 key 的行].mean() / .std()。 */
function colMean(ctx, k, key) { return pMean(pickByName(ctx, k, key)); }
function colStd(ctx, k, key) { return pStd1(pickByName(ctx, k, key)); }

function mulCol(col, f) {
  const out = new Float64Array(col.length);
  for (let i = 0; i < col.length; i++) out[i] = col[i] * f;
  return out;
}

/* --------------------------------------------------------------------------
 *  把 result_all.csv / Mean_Cps.csv 读成年龄层要的数组
 *
 *  界面和测试都走这里 —— 免得"测试验的是一份解析代码、界面用的是另一份"。
 *  列号与 np.loadtxt(usecols=...) 的参数一一对应，取自原实现：
 *      date   <- result_all.csv  usecols=(3..16, 18..22)   共 19 列
 *      cps    <- Mean_Cps.csv    usecols=(2..15)           共 14 列
 * ---------------------------------------------------------------------- */
const USE_COLS_RESULT = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  18, 19, 20, 21, 22];

function splitCsv(text) {
  return text.split(/\r?\n/).filter((l) => l.length).slice(1);
}

/** result_all.csv -> {name, fileName, dateAll[19][n], n}。 */
function parseResultAllCsv(text) {
  const body = splitCsv(text);
  const n = body.length;
  const dateAll = USE_COLS_RESULT.map(() => new Float64Array(n));
  const name = new Array(n);
  const fileName = new Array(n);
  for (let r = 0; r < n; r++) {
    const f = body[r].split(',');
    fileName[r] = f[1];
    name[r] = f[2].trim();          // 原实现 name[i]=name[i].strip()
    for (let k = 0; k < USE_COLS_RESULT.length; k++) {
      dateAll[k][r] = Number(f[USE_COLS_RESULT[k]]);
    }
  }
  return { name, fileName, dateAll, n };
}

/** Mean_Cps.csv -> 14 个长度 n 的数组（顺序同 usecols=(2..15)）。 */
function parseMeanCpsCsv(text) {
  const body = splitCsv(text);
  const n = body.length;
  const out = [];
  for (let j = 0; j < 14; j++) out.push(new Float64Array(n));
  for (let r = 0; r < n; r++) {
    const f = body[r].split(',');
    for (let j = 0; j < 14; j++) out[j][r] = Number(f[2 + j]);
  }
  return out;
}

/** 组装年龄层输入。comments 是 {文件名: 备注}，原实现里恒为空串。 */
function buildInput(resultAllCsv, meanCpsCsv, comments) {
  const t = parseResultAllCsv(resultAllCsv);
  const cmt = {};
  for (const f of t.fileName) {
    cmt[f] = (comments && Object.prototype.hasOwnProperty.call(comments, f))
      ? comments[f] : '';
  }
  return {
    name: t.name, fileName: t.fileName, dateAll: t.dateAll,
    dateCps: parseMeanCpsCsv(meanCpsCsv), comments: cmt, n: t.n,
  };
}

/* --------------------------------------------------------------------------
 *  coefficient()：NIST 外标系数。两处实现只差短别名（'610'/'612'/'614'）。
 * ---------------------------------------------------------------------- */
const ALIAS610 = ['NIST610', 'NIST 610', 'SRM610', 'SRM 610'];
const ALIAS612 = ['NIST612', 'NIST 612', 'SRM612', 'SRM 612'];
const ALIAS614 = ['NIST614', 'NIST 614', 'SRM614', 'SRM 614'];
const SHORT = { 610: '610', 612: '612', 614: '614' };

/**
 * coefficient(NIST_STD)。两处实现的差别只有短别名（线性法多 '610'/'612'/'614'）。
 *
 * 注意原实现把整段包在 try/except 里，异常一律退回 (0,0,0)。会抛异常的情形有：
 *      · 表里没有这个名字           -> date_all[14][s] 抛 KeyError
 *      · 该名字只出现一次（不是 Series 而是标量）  -> 尾部 `[:]` 抛 TypeError
 * 两种情况都按"系数为 0"处理。这个分支在真机上会出现（比如选了 NIST612 却只测了
 * NIST610），所以必须如实复现，不能想当然地拿 NaN 往下算。
 */
function coefficients(ctx, withShort) {
  const s = ctx.cfg.nistStd;
  const idx = [];
  for (let i = 0; i < ctx.n; i++) if (ctx.names[i] === s) idx.push(i);
  // pandas 的 `series[label]`（实测 pandas 1.5.3，与索引是否唯一无关）：
  //      匹配 0 行 -> KeyError ； 匹配 1 行 -> 标量 numpy.float64 ； 匹配 ≥2 行 -> Series
  // 于是 `date_all[14][s][:]` 在"匹配 1 行"时抛 IndexError: invalid index to
  // scalar variable，在"匹配 0 行"时抛 KeyError —— 两者都被最外层 except 吞掉，
  // 系数取 0。这是需要提醒使用者的一种情形：整批只插了一个标样时，微量元素列为 0。
  if (idx.length < 2) return [0, 0, 0];
  const m = (k) => {
    const v = new Float64Array(idx.length);
    for (let j = 0; j < idx.length; j++) v[j] = ctx.dateAll[k][idx[j]];
    return pMean(v);
  };
  const cU = m(14), cTh = m(15), cPb = m(16) + m(17) + m(18);
  const has = (list, tag) => list.indexOf(s) >= 0 || (withShort && s === SHORT[tag]);
  if (has(ALIAS610, 610)) return [461.5 / cU, 457.2 / cTh, 426 / cPb];
  if (has(ALIAS612, 612)) return [37.38 / cU, 37.79 / cTh, 38.57 / cPb];
  if (has(ALIAS614, 614)) return [0.832 / cU, 0.748 / cTh, 2.32 / cPb];
  return [0, 0, 0];
}

/* --------------------------------------------------------------------------
 *  表头
 * ---------------------------------------------------------------------- */
function baseHeader(linear) {
  const h = new Array(51).fill('');
  h[0] = linear ? 'File Names' : 'FileNames';
  h[1] = linear ? ' Sample Names' : ' SampleName';
  h[2] = '207Pb/206Pb'; h[3] = '2s'; h[4] = '206Pb/238U'; h[5] = '2s';
  h[6] = '207Pb/235U'; h[7] = '2s'; h[8] = '208Pb/232Th'; h[9] = '2s';
  h[10] = '208Pb/206Pb'; h[11] = '2s'; h[12] = '232Th/206Pb'; h[13] = '2s';
  h[14] = '208Pb/204Pb'; h[15] = '2s';
  h[16] = linear ? 'Age(Ma)' : 'Age';
  if (linear) {
    h[17] = '206Pb_238U'; h[18] = '2s';
    h[19] = '207Pb_235U'; h[20] = '2s';
    h[21] = '208Pb_232Th'; h[22] = '2s';
    h[23] = '207Pb_206Pb'; h[24] = '2s';
  } else {
    h[17] = '206Pb_238U Age(Ma)'; h[18] = '2s';
    h[19] = '207Pb_235U Age(Ma)'; h[20] = '2s';
    h[21] = '208Pb_232Th  Age(Ma)'; h[22] = '2s';
    h[23] = '207Pb_206Pb  Age(Ma)'; h[24] = '2s';
  }
  h[30] = 'Terra-Wasserburg Plot:'; h[31] = '238U/206Pb'; h[32] = '2s error';
  h[33] = '207Pb/206Pb'; h[34] = '2s error';
  h[35] = 'Plotting purposes:'; h[36] = '207Pb/235U'; h[37] = '2s error';
  h[38] = '206Pb/238U'; h[39] = '2s error'; h[40] = 'rho';
  h[42] = '208Pb/232Th'; h[43] = '2s error';
  h[44] = '208Pb/206Pb'; h[45] = '2s error';
  h[46] = 'Trace element'; h[47] = 'U (ppm)'; h[48] = 'Th (ppm)'; h[49] = 'Pb (ppm)';
  return h;
}

function headerFor(linear, method) {
  const h = baseHeader(linear);
  let br = null;
  if (method === 1) {
    br = { 25: '207Pb Corr. Age(Ma)', 26: '207Pb_235U', 27: '2s',
           28: '206Pb_238U', 29: '2s', 50: '207 Corrected isotop' };
  } else if (method === 2) {
    br = { 25: '208Pb Corr. Age(Ma)', 26: '207Pb_235U', 27: '2s',
           28: '206Pb_238U', 29: '2s', 50: '208 Corrected isotop' };
  } else if (method === 3) {
    br = { 25: '204Pb Corr. Age(Ma)', 26: '207Pb_235U', 27: '2s',
           28: '206Pb_238U', 29: '2s', 50: '204 Corrected isotop' };
  } else if (method === 4) {
    br = { 25: 'Cal 204Pb Corr. Age(Ma)', 26: '206Pb_238U', 27: '2s',
           // 下面两处列名沿用原程序的写法，不做改动
           28: linear ? '232Pb_232Th' : '208Pb_232Th', 29: '2s',
           50: linear ? '204 Corrected isotop' : 'Cal 204Pb Corrected isotop' };
  }
  if (br) for (const k of Object.keys(br)) h[k] = br[k];
  return h;
}

/** 相关系数 rho（两法写法逐字相同，包括末尾的 *100 与那个 abs 分支）。 */
function rhoOf(d1, d3, d5, R68, R75, R76, eV) {
  const w = (Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV) * R68) / R68 * 100;
  const s = (Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV) * R75) / R75 * 100;
  const o = (Math.sqrt((d1 / R76) * (d1 / R76) + 0.0001) * R76) / R76 * 100;
  const t = (w * w + s * s - o * o) / (2 * w * s);
  return Math.abs(t) < w / s ? Math.abs(t) : w / s;
}

/* ==========================================================================
 *  平均法：Age_Calculate_average()
 * ========================================================================== */
function averageAge(input) {
  const ctx = prep(input);
  const cfg = ctx.cfg;
  const eV = cfg.excessV;
  const method = cfg.method;
  const d = (k, i) => ctx.dateAll[k][i];
  const cp = (k, i) => ctx.dateCps[k][i];
  const coef = coefficients(ctx, false);
  // 207Pb/206Pb 年龄反解：默认沿用桌面版原实现；fix76=true 时用收敛修正版
  const solve76 = input.fix76 ? AG.age76PbFixed : AG.age76Pb;
  const warn = { divZero: 0 };               // 分母为零而无法校正的行数

  const f207_206 = cfg.P382 / colMean(ctx, 0, cfg.standard);
  const f206_238 = cfg.a / colMean(ctx, 2, cfg.standard);
  const std_68_2s = colStd(ctx, 2, cfg.standard) / colMean(ctx, 2, cfg.standard);
  const f207_235 = cfg.b / colMean(ctx, 4, cfg.standard);
  const std_75_2s = colStd(ctx, 4, cfg.standard) / colMean(ctx, 4, cfg.standard);
  const f208_232 = cfg.c / colMean(ctx, 6, cfg.standard);
  const f232_206 = 1 / f208_232;

  // 校正后的比值列（pandas 里是 date_all[k]*factor，再按位置取）
  const R76c = mulCol(ctx.dateAll[0], f207_206);
  const R68c = mulCol(ctx.dateAll[2], f206_238);
  const R75c = mulCol(ctx.dateAll[4], f207_235);
  const R82c = mulCol(ctx.dateAll[6], f208_232);
  const R86c = mulCol(ctx.dateAll[8], 1);
  const R26c = mulCol(ctx.dateAll[10], f232_206);
  const R84c = mulCol(ctx.dateAll[12], 1);

  const rows = [];
  for (let i = 0; i < ctx.n; i++) {
    const d1 = d(1, i), d2 = d(2, i), d3 = d(3, i), d5 = d(5, i), d7 = d(7, i);
    const r68raw = d2 * f206_238;                       // date_all[2][i]*f206_238
    const R76 = R76c[i], R68 = R68c[i], R75 = R75c[i], R82 = R82c[i];
    const R86 = R86c[i], R26 = R26c[i], R84 = R84c[i];
    const rho = rhoOf(d1, d3, d5, R68, R75, R76, eV);

    // 未校正年龄（字段 18-23）：一律用 date_all[2][i]*f206_238
    const a68 = dlog(Math.abs(r68raw + 1)) / AG_LAM238 / 1e6;
    const e68 = Math.sqrt((d3 / r68raw) * (d3 / r68raw) + eV * eV) * a68;
    const a75 = dlog(Math.abs(R75 + 1)) / AG_LAM235 / 1e6;
    const e75 = Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV) * a75;
    const a82 = dlog(Math.abs(R82 + 1)) / AG_LAM232 / 1e6;
    const e82 = Math.sqrt((d7 / R82) * (d7 / R82) + eV * eV) * a82;
    const A76 = solve76(R76);
    const A76e = solve76(R76 + d1) - A76;

    let mid4, tail6, sep17 = '-------------';
    if (method === 0) {
      mid4 = [' ', ' ', ' ', ' '];
      tail6 = ['', '', '', '', '', ''];
    } else if (method === 1) {
      const q = (R76 - cfg.radioactivePb) / (cfg.commonPb - cfg.radioactivePb);
      // 乘序照抄：((q*Pbc)*137.818)*d2*f206_238
      const lg75 = dlog(Math.abs(
        R75 - q * cfg.commonPb * AG_R_U * d2 * f206_238 + 1)) / AG_LAM235 / 1e6;
      const le75 = lg75 * Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV);
      const lg68 = (dlog(Math.abs((1 - q) * d2 * f206_238) + 1) / AG_LAM238) / 1e6;
      const le68 = lg68 * Math.sqrt((d3 / r68raw) * (d3 / r68raw) + eV * eV);
      const c75 = dexp(AG_LAM235 * lg75 * 1e6) - 1;
      const c68 = dexp(AG_LAM238 * lg68 * 1e6) - 1;
      mid4 = [lg75, le75, lg68, le68];
      tail6 = ['----', c75, c75 * le75 / lg75, c68, c68 * le68 / lg68, rho];
    } else if (method === 2 || method === 3) {
      const sk = AG.sk2model(cfg.age);
      const spike = (method === 2) ? (cp(11, i) - cp(4, i)) : (cp(8, i) - cp(1, i));
      const i207 = (method === 2) ? 4 : 1;
      const i206 = (method === 2) ? 3 : 0;
      const corr207 = (cp(10, i) - cp(3, i)) - spike * sk[i207];
      const corr206 = (cp(9, i) - cp(2, i)) - spike * sk[i206];
      const den = cp(13, i) - cp(6, i);
      let valid = true;
      let lg75 = 0, le75 = 0, lg68 = 0, le68 = 0, c75 = 0, c68 = 0;
      if (den === 0) {
        valid = false;                        // 该分支分母为零（正常数据不会走到）
      } else {
        const cr75 = f207_235 * AG_R_U * corr207 / den;
        const cr68 = f206_238 * corr206 / den;
        const cSpikeBase = (method === 2) ? cp(4, i) : cp(1, i);
        const errSpike = Math.sqrt((cSpikeBase / spike) * (cSpikeBase / spike) + 0.0004);
        const err206 = Math.sqrt(cp(2, i) * cp(2, i)
          + (errSpike * spike * sk[i206]) * (errSpike * spike * sk[i206])) / corr206;
        const err207 = Math.sqrt(cp(3, i) * cp(3, i)
          + (errSpike * spike * sk[i207]) * (errSpike * spike * sk[i207])) / corr207;
        const e750 = Math.sqrt(err207 * err207 + (cp(6, i) / den) * (cp(6, i) / den));
        const e680 = Math.sqrt(err206 * err206 + (cp(6, i) / den) * (cp(6, i) / den));
        const c75e0 = Math.sqrt(e750 * e750 + std_75_2s * std_75_2s) * cr75;
        const c68e0 = Math.sqrt(e680 * e680 + std_68_2s * std_68_2s) * cr68;
        lg75 = dlog(Math.abs(cr75 + 1)) / AG_LAM235 / 1e6;
        le75 = lg75 * (c75e0 / cr75);
        lg68 = dlog(Math.abs(cr68 + 1)) / AG_LAM238 / 1e6;
        le68 = lg68 * (c68e0 / cr68);
        c75 = dexp(AG_LAM235 * lg75 * 1e6) - 1;
        c68 = dexp(AG_LAM238 * lg68 * 1e6) - 1;
      }
      if (valid) {
        mid4 = [lg75, le75, lg68, le68];
        tail6 = ['----', c75, c75 * le75 / lg75, c68, c68 * le68 / lg68, rho];
      } else {
        mid4 = [0, 0, 0, 0];
        tail6 = ['----', 0, 0, 0, 0, rho];
      }
    } else {
      // method === 4（Cal 204Pb）。分母只由三个普通铅参数决定，参数取得不好
      // （例如 207/204 恰等于 206/204×放射性比）会整体为零 —— 原实现不判，
      // 会得到 ±Inf 一路传成 NaN；这里显式置 NaN 并计数，正常数据不受影响。
      const denC = cfg.commonPb207_204 - cfg.commonPb206_204 * cfg.radioactiveSPb207_206;
      let Cal204Pb;
      if (denC === 0 || !isFinite(denC)) {
        Cal204Pb = NaN;
        warn.divZero++;
      } else {
        Cal204Pb = Math.abs((d(17, i) - d(18, i) * cfg.radioactiveSPb207_206) / denC);
      }
      const lg68 = dlog(Math.abs(
        f206_238 * (d(18, i) - Cal204Pb * cfg.commonPb206_204) / d(14, i) + 1))
        / AG_LAM238 / 1e6;
      const le68 = lg68 * Math.sqrt((d3 / r68raw) * (d3 / r68raw) + eV * eV);
      const lg75 = dlog(Math.abs(
        f207_235 * (d(17, i) - Cal204Pb * cfg.commonPb207_204) / d(14, i) / AG_R_U + 1))
        / AG_LAM235 / 1e6;
      const le75 = lg75 * Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV);
      const lg82 = dlog(Math.abs(
        f208_232 * (d(16, i) - cfg.commonPb208_204 * Cal204Pb) / d(15, i) + 1))
        / AG_LAM232 / 1e6;
      const le82 = lg82 * Math.sqrt((d7 / R82) * (d7 / R82) + eV * eV);
      const c68 = dexp(AG_LAM238 * lg68 * 1e6) - 1;
      const c75 = dexp(AG_LAM235 * lg75 * 1e6) - 1;
      const c82 = dexp(AG_LAM232 * lg82 * 1e6) - 1;
      void c75; void c68; void c82;        // 原代码算了但没进表
      mid4 = [lg68, le68, lg82, le82];
      tail6 = ['----', '', '', '', '', ''];
    }

    const row = [
      ctx.fileNames[i], ctx.names[i], R76, d1, r68raw, d3,
      R75, d5, R82, d7, R86, d(9, i), R26, d(11, i), R84, d(13, i),
      sep17, a68, e68, a75, e75, a82, e82, A76, A76e,
      ctx.comments[ctx.fileNames[i]],
    ]
      .concat(mid4)
      .concat([
        '------------',
        (1 / r68raw),
        (1 / r68raw) * Math.sqrt((d3 / r68raw) * (d3 / r68raw) + eV * eV),
        R76, d1, '-------------',
        R75, Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV) * R75,
        R68, Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV) * R68,
        rho, '-------------',
        R82, Math.sqrt((d7 / R82) * (d7 / R82) + eV * eV) * R82,
        R86, d(9, i), '-------------',
        Math.abs(d(14, i) * coef[0]),
        d(15, i) * coef[1],
        (d(16, i) + d(17, i) + d(18, i)) * coef[2],
      ])
      .concat(tail6);

    rows.push(row.slice(0, 51));
  }
  return { header: headerFor(false, method), rows, warnings: warn, factors: {
    f207_206, f206_238, f207_235, f208_232, std_68_2s, std_75_2s,
  }, coefficients: coef };
}

/* ==========================================================================
 *  线性法：Age_Calculate()（相邻标样插值 SSB）
 * ========================================================================== */

/** 把升序下标切成"连续段"，对应原代码的 func()。 */
function splitRuns(lst) {
  let cur = lst;
  const out = [];
  for (let k = 0; k + 1 < lst.length; k++) {
    const j = lst[k + 1];
    if (j - lst[k] > 1) {
      const at = cur.indexOf(j);
      out.push(cur.slice(0, at));
      cur = cur.slice(at);
    }
  }
  out.push(cur);
  return out;
}

function linearAge(input) {
  const ctx = prep(input);
  const cfg = ctx.cfg;
  const eV = cfg.excessV;
  const method = cfg.method;
  const d = (k, i) => ctx.dateAll[k][i];
  const coef = coefficients(ctx, true);      // 线性法带 '610'/'612'/'614' 短别名
  const solve76 = input.fix76 ? AG.age76PbFixed : AG.age76Pb;
  const warn = { divZero: 0 };               // 分母为零而无法校正的行数

  const myix = [], myiy = [];
  for (let i = 0; i < ctx.n; i++) {
    (ctx.names[i] === cfg.standard ? myix : myiy).push(i);
  }
  const classStd = splitRuns(myix);
  const classSample = splitRuns(myiy);

  /**
   * factor()：标样段的均值倒数。注意它**会就地改写 classStd**
   * （append / insert 的语义原样保留 —— A、B 两套因子的下标错位正是靠这个补偿的）。
   */
  const factor = (SEP, standV, col) => {
    const seg = () => {
      const g = classStd[SEP];
      return standV / pMeanRange(ctx.dateAll[col], g[0], g[g.length - 1] + 1);
    };
    if (classStd.length === classSample.length) {
      if (classStd[0][0] === 0) {
        classStd.push(classStd[classStd.length - 1]);
      } else {
        classStd.unshift(classStd[0]);
      }
      return seg();
    }
    if (classStd.length < classSample.length) {
      classStd.push(classStd[classStd.length - 1]);
      classStd.unshift(classStd[0]);
      return seg();
    }
    return seg();
  };

  const rows = [];
  for (let SEP = 0; SEP < classSample.length; SEP++) {
    const each = classSample[SEP];
    const n = each.length;
    let w1 = 1;

    const f207_206A = factor(SEP, cfg.P382, 0);
    const f206_238A = factor(SEP, cfg.a, 2);
    const f207_235A = factor(SEP, cfg.b, 4);
    const f208_232A = factor(SEP, cfg.c, 6);
    const f232_206A = 1 / f208_232A;
    const f207_206B = factor(SEP + 1, cfg.P382, 0);
    const f206_238B = factor(SEP + 1, cfg.a, 2);
    const f207_235B = factor(SEP + 1, cfg.b, 4);
    const f208_232B = factor(SEP + 1, cfg.c, 6);
    const f232_206B = 1 / f208_232B;

    for (const i of each) {
      const d1 = d(1, i), d2 = d(2, i), d3 = d(3, i), d5 = d(5, i), d7 = d(7, i);
      const wa = w1 / n, wb = 1 - (w1 / n);
      // 乘序照抄：((d*(w1/n))*fB) + ((d*(1-(w1/n)))*fA)
      const R76 = d(0, i) * wa * f207_206B + d(0, i) * wb * f207_206A;
      const R68 = d(2, i) * wa * f206_238B + d(2, i) * wb * f206_238A;
      const R75 = d(4, i) * wa * f207_235B + d(4, i) * wb * f207_235A;
      const R82 = d(6, i) * wa * f208_232B + d(6, i) * wb * f208_232A;
      const R86 = d(8, i) * wa * 1 + d(8, i) * wb * 1;
      const R26 = d(10, i) * wa * f232_206B + d(10, i) * wb * f232_206A;
      const R84 = d(12, i) * wa * 1 + d(12, i) * wb * 1;
      const rho = rhoOf(d1, d3, d5, R68, R75, R76, eV);

      // 未校正年龄：线性法一律用 result_cal_206Pb_238U
      const a68 = dlog(Math.abs(R68 + 1)) / AG_LAM238 / 1e6;
      const e68 = Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV) * a68;
      const a75 = dlog(Math.abs(R75 + 1)) / AG_LAM235 / 1e6;
      const e75 = Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV) * a75;
      const a82 = dlog(Math.abs(R82 + 1)) / AG_LAM232 / 1e6;
      const e82 = Math.sqrt((d7 / R82) * (d7 / R82) + eV * eV) * a82;
      const A76 = solve76(R76);
      const A76e = solve76(R76 + d1) - A76;

      let mid4, tail6;
      let sep17 = '------------';
      if (method === 0) {
        mid4 = ['None', 'None', 'None', 'None'];
        tail6 = ['', '', '', '', '', ''];
      } else if (method === 1) {
        const q = (R76 - cfg.radioactivePb) / (cfg.commonPb - cfg.radioactivePb);
        const lg75 = dlog(Math.abs(
          R75 - q * cfg.commonPb * AG_R_U * R68 + 1)) / AG_LAM235 / 1e6;
        // 误差项：入表的那一份用的是**校正后**比值（原代码 line 1055/1056），
        // 与函数里那个局部变量 Corr_7_5_age_erro（用未校正的 date_all[4]）不同 ——
        // 局部变量没进表，所以以入表版本为准。
        const le75 = lg75 * Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV);
        const lg68 = (dlog(Math.abs((1 - q) * R68) + 1) / AG_LAM238) / 1e6;
        const le68 = lg68 * Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV);
        const c75 = dexp(AG_LAM235 * lg75 * 1e6) - 1;
        const c68 = dexp(AG_LAM238 * lg68 * 1e6) - 1;
        mid4 = [lg75, le75, lg68, le68];
        tail6 = ['-----', c75, c75 * le75 / lg75, c68, c68 * le68 / lg68, rho];
      } else if (method === 2 || method === 3) {
        // 两个分支都要除以 R86（204 通道推出来的比值）。204 计数为 0 时
        // 原实现会把 ±Inf 一路传成 NaN；这里显式置 NaN 并计数。
        if (R86 === 0 || !isFinite(R86)) {
          warn.divZero++;
          mid4 = [NaN, NaN, NaN, NaN];
          tail6 = (method === 2)
            ? ['-----', NaN, NaN, NaN, NaN, rho]
            : ['', '', '', '', '', rho];
        } else if (method === 2) {
        const lg75 = dlog(Math.abs(
          R75 * (R76 / R86 - cfg.commonPb207_208) / (R76 / R86) + 1))
          / AG_LAM235 / 1e6;
        const le75 = lg75 * ((Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV) * R75)
          / R75 * 100) / 100;
        const lg68 = dlog(Math.abs(
          R68 * (1 / R86 - cfg.commonPb206_208) / (1 / R86) + 1))
          / AG_LAM238 / 1e6;
        const le68 = lg68 * ((Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV) * R68)
          / R68 * 100) / 100;
        const c75 = dexp(AG_LAM235 * lg75 * 1e6) - 1;
        const c68 = dexp(AG_LAM238 * lg68 * 1e6) - 1;
        mid4 = [lg75, le75, lg68, le68];
        tail6 = ['-----', c75, c75 * le75 / lg75, c68, c68 * le68 / lg68, rho];
      } else {
        const lg75 = dlog(Math.abs(
          R75 * (R76 * R84 / R86 - cfg.commonPb207_204) / (R76 * R84 / R86) + 1))
          / AG_LAM235 / 1e6;
        const le75 = lg75 * ((Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV) * R75)
          / R75 * 100) / 100;
        const lg68 = dlog(Math.abs(
          R68 * (R84 / R86 - cfg.commonPb206_204) / (R84 / R86) + 1))
          / AG_LAM238 / 1e6;
        const le68 = lg68 * ((Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV) * R68)
          / R68 * 100) / 100;
        mid4 = [lg75, le75, lg68, le68];
        tail6 = ['', '', '', '', '', rho];
      }
      } else {
        // method === 4（Cal 204Pb）。分母只由三个普通铅参数决定，参数取得不好
        // 会整体为零 —— 原实现不判，±Inf 一路传成 NaN；这里显式置 NaN 并计数。
        const denC = cfg.commonPb207_204 - cfg.commonPb206_204 * cfg.radioactiveSPb207_206;
        let Cal204Pb;
        if (denC === 0 || !isFinite(denC)) {
          Cal204Pb = NaN;
          warn.divZero++;
        } else {
          Cal204Pb = Math.abs((d(17, i) - d(18, i) * cfg.radioactiveSPb207_206) / denC);
        }
        const lg68 = dlog(Math.abs(
          f206_238A * (d(18, i) - Cal204Pb * cfg.commonPb206_204) / d(14, i) + 1))
          / AG_LAM238 / 1e6;
        const le68 = lg68 * Math.sqrt(
          (d3 / (d2 * f206_238A)) * (d3 / (d2 * f206_238A)) + eV * eV);
        const lg82 = dlog(Math.abs(
          f208_232A * (d(16, i) - cfg.commonPb208_204 * Cal204Pb) / d(15, i) + 1))
          / AG_LAM232 / 1e6;
        const le82 = lg82 * Math.sqrt((d7 / R82) * (d7 / R82) + eV * eV);
        mid4 = [lg68, le68, lg82, le82];
        const t1 = 137.818 * ((d(17, i) - Cal204Pb * cfg.commonPb207_204) / d(14, i))
          * f207_235A;
        const t2 = (Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV)) * 137.818
          * ((d(17, i) - Cal204Pb * cfg.commonPb207_204) / d(14, i)) * f207_235A;
        const t3 = f206_238A * (d(18, i) - Cal204Pb * cfg.commonPb206_204) / d(14, i);
        const t4 = (Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV)) * f206_238A
          * (d(18, i) - Cal204Pb * cfg.commonPb206_204) / d(14, i);
        tail6 = ['', t1, t2, t3, t4, rho];
      }
      if (method === 1 || method === 2 || method === 3 || method === 4) sep17 = '-------------';

      const row = [
        ctx.fileNames[i], ctx.names[i], R76, d1, R68, d3,
        R75, d5, R82, d7, R86, d(9, i), R26, d(11, i), R84, d(13, i),
        sep17, a68, e68, a75, e75, a82, e82, A76, A76e,
        ctx.comments[ctx.fileNames[i]],
      ]
        .concat(mid4)
        .concat([
          '------------',
          (1 / R68),
          (1 / R68) * (Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV) * R68) / R68,
          R76, d1, '------------',
          R75, R75 * Math.sqrt((d5 / R75) * (d5 / R75) + eV * eV),
          R68, Math.sqrt((d3 / R68) * (d3 / R68) + eV * eV) * R68,
          rho, '------------',
          R82, d7, R86, d(9, i), '       ',
          Math.abs(d(14, i) * coef[0]),
          d(15, i) * coef[1],
          (d(16, i) + d(17, i) + d(18, i)) * coef[2],
        ])
        .concat(tail6);

      rows.push(row.slice(0, 51));
      w1 = w1 + 1;
    }
  }
  return { header: headerFor(true, method), rows, warnings: warn,
    coefficients: coef,
    groups: { std: classStd, sample: classSample } };
}

const DS_AGE = {
  attach, pMean, pStd1, pMeanRange, coefficients, headerFor,
  averageAge, linearAge, splitRuns,
  parseResultAllCsv, parseMeanCpsCsv, buildInput, USE_COLS_RESULT,
  AG_LAM238, AG_LAM235, AG_LAM232, AG_R_U,
};
if (typeof window !== 'undefined') {
  window.DS_AGE = DS_AGE;
  Object.assign(window.DS = window.DS || {}, DS_AGE);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_AGE;
