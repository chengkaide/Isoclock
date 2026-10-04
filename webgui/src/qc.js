/* ==========================================================================
 *  qc.js —— 一批数据的质量总览（出报告用的数据层）
 *
 *  这个模块做三件事：
 *    ① 把年龄层那张 51 列的表按**样品名**归组，对每组算加权平均年龄与 MSWD；
 *    ② 用这些量给每个标样做 QC（测出值 vs 给定真值），给每个样品打等级；
 *    ③ 收集"哪里可能有问题"的线索，逐条指到具体文件名。
 *
 *  【两件必须先说清楚的事】
 *
 *  1. 加权平均与 MSWD **不是桌面版 Isoclock 的输出**。
 *     桌面版只给逐点的年龄，从不做归组统计。这里新增的算法照 Wendt & Carl (1991)
 *     与 Isoplot 手册（Ludwig）第 3 章 "weighted average" 的写法：
 *
 *         w_i  = 1 / σ_i²                σ_i 是**1σ**
 *         μ    = Σ(w_i·x_i) / Σ w_i
 *         se   = 1 / sqrt(Σ w_i)                      内部误差
 *         MSWD = Σ((x_i-μ)/σ_i)² / (n-1)
 *         MSWD>1 时   σ_外部 = se · sqrt(MSWD)        过散放大
 *
 *     Isoplot 在算加权平均时，若 MSWD>1 会把误差乘 sqrt(MSWD) 再报出去（"外部误差"）。
 *     本模块两者都算：se 是内部误差，seExt 是放大后的。报告里这四类数字都会标成
 *     **网页版新增**，与桌面版输出分开看，免得被当成原程序的结论。
 *
 *  2. 年龄表里的 `2s` 列是 **2σ**（列名就写着 2s，原程序按 95% 置信算的）。
 *     加权平均与 MSWD 一律按**1σ**算，所以内部先把 2s 除以 2。
 *     不换算的话 MSWD 会小 4 倍、误差小 2 倍 —— 看着很"漂亮"，是假的。
 * ========================================================================== */
'use strict';

/* ==========================================================================
 *  一、年龄表的列布局
 *
 *  下标是 0 基，与 age.js 的 headerFor()/baseHeader() 一一对应：
 *
 *      17/18  206Pb_238U Age(Ma) / 2s          19/20  207Pb_235U Age(Ma) / 2s
 *      21/22  208Pb_232Th  Age(Ma) / 2s        23/24  207Pb_206Pb  Age(Ma) / 2s
 *      26/27  校正路径的第 1 个年龄 / 2s       28/29  校正路径的第 2 个年龄 / 2s
 *
 *  ⚠ 第 25 列（0 基）**表头与内容不一致**（沿用自原程序）：表头写的是 `…Pb Corr. Age(Ma)`，
 *  但数据里那一列装的是备注字符串（见 age.js 的 row 构造：尾部 concat 之前放的
 *  是 ctx.comments[...]）。所以校正后的年龄**不在第 25 列**，而在 26/28 列。
 *  checkLayout() 会把这件事显式报出来 —— 上一版界面里就有人（我）拿 r[25] 当
 *  校正年龄用，结果备注一非空就虚报"校正后年龄是 NaN"。
 * ========================================================================== */

const QC_KEY68 = '206Pb/238U';
const QC_KEY75 = '207Pb/235U';
const QC_KEY82 = '208Pb/232Th';
const QC_KEY76 = '207Pb/206Pb';

/** 未校正年龄的列（下标），四个都在表里，与 method 无关。 */
const QC_UNCORR_COL = {
  '206Pb/238U': 17, '207Pb/235U': 19, '208Pb/232Th': 21, '207Pb/206Pb': 23,
};

