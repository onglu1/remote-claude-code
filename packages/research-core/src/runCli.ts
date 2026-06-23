import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { installRlab } from './install';
import { scaffoldResearchRepo } from './scaffold';
import { checkResearchRepo } from './doctor';
import { NodeStore } from './store';
import { ResearchGraph } from './graph';
import { rebuildIndex } from './derivedIndex';
import { renderBrief } from './brief';
import { NodeTypeSchema, type ResearchNode, type NodeType, type EvidenceResult } from './schema';
import { addNode, setNode } from './verbs/create';
import { linkNodes, unlinkNodes, containNode, aliasNode } from './verbs/structure';
import { splitIdea, mergeIdeas } from './verbs/incubate';
import {
  concludeTask, supersedeNode, invalidateNode, dropNode, blockNode, unblockNode, setStatus,
} from './verbs/lifecycle';
import { contradictNodes, resolveContradiction } from './verbs/tension';
import { linkCode, linkOutput } from './verbs/attach';
import { nextAll, nextOpenTasks, nextTensions, nextStale, nextOrphans, nextStagnantThreads } from './insights/next';
import { affectedBy } from './insights/affected';
import { renderBriefRich } from './insights/briefRich';
import { analyzeGraph } from './insights/analyze';
import { DEFAULT_STALE_DAYS, type NextItem } from './insights/types';
import { parseLegacyDocs } from './legacy/parseLegacy';
import { importLegacy } from './legacy/importLegacy';

export interface CliResult {
  code: number;
  stdout: string;
}

const USAGE = [
  'rlab —— 科研工作流 CLI',
  '',
  '脚手架:  rlab init [dir] [--name N] [--force]   |   rlab doctor [dir]   |   rlab reindex [dir]',
  '安装:    rlab install   (软链 ~/.local/bin/rlab,任意仓库可用)',
  '建节点:  rlab add <type> --title T [--as N] [--parent P] [--summary S] [--result R] [--url U]',
  '改字段:  rlab set <id> [--title T] [--summary S] [--expectation E] [--text path]',
  '连边:    rlab link <from> <to> --label L [--note N]   |   rlab unlink <from> <to> [--label L]',
  '包含:    rlab contain <child> --in <parent>   |   rlab contain <child> --out',
  '孵化:    rlab split <idea> --into A,B,C   |   rlab merge <id...> --title T',
  '导入:    rlab import-legacy [docs-dir=docs]',
  '结论:    rlab conclude <task> --result R [--summary S] [--manifest M] [--output O1,O2]',
  '生命周期: rlab supersede <id> --by <newId> [--reason R] | invalidate <id> --reason R',
  '         rlab drop <id> --reason R | block <id> --on a,b | unblock <id> | status <id> --set S',
  '张力:    rlab contradict <a> <b> [--note N]   |   rlab resolve <a> <b> [--by <task>]',
  '挂接:    rlab alias <id> --add N | link-code <task> <path> | link-output <evidence> <path> [--manifest M]',
  '洞察:    rlab next [--stale-days N] [--kind K1,K2] | open | tensions | stale | orphans | stagnant',
  '         rlab affected-by <id> | analyze | brief --rich [--max-bytes N]',
  '读图:    rlab brief | show <id> [--deep] | find <query> | list [--type T] [--status S]',
  '通用:    任意命令加 --json 输出结构化结果',
  '',
].join('\n');

interface Flags {
  [k: string]: string | true;
}
function parseFlags(rest: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}
function s(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}
function csv(flags: Flags, key: string): string[] | undefined {
  const v = s(flags, key);
  return v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean);
}
function nodeStatus(node: ResearchNode): string {
  return node.type === 'reference' ? 'ref' : node.status;
}
function ok(stdout: string): CliResult {
  return { code: 0, stdout: stdout.endsWith('\n') ? stdout : stdout + '\n' };
}
function fail(stdout: string): CliResult {
  return { code: 1, stdout: stdout.endsWith('\n') ? stdout : stdout + '\n' };
}
function emit(flags: Flags, human: string, data: unknown): CliResult {
  return ok(flags.json ? JSON.stringify(data, null, 2) : human);
}

