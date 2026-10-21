# 数链 · Masyu — 交付报告

## 摘要

| 字段 | 值 |
|---|---|
| **App 名称** | 数链 · Masyu（回路推理） |
| 英文名 / 形态 | Masyu · 浏览器原生 ES 模块（根形态 + GitHub Pages 前缀形态），`electron/` 是同一份代码的桌面壳 |
| 玩法一句话 | 把一条不自交的闭环连过所有珠子：**黑珠**那一格必须拐弯、且进出的那两格都直穿；**白珠**那一格必须直穿、且前后两格里至少有一格拐了。玩家画的是格与格之间的那条边，一条边三态：没落笔 / 环边 / 排除叉 |
| 档位 | 菜单五档 6×6 / 7×7 / 8×8 / 9×9 / 10×10；`SIZE_TABLE` 里另有三个长方形（7×6 / 8×7 / 10×9）**不进菜单**，只当难度表的对照组量 |
| 难度口径 | 分数 = Σ规则权重 × 出手次数（`tools/balance.mjs` 自定义的度量，引擎里**没有** `scoreOf`）；`steps` 恒等于盘上边数，所以不作难度口径；档位区间住在 `js/engine/generate.js` 的 `SIZES` |
| 规则条数 | 10 条（`js/engine/pencil.js` 的 `RULE_ORDER`：`pearl-degree` / `white-straight` / `black-turn` / `black-straight` / `white-turn` / `cell-degree-two` / `no-dead-end` / `no-2x2-square` / `single-loop` / `no-island`） |
| 测试钩子 | `window.masyu`（27 个键：`version` `state` `engine` `view` `fx` `sound` `paused` `elapsedMs` `setPaused` `togglePause` `toggleFullscreen` `toggleMuted` `game` `won` `mode` `setMode` `hint` `newGame` `mintSeed` `checkWin` `render` `relayout` `hideVeil` `store` `palette` `space` `simClock`） |
| 依赖 | 运行时 **0** 个、`devDependencies` 1 个（electron，只有 `npm run electron` 那条路需要它） |
| 二进制资产 | 14 张 PNG（`icons/` 11 + `art/` 3），无音频文件（音效由 WebAudio 合成）、无字体 |
| node 断言 | **67 条**（`tools/rule-test.mjs`，每条规则要 fire / contra / 静得住），0 失败；另有 `tools/pencil-test.mjs` 逐结论对账 **7403 条结论**推错 0、`tools/counter-test.mjs` 五节、`tools/generator-probe.mjs` 五档 ×8 盘 |
| 文档腿 | **233 项 / 18 组**（`tools/doctest.mjs`），0 失败；破坏试验台账 **18 把刀**（`tools/sabotage.mjs`）全绿 |
| 部署集 | **43 条引用 / 77 条断言 / 10 张位图尺寸核对**（`tools/deploy-set.mjs`），0 失败；阴性自证 `tools/deploy-set-selftest.mjs` rc=0（13 把刀按预期发力，2 把按本仓形状合法 SKIP） |
| 浏览器断言 | **99 项**，6 段（boot 11 / render 6 / play 35 / marks 16 / resume 13 / hint 18）+ 一次 Pages 前缀形状冒烟，0 红 |
| 验收命令 | `npm run check` · `npm test` · `node tools/doctest.mjs` · `node tools/sabotage.mjs` · `node tools/deploy-set.mjs` · `node tools/deploy-set-selftest.mjs` · `bash tools/verify.sh` |

依赖与资产的机器可判定检查：

```bash
$ node -e 'const p=require("./package.json");const d=p.dependencies||{};
  process.stdout.write(Object.keys(d).length===0?"ok":JSON.stringify(d))'
ok
$ git ls-files | grep -cE '\.(png|jpg|jpeg|mp3|wav|woff2?|ttf|svg)$'
14
```

---

## 基线 → 本次提交

| | 提交 | 说明 |
|---|---|---|
| 基线 | `d328b57` | 「merge: 有机并线（两侧内容合入；重叠块按最新权威裁，非重叠两侧都留）」。两侧 = 本地侧 `41918ea` 体系（最后提交 2026-10-02）与远端侧 `80ee7a6` 体系（最后提交 2026-10-08） |
| 本次修复 1 | `092cdc3` | 修并线造成的五处整局级缺陷 + 部署清单漏拷 `art/` + 文档行号钉重钉 |
| 本次修复 2 | `a74b278` | 部署集自证台架的 X1 刀针不再写死位图目录名（清单一改它先炸自己） |
| 本次修复 3 | 见下（`js/main.js` 门面去重） | `window.masyu` 面上 `get paused()` 与 `setPaused` 也各被并线接了两遍 |
| 本交付物 | 本文件所在提交 | 只增这一个文件 |

