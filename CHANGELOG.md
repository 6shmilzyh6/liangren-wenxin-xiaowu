# 版本记录

## 未发布 · 3D 小公主试做线已撤除

- **放弃 Hunyuan3D 图生模型**。用本机 ComfyUI 的 `hunyuan_3d_v2.1` 从立绘生成 GLB，形体是对的（Q 版大头小身、钟形裙、头饰、捧书都复现了），但**单图生成的网格不是干净的可贴图拓扑**：鼻翼与脸颊有凹凸和放射状折痕，平面/球面投影一铺上去五官就糊成一团。试到第 12 版仍只有 30–55% 的完成度，重拓扑的成本远超收益，结论是这条路对小公主不成立。
- **回退内容**：`public/room/app.js` 的 `ensureClaude()` 从「sprite/model 双模式」改回只走 `claude-actor.js`（claudia-pet 的 147 段手绘精灵动画，画风与立绘一致、有真动作）；`__homeDebug()` 去掉 `claudeMode` / `claudeModelReady`；删掉探针接口 `window.__homeCam()`。
- **删掉的实验产物**：`public/room/claude-model-actor.js`、`public/room/_probe-model.html`、`public/room/assets/models/claude-3d.glb`、`prototypes/claude3d/`（373.7 MB，含手写几何 v2–v13 与 Hunyuan v1–v12 全部 .blend/.glb/.png）、`blender-addon/`（手写 bpy 插件，被已装的 dsh-blender 插件取代）、`scripts/hunyuan-img2mesh.mjs` 与配套的 `make-ext*.py` / `prep-input.py` / 输入图。
- **保持不变**：比赛版「故意没做的三件事」里第一条「小公主没有 3D」本来就是既定设计，所以两份包的文案一个字都不用改。
- **`smoke-single.mjs` 修一个真 bug**：进门前必须先填名字（`mode-menu.js` 的 `requireName()` 会忽略空名字的点击），脚本却直接点了「一个人住」，于是永远进不去游戏、`__homeDebug` 永远等不到，第 9 项判定必然失败。补了「菜单能填名字」一步，17 项 → 18 项，18/18 通过。

## 最新版 14 · 礼物分级（方案 C）与双人封面

- **礼物不再自动发放**：`resolveGifts()` → `resolveOffers()`。以前 `minIntimacy` 一到就往 `inventory` 里 push，19 件礼物玩家零选择。现在它只算不写，返回每件礼物的 `{tier, cost, currency, owned, unlocked, affordable, gapCoins, gapIntimacy, reason}`；`growthView()` 多下发 `offers` 与 `wallet` 两块，界面不自己算「够不够」。
- **两段解锁 + 双货币 + 三档**：
  - 币种 **鲸元券**（`whale`，偏小蓝鱼）/ **tokens**（`token`，偏小公主），每天各上限 8 点，攒下的不会清空。
  - 鲸元券三个来源：`streak`（隔天还回来，连签天数 1-3）/ `quiet-sleep`（睡着时没吵她，每 30 分钟 1 点）/ `repeat-talk`（同一句话又说一遍，1 点）。
  - tokens 三个来源：`harvest`（菜园收成，2 点）/ `care-all`（今天该照顾的都做了，2 点）/ `quiet-desk`（她看书时没打断，每 20 分钟 1 点）。
  - 三档：`casual` 2-3 点 4 件 / `careful` 8-15 点 8 件 / `solemn` 25-40 点 7 件。档位由 `minIntimacy` 推出，门槛仍落在十段边界上。
- **`buyGift()` 三道闸**：门槛不到不给买 / 买过不能再买 / 钱不够买不了。任意一道不过都返回一句给人看的 `reason`（「这个还不到日子」「还差 1 鲸元券」），联机与网页入口都把它带回前端 —— 以前这里只会静默 `changed:false`，表现为「点了没反应」。
- **`HOME_ACTIONS` 加 `buy`**，同时补上三处转发：`bridge.js:4495` 的 `gift: body.gift`、`home-engine.js:89` 的 `gift: input.gift`。少传一个就是那条经典静默失败。
- **钱包归一化**：`walletBase()` + `normalizeWallet()` + `growthOf()` 三重兜底。老存档没有 `wallet` 字段，不补就是进游戏 `undefined` 而不是 0；`wallet.src` 记「今天每个来源发了多少」，`earned` 记每个币种今天攒了多少，`tick` 记按时间计的来源攒到哪一格（不存的话 5 分钟一次的轮询永远攒不满 30 分钟）。
- **`streakDays` 终于有写入点**：原来它只在 `normalizeGrowth` 与 `growthView` 里出现，没有任何地方写。现在 `accrueReturnStreak()` 按「上一次 tick 到现在的真实间隔」判断（不是 `elapsed` —— 那个被 `MAX_ELAPSED_HOURS` 截到 8 小时，离线一天回来看起来只过了 8 小时）。
- **菜园第五个标签「礼物」**：`garden-ui.js` 顶部两个钱包数字（`leftToday === 0` 标「今天攒满了」），下面按三档分成三段。按钮文案是状态而不是价格：`在你这儿了` / `还不到日子` / `还差 N 鲸元券` / `N 鲸元券`。文案不写「花 30 点买到了钥匙」，写「放在她手边」。
- **离线补偿的坑**：`advanceHomeState` 里 `elapsed` 截到 8 小时，但「隔天还回来」必须用未截断的 `rawGap`，所以两者分开算。
- **`once` 来源一天只结算一次**：`care-all` 的条件满足后会一整天成立，不拦就是每个 tick 再发一遍。
- **成就三条**：`wallet-whale` / `wallet-token` / `gift-careful`，全走 `kind:'note'` + `flags`，在 `profile.noteAction()` 里当 `action==='buy'` 时落标记。`DAILY_TASKS` 的 `id` 与 `goal` 一个字没动（`profile.js:143` 用 `d.today.tasks[t.id]` 判定，改 id 会让所有玩家今日进度归零）。
- **作弊码**：`yu-wallet N`（两种货币各给 N 点）、`yu-gift`（把货架摆满，只发随手档）、`yu-all` 顺带补 200/200、`yu-reset` 连钱包一起归零。
- **exe 图标换双人构图**：新脚本 `game-src/make-icon.mjs`，两张立绘各按 alpha 包围盒裁掉透明边，并排贴进正方形，导出 16/32/48/64/128/256 六层打包成 `.ico`（Vista 以后每层直接存 PNG，小尺寸不丢 alpha）。同时留一张 `public/room/assets/ui/app-icon.png` 给托盘运行时读 —— `Launcher.cs` 的 `BuildTray()` 改成「app-icon.png 优先、idle.png 兜底」。
  原来 `ensureIcon()` 直接居中裁 `idle.png`，那张里只有小蓝鱼一个人，桌面图标和「两人温馨小屋」这个名字对不上。`pack.mjs` 的 `ensureIcon()` 现在没有 ico 就调 `make-icon.mjs` 现场生成，不再复制一遍裁剪逻辑。