function runWrite(cmd: string, root: string, store: NodeStore, pos: string[], flags: Flags): CliResult | null {
  const done = (human: string, data: unknown): CliResult => {
    rebuildIndex(root, store);
    return emit(flags, human, data);
  };
  switch (cmd) {
    case 'add': {
      const type: NodeType = NodeTypeSchema.parse(pos[0]);
      const node = addNode(root, store, {
        type,
        title: s(flags, 'title') ?? '',
        parent: s(flags, 'parent'),
        summary: s(flags, 'summary'),
        expectation: s(flags, 'expectation'),
        result: s(flags, 'result') as EvidenceResult | undefined,
        url: s(flags, 'url'),
        as: s(flags, 'as'),
      });
      return done(`已建 ${node.id}`, node);
    }
    case 'set':
      return done(`已更新 ${pos[0]}`, setNode(store, {
        id: pos[0], title: s(flags, 'title'), summary: s(flags, 'summary'),
        expectation: s(flags, 'expectation'), text: s(flags, 'text'),
      }));
    case 'link':
      return done(`已连 ${pos[0]} → ${pos[1]}`, linkNodes(store, {
        from: pos[0], to: pos[1], label: s(flags, 'label') ?? '', note: s(flags, 'note'),
      }));
    case 'unlink':
      return done(`已删边 ${pos[0]} → ${pos[1]}`, unlinkNodes(store, {
        from: pos[0], to: pos[1], label: s(flags, 'label'),
      }));
    case 'contain':
      return done(`已设容器 ${pos[0]}`, containNode(store, {
        child: pos[0], parent: flags.out ? undefined : s(flags, 'in'),
      }));
    case 'split': {
      const kids = splitIdea(root, store, { id: pos[0], into: csv(flags, 'into') ?? [] });
      return done(`已拆出 ${kids.map((k) => k.id).join(', ')}`, kids);
    }
    case 'merge': {
      const t = mergeIdeas(root, store, { ids: pos, title: s(flags, 'title') ?? '' });
      return done(`已凝成 ${t.id}`, t);
    }
    case 'conclude': {
      const r = concludeTask(root, store, {
        task: pos[0], result: s(flags, 'result') as EvidenceResult,
        summary: s(flags, 'summary'), manifest: s(flags, 'manifest'), output: csv(flags, 'output'),
      });
      return done(`${r.task.id} done,产出 ${r.evidence.id}`, r);
    }
    case 'supersede':
      return done(`${pos[0]} 被 ${s(flags, 'by')} 取代`, supersedeNode(store, {
        id: pos[0], by: s(flags, 'by') ?? '', reason: s(flags, 'reason'),
      }));
    case 'invalidate':
      return done(`${pos[0]} 已作废`, invalidateNode(store, { id: pos[0], reason: s(flags, 'reason') ?? '' }));
    case 'drop':
      return done(`${pos[0]} 已丢弃`, dropNode(store, { id: pos[0], reason: s(flags, 'reason') ?? '' }));
    case 'block':
      return done(`${pos[0]} 已阻塞`, blockNode(store, { id: pos[0], on: csv(flags, 'on') ?? [] }));
    case 'unblock':
      return done(`${pos[0]} 已解除阻塞`, unblockNode(store, { id: pos[0] }));
    case 'status':
      return done(`${pos[0]} 状态已更新为 ${s(flags, 'set')}`, setStatus(store, {
        id: pos[0], set: s(flags, 'set') ?? '',
      }));
    case 'contradict':
      return done(`${pos[0]} ⇄ ${pos[1]} 张力(open)`, contradictNodes(store, {
        a: pos[0], b: pos[1], note: s(flags, 'note'),
      }));
    case 'resolve':
      return done(`${pos[0]} ⇄ ${pos[1]} 已解决`, resolveContradiction(store, {
        a: pos[0], b: pos[1], by: s(flags, 'by'),
      }));
    case 'alias':
      return done(`${pos[0]} 加别名 ${s(flags, 'add')}`, aliasNode(store, { id: pos[0], name: s(flags, 'add') ?? '' }));
    case 'link-code':
      return done(`${pos[0]} 挂代码 ${pos[1]}`, linkCode(store, { id: pos[0], path: pos[1] }));
    case 'link-output':
      return done(`${pos[0]} 挂产物 ${pos[1]}`, linkOutput(store, {
        id: pos[0], path: pos[1], manifest: s(flags, 'manifest'),
      }));
    default:
      return null;
  }
}

