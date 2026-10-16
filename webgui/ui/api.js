/* ==========================================================================
 *  api.js —— 面向程序的统一入口（window.DS_API）
 *
 *  这个文件**不碰 DOM**：输入是普通对象/数组，输出是普通 JSON。它把
 *  「参数 → 解析 → 还原 → 年龄 → 质量统计」串成一次调用，供三类使用者：
 *      ① 智能体 / 自动化脚本（无头浏览器里 await DS_API.run(...)）
 *      ② Node 里的服务端调用（本文件也能 require，见文件尾）
 *      ③ 界面自己 —— ui/app.js 点"开始计算"走的就是这里的 compute()，
 *         不是另写一条并行的实现。所以"API 算出来的"与"界面上看到的"
 *         是同一串数字，而不是"应该一样"。
 *
 *  ★ 唯一真源：calAge / PB_SPEC / 模块接线 / 管线段 / 参数校验，
 *    此前散在 ui/app.js 的闭包里，现在都搬到这里。app.js 引用本文件，
 *    改这里等于同时改界面 —— 反过来也成立。唯一不准的是"两边各抄一份"。
 *
 *  约定：
 *      · 参数名与内置示例数据自带的那份推荐参数（DS_DEMO_REAL.params）一致，
 *        所以示例参数可以原样喂进来：DS_API.run(D.params, files)。
 *      · 所有失败都返回 { ok:false, errors:[{code, message}] }，不抛异常
 *        （除非调用方主动用 compute() 之外的底层函数）。错误码是给机器看的，
 *        message 是给人看的。
 *      · 不写本地存储、不发网络请求。
 *
 *  用法（浏览器控制台 / CDP / 智能体）：
 *      const D = window.DS_DEMO_REAL;
 *      const files = await D.decode();
 *      const r = window.DS_API.run(D.params, files);
 *      r.rows.length        // 年龄表行数
 *      r.quality.summary    // 质量统计
 *
 *  自描述：DS_API.capabilities() / DS_API.schema() / DS_API.tool()
 * ========================================================================== */
'use strict';

