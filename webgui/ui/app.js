/* ==========================================================================
 *  Isoclock 网页版 —— 界面逻辑
 *
 *  职责边界：这里只做"取输入 / 接管线 / 画结果"，任何数值都不在这里实现。
 *  数值全部来自 src/*.js（与桌面版逐位比对过的那几个模块）。
 *
 *  与桌面版的对应关系：
 *      拖入文件 + 点"开始计算"      <-  选择目录 + Load
 *      "标样名 / 标样年龄"          <-  skmethod() 的两个输入框
 *      "分馏校正标样"               <-  模块全局 standard
 *      "背景窗口 / 信号阈值倍数"    <-  bcg_from / bcg_to / multi
 *      "普通铅校正方式"             <-  PbCorrS 单选 + PbCorrSamples() 的追问
 *      "外挂误差 Ɛ"                 <-  var5（桌面版界面上就写着 Ɛ(%)，默认 3）
 *                                       即源码里的 excess_V = 界面值/100。
 *                                       **只进误差、不进年龄**：以平方和并进各年龄的
 *                                       相对误差。详细口径（2σ 混用、206Pb/207Pb 那列
 *                                       不含 Ɛ、对 MSWD 的反向影响）见 app.html 的说明。
 *      "年龄层算法"                 <-  Age_Calculate_average / Age_Calculate
 * ========================================================================== */