> 并线权威口径（`z-biz-game-lead/003_辅助能力/collapse/script/merge_organic.py` 的 `decide()`）：按**该路径两侧最后一次提交时间戳**比较，新的一侧为胜方。本仓逐路径算下来：`index.html` / `js/main.js` / `manifest.webmanifest` / `sw.js` / `css/game.css` / `tools/*` 归**远端侧**，而 `art/` / `assets/` / `js/fx.js` / `js/sound.js` 只在**本地侧**有。两侧各有完整实现、本次只取并集不取单边的地方，已在下表逐条写明。

---

## 改动表：旧代码错在哪 → 新代码为什么对

| # | 旧代码错在哪 | 新代码为什么对 |
|---|---|---|
| 1 | **整局不可玩**：`js/main.js` 里 `let paused` / `function setPaused` / `function paintPause` 各出现**两遍**（远端侧那份塞在中段，本地侧那份带遮罩）。**ES module 的顶层作用域里同名声明是 SyntaxError**（实测 `node --check`：`Identifier 'paused' has already been declared`）⇒ 整个 `main.js` 根本不加载 ⇒ 页面只剩一个空壳 | 逐个留一份：留本地侧那份（暂停遮罩 + `fx.paused` + `Sound.suspendForPause` + 暂停时的状态行），删掉远端侧那份。**能力没有丢**：远端侧那份有的功能本地侧都有，且本地侧那份多两样（遮罩与音效挂起） |
| 2 | **整局不可玩**：并线把 `index.html` 的 `#btn-sound` 裁掉了，而 `js/main.js` 的启动块要 `setMutedUI(Sound.muted())`、点击接线 `$('btn-sound').addEventListener(...)` 都指着它 ⇒ 页面一加载就 `TypeError`，后面整段初始化不执行 ⇒ 整局不可玩 | 按本地侧原文补回该按钮（`id` / `aria-pressed` / `title` / 文案与本地侧逐字一致）。它与本地侧那套音效子系统（M 键、静音偏好落盘、静音时真停 AudioContext）是一套，不是新加的功能 |
| 3 | **同一颗按钮挂两个处理器**（双开关 ⇒ 净效果「按了没反应」）：`#btn-pause` 上有两条 click —— 本地侧一条 `setPaused(!paused)`，远端侧在文件末尾追加块里又一条 | 只留本地侧那条。删之前核过：页面 38 个 `id` 现在全部唯一，脚本引用的 37 个 `id` 一个都不悬空 |
| 4 | **同一键挂两段 keydown**：远端侧在 keydown 链尾追加了 `N`/`P` 两个分支，而本地侧链首已经处理 `P`/`M`/`F`/`R`/`N` ⇒ 走到链尾的 `N`/`P` **永远不可达**（都被链首 `return` 掉了） | 删掉链尾那两个分支。链首那五组键位（`P` 暂停 / `M` 音效 / `F` 全屏 / `R`·`N` 换一局 / `?` 念规则）保持原样 |
| 5 | **全屏能力打折**：本地侧的 `toggleFullscreen()` 只探 `requestFullscreen` / `webkitRequestFullscreen`，老 Edge 只认 `ms` 前缀 ⇒ 在那儿按 `F` 没反应；而远端侧那份（整段被并线裁掉了）恰恰三套前缀都探 | 把 `ms` 前缀并进留下的那份：请求侧 `msRequestFullscreen`、退出侧 `msExitFullscreen`、状态回写侧 `msFullscreenElement` 三处一起补齐 |
| 6 | **部署清单漏拷 `art/` ⇒ 线上 404**：`tools/assemble-site.sh` 的位图循环写的是 `for d in icons assets`，而本仓的 `assets/` 是**出图脚本**（`assets/gen/gen_art.py`）不是运行时资源；真正在运行时被要的 `art/` 根本没进产物 ⇒ `css/game.css` 的 `url('../art/board-texture.png')`（页面底纹 + 暂停盖层）与 `js/main.js` 的 `fx.loadSprite('art/fx-sprites.png')`（粒子条）在线上各 404，而本地一切全绿（本地读的是仓库根），**Pages 的部署闸 `node tools/deploy-set.mjs _site` 本身就会红** | 循环改成 `for d in icons art`；`assets/` 进「不进站点的」名单并写清理由（它是**造**图标与纹理的源码，页面一次也没要过它）。README 那句「站点里现在是：…」同步成 7 项 |
| 7 | **文档行号钉全是远端侧的**：README/DESIGN 里 16 处 `js/main.js:NN` / `index.html:NN` 指的是远端侧那份文件的行号（远端侧 `<ol class="rules">` 在 101、`window.masyu` 在 499、`SIZES` 循环在 479、`DEFAULT_SIZE` 在 21），而并线后的文件里它们全在别处 ⇒ 文档腿 `D1f`/`D8d`/`D8e`/`D10`/`D11` 五处红，`D11` 直接点名「`js/main.js:21` 那几行整段是空行」 | 逐条按现在的文件重新定位并钉回去（`<ol>` 133-137、keyhint 148、`window.masyu` 649、SIZES 629、hint 233-267、keydown 437-535、pointerdown 366、右键 378-387、`verify()` 回填 175-177、mintSeed 127-133、`DEFAULT_SIZE` 23、generate 275-288、`Store.resume` 对账 301、作废存档固定文案 330-333）。**钉的是实数，强度不变** |
| 8 | **head 与 manifest 拼成两套**：并线把两侧的 meta 拼到了同一行（`viewport` 后面粘着 `twitter:card`），图标声明既有 `data:` URI 的手写 SVG 又有三枚 PNG，`og:image` 指的是 512×512 的**方形图标**而不是 1200×630 的横版卡片；`manifest.webmanifest` 取的是远端侧最简那份（3 枚图标、无 `screenshots`/`scope`/`display_override`/`lang`/`categories`），本仓生成器产的另外 6 枚 PNG 一枚都没被声明 | head 归一（`viewport` 独占一行；og/twitter 指向 `art/og.png` 的**绝对 URL**，抓取器不会替 Pages 补 `/<slug>/` 前缀；图标只留真 PNG，去掉那枚 data: URI 的 SVG——本仓自己写着「16px 的矢量小图冒充不了 180px 的位图图标」）；manifest 取本仓生成器那套（9 枚图标 + 1 张截图，`sizes` 与 PNG IHDR **逐张**量过）。副作用是 PWA 装到桌面/主屏的图标档位从 3 档补到 9 档 |
| 9 | **service worker 注册了两遍**：页面里一份内联 `<script>`（本地侧）与一份 `js/sw-register.js`（远端侧），两份都在 `load` 事件上注册 ⇒ 「装上了没有」从此有两个答案 | 只留 `js/sw-register.js`（它把三条边界写在文件头：`file://` 下不注册、路径相对 `document.baseURI`、装不上照样能玩） |
| 10 | **门面对象里也有重复键**：`window.masyu` 上 `get paused()` 与 `setPaused` 各被并线接了两遍（对象字面量里的重复键不报错，所以它一路躲过了语法扫描，但它是同一类重复） | 各留一份，重复的那份删掉（语义完全相同，删任一份都不改行为）。删前核过门面 27 个键现在全部唯一 |

