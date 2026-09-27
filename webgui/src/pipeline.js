/* ==========================================================================
 *  pipeline.js —— Thermo 数据的端到端流程
 *
 *  串起四步，与桌面版一一对应：
 *      thermoLoad()           <- loaddata() 的 Thermo 分支
 *      detectSignalWindow()   <- instructure0 里的窗口自动识别
 *      切背景 / 信号段 + 均值  <- dataprocess() 的 _load_channels / _mean_cps_row
 *      reduceSample()         <- dataprocess() 的还原与出表
 *
 *  依赖的模块通过 attach() 注入，便于在 Node 下按顺序加载、也便于单独测试。
 * ========================================================================== */
'use strict';

const P = {};                                  // 注入的依赖
function attach(mods) { Object.assign(P, mods); }

/** Python 的 arr[start:stop]（负索引、越界钳制、空切片）。 */
function pySlice(arr, start, stop) {
  const len = arr.length;
  let s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let e = stop < 0 ? Math.max(len + stop, 0) : Math.min(stop, len);
  if (e < s) e = s;
  const out = new Float64Array(e - s);
  for (let i = s; i < e; i++) out[i - s] = arr[i];
  return out;
}

/** Python 的 int()：向零截断。 */
function pyInt(v) {
  if (!Number.isFinite(v)) throw new Error('cannot convert ' + v + ' to int');
  return Math.trunc(v);
}

const CHANNEL_SUFFIX = [
  ['Hg202', 'y1'], ['Hg204', 'y2'], ['Pb206', 'y3'], ['Pb207', 'y4'],
  ['Pb208', 'y5'], ['Th232', 'y6'], ['U238', 'y7'],
];

/* ==========================================================================
 *  样品名
 *
 *  两套仪器在桌面版里取样品名的方式**不一样**：
 *      Thermo（instructure0）：读文件**第一行**，取第 0 个字段、按 ':' 切开取前段。
 *      Agilent（instructure1）：**不读文件**，拿"文件名去扩展名"去一份外部
 *                                Excel 清单里查 —— 原实现是
 *                                    sampleslist[name] = Sampleslist1[name.split('.')[0]]
 *                                那份清单由用户在打开数据前用对话框选（askopenfilename）。
 *
 *  网页版没有那个 Excel，改成一份两列 CSV/TSV（parseSampleList）。清单里查不到的
 *  文件要兜底，而两台仪器的兜底**不能共用一条规则**：
 *      Thermo  的第一行本来就是样品名（"91500: note"），照读即可；
 *      Agilent 的前几行是仪器元信息（"Agilent 7500  meta line 1"…），**每个文件都
 *              一模一样**，拿它当样品名会把所有文件塌成同一个样品、年龄表悄悄并成一行。
 *              所以 Agilent 退回用"文件名第一个点之前"——这也正是桌面版清单的键规则。
 *  返回值里标出名字是从哪来的（'list' / 'head' / 'file'），好让界面提示。
 * ========================================================================== */

/**
 * 清单查找用的键，对应 Python 的 `name.split('.')[0]`。
 *
 * **注意**这是"第一个点之前"，不是"去掉最后一个扩展名"：
 * `MAD.NEW.1.csv` 的键是 `MAD`，不是 `MAD.NEW.1`。原实现如此，照抄 ——
 * 清单第一列该填什么，以这个规则为准。
 */
function listKey(fileName) {
  const i = fileName.indexOf('.');
  return i >= 0 ? fileName.slice(0, i) : fileName;
}

/**
 * 解析样品名清单：两列，第一列是 listKey（文件名 key），第二列是样品名。
 *
 * 分隔符在逗号与制表符之间自动选（看第一行哪个多），接受 UTF-8 BOM。
 * **不跳过表头** —— 原实现是从第 0 行开始全表入映射；真带了表头也无害，
 * 那两行的键匹配不到任何文件。
 *
 * @returns {Object<string,string>} {listKey: 样品名}
 */
function parseSampleList(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = {};
  // 分隔符判定：只看第一条非空行
  let delim = ',';
  for (const l of lines) {
    if (!l.trim()) continue;
    const c = (l.match(/,/g) || []).length;
    const t = (l.match(/\t/g) || []).length;
    delim = t > c ? '\t' : ',';
    break;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = splitDelimited(line, delim);
    const key = (cells[0] || '').trim();
    if (!key) continue;
    out[key] = (cells[1] === undefined ? '' : cells[1]).trim();
  }
  return out;
}

