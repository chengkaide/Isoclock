/* ==========================================================================
 *  stages.js —— 「过程量」：把一条链的**中间环节**摆出来
 *
 *  为什么要有它
 *  ------------
 *  原程序（与逐位复现它的本网页版）把结果分在四个文件里：
 *      Mean_Cps.csv   每行的背景/信号均值（14 个通道值）
 *      result_all.csv 每行的比值、2s，以及五个通道的净计数
 *      年龄表.csv     51 列的年龄与绘图坐标
 *      日志           —— 只在屏幕上滚过去
 *  想回答"这个 157 Ma 是怎么一步步来的"，得在四个文件之间来回对。
 *  这个模块把**同一次计算的中间量并成一张表**：一行一个样品，
 *  列按链条顺序排（窗口 → 计数 → 净计数 → 比值 → 年龄 → 微量元素），
 *  外加一段 meta 放全局量（分馏因子、微量元素系数、标样段数）。
 *
 *  两条纪律
 *  --------
 *  ① **一个数都不新算**。除了 ²⁰²Hg / ²⁰⁴Pb 两个通道的"净计数"（原程序的
 *     netSignal() 里本来就有 204Pb 这一路，是"信号均值 − 背景均值"；202Hg
 *     原程序完全没用），其余每一格都**直接取自**已有的产物：
 *         · 背景/信号均值  <- pipeline.run() 的 meanRows（= Mean_Cps.csv）
 *         · 净计数 5 通道  <- pipeline.run() 的 resultRows（= result_all.csv 的
 *                            U/Th/Pb208/Pb207/Pb206 五列）
 *         · 比值 / 年龄     <- ageRes.rows（= 年龄表.csv，51 列位置数组）
 *         · 窗口下标        <- pipeline.run() 的 idx / ti（sliceChannels 用的同一份）
 *     所以表里不会出现"和别处对不上的第二种算法"。
 *
 *     ⚠ 五通道净计数为什么不自己按"均值相减"再算一遍：208Pb 校正路径
 *       （method 2）内部走的是**逐点相减再取均值**（totalMeans(asArray=true)），
 *       与"均值相减"在浮点末位可能差 1 ULP。既然 result_all 里已经有原值，
 *       就直接用原值，别再造一个"看着一样"的。202Hg / 204Pb 两列没有原值，
 *       按"均值相减"给 —— 204Pb 本来就是这个算法（netSignal 的 pb204）。
 *
 *  ② **口径写进表里，不写在脑里**。比值那一族是"逐点算 → 2σ 剔除 → 取均值"
 *     得到的（见 math.js 的 filter2s / mean2sem），不是两个均值相除；
 *     CSV 的 meta 段与界面的分段说明都把这句话印出来。
 * ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
 *  通道与列的定义
 * ---------------------------------------------------------------------- */

/**
 * 七个通道。顺序必须与 pipeline.js 的 CHANNEL_SUFFIX、report.js 的
 * HEADER_MEAN_CPS 一致 —— meanRows 的位置是按这个顺序排的。
 *
 *   netCol：该通道的净计数在 result_all.csv 里的**列下标**（0 基）；null 表示
 *           result_all 里没有这一列，由本模块按"信号均值 − 背景均值"补。
 *           （result_all 的 18..22 就是 U/Th/Pb208/Pb207/Pb206。）
 */
const STAGE_CHANNELS = [
  { key: 'Hg202', mean: '202Hg', label: '²⁰²Hg', netCol: null },
  { key: 'Hg204', mean: '204Pb', label: '²⁰⁴Pb', netCol: null },
  { key: 'Pb206', mean: '206Pb', label: '²⁰⁶Pb', netCol: 22 },
  { key: 'Pb207', mean: '207Pb', label: '²⁰⁷Pb', netCol: 21 },
  { key: 'Pb208', mean: '208Pb', label: '²⁰⁸Pb', netCol: 20 },
  { key: 'Th232', mean: '232Th', label: '²³²Th', netCol: 19 },
  { key: 'U238', mean: '238U', label: '²³⁸U', netCol: 18 },
];