/**
 * 校正后年龄的列（下标）。只对 method 1–4 存在，且**每条路径给的两个年龄不一样**：
 *  method 1/2/3（207Pb / 208Pb / 204Pb 校正）→ 先 207Pb/235U，再 206Pb/238U
 *  method 4（Cal 204Pb 校正）              → 先 206Pb/238U，再 208Pb/232Th
 * 依据是 age.js 里 mid4 的排列顺序（lg75,le75,lg68,le68 与 lg68,le68,lg82,le82），
 * 与 Isoclock2.0.py 第 765-791 行的表头写法一致。
 */
const QC_CORR_COL = {
  1: { '207Pb/235U': 26, '206Pb/238U': 28 },
  2: { '207Pb/235U': 26, '206Pb/238U': 28 },
  3: { '207Pb/235U': 26, '206Pb/238U': 28 },
  4: { '206Pb/238U': 26, '208Pb/232Th': 28 },
};

/** 误差列恒在年龄列 +1（17/18、19/20、21/22、23/24、26/27、28/29 全是这个关系）。 */
const QC_ERR_OFFSET = 1;

/** 该校正方式下能拿到的年龄种类（顺序即界面下拉的顺序）。 */
function qcAgeKeys(method) {
  const out = [QC_KEY68, QC_KEY75, QC_KEY82, QC_KEY76];
  const c = QC_CORR_COL[method];
  if (c) {
    for (const k of Object.keys(c)) if (out.indexOf(k) < 0) out.push(k);
  }
  return out;
}

/** 某个年龄种类在该校正方式下的列号；拿不到返回 null。 */
function qcAgeCol(method, key, corrected) {
  if (corrected) {
    const c = QC_CORR_COL[method];
    if (c && c[key] !== undefined) return c[key];
    return null;
  }
  return QC_UNCORR_COL[key] === undefined ? null : QC_UNCORR_COL[key];
}

/**
 * 定出"用哪一种年龄"。prefer 是界面上选的种类，认不出来就用 ²⁰⁶Pb/²³⁸U。
 *
 * 这是**按锆石 U-Pb 的常规做法**选的，不是原程序的规定（原程序只输出、不选）：
 *   · 该种类有校正后的列（method 1–4）→ 用校正后的；
 *   · 没有（method 0，或者该种类不在校正路径给的两种里）→ 用未校正的那一列。
 * 注意 ²⁰⁷Pb/²⁰⁶Pb 永远只能取未校正的：原实现那四条校正路径只校正
 * ²⁰⁷Pb/²³⁵U 与 ²⁰⁶Pb/²³⁸U，从不校正 ²⁰⁷Pb/²⁰⁶Pb。
 */
function qcDefaultAge(method, prefer) {
  const key = (prefer && QC_UNCORR_COL[prefer] !== undefined) ? prefer : QC_KEY68;
  if (qcAgeCol(method, key, true) !== null) return { key: key, corrected: true };
  return { key: key, corrected: false };
}

/**
 * 核对表头与列布局是否仍然对得上。
 *
 * 这个自检是**故意的防呆**：只要有人动了 age.js 的列顺序，报告就会立刻说不一致，
 * 而不是拿着错列的数字算出一份看起来很像样的报告。
 *
 * @returns {{problems: string[], notes: string[]}}
 */
function qcCheckLayout(header, method) {
  const problems = [];
  const notes = [];
  const has = (i, sub) => String(header[i] === undefined ? '' : header[i]).indexOf(sub) >= 0;
  const want = (i, sub, what) => {
    if (!has(i, sub)) {
      problems.push('第 ' + (i + 1) + ' 列应当是「' + what + '」（含 "' + sub + '"），'
        + '实际是 "' + header[i] + '"');
    }
  };
  want(17, '206Pb_238U', '206Pb/238U 年龄');
  want(18, '2s', '206Pb/238U 的 2s');
  want(19, '207Pb_235U', '207Pb/235U 年龄');
  want(21, '208Pb_232Th', '208Pb/232Th 年龄');
  want(23, '207Pb_206Pb', '207Pb/206Pb 年龄');
  if (method > 0) {
    const c = QC_CORR_COL[method];
    if (!c) {
      problems.push('未知的 Pb 校正方式 method=' + method);
    } else {
      for (const k of Object.keys(c)) {
        const i = c[k];
        want(i, k.replace('/', '_'), '校正后的 ' + k + ' 年龄');
        want(i + QC_ERR_OFFSET, '2s', '校正后的 ' + k + ' 的 2s');
      }
    }
    // 表头第 25 列写着校正年龄，数据却放备注（沿用自原程序），报告里要说出来
    if (has(25, 'Corr. Age')) {
      notes.push('表头第 26 列（1 起算）写着「' + header[25] + '」，但数据里那一列装的是'
        + '备注文字而不是年龄 —— 表头与内容不一致（沿用自原程序），校正后的年龄实际在'
        + '第 27 / 29 列。本报告按实际列位置取数。');
    }
  }
  return { problems: problems, notes: notes };
}

