# Isoclock 网页版 · 程序接口（`window.DS_API`）

给**程序**用的入口。界面（`ui/app.js`）点"开始计算"走的就是这里的
`DS_API.compute()` —— 不是另写一条并行的实现，所以"接口算出来的"和
"界面上看到的"是同一串数字（页面内自检里有一条专门钉这件事：拿同一批文件
比 51 列，逐位相同）。

三层用途：

| 谁 | 怎么调 | 场景 |
|---|---|---|
| 智能体 / 自动化脚本 | 无头浏览器 + CDP，等 `window.__apiReady` | 让 LLM 直接跑一批数据、拿结构化结果 |
| 浏览器控制台 / 扩展 | 直接 `window.DS_API.run(...)` | 手工试、二次开发 |
| Node（服务端） | `vm` 里加载 `src/*.js` + `ui/api.js`，见 `test_api.js` | 批处理、CI、做后端服务 |

**它不做什么**：不联网、不写本地存储、不碰 DOM。数据不出本机。

---

## 1. 最短的用法

```js
// 一条命令跑通内置的真实示例（49 个锡石 U-Pb 文件）
const r = await window.DS_API.runDemo();
r.ok            // true
r.rowCount      // 49
r.rows[0]       // { file, sample, AGE68, AGE68_2s, AGE75, …, rho, U_ppm, … }
r.quality.summary.level   // 'warn' | 'ok' | 'bad'
```

用**自己的数据**：

```js
const files = [
  { file: 'run01.csv', text: csvText1 },
  { file: 'run02.csv', text: csvText2 }
];
const r = window.DS_API.run(
  {
    inst: 'thermo',          // 'thermo' | 'agilent'
    b0: 1, b1: 25, multi: 4, // 背景窗（秒）与信号阈值倍数
    stdName: 'AY-4', stdAge: 158.2, fracStd: 'AY-4',
    nistStd: 'SRM 612',      // 微量元素外标，可省
    method: 1,               // 普通铅校正 0–4
    algo: 'avg',             // 'avg' 平均法 | 'linear' 线性法
    excess: 3                // 外挂误差 Ɛ，按**百分数**填
  },
  files
);
if (!r.ok) {
  console.error(r.errors);   // [{ code:'NO_FILES', message:'没有数据文件', field:'files' }]
} else {
  console.log(r.rows.length, '行年龄；', r.stats.nStdFiles, '个标样文件');
}
```

`run()` 是**同步**的（管线本身是纯计算）。只有 `demoFiles()` / `runDemo()`
是异步的 —— 内置示例是 gzip+base64，要解压。

---

## 2. `run(params, files, options?)`

### 参数

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `inst` | `'thermo'`\|`'agilent'` | `'thermo'` | 仪器。决定读数解析规则与样品名取法 |
| `b0` / `b1` | number | `1` / `25` | 背景窗起止（秒）——激光开孔之前那一段 |
| `multi` | number | `4` | 信号阈值倍数：超过背景中位数多少倍算信号 |
| `stdName` | string | `'AY-4'` | **年龄层认的**标样名，必须与数据里出现的名字逐字相同 |
| `stdAge` | number | `158.2` | 标样年龄（Ma），用来算分馏校正常数 |
| `fracStd` | string | `'AY-4'` | **分馏校正用的**标样名 |
| `nistStd` | string | `'SRM 612'` | 微量元素外标名，可省 |
| `method` | 0–4 | `1` | 0 不校正 / 1 ²⁰⁷Pb / 2 ²⁰⁸Pb / 3 ²⁰⁴Pb / 4 Cal ²⁰⁴Pb |
| `algo` | `'avg'`\|`'linear'` | `'avg'` | 平均法 / 线性法（相邻标样分段插值） |
| `excess` | number | `3` | 外挂误差 Ɛ（%）。**只进误差、不进年龄** |
| `estimateAge` | number | `100` | 估算样品年龄（Ma）。只在 `method:4` 的"按年龄推算"里用到 |
| `fix76` | boolean | `true` | ²⁰⁷Pb/²⁰⁶Pb 迭代收敛修正。关掉即逐位复现桌面版数值 |
| `pbParams` | object | — | 直接给普通铅参数，覆盖"按年龄推算" |

⚠ **默认参数只保证"能跑通"，不保证"适合你的数据"**：`b0`/`b1` 说的是
"第几秒到第几秒是信号"，这跟激光什么时候开孔有关。真数据请用数据自带的
推荐参数（内置示例就是 `DS_DEMO_REAL.params`），或按信号图自己量。

### `files`