/** 比值：{ [列头, 2s 列头], ageRes.rows 的 (值列, 2s列) } —— 顺序即输出顺序。 */
const STAGE_RATIOS = [
  { label: '207Pb/206Pb', c: 2 },
  { label: '206Pb/238U', c: 4 },
  { label: '207Pb/235U', c: 6 },
  { label: '208Pb/232Th', c: 8 },
  { label: '208Pb/206Pb', c: 10 },
  { label: '232Th/206Pb', c: 12 },
  { label: '208Pb/204Pb', c: 14 },
];

/** 四个未校正年龄（ageRes.rows 的值列），与 qc.js 的 QC_UNCORR_COL 同源。 */
const STAGE_AGES = [
  { label: '206Pb/238U', c: 17 },
  { label: '207Pb/235U', c: 19 },
  { label: '208Pb/232Th', c: 21 },
  { label: '207Pb/206Pb', c: 23 },
];

/** 该行第一个年龄列（未校正那族的起点），供界面判断"这行算出来了没有"。 */
const STAGE_AGE_FIRST = 17;

const GROUPS = {
  id: '标识',
  win: '积分窗口',
  cnt: '背景 / 信号均值 (cps)',
  net: '净计数 (cps)',
  ratio: '比值（逐点算 → 2σ 剔除 → 取均值）',
  age: '年龄 (Ma)',
  trace: '微量元素 (ppm)',
};

/** 每个分组的"这一步在做什么"。界面拿它当分段标题，CSV 拿它写 meta。 */
const GROUP_NOTE = {
  id: '文件与样品名的对应关系。样品名有三个来源：外部清单（Agilent 用）、'
    + '文件第一行（Thermo）、文件名第一个点之前那一段；这里印的是**这一行实际用到的**那一个。',
  win: '背景窗与信号窗按秒给，切片下标是按 Timeinternal 换算出来的整数，'
     + '真正切进数组的就是这两个区间。信号窗的起止由 detectSignalWindow() '
     + '自动定（本页没有 s0/s1 输入框）。'
     + '⚠ 表格印的是**切片前那处窗口自检改写之后**的值：原程序在信号窗宽小于 '
     + '2 个采样间隔时会把起止都改写成原来的终点（见 pipeline.js run() 里的注释）。',
  cnt: '背景段与信号段各自的**算术均值**（counts/s），即 Mean_Cps.csv 的那 14 列，'
     + '未做任何背景扣除。',
  net: '净计数 = 信号均值 − 背景均值。²⁰⁶Pb/²⁰⁷Pb/²⁰⁸Pb/²³²Th/²³⁸U 五个通道直接取自 '
     + 'result_all.csv 的同名列（与桌面版逐位相同）；²⁰²Hg 与 ²⁰⁴Pb 两列在 '
     + 'result_all.csv 里没有，按同一算式补出（²⁰⁴Pb 在原程序里也正是这么算的）。',
  ratio: '⚠ 这一族**不是**两个净计数相除，而是逐点算比值 → 用 2σ 剔掉离群点 → '
       + '对剩下的点取均值（math.js 的 filter2s / mean2sem）。'
       + '分母的有效点数与"数据点数"不是一回事。',
  age: '年龄由比值反解（ln(比值+1)/λ）。四个未校正年龄一律用未校正比值；'
     + '校正后的年龄只对 ²⁰⁷Pb/²³⁵U 与 ²⁰⁶Pb/²³⁸U（Cal 204Pb 路径是 ²⁰⁶Pb/²³⁸U 与 '
     + '²⁰⁸Pb/²³²Th）给出，且 ²⁰⁷Pb/²⁰⁶Pb 从不做普通铅校正。'
     + '2s 列是 2σ；外挂误差 Ɛ 已按平方和并进前三个年龄的误差，'
     + '但 ²⁰⁷Pb/²⁰⁶Pb 那一路不含 Ɛ。',
  trace: 'U / Th / Pb 的 ppm 值 = 净计数 × 微量元素系数，系数由 NIST 外标算（见 meta）。'
       + '外标在整批里出现 0 次或 1 次时系数会静默取 0，这是原实现的行为。',
};