/* ==========================================================================
 *  二、加权平均与 MSWD
 * ========================================================================== */

/**
 * 加权平均。
 *
 * @param {Array<{age:number, s2:number}>} pairs  s2 是表里的 **2σ**
 * @returns {{n:number, mean:number, se:number, chi2:number, dof:number,
 *            mswd:number, seExt:number, dropped:number}}
 *   n        参与点数（年龄与误差都有限的点）
 *   mean     加权平均（1σ 加权，与用 2σ 加权得到的均值相同 —— 差一个常数因子）
 *   se       内部标准误（1σ）
 *   mswd     Σ((x-μ)/σ)²/(n-1)，期望值为 1；n<2 时为 NaN
 *   seExt    过散放大后的误差：MSWD>1 时 se·sqrt(MSWD)
 *   dropped  因年龄或误差非有限而剔除的点数
 */
function qcWavg(pairs) {
  let sw = 0, swx = 0, n = 0, dropped = 0;
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i].age, s2 = pairs[i].s2;
    if (!Number.isFinite(a) || !Number.isFinite(s2) || s2 <= 0) { dropped++; continue; }
    const s1 = s2 / 2;                       // 2σ → 1σ
    const w = 1 / (s1 * s1);
    sw += w; swx += w * a; n++;
  }
  if (!n) {
    return { n: 0, mean: NaN, se: NaN, chi2: NaN, dof: 0, mswd: NaN, seExt: NaN, dropped };
  }
  const mean = swx / sw;
  const se = Math.sqrt(1 / sw);
  let chi2 = 0;
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i].age, s2 = pairs[i].s2;
    if (!Number.isFinite(a) || !Number.isFinite(s2) || s2 <= 0) continue;
    const z = (a - mean) / (s2 / 2);
    chi2 += z * z;
  }
  const dof = n - 1;
  const mswd = dof > 0 ? chi2 / dof : NaN;
  const seExt = (Number.isFinite(mswd) && mswd > 1) ? se * Math.sqrt(mswd) : se;
  return { n, mean, se, chi2, dof, mswd, seExt, dropped };
}

/**
 * MSWD 的判据上限。
 *
 * MSWD 在"单一年龄母体"假设下服从 χ²/(n-1)，其取样分布的标准差约 sqrt(2/(n-1))。
 * 所以取 **1 + 2·sqrt(2/(n-1))** 作为界限（约 95%，Wendt & Carl 1991 的做法）。
 * n=2 时这个界限是 3.0，n 小的时候天然很宽 —— 这是对的，不是 bug。
 *
 * @param {number} n 参与点数
 * @param {number} fixed 用户指定的固定上限；给了就用它（0 或非数字表示不用）
 */
function qcMswdLimit(n, fixed) {
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  const dof = n - 1;
  if (dof < 1) return Infinity;
  return 1 + 2 * Math.sqrt(2 / dof);
}

/** 单点对加权平均的标准残差 (x-μ)/σ（σ 为 1σ）。 */
function qcStdResiduals(pairs, mean) {
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i].age, s2 = pairs[i].s2;
    out.push((Number.isFinite(a) && Number.isFinite(s2) && s2 > 0)
      ? (a - mean) / (s2 / 2) : NaN);
  }
  return out;
}

