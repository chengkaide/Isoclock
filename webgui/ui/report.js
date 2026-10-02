/* ==========================================================================
 *  ui/report.js —— 把一次计算的结果整理成一份**可离线打开的 HTML 报告**
 *
 *  为什么是"导出文件"而不是页面里的一个标签页：报告是拿给别人看的
 *  （导师、评审、合作者、存档），对方不该需要装这个软件、也不该需要联网。
 *  所以这里生成的是一份**单文件、内联样式与内联 SVG、零外部依赖**的 HTML，
 *  双击就能开，Ctrl+P 就能存成 PDF。
 *
 *  报告里每一块数字的来源都写清楚了，特别标出哪几类**不是**桌面版 Isoclock
 *  的输出（加权平均、MSWD、以及所有判据阈值都是网页版新增的），
 *  免得被当成原程序的结论去引用。
 *
 *  本模块包在 IIFE 里：它只在界面层用，不需要进数值模块那套"平铺脚本 +
 *  顶层重名登记"的机制，包起来最省事。
 * ========================================================================== */
(function () {
  'use strict';

  var Q = window.DS_QC;

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(v, d) { return Q.qcNum(v, d); }

  function badge(level, text) {
    var t = text || ({ ok: '正常', warn: '要注意', bad: '不合格' })[level] || level;
    return '<span class="badge ' + esc(level) + '">' + esc(t) + '</span>';
  }

  /* ======================================================================
   *  参数说明表 —— 报告与界面共用同一份
   *
   *  每一项：参数名 / 这个参数是什么 / 在原程序里叫什么 / 默认值与它的出处。
   *  "出处"这一栏是刻意加的：原程序里有好几个默认值其实**没有可靠出处**
   *  （背景窗口就是），写清楚比装作有来源更负责。
   * ==================================================================== */
  var PARAM_DOC = [
    { key: 'instrument', label: '仪器类型', pyvar: 'ele（0=Thermo / 1=Agilent）',
      what: '决定用哪一套列名与读取规则，也决定样品名从哪里来。',
      src: '原实现按 ele 分派 loaddata 的 mode' },
    { key: 'standard', label: '标样名', pyvar: 'skmethod() 的输入框',
      what: '年龄层据此认出哪些行是标样，用它们算分馏因子。',
      src: '用户输入' },
    { key: 'standardAge', label: '标样年龄', pyvar: 'Standard_age',
      what: '代入 Cal_age() 得到 a/b/c/P382/Q8/R8/S8，其中 P382、Pbc 用于分馏校正。',
      src: '用户输入（实验室给的标样推荐值）' },
    { key: 'fractionationStandard', label: '分馏校正标样', pyvar: 'standard',
      what: '算分馏因子时取均值的那组行。通常与"标样名"相同。',
      src: '用户输入' },
    { key: 'method', label: '普通铅校正方式', pyvar: 'PbCorrS（0–4）',
      what: '0=不校正 / 1=207Pb / 2=208Pb / 3=204Pb / 4=Cal 204Pb。'
        + '决定哪一套普通铅参数参与计算，也决定年龄表后半部分的列含义。',
      src: '用户选择' },
    { key: 'excessV', label: '外挂误差 Ɛ', pyvar: 'var5 → excess_V（= 界面值/100）',
      what: '计数统计之外的额外相对分散，以平方和并进各年龄的相对误差。'
        + '「只影响误差列，不影响年龄值」。',
      src: '桌面版界面标签写作 Ɛ(%)，默认 var5.set(3) → 3%' },
    { key: 'b0', label: '背景窗口起点', pyvar: 'bcg_from',
      what: '取背景计数的起始时间（秒）。',
      src: '「没有可靠出处」—— 桌面版的那个输入框初始是空的，代码里另有 1/5/8 与注释掉的 3/10/8 两组' },
    { key: 'b1', label: '背景窗口终点', pyvar: 'bcg_to',
      what: '取背景计数的结束时间（秒）；与起点之间即为背景段。',
      src: '同上（默认值不确定）' },
    { key: 'multi', label: '信号阈值倍数', pyvar: 'multi',
      what: '自动找信号窗时的判据：净信号超过「背景均值 + multi × 背景标准差」才算信号。',
      src: '桌面版注释掉的默认值是 8' },
    { key: 'algo', label: '年龄层算法', pyvar: 'Age_Calculate_average / Age_Calculate',
      what: '平均法：整批共用一个分馏因子；线性法：用相邻标样插值（SSB），逐点一套因子。',
      src: '用户选择' },
    { key: 'nistStd', label: '微量元素外标', pyvar: 'NIST_STD',
      what: '算 U/Th/Pb 含量用的换算系数所依据的玻璃标样（NIST610/612/614）。'
        + '留空表示不算。',
      src: '用户输入；该名字在整批里出现 0 次或 1 次时，原实现会静默把系数置 0' },
    { key: 'fix76', label: '²⁰⁷Pb/²⁰⁶Pb 年龄迭代', pyvar: 'Age76Pb',
      what: '勾选（默认）= 用收敛判据正常迭代；不勾 = 逐位复现桌面版那个'
        + '「判据失效、固定迭代 10 次」的写法。1.5–2.2 Ga 区间两者最多差约 35 Ma。',
      src: '原实现的收敛判据因一处赋值缺失而失效（见报告末节）' },
    { key: 'ageKey', label: '统计所用年龄', pyvar: '（网页版新增，原程序无此概念）',
      what: '报告里的加权平均、MSWD、标样偏差都基于这一列年龄。'
        + '年轻锆石（≲1.2 Ga）一般看 ²⁰⁶Pb/²³⁸U，老锆石看 ²⁰⁷Pb/²⁰⁶Pb，'
        + '不能混着比。',
      src: '网页版新增的选择项' },
    { key: 'lambda', label: '衰变常数', pyvar: '源码里的字面量',
      what: 'λ₂₃₈=1.55125e-10 /yr、λ₂₃₅=9.8485e-10 /yr、λ₂₃₂=4.9475e-11 /yr，'
        + '²³⁸U/²³⁵U 取 137.818。',
      src: '原实现里是直接写死的数字，没有标注出处' },
    { key: 'sampleFrom', label: '样品名来源', pyvar: 'instructure0 / Sampleslist1',
      what: 'Thermo 读文件第一行冒号之前；Agilent 用文件名第一个点之前去清单里查。'
        + '名字必须与"标样名"完全一致，否则标样会被当成普通样品。',
      src: '两套规则都照抄原实现' },
  ];

  /** 判据阈值的中文说明直接取 qc.js 那一份，保证界面、报告、README 说的是同一件事。 */
  var THRESHOLD_DOC = Q.QC_THRESHOLD_DOC;

  /* ======================================================================
   *  误差棒图（手绘 SVG，不引图表库）
   * ==================================================================== */

  /**
   * @param {Array<{label,mean,err,kind,level}>} items kind: 'std' | 'sample'
   * @param {object} opt {trueAge, maxItems}
   */
  function errorBarSvg(items, opt) {
    opt = opt || {};
    var W = 960;
    var padL = 168, padR = 34, padT = 26, rowH = 23;
    var usable = items.filter(function (it) { return isFinite(it.mean); });
    var dropped = items.length - usable.length;
    var maxItems = opt.maxItems || 70;
    var shown = usable;
    var truncated = 0;
    if (usable.length > maxItems) {
      shown = usable.slice(0, maxItems);
      truncated = usable.length - maxItems;
    }
    if (!shown.length) {
      return '<p class="note">没有可用于绘图的年龄（全部为 NaN）。</p>';
    }
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < shown.length; i++) {
      var e = isFinite(shown[i].err) && shown[i].err > 0 ? shown[i].err : 0;
      lo = Math.min(lo, shown[i].mean - e * 1.3);
      hi = Math.max(hi, shown[i].mean + e * 1.3);
    }
    if (isFinite(opt.trueAge)) { lo = Math.min(lo, opt.trueAge); hi = Math.max(hi, opt.trueAge); }
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    var span = hi - lo;
    lo -= span * 0.05; hi += span * 0.05;
    var H = padT + shown.length * rowH + 40;
    var plotW = W - padL - padR;
    var x = function (v) { return padL + (v - lo) / (hi - lo) * plotW; };

    // 刻度：取一个"好看"的间隔
    var raw = (hi - lo) / 7;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var stepC = [1, 2, 2.5, 5, 10];
    var step = mag;
    for (var k = 0; k < stepC.length; k++) {
      if (stepC[k] * mag >= raw) { step = stepC[k] * mag; break; }
    }
    var out = [];
    out.push('<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" width="' + W
      + '" height="' + H + '" role="img" aria-label="各样品与标样的加权平均年龄及误差">');
    // 网格与刻度
    for (var t = Math.ceil(lo / step) * step; t <= hi; t += step) {
      var px = x(t);
      out.push('<line x1="' + px.toFixed(1) + '" y1="' + padT + '" x2="' + px.toFixed(1)
        + '" y2="' + (H - 30) + '" stroke="#e8ebef"/>');
      out.push('<text x="' + px.toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle"'
        + ' font-size="11" fill="#8a939e">' + t.toFixed(step < 1 ? 1 : 0) + '</text>');
    }
    out.push('<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="'
      + (H - 30) + '" stroke="#c9cfd6"/>');
    // 标样真值竖线
    if (isFinite(opt.trueAge)) {
      var tx = x(opt.trueAge);
      out.push('<line x1="' + tx.toFixed(1) + '" y1="' + (padT - 6) + '" x2="' + tx.toFixed(1)
        + '" y2="' + (H - 30) + '" stroke="#b3261e" stroke-dasharray="4 3"/>');
      out.push('<text x="' + (tx + 4).toFixed(1) + '" y="' + (padT - 9) + '" font-size="11"'
        + ' fill="#b3261e">标样真值 ' + num(opt.trueAge, 0) + ' Ma</text>');
    }
    var colors = { std: '#1d4ed8', sample: '#0f766e' };
    for (var j = 0; j < shown.length; j++) {
      var it = shown[j];
      var y = padT + j * rowH + rowH / 2;
      var c = colors[it.kind] || colors.sample;
      var err = isFinite(it.err) && it.err > 0 ? it.err : 0;
      var x0 = x(it.mean - err), x1 = x(it.mean + err), xm = x(it.mean);
      if (err > 0) {
        out.push('<line x1="' + x0.toFixed(1) + '" y1="' + y + '" x2="' + x1.toFixed(1)
          + '" y2="' + y + '" stroke="' + c + '" stroke-width="1.3"/>');
        out.push('<line x1="' + x0.toFixed(1) + '" y1="' + (y - 4) + '" x2="' + x0.toFixed(1)
          + '" y2="' + (y + 4) + '" stroke="' + c + '"/>');
        out.push('<line x1="' + x1.toFixed(1) + '" y1="' + (y - 4) + '" x2="' + x1.toFixed(1)
          + '" y2="' + (y + 4) + '" stroke="' + c + '"/>');
      }
      out.push('<circle cx="' + xm.toFixed(1) + '" cy="' + y + '" r="3.2" fill="' + c + '"/>');
      var lab = it.label.length > 22 ? it.label.slice(0, 21) + '…' : it.label;
      out.push('<text x="' + (padL - 10) + '" y="' + (y + 4) + '" text-anchor="end"'
        + ' font-size="12" fill="#3c4650">' + esc(lab) + '</text>');
    }
    out.push('<text x="' + padL + '" y="' + (H - 12) + '" text-anchor="end" font-size="11"'
      + ' fill="#8a939e">Ma</text>');
    out.push('</svg>');
    var tail = '';
    if (truncated) tail += '<p class="note">为控制篇幅，只画了前 ' + maxItems + ' 项，'
      + '另有 ' + truncated + ' 项未画（表格里是全的）。</p>';
    if (dropped) tail += '<p class="note">另有 ' + dropped + ' 项的年龄是 NaN，'
      + '画不出来 —— 见下面"异常与警告"。</p>';
    return out.join('') + tail;
  }

  /* ======================================================================
   *  各段落
   * ==================================================================== */

  function sectionParams(p) {
    var rows = PARAM_DOC.map(function (d) {
      var v = p[d.key];
      var shown = (v === undefined || v === null || v === '')
        ? '<span class="dim">（未用）</span>' : esc(v);
      return '<tr><td><b>' + esc(d.label) + '</b>'
        + '<div class="dim">' + esc(d.pyvar) + '</div></td>'
        + '<td class="val">' + shown + '</td>'
        + '<td>' + esc(d.what) + '</td>'
        + '<td class="dim">' + esc(d.src) + '</td></tr>';
    }).join('');
    var extra = '';
    if (p.pbParams) {
      extra = '<p class="note">普通铅参数（本次实际代入的值）：'
        + esc(p.pbParams) + '</p>';
    }
    return '<h2>2 · 这次用的参数（复现这份报告所需的全部选择）</h2>'
      + '<table class="params"><thead><tr><th>参数</th><th>本次取值</th>'
      + '<th>它是什么</th><th>默认值与出处</th></tr></thead><tbody>'
      + rows + '</tbody></table>' + extra;
  }

  /**
   * 判据阈值表。每一项都会标出"这一份报告里它是否偏离了默认值"——
   * 用的是**当前值与默认值直接比较**，不依赖外部传进来的状态。
   */
  function sectionThresholds(th) {
    var rows = THRESHOLD_DOC.map(function (d) {
      var v = th[d.k];
      var shown, changed;
      if (d.k === 'mswdMax') {
        // 0 / 非数字 = 按点数自动；自动就是默认行为，不算改过
        var isAuto = !isFinite(v) || v <= 0;
        shown = isAuto ? '按点数自动' : num(v, 1);
        changed = !isAuto;
      } else {
        shown = num(v, 1) + (d.unit || '');
        changed = Math.abs(v - d.def) > 1e-9;
      }
      return '<tr><td><b>' + esc(d.label) + '</b></td>'
        + '<td class="val">' + esc(shown)
        + (changed ? ' <span class="badge warn">已改</span>' : '') + '</td>'
        + '<td>' + esc(d.what) + '</td>'
        + '<td class="dim">' + esc(d.why) + '<br>默认 ' + esc(String(d.def))
        + esc(d.unit || '') + '</td></tr>';
    }).join('');
    return '<h3>判据阈值</h3>'
      + '<p class="note">下面每个阈值旁边都写了它是什么、为什么取这个数。'
      + '<b>它们都是经验判据，不是原程序的规定</b>，可以在界面上改；'
      + '表里标"已改"的就是这一份报告里偏离默认值的那几项。</p>'
      + '<table class="params"><thead><tr><th>判据</th><th>本次取值</th>'
      + '<th>它衡量什么</th><th>为什么取这个值</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
  }

  /**
   * 判定依据：把 qc.js 给出的 reasons 排成小字列在名字下面。
   *
   * 这一块是"为什么"的必要出口 —— 判据只给红黄绿色块而不给理由，
   * 报告里就会出现「相对偏差 0.0000%」却标着警告这种看着自相矛盾的行
   * （真实数据里就有：标样再现性很好，但内部 MSWD 高达 325）。
   * 没有理由的等级等于没判。
   */
  function reasonList(s) {
    if (!s.reasons || !s.reasons.length) return '';
    var seen = {}, out = [];
    s.reasons.forEach(function (r) {
      if (seen[r.why]) return;                    // 同一条别重复列
      seen[r.why] = 1;
      out.push('<li class="lv-' + esc(r.level) + '">' + esc(r.why) + '</li>');
    });
    return '<ul class="reasons">' + out.join('') + '</ul>';
  }

  function sectionStd(qc) {
    if (!qc.standards.length) {
      return '<h2>3 · 标样 QC</h2><p class="alert bad">整批数据里没有找出任何属于标样的行。'
        + '分馏因子取到的是空集合，本报告中的所有年龄都不可信 —— '
        + '请先核对"标样名"是否与数据里的名字完全一致。</p>';
    }
    var rows = qc.standards.map(function (s) {
      return '<tr class="lv-' + esc(s.level) + '">'
        + '<td><b>' + esc(s.name) + '</b>' + reasonList(s) + '</td>'
        + '<td class="val">' + num(s.trueAge, 1) + '</td>'
        + '<td class="val"><b>' + num(s.mean, 1) + '</b> ± ' + num(s.se, 1) + '</td>'
        + '<td class="val">± ' + num(s.seExt, 1) + '</td>'
        + '<td class="val">' + (isFinite(s.dev) ? (s.dev >= 0 ? '+' : '') + num(s.dev, 1) : '—') + '</td>'
        + '<td class="val"><b>' + (isFinite(s.devPct) ? (s.devPct >= 0 ? '+' : '') + num(s.devPct, 2) : '—') + '%</b></td>'
        + '<td class="val">' + s.used + ' / ' + s.n + '</td>'
        + '<td class="val">' + (isFinite(s.mswd) ? num(s.mswd, 2) : '—')
        + ' <span class="dim">/ ' + (isFinite(s.mswdLimit) ? num(s.mswdLimit, 2) : '∞') + '</span></td>'
        + '<td>' + badge(s.level) + '</td></tr>';
    }).join('');
    return '<h2>3 · 标样 QC（这批数据能不能用，主要看这一块）</h2>'
      + '<table><thead><tr><th>标样</th><th>真值<br>Ma</th><th>测出（加权平均）<br>Ma</th>'
      + '<th>外部误差<br>Ma</th><th>偏差<br>Ma</th><th>相对偏差</th><th>参与点数</th>'
      + '<th>MSWD<br><span class="dim">/ 判据上限</span></th><th>判定</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '<p class="note">"测出"是把该标样的所有测点按 1/σ² 加权平均得到的；'
      + '紧跟的 ± 是<b>内部误差</b>（标准误，= 1/√Σw），下一列是<b>外部误差</b>'
      + '（MSWD&gt;1 时乘了 √MSWD，更保守，报数一般用这个）。'
      + '<b>加权平均、MSWD、以及这里的判定都是网页版新增的</b> —— '
      + '桌面版 Isoclock 只输出逐点年龄，不做归组统计。</p>';
  }

  function sectionSamples(qc) {
    // 标样单独在第 3 节列，这一节只放普通样品
    var stdNames = {};
    qc.standards.forEach(function (t) { stdNames[t.name] = true; });
    var ss = qc.stats.filter(function (s) { return !stdNames[s.name]; });
    if (!ss.length) return '<h2>4 · 样品结果汇总</h2><p class="note">除了标样以外没有其它样品。</p>';
    var sorted = ss.slice().sort(function (a, b) {
      var x = isFinite(a.mean) ? a.mean : Infinity;
      var y = isFinite(b.mean) ? b.mean : Infinity;
      return x - y;
    });
    var rows = sorted.map(function (s) {
      var files = s.outliers.length
        ? '<div class="dim">离群候选：' + esc(s.outliers.join('、')) + '</div>' : '';
      return '<tr class="lv-' + esc(s.level) + '">'
        + '<td><b>' + esc(s.name) + '</b>' + reasonList(s) + files + '</td>'
        + '<td class="val">' + s.used + ' / ' + s.n + '</td>'
        + '<td class="val"><b>' + num(s.mean, 1) + '</b></td>'
        + '<td class="val">± ' + num(s.se, 1) + '</td>'
        + '<td class="val">± ' + num(s.seExt, 1) + '</td>'
        + '<td class="val">' + (isFinite(s.mswd) ? num(s.mswd, 2) : '—')
        + ' <span class="dim">/ ' + (isFinite(s.mswdLimit) ? num(s.mswdLimit, 2) : '∞') + '</span></td>'
        + '<td class="val">' + num(s.relMax, 1) + '%</td>'
        + '<td>' + badge(s.level) + '</td></tr>';
    }).join('');
    var chartItems = qc.standards.map(function (s) {
      return { label: s.name + '（标样）', mean: s.mean, err: s.seExt,
        kind: 'std', level: s.level };
    }).concat(sorted.map(function (s) {
      return { label: s.name, mean: s.mean, err: s.seExt,
        kind: 'sample', level: s.level };
    }));
    return '<h2>4 · 样品结果汇总</h2>'
      + '<table><thead><tr><th>样品</th><th>有效点/总点</th><th>加权平均<br>Ma</th>'
      + '<th>内部误差<br>Ma</th><th>外部误差<br>Ma</th>'
      + '<th>MSWD<br><span class="dim">/ 判据上限</span></th>'
      + '<th>最大单点<br>2s 相对</th><th>判定</th></tr></thead><tbody>'
      + rows + '</tbody></table>'
      + '<p class="note">按加权平均年龄升序排列。判定的含义：'
      + badge('ok') + ' 各项都在判据内；' + badge('warn')
      + ' 有过散、离群候选或相对误差偏大的点，建议逐个看信号图；'
      + badge('bad') + ' 一个有效点都没有，这个样品算不出来。'
      + '<b>离群候选只做提示，不会自动剔除</b> —— 删不删要结合铅丢失、包裹体、'
      + '信号图判断，报告不替你做这个决定。</p>'
      + '<h3>加权平均年龄（误差棒为外部误差）</h3>'
      + errorBarSvg(chartItems, { trueAge: qc.standards.length ? qc.standards[0].trueAge : NaN })
      + '<p class="note">蓝点为标样，青点为样品，红色虚线是标样真值。'
      + '数据点少或用的是未校正年龄时，这里的"加权平均"离真实年龄可能很远，'
      + '看数值不要只看图。</p>';
  }

  function sectionAnomalies(qc) {
    if (!qc.anomalies.length) {
      return '<h2>5 · 异常与警告</h2><p class="note">没有发现需要提醒的问题。</p>';
    }
    var order = { bad: 0, warn: 1, ok: 2 };
    var list = qc.anomalies.slice().sort(function (a, b) {
      return order[a.level] - order[b.level];
    });
    var li = list.map(function (a) {
      return '<li class="lv-' + esc(a.level) + '">' + badge(a.level) + ' '
        + '<b>' + esc(a.kind) + '</b>：' + esc(a.text)
        + (a.files && a.files.length
          ? '<div class="files">涉及文件：' + esc(a.files.join('、'))
            + (a.files.length >= 8 ? ' …' : '') + '</div>' : '')
        + '</li>';
    }).join('');
    return '<h2>5 · 异常与警告</h2><ul class="anom">' + li + '</ul>';
  }

  function sectionLimits(info) {
    return '<h2>7 · 这份报告不做什么，以及已知的口径问题</h2>'
      + '<ul class="limits">'
      + '<li><b>这份报告里不含谐和图</b>：报告要能离线双击打开，'
      + '所以不带任何 R 运行时，也不联网。谐和图与普通铅投影请到软件的'
      + '「IsoplotR 谐和图」标签页去做 —— 那一页的图和数是 <b>IsoplotR</b>'
      + '（Pieter Vermeesch 的 R 包）算的，首次使用要从 CDN 现装约 16 MB，'
      + '需要联网；装好后浏览器会缓存。它与桌面版 Isoclock 是两套独立实现，'
      + '两者的年龄口径不同（见该页的并排对照），不要直接互证。</li>'
      + '<li><b>不做普通铅的逐点诊断图</b>（如 <code>²⁰⁶Pb/²⁰⁴Pb</code> 对'
      + '<code>²⁰⁷Pb/²⁰⁶Pb</code> 的相关图）。上面那张谐和图上可以用'
      + '「普通铅」下拉切换投影方式，但那是图上的投影，<b>不改任何年龄数值</b>。</li>'
      + '<li><b>不自动剔除任何测点</b>。离群候选只列出来，删不删由你决定。</li>'
      + '<li><b>加权平均、MSWD、判据阈值都是网页版新增的</b>，'
      + '不是桌面版 Isoclock 的输出。原程序只输出逐点年龄，从不做归组统计。'
      + '引用时请区别对待。</li>'
      + '<li><b>外挂误差 Ɛ 的口径不齐</b>：它以平方和并进各年龄的相对误差'
      + '（只改误差、不改年龄），但内部相对误差用的是比值的 <code>2s</code>（2σ），'
      + 'Ɛ 直接与它相加 —— 严格说混了置信水平；另外 <code>²⁰⁷Pb/²⁰⁶Pb</code> 年龄的'
      + '误差<b>不含</b> Ɛ，同一行四个年龄的误差口径并不一致。'
      + '还有：Ɛ 调大会让 MSWD 变小，<b>不能用调 Ɛ 的办法去"改善"一致性</b>。</li>'
      + '<li><b>年龄表的表头有两处沿自原实现的错位</b>：第 17 列表头写着 '
      + '<code>Age</code> 但数据是分隔线；第 26 列表头写着 '
      + '<code>…Corr. Age(Ma)</code> 但数据是备注。校正后的年龄实际在第 27 / 29 列。'
      + '本报告按实际列位置取数。</li>'
      + '<li><b>²⁰⁷Pb/²⁰⁶Pb 年龄迭代</b>：'
      + esc(info.fix76Text) + '</li>'
      + (info.extraLimits || '')
      + '</ul>';
  }

  /* ======================================================================
   *  组装
   * ==================================================================== */

  var CSS = [
    '*{box-sizing:border-box}',
    'body{margin:0;padding:28px 20px 72px;background:#eef1f4;color:#1c2024;',
    'font:14px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",Roboto,sans-serif;',
    '-webkit-font-smoothing:antialiased}',
    '.page{max-width:1060px;margin:0 auto;background:#fff;padding:38px 44px 52px;',
    'box-shadow:0 1px 4px rgba(20,30,45,.10);border-radius:3px}',
    'h1{font-size:23px;margin:0 0 4px;letter-spacing:.2px}',
    'h2{font-size:17px;margin:36px 0 10px;padding-bottom:7px;border-bottom:2px solid #e3e7ec}',
    'h3{font-size:14.5px;margin:22px 0 8px;color:#2a3038}',
    '.sub{color:#6b7480;font-size:12.5px;margin:0 0 2px}',
    '.verdict{margin:18px 0 6px;padding:15px 18px;border-radius:4px;border-left:5px solid #999;',
    'background:#f6f7f9}',
    '.verdict.ok{border-color:#0a7a37;background:#f1f9f3}',
    '.verdict.warn{border-color:#c07a00;background:#fdf8ef}',
    '.verdict.bad{border-color:#b3261e;background:#fdf2f1}',
    '.verdict .big{font-size:16px;font-weight:600;display:block;margin-bottom:4px}',
    '.verdictwhy{margin-top:7px;font-size:12.5px;color:#4a535c;line-height:1.6;',
    'border-top:1px dashed rgba(0,0,0,.12);padding-top:6px}',
    'table{border-collapse:collapse;width:100%;font-size:12.5px;margin:8px 0 4px}',
    'th,td{border:1px solid #dde2e8;padding:6px 9px;text-align:left;vertical-align:top}',
    'th{background:#f3f5f8;font-weight:600;font-size:12px;color:#39414a}',
    'tbody tr:nth-child(even){background:#fafbfc}',
    'td.val{text-align:right;white-space:nowrap;',
    'font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px}',
    'table.params,table.over{table-layout:fixed}',
    //  固定列宽 + 允许换行。不这么做的话：λ 那一行的值是 nowrap 的长串，
    //  自动布局会把第 2 列撑到半屏，第 4 列（出处那一栏）被挤成每行一两个字。
    'table.params th:nth-child(1),table.params td:nth-child(1){width:19%}',
    'table.params th:nth-child(2),table.params td:nth-child(2){width:20%;',
    'font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px;',
    'text-align:right;white-space:normal;word-break:break-word}',
    'table.params th:nth-child(3),table.params td:nth-child(3){width:27%}',
    'table.params th:nth-child(4),table.params td:nth-child(4){width:34%}',
    'table.params td,table.over td{overflow-wrap:break-word;word-break:break-word}',
    //  概况表是"标签/值/标签/值"两对，四列等宽更好看
    'table.over th,table.over td{width:25%}',
    'tr.lv-ok td:first-child{border-left:3px solid #0a7a37}',
    'tr.lv-warn td:first-child{border-left:3px solid #c07a00}',
    'tr.lv-bad td:first-child{border-left:3px solid #b3261e}',
    '.badge{display:inline-block;padding:0 7px;border-radius:9px;font-size:11.5px;',
    'line-height:17px;white-space:nowrap}',
    '.badge.ok{background:#e3f5e9;color:#0a7a37}',
    '.badge.warn{background:#fdf1dd;color:#a86400}',
    '.badge.bad{background:#fbe6e4;color:#b3261e}',
    '.lv-ok{color:#0a7a37}.lv-warn{color:#a86400}.lv-bad{color:#b3261e}',
    'ul.reasons{list-style:none;padding:0;margin:5px 0 0;max-width:430px}',
    'ul.reasons li{font-size:11.5px;line-height:1.55;padding-left:11px;position:relative;',
    'margin-top:3px;color:#5b646e}',
    'ul.reasons li:before{content:"·";position:absolute;left:1px;color:#9aa3ad}',
    'ul.reasons li.lv-warn{color:#8a5a00}',
    'ul.reasons li.lv-bad{color:#b3261e}',
    '.dim{color:#8a939e;font-size:11.5px;line-height:1.5}',
    '.note{color:#5b646e;font-size:12.5px;margin:8px 0}',
    '.alert{padding:11px 14px;border-radius:4px;font-size:13px}',
    '.alert.bad{background:#fdf2f1;border-left:4px solid #b3261e}',
    '.demonote{margin:14px 0 0;line-height:1.7}',
    '.demonote b{color:#8c1d18}',
    'ul.anom,ul.limits{padding-left:0;list-style:none;margin:8px 0}',
    'ul.anom li{padding:9px 12px;margin:7px 0;background:#fafbfc;border-radius:4px;',
    'border-left:3px solid #c9cfd6;font-size:13px}',
    'ul.anom li.lv-bad{border-left-color:#b3261e;background:#fdf3f2}',
    'ul.anom li.lv-warn{border-left-color:#c07a00;background:#fdfaf3}',
    '.files{color:#6b7480;font-size:11.5px;margin-top:3px;word-break:break-all}',
    'ul.limits li{margin:7px 0;padding-left:15px;position:relative;font-size:13px}',
    'ul.limits li:before{content:"·";position:absolute;left:2px;color:#8a939e}',
    'svg.chart{max-width:100%;height:auto;display:block;margin:10px 0 4px;',
    'border:1px solid #e3e7ec;border-radius:4px;background:#fff}',
    'code{background:#f2f4f7;padding:1px 5px;border-radius:3px;font-size:12px;',
    'font-family:ui-monospace,Consolas,monospace}',
    '.foot{margin-top:40px;padding-top:14px;border-top:1px solid #e3e7ec;',
    'color:#8a939e;font-size:11.5px;line-height:1.9}',
    '@media print{body{background:#fff;padding:0}.page{box-shadow:none;padding:0;',
    'max-width:none;border-radius:0}h2{page-break-after:avoid}',
    'table,svg.chart{page-break-inside:avoid}}',
  ].join('');

  /**
   * 生成报告 HTML。
   *
   * @param {object} R
   *   title       标题
   *   generatedAt 'YYYY-MM-DD HH:MM:SS'
   *   build       window.__build（可为 null）
   *   files       文件数
   *   fileList    文件名数组
   *   sampleList  样品名清单的描述（可为 null）
   *   params      见 PARAM_DOC 的 key
   *   qc          qcAnalyze() 的结果
   *   fix76Text   207Pb/206Pb 迭代那一条的说明
   */
  function buildReportHtml(R) {
    var qc = R.qc;
    var s = qc.summary;

    /* ---- 一句话结论 ---- */
    var headline, detail;
    if (s.level === 'bad') {
      headline = '这批数据有问题，先别用这些年龄。';
    } else if (s.level === 'warn') {
      headline = '结果基本可用，但有若干处需要注意。';
    } else {
      headline = '没有发现需要提醒的问题。';
    }
    var parts = [];
    if (qc.standards.length) {
      var st = qc.standards[0];
      parts.push('标样「' + st.name + '」测出 ' + num(st.mean, 1) + ' ± ' + num(st.seExt, 1)
        + ' Ma（真值 ' + num(st.trueAge, 1) + ' Ma，相对偏差 '
        + (isFinite(st.devPct) ? (st.devPct >= 0 ? '+' : '') + num(st.devPct, 2) + '%' : '—')
        + '，MSWD ' + (isFinite(st.mswd) ? num(st.mswd, 2) : '—') + '）');
    } else {
      parts.push('没有找到标样行');
    }
    parts.push('样品 ' + s.nSamples + ' 个，有效测点 ' + s.nUsed + ' / ' + s.nRows);
    if (s.nBadAnomalies || s.nWarnAnomalies) {
      parts.push('异常 ' + s.nBadAnomalies + ' 条，警告 ' + s.nWarnAnomalies + ' 条');
    } else {
      parts.push('没有异常');
    }
    detail = parts.join('；') + '。';

    /* 标样判了 warn/bad 时，把第一条"为什么"直接搬进结论 ——
     * 看报告的人第一眼就会问"差在哪"，不该让人自己去表里翻。
     * （真实数据里标样偏差可以是 0.00%，但 MSWD 高达 325，
     *   只看结论那一行的偏差数字会以为没事。） */
    var whyFirst = '';
    if (qc.standards.length && qc.standards[0].level !== 'ok'
        && qc.standards[0].reasons.length) {
      whyFirst = '<div class="verdictwhy">标样被判「'
        + (qc.standards[0].level === 'bad' ? '不合格' : '要注意') + '」的原因：'
        + esc(qc.standards[0].reasons[0].why) + '</div>';
    }

    /* ---- 内置示例数据的免责声明 ----
     * 示例数据是合成出来的：各通道计数按人为规则拼，通道权重逐通道不同，
     * 所以比值之间**不满足 U-Pb 体系关系**。它跑出来的偏差与 MSWD 必然难看。
     * 不写这一句，点"载入示例数据 → 质量报告"的人会以为程序坏了，
     * 或者更糟——把这些数字当成一批真实数据的结果读走。 */
    var demoNote = R.demo === 'real'
      ? '<div class="alert demonote"><b>本次用的是内置的真实锡石数据'
        + '（' + esc(R.files) + ' 个 Thermo iCAP Qtegra 导出）。</b>'
        + '脱敏处理：样品代号按出现顺序重编号成 S-01…，每个文件第 1 行的采集时间戳'
        + '归零，文件名改成 sample_NN.csv；<b>数值一个字节都没有改</b>。'
        + '12 行仪器元信息原样保留 —— 那是方法信息，不是身份信息。'
        + '标样名保留原名。<br>'
        + '下面这份报告里的数字是<b>真数据算出来的</b>，不是演示用的假数字。'
        + '但它只是对你手上这批数据的质量描述，'
        + '<b>不构成对任何矿床的年龄结论</b>。</div>'
      : R.demo
      ? '<div class="alert bad demonote"><b>本次用的是内置示例合成数据，不是真实样品。</b>'
        + '各通道计数是按人为规则拼出来的，比值之间不满足 U-Pb 体系关系，'
        + '所以下面的标样偏差、MSWD 与颜色判定只用来演示报告的版面与算法，'
        + '<b>不对应任何真实批次的质量，不能当结果引用</b>。'
        + '要评估真实数据，请把仪器导出的 CSV 拖进界面再出一次报告。</div>'
      : '';

    var verdict = '<div class="verdict ' + esc(s.level) + '">'
      + '<span class="big">' + esc(headline) + '</span>' + esc(detail) + whyFirst + '</div>';

    /* ---- 概要卡 ---- */
    var meta = '<p class="sub">生成于 ' + esc(R.generatedAt)
      + '　·　数据文件 ' + esc(R.files) + ' 个'
      + (R.build ? '　·　构建于 ' + esc(R.build.built) : '')
      + (R.build && R.build.id ? '　·　源码指纹 ' + esc(R.build.id) : '')
      + '</p>';

    var filesBlock = '<details class="filesbox"><summary>参与计算的文件（'
      + (R.fileList || []).length + ' 个）</summary><div class="dim">'
      + esc((R.fileList || []).join('、')) + '</div>'
      + (R.sampleList ? '<div class="dim">样品名清单：' + esc(R.sampleList) + '</div>' : '')
      + '</details>';

    var html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + esc(R.title) + '</title>\n<style>' + CSS
      + '.filesbox{margin:10px 0 0;font-size:12.5px}'
      + '.filesbox summary{cursor:pointer;color:#5b646e}'
      + '</style>\n</head>\n<body>\n<div class="page">\n'
      + '<h1>' + esc(R.title) + '</h1>\n'
      + '<p class="sub">Isoclock 网页版 · 批次质量报告</p>\n'
      + meta
      + demoNote
      + verdict
      + filesBlock
      + '<h2>1 · 概况</h2>'
      + '<table class="params over"><tbody>'
      + '<tr><td>仪器</td><td class="val">' + esc(R.params.instrument) + '</td>'
      + '<td>数据文件</td><td class="val">' + esc(R.files) + ' 个</td></tr>'
      + '<tr><td>年龄层算法</td><td class="val">' + esc(R.params.algo) + '</td>'
      + '<td>统计所用年龄</td><td class="val">' + esc(R.params.ageKey) + '</td></tr>'
      + '<tr><td>普通铅校正</td><td class="val">' + esc(R.params.method) + '</td>'
      + '<td>有效测点</td><td class="val">' + s.nUsed + ' / ' + s.nRows + '</td></tr>'
      + '</tbody></table>'
      + (qc.layout.notes && qc.layout.notes.length
        ? '<p class="note">' + qc.layout.notes.map(esc).join('<br>') + '</p>' : '')
      + sectionParams(R.params)
      + sectionStd(qc)
      + sectionSamples(qc)
      + sectionAnomalies(qc)
      + '<h2>6 · 判据</h2>'
      + '<p class="note">报告里的"正常 / 要注意 / 不合格"是按下面这些判据打的标。'
      + '这部分是网页版做的判断，<b>不是原程序的结论</b>，改阈值会改变颜色。</p>'
      + sectionThresholds(qc.thresholds)
      + sectionLimits(R)
      + '<div class="foot">'
      + '本报告由 Isoclock 网页版生成，完全离线：文件不出本机、不联网、不上传。'
      + (R.build ? '<br>构建时间 ' + esc(R.build.built)
        + (R.build.id ? '　源码指纹 ' + esc(R.build.id) : '') : '')
      + '<br>同一份源码每次构建得到字节相同的文件，所以源码指纹对上就是同一版。'
      //  收尾的两个闭合标签故意拆开写：整段的 "</" + "body>" 一旦原样出现在
      //  打包后的单文件里，任何"把注入脚本插到最后一个 </body> 之前"的工具
      //  都会插错地方（已经踩过一次：截图脚本注进了这个字符串里，
      //  后半截报告源码就被当成正文显示出来了）。拆开写等于给对方一个锚点。
      + '</div>\n</div>\n</' + 'body>\n</' + 'html>\n';
    return html;
  }

  window.DS_QCREPORT = {
    PARAM_DOC: PARAM_DOC,
    THRESHOLD_DOC: THRESHOLD_DOC,
    errorBarSvg: errorBarSvg,
    buildReportHtml: buildReportHtml,
  };
}());