/* --------------------------------------------------------------------------
 *  列清单
 * ---------------------------------------------------------------------- */

/** 生成一次并缓存 —— 列定义与 cfg.method 有关（校正年龄那两列）。 */
function columnsFor(method, deps) {
  const cols = [];
  const add = (g, key, label, unit) => cols.push({ g, key, label, unit: unit || '' });

  add('id', 'no', '序号');
  add('id', 'file', '文件');
  add('id', 'sample', '样品名');

  add('win', 'n', '数据点数');
  add('win', 'ti', '采样间隔', 's');
  add('win', 'b0', '背景窗起', 's');
  add('win', 'b1', '背景窗止', 's');
  add('win', 's0', '信号窗起', 's');
  add('win', 's1', '信号窗止', 's');
  add('win', 'nb', '背景点数');
  add('win', 'ns', '信号点数');

  for (const c of STAGE_CHANNELS) add('cnt', 'b_' + c.key, '背景 ' + c.label);
  for (const c of STAGE_CHANNELS) add('cnt', 's_' + c.key, '信号 ' + c.label);
  for (const c of STAGE_CHANNELS) add('net', 'n_' + c.key, c.label, 'cps');

  for (const r of STAGE_RATIOS) {
    add('ratio', 'r' + r.c, r.label);
    add('ratio', 'r' + r.c + '_2s', r.label + ' 2s');
  }

  for (const a of STAGE_AGES) {
    add('age', 'age' + a.c, a.label);
    add('age', 'age' + a.c + '_2s', a.label + ' 2s');
  }
  const cs = correctedCols(method, deps);
  for (let i = 0; i < cs.length; i++) {
    add('age', 'corr' + i, '校正后 ' + cs[i].key);
    add('age', 'corr' + i + '_2s', '校正后 ' + cs[i].key + ' 2s');
  }

  add('trace', 'U', 'U', 'ppm');
  add('trace', 'Th', 'Th', 'ppm');
  add('trace', 'Pb', 'Pb', 'ppm');

  return cols;
}

/** 该校正方式的校正年龄列（{key, col}），取自 qc.js；method 0 返回空数组。 */
function correctedCols(method, deps) {
  const QC = (deps && deps.QC) || null;
  if (!QC || !QC.QC_CORR_COL) return [];
  const c = QC.QC_CORR_COL[method];
  if (!c) return [];
  return Object.keys(c).map((k) => ({ key: k, col: c[k] }));
}

/* --------------------------------------------------------------------------
 *  取数的小工具
 * ---------------------------------------------------------------------- */

/** 把 pipeline.run() 的 meanRows 按文件名建索引。 */
function indexMeanRows(meanRows) {
  const m = {};
  for (const r of meanRows || []) m[r[0]] = r;
  return m;
}

/** 把 resultRows（result_all.csv 的行）按文件名建索引。 */
function indexResultRows(resultRows) {
  const m = {};
  for (const r of resultRows || []) m[r[1]] = r;
  return m;
}

/**
 * 切片真正取到了几个点 —— 与 pipeline.js 的 pySlice 钳制规则**逐字相同**
 * （负索引按 Python 语义、越界钳到长度、stop<start 时取空）。
 *
 * 不直接用 eb−sb 是因为索引会被钳：b1/ti 超出点数时，两者会不一样。
 * 表里报的必须是"真的取进了几个点"。
 */
function sliceLen(len, start, stop) {
  let s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let e = stop < 0 ? Math.max(len + stop, 0) : Math.min(stop, len);
  if (e < s) e = s;
  return e - s;
}

/**
 * 解析样品名的来源（'list' / 'head' / 'file'）→ 中文短语，给界面用。
 * 与 app.js 的提示用词保持一致。
 */
