/**
 * 科研仓库目录规范。所有路径相对仓库根，正斜杠分隔（跨平台由调用方 join）。
 */

/** init 会创建的目录（含派生的 .index 运行时目录）。 */
export const SCAFFOLD_DIRS: string[] = [
  'research/nodes/threads',
  'research/nodes/ideas',
  'research/nodes/tasks',
  'research/nodes/evidence',
  'research/nodes/references',
  'research/text',
  'research/.index',
  'docs',
  'docs/conventions',
  'src',
  'experiments',
  'output',
];

/** doctor 视为「合规必需」的目录（排除派生/可空的 .index）。 */
export const REQUIRED_DIRS: string[] = [
  'research/nodes/threads',
  'research/nodes/ideas',
  'research/nodes/tasks',
  'research/nodes/evidence',
  'research/text',
  'docs',
  'src',
  'experiments',
  'output',
];

/** doctor 视为「合规必需」的文件。docs/CLAUDE.md 是必读路线图,删了 Agent 找不到 conventions。 */
export const REQUIRED_FILES: string[] = ['CLAUDE.md', 'docs/overview.md', 'docs/CLAUDE.md'];

/** init 会放 .gitkeep 占位的空目录（让 git 跟踪；.index 被 gitignore 故排除）。 */
export const GITKEEP_DIRS: string[] = SCAFFOLD_DIRS.filter((d) => d !== 'research/.index');