### 改钉一览（钉的是实数，强度不变）

| 钉 | 旧 | 新 | 为什么变 |
|---|---|---|---|
| `tools/deploy-set.mjs` `EXPECT_CHECKS` | 30 | 43 | 并线把页面要取的东西凑到了 43 条（`index.html` 6 + `manifest` 10 + `css` 1 + `js/main.js` 17 + 其余模块 9），钉停在旧值。**这是「引用条数」这一个实数**，引用多了是加严不是放水 |
| `tools/deploy-set.mjs` `EXPECT_ROWS` | 49 | 77 | 同上，这是「这一跑实际跑的断言条数」这一个实数。引用多了 ⇒ R10 多、位图多 ⇒ P1/P2 逐张核尺寸的断言也跟着多 |

闸的**断言一条没改、强度一条没降**：

- 部署集闸仍然逐条查「页面要去的东西在不在产物里且非 0 字节」（R10）、仍然要求引用条数与断言条数**两个数一起**等于钉在文件里的值（少一条断言就不能是绿的）、仍然逐张核 PNG 容器与声明尺寸（P1/P2）、仍然要求 `og:image` 是**本站**前缀下的绝对 URL 且那张图在产物里（R7）。本仓 R7 的刀（`X11`/`X12`）实测都按预期发力。
- 文档腿 `tools/doctest.mjs` 的**项数一项没动**（233 项 / 18 组，钉在 `tools/doctest.mjs` 与 `tools/verify.sh` 两处锁）。本次只**重钉位置**（把指错位置的引用指回真的地方），没有增删任何一条断言；`D10a` 要求的「名字 + 行号」同现引用条数与那把「截前缀」刀都还在。
- 破坏台账 `tools/sabotage.mjs` **18 把刀一把没少**，每把的靶面与点名正则都没动；连 K17（往拷贝清单里加 `tools`）在新清单下照样逼红 `D17b`。

