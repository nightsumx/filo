# litcode（lite-monaco）对比 Monaco

日期：2026-10-18。对象：`../text-suite/litcode`（包名 `lite-monaco` 0.3.0，最新提交 `4b9143d`，2026-10-12）对 `monaco-editor` 0.52.2。

## 结论

**在“嵌入一个编辑框”这个场景，日常编辑已经接近 Monaco；作为 Monaco 的替代品，还差平台能力和跨浏览器验证。** Filo 要的是前者（打开文件、改、保存、TS 补全和跳转），所以够用；不是 drop-in，也不打算是。

证据分三档，下面表里用标记区分：

- ✅ 我这次自己量的或跑的
- 📄 仓库文档自述，我没复核
- ❓ 没有证据，不知道

## 1. 体积和部署

| 项 | litcode | Monaco 0.52.2 | 来源 |
|---|---|---|---|
| 主包 | `dist/index.js` 1.5 MB，gzip 401 KB | `editor.main.js` 3.77 MB，gzip 954 KB，另有 `editor.main.css` gzip 21 KB | ✅ |
| TS 语言服务 | 不含，用宿主已有的 `typescript`，跑在主线程 | `tsWorker.js` 5.75 MB，gzip 1.29 MB，跑在 worker | ✅ |
| worker | 0 个 | 至少 editor worker 加各语言 worker（`workerMain.js` 376 KB） | ✅ |
| 语法高亮 | Shiki（peer，按需加载语言） | 内置 Monarch，`basic-languages` 640 KB | ✅ |

读这张表要注意：
- litcode 自己的 README 写主包约 700 KB，实测已经是 1.5 MB，文档过时了。
- Monaco 的 3.77 MB 是整包。按需裁剪语言和功能的 ESM 构建会小一些，我没量裁剪后的数字。
- litcode 不含 Shiki 和 TypeScript，这两样 Filo 本来就要装，所以对 Filo 是净省；单独用 litcode 的项目要把它们算进去。

对 Electron 的实际好处是不用配 worker：不用处理 `MonacoEnvironment.getWorkerUrl`、打包器的 worker 入口和 CSP。

## 2. 编辑功能

下表“litcode”一栏：有 = 仓库里有实现；括号是我没验证的限制。

| 功能 | Monaco | litcode | 来源 |
|---|---|---|---|
| 多光标、列选、选下一处 | 有 | 有（Alt 拖选 📄 标注“未完整产品化”，后续在 ROADMAP 里标已完成） | 📄 |
| 查找替换（大小写、全词、正则、选区内） | 有 | 有，Monaco 风格面板 | 📄 |
| 折叠（缩进、区域、按层级、递归） | 有 | 有，键位照 Monaco | 📄 |
| minimap、概览尺、sticky scroll、缩进线、括号配对着色 | 有 | 有 | 📄 |
| 自动补全 | 有 | 有，移植了 VS Code 的 fuzzyScore，列表虚拟渲染 | 📄 |
| TS 补全、hover、签名、诊断、跳转、引用、重命名、格式化、quick fix、peek、inlay hints | 有（worker） | 有（主线程） | 📄，我们的 `tsProject.test.ts` 用到了其中一部分 |
| 命令面板（F1）、右键菜单、Go to Line | 有 | 有 | 📄 |
| 并排 Diff | 有，含 inline、moved blocks、无障碍视图 | 只有并排，用 Monaco 的 diff 算法 | 📄 |
| 键位对照 | 本体 | 平台各自对齐 Monaco，CHANGELOG 称 436 条按键回放对 Monaco 差异 130 → 0 | 📄 |
| 自动换行 | 有 | 有，默认关 | 📄 |
| IME（拼音）组字 | 成熟 | 有专门的保护和修复记录 | 📄，真机 ❓ |
| 无障碍（屏幕阅读器） | 完整 | 有 role、live region，行号播报 | 📄，VoiceOver/NVDA ❓ |

## 3. litcode 没有的（Monaco 有）

| 缺什么 | 影响 |
|---|---|
| `monaco.languages.*` 的 provider 生态、contribution、完整 `monaco.editor` API | 想接别的语言服务要自己接内核的扩展点，没有现成的注册入口。README 写“永久不做” |
| 多 model 服务（URI、跨文件模型） | 多 tab 由宿主自己管。Filo 现在就是这么做的：切走时存 `state`，切回传回 |
| 非 TS 语言的智能 | 只有 css/html/json 的大纲，没有补全和诊断 |
| 语义 token、code lens、行内补全（ghost text）、颜色装饰器 | 我在源码里搜这些关键词没搜到，应该没有；没逐个功能确认 |
| Diff 的 inline 模式、moved blocks | 文档自述未做 |
| worker 里跑 TS | 见下一节 |
| 配置面 | 用 `features` 布尔开关，没有 Monaco 那一百多项 `editor.*` |