每项 `{ file: '文件名.csv', text: '文件全文（utf-8 字符串）' }`。
`text` 必须是字符串 —— Node 里自己 `readFileSync(p, 'utf8')`，不要传 Buffer。

### `options`

| 键 | 默认 | 说明 |
|---|---|---|
| `quality` | `true` | 是否附上批次质量统计（`r.quality`） |
| `fullRows` | `false` | 是否给每行附上 51 列原始位置数组（`row.raw`） |
| `ageKey` | `'206Pb/238U'` | 质检用哪一列年龄 |
| `corrected` | `true` | 质检是否用校正后年龄 |
| `thresholds` | — | 覆盖质量判据阈值（见 `capabilities().qcKeys` 同级文档） |
| `keepRaw` | `false` | 附上 51 列原始行与两份 CSV（体积大，调试用） |
| `log` | — | `(text, cls) => void`，实时接日志 |
| `sampleNames` | — | 样品名清单（Agilent 用） |
| `probeMap` | — | 复用已算好的探针结果，省一遍解析 |

---

## 3. 结果长什么样

```jsonc
{
  "ok": true,
  "apiVersion": "1.0",
  "params": { "stdName": "AY-4", "excessPercent": 3, "cal": { "P382": … }, … },
  "files": ["sample_01.csv", …],
  "stats": {
    "nFiles": 49, "nParsed": 49, "nBadFiles": 0,
    "nStdFiles": 15, "nNistFiles": 2,
    "nRows": 49, "nNaN": 0, "nNaNCorrected": 0,
    "samples": { "sample_01.csv": "S-01", … },
    "elapsedMs": 210
  },
  "header": [ … 51 个表头 … ],
  "rowCount": 49,
  "rows": [            // 命名字段行（不是 51 列位置数组）
    { "i": 0, "file": "sample_01.csv", "sample": "S-01",
      "AGE68": 158.4, "AGE68_2s": 2.1, "AGE75": …, "AGE82": …, "AGE76": …,
      "CORR1": …, "CORR1_2s": …, "CORR1_KEY": "207Pb/235U",
      "CORR2": …, "CORR2_KEY": "206Pb/238U",
      "U238_Pb206": …, "Pb207_Pb206": …, "Pb207_U235": …, "Pb206_U238": …,
      "rho": 0.83, "U_ppm": 412, "Th_ppm": 180, "Pb_ppm": 12 }
  ],
  "ageWarnings": { "divZero": 0 },
  "factors": { "f207_206": …, "f206_238": …, "f207_235": …, "f208_232": … },
  "warnings": [ { "code": "NAN_ROWS", "n": 3, "text": "…" } ],
  "logs": [ { "level": "info"|"ok"|"warn"|"error", "text": "…" } ],
  "quality": { … },     // src/qc.js 的 qcAnalyze() 原样输出
  "build": { "id": "156902ccbd90", "built": "…" }
}
```

**字段口径**（这几个最容易混）：

- `AGE68` 等四个是**未校正**年龄；`CORR1`/`CORR2` 是校正后年龄，
  取哪两列由 `qc.js` 的 `QC_CORR_COL[method]` 决定（`CORR1_KEY` 告诉你是哪个比值）。
- 误差列**恒在年龄列 +1**，所以 `AGE68_2s` 就是紧跟的那一列。
- 第 25 列（0 基）表头写着 `…Pb Corr. Age(Ma)` 但装的是**备注文字** ——
  这是原程序的历史遗留，所以校正后年龄要取 26/28 列，不取 25。
- `rho` 是 ²⁰⁶Pb/²³⁸U 与 ²⁰⁷Pb/²³⁵U 的相关系数，画谐和图要用。
- 年龄单位一律 **Ma**，浓度 **ppm**。`2σ` 的地方会写明（`_2s` 后缀）。

`algo: 'linear'` 时行数**不等于**文件数：线性法按相邻标样分段，只给
"非分馏标样"的文件出行（内置示例是 32 样品 + 2 个 SRM 612 = 34 行，
AY-4 的 15 行不出）。`r.groups` 给出标样段/样品段的数目。

---

## 4. 别的入口