function renderShow(graph: ResearchGraph, node: ResearchNode, deep: boolean): string {
  const lines = [`${node.id} [${nodeStatus(node)}] ${node.title}`];
  if (node.summary) lines.push(`  摘要: ${node.summary}`);
  for (const e of node.edges) lines.push(`  → ${e.to} (${e.label}${e.note ? ': ' + e.note : ''})`);
  for (const ie of graph.inEdges(node.id)) lines.push(`  ← ${ie.from} (${ie.edge.label})`);
  if (deep) for (const c of graph.subtree(node.id).slice(1)) lines.push(`  ⊂ ${c.id} ${c.title}`);
  return lines.join('\n');
}

function renderNext(items: NextItem[]): string {
  if (items.length === 0) return '(无)';
  return items
    .map((it) => `[${it.kind}] ${it.id}  ${it.title}\n  → ${it.reason}`)
    .join('\n');
}

function runRead(cmd: string, store: NodeStore, pos: string[], flags: Flags): CliResult | null {
  const graph = new ResearchGraph(store.list());
  switch (cmd) {
    case 'brief': {
      if (flags.rich) {
        const max = s(flags, 'max-bytes') ? parseInt(s(flags, 'max-bytes')!, 10) : undefined;
        const text = renderBriefRich(graph, max);
        return emit(flags, text, { brief: text });
      }
      return emit(flags, renderBrief(graph), { brief: renderBrief(graph) });
    }
    case 'show': {
      const node = graph.get(pos[0]);
      if (!node) return fail(`节点不存在: ${pos[0]}`);
      const data = { node, inEdges: graph.inEdges(pos[0]), subtree: flags.deep ? graph.subtree(pos[0]) : undefined };
      return emit(flags, renderShow(graph, node, flags.deep === true), data);
    }
    case 'find': {
      const hits = graph.find(pos[0] ?? '');
      return emit(flags, hits.map((n) => `${n.id}  ${n.title}`).join('\n') || '(无匹配)', hits);
    }
    case 'list': {
      const t = s(flags, 'type');
      const st = s(flags, 'status');
      const nodes = [...graph.nodes.values()]
        .filter((n) => (!t || n.type === t) && (!st || nodeStatus(n) === st))
        .sort((a, b) => a.id.localeCompare(b.id));
      return emit(flags, nodes.map((n) => `${n.id}  ${n.title}`).join('\n') || '(空)', nodes);
    }
    case 'next': {
      const items = nextAll(graph, {
        staleDays: s(flags, 'stale-days') ? parseInt(s(flags, 'stale-days')!, 10) : undefined,
        kinds: csv(flags, 'kind') as NextItem['kind'][] | undefined,
      });
      return emit(flags, renderNext(items), items);
    }
    case 'open':
      return emit(flags, renderNext(nextOpenTasks(graph)), nextOpenTasks(graph));
    case 'tensions':
      return emit(flags, renderNext(nextTensions(graph)), nextTensions(graph));
    case 'stale':
      return emit(flags, renderNext(nextStale(graph)), nextStale(graph));
    case 'orphans':
      return emit(flags, renderNext(nextOrphans(graph)), nextOrphans(graph));
    case 'stagnant': {
      const days = s(flags, 'stale-days') ? parseInt(s(flags, 'stale-days')!, 10) : DEFAULT_STALE_DAYS;
      const items = nextStagnantThreads(graph, new Date().toISOString(), days);
      return emit(flags, renderNext(items), items);
    }
    case 'affected-by': {
      const report = affectedBy(graph, pos[0] ?? '');
      const human = report.downstream.length === 0
        ? `${report.from} 无下游 depends-on`
        : report.downstream.map((d) => `${d.id}  路径: ${d.path.join(' → ')}`).join('\n');
      return emit(flags, human, report);
    }
    case 'analyze': {
      const stats = analyzeGraph(graph);
      const human = [
        `节点: ${stats.totals.nodes} · 边: ${stats.totals.edges} · contains 树: ${stats.totals.containsTrees}`,
        `按类型: ${Object.entries(stats.byType).filter(([, c]) => c > 0).map(([t, c]) => `${t}=${c}`).join(' ')}`,
        `按状态: ${Object.entries(stats.byStatus).map(([s2, c]) => `${s2}=${c}`).join(' ')}`,
        `孤儿: ${stats.orphans.join(', ') || '(无)'}`,
        `断链: ${stats.dangling.join(', ') || '(无)'}`,
        `未解张力对: ${stats.openTensions}`,
        `停滞方向: ${stats.stagnantThreads.join(', ') || '(无)'}`,
      ].join('\n');
      return emit(flags, human, stats);
    }
    default:
      return null;
  }
}