/* ==========================================================================
 *  三、默认判据
 *
 *  这些数字都是**经验阈值**，不是原程序的规定，也不来自某条物理定律。
 *  每一项在报告和界面上都写清楚"它是什么、为什么取这个值"，并且可以在界面上改。
 * ========================================================================== */
const QC_DEFAULT_THRESHOLDS = {
  stdDevPct: 2.0,     // 标样测出值与真值的相对偏差上限（%）
  mswdMax: 0,         // 0 = 按 1+2√(2/(n-1)) 自动；>0 则全部用它
  rel2sMax: 10.0,     // 单点年龄的 2s 相对误差上限（%）
  outlierZ: 3.0,      // 单点标准残差 |z| 超过它算离群候选
};

/** 阈值的中文说明，界面上用同一份。 */
const QC_THRESHOLD_DOC = [
  { k: 'stdDevPct', label: '标样相对偏差上限', unit: '%', def: 2.0,
    what: '标样测出的加权平均年龄，与你在②里填的标样真值相比，允许差多少。',
    why: '常见做法是要求标样再现性优于 2%，但「不同实验室要求不同」，请按你们的惯例改。' },
  { k: 'mswdMax', label: 'MSWD 上限', unit: '', def: 0,
    what: '每个样品/标样内部，各测点年龄之间的一致性。填 0 表示按点数自动算：'
      + '1 + 2·√(2/(n-1))。',
    why: 'MSWD 的期望值是 1。它在"单一年龄母体"假设下服从 χ²/(n-1)，'
      + '取样分布的标准差约为 √(2/(n-1))，所以自动界限取 1+2σ（约 95% 置信）。'
      + '点数少时界限天然很宽，这是应当的。' },
  { k: 'rel2sMax', label: '单点相对误差上限', unit: '%', def: 10.0,
    what: '单个测点的年龄误差（表里的 2s）占年龄的比例。超了说明这个点信号太弱。',
    why: '经验值。相对误差大的点往往 ²⁰⁶Pb 计数低或积分窗口没取好，'
      + '会拖着整个样品的加权平均。' },
  { k: 'outlierZ', label: '离群判据 |z|', unit: '', def: 3.0,
    what: '单个测点与所在样品加权平均的偏离，用该点自身的误差衡量'
      + '（z=(x-μ)/σ，σ 取 1σ）。',
    why: '3σ 是常规的离群提示线。「它只是提示，不是自动剔除」—— '
      + '报告不会替你删点，删不删要结合铅丢失、包裹体、信号图判断。' },
];

/* ==========================================================================
 *  四、分组
 * ========================================================================== */

/**
 * 按样品名把年龄表分组。
 *
 * 分组键是年龄表第 1 列（样品名），不是文件名 —— 同一样品常有多行。
 * 顺序按**首次出现**排，这样报告里样品的先后与数据顺序一致，便于对照。
 */
function qcGroupBySample(rows) {
  const order = [];
  const map = {};
  for (let i = 0; i < rows.length; i++) {
    const name = String(rows[i][1]);
    if (!map[name]) { map[name] = []; order.push(name); }
    map[name].push(rows[i]);
  }
  const out = [];
  for (const name of order) out.push({ name: name, rows: map[name] });
  return out;
}

/* 等级：三个字母分别是正常 / 要注意 / 不合格，报告里用绿黄红三种颜色 */
const QC_LEVELS = { OK: 'ok', WARN: 'warn', BAD: 'bad' };

/** 把若干条判据合成一个总等级。 */
function qcWorst(levels) {
  let out = QC_LEVELS.OK;
  for (const l of levels) {
    if (l === QC_LEVELS.BAD) return QC_LEVELS.BAD;
    if (l === QC_LEVELS.WARN) out = QC_LEVELS.WARN;
  }
  return out;
}

/* ==========================================================================
 *  五、主入口
 * ========================================================================== */

