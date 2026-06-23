import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/runCli';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-smoke-'));
function run(args: string[]): void {
  const r = runCli(args, root);
  process.stdout.write(`$ rlab ${args.join(' ')}\n${r.stdout}\n`);
  if (r.code !== 0) {
    process.stderr.write(`❌ 失败: rlab ${args.join(' ')}\n`);
    process.exit(1);
  }
}

run(['init']);
run(['add', 'thread', '--title', '错误危害方向', '--as', '003', '--summary', '研究错误注入危害']);
run(['add', 'idea', '--title', '激活值统计特征', '--as', '012', '--parent', 'thread/003']);
run(['add', 'task', '--title', '错误类型×位置矩阵', '--as', '007', '--parent', 'thread/003', '--expectation', '高层注入危害更大']);
run(['link-code', 'task/007', 'experiments/007_matrix']);
run(['conclude', 'task/007', '--result', 'positive', '--summary', '危害排序确认', '--output', 'output/007', '--manifest', 'output/007/MANIFEST.json']);
run(['add', 'task', '--title', '重测矩阵', '--as', '008', '--parent', 'thread/003']);
run(['conclude', 'task/008', '--result', 'negative', '--summary', '相反结论']);
run(['contradict', 'evidence/001', 'evidence/002', '--note', '设置微差导致结论相反']);
run(['add', 'task', '--title', '隔离哪个旋钮', '--as', '009']);
run(['resolve', 'evidence/001', 'evidence/002', '--by', 'task/009']);
run(['supersede', 'task/007', '--by', 'task/008', '--reason', '换更优设计']);
run(['invalidate', 'evidence/002', '--reason', 'fi_server 配置有误']);
run(['merge', 'idea/012', '--title', '凝成激活统计实验']);
run(['brief']);
run(['doctor']);

// === 洞察层场景 ===
run(['add', 'task', '--title', '依赖被作废的实验', '--as', '011']);
run(['link', 'task/011', 'evidence/002', '--label', 'depends-on']);
run(['affected-by', 'evidence/002']);  // 应列出 task/011
run(['next']);                          // 应含 open-task/stale/orphan/...
run(['analyze']);                       // 全图统计
run(['brief', '--rich']);               // 含 rollup
run(['open']);
run(['tensions']);
run(['stale']);
run(['orphans']);
run(['stagnant', '--stale-days', '1']);

process.stdout.write('✅ 骨干 + 洞察层冒烟通过(全流程绿)\n');
fs.rmSync(root, { recursive: true, force: true });
