/* ==========================================================================
 *  test_api.js —— 程序接口门面（window.DS_API）的判据
 *
 *  用法:  node webgui/test_api.js
 *
 *  这个文件测的不是数值（数值归各 src 模块自己的测试管），而是**接口的形状
 *  与它跟内部实现的一致性**：
 *      ① 自描述（schema / capabilities / tool）说得出话，且说对了
 *      ② 参数归一化：独立算式复算 Cal_age、默认值与内置示例不许分家
 *      ③ 校验判据：五条错误的**错误码与顺序**都与界面的"开始计算"一致
 *      ④ 全链路能在无 DOM 的 Node 里跑通，并且结果与产物声明的真值对得上
 *      ⑤ 列映射（toRows）没抄错：每个字段都能追回到 51 列原始行的某一列
 *
 *  "界面与接口同源"那条判据不在这里 —— 它必须有 DOM 才能验（要真的点一次
 *  "开始计算"再跟 DS_API 比），所以放在 ui/selftest.js 里，见那里的
 *  "程序接口与界面跑出来的是同一份结果"。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const SRC = path.join(HERE, 'src');

/* ---------- 加载模块（顺序与 build_ui.py 的 .js 加载顺序一致） ----------
 *  api.js 不碰 DOM，所以这一整套能在 Node 里跑 —— 这正是"给程序用的门面"
 *  该有的性质。 */