### 真实文件清单（本次改动的文件）

| 文件 | 改了什么 |
|---|---|
| `js/main.js` | 删远端侧那份暂停块（`let paused` / `setPaused` / `paintPause`）、删 `newGame` 里那句重复的解暂停、删 keydown 链尾不可达的 `N`/`P`、删末尾整段远端侧全屏块、把 `ms` 前缀并进留下的 `toggleFullscreen`、删重复的 `#btn-pause` 接线、删门面上重复的 `get paused()` / `setPaused` |
| `index.html` | 补回 `#btn-sound` 按钮；head 归一（meta 一行一条、og/twitter 用 `art/og.png` 绝对 URL、图标只留真 PNG、去掉 data: URI 的 SVG）；删掉与 `js/sw-register.js` 重复的内联 SW 注册脚本 |
| `manifest.webmanifest` | 取本仓生成器那套：9 枚图标 + 1 张 `art/og.png` 截图 + `scope`/`display_override`/`orientation`/`lang`/`dir`/`categories`，主题色与 `js/theme.js` 的 `Palette` 一致（`#070A14`） |
| `tools/assemble-site.sh` | 位图循环 `icons assets` → `icons art`；`assets/` 进「不进站点的」名单并写清理由 |
| `tools/deploy-set.mjs` | `EXPECT_CHECKS` 30→43、`EXPECT_ROWS` 49→77（钉的是实数，强度不变），并把 43 的构成写进注释 |
| `tools/deploy-set-selftest.mjs` | X1 那一刀的针改为从 `tools/assemble-site.sh` 现取那支 `for d in ...; do` 循环，不再写死目录名 |
| `README.md` | 16 处行号钉重钉；「站点里现在是：…」补 `art`（7 项） |
| `DESIGN.md` | 3 处行号钉重钉 |

**没有新建 README / 总结类 md**（本文件 `deliverable.md` 除外），没有删任何关卡/规则/音效/动效，`js/` 与 `css/` 之外的功能一件没少。

### 删行审计

| 删掉的东西 | 行数 | 为什么能删 |
|---|---|---|
| `js/main.js` 远端侧那套暂停实现 | 25 | 与留下的那份同名同义（本地侧那份多遮罩与音效挂起），留着两份就是双开关 |
| `js/main.js` 远端侧末尾整段全屏块 | 111 | 与留下的 `toggleFullscreen` 同义；它独有的三套前缀探测已并进留下的那份 |
| `js/main.js` keydown 链尾 `N`/`P` 两分支 | 7 | **不可达**：链首已 `return` 掉 |
| `js/main.js` `newGame` 里重复的解暂停 | 2 | 本地侧 `newGame` 本来就重置 `paused`/遮罩/按钮/`fx` |
| `js/main.js` 重复的 `#btn-pause` 接线 | 1 | 同一按钮挂两个处理器 = 按了没反应 |
| `js/main.js` 门面上重复的 `get paused()` / `setPaused` | 4 | 对象字面量里的重复键，语义完全相同 |
| `index.html` 重复的内联 SW 注册脚本 | 18 | 与 `js/sw-register.js` 等价，两份都注册 = 两个答案 |
| `index.html` head 里那枚 `data:` URI 的 SVG favicon | 2 | 本仓已有真 PNG 图标；SVG 既装不到桌面也进不了启动器 |
| `manifest.webmanifest` 远端侧那套 3 枚图标的最简版 | 19 | 换成同一份生成器产的 9 枚图标 + 截图（`sizes` 与 IHDR 逐张量过），不是功能减少 |