| 方法 | 干什么 |
|---|---|
| `DS_API.runDemo(opts)` | 取内置真实示例 + 推荐参数，跑一遍（异步） |
| `DS_API.demoFiles()` | 只要内置示例的 49 个文件（异步） |
| `DS_API.compute(params, files, opts)` | 只到"年龄表"为止，返回 `ageRes`（界面用的就是它） |
| `DS_API.stages(compiled, opts)` | 过程量表：把一次计算的全部中间量并成一张宽表（见 §4a） |
| `DS_API.sampleChain(model, file)` | 单个样品的"流水账"（界面点开一行时用） |
| `DS_API.quality(compiled, opts)` | 只做质量统计。传 `compute()` 的结果 |
| `DS_API.probe(files, inst, sampleNames)` | 只轻量解析：每文件的样品名、点数、读取笔记、错误 |
| `DS_API.validate(cfg, files)` | 只校验参数，返回错误码数组（与界面"开始计算"同一套判据） |
| `DS_API.normalize(params)` | 朴素 JSON → 管线认的 cfg |
| `DS_API.reportHtml(R)` | 组装单文件 HTML 质量报告（需要产物里有 `DS_QCREPORT`） |
| `DS_API.toRows(ageRes, cfg, opts)` | 51 列位置数组 → 命名字段行 |
| `DS_API.calAge(age)` | Cal_age 闭式函数（P382/Q8/R8/S8/Pbc） |
| `DS_API.capabilities()` | 能力清单、模块状态、内置示例信息、默认值、错误码 |
| `DS_API.schema()` | 参数模式（JSON Schema） |
| `DS_API.tool()` | function-calling 定义（OpenAI tools / Anthropic tool 通用形状） |

---

## 4a. `stages(compiled, options?)` —— 中间环节那张表

界面上「过程量」标签页与「过程量.csv」按钮用的就是它。**它一个数都不算** ——
只是把 `compute()` 已经产出的中间量并成一张宽表（一行一个样品），
所以它是视图，不是第二条算式。实现见 `src/stages.js`，判据见 `test_stages.js`（55 项）。

```js
const R  = DS_API.compute(DS_API.DEFAULT_PARAMS, files, { keepRaw: true });
const st = DS_API.stages(R, { csv: true, keepByFile: true });
// st.columns  [{ g:'net', key:'n_Pb206', label:'²⁰⁶Pb', unit:'cps' }, …]
// st.headers  ['序号','文件','样品名', …]            // 带单位，界面表格与 CSV 都用这一份
// st.rows     [[0,'sample_01.csv','S-01', …], …]     // 位置数组，按 columns 顺序
// st.groups   { id:'标识', win:'积分窗口', cnt:…, net:…, ratio:…, age:…, trace:… }
// st.notes    { net:'净计数 = 信号均值 − 背景均值。…' }   // 每段的口径
// st.meta     [{ k:'分馏因子 f(206/238)', v:… }, …]        // 全局量，CSV 的 # 段
// st.byFile   { 'sample_01.csv': { vals:{…}, row, index, sampleFrom, notes } }  // 仅 keepByFile
// st.csv      BOM + '# 元信息行' + 表头 + 数据行的 CSV（仅 csv:true）
```

列按链条顺序分七组：**标识**(3) → **积分窗口**(8) → **背景/信号均值**(14) →
**净计数**(7) → **比值**(14) → **年龄**(8~12) → **微量元素**(3)。列数与 `method`
有关（选了校正方式就多出"校正后"那两列），所以**别写死列数**，按 `columns[i].key` 找列。

三处口径值得注意（`st.notes` 里也各有一段）：

- 净计数的五个通道（²⁰⁶Pb/²⁰⁷Pb/²⁰⁸Pb/²³²Th/²³⁸U）直接取自 `result_all.csv`
  的同名列；²⁰²Hg 与 ²⁰⁴Pb 在那份表里没有，按同一算式补出。
  哪一列来自哪儿写在 `DS_STAGES.STAGE_CHANNELS[i].netCol`
  （数字 = `result_all` 的列号，`null` = 补出来的）。
- 比值**不是**两个净计数相除，而是逐点算比值 → 用 2σ 剔掉离群点 → 再取均值；
  所以"分母的有效点数"与"数据点数"不是一回事。
- 积分窗口那两列"点数"是**切片真的取到了几个点**（索引会被钳），不是
  终点减起点。

`stages()` 需要 `compute()` 的完整结果：`compute()` 默认就带
`meanRows` / `num` / `idx` / `ti` / `tiGlobal`，别把它们摘掉（`keepRaw` 只影响更重的
`raw`）。传不齐会返回 `{ ok:false, errors:[{ code:'NO_STAGES_INPUT', … }] }`。

`sampleChain(model, file)` 给单个样品的分段流水账 —— 界面点表格某一行时展开的就是它。
`model` 要用 `stages(…, { keepByFile:true })` 那份（它才带 `byFile`）：