const SAMPLE_FROM_TEXT = {
  list: '来自样品名清单',
  head: '读文件第一行',
  file: '取文件名（第一个点之前）',
};

/* --------------------------------------------------------------------------
 *  主入口：把一次计算的中间量拼成一张表
 * ---------------------------------------------------------------------- */

/**
 * @param {object} out       pipeline.run() 的返回值（要有 meanRows / resultRows /
 *                           num / idx / ti / tiGlobal / sampleFrom）
 * @param {object} ageRes    age.js 的返回值（rows 是 51 列位置数组）
 * @param {object} cfg       归一化后的配置（method / b0 / b1 / multi / …）
 * @param {object} deps      { QC, untagInt, buildId, generatedAt, fileNotes }
 * @returns {{columns, rows, meta, byFile, notes}}
 */
function buildStages(out, ageRes, cfg, deps) {
  deps = deps || {};
  const method = (cfg && cfg.method) || 0;
  const cols = columnsFor(method, deps);
  const corr = correctedCols(method, deps);

  const meanByFile = indexMeanRows(out.meanRows);
  const resByFile = indexResultRows(out.resultRows);
  const untag = deps.untagInt || ((v) => v);

  const rows = [];
  const byFile = {};
  for (const r of ageRes.rows) {
    const file = r[0];
    const sample = r[1];
    const mean = meanByFile[file] || null;
    const res = resByFile[file] || null;
    const num = (out.num && out.num[file]) || null;
    const idx = (out.idx && out.idx[file]) || null;

    const v = {};        // 先按 key 装，再按 columns 顺序摊平 —— 列序改起来不会错位
    v.no = res ? untag(res[0]) : '';
    v.file = file;
    v.sample = sample;

    /* --- 窗口 --- */
    v.n = num ? num[0] : '';
    v.ti = idx ? idx.ti : '';
    v.b0 = num ? num[1] : '';
    v.b1 = num ? num[2] : '';
    v.s0 = num ? num[3] : '';
    v.s1 = num ? num[4] : '';
    v.nb = (idx && num) ? sliceLen(num[0], idx.sb, idx.eb) : '';
    v.ns = (idx && num) ? sliceLen(num[0], idx.ss, idx.es) : '';

    /* --- 背景 / 信号均值（meanRows 的位置同 CHANNEL_SUFFIX） --- */
    STAGE_CHANNELS.forEach((c, i) => {
      v['b_' + c.key] = mean ? mean[2 + i] : NaN;
      v['s_' + c.key] = mean ? mean[9 + i] : NaN;
    });

    /* --- 净计数：五通道取自 result_all，其余按"信号均值 − 背景均值" --- */
    STAGE_CHANNELS.forEach((c, i) => {
      if (c.netCol !== null && res) {
        v['n_' + c.key] = res[c.netCol];
      } else {
        v['n_' + c.key] = (mean ? mean[9 + i] : NaN) - (mean ? mean[2 + i] : NaN);
      }
    });

    /* --- 比值：直接搬 ageRes 的列（值与 2s 都在里面） --- */
    for (const rr of STAGE_RATIOS) {
      v['r' + rr.c] = r[rr.c];
      v['r' + rr.c + '_2s'] = r[rr.c + 1];
    }

    /* --- 年龄 --- */
    for (const a of STAGE_AGES) {
      v['age' + a.c] = r[a.c];
      v['age' + a.c + '_2s'] = r[a.c + 1];
    }
    corr.forEach((c, i) => {
      v['corr' + i] = r[c.col];
      v['corr' + i + '_2s'] = r[c.col + 1];
    });

    /* --- 微量元素 (ppm)：年龄表第 48/49/50 列（0 基 47/48/49） --- */
    v.U = r[47]; v.Th = r[48]; v.Pb = r[49];

    rows.push(cols.map((c) => (v[c.key] === undefined ? '' : v[c.key])));
    byFile[file] = {
      row: rows[rows.length - 1], vals: v, index: rows.length - 1,
      sampleFrom: (out.sampleFrom || {})[file] || null,
      notes: (deps.fileNotes || {})[file] || [],
    };
  }

  return {
    columns: cols,
    rows,
    byFile,
    meta: buildMeta(out, ageRes, cfg, deps),
    notes: GROUP_NOTE,
    groups: GROUPS,
  };
}

