# docs/ —— 项目站点（GitHub Pages）

这个目录就是 <https://chengkaide.github.io/Isoclock/> 的源文件。
发布方式：仓库 **Settings → Pages → Source = `Deploy from a branch`，分支 `main`、目录 `/docs`**。

## 里面有什么

| 文件 | 是什么 | 谁生成的 |
|---|---|---|
| `index.src.html` | 落地页的**源**。中英双语、内联 CSS、零 JS、零外链（除 7 个 GitHub/邮箱链接）。要改页面就改这里 | 手写，直接编辑 |
| `index.html` | 落地页的**产物**，也是 GitHub Pages 真正服务的那一份（徽章、正文数字都已物化） | `python docs/make_badges.py`，**不要手改** |
| `guide.html` | 《原理与代码解读》图解版：8 章、56 张内联 SVG | 由 docbuild/ 流水线产出，**不要手改** |
| `app/isoclock.html` | 网页版应用本体（单文件、离线可用） | `webgui/build_ui.py` 的产物，**不要手改** |
| `assets/*.png` | 页面里引用的 7 张界面截图（清单的唯一真源是 `sync_assets.py` 的 `SHOT_MAP`，别在这里再抄一份）+ 1 张社交分享预览 `og.png` | 无头 Edge 实拍 |
| `sync_assets.py` | 把 `guide.html`、`app/`、`assets/` 从未提交/别处的地方同步进来 | — |
| `make_badges.py` | 由 `index.src.html` 生成 `index.html`（徽章 + 正文数字） | — |
| `.nojekyll` | 关掉 GitHub Pages 的 Jekyll 处理（本站全是静态文件，不需要） | `sync_assets.py` |

**上游只有一个**：`guide.html`、`app/isoclock.html`、`assets/` 全部由 `sync_assets.py` 复制而来，
`index.html` 由 `make_badges.py` 从 `index.src.html` 生成 —— 这四个都**不要在 `docs/` 里直接编辑**，
下次同步/生成就被覆盖了。要改就改源头再跑一次。

### 为什么首页要拆成两个文件

因为正文里的数字（单文件多大、标样跑出多少）必须**每次重算**，而标记若留在被服务的那份
文件里，就会原样发到线上。踩过一次：徽章物化了、正文标记却没人替换，线上首页真的把
`{{PAGEKB}}` 印给读者看了。所以规矩定成一句：**改内容改 `index.src.html`，然后跑
`python docs/make_badges.py`。**（`index.src.html` 会一起发布，它就是个静态源文件，无妨。）

## 怎么更新

```bash
# 1) 改了网页版源码之后，先重新构建（在仓库根目录）
python webgui/build_ui.py

# 2) 同步到站点
python docs/sync_assets.py

# 3) 重新生成首页（徽章 + 正文数字都按实算刷新）
python docs/make_badges.py

# 4) 检查有没有漏同步 / 页面数字过期（CI 或提交前跑）
python docs/sync_assets.py --check
python docs/make_badges.py  --check
```

`sync_assets.py` 会把图解版 HTML 的来源路径当参数（默认指向作者工作区里的那份）：

```bash
python docs/sync_assets.py --guide "D:/path/to/Isoclock_原理与代码解读_图解版.html"
# 或设环境变量 GUIDESRC
```

源码找不到时它**不会**把站点弄坏——保留现有的 `docs/guide.html`，只打一条警告。
只有 `webgui/isoclock.html` 缺失才算致命（返回码 1）。

## 本地预览

```bash
python -m http.server 8000 --directory docs
# 然后打开 http://localhost:8000
```

直接双击 `docs/index.html` 也能看，但 `app/isoclock.html` 里的下载功能在 `file://` 下行为不同，
要完整验证请用上面的本地服务器。

## 几条约定

- **落地页只用内联 CSS、不用 JS。** 站点要能在任何浏览器、任何年份打开，
  也要能直接 `Ctrl+P` 存成 PDF 发人。加脚本会破坏这两点。
- **深浅色都跟系统走**（`prefers-color-scheme`）。改样式时两边都要看一眼。
- **图必须点得开**：界面截图都包在 `<a href="assets/…" target="_blank">` 里，
  缩略图看不清时可以开原图。
- **改页面后重新拍一次截图**再提交，别只改文字不验版式：
  无头 Edge 的 `--window-size` 要开够高（首页约 13900 px —— 这是**图片都能加载**
  时的高度；图没加载上版面会塌缩到 11000 出头，那时截出来的图是残的）。
  ⚠ 注入探针的临时副本必须放在**被仿页面的同一目录**里，否则 `assets/ui-*.png`
  这些相对路径全部解析不到，量出来的每一个绝对位置都是错的。