- **Steam 商店图重新构图**：`steam-src/make-art.mjs` 加 `Draw-Pair()`（同一条 alpha 包围盒思路），两张立绘靠右下、左边留竖带给标题 —— 第一版两个人居中，标题正好压在小公主脸上。窄尺寸（`small-capsule` 231×87、`community-icon` 184×184）不再写字，那几个尺寸上任何中文都糊成一团。副标题从「大平层 · 一间会自己过日子的房子」缩成「大平层 · 她会自己过日子」，一行放得下。
- **两份分发包**：`pack.mjs --zip` 现在同时打
  `两人温馨小屋-分享版.zip`（exe + 玩家 README）与
  `两人温馨小屋-比赛版.zip`（exe + README + `评委说明.txt` + `玩法说明.txt`）。
  评委说明里放的是：三十秒上手、作弊码全表、**故意没做的三件事**（小公主没有 3D 是决定不是 bug / 对话不调模型 / 内部目录名不改）、自己验收的六条命令。
- **修掉两条一直红的断言与两个真 bug**：
  - `test-pack.mjs` 期望 `双击玩单机.cmd` / `启动联机版.cmd`，而 `pack.mjs` 早改名为 `快速启动.cmd` / `启动联机服务器.cmd` —— 一条真断言变成了永久红灯。
  - `server.mjs` 的 `findSourceRoot()` 从 `HERE` 一路往上找 `<dir>/game-src/server/server.mjs`，于是分享包只要恰好解在源码树里（`dist/大肥鱼书房/` 就是这种），就会把存档写进 `game-src/server/data`，交付包里永远没有 `data/`。改成只认「这个文件自己就躺在 `game-src/server/` 里」。`test-pack` 从 14/16 变 16/16。
- **测试**：`check-progress` 51 → 57 条（礼物 cost/currency/tier 齐备、币种都在 `wallet.currencies` 里、两种货币都有来源且各给 ≥3 件定价、三档各 ≥3 件、每件价格落在自己那档区间内、每种货币有每日上限）；`verify-growth` 28 → 32 条（门槛不到不给买 / 钱不够买不了 / 买过不能再买 / 买完进背包且次日回礼到玄关）。`test-home` 27、`test-room` 22、`verify-online` 24、`test-pack` 16 全绿。
- **真机验证**：`game-shots/probe-gift-click.mjs`（新增）在无头 Edge 里走真实点击路径 —— 点「一枝花」后钱包 10→8、`inventory` 出现 `g01-flower`、`/api/home/state` 的 `events` 里有「验收把一枝花放在她手边（鲸元券 −2）」。截图 `game-shots/garden-gift-click.png`。

## 最新版 13 · 两个人的小柜子与状态联动