export function runCli(argv: string[], cwd: string): CliResult {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return ok(USAGE);
  const { pos, flags } = parseFlags(rest);

  if (cmd === 'init') {
    const root = path.resolve(cwd, pos[0] ?? '.');
    const report = scaffoldResearchRepo(root, {
      projectName: s(flags, 'name') ?? path.basename(root),
      force: flags.force === true,
    });
    return ok([
      'rlab init: ' + root,
      'created: ' + (report.created.length ? report.created.join(', ') : '(无)'),
      'skipped: ' + (report.skipped.length ? report.skipped.join(', ') : '(无)'),
      '',
      '下一步: 填写 docs/overview.md(研究宪章),然后 rlab add thread 起第一个方向。',
    ].join('\n'));
  }

  if (cmd === 'doctor') {
    const root = path.resolve(cwd, pos[0] ?? '.');
    const r = checkResearchRepo(root);
    if (r.ok) return ok('rlab doctor: ok —— ' + root);
    return fail([
      'rlab doctor: 不合规 —— ' + root,
      'missing dirs:  ' + (r.missingDirs.join(', ') || '(无)'),
      'missing files: ' + (r.missingFiles.join(', ') || '(无)'),
      'invalid nodes: ' + (r.invalidNodes.join(', ') || '(无)'),
      'dangling refs: ' + (r.danglingRefs.join(', ') || '(无)'),
    ].join('\n'));
  }

  if (cmd === 'reindex') {
    const root = path.resolve(cwd, pos[0] ?? '.');
    const data = rebuildIndex(root, new NodeStore(root));
    return ok(`rlab reindex: ${data.nodes.length} 个节点 → research/.index/graph.json`);
  }

  if (cmd === 'import-legacy') {
    const docs = path.resolve(cwd, pos[0] ?? 'docs');
    const parsed = parseLegacyDocs(docs);
    const store = new NodeStore(cwd);
    const report = importLegacy(cwd, store, parsed);
    return ok([
      `rlab import-legacy: ${docs}`,
      `已建 task: ${report.createdTasks.length} 个 (${report.createdTasks.slice(0, 5).join(', ')}${report.createdTasks.length > 5 ? '...' : ''})`,
      `已建 evidence: ${report.createdEvidence.length} 个`,
      `已建 produces 边: ${report.linksAdded}`,
      `跳过(已存在): ${report.skipped.length} 个`,
      report.warnings.length > 0 ? `警告:\n  ` + report.warnings.join('\n  ') : '',
    ].filter(Boolean).join('\n'));
  }

  if (cmd === 'install') {
    const here = path.dirname(fileURLToPath(import.meta.url)); // .../src
    const binScript = path.join(here, '..', 'bin', 'rlab.mjs');
    const targetDir = path.join(os.homedir(), '.local', 'bin');
    const target = installRlab(binScript, targetDir);
    return ok(`已软链 ${target} → ${binScript}\n确保 ${targetDir} 在 PATH(如 export PATH="$HOME/.local/bin:$PATH")。`);
  }

  const store = new NodeStore(cwd);
  try {
    return runWrite(cmd, cwd, store, pos, flags) ?? runRead(cmd, store, pos, flags) ?? fail(`未知命令: ${cmd}\n\n${USAGE}`);
  } catch (e) {
    return fail(`错误: ${(e as Error).message}`);
  }
}