(function () {
  'use strict';

  var DS = window.DS;
  var AGE = window.DS_AGE;
  var PL = window.DS_PIPELINE;
  var RP = window.DS_REPORT;
  var TH = window.DS_THERMO;
  var FP = window.DS_FP;
  var QC = window.DS_QC;
  var QR = window.DS_QCREPORT;

  /* ---------- 模块接线（与 test_e2e.js 完全一致）---------- */
  window.DS_WINDOW.setNumeric(DS);
  PL.attach({
    thermoLoad: TH.thermoLoad,
    agilentLoad: TH.agilentLoad,
    thermoSampleName: TH.thermoSampleName,
    detectSignalWindow: window.DS_WINDOW.detectSignalWindow,
    nmean: DS.nmean,
    untagInt: DS.untagInt,
    reduceSample: DS.reduceSample,
    buildMeanCpsCsv: RP.buildMeanCpsCsv,
    buildResultAllCsv: RP.buildResultAllCsv,
  });
  AGE.attach({
    pwSum: DS.pwSum, nnanmean: DS.nnanmean,
    age76Pb: DS.age76Pb, age76PbFixed: DS.age76PbFixed, sk2model: DS.sk2model,
  });

  var ISONAME = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'];
  // Agilent 的 isoname 来自桌面版 instructure1()：202Hg 按原列名匹配，
  // 其余同位素按"只留数字"匹配（列名 204Pb / 206Pb / … 都能命中）。
  var ISO_AGILENT = ['时间 [s]', '202', '204', '206', '207', '208', '232', '238'];

  /* ======================================================================
   *  小工具
   * ==================================================================== */
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  };

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'on' + (isErr ? ' err' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 3200);
  }

  function logLine(msg, cls) {
    var pre = $('log');
    var span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = msg + '\n';
    pre.appendChild(span);
    pre.scrollTop = pre.scrollHeight;
  }
  function logClear() { $('log').textContent = ''; }

  /** 表格里显示用的数字格式：7 位有效数字，够了；导出时才用完整 repr。 */
  function fmtNum(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return 'NaN';
      if (v === Infinity) return '+Inf';
      if (v === -Infinity) return '-Inf';
      if (v === 0) return '0';
      var a = Math.abs(v);
      if (a >= 1e5 || a < 1e-3) return v.toExponential(4);
      return String(Number(v.toPrecision(7)));
    }
    return String(v);
  }

  function nf(v) {                       // 取输入框里的浮点，失败给默认值
    var x = parseFloat(v);
    return isFinite(x) ? x : NaN;
  }

  /** 把一个结果面板恢复成占位提示。 */
  function resetPane(id) {
    var p = $(id);
    p.textContent = '';
    p.appendChild(el('div', 'empty', '还没有结果。'));
  }

  /* ======================================================================
   *  Cal_age —— 原 main() 里的那个闭式函数（Isoclock2.0.py:3096）
   *
   *  写成字面量逐一对应，不做化简：0.000000000155125 就是 1.55125e-10，
   *  但保持和源码一样的乘序，免得浮点末位出现无谓的差别。
   * ==================================================================== */
  function calAge(age) {
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

  /* ======================================================================
   *  普通铅参数：对应 PbCorrSamples()（Isoclock2.0.py:2809）
   *
   *  注意原实现里 method 2/4 的"按年龄推算"用的是系数 36.630，
   *  而 Cal_age 里 S8 用的是 36.837 —— 两处不一致，这里按 PbCorrSamples 的写法。
   * ==================================================================== */
  //  "按年龄推算"里的 age 是**估算的样品年龄**（界面上那个 100 Ma 的输入框），
  //  不是标样年龄 —— 原实现 PbCorrSamples() 里是自己用 age 重算 exp 的。
  //  所以下面每个 byAge(eg) 收到的 eg 是 calAge(估算年龄)，不是 calAge(标样年龄)。
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
      // fromAge：原实现**从不问用户**，两个分支都用当前全局 age 现算（= P382）。
      // 照抄：界面上这一格恒为灰（不可编辑），值随估算年龄联动。
      // 附注：原实现在"直接输入同位素"分支下用的是**残留的全局 age**，
      //       首次运行就直接 NameError。网页版固定按估算年龄算，去掉这个不确定性。
      { k: 'radioactiveS_Pb207_206', label: '样品放射性 207Pb/206Pb',
        fromAge: true }
    ]
  };

  var EST_AGE_DEFAULT = 100;

  function buildPbParams() {
    var m = parseInt($('p-method').value, 10) || 0;
    var host = $('pbparams');
    host.textContent = '';
    var spec = PB_SPEC[m];
    if (!spec.length) {
      host.appendChild(el('p', 'hint',
        '这一条路径直接使用未校正比值，不需要普通铅参数。'));
      return;
    }
    var head = el('div', 'row');
    var lab = el('label', null, '');
    lab.className = 'grow';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'pb-byage';
    var cbLab = el('label', null, '');
    cbLab.style.fontSize = '12.5px';
    cbLab.appendChild(cb);
    cbLab.appendChild(document.createTextNode(' 按估算年龄推算（原界面的 Y 分支）'));
    head.appendChild(cbLab);
    var ageIn = document.createElement('input');
    ageIn.type = 'number';
    ageIn.id = 'pb-age';
    ageIn.value = EST_AGE_DEFAULT;
    ageIn.step = '0.1';
    ageIn.style.width = '84px';
    head.appendChild(ageIn);
    head.appendChild(el('span', 'unit', 'Ma'));
    host.appendChild(head);

    spec.forEach(function (p) {
      var row = el('div', 'row');
      var l = el('label', 'w', p.label);
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.id = 'pb-' + p.k;
      if (p.fromAge) inp.value = '';
      else inp.value = p.def;
      row.appendChild(l);
      row.appendChild(inp);
      host.appendChild(row);
    });
    host.appendChild(el('p', 'hint',
      '「按估算年龄推算」对应原界面的 Y 分支；取消勾选就按 N 分支直接用上面输入的数值。'));

    function refresh() {
      var byAge = cb.checked;
      ageIn.disabled = false;
      var aa = nf(ageIn.value);
      if (!isFinite(aa)) { toast('估算年龄不是数字', true); return; }
      if (aa <= 0) { toast('估算年龄要大于 0', true); return; }
      var eg = calAge(aa);
      spec.forEach(function (p) {
        var inp = $('pb-' + p.k);
        if (p.fromAge) {
          inp.value = String(eg.P382);
          inp.disabled = true;
          return;
        }
        inp.disabled = byAge;
        if (byAge) inp.value = String(p.byAge(eg));
      });
    }
    cb.addEventListener('change', refresh);
    ageIn.addEventListener('change', refresh);
    refresh();
  }

  /** 从界面读出这一轮的全部参数。 */
  function readConfig() {
    var m = parseInt($('p-method').value, 10) || 0;
    var cfg = {
      method: m,
      inst: $('p-inst').value,
      fix76: $('p-fix76').checked,
      excessV: nf($('p-excess').value) / 100,     // 界面按百分数填，源码里是小数
      nistStd: $('p-nist').value.trim() || null,
      standard: $('p-fracstd').value.trim(),      // 分馏校正用的标样名
      stdName: $('p-stdname').value.trim(),       // 年龄层认的标样名
      stdAge: nf($('p-stdage').value),
      algo: $('p-algo').value,
      b0: nf($('p-b0').value),
      b1: nf($('p-b1').value),
      multi: nf($('p-multi').value)
    };

    //  两套 age 各司其职，别混：
    //     gs —— 用**标样年龄**算，提供 a/b/c/P382/Pbc，也就是分馏校正要用的那套常数；
    //     ge —— 用**估算的样品年龄**算，只给"按估算年龄推算"的普通铅参数用。
    var gs = calAge(cfg.stdAge);
    var estAge = $('pb-age') ? nf($('pb-age').value) : 100;
    if (!isFinite(estAge) || estAge <= 0) estAge = 100;
    var ge = calAge(estAge);
    var byAge = !!( $('pb-byage') && $('pb-byage').checked );

    var params = { age: estAge };
    PB_SPEC[m].forEach(function (p) {
      if (p.fromAge) { params[p.k] = ge.P382; return; }   // 不受勾选影响
      params[p.k] = byAge ? p.byAge(ge) : nf($('pb-' + p.k).value);
    });

    cfg.params = params;
    cfg.cal = gs;
    return cfg;
  }

  /* ======================================================================
   *  文件
   * ==================================================================== */
  var state = { files: [], entries: null, entriesKey: '', result: null,
    ageResult: null, ageInput: null, cfg: null, selected: null,
    demo: false,                 // false | 'real'（内置真实锡石）| 'syn'（合成示例）
                                 // 取值是字符串而不是 true —— 报告里两种数据的
                                 // 免责声明**意思完全相反**，分不清就会把真实结果
                                 // 说成"不是真实样品"。
    sampleNames: null,           // 样品名清单：{文件名键: 样品名}
    sampleListName: null,        // 清单的来源文件名，仅用于显示
    probeKey: '', probeMap: null };   // 文件/仪器 → 轻量解析结果的缓存

  function readFileText(file, cb) {
    var r = new FileReader();
    r.onload = function () { cb(r.result); };
    r.onerror = function () { cb(null); };
    r.readAsText(file, 'utf-8');
  }

  function addFiles(list) {
    var arr = Array.prototype.slice.call(list);
    if (!arr.length) return;
    state.demo = false;                       // 拖入真实文件后退出示例模式
    var pending = arr.length;
    var dup = 0;
    arr.forEach(function (f) {
      readFileText(f, function (txt) {
        if (txt === null) { toast('读不了：' + f.name, true); }
        else if (state.files.some(function (g) { return g.file === f.name; })) {
          // 同名文件必须挡住：结果表是按文件名索引的（perFile[name]），
          // 两条同名会让后一条静默覆盖前一条，而列表里看着像两条。
          dup++;
        } else {
          state.files.push({ file: f.name, text: txt });
        }
        if (--pending === 0) {
          dropProbeCache();
          state.entries = null;
          refreshFileList();
          if (dup) toast('已跳过 ' + dup + ' 个重名文件', true);
        }
      });
    });
  }

  /** 当前选的仪器。 */
  function currentInst() {
    var s = $('p-inst');
    return (s && s.value === 'agilent') ? 'agilent' : 'thermo';
  }
  function isonameFor(inst) { return inst === 'agilent' ? ISO_AGILENT : ISONAME; }

  /**
   * 轻量解析：只为列表显示文件名/样品名/点数。
   *
   * **必须按当前仪器选读取器** —— Agilent 的表头里没有 `Time` 列，
   * 拿 Thermo 的列名去读会整批抛错，于是标样筛选为空、整条链走不下去。
   *
   * 结果按「仪器 + 文件集合」缓存：列表刷新、标样名候选、运行前的标样核对
   * 都要问同一批文件，不缓存的话 100 个文件会被反复解析好几遍。
   */
  function probeAll() {
    var inst = currentInst();
    var key = inst + '\u0000'
      + state.files.map(function (f) { return f.file; }).join('\u0000');
    if (state.probeMap && state.probeKey === key) return state.probeMap;
    var map = {};
    state.files.forEach(function (f) { map[f.file] = probeOne(f, inst); });
    state.probeKey = key;
    state.probeMap = map;
    return map;
  }

  function probeOne(f, inst) {
    try {
      var ch = (inst === 'agilent' ? TH.agilentLoad : TH.thermoLoad)(f.text, isonameFor(inst));
      var sn = PL.sampleNameFor(f.file, f.text, state.sampleNames, inst);
      return { ok: true, n: ch.x.length, sample: sn.name, sampleFrom: sn.from,
        notes: ch.notes || [], err: null };
    } catch (e) {
      return { ok: false, err: String(e && e.message || e) };
    }
  }

  function probe(f) { return probeAll()[f.file]; }
  function dropProbeCache() { state.probeKey = ''; state.probeMap = null; }

  function refreshFileList() {
    var host = $('filelist');
    host.textContent = '';
    if (!state.files.length) {
      host.appendChild(el('div', 'hint', '还没有数据。'));
      $('btn-run').disabled = true;
      updateStdNames();
      return;
    }
    var pm = probeAll();
    var t = el('table');
    var hr = el('tr');
    ['文件', '样品名', '点数', '窗口'].forEach(function (h) {
      hr.appendChild(el('th', null, h));
    });
    t.appendChild(hr);
    var failed = 0;
    var fromHead = 0;      // 名字取自文件第一行（Thermo 的规则）
    var fromFile = 0;      // 名字取自文件名（Agilent 没清单时的兜底）
    var compat = 0;        // 走了 Thermo 兼容读取（表头行/列名不是标准写法）
    state.files.forEach(function (f) {
      var pr = pm[f.file];
      var tr = el('tr', 'pick' + (state.selected === f.file ? ' sel' : ''));
      tr.setAttribute('data-file', f.file);
      tr.appendChild(el('td', null, f.file));
      tr.appendChild(el('td', null, pr.ok ? pr.sample : '—'));
      tr.appendChild(el('td', 'n', pr.ok ? String(pr.n) : '—'));
      //  "窗口"这一列顺带当状态列用：解析失败 / 兼容读取 / 正常
      var stCell = el('td', 'n');
      if (!pr.ok) stCell.textContent = '解析失败';
      else if (pr.notes && pr.notes.length) {
        stCell.appendChild(el('span', 'tagwarn', '兼容'));
      }
      tr.appendChild(stCell);
      //  悬停提示：失败原因、样品名的来源、读取时的提示，都堆在这里
      var tips = [];
      if (!pr.ok) {
        failed++;
        tips.push(pr.err);
      } else if (pr.sampleFrom === 'head' || pr.sampleFrom === 'file') {
        if (pr.sampleFrom === 'head') { fromHead++; } else { fromFile++; }
        tips.push((pr.sampleFrom === 'head'
          ? '样品名取自文件第一行'
          : '样品名取自文件名（第一个点之前）')
          + (state.sampleNames
            ? '（清单里没有键 "' + PL.listKey(f.file) + '"）' : ''));
      }
      if (pr.ok && pr.notes && pr.notes.length) {
        compat++;
        for (var ni = 0; ni < pr.notes.length; ni++) tips.push(pr.notes[ni]);
      }
      tr.title = tips.join('\n');
      tr.addEventListener('click', function () { pickFile(f.file); });
      t.appendChild(tr);
    });
    host.appendChild(t);
    // 摘要放在列表下方，不进日志 —— 这个函数会被反复调用，写日志会刷屏
    if (failed) {
      host.appendChild(el('div', 'hint', failed + ' 个文件解析失败 —— 鼠标悬在行上可看原因，'
        + '并检查③里的仪器选择是否与数据匹配。'));
    }
    if (compat) {
      host.appendChild(el('div', 'hint', compat + ' 个文件是「兼容读取」来的 —— '
        + '表头行位置或列名写法与标准 Thermo 导出不同（悬停可看具体差异）。'
        + '数值与标准写法一致，但值得核对一下这批文件的导出设置。'));
    }
    var fb = [];
    if (fromHead) { fb.push(fromHead + ' 个文件退回读第一行'); }
    if (fromFile) { fb.push(fromFile + ' 个文件退回用文件名'); }
    //  Thermo 在没有清单时"读第一行"本来就是正路，不是退化 —— 那时不提示，
    //  免得看起来像出了错。只有给了清单却没匹配上、或 Agilent 缺清单才值得说。
    if (fb.length && (state.sampleNames || currentInst() === 'agilent')) {
      host.appendChild(el('div', 'hint', fb.join('，')
        + (state.sampleNames
          ? ' —— 这些文件在清单里没找到对应的键（悬停可看该用什么键）。'
          : ' —— 没有提供清单。')));
    }
    $('btn-run').disabled = false;
    updateStdNames();
  }

  /** 选中某个文件：只换选中样式，不重建整张列表（文件多时不会闪）。 */
  function pickFile(file) {
    state.selected = file;
    var rows = document.querySelectorAll('#filelist tr.pick');
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].getAttribute('data-file') === file;
      rows[i].className = 'pick' + (on ? ' sel' : '');
    }
    showPlot(file);
    selectTab('plot');
  }

  function updateStdNames() {
    var dl = $('stdname-list');
    dl.textContent = '';
    var pm = probeAll();
    var seen = {};
    state.files.forEach(function (f) {
      var pr = pm[f.file];
      if (pr.ok && !seen[pr.sample]) {
        seen[pr.sample] = 1;
        var o = document.createElement('option');
        o.value = pr.sample;
        dl.appendChild(o);
      }
    });
    // 常见标样名优先猜一个
    var names = Object.keys(seen);
    if (names.length) {
      var guess = names.filter(function (n) { return /91500|MAD|NIST|AY-4|wc-1|Temora|Ple/i.test(n); });
      var pick = guess.length ? guess[0] : names[0];
      if (!$('p-stdname').value.trim()) $('p-stdname').value = pick;
      if (!$('p-fracstd').value.trim()) $('p-fracstd').value = pick;
    }
    updateListInfo();
  }

  /** 刷新"样品名清单"那行的状态说明。 */
  function updateListInfo() {
    var host = $('listinfo');
    if (!host) return;
    if (state.sampleNames) {
      host.textContent = '已载入「' + (state.sampleListName || '清单') + '」（'
        + Object.keys(state.sampleNames).length + ' 条）。清单里有键的按清单取名，'
        + '其余退回' + (currentInst() === 'agilent' ? '取文件名' : '读第一行') + '。';
    } else if (currentInst() === 'agilent') {
      host.textContent = '未提供清单 —— Agilent 的原实现要求这份清单；现在样品名退化为'
        + '取文件名（第一个点之前），请核对上面文件列表里的样品名对不对。';
    } else {
      host.textContent = '未提供 —— 样品名按各文件的第一行取（Thermo 原实现本就如此）。';
    }
  }

  /** 按当前参数把文件读成条目（供画图/结果用），带缓存。 */
  function ensureEntries() {
    var cfg = readConfig();
    // 缓存键必须含**仪器**：切到 Agilent 时同一批文件的解析结果完全不同，
    // 键里不带仪器就会拿着上一台仪器的结果继续用。
    var key = [cfg.inst, cfg.b0, cfg.b1, cfg.multi, state.files.length,
      state.files.map(function (f) { return f.file; }).join('|')].join(',');
    if (state.entries && state.entriesKey === key) return state.entries;
    var loaded = PL.loadThermoFiles(state.files, {
      isoname: isonameFor(cfg.inst),
      b0: cfg.b0, b1: cfg.b1, multi: cfg.multi,
      instrument: cfg.inst,
      sampleNames: state.sampleNames
    });
    state.entries = loaded;
    state.entriesKey = key;
    return loaded;
  }

  /* ======================================================================
   *  运行
   * ==================================================================== */
  function run() {
    logClear();
    var cfg = readConfig();
    var bad = [];
    if (!state.files.length) bad.push('没有数据文件');
    if (!cfg.stdName) bad.push('没有填标样名');
    if (!isFinite(cfg.stdAge)) bad.push('标样年龄不是数字');
    if (!(cfg.excessV >= 0)) bad.push('外挂误差不是数字');
    if (!cfg.standard) bad.push('没有填分馏校正标样');
    if (bad.length) { toast(bad[0], true); logLine('!! ' + bad.join('；'), 'e'); return; }

    var pm = probeAll();
    var badFiles = state.files.filter(function (f) { return !pm[f.file].ok; });
    if (badFiles.length) {
      logLine('!! ' + badFiles.length + ' 个文件没能解析：' + badFiles.slice(0, 5).map(function (f) {
        return f.file;
      }).join('、') + (badFiles.length > 5 ? ' 等' : ''), 'e');
      logLine('   原因（第一个）：' + pm[badFiles[0].file].err, 'e');
      if (badFiles.length === state.files.length) {
        toast('所有文件都解析失败，见日志', true);
        return;
      }
    }
    if (cfg.inst === 'agilent' && !state.sampleNames) {
      var stemCount = state.files.filter(function (f) {
        return pm[f.file].ok && pm[f.file].sampleFrom === 'file';
      }).length;
      logLine('  提示：Agilent 的样品名在桌面版来自那份 Excel 清单，本次没提供清单，'
        + stemCount + ' 个文件的样品名是取文件名（第一个点之前）得到的 —— 请核对列表里的样品名。', 'w');
    }

    var stdFiles = state.files.filter(function (f) { return probe(f).sample === cfg.stdName; });
    logLine('标样「' + cfg.stdName + '」在数据里出现 ' + stdFiles.length + ' 个文件');
    if (!stdFiles.length) {
      logLine('!! 没有任何文件属于这个标样名 —— 分馏因子会取到空集合。', 'e');
      if (cfg.algo === 'avg') { toast('标样名在数据里找不到', true); return; }
    }
    if (cfg.nistStd) {
      var nistFiles = state.files.filter(function (f) { return probe(f).sample === cfg.nistStd; });
      if (nistFiles.length < 2) {
        logLine('!! 微量元素外标「' + cfg.nistStd + '」只出现 ' + nistFiles.length
          + ' 次。原实现在这种情况下会把系数静默置 0（网页版照抄了这个行为）。', 'w');
      }
    }

    logLine('开始：' + state.files.length + ' 个文件，仪器 '
      + (cfg.inst === 'agilent' ? 'Agilent' : 'Thermo')
      + '，Pb 校正方式 ' + cfg.method
      + '，年龄层用' + (cfg.algo === 'avg' ? '平均法' : '线性法')
      + '，²⁰⁷Pb/²⁰⁶Pb 迭代' + (cfg.fix76 ? '已修正' : '按桌面版原样'));
    var t0 = (window.performance || Date).now();

    var stdSet = {};
    stdSet[cfg.stdName] = cfg.stdAge;
    var pipeCfg = {
      files: state.files,
      isoname: isonameFor(cfg.inst),
      b0: cfg.b0, b1: cfg.b1, multi: cfg.multi,
      stdcor: 0, method: cfg.method, standardNames: stdSet,
      ctx: cfg.cal, eleIndex: 2, instrument: cfg.inst,
      sampleNames: state.sampleNames
    };

    var out;
    try {
      out = PL.run(pipeCfg);
    } catch (e) {
      logLine('!! 读取/还原阶段出错：' + (e && e.stack || e), 'e');
      toast('计算失败，见日志', true);
      return;
    }
    logLine('  还原阶段完成：' + out.resultRows.length + ' 行，'
      + out.meanRows.length + ' 行计数');

    var input = AGE.buildInput(out.resultAllCsv, out.meanCpsCsv, null);
    input.fix76 = cfg.fix76;
    input.cfg = {
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

    var ageRes;
    try {
      ageRes = (cfg.algo === 'avg') ? AGE.averageAge(input) : AGE.linearAge(input);
    } catch (e) {
      logLine('!! 年龄层出错：' + (e && e.stack || e), 'e');
      toast('年龄层计算失败，见日志', true);
      return;
    }
    var dt = (window.performance || Date).now() - t0;

    state.cfg = cfg;
    state.result = out;
    state.ageResult = ageRes;
    state.ageInput = input;

    logLine('  年龄层完成：' + ageRes.rows.length + ' 行 × 51 列', 'g');
    if (ageRes.warnings && ageRes.warnings.divZero) {
      logLine('  ' + ageRes.warnings.divZero + ' 行因分母为零无法完成普通铅校正'
        + '（204 通道过弱或普通铅参数退化），相关列已置为 NaN。', 'w');
    }
    //  两种算法的诊断信息不一样：平均法只有一个全局分馏因子；
    //  线性法是每个标样段各自一套 A/B 因子，报"段数"更实在。
    if (ageRes.factors) {
      logLine('  分馏因子：207/206 f=' + ageRes.factors.f207_206.toPrecision(6)
        + '  206/238 f=' + ageRes.factors.f206_238.toPrecision(6)
        + '  207/235 f=' + ageRes.factors.f207_235.toPrecision(6)
        + '  208/232 f=' + ageRes.factors.f208_232.toPrecision(6));
    } else if (ageRes.groups) {
      logLine('  标样段 ' + ageRes.groups.std.length + ' 组，非标样段 '
        + ageRes.groups.sample.length + ' 组（相邻标样插值）');
    }
    if (ageRes.coefficients) {
      var co = ageRes.coefficients;
      var zero = co.every(function (v) { return v === 0; });
      logLine('  微量元素系数：U238=' + fmtNum(co[0]) + '  Th232=' + fmtNum(co[1])
        + '  Pb=' + fmtNum(co[2]));
      if (zero && cfg.nistStd) {
        logLine('  ! 系数全是 0 —— 外标「' + cfg.nistStd + '」在这批数据里出现 '
          + '0 次或 1 次时原实现就会这样（异常被吞掉），属已知行为。', 'w');
      }
    }
    //  哪里才算"校正后年龄"，交给 qc.js 的列映射去说 —— 别在这里硬编码列号。
    //  ⚠ 第 25 列（1 起算）在数据里装的是**备注文字**，不是表头写的校正年龄：
    //     age.js 的 row 在 concat 那两段之前放的就是 comments。之前这里判 r[25]，
    //     备注一非空（比如 'CMT-1'）就会 !isFinite 成立，虚报一堆"校正后年龄是 NaN"。
    var corrCols = [];
    if (cfg.method > 0) {
      var cc = QC.QC_CORR_COL[cfg.method];
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
      logLine('  ' + nanRows + '/' + ageRes.rows.length + ' 行的年龄是 NaN 或 Inf。', 'w');
      logLine('  最常见的三个原因：① 积分窗口没取对 —— 背景窗落在信号里，'
        + '净信号就成了 0，比值自然算不出来，先看"信号图"页的蓝、绿两条底色；'
        + '② 某个通道计数全为 0（204Pb 路径尤其容易除零）；'
        + '③ 该行的标样名对不上，分馏因子取到了空集合。', 'w');
    }
    if (nanCorr) {
      logLine('  另外 ' + nanCorr + ' 行的校正后年龄全是 NaN（第 27 / 29 列）—— '
        + '这些行的普通铅校正没有完成，上面未校正年龄可能仍是好的。', 'w');
    }
    logLine('  用时 ' + dt.toFixed(0) + ' ms', 'g');

    renderMeanCps(out);
    renderResultAll(out);
    renderAge(ageRes);
    ['btn-exp-all', 'btn-exp-cps', 'btn-exp-age', 'btn-exp-json', 'btn-report'].forEach(function (id) {
      $(id).disabled = false;
    });
    if (state.selected) showPlot(state.selected);
    selectTab('age');
    //  这一遍的年龄表变了 → IsoplotR 那一页的样品清单与可用点数跟着重算。
    //  放在最后：它只读 state.ageResult，不参与计算链。
    refreshIsoControls();
    toast('算完了：' + ageRes.rows.length + ' 行年龄');
  }

  /* ======================================================================
   *  结果表
   * ==================================================================== */
  function parseCsvRows(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.length; });
    var head = lines[0].split(',');
    var rows = lines.slice(1).map(function (l) { return l.split(','); });
    return { head: head, rows: rows };
  }

  function renderCsvTable(paneId, text, stringCols) {
    var t = parseCsvRows(text);
    var pane = $(paneId);
    pane.textContent = '';
    var wrap = el('div', 'tablewrap');
    var table = el('table', 'data');
    var hr = el('tr');
    t.head.forEach(function (h, i) {
      var th = el('th', stringCols.indexOf(i) >= 0 ? 's' : '', h);
      hr.appendChild(th);
    });
    table.appendChild(hr);
    var tb = el('tbody');
    t.rows.forEach(function (r) {
      var tr = el('tr');
      r.forEach(function (v, i) {
        var isStr = stringCols.indexOf(i) >= 0;
        var f = isStr ? v : Number(v);
        var td = el('td', isStr ? 's' : '', isStr ? v : fmtNum(f));
        if (!isStr && !isFinite(f)) td.className = 'na';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    pane.appendChild(wrap);
  }

  function renderMeanCps(out) {
    renderCsvTable('pane-cps', out.meanCpsCsv, [0, 1]);
  }
  function renderResultAll(out) {
    renderCsvTable('pane-all', out.resultAllCsv, [0, 1, 2, 17]);
  }

  function renderAge(ageRes) {
    var pane = $('pane-age');
    pane.textContent = '';
    // 显示的表头跟随"修正列名笔误"勾选 —— 否则会出现"屏幕上还是笔误、
    // 导出的却已经改过"的不一致，看表格的人和用表格的人对不上。
    var fixNames = !!($('p-fixnames') && $('p-fixnames').checked);
    var h = displayHeader(ageRes.header, fixNames);
    var wrap = el('div', 'tablewrap');
    var table = el('table', 'data');
    var hr = el('tr');
    var th0 = el('th', '', '#');
    hr.appendChild(th0);
    h.forEach(function (name) {
      hr.appendChild(el('th', '', name || ''));
    });
    table.appendChild(hr);
    var tb = el('tbody');
    ageRes.rows.forEach(function (row, ri) {
      var tr = el('tr');
      tr.appendChild(el('td', 'n', String(ri + 1)));
      row.forEach(function (v) {
        var td;
        if (typeof v === 'string') {
          var cls = (v === 'NaN' || v === '') ? 'na' : (/^-+$/.test(v) ? 'sep' : 's');
          td = el('td', cls, v);
        } else if (!isFinite(v)) {
          td = el('td', 'na', Number.isNaN(v) ? 'NaN' : String(v));
        } else {
          td = el('td', '', fmtNum(v));
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    pane.appendChild(wrap);

    // 说明：列号一律按 1 起算。这里要把两处**表头与内容不一致**（沿用自原程序）讲明白，
    // 否则有人按表头文字去取数就会取错：
    //   · 第 17 列表头写着 Age，数据其实是分隔线 '-------'；
    //   · 第 26 列表头写着 '…Corr. Age(Ma)'，数据其实是**备注文字**。
    //     校正后的年龄在第 27 / 29 列。qc.js 的列映射按实际位置走，不认表头文字。
    var typos = typoColumns(ageRes.header);
    var note = '共 ' + ageRes.rows.length + ' 行 × 51 列。'
      + '第 18-25 列是四条未校正年龄及其 2s —— 依次是 ²⁰⁶Pb/²³⁸U（第 18 列）、'
      + '²⁰⁷Pb/²³⁵U（第 20 列）、²⁰⁸Pb/²³²Th（第 22 列）、²⁰⁷Pb/²⁰⁶Pb（第 24 列），'
      + '每一列后面紧跟着它的 2s。';
    if (ageRes.header[25]) {
      note += ' 第 27-30 列是所选校正路径的两个年龄及其 2s。'
        + '⚠ 第 26 列表头写作 ' + ageRes.header[25] + '，但那一列实际装的是'
        + '备注文字；第 17 列同理（表头 Age，数据是分隔线）。这两列的表头与内容不一致，'
        + '沿用未改，取数请按实际列位置。';
    } else {
      note += ' 方式 0（不校正）下第 26-30 列为空。';
    }
    note += ' 第 51 列是微量元素含量（U / Th / Pb，ppm）。';
    if (typos.length) {
      note += ' 表头里的 ' + typos.join('、') + ' 沿用原程序的写法，'
        + (fixNames
          ? '已按勾选换成规范写法（只动表头文字，数值不变）。'
          : '默认照抄保留，可在右上角勾选"修正列名笔误"换掉。');
    }
    pane.appendChild(el('p', 'colgroup-note', note));
  }

  /* ======================================================================
   *  信号图（自绘 canvas，不引图表库）
   * ==================================================================== */
  var CH_COLORS = ['#8b5cf6', '#0ea5e9', '#dc2626', '#f59e0b', '#16a34a',
    '#7c3aed', '#0f766e'];
  var CH_LABELS = ['202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'];
  var CH_KEYS = ['y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7'];

  function showPlot(file) {
    var entries;
    try { entries = ensureEntries(); } catch (e) {
      logLine('!! 画图时出错：' + (e && e.message || e), 'e');
      return;
    }
    var e = entries.perFile[file];
    if (!e) return;                       // 该文件在别的仪器下解析失败过，别硬画
    $('plot-empty').style.display = 'none';
    var cv = $('plot');
    cv.style.display = 'block';
    drawPlot(cv, e, file);
  }

  /** 刻度/标签上的秒数：整数不带小数点，否则最多两位。 */
  function sec(v) {
    if (!isFinite(v)) return String(v);
    return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(2);
  }

  function drawPlot(cv, e, file) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = 900, cssH = 460;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px';
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cssW, cssH);

    // 上边留三行：标题 / 窗口标签 / 图例，再往下才是绘图区。
    var L = 64, R = 14, T = 62, B = 42;
    var x = e.ch.x, n = x.length;
    var x0 = x[0], x1 = x[n - 1];
    var series = CH_KEYS.map(function (k, j) {
      return { name: CH_LABELS[j], color: CH_COLORS[j], v: e.ch[k] };
    });

    // 对数纵轴范围
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) {
      for (var i = 0; i < n; i++) {
        var v = s.v[i];
        if (v > 0) { if (Math.log10(v) < lo) lo = Math.log10(v); }
      }
    });
    series.forEach(function (s) {
      for (var i = 0; i < n; i++) {
        var v = s.v[i];
        if (v > 0 && Math.log10(v) > hi) hi = Math.log10(v);
      }
    });
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 3; }
    lo = Math.floor(lo - 0.3); hi = Math.ceil(hi + 0.3);
    if (hi - lo < 2) hi = lo + 2;

    var px = function (t) { return L + (t - x0) / (x1 - x0 || 1) * (cssW - L - R); };
    var py = function (v) {
      var l = v > 0 ? Math.log10(v) : lo;
      return T + (hi - l) / (hi - lo) * (cssH - T - B);
    };

    // 窗口底色（用真正参与计算的那个窗口）
    var used = e.num;
    var post = state.result && state.result.num[file];
    var win = post && (post[3] !== used[3] || post[4] !== used[4]) ? post : used;
    var adjusted = win !== used;
    var bandLabels = [];
    function band(a, b, fill, label, color) {
      g.fillStyle = fill;
      var xa = px(a), xb = px(b);
      g.fillRect(xa, T, Math.max(xb - xa, 0.5), cssH - T - B);
      bandLabels.push({ x: (xa + xb) / 2, text: label, color: color });
    }
    band(win[1], win[2], 'rgba(31,111,235,.10)',
      '背景 ' + sec(win[1]) + '~' + sec(win[2]) + ' s', '#1f6feb');
    band(win[3], win[4], 'rgba(22,163,74,.12)',
      '信号 ' + sec(win[3]) + '~' + sec(win[4]) + ' s', '#16a34a');

    // 网格
    g.strokeStyle = '#eef2f5';
    g.lineWidth = 1;
    g.font = '11px ui-monospace, Consolas, monospace';
    g.textAlign = 'right';
    g.fillStyle = '#7b8b9a';
    for (var d = lo; d <= hi; d++) {
      var y = py(Math.pow(10, d));
      g.beginPath(); g.moveTo(L, y); g.lineTo(cssW - R, y); g.stroke();
      g.fillText('1e' + d, L - 6, y + 3.5);
    }
    // 时间刻度
    g.textAlign = 'center';
    for (var k = 0; k <= 6; k++) {
      var t = x0 + (x1 - x0) * k / 6;
      var xx = px(t);
      g.strokeStyle = '#eef2f5';
      g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, cssH - B); g.stroke();
      g.fillStyle = '#7b8b9a';
      g.fillText(sec(t), xx, cssH - B + 15);
    }
    g.fillStyle = '#4a5a6a';
    g.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.fillText('时间 (s)', (L + cssW - R) / 2, cssH - 8);
    g.save();
    g.translate(14, (T + cssH - B) / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillText('计数率 cps（对数轴）', 0, 0);
    g.restore();

    // 曲线
    g.lineWidth = 1.2;
    series.forEach(function (s) {
      g.strokeStyle = s.color;
      g.beginPath();
      var started = false;
      for (var i = 0; i < n; i++) {
        var v = s.v[i];
        if (!(v > 0)) { started = false; continue; }
        var X = px(x[i]), Y = py(v);
        if (!started) { g.moveTo(X, Y); started = true; } else g.lineTo(X, Y);
      }
      g.stroke();
    });

    // 图例（第二行），紧贴绘图区上沿
    var lx = L + 4, ly = T - 4;
    g.font = '11px ui-monospace, Consolas, monospace';
    g.textAlign = 'left';
    series.forEach(function (s, j) {
      var bx = lx + (j % 4) * 104;
      var by = ly + Math.floor(j / 4) * 13;
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillRect(bx - 2, by - 9, 100, 12);
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(bx, by - 3.5); g.lineTo(bx + 16, by - 3.5); g.stroke();
      g.fillStyle = '#4a5a6a';
      g.fillText(s.name, bx + 20, by);
    });

    // 窗口标签（第一行，压在标题下面；越界就夹回画布内，免得被切掉）
    g.font = '11px ui-monospace, Consolas, monospace';
    g.textAlign = 'center';
    bandLabels.forEach(function (bl) {
      var w = g.measureText(bl.text).width;
      var cx = Math.min(Math.max(bl.x, L + w / 2), cssW - R - w / 2);
      g.fillStyle = bl.color;
      g.fillText(bl.text, cx, 34);
    });

    // 标题（最上面一行）。示例数据时加显著标记，避免被误当成真实样品。
    g.fillStyle = '#1d2733';
    g.font = '12.5px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.textAlign = 'left';
    g.fillText((state.demo === 'real' ? '【内置真实数据（已脱敏）】'
      : state.demo === 'syn' ? '【示例合成数据，非真实样品】' : '')
      + file + '  样品「' + e.sample + '」  ' + n + ' 点  驻留 '
      + e.timeinternal.toFixed(4) + ' s' + (adjusted ? '   （窗口已含 dataprocess 的修正）' : ''),
      L, 16);
  }

  /* ======================================================================
   *  导出
   * ==================================================================== */
  function download(name, text, mime) {
    // 桌面版壳（packaging/isoclock_desktop.py）里走**系统原生"另存为"**。
    // 不用 blob + <a download>：WebView2 给 blob 下载的默认文件名是一串 GUID、
    // 没有扩展名，用户拿到 `a1b2c3d4` 这种文件还得自己改名。原生对话框带正确
    // 文件名与扩展名。浏览器里没有这个桥，所以行为与原来完全一致。
    var api = window.pywebview && window.pywebview.api;
    if (api && typeof api.save_as === 'function') {
      api.save_as(name, text);
      return;
    }
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /** 年龄表按 Python 的 repr 排版导出，保证数值可无损往返。 */
  //  沿用原程序的列名写法。默认原样导出（与桌面版逐字节一致）；
  //  勾选"修正列名笔误"后替换成正确写法，方便按列名取数的下游脚本。
  //
  //  **`isotop` 那一处不止一种形态**：第 51 列（1 起算）会随校正方式变成
  //  `207 Corrected isotop` / `208 Corrected isotop` / `204 Corrected isotop` /
  //  `Cal 204Pb Corrected isotop`，四种都少了结尾的 s，所以按词尾统一替换。
  var HEADER_TYPOS = [
    [/^232Pb_232Th$/, '208Pb_232Th'],
    [/(isotop)$/, 'isotopes'],
  ];

  /** 显示/导出用的表头。fixNames 为假时原样返回（与桌面版一致）。 */
  function displayHeader(header, fixNames) {
    if (!fixNames) return header.slice();
    return header.map(function (h) {
      var out = h;
      for (var i = 0; i < HEADER_TYPOS.length; i++) {
        out = out.replace(HEADER_TYPOS[i][0], HEADER_TYPOS[i][1]);
      }
      return out;
    });
  }

  /** 找出表头里沿用原程序写法的列，返回「第 N 列 xxx」这样的说明。 */
  function typoColumns(header) {
    var out = [];
    header.forEach(function (name, i) {
      if (!name) return;
      for (var k = 0; k < HEADER_TYPOS.length; k++) {
        if (HEADER_TYPOS[k][0].test(name)) { out.push('第 ' + (i + 1) + ' 列 ' + name); break; }
      }
    });
    return out;
  }

  function ageCsv() {
    var r = state.ageResult;
    var fixNames = !!($('p-fixnames') && $('p-fixnames').checked);
    var header = displayHeader(r.header, fixNames);
    var out = header.map(function (h) { return csvField(h); }).join(',') + '\r\n';
    r.rows.forEach(function (row) {
      out += row.map(function (v) {
        if (typeof v === 'string') return csvField(v);
        if (typeof v === 'number' && Number.isFinite(v)) return RP.pyFloatRepr(v);
        return String(v);
      }).join(',') + '\r\n';
    });
    return out;
  }
  function csvField(s) {
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportJson() {
    var r = state.ageResult, o = state.result, c = state.cfg;
    var fixNames = !!($('p-fixnames') && $('p-fixnames').checked);
    var doc = {
      generatedBy: 'Isoclock 网页版',
      build: window.__build || null,
      params: {
        standard: c.stdName, standardAge: c.stdAge,
        fractionationStandard: c.standard,
        method: c.method, excessV: c.excessV,
        nistStd: c.nistStd, algo: c.algo,
        instrument: c.inst, fix76: c.fix76,
        headerTyposFixed: fixNames,
        sampleList: state.sampleListName || null,
        b0: c.b0, b1: c.b1, multi: c.multi,
        cal: c.cal, pbParams: c.params
      },
      files: state.files.map(function (f) { return f.file; }),
      sampleNames: o.sampleslist,
      num: o.num,
      ageHeader: displayHeader(r.header, fixNames),
      ageRows: r.rows.map(function (row) {
        return row.map(function (v) { return typeof v === 'number' && !Number.isFinite(v) ? String(v) : v; });
      })
    };
    download('isoclock_result.json', JSON.stringify(doc, null, 1), 'application/json');
  }

  /* ======================================================================
   *  质量报告
   *
   *  这一块与别的导出不同：它不只是把已有结果搬一遍，而是**新做了统计** ——
   *  按样品归组的加权平均、MSWD、标样偏差、异常清单。这些**不是**桌面版
   *  Isoclock 的输出（原程序只输出逐点年龄，从不做归组统计），所以报告里
   *  每一处都标明了。公式与判据的定义在 src/qc.js。
   *
   *  产物是一份**单文件 HTML**：样式与图全部内联，双击可开、可打印成 PDF、
   *  可以直接发给别人 —— 对方不需要装这个软件、也不需要联网。
   * ==================================================================== */

  var METHOD_TEXT = {
    0: '0 · 不校正（用未校正比值）',
    1: '1 · 207Pb 校正',
    2: '2 · 208Pb 校正',
    3: '3 · 204Pb 校正',
    4: '4 · Cal 204Pb 校正'
  };

  function pad2(v) { return (v < 10 ? '0' : '') + v; }

  /** 本地时间的 'YYYY-MM-DD HH:MM:SS'（报告里要写明生成时刻）。 */
  function nowText() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** ⑥ 里的判据阈值。填得不合法就退回默认值 —— 出报告不该被一个空输入框挡住。 */
  function readThresholds() {
    var d = QC.QC_DEFAULT_THRESHOLDS;
    function g(id, def) {
      var host = $(id);
      if (!host) return def;
      var v = nf(host.value);
      return isFinite(v) ? v : def;
    }
    return {
      stdDevPct: g('q-stddev', d.stdDevPct),
      mswdMax: g('q-mswd', d.mswdMax),
      rel2sMax: g('q-rel2s', d.rel2sMax),
      outlierZ: g('q-outz', d.outlierZ)
    };
  }

  /** 把 qc.js 里那份阈值说明渲染到⑥下面 —— 界面、报告、代码说的是同一份。 */
  function renderQcDoc() {
    var host = $('qcdoc');
    if (!host) return;
    host.textContent = '';
    QC.QC_THRESHOLD_DOC.forEach(function (d) {
      host.appendChild(el('p', 'hint', d.label + '（默认 '
        + String(d.def) + (d.unit || '') + '）：' + d.what + '　' + d.why));
    });
  }

  /** 组装并下载质量报告。 */
  function doReport() {
    if (!state.ageResult || !state.result) {
      toast('先点一次"开始计算"，再出报告', true);
      return;
    }
    var c = state.cfg, r = state.ageResult, o = state.result;

    //  统计用哪一列年龄：界面选的种类 + 是否要校正后的。
    //  该种类没有校正列时（method 0，或 207Pb/206Pb 这种原实现从不校正的），
    //  自动退到未校正列，并在日志与报告里都说一句 —— 不静默换列。
    var ageKey = ($('p-agekey') && $('p-agekey').value) || QC.QC_KEY68;
    var wantCorr = !($('p-agecorr') && !$('p-agecorr').checked);
    var pick = QC.qcDefaultAge(c.method, ageKey);
    var useCorr = wantCorr && pick.corrected;
    if (wantCorr && !pick.corrected) {
      logLine('  报告：校正方式 ' + c.method + ' 下没有「校正后的 ' + pick.key
        + '」这一列，已改用同一比值的未校正年龄，报告里会注明。', 'w');
    }

    //  读取阶段的提示（兼容读取、缺列补零……）要带进报告
    var fileNotes = {};
    state.files.forEach(function (f) {
      var pr = probe(f);
      if (pr.ok && pr.notes && pr.notes.length) fileNotes[f.file] = pr.notes.slice();
    });

    var qc;
    try {
      qc = QC.qcAnalyze({
        header: r.header, rows: r.rows, method: c.method,
        ageKey: pick.key, ageCorrected: useCorr,
        stdName: c.stdName, stdAge: c.stdAge, fracStd: c.standard,
        nistStd: c.nistStd, algo: c.algo, instrument: c.inst,
        sampleNames: o.sampleslist,
        meanRows: o.meanRows, num: o.num,
        coefficients: r.coefficients,
        divZero: (r.warnings && r.warnings.divZero) || 0,
        fileNotes: fileNotes,
        thresholds: readThresholds()
      });
    } catch (e) {
      logLine('!! 报告统计出错：' + (e && e.stack || e), 'e');
      toast('出报告失败，见日志', true);
      return;
    }

    //  普通铅参数的实况：报告要说清"这次到底代入了哪些数"
    var pbText = '未使用';
    if (c.method > 0) {
      var pp = [];
      PB_SPEC[c.method].forEach(function (p) {
        pp.push(p.label + ' = ' + fmtNum(c.params[p.k]));
      });
      pp.push('估算样品年龄 = ' + fmtNum(c.params.age) + ' Ma');
      pbText = pp.join('；');
    }

    var sampleFromText = (c.inst === 'agilent')
      ? '取文件名第一个点之前那段 → 去样品名清单里查'
      : '取每个文件第一行冒号之前那段（Thermo 的规则）';
    if (state.sampleListName) sampleFromText += '；本次提供了清单「' + state.sampleListName + '」';

    var html = QR.buildReportHtml({
      title: 'Isoclock 批次质量报告 — ' + (c.stdName || '未填标样名'),
      generatedAt: nowText(),
      build: window.__build || null,
      files: state.files.length,
      fileList: state.files.map(function (f) { return f.file; }),
      sampleList: state.sampleListName || null,
      params: {
        instrument: c.inst === 'agilent' ? 'Agilent' : 'Thermo',
        standard: c.stdName,
        standardAge: fmtNum(c.stdAge) + ' Ma',
        fractionationStandard: c.standard,
        method: METHOD_TEXT[c.method],
        excessV: fmtNum(c.excessV * 100) + ' %',
        b0: fmtNum(c.b0) + ' s',
        b1: fmtNum(c.b1) + ' s',
        multi: fmtNum(c.multi),
        algo: c.algo === 'avg'
          ? '平均法（整批共用一个分馏因子）'
          : '线性法（相邻标样插值 SSB）',
        nistStd: c.nistStd || '',
        fix76: c.fix76 ? '已修正（按收敛判据正常迭代）' : '按桌面版原样（固定迭代 10 次）',
        ageKey: pick.key + (useCorr ? '（校正后）' : '（未校正）'),
        lambda: 'λ₂₃₈ = 1.55125e-10 /yr，λ₂₃₅ = 9.8485e-10 /yr，'
          + 'λ₂₃₂ = 4.9475e-11 /yr，²³⁸U/²³⁵U = 137.818',
        sampleFrom: sampleFromText,
        pbParams: pbText
      },
      qc: qc,
      demo: state.demo || false,
      fix76Text: c.fix76
        ? '本次用了收敛修正版，按收敛判据正常迭代 —— 与桌面版默认行为不同。'
        : '本次「按桌面版原样」执行：原实现的收敛判据因一处赋值缺失而失效，'
          + '实际固定迭代 10 次，1.5–2.2 Ga 区间年龄偏高最多约 35 Ma，'
          + '个别点甚至返回 0 岁。要与已发表结果核对时，这一版才是一致的。'
    });

    download('isoclock_质量报告.html', html, 'text/html;charset=utf-8');
    logLine('质量报告已导出：样品 ' + qc.summary.nSamples + ' 个，标样 '
      + qc.summary.nStd + ' 个，有效点 ' + qc.summary.nUsed + '/' + qc.summary.nRows
      + '，异常 ' + qc.summary.nBadAnomalies + ' 条 / 警告 '
      + qc.summary.nWarnAnomalies + ' 条。', 'g');
    if (qc.summary.level !== 'ok') {
      logLine('  报告判定：' + (qc.summary.level === 'bad' ? '不合格' : '要注意')
        + ' —— 打开报告看第 5 节"异常与警告"。', 'w');
    }
    toast('质量报告已导出');
  }

  /* ======================================================================
   *  IsoplotR 谐和图（可选模块）
   *
   *  这是整个页面里**唯一**需要联网的部分，所以接线的原则与别处相反：
   *    · 页面加载时只往三个下拉框里填文案，一个字节都不下载；
   *    · 只有点了"加载 IsoplotR 并作图"才去 CDN 取运行时；
   *    · 取回来的图以 data URI 塞进 <img>，不走内联 —— IsoplotR 的 SVG 用
   *      <symbol id="glyph0-1"> 定义字形，两张图内联进同一份文档必然撞 id；
   *    · 任何失败都把原文摊在面板上（R 的报错、网络错、CDN 改版都算），不吞。
   *
   *  为什么要有这一页：report.js 里原本写着"不做谐和图，那是另一个工具的事"，
   *  而 docs 里又说谐和图"这套软件最后要交代的就是这张图"。自己重写一遍
   *  Ludwig(1998) 的 discordia 不现实，接 IsoplotR 进来才诚实。
   * ==================================================================== */
  var ISO = window.DS_ISOPLOTR;

  function isoMsg(text, cls) {
    var el = $('iso-msg');
    if (!el) return;
    el.innerHTML = text;
    el.className = 'iso-msg' + (cls ? ' ' + cls : '');
  }

  /**
   * 往一个 <select> 里填选项（value 用字符串，读的时候再转数字）。
   *
   * 列表项有两种形态：
   *   · { v, label, note }                       —— 普通选项
   *   · { group: '标样（QC 用）', items: [...] } —— 生成一个 <optgroup>
   * 加分组是因为**样品和标样必须分开**（见 isoplotr.js 文件头 ⑬）：这批数据里
   * 标样 AY-4 有 15 个文件、样品每个只有 1 个，只按点数排序会把 AY-4 顶到第一位。
   * 用文字后缀标注不够 —— 下拉里第一眼看到的就是标题，分组才拦得住。
   */
  function isoFill(sel, list, keep) {
    if (!sel) return;
    var want = (keep === undefined) ? sel.value : String(keep);
    function addOption(host, o) {
      var op = document.createElement('option');
      op.value = String(o.v);
      op.textContent = o.label;
      if (o.note) op.title = o.note;
      host.appendChild(op);
    }
    sel.innerHTML = '';
    list.forEach(function (o) {
      if (o && o.group) {
        var g = document.createElement('optgroup');
        g.label = o.group;
        (o.items || []).forEach(function (it) { addOption(g, it); });
        sel.appendChild(g);
      } else {
        addOption(sel, o);
      }
    });
    var hit = -1;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === want) { hit = i; break; }
    }
    sel.selectedIndex = hit >= 0 ? hit : 0;
  }

  /**
   * 当前选中项能进表几个点（决定"拟合"里哪些选项可用）。
   *
   * 合并选（'*'）时**不含标样** —— 必须与 buildTable 的 drop 口径一致，
   * 否则下拉里写"41 个可用点"、真正送进 R 的只有 29 个（踩过：两处各算一遍；这两个数是当时的现场值，现在的对应值一律由本函数现场算，别抄）。
   */
  function isoUsableCount(groups, sample, std) {
    if (!groups || !groups.length) return 0;
    var isStd = function (nm) { return !!std && std.indexOf(nm) >= 0; };
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].name === sample) return groups[i].usable;
    }
    //  '全部'：把所有**样品**分组的可用点加起来（标样不算）
    var n = 0;
    for (var j = 0; j < groups.length; j++) {
      if (!isStd(groups[j].name)) n += groups[j].usable;
    }
    return n;
  }

  /**
   * 把当前结果的状态同步到这一页的控件上。
   * 每次切到这个标签页、以及每次算完一遍之后都会调一次。
   */
  function refreshIsoControls() {
    if (!ISO || !$('iso-type')) return;
    if (!$('iso-type').options.length) {
      isoFill($('iso-type'), ISO.TYPES, 1);
      isoFill($('iso-age'), ISO.AGES, 1);
      isoFill($('iso-cpb'), ISO.CPB, 0);
    }
    var ar = state.ageResult;
    var btn = $('btn-iso-run');
    if (!ar || !ar.rows || !ar.rows.length) {
      $('iso-sample').innerHTML = '<option value="*">（还没有结果）</option>';
      btn.disabled = true;
      return;
    }

    /*  样品与标样分组（isoplotr.js 文件头 ⑬）。顺序有意义：
     *  默认选中的是第一个选项「全部样品（不含标样）」—— 谐和图上该看的是样品，
     *  而标样只该拿来对 QC 真值。 */
    var groups = ISO.sampleNames(ar.rows);
    var std = ISO.standardNames(state.cfg);
    var smp = [], stg = [];
    groups.forEach(function (g) { (std.indexOf(g.name) >= 0 ? stg : smp).push(g); });
    var byUsable = function (a, b) {
      return (b.usable - a.usable) || (a.name < b.name ? -1 : 1);
    };
    smp.sort(byUsable);
    stg.sort(byUsable);

    var nSmp = smp.reduce(function (a, g) { return a + g.usable; }, 0);
    var opts = [{
      v: '*',
      //  没配标样（认不出标样名）时就不写"不含标样" —— 那会是一句假话。
      label: '全部样品（' + (std.length ? '不含标样，' : '') + nSmp + ' 个可用点）',
      note: '把这一批的样品测点合在一张谐和图上 —— 谐和线/不一致线该看的就是这个样本。'
        + (std.length ? '标样（' + std.join('、') + '）不在里面：它是 QC 样。' : '')
    }];
    smp.forEach(function (g) {
      opts.push({
        v: g.name,
        label: g.name + '（' + g.usable + ' / ' + g.rows + ' 点可用）',
        note: g.rows === 1
          ? '这个样品只有 1 个测点：图上就是一个带误差椭圆的点，拟合年龄没有意义'
            + '（IsoplotR 会直接报 Cannot fit a straight line）。要出年龄请选'
            + '「全部样品」。'
          : ''
      });
    });
    if (stg.length) {
      opts.push({
        group: '标样（QC 用，不是样品年龄）',
        items: stg.map(function (g) {
          var note = '标样是用来检验这一批的再现性与分馏校正的：它的年龄要与②里'
            + '填的真值比，不是待测样品的年龄。画它是为了看它落不落在谐和线上。';
          if (state.cfg && String(state.cfg.stdName).trim() === g.name
              && isFinite(Number(state.cfg.stdAge))) {
            note += '本批填的真值 = ' + state.cfg.stdAge + ' Ma。';
          }
          return {
            v: g.name,
            label: g.name + '（标样 · ' + g.usable + ' / ' + g.rows + ' 点可用）',
            note: note
          };
        })
      });
    }
    var keep = $('iso-sample').value || '*';
    isoFill($('iso-sample'), opts, keep);
    btn.disabled = false;
    refreshIsoAgeOptions();
  }

  /**
   * discordia（show.age ≥ 2）在点数太少时会**必然失败**（IsoplotR 的原话：
   * "Cannot fit a straight line through these data"）。与其让用户点了再吃一个
   * 报错，不如在这里就把选项禁掉并把原因写在旁边 —— 但也只是"禁掉默认路径"，
   * 数据本身我们不替用户删。实测失败的三种情形见 isoplotr.js 的文件头 ⑥。
   */
  function refreshIsoAgeOptions() {
    var ar = state.ageResult;
    if (!ar || !$('iso-age')) return;
    var groups = ISO.sampleNames(ar.rows);
    var n = isoUsableCount(groups, $('iso-sample').value, ISO.standardNames(state.cfg));
    var sel = $('iso-age');
    var notes = [];
    for (var i = 0; i < sel.options.length; i++) {
      var v = Number(sel.options[i].value);
      var dis = (v >= 2 && n < 3);
      sel.options[i].disabled = dis;
      if (dis) notes.push('「' + sel.options[i].textContent + '」');
    }
    if (n < 3 && Number(sel.value) >= 2) sel.value = '1';
    if (notes.length) {
      sel.title = '当前只有 ' + n + ' 个可用点，' + notes.join('、')
        + ' 需要至少 3 个点才能拟合一条线（IsoplotR 会直接报错）。';
    } else {
      sel.title = '';
    }
  }

  /** 取控件的字符串值 / 勾选状态。控件不存在时也不炸（避免旧产物 + 新界面源码）。 */
  function isoVal(id) { var e = $(id); return e ? String(e.value).trim() : ''; }
  function isoChk(id) { var e = $(id); return !!(e && e.checked); }
  /** 两个输入框 → "min,max"；只要有一格没填就返回空串 —— 空串的含义是"这一项不传"。 */
  function isoPair(a, b) {
    var x = isoVal(a), y = isoVal(b);
    return (x !== '' && y !== '') ? (x + ',' + y) : '';
  }

  /**
   * 「更多选项」里的联动显隐。规则照抄原版 GUI：只在用得上的时候才显示那一格，
   * 看不到的控件不会被读进参数（isoOpts 里 anchor 还额外要求 show.age≥2，
   * 见 isoplotr.js 的 rArgs —— 两处口径一致）。
   */
  function isoSyncMore() {
    var on = function (id, yes) {
      var e = $(id);
      if (e) e.className = 'fld' + (yes ? '' : ' off');
    };
    var anchor = Number(isoVal('iso-anchor') || 0);
    var showAge = Number(isoVal('iso-age') || 0);
    on('iso-anchor-age-wrap', anchor === 2 && showAge >= 2);
    var disc = Number(isoVal('iso-disc') || 0);
    on('iso-disc-opt-wrap', disc > 0);
    on('iso-disc-cut-wrap', disc > 0);
    on('iso-fill-wrap', isoChk('iso-fill-on'));
    on('iso-stroke-wrap', isoChk('iso-stroke-on'));
    //  上下限的 placeholder 跟着判据走 —— "留空用默认"要让人看见默认是多少。
    var dd = (ISO && ISO.DISC_DEFAULT && ISO.DISC_DEFAULT[Number(isoVal('iso-disc-opt') || 1)]) || [];
    var mn = $('iso-disc-min'), mx = $('iso-disc-max');
    if (mn) mn.placeholder = dd.length ? String(dd[0]) : '默认';
    if (mx) mx.placeholder = dd.length ? String(dd[1]) : '默认';
  }

  /** 把 <select> 的当前值读成参数。`drop` 只在"全部样品"时生效（见 buildTable）。 */
  function isoOpts() {
    return {
      type: Number($('iso-type').value),
      showAge: Number($('iso-age').value),
      commonPb: Number($('iso-cpb').value),
      sample: $('iso-sample').value,
      drop: ISO.standardNames(state.cfg),

      //  —— 以下对应「更多选项」面板，参数名逐项照抄 IsoplotR 原版 ——
      //  一律"留空/不勾 = 空串或 false = 不传这个参数"，让 IsoplotR 用自己的默认值。
      anchor: Number(isoVal('iso-anchor') || 0),
      anchorAge: isoVal('iso-anchor-age'),
      discFilter: Number(isoVal('iso-disc') || 0),
      discOpt: Number(isoVal('iso-disc-opt') || 1),
      discCutoff: isoPair('iso-disc-min', 'iso-disc-max'),
      tlim: isoPair('iso-tlim-min', 'iso-tlim-max'),
      xlim: isoPair('iso-xlim-min', 'iso-xlim-max'),
      ylim: isoPair('iso-ylim-min', 'iso-ylim-max'),
      ticks: isoVal('iso-ticks'),
      sigdig: isoVal('iso-sigdig'),
      exterr: isoChk('iso-exterr'),
      shownumbers: isoChk('iso-shownumbers'),
      //  颜色框永远有值，所以各自挂一个"改不改"的勾选框：不勾就不传。
      fill: isoChk('iso-fill-on') ? isoVal('iso-fill') : '',
      fillAlpha: isoChk('iso-fill-on') ? isoVal('iso-fill-alpha') : '',
      stroke: isoChk('iso-stroke-on') ? isoVal('iso-stroke') : ''
    };
  }

  /**
   * 本软件自己的加权平均（与质量报告同一套算法 —— QC.qcWavg）。
   * 用来与 IsoplotR 的谐和年龄做**独立交叉验证**：两条路径的实现完全不同
   * （一个是我们自己的加权平均 + MSWD，一个是 IsoplotR 的最大似然谐和拟合），
   * 对得上才说明接进来的不是个摆设。
   */
  function isoOwnMean(sampleName) {
    try {
      if (!sampleName || sampleName === '*' || !state.ageResult || !state.cfg) return null;
      var pick = QC.qcDefaultAge(state.cfg.method, '206Pb/238U');
      var col = QC.qcAgeCol(state.cfg.method, pick.key, pick.corrected);
      if (typeof col !== 'number' || col < 0) return null;
      var groups = QC.qcGroupBySample(state.ageResult.rows);
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].name !== sampleName) continue;
        var w = QC.qcWavg(groups[i].rows.map(function (r) {
          return { age: +r[col], s2: +r[col + QC.QC_ERR_OFFSET] };
        }));
        if (!w || !isFinite(w.mean)) return null;
        return { mean: w.mean, se: w.se, mswd: w.mswd, n: w.n, key: pick.key,
                 corrected: pick.corrected };
      }
      return null;
    } catch (e) { return null; }
  }

  function isoRender() {
    var ar = state.ageResult;
    if (!ISO || !ar) return;
    var o = isoOpts();
    var tab = ISO.buildTable(ar.rows, { sample: o.sample, drop: o.drop });

    if (tab.n < 1) {
      isoMsg('选中的样品里没有能进表的点（三比值或 rho 缺）。', 'warn');
      return;
    }
    var std = ISO.standardNames(state.cfg);
    var isStd = std.indexOf(o.sample) >= 0;
    var notes = [];
    if (tab.skipped) notes.push(tab.skipped + ' 行因比值/误差缺失被剔除');
    if (tab.badRho) {
      notes.push(tab.badRho + ' 行因 <b>ρ 写成 10 位有效数字后正好是 ±1</b> 被剔除'
        + '（ρ=1 的协方差矩阵是退化的，IsoplotR 会直接报 L-BFGS-B 失败；'
        + '这不是数据坏了，是原实现的 ρ 夹逼饱和到 1）'
        + (tab.rhoFiles && tab.rhoFiles.length
          ? '：' + tab.rhoFiles.join('、') : ''));
    }
    if (tab.dropped) {
      notes.push('另有 ' + tab.dropped + ' 行是<b>标样</b>（' + std.join('、')
        + '），不参与样品统计 —— 想画标样请在下面那个分组里单独选它');
    }
    if (tab.others) notes.push('另有 ' + tab.others + ' 行不属于所选样品');
    if (isStd) {
      notes.push('你选的是<b>标样 ' + o.sample + '</b>：标样的年龄是拿来对②里'
        + '填的真值、检验这一批分馏校正与再现性的，<b>不是样品年龄</b>。'
        + '要看样品年龄请选「全部样品」或某个样品。');
    }
    var head = '正在处理 <b>' + tab.n + '</b> 个点'
      + (o.sample === '*' ? '（全部样品，不含标样）'
        : '（' + o.sample + (isStd ? '，标样' : '') + '）')
      + (notes.length ? '；' + notes.join('，') : '') + '。';

    var svgText = null;
    var btn = $('btn-iso-run');
    btn.disabled = true;
    $('btn-iso-svg').disabled = true;
    isoMsg(head + '<br>正在加载…');

    //  选项**整份透传**，不再一项一项列。列一份就一定会漏一项，而漏掉的那项
    //  照样能出图（只是悄悄用了默认值），最难发现 —— 所以清单只有
    //  ISO.RARG_KEYS 那一份（见 isoplotr.js）。
    var ropts = {};
    (ISO.RARG_KEYS || []).forEach(function (k) { ropts[k] = o[k]; });
    ISO.render(tab, ropts, function (s) {
      isoMsg(head + '<br>' + s);
    }).then(function (out) {
      svgText = out.svg;
      $('iso-fig').src = ISO.svgDataUri(svgText);
      $('iso-fig').style.display = '';
      $('btn-iso-svg').disabled = false;

      //  汇总表
      var html = '<tbody>';
      out.summary.rows.forEach(function (r) {
        html += '<tr><td>' + r.k + '</td><td class="v">' + r.v + '</td><td class="note">'
          + (r.note || '') + '</td></tr>';
      });
      html += '</tbody>';
      $('iso-sum').innerHTML = html;
      $('iso-sum').style.display = '';

      //  独立交叉验证：只在"单样品 + 谐和年龄 + 那个样品本软件也有加权平均"时给
      var cross = '';
      var own = (!out.result.error && o.showAge === 1) ? isoOwnMean(o.sample) : null;
      if (own && isFinite(out.result.age.t)) {
        var diff = out.result.age.t - own.mean;
        cross = '交叉验证：同一组数据，<b>本软件的加权平均</b>（' + own.key
          + (own.corrected ? '，校正后' : '') + '，' + own.n + ' 点，MSWD '
          + ISO.fnum(own.mswd, 2) + '）给出 <b>' + ISO.fnum(own.mean, 2) + ' ± '
          + ISO.fnum(own.se * 2, 2) + ' Ma（2σ）</b>，<b>IsoplotR 的谐和年龄</b>给出 <b>'
          + ISO.fnum(out.result.age.t, 2) + ' ± ' + ISO.fnum(out.result.age['s[t]'] * 2, 2)
          + ' Ma（2σ）</b> —— 两条实现完全不同的路径相差 <b>'
          + ISO.fnum(Math.abs(diff), 2) + ' Ma</b>。';
      }

      //  标样：把拟合结果与②里填的真值并排摆出来 —— 这才是标样图上该看的那个比较
      var stdCmp = '';
      var ageNow = out.result.age && out.result.age.t;
      if (isStd && !out.result.error && isFinite(ageNow)
          && state.cfg && isFinite(Number(state.cfg.stdAge))
          && String(state.cfg.stdName).trim() === o.sample) {
        var truth = Number(state.cfg.stdAge);
        stdCmp = '<p>标样对照：IsoplotR 的谐和年龄 <b>' + ISO.fnum(ageNow, 2)
          + ' Ma</b>，你在②里填的标样真值 <b>' + ISO.fnum(truth, 2) + ' Ma</b>，'
          + '相差 <b>' + ISO.fnum(Math.abs(ageNow - truth), 2) + ' Ma</b>。'
          + '标样对得上，说明这一批的分馏校正没问题；差得多，先回去查②里的'
          + '参数与数据，而不是去改样品年龄。</p>';
      }

      //  说明（口径、失败原因、地质含义）+ 这一次真正传进 R 的参数。
      //  参数必须原样留痕：结果要能复现，光有那张图是不够的。
      var argTxt = (out.args && out.args.length)
        ? '<p class="iso-args">本次传给 IsoplotR 的参数：<code>'
          + out.args.join(', ') + '</code></p>'
        : '';
      var nl = out.summary.notes.map(function (s) { return '<li>' + s + '</li>'; }).join('');
      $('iso-notes').innerHTML = argTxt + (stdCmp ? stdCmp : '')
        + (cross ? '<p>' + cross + '</p>' : '')
        + (nl ? '<ul>' + nl + '</ul>' : '');

      var cls = out.result.error ? 'err' : '';
      isoMsg(head + '<br>图已出（' + out.seconds.toFixed(1) + ' s，'
        + Math.round(svgText.length / 1024) + ' KB）。'
        + (out.result.error ? ' <b>但拟合失败了，已退回只画点 —— 见下方说明。</b>' : ''), cls);
      logLine('IsoplotR：' + tab.n + ' 点（'
        + (o.sample === '*' ? '全部样品，不含标样' : o.sample) + '），'
        + (out.args && out.args.length ? out.args.join(', ') : '') + '，'
        + out.seconds.toFixed(1) + ' s'
        + (out.result.error ? '（拟合失败：' + out.result.error + '）' : ''), out.result.error ? 'w' : 'g');
    }).catch(function (e) {
      var m = String(e && e.message || e);
      isoMsg(head + '<br><b>失败：</b>' + m + '<br>'
        + '常见原因：没联网、公司网络拦了 webr.r-wasm.org、浏览器太旧（不支持 WebAssembly）。'
        + '其余功能不受影响 —— 这一页本来就是可选的。', 'err');
      logLine('!! IsoplotR 失败：' + m
        + (e && e.stack ? '\n' + e.stack : ''), 'e');
    }).then(function () {
      btn.disabled = false;
      refreshIsoAgeOptions();
    });
  }

  function initIsoTab() {
    if (!ISO) {
      isoMsg('这一页需要 <code>ui/isoplotr.js</code>，但产物里没有它 —— '
        + '请重新运行 <code>python webgui/build_ui.py</code>。', 'err');
      return;
    }
    isoFill($('iso-type'), ISO.TYPES, 1);
    isoFill($('iso-age'), ISO.AGES, 1);
    isoFill($('iso-cpb'), ISO.CPB, 0);
    //  「更多选项」面板：三组候选值都由 isoplotr.js 提供，界面不另抄一份。
    isoFill($('iso-anchor'), ISO.ANCHORS, 0);
    isoFill($('iso-disc'), ISO.DISCFILTERS, 0);
    isoFill($('iso-disc-opt'), ISO.DISCOPT, 1);
    ['iso-age', 'iso-anchor', 'iso-disc', 'iso-disc-opt',
     'iso-fill-on', 'iso-stroke-on'].forEach(function (id) {
      var e = $(id);
      if (e) e.addEventListener('change', isoSyncMore);
    });
    isoSyncMore();
    $('btn-iso-run').addEventListener('click', isoRender);
    $('btn-iso-svg').addEventListener('click', function () {
      var img = $('iso-fig');
      if (!img || !img.src) return;
      var svg = decodeURIComponent(img.src.slice(img.src.indexOf(',') + 1));
      download('isoplotr_谐和图.svg', svg, 'image/svg+xml;charset=utf-8');
    });
    $('iso-sample').addEventListener('change', refreshIsoAgeOptions);
    refreshIsoControls();
  }

  /* ======================================================================
   *  标签页
   * ==================================================================== */
  function selectTab(name) {
    var btns = document.querySelectorAll('.tabs button[data-tab]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = btns[i].getAttribute('data-tab') === name ? 'on' : '';
    }
    ['plot', 'cps', 'all', 'age', 'iso', 'log'].forEach(function (k) {
      $('pane-' + k).className = 'pane' + (k === name ? ' on' : '')
        + (k === 'plot' ? ' center' : '');
    });
    if (name === 'plot' && state.selected) showPlot(state.selected);
    if (name === 'iso') refreshIsoControls();   // 样品下拉要跟着当前结果走
  }

  /* ======================================================================
   *  事件
   * ==================================================================== */
  function wire() {
    var drop = $('drop');
    $('drop').addEventListener('click', function () { $('files').click(); });
    $('files').addEventListener('change', function (ev) {
      addFiles(ev.target.files);
      ev.target.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (ev) {
        ev.preventDefault(); drop.className = 'hot';
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (ev) {
        ev.preventDefault(); drop.className = '';
      });
    });
    drop.addEventListener('drop', function (ev) {
      if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });

    $('btn-clear').addEventListener('click', function () {
      var hadList = !!state.sampleNames;
      state.files = []; state.entries = null; state.selected = null;
      state.result = null; state.ageResult = null; state.ageInput = null;
      state.demo = false;
      state.sampleNames = null; state.sampleListName = null;
      dropProbeCache();
      ['cps', 'all', 'age'].forEach(function (k) { resetPane('pane-' + k); });
      ['btn-exp-all', 'btn-exp-cps', 'btn-exp-age', 'btn-exp-json', 'btn-report'].forEach(function (id) {
        $(id).disabled = true;
      });
      refreshFileList();
      $('plot').style.display = 'none';
      $('plot-empty').style.display = '';
      toast(hadList ? '已清空（含样品名清单）' : '已清空');
    });

    $('btn-run').addEventListener('click', function () {
      try { run(); } catch (e) {
        logLine('!! 未知错误：' + (e && e.stack || e), 'e');
        toast('出错了，见日志', true);
      }
    });

    var tm = null;
    $('p-method').addEventListener('change', function () {
      buildPbParams();
      state.entries = null;
    });
    ['p-b0', 'p-b1', 'p-multi', 'p-stdname', 'p-stdage', 'p-fracstd', 'p-algo', 'p-nist',
      'p-excess'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        state.entries = null;
        if (tm) clearTimeout(tm);
        tm = setTimeout(function () {
          if (state.selected) showPlot(state.selected);
        }, 120);
      });
    });
    $('p-stdname').addEventListener('change', function () {
      $('p-fracstd').value = $('p-stdname').value;
    });

    //  换仪器：列名规则、解析结果、样品名全都不一样，探针缓存与条目缓存都要作废，
    //  文件列表也得重画（同一批文件在另一台仪器下可能直接解析失败）。
    $('p-inst').addEventListener('change', function () {
      dropProbeCache();
      state.entries = null;
      if (!state.selected && state.files.length) state.selected = state.files[0].file;
      refreshFileList();
      if (state.selected) showPlot(state.selected);
    });

    //  修正列名笔误只动表头文字，但屏幕上的表头得跟着变，
    //  否则会出现"看着是笔误、导出的已改过"这种对不上的情况。
    $('p-fixnames').addEventListener('change', function () {
      if (state.ageResult) renderAge(state.ageResult);
    });

    //  样品名清单 —— 对应原桌面版 Agilent 流程里要求先选的那份 Excel LIST
    $('btn-list').addEventListener('click', function () { $('listfile').click(); });
    $('listfile').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        state.sampleNames = PL.parseSampleList(r.result);
        state.sampleListName = f.name;
        var n = Object.keys(state.sampleNames).length;
        dropProbeCache();              // 样品名变了：探针缓存与条目缓存一起作废
        state.entries = null;
        refreshFileList();
        if (state.selected) showPlot(state.selected);
        logLine('已载入样品名清单「' + f.name + '」，' + n + ' 条。');
        if (!n) {
          logLine('!! 清单里一条都没解析出来 —— 检查是不是两列，且第一列是文件名。', 'w');
        }
        toast('清单已载入：' + n + ' 条');
      };
      r.onerror = function () { toast('清单读不了：' + f.name, true); };
      r.readAsText(f, 'utf-8');
    });

    var tabs = document.querySelectorAll('.tabs button[data-tab]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (ev) {
        selectTab(ev.currentTarget.getAttribute('data-tab'));
      });
    }

    $('btn-exp-all').addEventListener('click', function () {
      download('result_all.csv', state.result.resultAllCsv, 'text/csv;charset=utf-8');
    });
    $('btn-exp-cps').addEventListener('click', function () {
      download('Mean_Cps.csv', state.result.meanCpsCsv, 'text/csv;charset=utf-8');
    });
    $('btn-exp-age').addEventListener('click', function () {
      download('age_result.csv', ageCsv(), 'text/csv;charset=utf-8');
    });
    $('btn-exp-json').addEventListener('click', exportJson);
    $('btn-report').addEventListener('click', doReport);

    $('btn-help').addEventListener('click', function () { $('modal').className = 'on'; });
    $('btn-close-modal').addEventListener('click', function () { $('modal').className = ''; });
    $('modal').addEventListener('click', function (ev) {
      if (ev.target === $('modal')) $('modal').className = '';
    });

    /* ------------------------------------------------------------------
     *  示例数据：两个入口
     *
     *  「真实锡石」那批是真实的 iCAP Qtegra 导出，gzip+base64 内嵌在
     *  这个单文件里，点一下才解压 —— 所以是异步的。
     *  它带的 DS_DEMO_REAL.params 是**推荐参数**、stdMeasured 是**这套参数跑出来的
     *  标样结果**，两样都由生成脚本用真管线在这批数据上量出来（AY-4 出
     *  157.06 ± 1.39 Ma（2σ），与文献两个 ID-TIMS 值都对得上）。
     *  界面不要再抄一份 —— 抄的那份迟早与数据脱节。口径尤其要跟着走：
     *  质量报告里印的是 **1σ 内部标准误**（0.70），正文引的是 **2σ**（1.39），
     *  同一个数在两处看着像对不上，所以 stdMeasured 连 sigma 一起记下来。
     * ---------------------------------------------------------------- */
    function applyParams(P) {
      $('p-b0').value = String(P.b0);
      $('p-b1').value = String(P.b1);
      $('p-multi').value = String(P.multi);
      $('p-stdname').value = P.stdName;
      $('p-stdage').value = String(P.stdAge);
      $('p-fracstd').value = P.fracStd;
      $('p-nist').value = P.nistStd;
      $('p-method').value = String(P.method);
      $('p-algo').value = P.algo;
      $('p-excess').value = String(P.excess);
      $('p-inst').value = P.inst;
    }

    function loadFiles(fs, kind) {
      state.files = fs;
      state.entries = null;
      state.selected = fs[0].file;
      state.demo = kind;
      dropProbeCache();
      buildPbParams();          // 必须在 $('p-method').value 改完之后调用
      refreshFileList();
      state.entries = null;
    }

    $('btn-demo').addEventListener('click', function () {
      var D = window.DS_DEMO_REAL;
      if (!D || typeof D.decode !== 'function') {
        toast('这份文件里没有内置真实示例数据', true);
        logLine('!! 找不到 window.DS_DEMO_REAL —— 产物可能被手工改过，或来自旧版构建。', 'e');
        return;
      }
      logLine('正在解压内置真实示例数据（' + D.files + ' 个文件，'
        + Math.round(D.b64Chars / 1024) + ' KB base64 → gzip 解压）…');
      D.decode().then(function (fs) {
        applyParams(D.params);
        loadFiles(fs, 'real');
        logLine('已载入 ' + fs.length + ' 个真实文件：锡石 LA-ICP-MS U-Pb，'
          + 'Thermo iCAP Qtegra 导出，按原始采集顺序。', 'g');
        logLine('  参数按数据自带的推荐值填好了：标样 ' + D.params.stdName + ' = '
          + D.params.stdAge + ' Ma，分馏校正用 ' + D.params.fracStd
          + '，微量元素外标 ' + D.params.nistStd + '，背景 ' + D.params.b0 + '~'
          + D.params.b1 + ' s，普通铅按 207Pb 校正（方式 ' + D.params.method + '）。');
        //  数字取自产物（stdMeasured），不在这里手写第二份。
        //  质量报告的标样表印的是 1σ 内部标准误，这里引的是 2σ —— 所以
        //  M.sigma 要跟着一起印出来，否则同一个数在两处看着像对不上。
        var M = D.stdMeasured;
        var refs = (D.stdRefs || []).map(function (x) {
          return x.who + ' ' + x.age + ' ± ' + x.s2 + ' Ma';
        }).join('、');
        if (M) {
          logLine('  这一批的标样 ' + M.name + ' 跑出来是 ' + M.mean.toFixed(2)
            + ' ± ' + M.se2.toFixed(2) + ' Ma（' + M.sigma + '，MSWD '
            + M.mswd.toFixed(2) + '，' + M.n + ' 个点）—— 与公开发表的 '
            + 'ID-TIMS 值都对得上：' + refs + '。');
        } else {
          logLine('  这一批的标样 ' + D.params.stdName + ' 已按推荐参数跑过一遍，'
            + '公开的 ID-TIMS 值是 ' + refs + '。');
        }
        logLine('  脱敏说明：样品代号已重编号成 S-01…，第 1 行的采集时间已归零，'
          + '文件名改成 sample_NN.csv，**数值一个字节都没动**。'
          + '标样名（' + D.params.stdName + '、' + D.params.nistStd
          + '）保留原名 —— 标样本来就要写进论文。');
        if (D.flaws) {
          var bad = D.flaws.nanRows || [];
          var weak = D.flaws.weakFiles || [];
          if (bad.length) {
            logLine('  ⚠ 有 ' + bad.length + ' 个文件的比值列整行算不出来（NaN）：'
              + bad.map(function (x) { return x.file + '（' + x.sample + '）'; }).join('、')
              + '。', 'w');
            logLine('     原因是积分窗口没定出来：探测到的 s0 落在 s1 之后（探到了一个'
              + '反的窗口），原实现里那段窗口自检随后把它压成空切片。'
              + '质量报告会把这些点剔除，而不是拿它们去污染加权平均 —— 所以'
              + '"参与平均的点数"比"文件数"少是对的。', 'w');
          }
          if (weak.length) {
            logLine('  ⚠ 另有 ' + weak.length + ' 个文件的净 ²⁰⁶Pb 计数低于本批中位数的一半'
              + '（剥蚀失败或颗粒贫 U），它们的单点误差会明显偏大。本批净 ²⁰⁶Pb 中位数 '
              + '= ' + Math.round(D.flaws.netPbMedian) + ' cps。', 'w');
          }
        }
        logLine('  这不是为了演示而挑出来的"干净"数据 —— 真数据就长这样。'
          + '点"开始计算"，再点质量报告看它怎么处理这些点。');
        toast('真实示例数据已载入，点"开始计算"');
      }).catch(function (e) {
        logLine('!! 解压内置数据失败：' + (e && e.message || e), 'e');
        toast('解压内置数据失败，见日志', true);
      });
    });

    $('btn-demo-syn').addEventListener('click', function () {
      var fs = window.__demoFiles();
      //  合成数据的信号大约落在第 7~17 秒，背景得取在信号之前，否则净信号≈0、
      //  比值全是 NaN。所以载入时把窗口参数一并调好 —— 只为让流程能跑通。
      applyParams({ inst: 'thermo', b0: 1, b1: 5, multi: 8,
        stdName: 'MAD-NEW', stdAge: 485, fracStd: 'MAD-NEW', nistStd: 'NIST610',
        method: 0, algo: 'avg', excess: 3 });
      loadFiles(fs, 'syn');
      logLine('已载入 ' + fs.length + ' 个示例文件（**合成数据**，只为了让你先看到流程跑通）。');
      logLine('  示例数据是合成的，算出来的年龄没有地质意义，别拿去用。');
      logLine('  顺带把积分窗口改成了 背景 1~5s、阈值 8 倍 —— 这份数据的信号在 7~17s，'
        + '按默认的 8~16s 取背景会把信号也当成背景。');
      toast('合成示例已载入，点"开始计算"');
    });
  }

  /* ======================================================================
   *  启动
   * ==================================================================== */
  /** 页脚的构建信息。拿不到也不报错，只说明情况 —— 用户得知道手上是哪一版。 */
  function fillBuildInfo() {
    var host = $('buildinfo');
    if (!host) return;
    var b = window.__build;
    if (!b) { host.textContent = '构建信息缺失（这份文件可能被手工改过）'; return; }
    //  显示 __build.id（源码指纹）—— 与 build_ui.py 打印的"源码指纹"那一行同值，
    //  用户拿它俩核对"是不是同一版"才成立。没有 id 的旧产物退回看 fp.js 的模块哈希。
    var fp = '';
    if (b.id) {
      fp = '  ·  源码指纹 ' + b.id;
    } else {
      var m = /src\/fp\.js=([0-9a-f]+)/.exec(b.fingerprint || '');
      if (m) fp = '  ·  fp.js 指纹 ' + m[1].slice(0, 8);
    }
    host.textContent = '构建于 ' + b.built + fp;
  }

  /*  左栏「真实锡石」那句说明里的文件个数，从产物读。
   *  这里原来是手写的一个数，数据从 50 个改成 49 个之后没人记得改 ——
   *  凡是从产物里就有答案的数，就不该在界面里抄第二份。 */
  function fillDemoCount() {
    var el = $('demo-n'), D = window.DS_DEMO_REAL;
    if (el && D && D.files) el.textContent = D.files + ' 个';
  }

  function boot() {
    wire();
    buildPbParams();
    fillBuildInfo();
    fillDemoCount();
    renderQcDoc();          // ⑥ 里那些阈值说明取自 qc.js，不在 HTML 里重复一遍
    initIsoTab();           // IsoplotR 那一页：只填下拉文案，不碰网络
    if (location.hash === '#selftest') {
      window.__selftest = { done: false, results: [] };
      setTimeout(function () {
        try {
          window.__selftest = window.__runSelftest();
        } catch (e) {
          window.__selftest = { done: true, pass: 0, fail: 1,
            results: [{ name: 'selftest 抛出异常', ok: false, detail: String(e && e.stack || e) }] };
        }
        var R = window.__selftest;
        logClear();
        logLine('内置自检：' + R.pass + ' 通过 / ' + R.fail + ' 失败');
        R.results.forEach(function (r) {
          logLine((r.ok ? '  ok  ' : ' FAIL ') + r.name + '   ' + (r.detail || ''),
            r.ok ? 'g' : 'e');
        });
        selectTab('log');
        //  把通过数写进标题：无头浏览器只看得到 <title>，日志面板的文本
        //  不在 --dump-dom 的输出里（试过，读不到）。带上数字才能一眼核对。
        document.title = (R.fail ? 'SELFTEST-FAIL' : 'SELFTEST-OK')
          + ' [' + R.pass + '/' + (R.pass + R.fail) + '] —— ' + document.title;
        window.__selftestReady = true;
      }, 0);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();

  // 供自检使用
  window.__ui = {
    state: state, run: run, readConfig: readConfig, calAge: calAge,
    ensureEntries: ensureEntries, addFiles: addFiles, selectTab: selectTab,
    refreshFileList: refreshFileList, probe: probe, probeAll: probeAll,
    pickFile: pickFile, showPlot: showPlot, dropProbeCache: dropProbeCache,
    currentInst: currentInst, isonameFor: isonameFor,
    displayHeader: displayHeader, typoColumns: typoColumns,
    updateListInfo: updateListInfo, resetPane: resetPane,
    fmtNum: fmtNum, ageCsv: ageCsv, exportJson: exportJson, download: download,
    logLine: logLine, logClear: logClear, ISONAME: ISONAME, ISO_AGILENT: ISO_AGILENT,
    //  IsoplotR 那一页：自检要能读它的控件状态，也要能直接调交叉验证那一段
    initIsoTab: initIsoTab, refreshIsoControls: refreshIsoControls,
    refreshIsoAgeOptions: refreshIsoAgeOptions, isoOpts: isoOpts,
    isoSyncMore: isoSyncMore,
    isoOwnMean: isoOwnMean, isoRender: isoRender, isoMsg: isoMsg
  };
})();