/* --------------------------------------------------------------------------
 *  全局量（meta）—— 一行一条，供界面卡片与 CSV 的 # 段用
 * ---------------------------------------------------------------------- */

/**
 * 分馏因子怎么来的、每条的出处。
 *
 * 平均法只有一个全局因子（全批标样取均值）；线性法是每个标样段各一套 A/B
 * 因子，**没有单一数值可给** —— 所以那时只报段数，并指向年龄表里每行的
 * "校正后"那两列。
 */
function buildMeta(out, ageRes, cfg, deps) {
  cfg = cfg || {};
  const METHOD_TEXT = {
    0: '0 · 不校正（未校正比值）',
    1: '1 · 207Pb 校正',
    2: '2 · 208Pb 校正',
    3: '3 · 204Pb 校正',
    4: '4 · Cal 204Pb 校正',
  };
  const m = [];
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') m.push({ k, v }); };

  put('生成时间', deps.generatedAt || '');
  put('构建指纹', deps.buildId || '');
  put('仪器', cfg.inst === 'agilent' ? 'Agilent' : 'Thermo');
  put('积分窗口设置', '背景 ' + cfg.b0 + '–' + cfg.b1 + ' s，信号阈值倍数 ' + cfg.multi);
  put('实际用于切片的采样间隔', (out.tiGlobal !== undefined ? out.tiGlobal : '') + ' s');
  put('标样名', cfg.stdName);
  put('标样年龄', cfg.stdAge + ' Ma');
  put('分馏校正标样', cfg.standard);
  put('普通铅校正方式', METHOD_TEXT[cfg.method] || String(cfg.method));
  put('外挂误差 Ɛ', (cfg.excessV * 100).toFixed(6).replace(/\.?0+$/, '') + ' %'
    + '（按平方和并进年龄的相对误差；不改变年龄本身）');
  put('微量元素外标', cfg.nistStd || '（未指定）');
  put('年龄层算法', cfg.algo === 'linear' ? '线性法（相邻标样插值 SSB）' : '平均法（全批一个分馏因子）');
  put('207Pb/206Pb 年龄迭代', cfg.fix76 ? '收敛修正版' : '逐位复现桌面版的固定 10 次');

  //  分馏因子 / 标样段
  if (ageRes && ageRes.factors) {
    const f = ageRes.factors;
    put('分馏因子 f(207/206)', f.f207_206);
    put('分馏因子 f(206/238)', f.f206_238);
    put('分馏因子 f(207/235)', f.f207_235);
    put('分馏因子 f(208/232)', f.f208_232);
    put('标样 206Pb/238U 的相对 2s', f.std_68_2s);
    put('标样 207Pb/235U 的相对 2s', f.std_75_2s);
  } else if (ageRes && ageRes.groups) {
    put('标样段数', (ageRes.groups.std || []).length);
    put('非标样段数', (ageRes.groups.sample || []).length);
    put('分馏因子', '线性法：每个标样段各一套，见年龄表里每行的"校正后"两列');
  }

  if (ageRes && ageRes.coefficients) {
    const c = ageRes.coefficients;
    put('微量元素系数 U238', c[0]);
    put('微量元素系数 Th232', c[1]);
    put('微量元素系数 Pb', c[2]);
    if (c[0] === 0 && c[1] === 0 && c[2] === 0 && cfg.nistStd) {
      put('提示', '微量元素系数全为 0 —— 外标「' + cfg.nistStd
        + '」在这批数据里出现 0 次或 1 次时原实现即如此');
    }
  }

  put('行数', (ageRes && ageRes.rows ? ageRes.rows.length : 0) + ' 个样品');
  if (ageRes && ageRes.warnings && ageRes.warnings.divZero) {
    put('普通铅校正失败行数', ageRes.warnings.divZero);
  }
  return m;
}