- **同行账本（`together`）落成**：挂在 `homeState` 顶层，存 `{day, sessionMs, totalMs, points, pointedMs, claimed, unlocked, notes, lastAwardAt, restedUntil}`。四条链路：①每满 10 分钟给 `baseGain 0.3 × fatigueFactor` 亲密度（走 `growBy`，不吃重复系数 —— 它不是「同一动作又做了一次」）；②每 30 分钟 +1 点，一天封顶 8 点；③五个里程碑（3 小时「并肩」/10 小时「双人长椅」/25 小时「两张电影票」/60 小时「同行者」/150 小时「合照」）；④久玩时她开口劝（60 分钟「坐太久了」、120 分钟「电视我先关了」、180 分钟直接去睡）。
- **`MAX_ELAPSED_HOURS = 8` 的坑**：离线一天回来 `elapsed` 会被截到 8 小时，直接累加等于白送 8 小时同行。`togetherOf` 里加了「`gap > breakMs`（30 分钟）视为断开」的闸门，断开就一分不加，只清 `sessionMs`。
- **同行点数必须按 `sessionMs` 累计算**：第一版拿单次 `gap` 除 30 分钟，永远除不满 —— tick 一分钟一次，实测 40 分钟只拿到 0 点。改成 `earnedTotal = Math.floor(sessionMs / pointPerMs)` 与 `pointedMs` 比差值。
- **`normalizeCharacter` 里一个潜伏 bug**：原代码 `out.lastEventAt = {}` 之后又遍历 `out.lastEventAt`，等于每次 normalize 都把冷却表抹掉 —— 所有 `emit` 冷却全部失效（实测 `tired` 在 60~65 分钟连写 6 条）。改成读 `raw.lastEventAt` 后，65 分钟只 1 条。
- **状态↔好感联动**：新增 `needScoreOf(needs)`（五项加权取**最大**值，不取平均 —— 一个需求崩了就该触发，不被另外三项稀释）、`careFactorOf` / `strainFactorOf` / `stateFactorFor`。照顾她的动作（feed/water/heal/pet/sleep/wake）最高 ×2.5，勉强她的动作（play/talk/command/go/place）最低 ×0.4。**只对玩家动作生效**，她自己过日子的 `effect` 恒为 1，否则「她自己喝水也拿 2.5 倍」。
- **状态不好会说出来**：`advanceCharacter` 里按 0.4/0.65/0.85 三档做跨档检测，跨档才 `emit(c,'need',...)`（冷却 40 分钟，同档不重念）。文案从五项里挑最严重那一件说，不列清单。
- **HUD 提醒**：`characterView` 下发 `state: stateFxView(c)`（`needScore` / `careFactor` / `strainFactor` / `band` / `top` / `topWord` / `line`），页面据此挂 `.need-hint`（`critical` 时额外加一句「这时候照顾她，比平时管用得多」）并把 `.her-panel` 标 `strained`。提醒用她自己的口吻，不是系统告警。
- **菜园第四个标签「两个人的小柜子」**：花同行点数换三样 —— 一份小点心（2 点，不占今天的喂食次数）、一张便条（3 点，写完真的贴到记忆墙）、一次主动串门（5 点，让另一位立刻走过来）。每项一天一次。
- **小柜子踩到的三个真实 bug**（都已修）：
  1. `HOME_ACTIONS` 白名单里没有 `claim` → 三个入口（`bridge` / 单机 `net-shim` / 联机 `server`）全 400。加了 `'claim'`。
  2. `game-engine.act()` 转发给 `applyHomeAction` 时没传 `offer` → 后端 `find` 不到，一路 `changed:false`，界面上表现为「点了没反应」。补 `offer: input.offer`。
  3. `text` 只对 `talk` 放行 → 便条正文被抹成空字符串，落回 `offer.label`，墙上出现「一张便条」这种只有商品名的东西。改成 `talk` 与 `claim` 都保留，并把 `note` 分支真的写进 `together.notes`（原来只拼了句「贴到墙上」，墙上什么都没出现）。
- **`setMemoryNotes` 加了内容签名短路**：它每帧状态刷新都会调，原来每次都新建 canvas 纹理再 dispose 旧的，纯属抖内存。顺带修掉「便条删了墙上还留着」——原来只有 `memLines.length` 非空才调。
- **左右侧动作失配（用户报的那个）**：
  - `index.html` 原有 `body.side-her #meetBtn{display:none}`，等于在小蓝鱼页面上把「双人」玩法关掉了。删掉。
  - 小公主的九项动作原来只映射到六个 gesture（pet/feed/water 全指 `fold`/`tea`/`tea`，sleep 和 pet 都是 `fold`，wake 和 lamp 都是 `wave`）。改成 `pet:patShy / feed:patJoy / water:hum / play:happy / talk:curtsy / sleep:stretch / wake:yawn / lamp:look / meet:wave`，`GESTURES` 表从 6 项扩到 16 项，`playGesture` 按片段是否 loop 决定 `once`。`star` 从「开心蹦跳」改成「抬眼望过去」（原来点「抬头看星星」演的是蹦跳）。
- **投屏开场白**：投屏开始时她主动说 2~3 句（`tvOpeningPrompt`，第 1 句必须点名画面里真实看得见的东西）。原本 60 秒轮询一次模型，现在一场两小时投屏从 120 次调用降到 1 次。**「观后感」按钮原来是假的**（走本地随机池，根本不看画面），现在真的走接口，随机池降级为失败兜底。
- **第五聊天通道「一起看」**：`home-room-tv-v1`，投屏时她说的话单独存，和私聊/群聊/玩家互通并列。
- **封面手牵手**：`mode-menu.js` 的 `.m-pair` 两侧各 `-3.5%` 重叠 + 中间叠一枚 `assets/ui/hand-hold.svg` 交握手线稿（160×100，冷调手腕 + 暖调拇指）。3.5% 是「手碰到、脸不碰」的临界值。`.m-solo` 时自动隐藏。
- **菜园不再是谁一个人的**：`garden-ui.js` 两处标题改成「我们俩的菜园」、eyebrow 加「两个人一起种」、`garden-world.js` 的 3D 名牌、`garden-state.js` 的开张日志同步改；`stewardshipTitle`（谁在照料）仍分人，因为玩家要知道派的是谁。
- **作弊码补一条**：`__cheat('yu-together 20')` 直接给同行点数（演示小柜子用），走新加的 `applyTogetherCheat` + `home-engine.cheatTogether`。
- **测试**：`test-home` 27、`test-room` 22、`verify-growth` 28/28、`check-progress` 51/51、`smoke-menu` 三入口、`smoke` 进游戏正常；新增 `game-shots/probe-together-click.mjs` 用真实浏览器点一遍小柜子（stub `window.prompt`），实测「便条按钮变『已经换过』、feedback 显示写进去的那句话、`/api/home/state` 的 `together.notes` 里有原文」。

