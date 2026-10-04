/* ==========================================================================
 *  selftest.js —— 内置自检 + 示例数据
 *
 *  地址栏后面加 #selftest 打开本页，就会用一份合成数据把整条链跑一遍，
 *  逐项检查并把结果写进 window.__selftest，方便无头浏览器读取。
 *
 *  为什么自检要放在页面里
 *  ---------------------
 *  Node 下的 test_*.js 验的是 src/*.js 这几个模块；这里是**验接线**：
 *  界面读参数 → 组 cfg → 调管线 → 组年龄层输入 → 出表。接线错了，模块再对也没用。
 *  所以自检是"设置页面上的输入框，然后点计算"，走的是真按钮走的那条路。
 *
 *  合成数据与 make_e2e_case.py 的规则一致（同一套 time_text / profile / 通道倍数），
 *  只是规模缩小、并加上"每个文件一组通道倍数"以便各样品年龄互不相同。
 * ========================================================================== */
(function () {
  'use strict';

  var ISONAME = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'];
  var WEIGHTS = [5, 1, 30, 2, 6, 200, 1500];
  var N = 1200;
  var B0 = 1.0, B1 = 5.0, MULTI = 8;

  var FILES = [
    ['MAD-NEW_1.csv', 'MAD-NEW', 'two_plates'],
    ['MAD-NEW_2.csv', 'MAD-NEW', 'step'],
    ['NIST610_3.csv', 'NIST610', 'step'],
    ['NIST610_4.csv', 'NIST610', 'step'],
    ['91500_5.csv', '91500', 'step']
  ];

  function channelWeight(k, j) {
    return Math.round(WEIGHTS[j] * (0.55 + 0.075 * ((k * 7 + j * 11) % 13)));
  }

  function profileOf(shape, n) {
    var p = new Array(n);
    var a = Math.trunc(n * 0.25);
    var b = Math.trunc(n * 0.75);
    if (shape === 'step') {
      for (var i = 0; i < n; i++) p[i] = i < a ? 100 : (i < b ? 9000 : 100);
    } else if (shape === 'two_plates') {
      var t1 = Math.trunc(n * 0.5), t2 = Math.trunc(n * 0.6);
      for (var j = 0; j < n; j++) {
        p[j] = j < a ? 100 : (j < t1 ? 8000 : (j < t2 ? 100 : (j < b ? 9000 : 100)));
      }
    } else throw new Error('未知 shape: ' + shape);
    return p;
  }

  function timeText(i) {
    var t = i * 2;
    return Math.floor(t / 100) + '.' + String(t % 100).padStart(2, '0');
  }

  function makeCsv(sampleName, shape, n, k) {
    var lines = [sampleName + ': synthetic test export'];
    for (var i = 1; i < 13; i++) lines.push('Thermo Fisher iCAP  meta line ' + (i < 10 ? '0' + i : i));
    lines.push(ISONAME.concat(['Note']).join(','));
    lines.push(['sec'].concat(['cps', 'cps', 'cps', 'cps', 'cps', 'cps', 'cps', 'txt']).join(','));
    var prof = profileOf(shape, n);
    for (var r = 0; r < n; r++) {
      var cells = [timeText(r)];
      for (var j = 0; j < 7; j++) {
        var w = channelWeight(k, j);
        cells.push(String(w * prof[r] + (w % 7) * ((r * 13 + j * 5) % 9)));
      }
      cells.push('ok');
      lines.push(cells.join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  function makeFiles() {
    return FILES.map(function (f, k) {
      return { file: f[0], text: makeCsv(f[1], f[2], N, k) };
    });
  }

  /**
   * Agilent 格式的同一套数据：前 3 行元信息、第 4 行列名、第 5 行单位，
   * 列名是 `时间 [s] / 202 / 204Pb / …`（对应 skiprows=3）。
   * 数值生成与 Thermo 版共用 profileOf / channelWeight，两条链的结果应当一致。
   */
  function makeAgilentCsv(shape, n, k) {
    var lines = [];
    for (var i = 1; i <= 3; i++) lines.push('Agilent 7500  meta line ' + i);
    lines.push(['时间 [s]', '202', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U']
      .join(','));
    lines.push(['sec', 'cps', 'cps', 'cps', 'cps', 'cps', 'cps', 'cps'].join(','));
    var prof = profileOf(shape, n);
    for (var r = 0; r < n; r++) {
      var cells = [timeText(r)];
      for (var j = 0; j < 7; j++) {
        var w = channelWeight(k, j);
        cells.push(String(w * prof[r] + (w % 7) * ((r * 13 + j * 5) % 9)));
      }
      lines.push(cells.join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  /** 已知的"正确舍入"取值（由 Python 用 decimal 算出来，见 webgui/src/fp_case.json）。 */
  var FP_PROBES = [
    ['crExp', 0.11975871858733333, 1.1272248403631944],
    ['crExp', 1.0448071347791346, 2.8428501838470353],
    ['crLog', 0.8293162832224102, -0.18715367281793374],
    ['crLog', 2.333790162734562, 0.8474936252531097]
  ];

  function run() {
    var out = [];
    var pass = 0, fail = 0;
    function t(name, ok, detail) {
      out.push({ name: name, ok: !!ok, detail: detail || '' });
      if (ok) pass++; else fail++;
    }
    var ui = window.__ui;
    var DS = window.DS, AGE = window.DS_AGE, PL = window.DS_PIPELINE, FP = window.DS_FP;
    var $ = function (id) { return document.getElementById(id); };

    /* --- 0. 前置：模块都在 --- */
    t('模块全部就绪', !!(DS && AGE && PL && FP && window.DS_WINDOW && window.DS_THERMO
      && window.DS_REPORT), 'DS / DS_AGE / DS_PIPELINE / DS_FP / DS_WINDOW / DS_THERMO / DS_REPORT');
    if (!DS || !AGE || !PL || !FP) return { done: true, pass: pass, fail: fail, results: out };

    /* --- 0a. 内置真实示例数据必须真的打进来了 ---
       桌面壳（packaging/isoclock_desktop.py）的 --selftest 只看这一套自检的
       通过数。如果 build_ui.py 漏拼了 demo_real.js，界面照样能开、手工拖 CSV
       也照样能用 —— 只有主推的那个示例按钮会在**用户手里**才报错。
       所以这里必须有一条。

       注意这里只查**存在与形状**，不查内容：解压是异步的，而 run() 是同步的。
       内容对不对由 CI 里的 webgui/test_demo_real.js 管 —— 它会真解压、
       重算 sha256、跑完整管线并拿标样去对公开文献值。两条分工明确。 */
    var DR = window.DS_DEMO_REAL;
    t('内置真实示例数据已打包进来',
      !!(DR && typeof DR.decode === 'function' && DR.files > 0 && DR.rawBytes > 0),
      DR ? (DR.files + ' 个文件，' + Math.round(DR.b64Chars / 1024) + ' KB base64，'
            + DR.encoding) : '没找到 window.DS_DEMO_REAL');
    t('内置真实示例数据的推荐参数齐全',
      !!(DR && DR.params && DR.params.stdName && DR.params.stdAge > 0
        && DR.params.fracStd && DR.params.nistStd
        && typeof DR.params.method === 'number' && DR.params.multi > 0
        && DR.params.b1 > DR.params.b0),
      DR && DR.params ? (DR.params.stdName + ' = ' + DR.params.stdAge + ' Ma ｜ method '
        + DR.params.method + ' ｜ 背景 ' + DR.params.b0 + '~' + DR.params.b1 + ' s ｜ 外标 '
        + DR.params.nistStd) : '没有 params');
    t('内置真实示例数据带实测毛病清单（flaws）',
      !!(DR && DR.flaws && Array.isArray(DR.flaws.nanRows)
        && Array.isArray(DR.flaws.weakFiles)),
      DR && DR.flaws ? (DR.flaws.nanRows.length + ' 个整行 NaN 的文件 ｜ '
        + DR.flaws.weakFiles.length + ' 个弱信号文件 ｜ 净 ²⁰⁶Pb 中位数 '
        + Math.round(DR.flaws.netPbMedian) + ' cps') : '没有 flaws');
    /*  界面日志与文档正文引的那个"标样跑出来是多少"必须来自这里，
        不能是手写的第二份 —— 而且**误差口径要一起带着**：质量报告的标样表
        印 1σ 内部标准误，正文引 2σ，少了 sigma 就会看着像两个数对不上。 */
    t('内置真实示例数据带实测标样结果（含误差口径）',
      !!(DR && DR.stdMeasured && DR.stdMeasured.mean > 0 && DR.stdMeasured.se2 > 0
        && DR.stdMeasured.mswd > 0 && DR.stdMeasured.n > 0
        && /σ/.test(DR.stdMeasured.sigma)),
      DR && DR.stdMeasured ? (DR.stdMeasured.name + ' = '
        + DR.stdMeasured.mean.toFixed(2) + ' ± ' + DR.stdMeasured.se2.toFixed(2) + ' Ma（'
        + DR.stdMeasured.sigma + '），' + DR.stdMeasured.n + ' 个点，MSWD '
        + DR.stdMeasured.mswd.toFixed(2)) : '没有 stdMeasured');
    /*  左栏那句「真实锡石」说明里的文件个数**从产物读**，不是手写的 ——
        手写的那份已经过期过一次（数据从 50 个改成 49 个时没人记得改）。
        这条钉住"界面里那个数确实被填上了、而且填对了"。 */
    t('左栏说明里的文件个数与内置数据一致',
      !!(DR && $('demo-n') && $('demo-n').textContent === DR.files + ' 个'),
      $('demo-n') ? ('界面上写着「' + $('demo-n').textContent + '」，产物里是 '
        + (DR ? DR.files : '?') + ' 个') : '找不到 #demo-n');

    /* --- 0b. 单文件构建的结构自检（踩过的坑，留个哨兵）---
       src 下的模块是"平铺式脚本"：顶层直接写 const / function，靠 window.DS_* 交接。
       构建时如果把多个模块合并进**同一个** script 块，同名顶层函数就会互相覆盖
       —— pipeline.js 与 age.js 都声明了 attach，合并后 DS_PIPELINE.attach
       实际指向 age.js 那个，于是 PL.attach(...) 把参数写进了 age.js 的内部对象，
       pipeline 自己的 thermoLoad 一直是 undefined，直到跑起来才报
       "P.thermoLoad is not a function"。下面两条就是钉住这件事的。 */
    t('PL.attach 没有被 AG.attach 顶掉', PL.attach !== AGE.attach,
      'PL.attach: ' + String(PL.attach).replace(/\s+/g, ' ').slice(0, 48)
      + ' ｜ AG.attach: ' + String(AGE.attach).replace(/\s+/g, ' ').slice(0, 48));

    var sentinelHit = 0;
    var realThermoLoad = window.DS_THERMO.thermoLoad;
    try {
      PL.attach({ thermoLoad: function () { sentinelHit++; return {}; } });
      try {
        PL.loadThermoFiles([{ file: 'probe.csv', text: 'x' }],
          { isoname: [], b0: 1, b1: 2, multi: 4 });
      } catch (eProbe) { /* 数据是假的，后面多半要出错；只要哨兵被调到就够了 */ }
    } finally {
      PL.attach({ thermoLoad: realThermoLoad });     // 立刻还原，别影响后面的测试
      ui.state.entries = null;
    }
    t('PL.attach 的参数真的落在管线上', sentinelHit === 1,
      '哨兵被调用 ' + sentinelHit + ' 次（应当恰好 1 次）');

    /* --- 1. 正确舍入的 exp / log 真的在用 --- */
    var fpBad = [], fpHostDiff = 0;
    FP_PROBES.forEach(function (p) {
      var got = FP[p[0]](p[1]);
      if (!Object.is(got, p[2])) fpBad.push(p[0] + '(' + p[1] + ')=' + got + ' 期望 ' + p[2]);
      var host = (p[0] === 'crExp' ? Math.exp : Math.log)(p[1]);
      if (!Object.is(host, p[2])) fpHostDiff++;
    });
    t('crExp/crLog 与正确舍入一致', fpBad.length === 0,
      fpBad.length ? fpBad.join('；') : FP_PROBES.length + ' 个探针逐位相同');
    /* 宿主更准还是更差，是**环境属性**，不能写成这个软件的通过/失败项。
       `Math.exp` / `Math.log` 的精度随引擎和机器变：macOS 的 JavaScriptCore
       （WKWebView）与一部分 Windows 上的 WebView2 在这 4 个探针上就是**与
       正确舍入一致**的。原先把 `fpHostDiff > 0` 当断言，结果是同一个文件在
       开发机上 37/37、在 CI 的 Windows 和 macOS 上都 36/37 ——
       挂的不是软件，是机器。这种测试比没有更坏：它会训练人忽略红灯。

       真正要守住的是：**自实现必须真的是自实现**。宿主越准，上面那条
       "与参考值一致"就越没有区分力（把 crExp 换成 Math.exp 也能过），
       所以这一条必须独立存在。 */
    t('自实现没有被宿主函数顶掉',
      FP.crExp !== Math.exp && FP.crLog !== Math.log,
      '宿主与正确舍入不同的探针：' + fpHostDiff + '/' + FP_PROBES.length
        + ' 个（引擎属性，只记录，不判通过与否）');
    t('dexp/dlog 默认走自实现', FP.dexp(0.11975871858733333) === 1.1272248403631944,
      'dexp(0.11975871858733333)=' + FP.dexp(0.11975871858733333));

    /* --- 2. 合成数据本身 --- */
    var files = makeFiles();
    t('合成数据生成', files.length === 5 && files.every(function (f) {
      return f.text.split('\r\n').length > 1200;
    }), files.length + ' 个文件，每个 >1200 行');

    /* --- 3. 灌进界面（就是按钮走的那条路）--- */
    ui.state.files = files;
    ui.state.entries = null;
    ui.state.selected = null;
    $('p-stdname').value = 'MAD-NEW';
    $('p-stdage').value = '485';
    $('p-fracstd').value = 'MAD-NEW';
    $('p-b0').value = String(B0);
    $('p-b1').value = String(B1);
    $('p-multi').value = String(MULTI);
    $('p-method').value = '0';
    $('p-excess').value = '3';            // 与桌面版默认（var5.set(3)）一致
    $('p-algo').value = 'avg';
    $('p-nist').value = 'NIST610';
    ui.state.entries = null;

    /* --- 4. 每个文件都能解析、窗口合理 --- */
    var entries = ui.ensureEntries();
    var nBad = 0, winBad = 0;
    files.forEach(function (f) {
      var e = entries.perFile[f.file];
      if (!e || e.n !== N) nBad++;
      else {
        var w = e.num;
        if (!(w[4] > w[3] && w[3] >= w[2] && w[2] > 0)) winBad++;
      }
    });
    t('5 个文件全部解析', nBad === 0, '点数都等于 ' + N);
    t('自动识别的信号窗口合法', winBad === 0,
      files.map(function (f) {
        var w = entries.perFile[f.file].num;
        return f.file + ':[背景 ' + w[1] + '~' + w[2] + ' 信号 ' + w[3] + '~' + w[4] + ']';
      }).join(' '));

    /* --- 5. 点"开始计算" --- */
    var csv1 = null;
    try {
      ui.run();
      csv1 = ui.state.result && ui.state.result.resultAllCsv;
      t('管线跑到出结果', !!csv1, csv1 ? csv1.split('\r\n').length - 2 + ' 行 result_all' : '没有产出');
    } catch (e) {
      t('管线跑到出结果', false, String(e && e.stack || e));
      return { done: true, pass: pass, fail: fail, results: out };
    }

    /* --- 6. result_all / Mean_Cps 的形状 --- */
    var ra = csv1.split('\r\n').filter(function (l) { return l.length; });
    var mc = ui.state.result.meanCpsCsv.split('\r\n').filter(function (l) { return l.length; });
    t('result_all 行数与列数', ra.length === 6 && ra[0].split(',').length === 23,
      ra.length + ' 行（含表头）× ' + ra[0].split(',').length + ' 列');
    t('Mean_Cps 行数与列数', mc.length === 6 && mc[0].split(',').length === 16,
      mc.length + ' 行（含表头）× ' + mc[0].split(',').length + ' 列');

    /* --- 7. 年龄表 --- */
    var ar = ui.state.ageResult;
    t('年龄表行数与列数', ar.rows.length === 5 && ar.rows[0].length === 51,
      ar.rows.length + ' 行 × ' + ar.rows[0].length + ' 列');
    t('年龄表表头与 headerFor 一致',
      ar.header.join('|') === AGE.headerFor(false, 0).join('|'), '51 列');
    var ages = ar.rows.map(function (r) { return r[17]; });
    t('206Pb/238U 年龄全部有限', ages.every(function (a) { return isFinite(a); }),
      ages.map(function (a) { return ui.fmtNum(a); }).join(', '));
    t('年龄都落在 0~4560 Ma', ages.every(function (a) { return a >= 0 && a <= 4560; }),
      '最大 ' + ui.fmtNum(Math.max.apply(null, ages)) + ' Ma');
    t('各样品年龄互不相同', new Set(ages).size === ages.length,
      new Set(ages).size + ' 个不同的值');
    var coefBad = ar.rows.filter(function (r) {
      return !(r[47] !== 0 && r[48] !== 0 && r[49] !== 0);
    }).length;
    t('微量元素系数非零（NIST610 出现 2 次）', coefBad === 0,
      '第 47/48/49 列在 ' + (5 - coefBad) + '/5 行上非零');

    /* --- 8. 确定性：同输入同结果 --- */
    var before = ui.state.result.resultAllCsv;
    ui.run();
    t('重跑结果完全相同', ui.state.result.resultAllCsv === before,
      '两次 result_all.csv 逐字节相同（' + before.length + ' 字节）');

    /* --- 9. 换线性法 --- */
    $('p-algo').value = 'lin';
    ui.run();
    var arL = ui.state.ageResult;
    var nSample = 5 - 2;                       // 两个 MAD-NEW 是标样
    t('线性法行数正确', arL.rows.length === nSample,
      arL.rows.length + ' 行（非标样行数 ' + nSample + '）');
    t('线性法与平均法结果不同',
      arL.rows.length !== ar.rows.length
      || JSON.stringify(arL.rows[0]) !== JSON.stringify(ar.rows[0]), '两种算法有区别');

    /* --- 10. 换校正路径：207Pb 校正 + 按年龄推算普通铅 --- */
    $('p-algo').value = 'avg';
    $('p-method').value = '1';
    $('p-method').dispatchEvent(new Event('change'));
    $('pb-byage').checked = true;
    $('pb-byage').dispatchEvent(new Event('change'));
    $('pb-age').value = '100';
    $('pb-age').dispatchEvent(new Event('change'));
    ui.run();
    var arM1 = ui.state.ageResult;
    t('207Pb 校正路径跑通', arM1.rows.length === 5 && arM1.rows[0].length === 51,
      arM1.rows.length + ' 行');
    t('207Pb 校正路径与不校正不同',
      JSON.stringify(arM1.rows[0]) !== JSON.stringify(ar.rows[0]), '第 26-29 列有差异');
    var hdrOk = ['207Pb Corr. Age(Ma)', '207Pb_235U', '2s', '206Pb_238U', '2s']
      .every(function (s, i) { return arM1.header[25 + i] === s; });
    t('校正路径的表头正确', hdrOk, '第 25-29 列 = ' + arM1.header.slice(25, 30).join(' | '));

    /* --- 11. 导出 --- */
    var txt = ui.ageCsv();
    var lines = txt.split('\r\n').filter(function (l) { return l.length; });
    t('年龄表可导出为 CSV', lines.length === 6 && lines[0].split(',').length === 51,
      lines.length + ' 行（含表头）× ' + lines[0].split(',').length + ' 列');
    t('导出用 Python 的 repr 排版', /e[-+]0/.test(txt) || /\d\.\d/.test(txt),
      '例如 ' + lines[1].split(',')[17]);

    /* --- 12. 信号图能画 --- */
    var cv = $('plot');
    ui.selectTab('plot');
    try {
      ui.state.selected = files[0].file;
      ui.refreshFileList();                 // 拖文件进界面时走的就是这一步
      var rows = document.querySelectorAll('.filelist tr.pick');
      t('文件列表渲染出 ' + rows.length + ' 行', rows.length === files.length,
        rows.length + ' 行可点');
      // 点第一行 —— 就等于用户点开它的信号图
      rows[0].dispatchEvent(new MouseEvent('click'));
      var g = cv.getContext('2d');
      var d = g.getImageData(0, 0, cv.width, cv.height).data;
      var nonWhite = 0;
      for (var i = 0; i < d.length; i += 4 * 997) {
        if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) nonWhite++;
      }
      t('信号图有实际内容', nonWhite > 20,
        '采样点里 ' + nonWhite + ' 个非白（画布 ' + cv.width + '×' + cv.height + '）');
    } catch (e2) {
      t('信号图有实际内容', false, String(e2 && e2.message || e2));
    }

    /* --- 13. 仪器必须一路传到"轻量解析"那一步 ---
       踩过的坑：probe() 曾经写死用 Thermo 读取器，不读③里的仪器选择。
       Agilent 的表头里没有 Time 列，于是整批文件显示"解析失败"、标样筛选为空、
       平均法直接 return —— 而只测读取器的 test_agilent.js 是全绿的。
       下面这条哨兵不需要额外数据：同一批 Thermo 文件，仪器切到 Agilent 之后
       必须**全部解析失败**。若仪器没传下去，它们还会成功，当场就能发现。 */
    $('p-inst').value = 'agilent';
    $('p-inst').dispatchEvent(new Event('change'));
    var agOnThermo = files.filter(function (f) { return ui.probeAll()[f.file].ok; }).length;
    t('仪器切换真的生效（Thermo 文件在 Agilent 模式下应全部失败）', agOnThermo === 0,
      'Thermo 模式下 5/5 可解析 → Agilent 模式下 ' + agOnThermo + '/5 可解析');
    $('p-inst').value = 'thermo';
    $('p-inst').dispatchEvent(new Event('change'));
    var backOk = files.filter(function (f) { return ui.probeAll()[f.file].ok; }).length;
    t('切回 Thermo 后恢复正常', backOk === files.length, backOk + '/' + files.length + ' 可解析');

    /* --- 13b. 真的 Agilent 文件跑一遍全链（含清单定样品名）--- */
    var agFiles = [
      ['AG-S1.csv', 0], ['AG-S2.csv', 1], ['AG-X1.csv', 2]
    ].map(function (a) { return { file: a[0], text: makeAgilentCsv('step', N, a[1]) }; });
    ui.state.files = agFiles;
    ui.state.entries = null;
    ui.state.selected = null;
    ui.state.sampleNames = { 'AG-S1': 'MAD-NEW', 'AG-S2': 'MAD-NEW', 'AG-X1': '91500' };
    ui.state.sampleListName = '（自检内置清单）';
    ui.dropProbeCache();
    $('p-inst').value = 'agilent';
    $('p-inst').dispatchEvent(new Event('change'));

    var pmAg = ui.probeAll();
    var agOk = agFiles.filter(function (f) { return pmAg[f.file].ok; }).length;
    t('Agilent 文件在 Agilent 模式下全部可解析', agOk === agFiles.length,
      agOk + '/' + agFiles.length + ' 可解析');
    var agNames = agFiles.map(function (f) { return pmAg[f.file].sample; }).join(' | ');
    t('样品名来自清单而不是文件第一行', agNames === 'MAD-NEW | MAD-NEW | 91500', agNames);
    t('清单命中来源被标出来', agFiles.every(function (f) {
      return pmAg[f.file].sampleFrom === 'list';
    }), 'sampleFrom 全为 list');

    $('p-stdname').value = 'MAD-NEW';
    $('p-fracstd').value = 'MAD-NEW';
    $('p-nist').value = '';                    // 这批里没有 NIST，免得触发"系数归零"提示
    $('p-algo').value = 'avg';
    $('p-method').value = '0';
    $('p-method').dispatchEvent(new Event('change'));
    ui.run();
    var agAr = ui.state.ageResult;
    t('Agilent 链路出得出生龄表', !!(agAr && agAr.rows.length === 3),
      agAr ? agAr.rows.length + ' 行' : '没有结果');
    var agAges = (agAr ? agAr.rows : []).map(function (r) { return r[17]; });
    t('Agilent 年龄全部有限', agAges.length === 3 && agAges.every(function (a) {
      return isFinite(a);
    }), agAges.map(function (a) { return ui.fmtNum(a); }).join(', '));

    /* --- 13c. Agilent 没清单时的兜底：取文件名，且必须互不相同 ---
       Agilent 每个文件的前几行是**同一串**仪器元信息；照 Thermo 的规则读第一行的话，
       三个文件会拿到同一个样品名，年龄层就把它们当成同一样品的重复测量并成一个。 */
    ui.state.sampleNames = null;
    ui.state.sampleListName = null;
    ui.dropProbeCache();
    var pmNo = ui.probeAll();
    var noNames = agFiles.map(function (f) { return pmNo[f.file].sample; }).join(' | ');
    t('无清单时样品名取自文件名', noNames === 'AG-S1 | AG-S2 | AG-X1', noNames);
    t('无清单时样品名互不相同（不会塌成一个样品）', agFiles.every(function (f) {
      return pmNo[f.file].sampleFrom === 'file';
    }), 'sampleFrom 全为 file');

    /* --- 14. IsoplotR 那一页的接线 ---
       这一套**不验联网**（无头 CI 里没有网，也不是这条链的职责）。
       验的是"不联网也该对"的那几件事：模块打进来了、控件填上了、
       给 IsoplotR 的表是按 format=1 的列序、禁用了必然失败的选项、
       以及 Page 上没有没换掉的模板标记。真正跑 R 的部分由
       webgui/test_isoplotr.js（纯函数）与 G:/_isohtml/isoplotr/ 下的
       浏览器探针记录负责。 */
    var ISO = window.DS_ISOPLOTR;
    t('IsoplotR 模块已打包进来（ui/isoplotr.js）',
      !!(ISO && typeof ISO.buildTable === 'function' && typeof ISO.svgDataUri === 'function'),
      ISO ? (ISO.WEBR_ENTRY + ' ｜ 导出 ' + Object.keys(ISO).length + ' 项')
          : '没找到 window.DS_ISOPLOTR');
    var isoTab = document.querySelector('.tabs button[data-tab="iso"]');
    t('标签栏里有「IsoplotR 谐和图」这一页',
      !!isoTab && !!$('pane-iso'), isoTab ? isoTab.textContent.trim() : '没有这个按钮');
    t('三个下拉都填满了（图型 / 拟合 / 普通铅）',
      $('iso-type').options.length === (ISO ? ISO.TYPES.length : 0)
      && $('iso-age').options.length === (ISO ? ISO.AGES.length : 0)
      && $('iso-cpb').options.length === (ISO ? ISO.CPB.length : 0),
      $('iso-type').options.length + ' / ' + $('iso-age').options.length
      + ' / ' + $('iso-cpb').options.length + ' 项');

    /*  「更多选项」面板（逐项对应 IsoplotR 原版）。这里验的是**接线**：
     *  控件填满了没有、联动对不对、以及"留空是不是真的不传"。
     *  参数本身怎么进 R 代码由 webgui/test_isoplotr.js 的 §I 负责。 */
    var more = $('iso-more');
    t('「更多选项」面板在，且默认是收起来的',
      !!more && String(more.tagName).toLowerCase() === 'details' && more.open === false,
      more ? (more.open ? '默认展开会挤掉首屏' : '默认收起') : '没有这个面板');
    t('面板里三组候选值都填满了（锚定 / 过滤档 / 判据）',
      $('iso-anchor').options.length === (ISO ? ISO.ANCHORS.length : 0)
      && $('iso-disc').options.length === (ISO ? ISO.DISCFILTERS.length : 0)
      && $('iso-disc-opt').options.length === (ISO ? ISO.DISCOPT.length : 0),
      $('iso-anchor').options.length + ' / ' + $('iso-disc').options.length
      + ' / ' + $('iso-disc-opt').options.length + ' 项');

    /*  默认（什么都没碰）时必须**一个都不传** —— 这是"与原版一致"的前提：
     *  用户没动过的项，行为必须和不加这个面板时一模一样。 */
    t('默认状态下「更多选项」一个参数都不传（留空 = 用 IsoplotR 自己的默认值）',
      (function () {
        var o = ui.isoOpts();
        return o.anchor === 0 && !o.anchorAge && o.discFilter === 0 && !o.discCutoff
          && !o.tlim && !o.xlim && !o.ylim && !o.ticks && !o.exterr
          && !o.shownumbers && !o.fill && !o.stroke;
      })(), '默认就把参数传出去，等于偷偷改了用户没动过的东西');

    t('联动：锚定年龄那格只在 anchor=2 且拟合选 discordia 时出现',
      (function () {
        var shown = function (a, sa) {
          $('iso-anchor').value = String(a);
          $('iso-age').value = String(sa);
          ui.isoSyncMore();
          return $('iso-anchor-age-wrap').className.indexOf('off') < 0;
        };
        var r = [shown(2, 2), shown(2, 1), shown(3, 2), shown(0, 2)];
        $('iso-anchor').value = '0'; $('iso-age').value = '1'; ui.isoSyncMore();
        return r[0] === true && r[1] === false && r[2] === false && r[3] === false;
      })(), '原版 GUI 也是只在 discordia 那一档显示这一栏');

    t('联动：颜色框挂在「自定义」勾选框上，不勾就不传颜色',
      (function () {
        var before = ui.isoOpts();
        $('iso-fill-on').checked = true;
        $('iso-fill').value = '#ff0000';
        $('iso-fill-alpha').value = '0.35';
        ui.isoSyncMore();
        var shown = $('iso-fill-wrap').className.indexOf('off') < 0;
        var on = ui.isoOpts();
        $('iso-fill-on').checked = false;
        ui.isoSyncMore();
        var off = ui.isoOpts();
        return !before.fill && shown && on.fill === '#ff0000'
          && on.fillAlpha === '0.35' && off.fill === '';
      })(), '颜色框永远有值，所以必须靠勾选框决定传不传');

    t('填了更多选项后，生成的 R 代码里真的带上它们（anchor 也会按 show.age 决定传不传）',
      (function () {
        var mk = function () {
          var o = ui.isoOpts();
          return ISO.rCode({ csv: '/tmp/s.csv', svg: '/tmp/s.svg',
                             showAge: o.showAge, ticks: o.ticks, anchor: o.anchor });
        };
        $('iso-anchor').value = '3';
        $('iso-ticks').value = '5';
        $('iso-age').value = '1';
        var c1 = mk();                       // discordia 之外的档：anchor 不该传
        $('iso-age').value = '2';
        var c2 = mk();
        $('iso-anchor').value = '0';
        $('iso-age').value = '1';
        $('iso-ticks').value = '';
        ui.isoSyncMore();
        return /ticks=5/.test(c1) && !/anchor=3/.test(c1) && /anchor=3/.test(c2);
      })());

    var arIso = ui.state.ageResult;
    t('有结果时「加载 IsoplotR 并作图」可用；没结果时禁用',
      !!arIso && $('btn-iso-run').disabled === false,
      arIso ? ('当前 ' + arIso.rows.length + ' 行结果，按钮 enabled=' +
        !$('btn-iso-run').disabled) : '还没有结果');

    var tabIso = ISO ? ISO.buildTable(arIso ? arIso.rows : [], {}) : null;
    t('给 IsoplotR 的表按 format=1 的列序，且表头就是那五列',
      !!tabIso && tabIso.lines[0] === 'Pb207U235,errPb207U235,Pb206U238,errPb206U238,rhoXY',
      tabIso ? tabIso.lines[0] : '—');
    t('表里的点数与年龄表里能用的行数一致（不是把 NaN 行也塞进去）',
      !!tabIso && tabIso.n > 0
      && tabIso.n === (arIso ? arIso.rows.filter(function (r) {
        return ISO.rowUsable(r).ok;
      }).length : -1),
      tabIso ? (tabIso.n + ' 点，剔除 ' + tabIso.skipped + ' 行') : '—');
    t('表里第 1 行第 1 个数 = 年龄表那一行的第 36 列（列号没数错）',
      (function () {
        if (!tabIso || !arIso) return false;
        var first = arIso.rows.filter(function (r) { return ISO.rowUsable(r).ok; })[0];
        return !!first && tabIso.lines[1].split(',')[0] === Number(first[36]).toPrecision(10);
      })(), '取错列（比如取了 2s 那列）这里立刻红');

    /*  这一条是本模块最贵的一个坑的守卫：判据必须作用在**写出去的那个数**上。
        年龄表里 ρ 可以到 0.99999999999999889，按原始值判 |ρ|<1 就放行了，
        而写出格式是 10 位有效数字 ⇒ "1.000000000" ⇒ R 收到精确的 1
        ⇒ 协方差矩阵退化 ⇒ 拟合静默失败（只报一句 L-BFGS-B）。 */
    t('表里每一行的 ρ（写出去的第 5 列）都严格小于 1',
      !!tabIso && tabIso.lines.slice(1).length > 0
      && tabIso.lines.slice(1).every(function (l) {
        var v = Number(l.split(',')[4]);
        return isFinite(v) && Math.abs(v) < 1;
      }),
      tabIso ? ('剔掉 ' + tabIso.badRho + ' 行 ρ 写出去就是 ±1'
        + (tabIso.rhoFiles && tabIso.rhoFiles.length
          ? '：' + tabIso.rhoFiles.join('、') : '')) : '—');

    //  样品下拉：切到那一页时要按当前结果重建
    ui.selectTab('iso');
    var sopts = $('iso-sample').options;
    t('切到该页后，样品下拉按当前结果重建（第一项是"全部样品"，且注明不含标样）',
      sopts.length >= 2 && /^全部样品（(不含标样，)?\d+ 个可用点）$/.test(sopts[0].textContent),
      sopts.length + ' 项，第一项「' + (sopts[0] ? sopts[0].textContent : '') + '」');

    /*  样品与标样必须分开（isoplotr.js 文件头 ⑬）。内置这批数据是**一个文件
     *  一个测点**：32 个样品各 1 点，而标样 AY-4 有 15 个文件、SRM 612 有 2 个
     *  —— 只按点数排序会把 AY-4 顶到第一位，于是最自然的操作就是拿标样去拟合
     *  "样品年龄"。所以这里钉住三件事：默认项不含标样、标样在单独的分组里、
     *  真正送出去的表里确实没有标样行。 */
    t('默认选中的「全部样品」不含标样；标样在单独的分组里',
      (function () {
        if (!ISO || !arIso || !ui.state.cfg) return false;
        var std = ISO.standardNames(ui.state.cfg);
        if (!std.length) return true;              // 认不出标样就没什么可分的
        var isStd = function (nm) { return std.indexOf(nm) >= 0; };
        var nSmp = 0, opts0 = $('iso-sample').options[0];
        ISO.sampleNames(arIso.rows).forEach(function (g) {
          if (!isStd(g.name)) nSmp += g.usable;
        });
        if (opts0.value !== '*' || opts0.textContent.indexOf(String(nSmp)) < 0) return false;
        //  标样选项必须落在某个 <optgroup> 里（下拉的标题就是"标样（QC 用…）"）
        var og = $('iso-sample').querySelectorAll('optgroup');
        if (!og.length || og[og.length - 1].label.indexOf('标样') < 0) return false;
        var inGroup = {};
        for (var i = 0; i < og.length; i++) {
          var kids = og[i].children;
          for (var j = 0; j < kids.length; j++) inGroup[kids[j].value] = 1;
        }
        var allIn = std.every(function (nm) { return inGroup[nm]; });
        //  真正交给 IsoplotR 的那张表里也不能有标样行
        var t2 = ISO.buildTable(arIso.rows, { sample: '*', drop: std });
        return allIn && t2.n === nSmp && t2.dropped > 0;
      })(), '标样 ' + ISO.standardNames(ui.state.cfg || {}).join('、')
      + ' —— 默认视图是样品那 ' + (function () {
        var std = ISO.standardNames(ui.state.cfg || {});
        var n = 0;
        ISO.sampleNames(arIso ? arIso.rows : []).forEach(function (g) {
          if (std.indexOf(g.name) < 0) n += g.usable;
        });
        return n;
      })() + ' 个点');

    //  选中标样时要明说"这不是样品年龄"，并把②里填的真值一起摆出来
    t('选中标样时，说明里点明它是 QC 样（不是样品年龄）',
      (function () {
        if (!ISO || !arIso || !ui.state.cfg) return false;
        var std = ISO.standardNames(ui.state.cfg);
        if (!std.length) return true;
        var has = false;
        for (var i = 0; i < $('iso-sample').options.length; i++) {
          if ($('iso-sample').options[i].value === std[0]) { has = true; break; }
        }
        if (!has) return false;
        $('iso-sample').value = std[0];
        var bad0 = null;
        try {
          //  不真跑 R（这里不联网）：只看下拉项的 title 有没有把话说清楚
          bad0 = $('iso-sample').options[$('iso-sample').selectedIndex].title;
        } catch (e) { return false; }
        $('iso-sample').value = '*';
        $('iso-sample').dispatchEvent(new Event('change'));
        return typeof bad0 === 'string' && bad0.indexOf('不是') >= 0
          && bad0.indexOf('真值') >= 0;
      })(), '标样那一项的 title：' + (function () {
        var std = ISO.standardNames(ui.state.cfg || {});
        for (var i = 0; i < $('iso-sample').options.length; i++) {
          if ($('iso-sample').options[i].value === std[0]) {
            return String($('iso-sample').options[i].title).slice(0, 40) + '…';
          }
        }
        return '—';
      })());

    t('单点样品的 discordia 选项被禁用（IsoplotR 对 <3 点必然报错）',
      (function () {
        if (!ISO || !arIso) return false;
        var groups = ISO.sampleNames(arIso.rows);
        var one = groups.filter(function (g) { return g.usable === 1; })[0];
        if (!one) return false;                     // 合成夹具里没有单点样品就跳过
        $('iso-sample').value = one.name;
        $('iso-sample').dispatchEvent(new Event('change'));
        var sel = $('iso-age');
        var dis = 0, tot = 0;
        for (var i = 0; i < sel.options.length; i++) {
          if (Number(sel.options[i].value) >= 2) { tot++; if (sel.options[i].disabled) dis++; }
        }
        var back = Number(sel.value) < 2;           // 而且自动退回到不会失败的那一项
        $('iso-sample').value = '*';
        $('iso-sample').dispatchEvent(new Event('change'));
        return tot > 0 && dis === tot && back;
      })(), '只有一个可用点时，discordia 那三个选项应当全被禁掉');

    t('本软件自己的加权平均能被取到（交叉验证那一行要用）',
      (function () {
        if (!ISO || !ui.state.cfg) return false;
        var own = ui.isoOwnMean(ui.state.cfg.stdName);
        return !!own && isFinite(own.mean) && own.n > 0;
      })(), (function () {
        var own = ui.isoOwnMean(ui.state.cfg ? ui.state.cfg.stdName : null);
        return own ? (own.key + ' = ' + own.mean.toFixed(3) + ' Ma，' + own.n + ' 点') : '取不到';
      })());

    /*  这条查的是"页面上有没有没换掉的模板标记"。两个坑都踩过：
        ① 待查串若写成字面量，查的就是本文件自己（自指）⇒ 按字符拼出来；
        ② 内联脚本里的 JSDoc 有若干处"@returns"后接双花括号的写法，
           它在 body.innerHTML 里但**不渲染**、读者看不见 ⇒ 只看 innerHTML 必假警报。
        所以改成"扫 body 下所有文字节点与属性值，但跳过 SCRIPT/STYLE 两类的文字"
        —— 这样隐藏面板里的残留也照样能抓到。
        （本注释里也不能出现尖括号包住的 script 字样：build_ui.py 会把它当成
          真的标签数进去，上一轮就是这么被拦下的。） */
    var NEEDLE = '{' + '{';
    var leftover = (function () {
      var hits = [];
      var notText = /^(SCRIPT|STYLE)$/;
      var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentNode;
          if (p && p.nodeType === 1 && notText.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walk.nextNode()) {
        var s = String(walk.currentNode.nodeValue || '');
        if (s.indexOf(NEEDLE) >= 0) hits.push('文字「' + s.slice(0, 40) + '」');
      }
      var all = document.body.querySelectorAll('*');
      for (var e = 0; e < all.length; e++) {
        var at = all[e].attributes;
        for (var a = 0; a < at.length; a++) {
          var v = String(at[a].value || '');
          if (v.indexOf(NEEDLE) >= 0) hits.push('属性 ' + at[a].name + '="' + v.slice(0, 40) + '"');
        }
      }
      return hits;
    })();
    t('页面上没有没换掉的模板标记（双花括号会把标记原样印给读者）',
      leftover.length === 0,
      leftover.length ? leftover.slice(0, 3).join(' ｜ ')
        : '全文与属性都扫过；踩过：首页真的把 PAGEKB 标记印出来过');

    return { done: true, pass: pass, fail: fail, results: out,
      ages: ages.map(function (a) { return ui.fmtNum(a); }) };
  }

  window.__demoFiles = makeFiles;
  window.__runSelftest = run;
})();