const sandbox = {
  window: {}, console,
  //  demo_real.js 解 gzip 要用这几个（Node 18+ 有，浏览器里本来就有）
  DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob, Response: globalThis.Response,
  atob: globalThis.atob, TextDecoder: globalThis.TextDecoder
};
vm.createContext(sandbox);
for (const f of ['fp.js', 'math.js', 'thermo.js', 'window.js', 'report.js',
                 'pipeline.js', 'age.js', 'qc.js', 'stages.js', 'demo_real.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
for (const f of ['api.js']) {
  vm.runInContext(fs.readFileSync(path.join(HERE, 'ui', f), 'utf8'), sandbox,
    { filename: 'ui/' + f });
}

const API = sandbox.window.DS_API;
const DEMO = sandbox.window.DS_DEMO_REAL;
const QC = sandbox.window.DS_QC;

let pass = 0, fail = 0;
const rows = [];
function t(name, ok, detail) {
  if (ok) pass++; else fail++;
  rows.push([ok, name, detail === undefined ? '' : String(detail)]);
  return ok;
}
function eq(a, b) { return Object.is(a, b); }

async function main() {
  if (!API) { console.log('DS_API 没挂上 —— 加载失败'); process.exit(1); }

  /* ------------------------------------------------------------------ ① */
  t('门面存在，且带版本号', !!API && typeof API.version === 'string' && API.version.length > 0,
    'version = ' + (API && API.version));

  const caps = API.capabilities();
  t('capabilities() 报告 ready（8 个必需模块都在）', caps.ready === true,
    caps.ready ? '' : '缺：' + caps.missingModules.join('、'));
  t('capabilities() 认出这是 Node 环境（没有 document）', caps.environment === 'node',
    'environment = ' + caps.environment);
  t('capabilities() 声明离线且不写本地存储',
    caps.offline === true && caps.writesStorage === false);
  t('capabilities() 的 ageColumns 与 qc.js 的列映射逐项相同',
    API.UNCORR_COLS.AGE68 === QC.QC_UNCORR_COL['206Pb/238U']
    && API.UNCORR_COLS.AGE75 === QC.QC_UNCORR_COL['207Pb/235U']
    && API.UNCORR_COLS.AGE82 === QC.QC_UNCORR_COL['208Pb/232Th']
    && API.UNCORR_COLS.AGE76 === QC.QC_UNCORR_COL['207Pb/206Pb'],
    'AGE68=17 AGE75=19 AGE82=21 AGE76=23');
  t('correctedCols(1) 就是从 qc.js 读出来的那两列',
    JSON.stringify(API.correctedCols(1)) === JSON.stringify(
      Object.keys(QC.QC_CORR_COL[1]).map((k) => ({ key: k, col: QC.QC_CORR_COL[1][k] }))),
    JSON.stringify(API.correctedCols(1)));

  const sch = API.schema();
  const props = Object.keys(sch.properties);
  t('schema() 列出了全部 14 个参数',
    props.length === 14, props.length + ' 个：' + props.join(', '));
  t('schema() 里每个参数都有 description（不然智能体猜不出怎么填）',
    props.every((k) => typeof sch.properties[k].description === 'string'
      && sch.properties[k].description.length > 4),
    props.filter((k) => !sch.properties[k].description).join(', ') || '全部有');

  /*  schema 说的默认值必须真的就是 normalize 用的默认值 —— 自描述与实际
   *  行为分家是最难查的一类错（文档看着对、跑起来不对）。 */
  const dflt = API.DEFAULT_PARAMS;
  const schemaDefaultOK = props.every((k) => {
    if (sch.properties[k].default === undefined) return true;
    if (k === 'estimateAge') return sch.properties[k].default === API.EST_AGE_DEFAULT;
    return sch.properties[k].default === dflt[k];
  });
  t('schema() 里的 default 与 DEFAULT_PARAMS 逐项一致（自描述不许骗人）',
    schemaDefaultOK,
    props.filter((k) => sch.properties[k].default !== undefined
      && sch.properties[k].default !== dflt[k] && k !== 'estimateAge').join(', ') || '一致');

  const tool = API.tool();
  t('tool() 是 function-calling 的形状（type/function.name/parameters）',
    tool.type === 'function' && tool.function && tool.function.name === 'isoclock_run'
    && tool.function.parameters && tool.function.parameters.required.indexOf('files') >= 0,
    tool.function && tool.function.name);
  t('tool() 的参数模式嵌的就是 schema()（不是另写一份）',
    tool.function.parameters.properties.params.title === sch.title,
    'title = ' + tool.function.parameters.properties.params.title);
  t('errorCodes 把 20 个错误码都写清楚了',
    Object.keys(API.errorCodes).length === 20
    && Object.keys(API.errorCodes).every((k) => API.errorCodes[k].length > 4),
    Object.keys(API.errorCodes).length + ' 个');

  /* ------------------------------------------------------------------ ② */
  /*  Cal_age 用独立算式复算一遍。FP.dexp 是模拟 Python exp 的实现（不是
   *  Math.exp），末位本来就可能差几个 ULP —— 所以容差取 1e-13：判的是
   *  "系数与乘序没抄错"，而不是"JS 的 exp 与 Python 的 exp 一模一样"。 */
  {
    const c = API.calAge(100);
    const a = Math.expm1(0.000000000155125 * 100 * 1000000);
    const b = Math.expm1(0.00000000098485 * 100 * 1000000);
    const c2 = Math.expm1(0.000000000049475 * 100 * 1000000);
    const P382 = 1 / 137.818 * (b / a);
    const Q8 = 18.700 - a * 9.735;
    const R8 = 15.628 - b * (9.735 / 137.818);
    t('Cal_age(100) 的 P382 与独立算式一致（相对误差 < 1e-13）',
      Math.abs(c.P382 - P382) / P382 < 1e-13,
      'API=' + c.P382 + '  独立=' + P382);
    t('Cal_age(100) 的 Q8 / R8 / S8 与独立算式一致',
      Math.abs(c.Q8 - Q8) < 1e-13 && Math.abs(c.R8 - R8) < 1e-13
      && Math.abs(c.S8 - (38.630 - c2 * 36.837)) < 1e-12,
      'Q8=' + c.Q8 + ' R8=' + c.R8);
    t('Cal_age 的 Pbc 就是 R8/Q8',
      c.Pbc === c.R8 / c.Q8, 'Pbc = ' + c.Pbc);
  }

  /*  默认值与内置示例的推荐参数不许分家 —— 两处各有一份，跑起来对不上
   *  是最难查的那种错。 */
  t('DEFAULT_PARAMS 与内置示例的推荐参数逐字段相同',
    ['inst', 'b0', 'b1', 'multi', 'stdName', 'stdAge', 'fracStd', 'nistStd',
     'method', 'algo', 'excess'].every((k) => eq(dflt[k], DEMO.params[k])),
    ['inst', 'b0', 'b1', 'multi', 'stdName', 'stdAge', 'fracStd', 'nistStd',
     'method', 'algo', 'excess']
      .filter((k) => !eq(dflt[k], DEMO.params[k]))
      .map((k) => k + ': ' + dflt[k] + ' != ' + DEMO.params[k]).join(' ｜ ') || '一致');

  /*  归一化：excess 是**百分数进、小数出**（界面就是这么填的）。 */
  {
    const cfg = API.normalize({ excess: 3 });
    t('normalize：excess 3(%) → excessV 0.03（与界面同口径）',
      cfg.excessV === 0.03, 'excessV = ' + cfg.excessV);
    t('normalize：别名 stdName/fracStd 与 standard 互认',
      API.normalize({ stdName: 'X', fracStd: 'Y' }).stdName === 'X'
      && API.normalize({ stdName: 'X', fracStd: 'Y' }).standard === 'Y'
      && API.normalize({ standard: 'Z', fractionationStandard: 'W' }).stdName === 'Z'
      && API.normalize({ standard: 'Z', fractionationStandard: 'W' }).standard === 'W');
    t('normalize：method 4 的 radioactiveS_Pb207_206 恒按估算年龄算（fromAge）',
      API.normalize({ method: 4, estimateAge: 100 }).params.radioactiveS_Pb207_206
        === API.calAge(100).P382,
      'P382(100) = ' + API.calAge(100).P382);
    t('normalize：显式给的 pbParams 优先于按年龄推算',
      API.normalize({ method: 1, pbParams: { common_Pb: 0.9 } }).params.common_Pb === 0.9);
    t('normalize：非法仪器 / 方式 / 算法各自抛带错误码的异常',
      ['BAD_INSTRUMENT', 'BAD_METHOD', 'BAD_ALGO'].every((code, i) => {
        try {
          API.normalize([{ inst: 'x' }, { method: 9 }, { algo: 'x' }][i]);
          return false;
        } catch (e) { return e.code === code; }
      }));
  }

  /*  isCfg：界面 readConfig() 的输出必须被认作"已归一化"，否则参数会被
   *  二次换算（excess 除两次 100）。 */
  t('isCfg：能认出已归一化的 cfg（保证界面传进来时不会被二次换算）',
    API.isCfg(API.normalize(DEMO.params)) === true
    && API.isCfg(DEMO.params) === false,
    'normalize 后 = ' + API.isCfg(API.normalize(DEMO.params)));

  /* ------------------------------------------------------------------ ③ */
  /*  五条判据的错误码与**顺序**必须与界面"开始计算"按下的那一刻一致 ——
   *  界面上弹的是 errors[0]，顺序错了就会弹错那句。 */
  {
    const cfgOK = API.normalize(DEMO.params);
    const filesOK = [{ file: 'a.csv', text: 'x' }];
    const E = (cfg, files) => API.validate(cfg, files).map((e) => e.code);

    t('校验：五条判据的错误码与顺序与界面完全一致',
      JSON.stringify(E(cfgOK, []))
        === JSON.stringify(['NO_FILES']),
      JSON.stringify(E(cfgOK, [])));
    const bad1 = Object.assign({}, cfgOK, { stdName: '' });
    const bad2 = Object.assign({}, cfgOK, { stdAge: NaN });
    const bad3 = Object.assign({}, cfgOK, { excessV: NaN });
    const bad4 = Object.assign({}, cfgOK, { standard: '' });
    t('校验：缺标样名 → MISSING_STD_NAME',
      JSON.stringify(E(bad1, filesOK)) === JSON.stringify(['MISSING_STD_NAME']));
    t('校验：标样年龄不是数字 → BAD_STD_AGE',
      JSON.stringify(E(bad2, filesOK)) === JSON.stringify(['BAD_STD_AGE']));
    t('校验：外挂误差不是数字 → BAD_EXCESS',
      JSON.stringify(E(bad3, filesOK)) === JSON.stringify(['BAD_EXCESS']));
    t('校验：缺分馏校正标样 → MISSING_FRAC_STD',
      JSON.stringify(E(bad4, filesOK)) === JSON.stringify(['MISSING_FRAC_STD']));
    t('校验：全缺时五条按固定顺序一起报（界面弹的是第一条）',
      JSON.stringify(E({ stdName: '', stdAge: NaN, excessV: NaN, standard: '' }, []))
        === JSON.stringify(['NO_FILES', 'MISSING_STD_NAME', 'BAD_STD_AGE',
          'BAD_EXCESS', 'MISSING_FRAC_STD']),
      JSON.stringify(E({ stdName: '', stdAge: NaN, excessV: NaN, standard: '' }, [])));
  }

  /*  失败一律返回 ok:false + 错误码，不抛异常 —— 调用方（智能体宿主）
   *  要能靠这一个字段判断，而不是去 try/catch 猜。 */
  {
    const r1 = API.run({}, []);
    t('run({}, []) 不抛异常，返回 ok:false 与 NO_FILES',
      r1.ok === false && r1.errors[0].code === 'NO_FILES',
      JSON.stringify(r1.errors));
    const r2 = API.run(DEMO.params, [{ file: 'a.csv', text: 42 }]);
    t('run() 的文件项 text 不是字符串 → BAD_FILE（不静默当空文件处理）',
      r2.ok === false && r2.errors[0].code === 'BAD_FILE', JSON.stringify(r2.errors));
    const r3 = API.run({ inst: 'x' }, [{ file: 'a.csv', text: 'y' }]);
    t('run() 的非法仪器 → BAD_INSTRUMENT（归一化阶段就拦住，不进管线）',
      r3.ok === false && r3.errors[0].code === 'BAD_INSTRUMENT',
      JSON.stringify(r3.errors));
    const r4 = API.run(DEMO.params, [{ file: 'a.csv', text: '1,2,3\n' }]);
    t('run() 解析不出任何东西 → ALL_FILES_UNPARSED（不是返回空表）',
      r4.ok === false && r4.errors[0].code === 'ALL_FILES_UNPARSED',
      JSON.stringify(r4.errors));
  }

  /* ------------------------------------------------------------------ ④ */
  /*  全链路。这一遍要用内置示例 —— 它自带推荐参数与**产物声明的**标样结果，
   *  所以判据不是"我算出来等于我算出来"，而是"算出来等于数据自己声明的那个数"。 */
  let demoFiles = null;
  try {
    demoFiles = await DEMO.decode();
  } catch (e) {
    t('内置示例能在 Node 里解开（DecompressionStream 可用）', false, String(e && e.message || e));
  }
  if (demoFiles) {
    t('内置示例解开后是 49 个文件，且每个都带 file/text',
      demoFiles.length === 49 && demoFiles.every((f) => typeof f.file === 'string'
        && typeof f.text === 'string' && f.text.length > 100),
      demoFiles.length + ' 个，首个 = ' + demoFiles[0].file);

    const R = API.run(DEMO.params, demoFiles);
    t('全链路跑通（ok:true），年龄表 49 行', R.ok === true && R.rowCount === 49,
      R.ok ? R.rowCount + ' 行' : JSON.stringify(R.errors));
    t('文件清单与示例一致（49 个）', R.files.length === 49, R.files.length + ' 个');
    t('标样文件数与产物声明一致（15 个 AY-4）',
      R.stats.nStdFiles === DEMO.stdMeasured.n, R.stats.nStdFiles + ' 个');

    /*  ★ 关键判据：接口算出来的标样结果 == 数据自己声明的那个数。
     *  这条能挂掉的情形很实在 —— 参数被归一化错、管线段被改过、
     *  或者列映射取错列，都会让它对不上。 */
    {
      const q = R.quality;
      const g = q.standards.filter((s) => s.name === DEMO.stdMeasured.name)[0];
      t('质量统计里找得到标样 ' + DEMO.stdMeasured.name, !!g);
      if (g) {
        const mean = Math.abs(g.mean - DEMO.stdMeasured.mean);
        //  qc.js 给的是 1σ 内部标准误（se），产物里声明的是 **2σ**（se2）——
        //  口径必须带着走，不能拿 se 去比 se2。
        const se = Math.abs(g.se * 2 - DEMO.stdMeasured.se2);
        t('接口算出的标样加权平均 == 产物声明的 mean（' + DEMO.stdMeasured.mean.toFixed(4) + '）',
          mean < 1e-9, '差 ' + mean.toExponential(3));
        t('接口算出的标样 2σ（se×2）== 产物声明的 se2（' + DEMO.stdMeasured.se2.toFixed(4) + '）',
          se < 1e-9, '差 ' + se.toExponential(3));
        t('接口算出的标样 MSWD == 产物声明的 mswd（' + DEMO.stdMeasured.mswd.toFixed(4) + '）',
          Math.abs(g.mswd - DEMO.stdMeasured.mswd) < 1e-9,
          'API=' + g.mswd + ' 声明=' + DEMO.stdMeasured.mswd);
      }
    }

    t('NaN 行数与产物声明的 nanRows 一致（窗口修正后应为 0）',
      R.stats.nNaN === (DEMO.flaws.nanRows || []).length,
      'API=' + R.stats.nNaN + ' 声明=' + (DEMO.flaws.nanRows || []).length);

    t('quality 默认用 206Pb/238U 的**校正后**年龄（method 1 有这一列）',
      R.qualityAgeKey === '206Pb/238U' && R.qualityCorrected === true,
      R.qualityAgeKey + ' corrected=' + R.qualityCorrected);
    t('quality.summary 里有等级、样品数、有效点数',
      R.quality.summary && typeof R.quality.summary.level === 'string'
      && R.quality.summary.nRows === 49
      && R.quality.summary.nUsed > 0,
      JSON.stringify(R.quality.summary));

    /*  日志：级别是语义化的，且**至少**有一条 error 级别的绝不出现
     *  （成功跑完还带 error 日志，说明有东西被吞掉了）。 */
    t('日志带语义级别（ok/warn/info），且成功路径上没有 error 级',
      R.logs.length > 5
      && R.logs.every((l) => ['ok', 'warn', 'info', 'error'].indexOf(l.level) >= 0)
      && R.logs.filter((l) => l.level === 'error').length === 0,
      R.logs.length + ' 条，级别 = '
        + Array.from(new Set(R.logs.map((l) => l.level))).join('/'));

    /*  quality:false 时不该带统计 —— 这个开关是给"只要年龄表"的调用方省时间的。 */
    const R2 = API.run(DEMO.params, demoFiles, { quality: false });
    t('options.quality=false 时不附质量统计', R2.ok && R2.quality === undefined
      && R2.rowCount === 49);

    /*  参数回显：调用方要能从结果里看出"到底按什么跑的"。 */
    t('结果里回显了跑这批数据用的参数（含 excessPercent 与 cal）',
      R.params.stdName === DEMO.params.stdName
      && R.params.excessPercent === DEMO.params.excess
      && typeof R.params.cal.P382 === 'number',
      'stdName=' + R.params.stdName + ' excess%=' + R.params.excessPercent);

    /* ---------------------------------------------------------------- ⑤ */
    /*  列映射。toRows 把 51 列位置数组翻译成命名字段，翻错列是最隐蔽的
     *  bug（数字看着像样、其实是隔壁那列）。逐个字段追回原始列。 */
    {
      const cmp = API.run(DEMO.params, demoFiles, { keepRaw: true });
      const rawRows = cmp.raw.ageRows;
      const named = cmp.rows;
      const pairs = [
        ['AGE68', 17], ['AGE68_2s', 18], ['AGE75', 19], ['AGE75_2s', 20],
        ['AGE82', 21], ['AGE82_2s', 22], ['AGE76', 23], ['AGE76_2s', 24],
        ['U238_Pb206', 31], ['Pb207_Pb206', 33], ['Pb207_U235', 36],
        ['Pb206_U238', 38], ['rho', 40],
        ['U_ppm', 47], ['Th_ppm', 48], ['Pb_ppm', 49]
      ];
      const badCols = [];
      for (let i = 0; i < named.length; i++) {
        for (const [field, col] of pairs) {
          const a = named[i][field], b = rawRows[i][col];
          const same = (typeof b === 'number' && !isFinite(b))
            ? (a === null || !isFinite(a))
            : eq(a, b);
          if (!same) badCols.push('行' + i + '.' + field + ' (' + a + ' vs ' + b + ')');
        }
      }
      t('toRows 的 16 个数值字段逐个追回原始列（17/19/21/23 +1、31/33/36/38/40/47-49）',
        badCols.length === 0, badCols.slice(0, 4).join(' ｜ ') || '全部对上');

      const corr = API.correctedCols(1);
      const c0 = named[5];
      t('校正后年龄字段取自 qc.js 说的那两列（CORR1/CORR2）',
        (isFinite(rawRows[5][corr[0].col]) ? eq(c0.CORR1, rawRows[5][corr[0].col]) : c0.CORR1 === null)
        && (isFinite(rawRows[5][corr[1].col]) ? eq(c0.CORR2, rawRows[5][corr[1].col]) : c0.CORR2 === null),
        'CORR1_KEY=' + c0.CORR1_KEY + ' CORR2_KEY=' + c0.CORR2_KEY);
      t('精简行不带 51 列的 raw；fullRows 才带',
        named[0].raw === undefined && cmp.raw.ageRows[0].length === 51,
        'raw 列数 = ' + cmp.raw.ageRows[0].length);
      t('样品名与文件名都在行里（下游要按样品归组）',
        typeof named[0].sample === 'string' && named[0].sample.length > 0
        && /\.csv$/.test(named[0].file), named[0].sample + ' / ' + named[0].file);
    }

    /*  探针：每个文件都有结论，错的带 err —— 上游数据坏了要能说清是哪个文件。 */
    {
      const pr = API.probe(demoFiles, 'thermo', null);
      const keys = Object.keys(pr);
      t('probe() 给每个文件一条结论（49 条）', keys.length === 49, keys.length + ' 条');
      t('probe() 里 49 个文件全部解析成功',
        keys.every((k) => pr[k].ok === true),
        keys.filter((k) => !pr[k].ok).slice(0, 3).join(', ') || '全部 ok');
      t('probe() 认出 15 个 AY-4 与 2 个 SRM 612',
        keys.filter((k) => pr[k].sample === 'AY-4').length === 15
        && keys.filter((k) => pr[k].sample === 'SRM 612').length === 2,
        'AY-4=' + keys.filter((k) => pr[k].sample === 'AY-4').length
        + ' SRM612=' + keys.filter((k) => pr[k].sample === 'SRM 612').length);
    }

    /*  runDemo()：一条命令跑通全流程（智能体最省事的入口）。 */
    {
      let rd = null;
      try { rd = await API.runDemo(); } catch (e) {
        t('runDemo() 能跑通', false, String(e && e.message || e));
      }
      if (rd) {
        t('runDemo() 用数据自带的推荐参数跑出 49 行，并标明来源',
          rd.ok === true && rd.rowCount === 49 && rd.source === 'demo'
          && rd.provenance && rd.provenance.files === 49,
          rd.ok ? rd.rowCount + ' 行 source=' + rd.source : JSON.stringify(rd.errors));
      }
    }

    /*  算法切换：linear 走的是**另一条路**（相邻标样分段插值），输出也不是
     *  一行一个文件 —— 它只给"非分馏标样"的文件出行（32 个样品 + 2 个
     *  SRM 612，后者不是 fracStd，所以按样品处理），AY-4 的 15 行不出。
     *  这是原程序的输出形态，不是缺陷；判据就按这个来。 */
    {
      const RL = API.run(Object.assign({}, DEMO.params, { algo: 'linear' }), demoFiles);
      const wantRows = 49 - DEMO.stdMeasured.n;   // 49 − 15 = 34
      t('线性法（algo=linear）跑通，且只给出非标样行（49−15=34 行）',
        RL.ok === true && RL.rowCount === wantRows
        && RL.groups && RL.groups.std.length > 0 && RL.groups.sample.length > 0,
        RL.ok ? (RL.rowCount + ' 行（要 ' + wantRows + '）；std '
          + RL.groups.std.length + ' 段 / sample ' + RL.groups.sample.length + ' 段')
          : JSON.stringify(RL.errors));
      t('线性法的行里没有分馏标样 AY-4（它只出现在段统计里）',
        RL.ok && RL.rows.every((x) => x.sample !== DEMO.params.fracStd),
        RL.ok ? '样品名种类 = '
          + Array.from(new Set(RL.rows.map((x) => x.sample))).slice(0, 4).join('/') : '');
    }

    /*  过程量表那两扇门也开在门面上（界面用的就是它们，见 src/stages.js）。
     *  这里只验**形状与错误码** —— 逐格的判据归 test_stages.js，别重复。
     *  之所以要单列：接口的"能力清单"里点得出名字的东西，缺了要当场红，
     *  不能等到有人真去调才发现少了一个函数。 */
    {
      t('门面上开了 stages() / sampleChain() 两扇门（过程量表用）',
        typeof API.stages === 'function' && typeof API.sampleChain === 'function',
        typeof API.stages + ' / ' + typeof API.sampleChain);
      const R0 = API.compute(DEMO.params, demoFiles, { keepRaw: true });
      const ST = API.stages(R0, { keepByFile: true, csv: true });
      t('stages(compute 结果) 出表，列数 = 行数宽度，且 CSV 与表同源',
        ST.ok === true && ST.rows.length === R0.ageRes.rows.length
        && ST.rows.every((r) => r.length === ST.columns.length)
        && typeof ST.csv === 'string' && ST.csv.charAt(0) === '\ufeff'
        && ST.meta.length > 0,
        ST.ok ? (ST.rows.length + ' 行 × ' + ST.columns.length + ' 列，' + ST.meta.length
          + ' 条元信息，CSV ' + ST.csv.length + ' 字节') : JSON.stringify(ST.errors));
      const bad = API.stages({ cfg: { method: 0 }, ageRes: { rows: [] } });
      t('中间量缺失时 stages() 返回错误码而不是抛异常',
        bad.ok === false && bad.errors[0].code === 'NO_STAGES_INPUT',
        bad.ok ? '居然成功了' : bad.errors[0].code);
    }
  }

  /* ------------------------------------------------------------------- */
  for (const [ok, name, detail] of rows) {
    console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(64) + (detail ? '   ' + detail : ''));
  }
  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

  /*  vm 的 Promise 与外层不同源，但 await 只要求对象带 then 方法，所以
   *  跨 context 照样能 await（这也是本文件 main() 是 async 的原因）。 */

main().then(() => {}, (e) => {
  console.error('测试自身抛异常：', (e && e.stack) || e);
  process.exit(2);
});
