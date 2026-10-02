# docs/ —— 项目站点（GitHub Pages）

这个目录就是 <https://chengkaide.github.io/Isoclock/> 的源文件。
发布方式：仓库 **Settings → Pages → Source = `Deploy from a branch`，分支 `main`、目录 `/docs`**。

## 里面有什么

| 文件 | 是什么 | 谁生成的 |
|---|---|---|
| `index.html` | 落地页。手写，中英双语，内联 CSS，零 JS、零外链（除 7 个 GitHub/邮箱链接） | 手写，直接编辑 |
| `guide.html` | 《原理与代码解读》图解版：8 章、56 张内联 SVG | 由 docbuild/ 流水线产出，**不要手改** |
| `app/isoclock.html` | 网页版应用本体（单文件、离线可用） | `webgui/build_ui.py` 的产物，**不要手改** |
| `assets/*.png` | 页面里引用的 5 张界面截图 + 1 张社交分享预览 `og.png` | 无头 Edge 实拍 |
| `sync_assets.py` | 把上面三样从未提交/别处的地方同步进来 | — |
| `.nojekyll` | 关掉 GitHub Pages 的 Jekyll 处理（本站全是静态文件，不需要） | `sync_assets.py` |

**上游只有一个**：`guide.html`、`app/isoclock.html`、`assets/` 全部由 `sync_assets.py` 复制而来，
不要在 `docs/` 里直接编辑它们——下次同步就被覆盖了。要改就改源头再同步。

## 怎么更新

```bash
# 1) 改了网页版源码之后，先重新构建（在仓库根目录）
python webgui/build_ui.py

# 2) 同步到站点
python docs/sync_assets.py

# 3) 检查有没有漏同步（CI 或提交前跑）
python docs/sync_assets.py --check
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
  无头 Edge 的 `--window-size` 要开够高（首页约 13400 px），否则会截断。
- **不要写没验证过的数字。** 页面上所有计数（336 项、756 KB、9.8 MB 等）
  都来自已经跑过的实测记录；新增数字要有出处。
- **首屏那排徽章不要手写** —— 它由 `python docs/make_badges.py` **算出来**再写进
  `index.html`（改的是 `<!-- BADGES:BEGIN -->` / `<!-- BADGES:END -->` 之间，
  别手改那一段）。文件体积直接 `getsize()`，比对项数**真跑** `webgui/test_*.js`
  再累加。手写就会过期：这里原来写死 "289 KB"，而文件当时已是 290549 字节，
  没有任何东西会报错。
  CI 上跑 `python docs/make_badges.py --check`，过期即失败。
- **正文里的数字写成 `{{TOKEN}}`，不要写值。** 徽章那一段是物化的（文件本身就是成品页），
  但 `index.html` 的**正文**里凡是引用实算值的地方都留标记，例如
  `单文件 {{PAGEKB}} KB`、`标样 AY-4 出 {{AY4}} ± {{AY4SE}} Ma（2σ）`、
  `{{TESTS}} 项数值比对`。每次跑 `make_badges.py` 会拿新值替换一遍。
  可用的标记看 `token_facts()` / `read_demo_facts()`。
  **哪个标记没有实算值，构建就直接报错** —— 宁可失败，也不要印一个猜出来的数。
  （踩过一次：早先脚本把替换后的结果写回文件，于是标记变成了字面量，
  第二次运行再也刷不动正文，而且**一声不响**。现在写回的是带标记的那份，
  `--check` 则拿"同一套实算值分别替换两个版本"来比对。）
- **`webgui/ui/app.html` 里那三个数（多少项比对 / 多少套 / 多少项自检）**写在
  帮助弹窗里，页面自己算不出来（要跑 Node 才知道），所以留在 HTML 里、
  用 `data-count="tests|suites|selftest"` 标出来，由 `make_badges.py` 每次
  跟实跑结果比一次，对不上就红。
- **不要用 shields.io 之类的徽章图片。** 那是一次外部请求，与"零外链、离线可开"
  的约定冲突。徽章是内联 HTML 药丸（`.badges` / `.b`），跟着系统深浅色走。
- **必须保留「关于这份文档」那一节**（`index.html` 的 `#about`）：用户的硬要求是
  **标注 AI 参与了文字/图表整理**、声明维护者是使用者而非方法提出者、
  并给出每个数字的可复现出处。改版时不要顺手删掉它。