```js
DS_API.sampleChain(st, 'sample_01.csv')
// → [{ group:'win', title:'积分窗口', note:'…口径…',
//      items:[{ name:'背景窗 (s)', value:'8 – 16' }, …] }, …]
//    分段顺序：id → win → cnt → net → ratio → age → trace
//    items 里的 value **已经是排好版的字符串**（年龄 2 位小数、比值 6 位），
//    直接贴到界面上就行 —— 免得调用方再猜一遍该保留几位。
```

---

## 5. 给智能体：自描述

不用读源码就知道怎么调。

```js
DS_API.schema()   // → 完整 JSON Schema，含每个参数的 enum / default / description
DS_API.tool()     // → { type:'function', function:{ name:'isoclock_run', parameters:{…} } }
DS_API.capabilities()
// → { ready, modules:{…}, methods, algorithms, instruments, ageColumns,
//     qcKeys, units, demo:{ params, stdMeasured, stdRefs }, defaults, errorCodes }
```

`errorCodes` 是完整表 —— 调用方可据此分支处理：

| 码 | 含义 |
|---|---|
| `MODULE_MISSING` | 产物里缺少数值模块（文件被改过或来自旧版构建） |
| `BAD_PARAMS` / `BAD_INSTRUMENT` / `BAD_METHOD` / `BAD_ALGO` / `BAD_NUMBER` | 参数不合法 |
| `BAD_FILE` | 文件项不是 `{file, text}`，或 `text` 不是字符串 |
| `NO_FILES` | 没有数据文件 |
| `MISSING_STD_NAME` / `BAD_STD_AGE` / `BAD_EXCESS` / `MISSING_FRAC_STD` | 界面"开始计算"的五条判据 |
| `ALL_FILES_UNPARSED` | 所有文件都解析失败（附第一个的原始报错） |
| `STD_NOT_FOUND` | 标样名在数据里找不到（平均法下这是致命的） |
| `PIPELINE_ERROR` / `AGE_ERROR` / `PROBE_ERROR` | 三段各自的失败 |
| `NO_RESULT` | `quality()` 没拿到 `compute()` 的结果 |
| `NO_REPORT_MODULE` / `NO_DEMO` | 产物里没有报告模块 / 内置示例 |

失败一律返回 `{ ok:false, errors:[{ code, field, message }] }`，**不抛异常**。
只有 `normalize()` / `toRows()` 这类"底层纯函数"会抛（带 `e.code`）。

---

## 6. 智能体模式的地址（`#api`）

在地址栏 hash 里加 `#api`：

- 开屏不建 DOM（不用等那 1.4 s）
- 界面照样渲染，但**不用碰它** —— 等 `window.__apiReady === true` 即可开跑
- `<title>` 会变成 `API-READY [isoclock/1.0] …`，好让"只看得到标题的无头
  浏览器"也能判断就绪（日志面板的文字读不出来，这个坑踩过）

```js
// CDP 里最小的一段
await page.wait_js('window.__apiReady === true');
const r = await page.eval('DS_API.runDemo().then(x => JSON.stringify({ n: x.rowCount, lv: x.quality.summary.level }))');
```

---

## 7. 几条约定（改这个模块时要守住）

1. **`ui/api.js` 是唯一真源**：`calAge` / `PB_SPEC` / 模块接线 / 管线段 /
   参数校验都只此一份。`ui/app.js` 引用它。**任何一边想改这几样，都得改
   `api.js`** —— 两边各抄一份是唯一不准的做法。
2. **`isCfg()` 必须返回真布尔**。调用方会写 `if (isCfg(x))`，也会写
   `isCfg(x) === false`；返回 `undefined` 会让后一种写法悄悄失灵（踩过）。
3. **年龄表前两列是文件名与样品名**（`age.js` 的
   `row = [fileNames[i], names[i], R76, …]`），不是 CSV 里那个
   "序号/文件名/样品名"的顺序 —— 写反过一次。
4. **`quality()` 的上下文要凑齐**：`meanRows`（信号强度）、`num`（积分窗口）、
   `fileNotes`（读取提示）、`stats.samples`。少一个，报告里就少一段判据。
5. 加了新参数 → `schema()`、`DEFAULT_PARAMS`、`test_api.js` 的计数断言
   三处一起改；`schema` 里的 `default` 与实际默认值必须一致（自检有钉）。

## 8. 验证

- `node webgui/test_api.js` —— **56 项**：自描述、参数归一化、五条校验判据
  的错误码与顺序、全链路（用内置示例跑，与产物声明的标样结果对）、
  列映射逐字段追回原始列、线性法的行数语义。
- 页面内自检（`#selftest`）里的 **8 条** API 断言，其中一条是
  **"接口与界面跑出来的是同一份结果（51 列逐位）"** —— 这是"唯一真源"
  的当场验证。