/** 按分隔符切一行，处理双引号包裹（"a,b",c 这类）。 */
function splitDelimited(line, delim) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else { quoted = false; }
      } else { cur += ch; }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      cells.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * 取一个文件的样品名。
 *
 * @param {string} fileName
 * @param {string} text       文件原文（Thermo 读第一行用）
 * @param {Object} sampleNames  清单映射，可为 null
 * @param {string} [instrument] 'agilent' 时兜底取文件名，否则读第一行
 * @returns {{name: string, from: 'list'|'head'|'file'}}
 */
function sampleNameFor(fileName, text, sampleNames, instrument) {
  if (sampleNames) {
    const k = listKey(fileName);
    if (Object.prototype.hasOwnProperty.call(sampleNames, k)) {
      return { name: sampleNames[k], from: 'list' };
    }
  }
  // Agilent 的头部是仪器元信息，同名于所有文件，不能当样品名（见文件头注释）
  if (instrument === 'agilent') {
    return { name: listKey(fileName), from: 'file' };
  }
  return { name: P.thermoSampleName(text), from: 'head' };
}

/**
 * 第一步：把一批 Thermo CSV 读进来，并算出各自的积分窗口。
 *
 * @param {Array<{file:string,text:string}>} files  顺序即处理顺序
 *        （桌面版用的是 os.listdir 的顺序，不保证稳定，见 README 说明）
 * @param {object} opt  {isoname, b0, b1, multi}
 * @returns {{perFile: object, order: string[], sampleslist: object}}
 */
function loadThermoFiles(files, opt) {
  const isoname = opt.isoname;
  const perFile = {};
  const order = [];
  const sampleslist = {};
  const sampleFrom = {};                       // file -> 'list' | 'head' | 'file'
  for (const f of files) {
    // 仪器选择：默认 Thermo；opt.instrument === 'agilent' 走 Agilent 读取
    // （isoname 也由调用方换成 Agilent 那套：['时间 [s]','202','204',…]）
    const load = opt.instrument === 'agilent' ? P.agilentLoad : P.thermoLoad;
    const ch = load(f.text, isoname);                  // {x,y1..y7}
    const n = ch.x.length;
    // Timeinternal 由数据本身推出：末点减首点再除以点数（与原实现一致）
    const timeinternal = (ch.x[n - 1] - ch.x[0]) / n;
    const channels = [ch.y1, ch.y2, ch.y3, ch.y4, ch.y5, ch.y6, ch.y7];
    const win = P.detectSignalWindow({
      n, channels, b0: opt.b0, b1: opt.b1,
      timeinternal, multi: opt.multi,
    });
    const sn = sampleNameFor(f.file, f.text, opt.sampleNames, opt.instrument);
    perFile[f.file] = {
      ch, channels, n, timeinternal, num: win.num, sample: sn.name,
      notes: ch.notes || [],
    };
    order.push(f.file);
    sampleslist[f.file] = sn.name;
    sampleFrom[f.file] = sn.from;
  }
  return { perFile, order, sampleslist, sampleFrom };
}

/**
 * 第二步：按窗口切出背景段 / 信号段（对应 dataprocess 的 _load_channels）。
 *
 * tiOverride 传入的是**全局** Timeinternal —— 原实现里 Timeinternal 是模块级全局，
 * instructure0 每个文件都会覆盖它，于是 dataprocess 里所有样品都用**最后一个文件**
 * 的值。同一批数据驻留时间通常相同，所以看不出来；但行为确实如此，这里照抄。
 */
function sliceChannels(perFile, file, tiOverride) {
  const e = perFile[file];
  const ti = (tiOverride === undefined) ? e.timeinternal : tiOverride;
  // num = [Numbers, b0, b1, s0, s1]
  const b0 = e.num[1], b1 = e.num[2], s0 = e.num[3], s1 = e.num[4];
  const sb = pyInt(b0 / ti), eb = pyInt(b1 / ti);
  const ss = pyInt(s0 / ti), es = pyInt(s1 / ti);
  const out = {};
  for (const [key, suffix] of CHANNEL_SUFFIX) {
    const v = e.ch[suffix];
    out[key + '_b'] = pySlice(v, sb, eb);
    out[key + '_s'] = pySlice(v, ss, es);
  }
  return out;
}

