import fs from 'node:fs';
import path from 'node:path';
import { SCAFFOLD_DIRS, GITKEEP_DIRS } from './layout';
import { TEMPLATE_FILES, GITIGNORE_SNIPPET } from './templates';

export interface ScaffoldOptions {
  projectName: string;
  force?: boolean;
}

export interface ScaffoldReport {
  created: string[];
  skipped: string[];
}

/**
 * 在 root 处脚手架一个合规科研仓库。幂等：已存在的模板文件默认跳过（force 才覆盖）。
 * 直接用 node:fs（同步），与本仓库 taskEvidence.ts 的写法一致。
 */
export function scaffoldResearchRepo(root: string, opts: ScaffoldOptions): ScaffoldReport {
  const report: ScaffoldReport = { created: [], skipped: [] };

  for (const dir of SCAFFOLD_DIRS) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  for (const dir of GITKEEP_DIRS) {
    const keep = path.join(root, dir, '.gitkeep');
    if (!fs.existsSync(keep)) {
      fs.writeFileSync(keep, '');
      report.created.push(path.posix.join(dir, '.gitkeep'));
    }
  }

  for (const tpl of TEMPLATE_FILES) {
    const abs = path.join(root, tpl.path);
    if (fs.existsSync(abs) && !opts.force) {
      report.skipped.push(tpl.path);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tpl.render(opts));
    report.created.push(tpl.path);
  }

  ensureGitignore(root, report);
  return report;
}

function ensureGitignore(root: string, report: ScaffoldReport): void {
  const gi = path.join(root, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (existing.includes('# --- research workflow ---')) {
    report.skipped.push('.gitignore');
    return;
  }
  const next = existing.length > 0 ? existing.replace(/\n*$/, '\n\n') + GITIGNORE_SNIPPET : GITIGNORE_SNIPPET;
  fs.writeFileSync(gi, next);
  report.created.push('.gitignore');
}