/**
 * 跑完整套 QC。
 *
 * @param {object} ctx
 *   header      年龄表表头（51 列）
 *   rows        年龄表的行
 *   method      Pb 校正方式 0–4
 *   ageKey      用哪个年龄做统计（'206Pb/238U' 等）
 *   ageCorrected 是否用校正后的年龄
 *   stdName     标样名（②里填的那个，年龄层用它认标样）
 *   stdAge      标样真值（Ma）
 *   fracStd     分馏校正标样名
 *   nistStd     微量元素外标名
 *   algo        'avg' | 'lin'
 *   instrument  'thermo' | 'agilent'
 *   sampleNames {文件: 样品名}
 *   meanRows    两个 CSV 的行（Mean_Cps），用于信号质量
 *   num         {文件: [Numbers,b0,b1,s0,s1]}，积分窗口
 *   coefficients 微量元素系数 [U, Th, Pb]
 *   factors     {f207_206, f206_238, f207_235, f208_232, std_68_2s, std_75_2s}
 *   divZero     204 路径分母为零的行数
 *   fileNotes   {文件: [提示]} 读取时的提示（如兼容模式、缺列补零）
 *   fixed76     是否用了 207Pb/206Pb 迭代修正
 *   thresholds  见 QC_DEFAULT_THRESHOLDS
 *
 * @returns 一个有 samples / standards / anomalies / summary 的对象，供 report.js 排版
 */