/* --------------------------------------------------------------------------
 *  CSV
 * ---------------------------------------------------------------------- */

/**
 * 生成过程量 CSV。
 *
 * 形状：UTF-8 BOM + 若干 `#` 元信息行 + 一行表头 + N 行数据。
 *   · BOM 是为了 Excel 双击打开时中文表头不乱码（别的几个导出是纯 ASCII 表头，
 *     没有这个问题，所以只有这一份带）。
 *   · `#` 段放全局量 —— 每行一个"键,值"，键可以重复出现。
 *   · 数据段每个数**用 Python repr 排版**（deps.fmt 传 report.js 的
 *     pyFloatRepr），与另外两个 CSV 同一套写法，数值可无损往返。
 *
 * @param {object} model  buildStages() 的返回值
 * @param {object} deps   { fmt }
 */
function stagesCsv(model, deps) {
  deps = deps || {};
  const fmt = deps.fmt || ((v) => String(v));
  const cell = (v) => {
    if (typeof v === 'string') return needQuote(v) ? quote(v) : v;
    if (typeof v === 'number') {
      if (!isFinite(v)) return Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf');
      const s = fmt(v);
      return needQuote(s) ? quote(s) : s;
    }
    return String(v);
  };
  const EOL = '\r\n';

  let out = '\ufeff';
  out += '# Isoclock 网页版 · 过程量（一次计算的中间环节）' + EOL;
  out += '# 一行一个样品；列按链条顺序：积分窗口 → 背景/信号均值 → 净计数 → 比值 → 年龄 → 微量元素' + EOL;
  for (const it of model.meta) {
    out += '# ' + esc(it.k) + ' = ' + esc(String(it.v)) + EOL;
  }
  out += '# 分组口径' + EOL;
  for (const k of Object.keys(GROUPS)) {
    if (GROUP_NOTE[k]) out += '# ' + GROUPS[k] + '：' + esc(GROUP_NOTE[k]).replace(/\n/g, ' ') + EOL;
  }
  out += '# 注意：本文件里的数据段与其它三个 CSV 同源，但不参与"与桌面版逐字节一致"的比对 ——' + EOL;
  out += '#      它是一张**视图**，把已有的中间量并在一起，没有新增任何算式。' + EOL;

  out += model.columns.map((c) => cell(colHeader(c))).join(',') + EOL;
  for (const r of model.rows) out += r.map(cell).join(',') + EOL;
  return out;
}

/** 表头：有单位就带上，免得下游不知道这是 cps 还是 ppm。 */
function colHeader(c) {
  return c.unit ? (c.label + ' (' + c.unit + ')') : c.label;
}