## 最新版 12 · 参赛分发与作弊码

- **新增 `game-src/pack-portable.mjs`**，两种不需要 exe 的分发形态（都不会撞 SmartScreen / 智能应用控制）：
  - **itch 包**：`game/` 原样压成 zip（`index.html` 在根上），上传 itch.io 后勾「This file will be played in the browser」。119.2 MB，免费账号上限 1 GB。实测纯静态托管（`/api/*` 全部 404）能完整进游戏、立绘 `readyState` 正常、存档落 localStorage；子目录部署（`/games/warmhouse/`）同样通过。
  - **便携包**：`node.exe` + `game/` + `快速启动.cmd`，解压后双击即可，不用装 Node。212 MB / 压缩后 152.7 MB。`node.exe` 是 `process.execPath`（v24.22.1，OpenJS Foundation 签名），`start.mjs` 只 import 五个 `node:` 内置模块，无 node_modules 依赖。cmd 按 GBK 写入（首字节 `0x40`，无 BOM）。
  - npm 脚本：`game:portable`（两个都打）、`game:itch`（只打 itch 包）。
- **便携包结构的一个坑**：`start.mjs` 的 `ROOT = HERE`（它自己所在目录），所以必须和 `index.html` 同级。第一版把它放在包根、游戏在 `game/` 子目录，启动时报「这个目录里没有 index.html」。改成放进 `game/` 里，`快速启动.cmd` 调 `"%~dp0game\start.mjs"`。
- **新增作弊码**（`game-src/shell/cheats.js`），只在控制台暴露，界面上不放按钮：
  ```
  __cheat()              列出所有码
  __cheat('yu-all')      满级 + 满亲密度 + 金币 + 时长
  __cheat('yu-level 30') 等级直接到 30
  __cheat('yu-full')     亲密度拉满
  __cheat('yu-coins 999')菜园金币
  __cheat('yu-live 600') 在线时长（分钟）
  __cheat('yu-reset')    清回初始（成就保留）
  ```
  分三层写入口，各写各的层：`profile.cheat()` 管经验/亲密度/时长/签到，`home-engine.cheatGrowth()` 管 home-state 的 `growth`，`home-engine.cheatGarden()` 管金币/堆肥/种子。每条都落盘并走 `resolveUnlocks` / `tick`，否则下次结算会覆盖回去。
- **作弊码踩到的真实 bug**：第一版只改 `profile.aff`，控制台报告「亲密度已拉满 100」但界面仍是 0 —— 页面上的「和她」读的是 home-state 的 `growth.intimacy`，和 `profile.aff` 是两份。这也是「和她只有一个数」那次改造留下的结构，作弊码必须两份都写。修完实测：`aff=100`、面板 `100`、段位「交给你了」、重开游戏后仍在。
- **`src/home-state.js` 新增 `applyGrowthCheat(state, patch, now)`**：只写 `growth` 里的 `xp` / `intimacy` / `lastGrowAt`，不动房间、需求、事件（免得作弊打断她正在做的事），并补 `resolveGifts` 让礼物一次性到位。
- **等级曲线不再抄常数**：`cheats.js` 的 `totalXpToLevel` 从 `assets/data/progress.json` 的 `levelCurve` 读 `base` / `step` / `max`。第一版硬编码 120/60，改配置就会悄悄不同步。
- **顺手清掉死代码**：第一版写了个 `xpForLevel()` 用二分调 `profile.cheatProbe`，那个方法根本不存在，整个函数永远走 `break` 返回 0。删掉。
- **测试**：`test-room` 22、`test-home` 27、`verify-growth` 28/28、`check-progress` 51/51、`game verify` 25/25、`smoke-menu` 三入口、`smoke` 进游戏正常。

## 最新版 11 · 两人温馨小屋

