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
    t('宿主 Math.exp/log 确有差异', fpHostDiff > 0,
      FP_PROBES.length + ' 个探针里有 ' + fpHostDiff + ' 个与正确舍入不同（正是自实现的存在理由）');
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

    return { done: true, pass: pass, fail: fail, results: out,
      ages: ages.map(function (a) { return ui.fmtNum(a); }) };
  }

  window.__demoFiles = makeFiles;
  window.__runSelftest = run;
})();