function needQuote(s) {
  return s.indexOf(',') >= 0 || s.indexOf('"') >= 0
    || s.indexOf('\r') >= 0 || s.indexOf('\n') >= 0 || s.charAt(0) === '#';
}
function quote(s) { return '"' + s.replace(/"/g, '""') + '"'; }
function esc(s) { return String(s).replace(/[\r\n]/g, ' '); }

/* --------------------------------------------------------------------------
 *  单样品的"流水账" —— 界面点某一行时展开的那一份
 * ---------------------------------------------------------------------- */

/** 一个分段的格式化规则：跟着分组走，年龄留 2 位、比值留 6 位。 */
function fmtByGroup(g, v) {
  if (v === '' || v === undefined || v === null) return '—';
  if (typeof v !== 'number') return String(v);
  if (!isFinite(v)) return Number.isNaN(v) ? 'NaN' : (v > 0 ? 'Inf' : '-Inf');
  if (g === 'age' || g === 'trace') return v.toFixed(2);
  if (g === 'win') return v.toFixed(4).replace(/\.?0+$/, '');
  return v.toPrecision(6);
}

/**
 * 取一个样品的全链条，给界面渲染成"流水账"。
 *
 * @param {object} model  buildStages() 的返回值
 * @param {string} file
 * @returns {Array<{group, title, note, items:Array<{name, value}>}>}
 */
function sampleChain(model, file) {
  const e = model.byFile[file];
  if (!e) return [];
  const v = e.vals;
  const out = [];
  const push = (g, items) => out.push({
    group: g, title: GROUPS[g],
    note: GROUP_NOTE[g] || '', items,
  });

  push('id', [
    { name: '样品名', value: v.sample },
    { name: '样品名来源', value: SAMPLE_FROM_TEXT[e.sampleFrom] || '（未记录）' },
    { name: '文件', value: v.file },
    { name: '序号', value: String(v.no) },
  ]);

  push('win', [
    { name: '数据点数', value: fmtByGroup('win', v.n) },
    { name: '采样间隔 (s)', value: fmtByGroup('win', v.ti) },
    { name: '背景窗 (s)', value: fmtByGroup('win', v.b0) + ' – ' + fmtByGroup('win', v.b1) },
    { name: '信号窗 (s)', value: fmtByGroup('win', v.s0) + ' – ' + fmtByGroup('win', v.s1) },
    { name: '背景段取点数', value: fmtByGroup('win', v.nb) },
    { name: '信号段取点数', value: fmtByGroup('win', v.ns) },
  ]);

  push('cnt', STAGE_CHANNELS.map((c) => ({
    name: c.label + ' 背景 / 信号',
    value: fmtByGroup('cnt', v['b_' + c.key]) + '  /  ' + fmtByGroup('cnt', v['s_' + c.key]),
  })));

  push('net', STAGE_CHANNELS.map((c) => ({
    name: c.label,
    value: fmtByGroup('net', v['n_' + c.key])
      + (c.netCol === null ? '（网页版按均值相减补出）' : '（取自 result_all）'),
  })));

  push('ratio', STAGE_RATIOS.map((r) => ({
    name: r.label,
    value: fmtByGroup('ratio', v['r' + r.c]) + ' ± ' + fmtByGroup('ratio', v['r' + r.c + '_2s']),
  })));

  const ageItems = STAGE_AGES.map((a) => ({
    name: a.label,
    value: fmtByGroup('age', v['age' + a.c]) + ' ± ' + fmtByGroup('age', v['age' + a.c + '_2s']),
  }));
  for (const c of model.columns) {
    if (c.g === 'age' && c.key.indexOf('corr') === 0 && c.key.indexOf('_2s') < 0) {
      const k2 = c.key + '_2s';
      const lbl = c.label.replace('校正后 ', '');
      const has = v[k2];
      ageItems.push({
        name: '校正后 ' + lbl,
        value: (has === '' || has === undefined)
          ? '—' : (fmtByGroup('age', v[c.key]) + ' ± ' + fmtByGroup('age', v[k2])),
      });
    }
  }
  push('age', ageItems);

  push('trace', [
    { name: 'U (ppm)', value: fmtByGroup('trace', v.U) },
    { name: 'Th (ppm)', value: fmtByGroup('trace', v.Th) },
    { name: 'Pb (ppm)', value: fmtByGroup('trace', v.Pb) },
  ]);

  return out;
}

/* --------------------------------------------------------------------------
 *  导出
 * ---------------------------------------------------------------------- */

const DS_STAGES = {
  buildStages, stagesCsv, sampleChain, columnsFor, buildMeta, sliceLen,
  STAGE_CHANNELS, STAGE_RATIOS, STAGE_AGES, STAGE_AGE_FIRST, GROUPS, GROUP_NOTE,
  SAMPLE_FROM_TEXT,
  correctedCols, colHeader, indexMeanRows, indexResultRows, fmtByGroup,
};
if (typeof window !== 'undefined') {
  window.DS_STAGES = DS_STAGES;
  Object.assign(window.DS = window.DS || {}, DS_STAGES);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_STAGES;