- **改名**：游戏统一叫「两人温馨小屋」。改到的地方：主菜单标题（`mode-menu.js`）、进门引导（`game-shell.js`）、页面 `<title>` 与 `<h1>`、`<title>` 的构建替换规则（`build.mjs`）、exe 文件名（`pack.mjs` / `smoke-single.mjs` / `verify-desktop-exe.mjs`）、启动器窗口标题/托盘/快捷方式名（`Launcher.cs`）、服务器启动横幅、Steam 构建与商店文案（`steam-src/*`）、`VERSION.txt`（GBK 编码，写回时用代码页 936，不能改成 UTF-8）。
- **内部路径刻意不动**：`dist/大肥鱼书房/` 与 `%LOCALAPPDATA%\dafiyu-house` 保持原名。存档按 origin 落盘、验收脚本按路径找产物，改名等于让老存档找不到家。`CHANGELOG` 里版本 9 的「小蓝鱼的家.exe」是当时的事实，不改。
- **进门必须定名字**：`identity.js` 加 `nameSettled()`（localStorage 的 `dafiyu-name-set`），`mode-menu.js` 加 `requireName()` —— 空名字点按钮不进门，输入框抖一下把光标放回去。三个入口（单机 / 联机服务器 / 双人开房或进房）都拦。以前空名会静默回落成「小屋访客」，两个人都不改名时就都叫这个，事件面板分不清谁做的、按名字记的账也会合并成一条。进房后仍可改名（`app.js` 的 `promptActorName`），但不能再改回空。
- **存档面板**：`profile.js` 新增 `saveInfo()` / `keepSave()` / `addLivedMs()`，`emptyProfile` 补 `livedMs` 与 `kept` 两个字段（老档 normalize 时补默认值）。面板存档页摊开「上次玩到 / 陪了她多久 / 现在几级 / 收下几条成就」，并给「保留存档」开关。以前只有自动写盘，玩家不知道进度还在不在。
- **在线时长**：`game-shell.js` 每 30 秒记一次，`document.hidden` 或间隔超过 5 分钟不计入（挂机刷时长没意义）。
- **「和她」只剩一个数**：`app.js` 的 HUD 从 `roomView.affection` 改为读当前指挥对象的 `growth.intimacy`，读不到才回落；`game-shell.js` 的 `#gxBar` 通过 `__gameLiveAffection()` 读同一个数。以前两处各读一份账 —— 摸三次头会显示 9 和 4.25。
- **修复 `poke` 增益被取整翻倍**：`profile.js` 的 `clamp` 原来是 `Math.round`，0.5 会被翻成 1，连戳十下能拿满 10 点（该给 5 点）。改成两位小数，上限也改为读 `intimacy.max` 而不是写死 100。
- **修复 `aff-60` / `aff-90` 两条成就**：60 不落在十段任何边界（45 是「会等你」、56 是「默契」），90 又与 `stage-entrusted` 同 label（「离不开」会在 79 和 90 各解锁一次）。删除，段位成就统一由 `stage-*` 表生成，`bumpAffection` 也改成按十段边界解锁。
- **修复 Claude 立绘 poster 丢 alpha**：`claude_idle.png` 原本不存在（只有 webm），第一次抽帧用默认 pix_fmt 得到 RGB 无 alpha，82.8% 是键控绿，poster 露出来就是一整块绿。改用 `-c:v libvpx-vp9` + `-pix_fmt rgba` 重抽，现在透明 82.8%、绿像素 0%、`colorType=6`。
- **新增「今天的账」**：`home-state.js` 的 `growBy` 补 `action/base/times/repeat/decay/factor/capLeft/capped/dailyCap`，`growthView` 用 `cleanLastGrow` 白名单透出 `lastGrow`。`app.js` 点开「和她」那栏就能看到这一下为什么只涨这么点（标称多少、今天第几次、按百分之几记、今日额度还剩多少），四种原因各有独立文案，不用系统口吻。
- **修复 `decay` 显示错误**（自己引入又自己修的）：原来在 `g.intimacy` 已被改写后才重算边际系数，账本上写的是「加完之后下一个百分点」的衰减率 —— 首次摸头显示 `×0.98` 而实际生效的是 `1.0`。改成改值之前取。
- **新增「还差多少」**：`clipLockReason` 从返回一句话改为返回 `{line, level, intimacy, short, gapLevel, gapIntimacy}`，`growthView` 下发对象而非字符串。前端 `clipLocked()` 的 `fromServer?.level` 终于能取到值 —— 以前服务端下发字符串，读 `.level` 永远是 `undefined`，于是每条都静默回退本地表，看着没坏但那份权威数据一直没被用上。抽屉里 110 个锁着的片段现在显示「两样都差一点。（还差 17 级、34 点）」。
- **新增重复对话不静默**：同一句话 30 分钟内重复（`talkDedupMs`），她换一句应你（三句池，按句子长度取模，同一句永远得到同一个反应），气泡压到 2600ms。数值仍不重复记。以前回应跟平时一模一样，玩家只会觉得「没反应、卡了」，于是开始刻意换说法。
- **修复 Windows 上永远为红的 0600 断言**：`test-room.mjs` 与 `test-home.mjs` 的 `statSync().mode & 0o777 === 0o600` 在 NTFS 上不成立（ACL 不映射到 mode 位，chmod 后仍报 `0o666`）。按平台跳过并写明原因。
- **测试**：`verify-growth.mjs` 从 19 项加到 28 项（lastGrow 带系数、第 6 次系数归零、实得=标称×系数、capped、同文 deduped、超窗重记、锁值带门槛与缺口）。`test-room.mjs` 加 5 项（账本容器与渲染函数在页面上、账本文案不说系统口吻、`growExplain` 六种分支各说对）。`menu-drive.mjs` 的 `pickMode` 在点按钮前替验收脚本填名字。
- **实测**：`test-room` 22、`test-home` 27、`verify-growth` 28/28、`check-progress` 51/51、`game verify` 25/25、`smoke-menu` 三入口、`smoke` 进游戏正常。

## 大肥鱼房子最新版 9

