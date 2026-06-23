# 聊天模式顶部 HUD 信息条设计

日期：2026-06-21
状态：已与用户确认方案，进入实现

## 背景与问题

终端视图里能直接看到用户配置的 statusLine（claude-hud）——它把**模型、上下文占用、5 小时限额、周限额**画在屏幕底部。但聊天视图把 TUI chrome 全剥掉了（`paneScraper` 专门丢弃状态行/权限行），于是这些关键信息在聊天界面**完全看不到**。用户希望聊天界面也能实时看到这些。

约束：claude-hud 是用户的 statusLine，其输出**本就在聊天会话每 250ms 抓取的整屏 pane 里**（`ChatSession.tick()` 已 `capturePaneVisible`）。所以**复用这条已有轮询**即可，新增一个纯函数从 pane 文本解析 HUD，**不新增 tmux 调用、不改全局配置、不碰 claude-hud 的 config/settings**。

## 真实状态行格式（线上实测，2026-06-21）

繁忙/有订阅 usage（两行 HUD + 一行权限提示，权限行忽略）：

```
  [claude-opus-4-8[1m]] ██░░░░░░░░ 19% | remote-cc git:(master*) | Usage █░░░░░░░░░ 14% (2h 19m / 5h)
  Weekly █░░░░░░░░░ 14% (6d 3h / Weekly)
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```

空闲/无 usage（只有第一行 model+context，无 Usage 段、无 Weekly 行）：

```
  [claude-opus-4-8[1m]] ░░░░░░░░░░ 0% | sample-finetune git:(master*)
  ⏵⏵ bypass permissions on (shift+tab to cycle)
```

## 解析规则

- **模型**：第一个 `[...]` 方括号内容（`claude-opus-4-8[1m]`）。其中尾部 `[1m]`/`[200k]` 是**上下文窗口大小标记**，要从模型名里拆出：`model=claude-opus-4-8`、`contextWindow=1m`。
- **上下文占比**：模型方括号后的第一个 `NN%`（细条之后那个百分比）。
- **5 小时限额**：若该行含 `Usage` 段，取其后的 `NN%` 与括号文本 `(2h 19m / 5h)`。无 `Usage` 段（API 用户/无订阅）→ 不显示。
- **周限额**：若有以 `Weekly` 开头的行，取其 `NN%` 与括号文本 `(6d 3h / Weekly)`。无该行 → 不显示。
- **git 分支**（可选）：`git:(master*)` → `master*`。
- 所有字段**可选、容错**：解析不到就不显示（订阅缺失/ API 用户 → 无 Usage/Weekly 属正常）。
- 额外保留一份**清洗后的 `raw`**（1~2 行 HUD 文本，去掉权限行与进度条字符噪声后的可读镜像）作为兜底展示——即使结构化字段没吃下当前格式，也能忠实显示原文。

## 数据流

```
capture-pane(整屏，tick 已抓) ──scrapeHud──► Hud | null
                       │
       tick(): 用签名去重，变化才 emit onHud(hud)
                       │
ChatRegistry 扇出所有订阅者；新订阅/resync 用 getLiveHud() 立即补发一次
                       │
routes/chat.ts: onHud → send({ type:'hud', hud })
                       │
前端 ChatView 存 state ──► <Hud> 顶部信息条
   模型徽标 + 上下文(细条+%) + [订阅才有] 5h(条+%+时间) + 周(条+%+时间)
   可点开展开显示 raw 原文
```

## 硬约束（项目铁律）

- **纯并行增量**：HUD 解析是**独立于 `paneScraper` 的另一条解析**，二者互不影响。预览逻辑（流式/spinner/done）、ask 待答检测、transcript 渲染、rewind、effort、终端视图——行为**完全不变**。
- **零新增外部调用**：复用 `tick()` 已抓的 `pane`，不新增 `capture-pane`/tmux 调用，不读 claude-hud 配置。
- **去重**：与现有 ask/preview 同风格，用签名比对，变化才广播（避免每 250ms 重发）。
- **重连补发**：HUD 是「当前态」、不在 transcript 历史里，故新订阅者/`resync` 需 `getLiveHud()` 补发一次（与 `getLiveAsk` 同构）。
- **手机优先、轻量**：信息条视觉重心不抢聊天内容；沿用 `themes/tokens.css` 既有变量与 `EffortPill` 风格，不引入新依赖。

## 关键风险与对策

- **格式漂移**：claude-hud 升级可能改格式。对策——解析全部容错、字段全可选；保留清洗 `raw` 兜底，最坏情况退化为「忠实镜像」。解析器隔离成纯函数 + 真实快照夹具单测，便于适配。
- **误吃别的方括号**：第一行可能含其他 `[...]`？实测 statusLine 首 token 恒为 `[model]`，取**第一个**方括号即可。解析时只认「行首（trim 后）以 `[` 开头」的行作为 HUD 首行，避免误吃正文里的方括号。
- **进度条字符**：`█`/`░` 等仅用于人眼，结构化解析只取百分比数字；`raw` 里可保留或精简（保留更忠实）。
- **多行/换行**：窄屏下 claude 可能折行，但 HUD 行由 claude-hud 单行渲染、tmux pane 宽度固定（120），实测不折行；解析按「含 `[model]` 的行 + 紧随的 `Weekly` 行」定位，对中间杂行鲁棒。

## 字段（shared 协议）

```ts
interface Hud {
  model?: string;          // claude-opus-4-8
  contextWindow?: string;  // 1m / 200k
  contextPct?: number;     // 19
  fiveHour?: { pct?: number; text?: string };  // 14, "2h 19m / 5h"
  weekly?: { pct?: number; text?: string };    // 14, "6d 3h / Weekly"
  gitBranch?: string;      // master*
  raw: string;             // 清洗后的 1~2 行 HUD 文本（兜底镜像）
}
// ChatServerMessage 增分支：{ type: 'hud'; hud: Hud }
```

## 验证

- 单测：两种 fixture（繁忙全字段、空闲仅 model+context）+ 边界（无方括号→null、宽度换行/杂行）。
- 真实集成：对线上真实 pane 跑 `scrapeHud` 打印，证明能解析当前格式；连聊天 WS 确认收到 `hud` 消息。
- `npm run typecheck`/`npm test`/`npm run build` 全绿，`./start.sh` 重启。