净变化：`7 files changed, 87 insertions(+), 213 deletions(-)`（修复 1）+ `1 file changed, 8 insertions(+), 3 deletions(-)`（修复 2）+ 门面去重 + 本交付物。

---

## 验收（命令原样输出）

```bash
$ npm run check
OK check

$ npm test
（rule-test 67 条通过 / pencil-test 7403 条结论推错 0 / counter-test 五节 / generator-probe 五档 ×8 盘）
OK rule-test
OK pencil-test
OK counter-test
OK generator-probe

$ node tools/doctest.mjs
合计 233 项，0 项失败
STAMP groups=18 rows=233 subset=none

$ node tools/sabotage.mjs
KNIVES=18
台账全绿：18 把刀各自逼红了点名的断言，复原逐字节一致，两遍输出相同，干净树对照 doctest 绿。

$ node tools/deploy-set.mjs
部署集：43 条引用（含 10 张位图尺寸核对），失败 0 项
rows: 77 fail: 0

$ node tools/deploy-set-selftest.mjs
基线: rc=0 部署集：43 条引用（含 10 张位图尺寸核对），失败 0 项 rows=77 refs=44 位图引用=17 内联位图=0
X1 assemble 不收位图目录 OK · FAIL R10 icons/favicon-16.png 在部署产物里且非 0 字节  出处 index.html，产物缺 icons/favicon-16.png
X2 模块边改名 OK · FAIL R8 取径上的 js/theme-GONE.js 在仓库根读不到（读不到=这一站根本没扫）  出处 js/main.js
X3 CSS url() 改成绝对路径 OK · FAIL R9 绝对路径 /probe-absolute.css 会在 Pages 前缀下跳出站点  出处 css/game.css
X4 start_url 改绝对 OK · FAIL R4 manifest.start_url 不能是绝对路径  start_url=/probe-absolute-root/ 在 Pages 的 /<repo>/ 前缀下会跳出项目站点
X5 删光 >=512 图标 OK · FAIL R5 manifest 有 >=512 的图标（Chrome 否则不给安装提示）
X6 manifest 少 display OK · FAIL R3 manifest 六个必填字段都在  缺 display
X7 manifest 尺寸与真图不符 OK · FAIL P2 icons/favicon-32.png 实际 32x32 等于声明的 256x256  出处 manifest.icons · 声明被改成 256x256
X13 SKIP · manifest 里没有内联 data:image/png 图标（这一仓的位图都是文件）
X8 pages.yml 不调 assemble OK · FAIL W2 pages.yml 里真的调了 tools/assemble-site.sh  pages.yml 没有 run: bash tools/assemble-site.sh <dir>：CI 拷的是另一份清单，本闸验的不是上线那份
X9 ci.yml 不跑闸 OK · FAIL W4 每次 merge 前的 CI 调这道闸  ci.yml 没有 run: node tools/deploy-set.mjs 这一步：只有部署时才查，坏清单能一路活到上线
X11 og:image 退回相对路径 OK · FAIL R7 og:image 是本站绝对 URL 且那张图在产物里  og:image=art/og.png · README 声明的前缀 https://z-biz-game.github.io/z-biz-game-masyu-cos · og 变成 art/og.png
X12 og:image 的前缀指向别的 slug OK · FAIL R7 og:image 是本站绝对 URL 且那张图在产物里  og:image=https://z-biz-game.github.io/z-biz-game-masyu-cos/art/og.png · README 声明的前缀 https://z-biz-game.github.io/probe-wrong-slug · README 的部署前缀改成 https://z-biz-game.github.io/probe-wrong-slug
X10 注释里的假路径 OK · 散文没被算成引用，条数仍 43、rows 仍 77
DS_SELFTEST rc=0（0=每一刀都按预期发力、阴性对照按预期不发力）

$ bash tools/verify.sh
=== 逻辑闸 tools/doctest.mjs（文档数字 == 代码 / balance / 四套纯 Node 闸的现跑）===
合计 233 项，0 项失败
STAMP groups=18 rows=233 subset=none
=== 逻辑闸 tools/sabotage.mjs（破坏试验台账：每一类谎都要把对应断言逼红）===
KNIVES=18
台账全绿：18 把刀各自逼红了点名的断言，复原逐字节一致，两遍输出相同，干净树对照 doctest 绿。
opened http://127.0.0.1:5276/
boot: masyu 0.1.0 at http://127.0.0.1:5276/
=== boot ===
  11 checks, 0 failed  {'sizeKey': '6x6', 'url': 'http://127.0.0.1:5276/'}
=== render ===
  6 checks, 0 failed  {'pearls': 7, 'edges': 60, 'cell': 76, 'dpr': 1, 'fingerprint': '6x6|2W12W14W15B17B22B29W|3c|e20760064f390c30'}
=== play ===
  35 checks, 0 failed  {'loopLength': 28, 'verify': {'ok': True, 'length': 28}, 'seedBefore': 'gate-play-6', 'seedAfter': 'm1-e23a11ed6727'}
=== marks ===
  16 checks, 0 failed  {'edges': 60, 'savedMoves': 2, 'savedMark': '2', 'fingerprint': '6x6|3W15W17W23B26B31W33B|3c|398c3c7090c93240'}
=== resume ===
  13 checks, 0 failed  {'resumedMoves': 2, 'resumedCuts': 1, 'seed': 'gate-marks-6'}
=== hint ===
  18 checks, 0 failed  {'clicks': 51, 'edges': 60, 'rules': 8, 'loop': 28, 'cuts': 23, 'verify': {'ok': True, 'length': 28}, 'loopLength': 28}
=== pages-prefix ===
  PREFIX-BOARDED at=PREFIXED css=OK canvas=488x488 engine=OK pearls=6
=== deploy-set ===
部署集：43 条引用（含 10 张位图尺寸核对），失败 0 项
rows: 77 fail: 0
=== ALL GREEN ===
```