- **不要写没验证过的数字。** 页面上所有计数（409 项、826 KB、9.8 MB 等）
  都来自已经跑过的实测记录；新增数字要有出处。
- **首屏那排徽章不要手写** —— 它由 `python docs/make_badges.py` **算出来**再写进
  `index.html`；同一趟也会把 `index.src.html` 里 `<!-- BADGES:BEGIN -->` 与
  `<!-- BADGES:END -->` 之间的那一块**回写**成同一份内容，**那一块别手改**。
  文件体积直接 `getsize()`，比对项数**真跑** `webgui/test_*.js` 再累加。
  手写就会过期：这里原来写死 "289 KB"，而文件当时已是 290549 字节，
  没有任何东西会报错。
  （踩过一次更隐蔽的：脚本原先只写产物、不回写源，于是源里那块一直停在
  `336 项 / 41 项`，而实跑早已是 402 / 54 —— 过期的是副本，总数还"对得上"，
  所以没人发现。现在 `--check` 同时盯产物和源。）
  CI 上跑 `python docs/make_badges.py --check`，任一处过期即失败。
- **正文里的数字写成 `{{TOKEN}}`，不要写值。** 写在 `index.src.html` 里，例如
  `单文件 {{PAGEKB}} KB`、`标样 AY-4 出 {{AY4}} ± {{AY4SE}} Ma（2σ）`、
  `{{TESTS}} 项数值比对`。每次跑 `make_badges.py` 会用新值替换一遍**写进 `index.html`**，
  源里则始终保留标记。可用的标记看 `token_facts()` / `read_demo_facts()`。
  **哪个标记没有实算值，构建就直接报错** —— 宁可失败，也不要印一个猜出来的数。
  （踩过一次：早先脚本把替换后的结果写回文件，于是标记变成了字面量，
  第二次运行再也刷不动正文，而且**一声不响**。现在源与产物分开，就没有这个空间了。）
- **注释里也不能写出标记的原样。** 替换器认的是"任意 `{{字母数字}}`"，
  解释"这里为什么不用标记"的注释里要是照抄一个，构建会当场停下 —— 这是刻意的。
- **工作区里的换行符必须是 LF。** 根目录的 `.gitattributes` 把 `docs/**` 和 `webgui/**`
  钉成 `text=auto eol=lf`：Windows 默认 `core.autocrlf=true` 会把 checkout 出来的文本
  每行多一个字节，而徽章量的是工作区文件 —— 同一枚徽章在 Windows 和 CI（ubuntu）上
  会算出两个数，那种红只在别人机器上出现。写文件时显式给 `newline="\n"`
  （`Path.write_text()` 的默认值在 Windows 上就是 CRLF 的来源）。
- **`webgui/ui/app.html` 里那些数**写在帮助弹窗里，页面自己算不出来（要跑 Node
  才知道），所以留在 HTML 里用标记标出来，由 `make_badges.py` 每次跟实跑结果比一次，
  对不上就红。三类标记：总数用 `data-count="tests|suites|selftest"`；
  **逐套的项数**（"63 项质量统计"这种）用 `data-count="suite:<文件名>"` ——
  后者是补上的：那几行同样是手写的，也过期过（`test_demo_real.js` 从 20 项加到
  22 项之后，页面上还写着 20，而总数是对的、所以谁也没发现）。
- **凡是产物里已经有答案的数，界面就别抄第二份。** 左栏「真实锡石」那句说明里的
  文件个数就是从 `DS_DEMO_REAL.files` 现读的（原来手写"50 个"，数据改成 49 个之后
  成了假话）。给这类元素留个 id、在 `boot()` 里填，并且**在 `#selftest` 里加一条
  断言**钉住"确实填上了、填对了"。
- **不要用 shields.io 之类的徽章图片。** 那是一次外部请求，与"零外链、离线可开"
  的约定冲突。徽章是内联 HTML 药丸（`.badges` / `.b`），跟着系统深浅色走。
- **必须保留「关于这份文档」那一节**（`index.src.html` 的 `#about`）：用户的硬要求是
  **标注 AI 参与了文字/图表整理**、声明维护者是使用者而非方法提出者、
  并给出每个数字的可复现出处。改版时不要顺手删掉它。
