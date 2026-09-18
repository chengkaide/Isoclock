# webgui —— Isoclock 网页版

把 Isoclock 的数值内核移植到浏览器，做成**一个能双击打开的单文件 HTML**：
不装 Python、不联网、可直接邮件发给同行。

> **当前进度：数值内核已完成并通过逐位验证。界面尚未开始。**
> 这不是一个能用的软件，是它的地基 —— 但地基是这类移植里最容易出错的部分。

## 为什么是单文件离线

| 方案 | 问题 |
|---|---|
| Streamlit / Dash | 要装依赖、要起服务，分享给别人对方也得装 |
| 纯前端 + CDN 图表库 | 没网就白屏 |
| **单文件 HTML（自绘 canvas）** | 双击就能用、可邮件发送、零依赖 |

## 目录

```
webgui/
├── make_data.py       调用真实 Isoclock2.0.py 生成参考值（★ 不是复写算法）
├── test_math.js       Node 逐位对照测试
├── README.md
└── src/
    ├── math.js        数值内核（从 Isoclock2.0.py 逐式移植）
    ├── data.js        测试用通道数据（base64 float64，生成物）
    └── reference.json Python 端参考值（生成物）
```

## 怎么验证

```bash
python make_data.py      # 需要 Python 3.9 + numpy，生成 data.js / reference.json
node test_math.js        # 需要 Node，跑逐位对照
```

`make_data.py` 会 `import` 真实的 `../Isoclock2.0.py`（用 stub 顶掉 tkinter / xlwt），
**用原代码本身算参考值**，而不是把算法再抄一遍 —— 否则就成了"拿我的实现验证我的实现"。

## 当前验证结果

```
Python 3.9.10 / NumPy 1.24.2    node v22.22.2
数据：180 背景点 + 540 信号点 × 3 路样品

primitive   sum / mean / std / average        15/15 逐位相等
            nanmean / nanstd / countNan         3/3 逐位相等
            filter2s + mean2sem                 3/3 逐位相等（含 NaN 位置）
model       SK2model                      最大相对差 0
            Age76Pb                       最大相对差 1.9e-14
            ln(1+r)/λ 年龄换算              最大相对差 1.4e-16
reduce      3 样品 × 5 条校正路径            15/15 通过，每条 23/23 列逐位相等

总计 24 项：通过 24，失败 0
```

**345 个输出数值全部与 Python 逐位相同。**

## 移植中踩到的三个坑（都靠实测定位，不是推测）

### 1. NumPy 的求和不是左到右累加

`np.sum / mean / std / average / nanmean / nanstd` 全部走**成对求和**
（pairwise summation）：分块 128、8 路展开累加器、超过 128 再二分递归，切点对齐到 8 的倍数。

朴素累加与它的相对差实测可达 **1.3e-15** —— 足以让末位不同的数值进入论文表格。
`src/math.js` 里 `pwSum()` 逐行复刻了 `numpy/core/src/umath/loops.c.src` 的
`pairwise_sum_DOUBLE`，连 `n2 -= n2 % 8` 都一致。

### 2. `np.nanstd` 会把被掩位置"减完均值再打回 0"

这是最隐蔽的一处。`numpy/lib/nanfunctions.py::nanvar` 的实际顺序是：

```python
arr, mask = _replace_nan(a, 0)      # NaN -> 0
cnt = sum(~mask)
avg = sum(arr) / cnt                # 在原长数组上求和
np.subtract(arr, avg, out=arr)      # 全部位置都减 avg
arr = _copyto(arr, 0, mask)         # ★ 被掩位置重置回 0
var = sum(arr*arr) / cnt            # 仍在原长数组上求和
```

第 5 行是关键：被掩位置对平方和贡献 **0**，不是 `(0-avg)²`。
少这一步实测相对差 **4e-3**；改成"压缩有效子集再算"能降到 0.5 ULP 但仍不逐位相等
（数组长度变了，成对求和的分块结构就变了）。

### 3. 标量除法会静默产出 NaN

`net.pb204` 是标量，Python 里写 `n8 / pb204` 合法，JS 里 `a[i]/b[i]` 得到一片 NaN
**且不报错**。现在 `divArr()` 收到标量会直接 `throw`，逐元素除法必须显式用 `divScalar()`。

## 已保留的原实现缺陷

移植目标是**复现原软件的结果**，不是修正它。以下行为原样保留，已在 README 的
Known issues 中向使用者公开：

- `Age76Pb()` 循环条件里的 `Rap` 在循环体内从不更新 → 固定迭代 10 次，
  1.5–2.2 Ga 区间最大约 +35 Ma 偏差；比值略高于阈值时甚至返回**负年龄**（参考值里
  `r=0.0460456 → −1.078 Ma` 就是实录）
- 204 通道未做 Hg 干扰扣除
- 五条校正路径之间几处彼此不一致的写法（207Pb 法误差列用未校正比值、
  Cal204Pb 法的 2s 用另一表达式、208Pb 法的五个总量列用不同浮点路径）

## 已知误差来源

`exp` / `log` 各语言实现允许有约 1 ULP 差异（IEEE-754 不要求它们正确舍入）。
这是本移植唯一无法消除的误差源。实测：

| 函数 | 最大相对差 |
|---|---|
| `SK2model` | 0（逐位相同） |
| `Age76Pb` | 1.9e-14 |
| `ln(1+r)/λ` | 1.4e-16 |
| 全部 15 条还原路径 | 0（逐位相同） |

`Math.sqrt` 由 IEEE-754 规定为正确舍入，与 libm 的 `sqrt` 逐位相同，不构成误差源。

## 下一步

需要移植但尚未开始的部分（按依赖顺序）：

1. **数据导入** —— 原 `loaddata()` 的三种仪器分支（Thermo / Agilent / Element）。
   Thermo 与 Agilent 走 CSV，可在浏览器里直接解析；Element 的 `.fin`/`.fin2`
   需要先确认格式（可能是专有二进制），必要时降级为"先用桌面端转换"。
2. **标样校正与年龄层** —— 原 `Age_Calculate_average`（606 行）+ `Age_Calculate`（445 行）。
   这两千行里混着 GUI 与真正的数值，包含示踪元素系数、分馏因子、
   Sample-Standard-Bracketing 与漂移回归 `regression()`（用 `scipy.curve_fit`，
   属于优化器，按**相对容差 1e-9** 验收而非逐位）。**这是剩余工作量的主体。**
3. **界面** —— 单文件 HTML：数据粘贴/拖入、样品列表、信号图与积分窗口、
   结果表、导出（CSV / XLSX / JSON）。信号图用自绘 canvas，不引外部图表库。

## 交付检查清单（当前状态）

- [x] `node --check` 全部 JS 通过
- [x] `node test_math.js` 全部通过（15 条还原路径逐位相等）
- [ ] 无头浏览器 `#selftest` 全绿 —— 需等界面
- [ ] 每个标签页截图肉眼检查排版 —— 需等界面
- [ ] 单文件 html 单独拷贝仍能打开 —— 需等界面
- [x] 写清与原脚本的实际差异与已知局限
- [x] README 写清如何重建、如何验证

## 许可

与主项目一致，Apache License 2.0。数值方法与原始实现版权归 Guoqi Liu 所有。