浏览器闸的读数自证（不是"跑过了"，是"量到了"）：`boot` 量到 `sizeKey=6x6` 与页面 URL；`render` 量到 7 颗珠 / 60 条边 / 题面指纹；`play` 量到落子后 `verify().ok=true`、环长 28、`seedBefore≠seedAfter`（换一局真的换了）；`marks` 量到存档里 `moves=2` 与一条 `'2'`（排除叉）字符；`resume` 量到跨真刷新后 `resumedMoves=2` 与 `resumedCuts=1`；`hint` 量到 51 次点击后引擎推出 8 条规则、23 个排除叉、`verify().ok=true`；前缀形状那一次量到 `at=PREFIXED` / `css=OK` / `engine=OK`（相对路径与动态 import 在 `/<repo>/` 前缀下都没 404）。

### 行为变化需知会

1. **音效开关那颗按钮回来了**（`#btn-sound`，顶栏，M 键同义）。并线把它裁掉过，页面一加载就 TypeError ⇒ 整局不可玩。现在它回来了，文案「音效 关 / 开」与 `aria-pressed` 都与本地侧一致。
2. **暂停的实现是本地侧那套**：按 `P` 或点顶栏那颗 ⇒ 盖层落下 + 计时表真冻结 + 粒子仿真停喂 + 音效挂起 + 状态行写明「计时表停在这里」。远端侧那套（只停计时表、不给遮罩）已经没有了。
3. **全屏三套 API 前缀都认**了（`requestFullscreen` / `webkitRequestFullscreen` / `msRequestFullscreen`）。老 Edge 上按 `F` 现在有反应了；这三台浏览器都没有全屏接口时，按 `F` 会在状态行说清「这台设备没给全屏接口（requestFullscreen 不存在）：这一条我做不到，盘面照常能玩」，盘面照常可玩。
4. **PWA 的图标档位从 3 档变 9 档**，并多了一张 `art/og.png` 的截图声明；`theme_color` / `background_color` 从 `#0a0a12` 改成 `#070A14`（与 `js/theme.js` 的 `Palette` 和页面 `theme-color` 同一批值）。
5. **分享卡片图从 512×512 的方形图标换成 1200×630 的横版 `art/og.png`**（绝对 URL，抓取器不会替 Pages 补前缀）。
6. **线上不再 404 底纹与粒子条**：产物里现在带 `art/`。这是修好，不是新增。
7. **service worker 只注册一次**（`js/sw-register.js`）。行为不变，少一次重复注册。

---

## 未实现 / 需人接手