- **单文件绿色版**：`game-src/launcher/Launcher.cs` 同一份源码编出两个 exe。打包时把整个 `game/`（82.1 MB）用 `Compress-Archive` 压成 zip，再用 `csc /resource:game.bundle.zip,dafiyu.bundle` 当嵌入资源编进 `dist/小蓝鱼的家.exe`（79.0 MB）。玩家拿到一个文件，拖到桌面双击就玩，不需要文件夹。
- 启动时 `ResolveRoot()` 先看 `--root`、再看 exe 旁边有没有 `index.html`，都没有才 `ExtractBundle()` 从嵌入资源解出来。这样同一份源码既能当文件夹版（`开始玩.exe`）也能当单文件版。
- `ExtractBundle()` 解到 `<workRoot>\app\<version>\`，version 是 `game/` 全部文件的「名字 + 大小」的 sha256 前 12 位（不是时间戳）—— 内容没变就不会让所有人重解一遍 82 MB。流程是解到 `<version>.part`、写完 `.ok` 再 `Directory.Move` 过去，所以中途关掉不会留下半个包；`PruneOldVersions()` 顺手清掉旧版本目录。
- `PickWorkRoot()`（可写目录回退链）：依次试 `DAFIYU_HOME` 环境变量、`%LOCALAPPDATA%\dafiyu-house`、`%TEMP%\dafiyu-house`、exe 旁边，每处都真写一个 `.wtest` 验证能写才用。首选位置被域策略/安全软件挡住时自动往下退，不至于"点了没反应"。
- 托盘菜单加「在桌面放个快捷方式」（`CreateDesktopShortcut()`，借 WScript.Shell 写 `.lnk`，图标用 `icon.ico`）。玩家直接从别处拖 exe 到桌面是没有游戏图标的，这个补上。
- 解压期间 `--no-open` 时不弹 splash、不建托盘，脚本化验收才跑得动；出错不再静默，`LogError()` 写 `launcher-log.txt`（`ERROR ` 前缀），位置跟解压目录同一处。
- `ProbeExisting()` 从扫 40 个端口收窄到 10 个，connect 等待 120ms → 80ms、读超时 600ms → 400ms：二次启动 5.51s → 3.01s（实测）。
- 打包脚本 `game-src/pack.mjs`：`buildLauncher()` 补 `/r:System.IO.Compression.dll`、`/r:System.IO.Compression.FileSystem.dll`、`/win32icon:`；新增 `ensureIcon()`（从 `game/assets/pet/idle.png` 居中裁 256×256 存 `game-src/launcher/icon.ico`，有就复用）与 `buildSingleFile()`。`--zip` 改成只装 `小蓝鱼的家.exe` + `README.txt`（两个形态都打要 160 MB，收到的人还得先选），文件夹版留在 `dist/大肥鱼书房` 里自用；包名跟着改：`小蓝鱼的家-分享版.zip`。
- `README` 重写开头：先讲「拿到的是哪个形态」（单个 79 MB 的 exe / 一个 61 KB 的「开始玩.exe」+ 文件夹），再加一节讲单文件版的首启、升级、托盘放快捷方式。`dist/README.txt` 与 `dist/大肥鱼书房/README.txt` 各放一份。
- 新增 `game-src/smoke-single.mjs`（17 项）：把 exe 复制到一个"只有这一个文件"的空目录里当桌面用，验首启自解、解压结构（`index.html` / `game.js` / `.ok` / 唯一版本目录）、首页与 `game.js` 与 `assets/pet/idle.webm` 都取得到、真浏览器点单机能进游戏且立绘 `readyState=4`、控制台无异常、二次启动不重解、版本目录没变多。本机沙箱不让子进程写 `%TEMP%`，所以用 `DAFIYU_HOME` 钉到 `.smoke-single/`。
- 实测：单文件版首启 2.1s（包已解开过；全新机器十几秒）、二次启动 1.1s、`小蓝鱼的家.exe` 82863616 B、zip 79.0 MB、`smoke-single` 17/17。
- `.gitignore` 补 `.pack-single/`、`.pack-zip/`、`.smoke-single/`、`.test-home/`。

## 大肥鱼房子最新版 8

- 双人不再需要同一个网：`game-src/shell/duo-link.js` + `net-duo.js` 走 WebRTC DataChannel 直连，公共 PeerJS 云只做房间号配对信令。房主拿 6 位房间号、对方输码进屋，两人看到的是同一间屋子；不需要公网 IP、不用开端口、不用内网穿透、不用装 Node。房间号字母表去掉了 `0/O/1/I/L`（`ALPHABET='23456789ABCDEFGHJKMNPQRSTUVWXYZ'`）
- 房主权威：屋子跑在开房那台电脑上（`home-engine` + `profile`），客人把每个 `/api/*` 经通道转给房主执行。不各跑一份再合并 —— 那样时钟、随机、自主行为都会分叉，会出现"她在这边睡觉、在那边种地"
- 玩法改成游戏内选：`game-src/shell/mode-menu.js` 开场就是菜单（🐟一个人住 / 👥两个人住 / 🖧连联机服务器），`main.js` 不再按 `location.protocol` 猜玩法。选完、并且需要联网的模式真的连上了，才继续往下走
- 掉线自己接回来：心跳按"最后一帧到达时间"判活（`SLOW_MS=9000` / `STALE_MS=20000`），不靠 rtt —— 浏览器休眠或拔网线时 `send` 照样不报错。客人侧指数退避重连 3/6/12/24 秒共 4 次，恢复后 inflight 请求自动重放
- 「屋里的人」面板抽出成 `net-ui.js`，联机与点对点共用：在线名单、动态播报、两人私聊、连接状态条（等对方进来 / 正在连 / 对方断开了 / 网络有点慢），以及「离开这间屋子」
- 不能直接双击 `index.html`：file:// 页面里读进来的视频/图片算跨源数据，浏览器不许拿去当 WebGL 贴图，立绘和 3D 模型会整片空白（实测见 `game-src/probe-taint.mjs`：`texImage2D` 抛 `SecurityError`，`fetch` 连本地文件都拿不到）。所以正式包改成双击 `开始玩.exe`
- `开始玩.exe`（`game-src/launcher/Launcher.cs`，C# 单文件，15KB）：在本机起一个只监听 `127.0.0.1:8787` 的静态服务再打开浏览器。端口写死是因为存档按 origin 存，换端口等于换存档；已在跑再双击不会起第二份，而是把浏览器指过去；关闭标签后托盘里再等 90 秒无人使用才退出；支持 Range 与缓存头，托盘图标取 `assets/pet/idle.png`
- 分享包布局简化为"一个文件夹，双击就玩"：`开始玩.exe`、`index.html`、`game.js`、`garden.css`、`assets/`、`README.txt`、可选的 `server.mjs` + `启动联机服务器.cmd`（旧的 `双击玩单机.cmd` / `启动联机版.cmd` 已删除）
- 主菜单会按打开方式给提示：file:// 出黄色警告说明立绘会空白；`连联机服务器` 只有真的探到 `/api/home/state` 才出现（不能只看协议 —— `开始玩.exe` 起的本机服务也是 http:// 但没有 /api）
- 验收脚本：`smoke.mjs`（单机冒烟）、`smoke-duo.mjs`（双开 + 掐断重连）、`smoke-http.mjs`（走 exe 的真实路径，readyState 必须 ≥2 才通过）、`smoke-menu.mjs`（三种打开方式的菜单差异）、`smoke-visible.mjs`（真窗口双开 + 截图）；`probe-taint.mjs` 记录 file:// 跨源证据
- 修「屋里的人」名单慢半拍：`net-online.js` 心跳原来 8 秒才打第一拍，刚进屋时名单里只有自己，状态条显示「你在屋里」而不是「2 人在屋里」→ 改成先打一拍、之后 4 秒一次（`beat(); setInterval(beat, 4000)`），并把 `globalThis.__net` 补上 `state: netState` 好让验收读
- 修动态被心跳冲空：`net-ui.js` 的 `absorbNet` 原来无条件写 `players/feed`，而 `/api/net/presence` 只回名单不回动态，于是每 4 秒一拍就把刚收到的「谁做了什么」清成空数组，面板永远显示"屋里还没有新动静"→ 改成按字段判断（`if (Array.isArray(...))`）
- 修「进屋」偶发失败：对方刚开完房时公共信令还没登记好他的 id，`peer.connect` 会误报 `peer-unavailable`（玩家看到的是"没有这个房间号，或者对方已经关掉了"）。`duo-link.js` 的 `join()` 改成可在同一个 peer 上再拨三次（间隔 900ms），只有真的三次都失败才报错 —— 不能靠重开 `startDuo` 重试，那会多挂一层 fetch 包装、前一层的 link 已经死了
- 修 `ui-kit.js` 的 `el(tag, cls)` 丢第三参：`game-shell.js` 有 51 处按三参调用，导致「离开这间屋子」渲染成没有字的空按钮
- 清掉 `src/home-state.js` 里两处重复键（`HOME_LAYOUT` 的 8 个 `study_*` 站位整段重复、`ARRIVALS.studyRead` 连续两行相同），构建与打包现在零警告

## 大肥鱼房子最新版 7

- 独立游戏包：新增 `game-src/`，把房间页与全部行为逻辑（`src/home-state.js`、`src/garden-store.js`、`src/garden-autonomy.js`、`public/room/garden-state.js`）用 esbuild 压成一份浏览器能跑的 `game.js`，只把 `node:fs` / `node:path` 换成内存虚拟文件表（`engine/storage.js` + `shims/`），行为逻辑一行未改；产物不再需要 DSH，也不需要桥接
- 两种玩法共用同一份产物：`file://` 双击打开是单机（存档在 localStorage），`http://` 打开是双人联机（存档在服务器），分支在 `game-src/main.js` 按 `location.protocol` 决定，不用打两份包
- 联机服务器 `game-src/server/server.mjs`：静态托管 + 状态唯一源。两人照样 1.2 秒轮询同一个 `/api/home/state`，谁做了什么由服务器推成玩家动态流（`net.feed`）随轮询下发；等级、亲密度、菜园进度共享，右下角「屋里的人」面板显示在线名单、最近动态与两人私聊；联机时不提供导出/导入/重开，避免一方清空另一方的进度
- 能直接发给别人的分享包：`game-src/pack.mjs` 把服务器 esbuild 成单文件 `server.mjs`（只依赖 Node 内置模块），配 `双击玩单机.cmd`、`启动联机版.cmd`、`README.txt`，数据落在分享包自己的 `data/`；同一份 `server.mjs` 既认得源码布局也认得分享包布局
- 批处理按 GBK 落盘：`cmd.exe` 用当前代码页逐行解 `.cmd`（中文 Windows 是 936），存 UTF-8 会整段乱码，`chcp 65001` 写在文件里也来不及；node 的 UTF-8 输出改用临时 `chcp 65001` 区间包起来
- 验收脚本固化：`verify.mjs`（单机 25 项）、`verify-online.mjs`（联机接口 24 项）、`verify-duo.mjs`（两个独立浏览器 = 两台设备，24 项）、`test-pack.mjs`（直接跑 dist 里那份单文件服务器，16 项）；后三者认 `DAFIYU_SERVER` 环境变量，可以指着分享包里的 `server.mjs` 验

## 大肥鱼房子最新版 6

- 大小姐造型：小公主从 Q 版重做成修长大小姐（站高约 1.5m、头身比约 6）：赤陶长卷发 + 侧分刘海与呆毛、A 字长裙 + 赤陶滚边、束腰胸衣、高领衬衣与领口缎带胸针、及肘长手套、低跟短靴、右侧缎带蝴蝶结头饰与星形发夹；脸改成细长杏眼 + 眼下小痣
- 她要演不要换图：新增 `playGesture()`（收裙欠身 / 抬手招呼 / 捧着书读 / 抬头看星星 / 双手交叠 / 端着茶），右侧面板换成「大小姐的姿态」六个姿态按钮，动作时配表情
- 各守一端：地址加 `?as=claude` / `?as=her` 锁死那一侧，`body.side-locked` 下「指挥」开关与立绘/画质/视角/气泡控件全部隐藏，点击只提示；两侧私聊标签也各只剩自己那一个
- 两端区分度：大小姐端整套换成暖陶纸配色 + 宋体衬线（`body.side-claude`），面板词也换（精神 / 饱腹 / 口渴 / 倦意、她的近况、和她的亲近），小蓝鱼端仍是深蓝玻璃 + 无衬线
- 镜头与命中跟着人：`focusCharacter()` / `updateCamera()` / `charHit()` 全部改成认「这一端的那位」，锁定端镜头只围着这一位转，点人/长按拖动也只作用在这一位身上
- 114 个动作：把 dsh-pet 的 114 个立绘 webm 全部收进 `public/room/assets/pet/extra/`，`pet-clips.js` 输出 `EXTRA_CLIPS / CLIP_LABELS / CLIP_GROUPS`，右侧「全动作抽屉」按九组铺开，点一下就地播放
- 验收脚本：`scripts/side-probe.mjs`（读两侧界面差异）、`scripts/side-shot.mjs`（截图 + 像素配色统计）、`scripts/side-interact.mjs`（点地面 / 摆姿态 / 长按拖动三步实测）

## 大肥鱼房子最新版 5

- 双人共居：新增第二位住户 **Claude 小公主**（暖橙 + 奶油白配色的程序化 3D 角色，带皇冠、耳侧星形发夹、后腰蝴蝶结），与小蓝鱼同住一屋
- 独立状态：两人各自一套饥饿 / 口渴 / 精力 / 膀胱 / 不适、独立日程表（起床、洗漱、小书桌、吃饭、地毯小睡、看书、电视、回床）、各自的床铺与躺姿朝向
- 指挥切换：右上「指挥」按钮切换当前对象，点房间 / 点地面 / 摸头 / 喂食 / 倒水 / 陪玩 / 哄睡 / 叫醒 全部作用于选中的人；右侧面板与事件列表跟着换人
- 串门互动：新增 `meet` 动作与「去串门」按钮，走到对方身边 0.62m 处停下说一会儿话（对方睡着自己轻声走开）；两人都闲着时会自主串门
- 双人私聊：私聊面板拆成「小蓝鱼 / 小公主」两个标签，各自独立会话文件与记忆条目；小公主人设温柔轻软、不争抢、不自称 AI，并会提到小蓝鱼在做什么
- 事件分流：事件按角色打 `by` 标记，两人各看各的「刚刚发生」
- 位置：公主床在卧室、公主小书桌在书房，两处新增站位与寻路节点不会挡原有动线
- 兼容：旧存档顶层字段仍视为小蓝鱼本人，读档时自动补出小公主，无需迁移
- 异地共同经营：`npm run tunnel` 起一条 Cloudflare 快速隧道，把 `/room/` 变成一个 https 地址发给另一个人，两人操作同一份 `state/` 存档；隧道域名只放行房间页与房间/菜园 API，控制台仍只能在本机开
- 各自署名：「我是」按钮给自己起名字，动作事件带上名字，看得出是谁点的（名字只存本机 localStorage）
- 整理：修掉一处重复的 `study` 站位表（它会把 `claude_desk` 覆盖掉，读档后找不到公主小书桌）

## 大肥鱼房子最新版 4

- 东侧增建书房（4.2m × 3.2m）：走廊东墙开门打通，不占菜园、阳台与菜园小径
- 书房家具：书桌 + 大屏显示器、五层书架、懒人沙发、沙发床、边几、小茶几、绿植 ×2、台灯、氛围灯带与阅读角地毯，全部复用现有材质
- 书房寻路：新增 5 个站位与完整路点图，自动避开书架 / 沙发床 / 懒人沙发；18-19 点她会自己去书房翻书
- 书房投屏：`getDisplayMedia` 把屏幕共享到书房大屏，小蓝鱼自动到书房沙发旁陪看，每分钟自动截屏说一句观后感（书房语境提示词）
- 书架抽书：点书架热点打开抽书面板，5 本内置书；选书后她走到阅读角坐下，分句念完并收尾
- 书房小游戏：书房投屏状态下开打砖块，底部控制条移动挡板，按分数 / 通关 / 出局触发她的气泡与动作
- 相机：书房专属房间视角与第一视角预设；地面拾取面扩到书房范围
- 修复：主地板与天花板延伸到书房、太阳阴影相机覆盖书房、踢脚线补齐

## 大肥鱼房子最新版 3

- 新增 `tools/` 目录：暴喵AI管家 Windows / macOS 安装包
- 安装包经暴喵AI官方授权由项目发布者分发
- 保留官方文件名、SHA256 和来源/授权说明
- 不提供邀请码、返利或领取活动

## 大肥鱼房子最新版 2

- 清理根目录重复模型（58.9 MB）
- 删除未引用的 examples 图片和 garden-showcase.html
- 清理 src/bridge.js 中的真实 QQ、本机路径和默认私人角色名
- 修复 README 的占位仓库链接
- 拆分标准 MIT LICENSE 与第三方说明
- 统一 package 身份和版本号
- 功能保持不变

## 大肥鱼房子最新版 1

- 完整 3D 房间、菜园、电视、陪伴层和 QQ 桥接
- 6.7 MB 优化模型 + 58.9 MB 原始工程模型
- 3D 标准 / 高画质切换
- 最新走路动画、动作栏、菜园拖拽
- SnowLuma / NapCat 双网关支持
- 安装文档、NapCat 文档、新手 GitHub 教程
