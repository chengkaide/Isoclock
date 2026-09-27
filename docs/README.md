# docs/ —— 项目站点（GitHub Pages）

这个目录就是 <https://chengkaide.github.io/Isoclock/> 的源文件。
发布方式：仓库 **Settings → Pages → Source = `Deploy from a branch`，分支 `main`、目录 `/docs`**。

## 里面有什么

| 文件 | 是什么 | 谁生成的 |
|---|---|---|
| `index.html` | 落地页。手写，中英双语，内联 CSS，零 JS、零外链（除 7 个 GitHub/邮箱链接） | 手写，直接编辑 |
| `guide.html` | 《原理与代码解读》图解版：8 章、56 张内联 SVG | 由 docbuild/ 流水线产出，**不要手改** |
| `app/isoclock.html` | 网页版应用本体（单文件、离线可用） | `webgui/build_ui.py` 的产物，**不要手改** |
| `assets/*.png` | 页面里引用的 5 张界面截图 | 无头 Edge 实拍 |
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
- **不要写没验证过的数字。** 页面上所有计数（314 项、690 格、4.1×、876 px 等）
  都来自 `webgui/README.md` 里已经跑过的实测记录；新增数字要有出处。