1. **`no-2x2-square` 是死规则**（DESIGN §6 已记）：192 张出货盘里前件从未成立，权重表里那条 4 分是白挂的。要么给它一条真的会到的形状，要么从 `RULE_ORDER` 与权重表里摘掉——这会改难度分数口径，**不是本次能顺手做的**。
2. **续局那句给玩家的话仍是固定文案**（`js/main.js:330-333`）：`resumeDiscarded.why` 分出的「存档里没有指纹」与「指纹不一致」两种原因没有分开讲。要分开就得改 `js/store.js` 的作废路径与状态行文案。
3. **难度只有总体口径**：p50/p95 是分位数，同一档内部没有分级；「这盘比上盘难」没有说给玩家听的东西（`tools/balance.mjs` 的分数是引擎出口之外的自定义度量）。
4. **出题同步不可中断**：`makePuzzle` 在主线程上跑，10×10 的 p95 是 1341 ms（本机 load1 4.23、15 核；争用机上曾读到 p95 4841 ms）。要给出等待承诺得挪进 worker 并带中断。
5. **本仓的 `sw.js` 取的是远端侧那份**（网络优先 + 免手动 bump 版本号），本地侧那份（额外预缓存 `css/game.css` / `icons/*` / `art/*`）被并线整块裁掉了。两份都是完整实现，差别只在冷启动时预缓存清单的宽窄；本次**没有**把两者合并——那是产品取舍，不是并线修缺，留给人定。
6. **本仓的 `js/main.js` 里有两套并存的难度说明**：`README.md` 抄的难度表是 2026-09-28 那一跑的读数，墙钟那一列是**上界**（本机 load average 30 争用）。重新量用 `SAMPLES=32 node tools/balance.mjs`，`npm run balance` 自己也会重算。

---

## 基线归因记录

| 现象 | 归因 | 证据 |
|---|---|---|
| 整局打不开（白屏） | 并线造成 ES module 同名顶层声明 ⇒ `main.js` 整份不加载 | `node --check` 报 `Identifier 'paused' has already been declared`；`d328b57` 的 `js/main.js` 里 `let paused` / `function setPaused` / `function paintPause` 各两遍 |
| 页面一加载就 TypeError | 并线把 `index.html` 的 `#btn-sound` 裁掉了，`js/main.js` 的启动块与点击接线仍指着它 | `d328b57:index.html` 无 `btn-sound`；`d328b57:js/main.js` 有 `$('btn-sound')` 与 `setMutedUI(Sound.muted())` |
| 按暂停没反应 | 同一按钮两个 click 处理器 | `d328b57:js/main.js` 两条 `$('btn-pause').addEventListener` |
| 线上底纹与粒子条 404 | `tools/assemble-site.sh` 的位图循环写的是 `assets`（本仓的 assets/ 是出图脚本），`art/` 没进产物 | 合并基线跑 `node tools/deploy-set.mjs`：`FAIL R10 ../art/board-texture.png … 产物缺 art/board-texture.png` / `FAIL R10 art/fx-sprites.png …` |
| 文档腿 5 处红 | README/DESIGN 的行号钉是远端侧的行号，并线后代码行号变了 | 合并基线跑 `node tools/doctest.mjs`：`D1f/D8d/D8e/D10/D11` 5 项红，`D11` 点名「`js/main.js:21` 那几行整段是空行」 |
| 部署集闸 2 处红（引用条数与断言条数对不上） | 钉停在远端侧那版的实数 | 合并基线：`R12 实际 35 条` vs 钉 30、`R13 实际 54 条` vs 钉 49 |
| 台架 X1 那刀落空 | 刀针写死了旧清单的目录名 | `needle "for d in icons assets; do" … 命中 0 次` |
| 上面这些**不是**本次改坏的 | 全部在并线提交 `d328b57` 上就成立 | 基线复现：把 `js/main.js`、`index.html`、`README.md`、`DESIGN.md`、`manifest.webmanifest`、`tools/assemble-site.sh` 恢复到 `d328b57` 的样子，上面每一条读数原样复现 |

**环境提示（不是本仓缺陷）**：`tools/verify.sh` 收尾那行 `rm -f "$PROOT/z-biz-game-masyu-cos"`（删临时目录里的符号链接）在本机被运行时的可恢复删除钩子接了，钩子把符号链接解析到仓库根、判定"受保护路径且是当前工作目录"⇒ 拒绝删除并打印提示。临时目录留在 `/tmp` 下，不影响任何闸的结论（那一步之后的 `deploy-set` 与 `ALL GREEN` 都照常打出）。