/** 对应 _mean_cps_row()：背景 7 个通道均值 + 信号 7 个通道均值。 */
function meanCpsRow(file, sig, sampleslist) {
  const row = [file, sampleslist[file]];
  for (const phase of ['_b', '_s']) {
    for (const [key] of CHANNEL_SUFFIX) row.push(P.nmean(sig[key + phase]));
  }
  return row;
}

/**
 * 第三步：跑完整条链，产出两个 CSV 的文本。
 *
 * @param {object} cfg
 *   files          [{file,text}]，顺序即处理顺序
 *   isoname        Thermo 列名
 *   b0, b1, multi  背景窗口（秒）与阈值倍数
 *   stdcor         0 = 标样做 Pb 校正
 *   method         Pb207Corr 的值：0=207Pb / 1=Cal204Pb / 2=208Pb / 3=204Pb
 *   standardNames  标样名集合（对应 Standard_names）
 *   ctx            {Q8,R8,S8,P382,Pbc,Standard_age}
 *   eleIndex       对应 ele.get()
 */
function run(cfg) {
  const loaded = loadThermoFiles(cfg.files, cfg);
  const { perFile, order, sampleslist } = loaded;

  // dataprocess() 开头的窗口自检 —— 注意它会**就地改写** s0/s1。
  // 第一个条件只把样品名记进 wrong_samples（原实现里这个列表也没被用到）；
  // 第二个条件把 s0/s1 都设成原来的 s1。这会影响后面的切片，必须照抄。
  for (const file of order) {
    const m = perFile[file].num;
    if (m[3] - m[2] < 0 || m[4] - m[2] < 0) {
      // 对应 wrong_samples.append(name)：原实现只记录、不处理
    } else if (m[3] + 1 > m[4] - 1) {
      m[3] = m[4];
      m[4] = m[3];
    }
  }

  // Timeinternal 是全局量，最后一个文件的值覆盖前面所有 —— 照抄
  const tiGlobal = order.length ? perFile[order[order.length - 1]].timeinternal : 0;

  const METHOD_BY_ID = { 0: 'std207', 1: 'std_cal204', 2: 'std208', 3: 'std204' };
  const method = METHOD_BY_ID[cfg.method];
  if (!method) throw new Error('未知的 Pb 校正方式: ' + cfg.method);

  const stdSet = cfg.standardNames || {};
  const isStd = (name) => Object.prototype.hasOwnProperty.call(stdSet, sampleslist[name]);

  const meanRows = [];
  const outStd = [];
  const outSamples = [];

  for (const file of order) {
    const sig = sliceChannels(perFile, file, tiGlobal);
    meanRows.push(meanCpsRow(file, sig, sampleslist));
    if (cfg.stdcor === 0 && isStd(file)) {
      outStd.push(P.reduceSample(file, sig, method, cfg.ctx,
        { eleIndex: cfg.eleIndex, samplesMap: sampleslist }));
    } else {
      outSamples.push(P.reduceSample(file, sig, 'sample', cfg.ctx,
        { eleIndex: cfg.eleIndex, samplesMap: sampleslist }));
    }
  }

  // 对应 result_outstd.extend(result_outsamples); sort(key=lambda x: x[0])
  // 稳定排序；Python 里这一列可能是 int（ele==0）也可能是文件名（字符串），
  // 拆掉 int 标记后再比，两种情况都与 Python 的排序一致。
  const all = outStd.concat(outSamples);
  const key = (v) => (P.untagInt ? P.untagInt(v) : v);
  all.sort((a, b) => {
    const x = key(a[0]), y = key(b[0]);
    return x < y ? -1 : (x > y ? 1 : 0);
  });

  return {
    sampleslist,
    sampleFrom: loaded.sampleFrom,
    num: (() => { const m = {}; for (const f of order) m[f] = perFile[f].num; return m; })(),
    meanCpsCsv: P.buildMeanCpsCsv(meanRows),
    resultAllCsv: P.buildResultAllCsv(all),
    meanRows, resultRows: all,
  };
}

const DS_PIPELINE = { attach, pySlice, pyInt, CHANNEL_SUFFIX, loadThermoFiles,
  sliceChannels, meanCpsRow, run,
  listKey, parseSampleList, sampleNameFor };
if (typeof window !== 'undefined') {
  window.DS_PIPELINE = DS_PIPELINE;
  Object.assign(window.DS = window.DS || {}, DS_PIPELINE);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_PIPELINE;