function qcAnalyze(ctx) {
  const th = Object.assign({}, QC_DEFAULT_THRESHOLDS, ctx.thresholds || {});
  const method = ctx.method >>> 0;
  const ageCol = qcAgeCol(method, ctx.ageKey, ctx.ageCorrected);
  const errCol = ageCol === null ? null : ageCol + QC_ERR_OFFSET;

  const layout = qcCheckLayout(ctx.header, method);
  const anomalies = [];

  function anomaly(level, kind, text, files) {
    anomalies.push({ level: level, kind: kind, text: text, files: files || [] });
  }

  if (layout.problems.length) {
    anomaly(QC_LEVELS.BAD, '列布局', '年龄表的列与预期不符，报告里的年龄可能取错列：'
      + layout.problems.join('；'), []);
  }

  /* ---- 5.1 逐样品归组统计 ---- */
  const groups = qcGroupBySample(ctx.rows);
  const stats = [];
  for (const g of groups) {
    const pairs = g.rows.map(function (r) {
      return { age: ageCol === null ? NaN : r[ageCol],
        s2: errCol === null ? NaN : r[errCol] };
    });
    const w = qcWavg(pairs);
    const z = qcStdResiduals(pairs, w.mean);
    const outIdx = [];
    for (let i = 0; i < z.length; i++) {
      if (Number.isFinite(z[i]) && Math.abs(z[i]) > th.outlierZ) outIdx.push(i);
    }
    // 单点相对误差（2s/age）
    let relMax = 0, relBad = 0;
    for (const p of pairs) {
      if (!Number.isFinite(p.age) || !Number.isFinite(p.s2) || p.age === 0) continue;
      const rel = Math.abs(p.s2 / p.age) * 100;
      if (rel > relMax) relMax = rel;
      if (rel > th.rel2sMax) relBad++;
    }
    const wLimit = qcMswdLimit(w.n, th.mswdMax);
    /* 判据不只给等级，还要给「为什么」——
     * 否则报告里会出现「偏差 0.0000%」却标着警告这种看着自相矛盾的行。 */
    const reasons = [];
    if (w.n === 0) {
      reasons.push({ level: QC_LEVELS.BAD, why: '这一组没有一个年龄是有限数，算不出加权平均。'
        + '先查年龄缺失的那几条异常。' });
    } else if (w.n === 1) {
      reasons.push({ level: QC_LEVELS.WARN, why: '只有 1 个有效点：均值就等于那一个点，'
        + 'MSWD 无从判断，这一组的"一致性"其实没被检验过。' });
    }
    if (Number.isFinite(w.mswd) && w.mswd > wLimit) {
      reasons.push({ level: QC_LEVELS.WARN,
        why: 'MSWD = ' + qcNum(w.mswd, 2) + '，超过上限 '
          + (Number.isFinite(wLimit) ? qcNum(wLimit, 2) : '∞')
          + '（' + w.n + ' 个点。界限 = 1 + 2·√(2/(n−1))）：'
          + '点与点之间比各自的误差所允许的更分散 —— 可能是混了不同年龄的域，'
          + '也可能是误差被低估（比如普通铅校正没走完）。' });
    }
    if (relBad) {
      reasons.push({ level: QC_LEVELS.WARN,
        why: relBad + ' 个点的年龄相对误差超过 ' + qcNum(th.rel2sMax, 1) + '%'
          + '（最大的一个 ' + qcNum(relMax, 1) + '%）：这些点信号弱，'
          + '会把所在样品的加权平均往自己那边拖。' });
    }
    if (outIdx.length) {
      reasons.push({ level: QC_LEVELS.WARN,
        why: outIdx.length + ' 个点的 |z| 超过 ' + qcNum(th.outlierZ, 1)
          + '，是离群候选：这只是提示，报告不会替你剔点，'
          + '要不要删得结合信号图与铅丢失情况判断。' });
    }
    stats.push({
      name: g.name, n: g.rows.length, used: w.n, dropped: w.dropped,
      mean: w.mean, se: w.se, seExt: w.seExt, mswd: w.mswd, chi2: w.chi2, dof: w.dof,
      mswdLimit: wLimit, relMax: relMax, relBad: relBad,
      outliers: outIdx.map(function (i) { return g.rows[i][0]; }),
      reasons: reasons,
      level: qcWorst(reasons.map(function (r) { return r.level; })),
      files: g.rows.map(function (r) { return r[0]; }),
    });
  }

  /* ---- 5.2 标样 QC ---- */
  const isStd = function (s) { return s.name === ctx.stdName; };
  const stds = stats.filter(isStd).map(function (s) {
    const dev = s.mean - ctx.stdAge;
    const devPct = ctx.stdAge ? dev / ctx.stdAge * 100 : NaN;
    /* 偏差这一条放最前面：标样 QC 就是看它。后面再继承 5.1 里那几条
     * （MSWD / 离群 / 单点相对误差），这样报告的"为什么"栏目不会
     * 出现"偏差为 0 却标警告"这种看不出原因的行。 */
    const reasons = [];
    if (!s.used) {
      reasons.push({ level: QC_LEVELS.BAD,
        why: '标样「' + ctx.stdName + '」没有可用测点，加权平均年龄算不出来 —— '
          + '分馏因子失去依据，下面所有样品的年龄都不可信。' });
    } else if (!(Math.abs(devPct) <= th.stdDevPct)) {
      const lv = Math.abs(devPct) <= th.stdDevPct * 2 ? QC_LEVELS.WARN : QC_LEVELS.BAD;
      reasons.push({ level: lv,
        why: '测出 ' + qcNum(s.mean, 1) + ' Ma，与真值 ' + qcNum(ctx.stdAge, 1)
          + ' Ma 相差 ' + (dev > 0 ? '+' : '') + qcNum(devPct, 2) + '%，'
          + (lv === QC_LEVELS.BAD
            ? '已超过上限 ' + qcNum(th.stdDevPct, 1) + '% 的两倍。'
            : '超过上限 ' + qcNum(th.stdDevPct, 1) + '%。')
          + '标样再现性不好说明整批的分馏校正有问题。' });
    }
    for (const r of s.reasons) reasons.push(r);
    if (s.used >= 1 && s.used < 3) {
      reasons.push({ level: QC_LEVELS.WARN,
        why: '标样只有 ' + s.used + ' 个有效点：分馏因子由这么少的点定出来，'
          + '它自身的不确定度很大，会同时放大到每个样品的年龄上。' });
    }
    return Object.assign({}, s, {
      trueAge: ctx.stdAge, dev: dev, devPct: devPct,
      reasons: reasons,
      level: qcWorst(reasons.map(function (r) { return r.level; })),
    });
  });
  if (!stds.length) {
    anomaly(QC_LEVELS.BAD, '标样',
      '整批数据里没有找出任何属于标样「' + ctx.stdName + '」的行 —— '
      + '分馏因子取到的是空集合，下面所有年龄都不可信。', []);
  }

  /* ---- 5.3 逐点异常 ---- */
  let nanAge = 0, nanAgeFiles = [];
  let corrNan = 0;
  for (const r of ctx.rows) {
    const bad = !Number.isFinite(ageCol === null ? NaN : r[ageCol]);
    if (bad) { nanAge++; if (nanAgeFiles.length < 8) nanAgeFiles.push(r[0]); }
    // 校正后年龄缺失（只在用了校正时才有意义）
    if (ctx.ageCorrected && ageCol !== null && !Number.isFinite(r[ageCol])) corrNan++;
  }
  if (nanAge) {
    anomaly(QC_LEVELS.BAD, '年龄缺失',
      nanAge + ' / ' + ctx.rows.length + ' 行的年龄算不出来（NaN 或 Inf）。'
      + '先看"信号图"页里蓝、绿两条底色是不是把背景窗画进了信号里 —— '
      + '这是最常见的原因。', nanAgeFiles);
  }
  if (ctx.ageCorrected && corrNan) {
    anomaly(QC_LEVELS.WARN, '校正未完成',
      corrNan + ' 行的「校正后年龄」是 NaN。这些行的普通铅校正没走完，'
      + '未校正年龄可能仍是好的。', []);
  }

  /* ---- 5.4 积分窗口 ---- */
  if (ctx.num) {
    const badWin = [];
    for (const f of Object.keys(ctx.num)) {
      const m = ctx.num[f];
      if (!m) continue;
      // m = [Numbers, b0, b1, s0, s1]
      if (!(m[4] > m[3])) badWin.push(f);
    }
    if (badWin.length) {
      anomaly(QC_LEVELS.WARN, '积分窗口',
        badWin.length + ' 个文件的信号窗起止没有取到（s1 ≤ s0）—— '
        + '原实现会把 s0/s1 都设成 s1，那些文件的信号段是空的。', badWin.slice(0, 8));
    }
  }

  /* ---- 5.5 信号强度（用 Mean_Cps 的净计数） ---- */
  const lowSn = [];
  if (ctx.meanRows && ctx.meanRows.length) {
    for (const row of ctx.meanRows) {
      const file = row[0];
      // 前 2 列是文件名与样品名，接着 7 个背景均值，再 7 个信号均值
      const bU = row[8], sU = row[15];          // 238U
      const bPb = row[4], sPb = row[11];        // 206Pb
      const netU = sU - bU, netPb = sPb - bPb;
      if (!Number.isFinite(netU) || netU <= 0) { lowSn.push(file); continue; }
      const snr = netPb / Math.sqrt(Math.abs(bPb) || 1);
      if (snr < 3) lowSn.push(file);
    }
  }
  if (lowSn.length) {
    anomaly(QC_LEVELS.WARN, '信号偏弱',
      lowSn.length + ' 个文件的 ²⁰⁶Pb 净信号太弱或 ²³⁸U 净计数不为正'
      + '（²⁰⁶Pb 净计数不到背景起伏的 3 倍）—— 这些点算出的年龄误差会很大。',
      lowSn.slice(0, 8));
  }

  /* ---- 5.6 读取提示（兼容模式、缺列补零等） ---- */
  if (ctx.fileNotes) {
    const grouped = {};
    for (const f of Object.keys(ctx.fileNotes)) {
      for (const n of (ctx.fileNotes[f] || [])) {
        if (!grouped[n]) grouped[n] = [];
        grouped[n].push(f);
      }
    }
    for (const n of Object.keys(grouped)) {
      anomaly(QC_LEVELS.WARN, '读取提示',
        '「' + n + '」出现在 ' + grouped[n].length + ' 个文件上。', grouped[n].slice(0, 8));
    }
  }

  /* ---- 5.7 微量元素系数 ---- */
  if (ctx.coefficients) {
    const co = ctx.coefficients;
    const allZero = co.every(function (v) { return v === 0; });
    if (allZero && ctx.nistStd) {
      anomaly(QC_LEVELS.WARN, '微量元素',
        '外标「' + ctx.nistStd + '」的换算系数全是 0 —— 原实现在这个标样只出现 0 次'
        + '或恰好 1 次时会把异常吞掉、系数归零。报告里的 U/Th/Pb 含量列因此无效。', []);
    }
  }
  if (ctx.divZero) {
    anomaly(QC_LEVELS.WARN, '普通铅校正',
      ctx.divZero + ' 行因分母为零无法完成普通铅校正（²⁰⁴ 通道过弱，'
      + '或普通铅参数组合退化），相关列已置为 NaN。', []);
  }

  /* ---- 5.8 参数层面的提醒 ---- */
  if (ctx.algo === 'avg' && ctx.fracStd) {
    const g = stats.find(function (s) { return s.name === ctx.fracStd; });
    if (g && g.used < 3) {
      anomaly(QC_LEVELS.WARN, '分馏校正',
        '平均法只用一个全局分馏因子，而分馏校正标样「' + ctx.fracStd
        + '」只有 ' + g.used + ' 个有效点 —— 因子本身的不确定度没有体现在'
        + '任何一列误差里。点数多些更稳。', []);
    }
  }

  /* ---- 5.9 总等级 ---- */
  const allLevels = stats.map(function (s) { return s.level; })
    .concat(stds.map(function (s) { return s.level; }))
    .concat(anomalies.map(function (a) { return a.level; }));
  const bad = anomalies.filter(function (a) { return a.level === QC_LEVELS.BAD; }).length;
  const warn = anomalies.filter(function (a) { return a.level === QC_LEVELS.WARN; }).length;

  return {
    method: method,
    ageKey: ctx.ageKey,
    ageCorrected: !!ctx.ageCorrected,
    ageCol: ageCol,
    errCol: errCol,
    layout: layout,
    thresholds: th,
    stats: stats,
    standards: stds,
    anomalies: anomalies,
    summary: {
      level: qcWorst(allLevels),
      nSamples: stats.length - stds.length,
      nStd: stds.length,
      nRows: ctx.rows.length,
      nUsed: stats.reduce(function (a, s) { return a + s.used; }, 0),
      nBadAnomalies: bad,
      nWarnAnomalies: warn,
    },
  };
}