## 4. 性能

| 项 | 数字 | 来源 |
|---|---|---|
| 10k 行（49 万字符）文件，普通编辑和光标操作 | 多数 p50 在 0.3 到 25 ms（最慢的是随机跳转滚动 25 ms） | 📄 2026-08-14 的表，修复后 find / fold 降到 2 到 24 ms |
| 同一文件整篇载入 | 3.7 秒 | 📄 同一张表 |
| 语义诊断（主线程） | 10k 行约 200 ms；超过 2 万行自动只做语法诊断 | 📄 |
| 格式化整个文件 | 105 ms | 📄 |
| 粘贴 2 万行 | 约 130 ms（CHANGELOG 后来的数字） | 📄 |
| 同一场景 Monaco 的数字 | 没有 | ❓ |

要点：
- 仓库自己的数字都没有对着 Monaco 在同一台机器上测过，所以“快不快于 Monaco”这件事没有证据。
- TS 在主线程是真实的结构性短板：Monaco 把它放 worker，大文件不卡输入；litcode 靠“按行数分档降级”来躲（S/M/L/XL），降级就意味着大文件里功能变少。
- 整篇载入 3.7 秒那一项是 8 月的数字，之后改过不少，我没重跑。

## 5. 稳定性和验证

| 项 | 状态 | 来源 |
|---|---|---|
| 自动测试 | 203 个测试文件，3410 条，3409 通过 | ✅ 我跑了 |
| 那 1 条失败 | `dombridge-index-fix.test.ts` 的耗时断言（要求 < 150 ms，实测 192 ms），机器有别的任务在跑时的计时波动，不是逻辑错 | ✅ |
| Chrome 桌面 | 验收过 | 📄 |
| Firefox、Safari、iOS、Android | 没人手测，文档里标 ⏳ | 📄 |
| 代码量 | `src` 约 4.4 万行 TS，2026-06-30 起 103 次提交 | ✅ |
| API 稳定性 | 0.x，`litcode`、`DiffEditor`、`core` 标 stable，但 0.x 允许 breaking | 📄 |

Filo 是 Electron，只跑 Chromium，所以跨浏览器那一行对我们基本不构成风险。

## 6. litcode 的优势（对 Filo）

1. **主题按实例，不是全局。** Monaco 的 `setTheme` 是全局的，同页一暗一亮会互相影响；litcode 的颜色是每个编辑器上的 `--lc-*` 变量。Filo 里同时开暗色和亮色的编辑器时不会互相影响（我没专门测这个场景）。📄
2. **状态可以整个存取。** `litcode({ state })` 恢复撤销历史、选区、折叠；多 tab 切换不丢。Monaco 要自己管 model 和 view state。Filo 的 `fileTab.ts` 已经在用。
3. **和 VS Code 同一份语法和主题。** 用 Shiki 的 TextMate 语法和 `dark-plus`，颜色就是 VS Code 的（今天刚换，已截图核对）。
4. **没有 worker、CSP 简单，体积小一半以上。** 见第 1 节。
5. **可监测。** `view.introspect()`、`state.snapshot()`、`onTransaction`。我们的 e2e 直接读 `window.__app.activeFile.view`，不用靠 DOM 猜。
6. **源码在手。** 出问题能直接改，和 Filo 一起迭代。Monaco 的内部基本改不了。
7. **多编辑器互不串。** token 缓存按 view 分开，同语言的实例共享一个 TS 项目。📄

## 7. litcode 的风险

1. **一个人维护的 0.x 库。** 出问题没有社区兜底；这也是上一点“源码在手”的另一面。
2. **主线程 TS。** 大文件会降级，或者在语义诊断时有感知的停顿。
3. **文档落后于代码。** README 的体积数字、`CAPABILITIES.md`（2026-07-13）和 CHANGELOG 对不上，查事实要以代码和测试为准。
4. **Filo 打包用的是 `vendor/lite-monaco-0.3.0-r10.tgz`（r9 的 dist 上补了 `from '.'`、`lib` 选项、lib 排在用户文件前、`setTsResolutions`；litcode 工作区源码里是同样的改动，未提交），开发模式用的是 `../text-suite/litcode` 的工作区源码。** 最新提交比 tgz 晚一天；两者内容差多少我没比对，所以你在 dev 里看到的编辑器，不一定和打出来的包一样。每次发版前要重新打 tgz。
5. **真机输入法和读屏没有验证记录**，Filo 用户里有中文输入，这块值得自己在真机上过一遍。

## 8. 建议