(function () {
  var G = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined') ? globalThis : this;

  var VERSION = '1.0';

  /* ======================================================================
   *  一、依赖与接线
   *
   *  数值模块由页面在 src/*.js 里先加载（Node 里由调用方先 require）。
   *  本模块只做**接线**与编排，一个数值都不在这里实现。
   * ==================================================================== */

  /** 全局模块名 —— 与 build_ui.py 的 REQUIRED_GLOBALS 对齐。 */
  var MODULE_KEYS = {
    DS: 'DS',            // math.js 汇总出来的数值内核
    AGE: 'DS_AGE',
    PL: 'DS_PIPELINE',
    TH: 'DS_THERMO',
    W: 'DS_WINDOW',
    FP: 'DS_FP',
    QC: 'DS_QC',
    RP: 'DS_REPORT',
    STAGES: 'DS_STAGES', // 过程量（中间环节）宽表，见 src/stages.js
    QR: 'DS_QCREPORT',   // 可选：只有出报告时用
    DEMO: 'DS_DEMO_REAL' // 可选：只有取内置示例时用
  };

  /** 必需模块（少一个就算不 ready）。QR / DEMO 是可选的。 */
  var REQUIRED = ['DS', 'AGE', 'PL', 'TH', 'W', 'FP', 'QC', 'RP', 'STAGES'];

  var WIRED = false;

  function pick() {
    var m = {};
    for (var k in MODULE_KEYS) m[k] = G[MODULE_KEYS[k]];
    return m;
  }

  /**
   * 接线。幂等 —— 重复调用不会改变任何已注入的值（同样的函数再 assign 一次）。
   * 缺模块时抛，由 compute() 转成 MODULE_MISSING 错误码。
   */
  function wire() {
    var m = pick();
    var missing = REQUIRED.filter(function (k) { return !m[k]; });
    if (missing.length) {
      throw mkerr('MODULE_MISSING', '缺少数值模块：'
        + missing.map(function (k) { return MODULE_KEYS[k]; }).join('、')
        + ' —— 页面可能被手工改过，或来自旧版构建。');
    }
    if (WIRED) return m;
    //  与 test_e2e.js 完全一致的接线顺序（那里是逐字节比对的基准）
    m.W.setNumeric(m.DS);
    m.PL.attach({
      thermoLoad: m.TH.thermoLoad,
      agilentLoad: m.TH.agilentLoad,
      thermoSampleName: m.TH.thermoSampleName,
      detectSignalWindow: m.W.detectSignalWindow,
      nmean: m.DS.nmean,
      untagInt: m.DS.untagInt,
      reduceSample: m.DS.reduceSample,
      buildMeanCpsCsv: m.RP.buildMeanCpsCsv,
      buildResultAllCsv: m.RP.buildResultAllCsv
    });
    m.AGE.attach({
      pwSum: m.DS.pwSum, nnanmean: m.DS.nnanmean,
      age76Pb: m.DS.age76Pb, age76PbFixed: m.DS.age76PbFixed, sk2model: m.DS.sk2model
    });
    WIRED = true;
    return m;
  }

  /** 稳定的同位素通道名（与桌面版 isoname 一致）。 */
  var ISO_THERMO = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'];
  //  Agilent 的 isoname 来自桌面版 instructure1()：202Hg 按原列名匹配，
  //  其余同位素按"只留数字"匹配（列名 204Pb / 206Pb / … 都能命中）。
  var ISO_AGILENT = ['时间 [s]', '202', '204', '206', '207', '208', '232', '238'];

  function isonameFor(inst) { return inst === 'agilent' ? ISO_AGILENT : ISO_THERMO; }

  /* ======================================================================
   *  二、Cal_age 与普通铅参数
   *
   *  这两块原本在 ui/app.js 的闭包里。搬到 API 里是因为**参数归一化**
   *  （把朴素 JSON 变成管线认的 cfg）必须能脱离 DOM 进行 —— 智能体与
   *  Node 调用者都不会去填输入框。
   * ==================================================================== */

  /**
   * Cal_age —— 原 main() 里的那个闭式函数（Isoclock2.0.py:3096）
   *
   *  写成字面量逐一对应，不做化简：0.000000000155125 就是 1.55125e-10，
   *  但保持和源码一样的乘序，免得浮点末位出现无谓的差别。
   */
  function calAge(age) {
    var FP = G.DS_FP;
    var a = FP.dexp(0.000000000155125 * age * 1000000) - 1;
    var b = FP.dexp(0.00000000098485 * age * 1000000) - 1;
    var c = FP.dexp(0.000000000049475 * age * 1000000) - 1;
    var P382 = 1 / 137.818 * (b / a);
    var Q8 = 18.700 - a * 9.735;
    var R8 = 15.628 - b * (9.735 / 137.818);
    var S8 = 38.630 - c * 36.837;
    return { a: a, b: b, c: c, P382: P382, Q8: Q8, R8: R8, S8: S8,
      Pbc: R8 / Q8, Standard_age: age };
  }

  /**
   * 普通铅参数：对应 PbCorrSamples()（Isoclock2.0.py:2809）
   *
   *  注意原实现里 method 2/4 的"按年龄推算"用的是系数 36.630，
   *  而 Cal_age 里 S8 用的是 36.837 —— 两处不一致，这里按 PbCorrSamples 的写法。
   *
   *  "按年龄推算"里的 age 是**估算的样品年龄**（界面上那个 100 Ma 的输入框），
   *  不是标样年龄 —— 原实现 PbCorrSamples() 里是自己用 age 重算 exp 的。
   *  所以下面每个 byAge(eg) 收到的 eg 是 calAge(估算年龄)，不是 calAge(标样年龄)。
   */
  var PB_SPEC = {
    0: [],
    1: [
      { k: 'Radioactive_Pb', label: '放射性 207Pb/206Pb', def: '0.048015',
        byAge: function (eg) { return eg.P382; } },
      { k: 'common_Pb', label: '初始 207Pb/206Pb', def: '0.842185',
        byAge: function (eg) { return eg.Pbc; } }
    ],
    2: [
      { k: 'common_Pb206_208', label: '初始 206Pb/208Pb', def: '0.48240',
        byAge: function (eg) { return eg.Q8 / (38.630 - eg.c * 36.630); } },
      { k: 'common_Pb207_208', label: '初始 207Pb/208Pb', def: '0.40628',
        byAge: function (eg) { return eg.R8 / (38.630 - eg.c * 36.630); } }
    ],
    3: [
      { k: 'common_Pb207_204', label: '初始 207Pb/204Pb', def: '15.6207',
        byAge: function (eg) { return eg.R8; } },
      { k: 'common_Pb206_204', label: '初始 206Pb/204Pb', def: '18.5478',
        byAge: function (eg) { return eg.Q8; } }
    ],
    4: [
      { k: 'common_Pb207_204', label: '初始 207Pb/204Pb', def: '15.6207',
        byAge: function (eg) { return eg.R8; } },
      { k: 'common_Pb206_204', label: '初始 206Pb/204Pb', def: '18.5478',
        byAge: function (eg) { return eg.Q8; } },
      { k: 'common_Pb208_204', label: '初始 208Pb/204Pb', def: '38.447',
        byAge: function (eg) { return 38.630 - eg.c * 36.630; } },
      //  fromAge：原实现**从不问用户**，两个分支都用当前全局 age 现算（= P382）。
      //  照抄：界面上这一格恒为灰（不可编辑），值随估算年龄联动。
      //  附注：原实现在"直接输入同位素"分支下用的是**残留的全局 age**，
      //         首次运行就直接 NameError。网页版固定按估算年龄算，去掉这个不确定性。
      { k: 'radioactiveS_Pb207_206', label: '样品放射性 207Pb/206Pb',
        fromAge: true }
    ]
  };

  var EST_AGE_DEFAULT = 100;

  /**
   * 出厂默认参数。
   *
   *  ⚠ 这**不是**"随便哪份数据都能用的参数" —— 激光开窗时间是对数据敏感的
   *  （b0/b1 说的是"第几秒到第几秒是信号"）。它只是让"不传参数"也能跑通，
   *  好让调用者先拿到结构、再逐项调。真数据请用数据自带的推荐参数
   *  （内置示例是 DS_DEMO_REAL.params），或自己量一遍。
   *
   *  自检里钉了一条：这份 DEFAULT_PARAMS 必须与内置示例的推荐参数逐字段相同
   *  （见 ui/selftest.js）—— 免得两处默认值悄悄分家。
   */
  var DEFAULT_PARAMS = {
    inst: 'thermo',
    b0: 1, b1: 25, multi: 4,
    stdName: 'AY-4', stdAge: 158.2, fracStd: 'AY-4',
    nistStd: 'SRM 612',
    method: 1, algo: 'avg', excess: 3,
    estimateAge: EST_AGE_DEFAULT,
    fix76: true
  };

  /** 校正方式 → 人可读的说明（界面下拉、报告、错误信息共用）。 */
  var METHODS = [
    { value: 0, label: '0 · 不校正（用未校正比值）' },
    { value: 1, label: '1 · 207Pb 校正' },
    { value: 2, label: '2 · 208Pb 校正' },
    { value: 3, label: '3 · 204Pb 校正' },
    { value: 4, label: '4 · Cal 204Pb 校正' }
  ];

  /* ======================================================================
   *  三、参数归一化与校验
   * ==================================================================== */

  function mkerr(code, message, field) {
    var e = new Error(message);
    e.code = code;
    e.field = field || null;
    return e;
  }

  function num(v, dflt, field, code) {
    if (v === undefined || v === null || v === '') return dflt;
    var x = (typeof v === 'number') ? v : Number(String(v).trim());
    if (!isFinite(x)) throw mkerr(code || 'BAD_NUMBER', '参数 ' + field + ' 不是数字：' + v, field);
    return x;
  }

  function intOf(v, dflt, field) { return Math.round(num(v, dflt, field)); }

  function str(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

  /** 已经归一化过（= readConfig() 的输出形状）就直接用。
   *  ★ 必须返回**真布尔**：调用方会写 `if (isCfg(x))`，也会写
   *    `isCfg(x) === false`；返回值若是 undefined，后一种写法就悄悄失灵。 */
  function isCfg(x) {
    return !!(x && typeof x === 'object' && x.cal && x.params
      && typeof x.excessV === 'number' && typeof x.method === 'number');
  }

  /**
   * 朴素 JSON 参数 → 管线认的 cfg。
   *
   *  接受的名字就是内置示例 DS_DEMO_REAL.params 里的那些（inst / stdName /
   *  stdAge / fracStd / nistStd / method / algo / excess / b0 / b1 / multi），
   *  所以示例参数可以原样传进来。另有两个可选：estimateAge、fix76。
   */
  function normalize(p) {
    if (p === undefined || p === null) p = {};
    if (typeof p !== 'object') throw mkerr('BAD_PARAMS', '参数必须是对象，收到 ' + typeof p);

    var inst = str(p.inst || p.instrument || DEFAULT_PARAMS.inst).toLowerCase();
    if (inst !== 'thermo' && inst !== 'agilent') {
      throw mkerr('BAD_INSTRUMENT', '仪器只支持 thermo 或 agilent，收到「' + inst + '」', 'inst');
    }

    var method = intOf(p.method, DEFAULT_PARAMS.method, 'method');
    if (method < 0 || method > 4) {
      throw mkerr('BAD_METHOD', '普通铅校正方式只能是 0–4，收到 ' + method, 'method');
    }

    var algo = str(p.algo || p.algorithm || DEFAULT_PARAMS.algo).toLowerCase();
    if (algo !== 'avg' && algo !== 'linear') {
      throw mkerr('BAD_ALGO', '年龄层算法只支持 avg（平均法）或 linear（线性法），收到「'
        + algo + '」', 'algo');
    }

    //  excess 在界面上按**百分数**填（3 表示 3%），源码里是小数 —— 与 app.js 一致。
    var excess = num(p.excess !== undefined ? p.excess : p.excessPercent,
      DEFAULT_PARAMS.excess, 'excess');
    var estAge = num(p.estimateAge, EST_AGE_DEFAULT, 'estimateAge');
    if (!isFinite(estAge) || estAge <= 0) estAge = EST_AGE_DEFAULT;

    var gs = calAge(num(p.stdAge, DEFAULT_PARAMS.stdAge, 'stdAge'));
    var ge = calAge(estAge);

    var byAge = !!p.pbByAge;
    var given = p.pbParams || {};
    var params = { age: estAge };
    PB_SPEC[method].forEach(function (spec) {
      if (spec.fromAge) { params[spec.k] = ge.P382; return; }   // 不受勾选影响
      if (given[spec.k] !== undefined) {                        // 显式给了就用给的
        params[spec.k] = num(given[spec.k], 0, 'pbParams.' + spec.k);
        return;
      }
      params[spec.k] = byAge ? spec.byAge(ge) : Number(spec.def);
    });

    return {
      method: method,
      inst: inst,
      fix76: (p.fix76 === undefined) ? DEFAULT_PARAMS.fix76 : !!p.fix76,
      excessV: excess / 100,
      nistStd: str(p.nistStd || p.traceElementStandard) || null,
      standard: str(p.fracStd || p.fractionationStandard),  // 分馏校正用的标样名
      stdName: str(p.stdName || p.standard),                // 年龄层认的标样名
      stdAge: num(p.stdAge, DEFAULT_PARAMS.stdAge, 'stdAge'),
      algo: algo,
      b0: num(p.b0, DEFAULT_PARAMS.b0, 'b0'),
      b1: num(p.b1, DEFAULT_PARAMS.b1, 'b1'),
      multi: num(p.multi, DEFAULT_PARAMS.multi, 'multi'),
      params: params,
      cal: gs
    };
  }

  /**
   * 校验 —— 判据与界面「开始计算」按下时的那五条**逐字相同**。
   * 返回 [{code, field, message}]，空数组表示可以跑。
   */
  function validate(cfg, files) {
    var out = [];
    function need(cond, code, field, message) {
      if (!cond) out.push({ code: code, field: field || null, message: message });
    }
    need(files && files.length, 'NO_FILES', 'files', '没有数据文件');
    need(!!cfg.stdName, 'MISSING_STD_NAME', 'stdName', '没有填标样名');
    need(isFinite(cfg.stdAge), 'BAD_STD_AGE', 'stdAge', '标样年龄不是数字');
    need(cfg.excessV >= 0, 'BAD_EXCESS', 'excess', '外挂误差不是数字');
    need(!!cfg.standard, 'MISSING_FRAC_STD', 'fracStd', '没有填分馏校正标样');
    return out;
  }

  /* ======================================================================
   *  四、日志
   *
   *  级别用界面那套字母（'g' 好 / 'w' 警告 / 'e' 错误），另给语义级别，
   *  好让机器不用去猜颜色。文案**逐字**沿用界面 —— 截图里的日志面板、
   *  报告里的说明与这里的字符串是同一份。
   * ==================================================================== */

  var LEVEL_OF = { g: 'ok', w: 'warn', e: 'error' };

  function makeLogger(hook) {
    var logs = [];
    return {
      logs: logs,
      line: function (text, cls) {
        logs.push({ level: LEVEL_OF[cls] || 'info', cls: cls || null, text: text });
        if (hook) hook(text, cls);
      }
    };
  }

  /** 把异常收成一条错误 —— 不往调用方抛。 */
  function fail(log, e, code) {
    var err = { code: (e && e.code) || code || 'ERROR',
      field: (e && e.field) || null,
      message: String((e && e.message) || e) };
    log.line('!! ' + err.message, 'e');
    return { ok: false, apiVersion: VERSION, errors: [err], logs: log.logs };
  }

  /* ======================================================================
   *  五、文件与探针
   * ==================================================================== */

  /** 接受 {file,text} / {name,text} / {fileName,text}；text 必须是字符串。 */
  function normFile(f) {
    if (!f || typeof f !== 'object') {
      throw mkerr('BAD_FILE', '文件项必须是 {file, text} 对象，收到 ' + typeof f);
    }
    var name = str(f.file || f.name || f.fileName);
    if (!name) throw mkerr('BAD_FILE', '文件项缺少文件名（file / name）');
    if (typeof f.text !== 'string') {
      throw mkerr('BAD_FILE', '文件「' + name + '」的 text 必须是字符串'
        + '（Node 里请自己 readFileSync 成 utf-8）');
    }
    return { file: name, text: f.text };
  }

  function probeOne(f, inst, sampleNames, m) {
    try {
      var ch = (inst === 'agilent' ? m.TH.agilentLoad : m.TH.thermoLoad)(f.text, isonameFor(inst));
      var sn = m.PL.sampleNameFor(f.file, f.text, sampleNames, inst);
      return { file: f.file, ok: true, n: ch.x.length, sample: sn.name,
        sampleFrom: sn.from, notes: ch.notes || [], err: null };
    } catch (e) {
      return { file: f.file, ok: false, n: 0, sample: null, sampleFrom: null,
        notes: [], err: String((e && e.message) || e) };
    }
  }

  /** 读取阶段的提示（兼容读取、缺列补零等）按文件收集起来，质检要用。 */
  function fileNotesFrom(pm) {
    var out = {};
    for (var f in pm) {
      var p = pm[f];
      if (p && p.ok && p.notes && p.notes.length) out[f] = p.notes.slice();
    }
    return out;
  }

  /** 每个文件轻量解析一遍：样品名、点数、读取笔记、错误。 */
  function probeFiles(files, inst, sampleNames) {
    var m = wire();
    var map = {};
    (files || []).forEach(function (f) { map[f.file] = probeOne(f, inst, sampleNames, m); });
    return map;
  }

  /* ======================================================================
   *  六、compute —— 解析 + 还原 + 年龄
   *
   *  这一段是 ui/app.js 里"开始计算"按钮的**那一段代码**，逐行搬来这里。
   *  界面调它、API 调它，用同一个实现。
   * ==================================================================== */

  function now() { return (G.performance || Date).now(); }

  function buildPipeCfg(cfg, files, sampleNames) {
    var stdSet = {};
    stdSet[cfg.stdName] = cfg.stdAge;
    return {
      files: files,
      isoname: isonameFor(cfg.inst),
      b0: cfg.b0, b1: cfg.b1, multi: cfg.multi,
      stdcor: 0, method: cfg.method, standardNames: stdSet,
      ctx: cfg.cal, eleIndex: 2, instrument: cfg.inst,
      sampleNames: sampleNames
    };
  }

  function buildAgeCfg(cfg) {
    return {
      method: cfg.method, excessV: cfg.excessV,
      nistStd: cfg.nistStd, standard: cfg.standard,
      P382: cfg.cal.P382, a: cfg.cal.a, b: cfg.cal.b, c: cfg.cal.c,
      Pbc: cfg.cal.Pbc,
      age: cfg.params.age,
      radioactivePb: cfg.params.Radioactive_Pb,
      commonPb: cfg.params.common_Pb,
      commonPb206_208: cfg.params.common_Pb206_208,
      commonPb207_208: cfg.params.common_Pb207_208,
      commonPb206_204: cfg.params.common_Pb206_204,
      commonPb207_204: cfg.params.common_Pb207_204,
      commonPb208_204: cfg.params.common_Pb208_204,
      radioactiveSPb207_206: cfg.params.radioactiveS_Pb207_206
    };
  }

  /**
   * 跑一遍：参数校验 → 探针 → 管线 → 年龄。
   *
   *  @param input  朴素参数对象，或已归一化的 cfg（isCfg 为真）
   *  @param files  [{file, text}, ...]
   *  @param opts   { log(text,cls), probeMap, sampleNames, keepRaw }
   *  @returns { ok, cfg, errors, logs, stats, out?, ageRes, ageInput? }
   */
  function compute(input, files, opts) {
    opts = opts || {};
    var log = makeLogger(opts.log);
    var m;
    try { m = wire(); } catch (e) { return fail(log, e, 'MODULE_MISSING'); }

    var cfg;
    try { cfg = isCfg(input) ? input : normalize(input); }
    catch (e) { return fail(log, e, 'BAD_PARAMS'); }

    var bad0 = null;
    try { files = (files || []).map(normFile); }
    catch (e) { bad0 = e; }
    if (bad0) return fail(log, bad0, 'BAD_FILE');

    /* --- 参数校验（与界面逐字相同的五条判据）--- */
    var errors = validate(cfg, files);
    if (errors.length) {
      log.line('!! ' + errors.map(function (x) { return x.message; }).join('；'), 'e');
      return { ok: false, apiVersion: VERSION, cfg: cfg, errors: errors,
        logs: log.logs, files: files.map(function (f) { return f.file; }) };
    }

    /* --- 探针 --- */
    var pm = opts.probeMap;
    if (!pm) {
      try { pm = probeFiles(files, cfg.inst, opts.sampleNames); }
      catch (e) { return fail(log, e, 'PROBE_ERROR'); }
    }
    var probe = function (f) { return pm[f.file] || { ok: false, err: '没有探针结果' }; };

    var badFiles = files.filter(function (f) { return !probe(f).ok; });
    if (badFiles.length) {
      log.line('!! ' + badFiles.length + ' 个文件没能解析：' + badFiles.slice(0, 5).map(function (f) {
        return f.file;
      }).join('、') + (badFiles.length > 5 ? ' 等' : ''), 'e');
      log.line('   原因（第一个）：' + probe(badFiles[0]).err, 'e');
      if (badFiles.length === files.length) {
        return { ok: false, apiVersion: VERSION, cfg: cfg,
          errors: [{ code: 'ALL_FILES_UNPARSED', field: 'files',
            message: '所有文件都解析失败：' + probe(badFiles[0]).err }],
          logs: log.logs, probe: pm,
          files: files.map(function (f) { return f.file; }) };
      }
    }
    if (cfg.inst === 'agilent' && !opts.sampleNames) {
      var stemCount = files.filter(function (f) {
        return probe(f).ok && probe(f).sampleFrom === 'file';
      }).length;
      log.line('  提示：Agilent 的样品名在桌面版来自那份 Excel 清单，本次没提供清单，'
        + stemCount + ' 个文件的样品名是取文件名（第一个点之前）得到的 —— 请核对列表里的样品名。', 'w');
    }

    var stdFiles = files.filter(function (f) { return probe(f).sample === cfg.stdName; });
    log.line('标样「' + cfg.stdName + '」在数据里出现 ' + stdFiles.length + ' 个文件');
    if (!stdFiles.length) {
      log.line('!! 没有任何文件属于这个标样名 —— 分馏因子会取到空集合。', 'e');
      if (cfg.algo === 'avg') {
        return { ok: false, apiVersion: VERSION, cfg: cfg,
          errors: [{ code: 'STD_NOT_FOUND', field: 'stdName',
            message: '标样名「' + cfg.stdName + '」在数据里找不到' }],
          logs: log.logs, probe: pm,
          files: files.map(function (f) { return f.file; }) };
      }
    }

    var nistFiles = [];
    if (cfg.nistStd) {
      nistFiles = files.filter(function (f) { return probe(f).sample === cfg.nistStd; });
      if (nistFiles.length < 2) {
        log.line('!! 微量元素外标「' + cfg.nistStd + '」只出现 ' + nistFiles.length
          + ' 次。原实现在这种情况下会把系数静默置 0（网页版照抄了这个行为）。', 'w');
      }
    }

    log.line('开始：' + files.length + ' 个文件，仪器 '
      + (cfg.inst === 'agilent' ? 'Agilent' : 'Thermo')
      + '，Pb 校正方式 ' + cfg.method
      + '，年龄层用' + (cfg.algo === 'avg' ? '平均法' : '线性法')
      + '，²⁰⁷Pb/²⁰⁶Pb 迭代' + (cfg.fix76 ? '已修正' : '按桌面版原样'));
    var t0 = now();

    var out;
    try {
      out = m.PL.run(buildPipeCfg(cfg, files, opts.sampleNames));
    } catch (e) {
      log.line('!! 读取/还原阶段出错：' + ((e && e.stack) || e), 'e');
      return { ok: false, apiVersion: VERSION, cfg: cfg,
        errors: [{ code: 'PIPELINE_ERROR', message: '读取/还原阶段出错：'
          + String((e && e.message) || e) }],
        logs: log.logs, probe: pm,
        files: files.map(function (f) { return f.file; }) };
    }
    log.line('  还原阶段完成：' + out.resultRows.length + ' 行，'
      + out.meanRows.length + ' 行计数');

    var ageInput = m.AGE.buildInput(out.resultAllCsv, out.meanCpsCsv, null);
    ageInput.fix76 = cfg.fix76;
    ageInput.cfg = buildAgeCfg(cfg);

    var ageRes;
    try {
      ageRes = (cfg.algo === 'avg') ? m.AGE.averageAge(ageInput) : m.AGE.linearAge(ageInput);
    } catch (e) {
      log.line('!! 年龄层出错：' + ((e && e.stack) || e), 'e');
      return { ok: false, apiVersion: VERSION, cfg: cfg,
        errors: [{ code: 'AGE_ERROR', message: '年龄层出错：' + String((e && e.message) || e) }],
        logs: log.logs, probe: pm,
        files: files.map(function (f) { return f.file; }) };
    }
    var dt = now() - t0;

    log.line('  年龄层完成：' + ageRes.rows.length + ' 行 × 51 列', 'g');
    var warnings = [];
    if (ageRes.warnings && ageRes.warnings.divZero) {
      log.line('  ' + ageRes.warnings.divZero + ' 行因分母为零无法完成普通铅校正'
        + '（204 通道过弱或普通铅参数退化），相关列已置为 NaN。', 'w');
      warnings.push({ code: 'DIV_ZERO_COMMON_PB', n: ageRes.warnings.divZero,
        text: '有 ' + ageRes.warnings.divZero + ' 行因分母为零无法完成普通铅校正。' });
    }
    //  两种算法的诊断信息不一样：平均法只有一个全局分馏因子；
    //  线性法是每个标样段各自一套 A/B 因子，报"段数"更实在。
    if (ageRes.factors) {
      log.line('  分馏因子：207/206 f=' + ageRes.factors.f207_206.toPrecision(6)
        + '  206/238 f=' + ageRes.factors.f206_238.toPrecision(6)
        + '  207/235 f=' + ageRes.factors.f207_235.toPrecision(6)
        + '  208/232 f=' + ageRes.factors.f208_232.toPrecision(6));
    } else if (ageRes.groups) {
      log.line('  标样段 ' + ageRes.groups.std.length + ' 组，非标样段 '
        + ageRes.groups.sample.length + ' 组（相邻标样插值）');
    }
    if (ageRes.coefficients) {
      var co = ageRes.coefficients;
      var zero = co.every(function (v) { return v === 0; });
      log.line('  微量元素系数：U238=' + fmtNum(co[0]) + '  Th232=' + fmtNum(co[1])
        + '  Pb=' + fmtNum(co[2]));
      if (zero && cfg.nistStd) {
        log.line('  ! 系数全是 0 —— 外标「' + cfg.nistStd + '」在这批数据里出现 '
          + '0 次或 1 次时原实现就会这样（异常被吞掉），属已知行为。', 'w');
        warnings.push({ code: 'TRACE_COEF_ZERO',
          text: '微量元素系数全是 0（外标出现 0 或 1 次时原实现即如此）。' });
      }
    }

    //  哪里才算"校正后年龄"，交给 qc.js 的列映射去说 —— 别在这里硬编码列号。
    //  ⚠ 第 25 列（1 起算）在数据里装的是**备注文字**，不是表头写的校正年龄：
    //     age.js 的 row 在 concat 那两段之前放的就是 comments。
    //     （界面版曾在这里判 r[25]，备注一非空就会虚报一堆"校正后年龄是 NaN"。）
    var corrCols = [];
    if (cfg.method > 0) {
      var cc = m.QC.QC_CORR_COL[cfg.method];
      if (cc) corrCols = Object.keys(cc).map(function (k) { return cc[k]; });
    }
    var nanRows = 0;
    var nanCorr = 0;
    ageRes.rows.forEach(function (r) {
      if (!isFinite(r[17]) || !isFinite(r[23])) nanRows++;
      //  两个校正年龄都为 NaN 才算这一行没校正成功（只有一个坏，另一个还能用）
      if (corrCols.length && corrCols.every(function (c) { return !isFinite(r[c]); })) {
        nanCorr++;
      }
    });
    if (nanRows) {
      log.line('  ' + nanRows + '/' + ageRes.rows.length + ' 行的年龄是 NaN 或 Inf。', 'w');
      log.line('  最常见的三个原因：① 积分窗口没取对 —— 背景窗落在信号里，'
        + '净信号就成了 0，比值自然算不出来，先看"信号图"页的蓝、绿两条底色；'
        + '② 某个通道计数全为 0（204Pb 路径尤其容易除零）；'
        + '③ 该行的标样名对不上，分馏因子取到了空集合。', 'w');
      warnings.push({ code: 'NAN_ROWS', n: nanRows,
        text: '有 ' + nanRows + '/' + ageRes.rows.length + ' 行的年龄是 NaN 或 Inf。' });
    }
    if (nanCorr) {
      log.line('  另外 ' + nanCorr + ' 行的校正后年龄全是 NaN（第 27 / 29 列）—— '
        + '这些行的普通铅校正没有完成，上面未校正年龄可能仍是好的。', 'w');
      warnings.push({ code: 'NAN_CORRECTED', n: nanCorr,
        text: '另有 ' + nanCorr + ' 行的校正后年龄全是 NaN。' });
    }
    log.line('  用时 ' + dt.toFixed(0) + ' ms', 'g');

    var stats = {
      nFiles: files.length,
      nParsed: files.length - badFiles.length,
      nBadFiles: badFiles.length,
      nStdFiles: stdFiles.length,
      nNistFiles: nistFiles.length,
      nRows: ageRes.rows.length,
      nNaN: nanRows,
      nNaNCorrected: nanCorr,
      samples: out.sampleslist,
      sampleFrom: out.sampleFrom,
      elapsedMs: Math.round(dt)
    };

    var res = {
      ok: true, apiVersion: VERSION,
      cfg: cfg, errors: [], logs: log.logs, warnings: warnings,
      stats: stats, probe: pm,
      files: files.map(function (f) { return f.file; }),
      ageRes: ageRes,
      //  quality() 要用这三样：信号强度取自 meanRows、积分窗口取自 num、
      //  读取提示取自探针。体积都不大，默认带上（第 51 列那堆位置数组才大）。
      //  resultRows / idx / ti / tiGlobal 同理 —— 过程量表（DS_API.stages）
      //  要用，见 src/stages.js 的文件头。
      meanRows: out.meanRows, resultRows: out.resultRows, num: out.num,
      idx: out.idx, ti: out.ti, tiGlobal: out.tiGlobal,
      fileNotes: fileNotesFrom(pm)
    };
    if (opts.keepRaw) { res.out = out; res.ageInput = ageInput; }
    return res;
  }

  function fmtNum(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    return v.toFixed(6).replace(/\.?0+$/, '');
  }

  /* ======================================================================
   *  七、年龄表的列
   *
   *  内部 ageRes.rows 是 51 列的**位置数组**（与原程序一致），直接丢给
   *  智能体既大又难读。这里给出一层命名映射，输出精简行。
   *
   *  ⚠ 第 25 列（0 基）表头与内容不一致（沿用自原程序）：表头写着
   *     `…Pb Corr. Age(Ma)`，数据里却是备注文字。所以校正后年龄取
   *     26/28 两列（由 qc.js 的 QC_CORR_COL 说），不在这里再硬编码一遍。
   * ==================================================================== */

  /** 四个未校正年龄的列（0 基），与 qc.js 的 QC_UNCORR_COL 同源。 */
  var UNCORR_COLS = { AGE68: 17, AGE75: 19, AGE82: 21, AGE76: 23 };

  var UNCORR_DOC = {
    AGE68: { key: '206Pb/238U', label: '206Pb/238U 年龄 (Ma)' },
    AGE75: { key: '207Pb/235U', label: '207Pb/235U 年龄 (Ma)' },
    AGE82: { key: '208Pb/232Th', label: '208Pb/232Th 年龄 (Ma)' },
    AGE76: { key: '207Pb/206Pb', label: '207Pb/206Pb 年龄 (Ma)' }
  };

  /** 校正后年龄的列 —— 取自 qc.js，改口径只需改那一处。 */
  function correctedCols(method) {
    var QC = G.DS_QC;
    var c = QC && QC.QC_CORR_COL[method];
    if (!c) return [];
    return Object.keys(c).map(function (k) { return { key: k, col: c[k] }; });
  }

  /**
   * 51 列位置数组 → 命名字段行。
   *
   *  ⚠ 前两列是**文件名与样品名**（age.js 里 `row = [fileNames[i],
   *     names[i], R76, …]`），不是 CSV 里那个"序号/文件名/样品名"的顺序 ——
   *     这里写反过一次，症状是 sample 字段拿到一个比值、file 字段拿到样品名。
   *  误差列恒在年龄列 +1（qc.js 的 QC_ERR_OFFSET），绘图坐标取 31/33/36/38/40。
   */
  function toRows(ageRes, cfg, opts) {
    opts = opts || {};
    var full = !!opts.fullRows;
    var out = [];
    for (var i = 0; i < ageRes.rows.length; i++) {
      var r = ageRes.rows[i];
      var row = { i: i, file: r[0], sample: r[1] };
      for (var k in UNCORR_COLS) {
        var c = UNCORR_COLS[k];
        row[k] = numOrNull(r[c]);
        row[k + '_2s'] = numOrNull(r[c + 1]);
      }
      var cs = correctedCols(cfg.method);
      if (cs.length >= 1) { row.CORR1 = numOrNull(r[cs[0].col]); row.CORR1_2s = numOrNull(r[cs[0].col + 1]); row.CORR1_KEY = cs[0].key; }
      if (cs.length >= 2) { row.CORR2 = numOrNull(r[cs[1].col]); row.CORR2_2s = numOrNull(r[cs[1].col + 1]); row.CORR2_KEY = cs[1].key; }
      //  绘图坐标（Tera-Wasserburg / Wetherill）与 rho —— IsoplotR 与外部画图要用
      row.U238_Pb206 = numOrNull(r[31]); row.Pb207_Pb206 = numOrNull(r[33]);
      row.Pb207_U235 = numOrNull(r[36]); row.Pb206_U238 = numOrNull(r[38]);
      row.rho = numOrNull(r[40]);
      row.U_ppm = numOrNull(r[47]); row.Th_ppm = numOrNull(r[48]); row.Pb_ppm = numOrNull(r[49]);
      if (full) row.raw = Array.prototype.slice.call(r);
      out.push(row);
    }
    return out;
  }

  function numOrNull(v) {
    return (typeof v === 'number' && isFinite(v)) ? v
      : (typeof v === 'number' ? null : (v === undefined ? null : v));
  }

  /* ======================================================================
   *  八、质量统计
   *
   *  这一块**不是**桌面版 Isoclock 的输出（原程序只出逐点年龄，从不做归组
   *  统计）。公式与判据的定义全在 src/qc.js，这里只做"挑哪一列、要不要
   *  校正后那列"的映射，并把 qc.js 的选择（可能自动退到未校正列）说清楚。
   * ==================================================================== */

  /**
   * 批次质量统计。
   *
   *  职责只有两件：① 决定用哪一列年龄（该种类没有校正列时自动退到未校正列，
   *  并把这件事说清楚，不静默换列）；② 把 qc.js 要的上下文凑齐。
   *  公式、阈值、等级判据**全部在 src/qc.js**，这里一个判据都不重复实现。
   *
   *  ★ 传进来的必须带着上下文：meanRows（信号强度）、num（积分窗口）、
   *    fileNotes（读取提示）、stats.samples（样品名清单）。这些都在
   *    compute() 的返回里；界面上则是从 state.result / probe 里凑 ——
   *    两边传的是**同一组字段**，所以出的报告也一样。
   *
   *  @param compiled compute() 的返回，或等价的 {cfg, ageRes, meanRows, num, ...}
   *  @param opts     { ageKey, corrected, thresholds }
   */
  function quality(compiled, opts) {
    opts = opts || {};
    var m = wire();
    if (!compiled || !compiled.cfg || !compiled.ageRes) {
      return { ok: false, errors: [{ code: 'NO_RESULT',
        message: 'quality() 需要 compute() 的结果（至少要有 cfg 与 ageRes）' }] };
    }
    var cfg = compiled.cfg;
    var ageRes = compiled.ageRes;
    var ageKey = opts.ageKey || m.QC.QC_KEY68;
    var wantCorr = (opts.corrected === undefined) ? true : !!opts.corrected;
    var pick = m.QC.qcDefaultAge(cfg.method, ageKey);
    var useCorr = wantCorr && pick.corrected;

    //  meanRows / num 可能挂在 compute 结果上，也可能挂在它的 out 上
    var src = compiled.out || compiled;
    var qc = m.QC.qcAnalyze({
      header: ageRes.header, rows: ageRes.rows, method: cfg.method,
      ageKey: pick.key, ageCorrected: useCorr,
      stdName: cfg.stdName, stdAge: cfg.stdAge, fracStd: cfg.standard,
      nistStd: cfg.nistStd, algo: cfg.algo, instrument: cfg.inst,
      sampleNames: (compiled.stats && compiled.stats.samples) || compiled.sampleNames || null,
      meanRows: src.meanRows || null,
      num: src.num || null,
      coefficients: ageRes.coefficients || null,
      divZero: (ageRes.warnings && ageRes.warnings.divZero) || 0,
      fileNotes: compiled.fileNotes || null,
      thresholds: opts.thresholds
    });
    var note = null;
    if (wantCorr && !pick.corrected) {
      //  文案与界面日志逐字相同 —— 界面把这个 note 直接印在日志里，
      //  所以这里换一个字，界面上就跟着变（不必两边各写一句）。
      note = '校正方式 ' + cfg.method + ' 下没有「校正后的 ' + pick.key
        + '」这一列，已改用同一比值的未校正年龄，报告里会注明。';
    }
    return { ok: true, ageKey: pick.key, corrected: useCorr, note: note, qc: qc };
  }

  /* ======================================================================
   *  八·之二、过程量（中间环节）
   *
   *  「这个年龄是怎么一步步来的」—— 把一次计算里的窗口、计数、净计数、
   *  比值、年龄并成一张宽表。算式、列定义、口径说明全部在 src/stages.js，
   *  这里只负责把依赖备齐（qc.js 的列映射、report.js 的浮点排版）。
   *
   *  ★ 与 quality() 一样，传进来的可以是 compute() 的返回，也可以是界面上
   *    等价的一组字段 —— 两边走的是同一段代码。
   * ==================================================================== */

  /**
   * @param compiled compute() 的返回（要有 cfg / ageRes，以及 meanRows /
   *                 resultRows / num / idx 这些中间量 —— 它们在 compute()
   *                 返回的顶层就有，also 在 .out 上）
   * @param opts     { keepByFile, csv, generatedAt }
   * @returns {ok, columns, rows, meta, groups, notes, byFile?, csv?}
   */
  function stages(compiled, opts) {
    opts = opts || {};
    var m = wire();
    var S = m.STAGES;
    if (!S || typeof S.buildStages !== 'function') {
      return { ok: false, errors: [{ code: 'NO_STAGES_MODULE',
        message: '这份产物里没有过程量模块（DS_STAGES）' }] };
    }
    if (!compiled || !compiled.cfg || !compiled.ageRes) {
      return { ok: false, errors: [{ code: 'NO_RESULT',
        message: 'stages() 需要 compute() 的结果（至少要有 cfg 与 ageRes）' }] };
    }
    var src = compiled.out || compiled;
    if (!src.meanRows || !src.resultRows) {
      return { ok: false, errors: [{ code: 'NO_STAGES_INPUT',
        message: '缺少中间量（meanRows / resultRows）—— compute() 要用默认参数调用，'
          + '别把 out 摘掉' }] };
    }
    var model = S.buildStages(src, compiled.ageRes, compiled.cfg, {
      QC: m.QC,
      untagInt: m.DS.untagInt,
      buildId: (G.__build && G.__build.id) || '',
      generatedAt: opts.generatedAt || '',
      fileNotes: compiled.fileNotes || null
    });
    var res = {
      ok: true, apiVersion: VERSION,
      columns: model.columns,
      //  表头文字（带单位）也一并给出 —— 界面表格与 CSV 都用这一份，
      //  免得两边各拼一次、哪天改标题就只改了一边。
      headers: model.columns.map(function (c) { return S.colHeader(c); }),
      rows: model.rows,
      meta: model.meta, groups: model.groups, notes: model.notes
    };
    if (opts.keepByFile) res.byFile = model.byFile;
    if (opts.csv) res.csv = S.stagesCsv(model, { fmt: m.RP.pyFloatRepr });
    return res;
  }

  /** 单样品的"流水账"分段（界面点开一行时用）。model 来自 stages()。 */
  function sampleChain(model, file) {
    var S = G.DS_STAGES;
    if (!S || !model) return [];
    return S.sampleChain(model, file);
  }

  /* ======================================================================
   *  九、报告（可选）
   *
   *  HTML 组装本身在 ui/report.js（DS_QCREPORT），这里只负责把参数备齐。
   *  缺少那个模块时明确报错，不返回半份报告。
   * ==================================================================== */

  function reportHtml(R) {
    var QR = G.DS_QCREPORT;
    if (!QR || typeof QR.buildReportHtml !== 'function') {
      throw mkerr('NO_REPORT_MODULE', '这份产物里没有报告模块（DS_QCREPORT）');
    }
    return QR.buildReportHtml(R);
  }

  /* ======================================================================
   *  十、顶层入口
   * ==================================================================== */

  /**
   * 跑一遍并整理成可直接 JSON.stringify 的结果。
   *
   *  @param params  朴素参数（见 schema()），或已归一化的 cfg
   *  @param files   [{file, text}, ...]
   *  @param opts    { quality:true, fullRows:false, ageKey, corrected,
   *                   thresholds, log, sampleNames, probeMap }
   */
  function run(params, files, opts) {
    opts = opts || {};
    var r = compute(params, files, opts);
    if (!r.ok) { delete r.ageRes; return r; }

    //  精简行是默认；要 51 列原始数组得显式全量要
    var rows = toRows(r.ageRes, r.cfg, { fullRows: !!opts.fullRows });

    var out = {
      ok: true,
      apiVersion: VERSION,
      params: echoParams(r.cfg),
      files: r.files,
      stats: r.stats,
      header: r.ageRes.header,
      rows: rows,
      rowCount: rows.length,
      ageWarnings: r.ageRes.warnings || null,
      factors: r.ageRes.factors || null,
      groups: r.ageRes.groups || null,
      coefficients: r.ageRes.coefficients || null,
      warnings: r.warnings,
      logs: r.logs,
      build: G.__build || null
    };

    if (opts.quality !== false) {
      var q = quality(r, opts);
      if (q.ok) {
        out.quality = q.qc;
        out.qualityAgeKey = q.ageKey;
        out.qualityCorrected = q.corrected;
        if (q.note) out.warnings = out.warnings.concat([{ code: 'QC_COLUMN_FALLBACK', text: q.note }]);
      } else {
        out.warnings = out.warnings.concat(q.errors.map(function (e) {
          return { code: e.code, text: e.message };
        }));
      }
    }
    //  过程量（中间环节）不默认附上 —— 它比 rows 还宽。
    //  要就显式 opts.stages = true，或者单独调 stages()。
    if (opts.stages) {
      var st = stages(r, { generatedAt: opts.generatedAt });
      if (st.ok) {
        out.stages = { columns: st.columns, rows: st.rows, meta: st.meta,
          groups: st.groups, notes: st.notes };
      } else {
        out.warnings = out.warnings.concat(st.errors.map(function (e) {
          return { code: e.code, text: e.message };
        }));
      }
    }
    if (opts.keepRaw) out.raw = { ageRows: r.ageRes.rows, out: r.out };
    return out;
  }

  /** cfg → 调用方能看懂的参数回显（不含内部派生量，除了算出来的 cal）。 */
  function echoParams(cfg) {
    return {
      inst: cfg.inst, method: cfg.method, algo: cfg.algo,
      stdName: cfg.stdName, stdAge: cfg.stdAge, fracStd: cfg.standard,
      nistStd: cfg.nistStd, excessPercent: cfg.excessV * 100,
      b0: cfg.b0, b1: cfg.b1, multi: cfg.multi, fix76: cfg.fix76,
      estimateAge: cfg.params.age,
      cal: cfg.cal, pbParams: cfg.params
    };
  }

  /* ======================================================================
   *  十一、自描述
   *
   *  智能体工具整合最需要这一块：不用读源码就知道怎么调、字段叫什么、
   *  错误码有哪些。schema() 给参数模式，tool() 给 function-calling 定义。
   * ==================================================================== */

  function capabilities() {
    var m = pick();
    var missing = REQUIRED.filter(function (k) { return !m[k]; });
    var demo = null;
    try {
      var DD = G.DS_DEMO_REAL;
      if (DD && typeof DD.decode === 'function') {
        demo = { available: true, files: DD.files, encoding: DD.encoding,
          params: DD.params, stdMeasured: DD.stdMeasured, stdRefs: DD.stdRefs,
          sha256: DD.sha256, flaws: DD.flaws };
      } else demo = { available: false };
    } catch (e) { demo = { available: false, error: String(e && e.message || e) }; }

    return {
      name: 'isoclock',
      version: VERSION,
      title: 'Isoclock 网页版 · 程序接口',
      ready: missing.length === 0,
      missingModules: missing.map(function (k) { return MODULE_KEYS[k]; }),
      offline: true,
      writesStorage: false,
      environment: (typeof G.document !== 'undefined') ? 'browser' : 'node',
      modules: Object.keys(MODULE_KEYS).reduce(function (acc, k) {
        acc[MODULE_KEYS[k]] = !!m[k]; return acc;
      }, {}),
      methods: METHODS,
      algorithms: [
        { value: 'avg', label: '平均法（全局一个分馏因子，输出 15 列）' },
        { value: 'linear', label: '线性法（每个标样段一套因子，输出 51 列）' }
      ],
      instruments: [
        { value: 'thermo', label: 'Thermo（iCAP / Qtegra 导出，样品名读文件第一行）' },
        { value: 'agilent', label: 'Agilent（样品名来自外部清单，无清单时用文件名）' }
      ],
      ageColumns: UNCORR_DOC,
      correctedColumns: function (method) { return correctedCols(method === undefined ? 1 : method); },
      qcKeys: m.QC ? m.QC.qcAgeKeys(1) : [],
      //  过程量的分组（列按这个顺序排），给"要中间环节"的调用方看
      stageGroups: m.STAGES ? Object.keys(m.STAGES.GROUPS).map(function (k) {
        return { value: k, label: m.STAGES.GROUPS[k] };
      }) : [],
      units: { age: 'Ma', concentration: 'ppm', excess: '%（1σ 之外额外并进的相对误差）' },
      demo: demo,
      defaults: DEFAULT_PARAMS,
      errorCodes: Object.keys(ERROR_CODES)
    };
  }

  var ERROR_CODES = {
    MODULE_MISSING: '产物里缺少数值模块（文件被改过或来自旧版构建）',
    BAD_PARAMS: '参数对象本身不合法',
    BAD_FILE: '文件项不是 {file, text} 或 text 不是字符串',
    BAD_INSTRUMENT: '仪器只能是 thermo / agilent',
    BAD_METHOD: 'method 只能是 0–4',
    BAD_ALGO: 'algo 只能是 avg / linear',
    BAD_NUMBER: '某个数值参数不是数字',
    NO_FILES: '没有数据文件',
    MISSING_STD_NAME: '没有填标样名（stdName）',
    BAD_STD_AGE: '标样年龄不是数字（stdAge）',
    BAD_EXCESS: '外挂误差不是数字（excess）',
    MISSING_FRAC_STD: '没有填分馏校正标样（fracStd）',
    ALL_FILES_UNPARSED: '所有文件都解析失败',
    STD_NOT_FOUND: '标样名在数据里找不到',
    PIPELINE_ERROR: '读取/还原阶段出错',
    AGE_ERROR: '年龄层计算出错',
    PROBE_ERROR: '轻量解析（探针）出错',
    NO_RESULT: 'quality() 需要先跑 compute()',
    NO_REPORT_MODULE: '这份产物里没有报告模块',
    NO_DEMO: '这份产物里没有内置示例数据'
  };

  /** 参数模式。给智能体生成调用参数用。 */
  function schema() {
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Isoclock 运行参数',
      type: 'object',
      additionalProperties: true,
      properties: {
        inst: { type: 'string', enum: ['thermo', 'agilent'],
          default: DEFAULT_PARAMS.inst,
          description: '仪器品牌。决定读数解析规则与样品名取法。' },
        b0: { type: 'number', default: DEFAULT_PARAMS.b0,
          description: '背景窗口起点（秒）。激光开孔之前的那一段。' },
        b1: { type: 'number', default: DEFAULT_PARAMS.b1,
          description: '背景窗口终点（秒）。' },
        multi: { type: 'number', default: DEFAULT_PARAMS.multi,
          description: '信号阈值倍数：超过背景中位数多少倍算信号。' },
        stdName: { type: 'string', default: DEFAULT_PARAMS.stdName,
          description: '年龄层认的标样名。必须与数据里出现的名字**逐字**相同。' },
        stdAge: { type: 'number', default: DEFAULT_PARAMS.stdAge,
          description: '标样年龄（Ma）。用来算分馏校正要用的常数。' },
        fracStd: { type: 'string', default: DEFAULT_PARAMS.fracStd,
          description: '分馏校正用的标样名。' },
        nistStd: { type: 'string', default: DEFAULT_PARAMS.nistStd,
          description: '微量元素外标名（如 SRM 612）。可省略。' },
        method: { type: 'integer', minimum: 0, maximum: 4, default: DEFAULT_PARAMS.method,
          description: '普通铅校正方式：0 不校正 / 1 207Pb / 2 208Pb / 3 204Pb / 4 Cal 204Pb。' },
        algo: { type: 'string', enum: ['avg', 'linear'], default: DEFAULT_PARAMS.algo,
          description: '年龄层算法。平均法输出 15 列，线性法输出 51 列。' },
        excess: { type: 'number', default: DEFAULT_PARAMS.excess,
          description: '外挂误差 Ɛ，按**百分数**填（3 表示 3%）。只进误差、不进年龄。' },
        estimateAge: { type: 'number', default: EST_AGE_DEFAULT,
          description: '估算的样品年龄（Ma）。只在 method 4 的"按年龄推算"里用到。' },
        fix76: { type: 'boolean', default: DEFAULT_PARAMS.fix76,
          description: '²⁰⁷Pb/²⁰⁶Pb 迭代收敛修正。默认开；关掉即逐位复现桌面版数值。' },
        pbParams: { type: 'object',
          description: '直接给普通铅参数（覆盖按年龄推算）。键名见 capabilities().defaults 之外的 pbParams 文档。' }
      }
    };
  }

  /**
   * function-calling 定义（OpenAI tools / Anthropic tool 都吃这个形状）。
   *
   *  files 的内容不放在参数里 —— 数据可能是几十个几百 KB 的文件，
   *  由调用方（智能体宿主）读进来再传给 run()。这里只描述"要哪些键"。
   */
  function tool() {
    return {
      type: 'function',
      function: {
        name: 'isoclock_run',
        description: '用 Isoclock 对一批 LA-ICP-MS 数据做锆石/锡石 U-Pb 定年：'
          + '自动识别积分窗口、扣背景、分馏校正、普通铅校正，输出逐点年龄表与批次质量统计。'
          + '完全离线，不联网、不上传。files 由宿主读入后传入（每项 {file, text}）。',
        parameters: {
          type: 'object',
          properties: {
            params: schema(),
            files: {
              type: 'array',
              description: '数据文件。每项是 {file: 文件名, text: 文件全文（utf-8 字符串）}。',
              items: {
                type: 'object',
                required: ['file', 'text'],
                properties: {
                  file: { type: 'string', description: '文件名（含扩展名）' },
                  text: { type: 'string', description: '文件全文' }
                }
              }
            },
            options: {
              type: 'object',
              properties: {
                quality: { type: 'boolean', default: true, description: '是否附上批次质量统计' },
                fullRows: { type: 'boolean', default: false, description: '是否附上 51 列原始行' },
                ageKey: { type: 'string', description: '质检用哪一列年龄，默认 206Pb/238U' },
                corrected: { type: 'boolean', default: true, description: '质检是否用校正后年龄' }
              }
            }
          },
          required: ['params', 'files']
        }
      }
    };
  }

  /* ======================================================================
   *  十二、内置示例
   * ==================================================================== */

  /** 取内置的真实示例（49 个文件）。异步 —— 要解 gzip。 */
  function demoFiles() {
    var DD = G.DS_DEMO_REAL;
    if (!DD || typeof DD.decode !== 'function') {
      return Promise.reject(mkerr('NO_DEMO', ERROR_CODES.NO_DEMO));
    }
    return DD.decode();
  }

  /** 一条命令跑通内置示例：取数据 + 用推荐参数 + 返回结果。 */
  function runDemo(opts) {
    opts = opts || {};
    return demoFiles().then(function (files) {
      var DD = G.DS_DEMO_REAL;
      var p = opts.params || (DD && DD.params) || DEFAULT_PARAMS;
      var r = run(p, files, opts);
      r.source = 'demo';
      if (r.ok) r.provenance = { files: files.length,
        note: '内置真实示例（锡石 LA-ICP-MS U-Pb，已脱敏）' };
      return r;
    });
  }

  /* ======================================================================
   *  十三、导出
   * ==================================================================== */

  var API = {
    name: 'isoclock',
    version: VERSION,

    //  —— 主入口 ——
    run: run,
    compute: compute,
    quality: quality,
    stages: stages,
    sampleChain: sampleChain,
    reportHtml: reportHtml,
    probe: probeFiles,

    //  —— 参数 ——
    normalize: normalize,
    validate: validate,
    isCfg: isCfg,
    calAge: calAge,
    PB_SPEC: PB_SPEC,
    METHODS: METHODS,
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    EST_AGE_DEFAULT: EST_AGE_DEFAULT,

    //  —— 数值/常量（供外部脚本直接用，省得再去猜全局名）——
    isonameFor: isonameFor,
    ISO_THERMO: ISO_THERMO,
    ISO_AGILENT: ISO_AGILENT,
    UNCORR_COLS: UNCORR_COLS,
    correctedCols: correctedCols,
    toRows: toRows,

    //  —— 示例 ——
    demoFiles: demoFiles,
    runDemo: runDemo,

    //  —— 自描述 ——
    capabilities: capabilities,
    schema: schema,
    tool: tool,
    errorCodes: ERROR_CODES,

    //  —— 接线（界面与测试共用；幂等）——
    wire: wire
  };

  if (typeof window !== 'undefined') window.DS_API = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (G && typeof G === 'object' && !G.DS_API) G.DS_API = API;

}());