/* ==========================================================================
 *  六、给报告用的数值排版
 * ========================================================================== */

/** 固定有效数字，NaN 与 Inf 写成可读的文字而不是 "NaN"。 */
function qcNum(v, digits) {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return String(v);
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Inf' : '-Inf';
  return v.toFixed(digits === undefined ? 2 : digits);
}

/** 带 ± 的年龄写法。 */
function qcAgeText(mean, err, digits, prefix) {
  if (!Number.isFinite(mean)) return '—';
  const d = digits === undefined ? 1 : digits;
  const e = Number.isFinite(err) ? err : NaN;
  return mean.toFixed(d) + ' ± ' + (Number.isFinite(e) ? e.toFixed(d) : '—')
    + (prefix ? ' ' + prefix : '');
}

const DS_QC = {
  QC_KEY68, QC_KEY75, QC_KEY82, QC_KEY76,
  QC_UNCORR_COL, QC_CORR_COL, QC_ERR_OFFSET, QC_LEVELS,
  QC_DEFAULT_THRESHOLDS, QC_THRESHOLD_DOC,
  qcAgeKeys, qcAgeCol, qcDefaultAge, qcCheckLayout,
  qcWavg, qcMswdLimit, qcStdResiduals,
  qcGroupBySample, qcWorst, qcAnalyze,
  qcNum, qcAgeText,
};
if (typeof window !== 'undefined') {
  window.DS_QC = DS_QC;
  Object.assign(window.DS = window.DS || {}, DS_QC);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_QC;