- 当前用法（单文件编辑、TS 补全、多 tab、分屏）：继续用 litcode，没必要换回 Monaco。
- 换回 Monaco 才划算的情况：要接非 TS 语言服务（LSP）、要 inline diff / moved blocks、要稳定的无障碍。
- 值得补的验证（我没做）：同一台机器上，同一个 1 万行文件，两边测载入、打字延迟、滚动，得到一张有 Monaco 对照的数字；中文输入法真机过一遍。

## 9. 再对比 CodeMirror 6

CodeMirror 6 没装在本仓库，我在临时目录里装了 `codemirror@6.0.2` 加 `@codemirror/lang-javascript@6.2.4`（view 6.43.14）量了体积，之后删掉。其余 CM6 的说法来自 litcode 自己的 `CM6-LEFTOVER.md`、`CAPABILITIES.md` 和我对 CM6 的了解，没有另测。

前提：litcode 不是 CM6 的竞争对手，是从它长出来的。核心（文档模型、事务、Facet、heightmap、输入和 IME 处理）是照 CM6 的源码移植加重写的（文档里叫 CM7），“浏览器输入的坑”直接搬了 CM6 的做法。所以问题实际是：CM6 的原版内核加你自己拼功能，还是 litcode 这套拼好的 Monaco 风格成品。

| 项 | CM6 | litcode | 来源 |
|---|---|---|---|
| 体积 | `basicSetup` 加 JS 语言：491 KB，gzip 168 KB | 1.5 MB，gzip 401 KB，但含 minimap、find 面板、命令面板、TS 智能、Diff | ✅ |
| 成熟度 | 多年、大量生产使用，6.x 内 API 稳定 | 0.x，约三个月，一个人维护 | 📄 |
| 浏览器和输入法 | 多平台长期打磨 | 移植了 CM6 的主要处理，Chrome 外没验证 | 📄 |
| 高亮 | Lezer 增量解析，语法树可用于导航和折叠 | Shiki（VS Code 同款颜色），没有语法树，不能按语法节点导航 | 📄 |
| TS 补全、hover、跳转、诊断 | 要自己接（社区有包） | 内置 | 📄 |
| Monaco/VS Code 外观和键位 | 要自己做 | 内置，按键位对过 Monaco | 📄 |
| minimap、sticky scroll、peek、命令面板、Diff 编辑器 | 大多要找社区包或自己写 | 内置 | 📄 |
| 扩展机制 | ViewPlugin、通用 gutter/panel/tooltip，生态大 | 专用 overlay，没有通用插件 API，不兼容 CM6 插件 | 📄 |
| 可监测（读内部状态做测试） | 内部值私有 | `introspect()` / `snapshot()` | 📄 |
| 横向滚动稳定性 | 靠 DOM 的 scrollWidth | 有全文档行宽表 | 📄 |
| 无障碍、RTL | 完整 | 有基础，RTL 命令偏逻辑方向 | 📄 |

**哪个强，看比的是什么：**

- **引擎的可靠性和生态：CM6 强。** 它经过更多真实场景，扩展点完整，语法树能支撑更多编辑命令。litcode 在这一层是“CM6 的子集加自己的取舍”，不会比原版更稳。
- **开箱即用的 Monaco 体验和 TS 智能：litcode 强。** CM6 要达到同样的效果，得自己组装十几个包，TS 那部分要自己接语言服务。
- **体积：** CM6 的最小配置更小，但那是没有这些功能的配置。同功能下谁小，我没量，不下结论。
- **性能：** 两边我都没测，没有结论。

对 Filo：它要的是 VS Code 风格、带 TS 补全和跳转、多 tab 的编辑器，litcode 更省事。代价是引擎层没有 CM6 的稳定性和生态；输入法、Safari 一类的边角问题得自己修。如果以后要接别的语言服务，或要按语法节点做编辑命令，CM6 加 Lezer 是更稳的底座。

## 10. 许可证和来源（2026-10-18 核查）

我把 litcode 的 130 个源文件转成同样的 JS 后，和本机的 CodeMirror 6 与 Monaco 0.52.2 源码逐 token 比对：约 8.5% 的 token 落在“连续 20 个以上完全一致”的片段里，几乎都来自 CM6（heightmap、rangeset、change、rope、browser 等，最长一段连续 231 个 token 一字不差）。来自 Monaco 的是补全的 fuzzy 打分，和 minimap 的预烤字形表（与 Monaco 的数据逐字节相同）。Monaco 的词操作（`words.ts`）没有发现复制。

处理：litcode 加了 `THIRD-PARTY-NOTICES.md` 并随包发布，相关源文件头加了来源注释，README 和 `package.json` 不再说“自研 / from-scratch”，README 顶部注明与微软无关；Filo 的应用包里也带了这份声明。未解决：Monaco 名字有没有商标限制，我没查到结论；codicon 字体是 CC BY 4.0 还是 MIT，按更严的署名处理。
