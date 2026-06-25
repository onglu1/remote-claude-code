# @rcc/research-core

科研工作流系统的核心库（被 research CLI 与 remote-cc 后端共用）。

本包当前覆盖 spec 的「约定层」：
- 目录规范常量（`layout.ts`）
- CLAUDE.md / overview 模板（`templates.ts`）
- `scaffoldResearchRepo`（`research init` 的核心）
- `checkResearchRepo`（`research doctor`）
- CLI dispatch（`runCli` / `cli.ts`）：`init` / `doctor`
- 草案节点 schema（`schema.ts`）

## 用法（开发期，经 tsx）

    npm -w @rcc/research-core run research -- init <dir> [--name 名称] [--force]
    npm -w @rcc/research-core run research -- doctor <dir>

完整知识图存储与其余 CLI 动词（add/link/supersede/invalidate/contradict/brief/show…）见后续「骨干层」。
