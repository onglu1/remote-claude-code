import { useState, type JSX } from 'react';
import type { NodeType, EvidenceResult, ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { researchApi } from '../../lib/researchApi';

export interface NodeOpsContext {
  subject?: string;
  parent?: string;
}

type Verb =
  | 'add' | 'set' | 'link' | 'unlink' | 'contain' | 'split' | 'merge'
  | 'conclude' | 'supersede' | 'invalidate' | 'drop' | 'block' | 'unblock'
  | 'contradict' | 'resolve' | 'alias' | 'status' | 'link-code' | 'link-output';

const TYPE_OPTIONS: NodeType[] = ['thread', 'idea', 'task', 'evidence', 'reference'];
const RESULT_OPTIONS: EvidenceResult[] = ['positive', 'negative', 'inconclusive', 'mixed'];

function statusOptions(node: ResearchNode | undefined): string[] {
  if (!node) return [];
  if (node.type === 'thread') return ['open', 'parked', 'concluded'];
  if (node.type === 'idea') return ['incubating', 'parked', 'crystallized', 'dropped'];
  if (node.type === 'task') return ['todo', 'active', 'done', 'superseded', 'invalidated', 'dropped', 'blocked'];
  if (node.type === 'evidence') return ['active', 'superseded', 'invalidated'];
  return [];
}

export function NodeOpsDrawer({
  projectId, verb, context, graph, onClose, onDone,
}: {
  projectId: string;
  verb: string; // 接受任意字符串,内部 dispatch 时 narrow
  context?: NodeOpsContext;
  graph: ResearchGraph;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const v = verb as Verb;
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const subject = context?.subject;
  const subjectNode: ResearchNode | undefined = subject ? graph.get(subject) : undefined;

  const set = (field: string, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));
  const opt = (field: string): string | undefined =>
    form[field] && form[field].length > 0 ? form[field] : undefined;
  const list = (field: string): string[] =>
    (form[field] ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  async function dispatch() {
    const pid = projectId;
    switch (v) {
      case 'add':
        await researchApi.add(pid, {
          type: (form.type as NodeType) || 'task',
          title: form.title ?? '',
          as: opt('as'),
          parent: opt('parent') ?? context?.parent,
          summary: opt('summary'),
          expectation: opt('expectation'),
          result: (form.result as EvidenceResult) || undefined,
          url: opt('url'),
        }); return;
      case 'set':
        await researchApi.set(pid, { id: subject!, title: opt('title'), summary: opt('summary'), expectation: opt('expectation'), text: opt('text') }); return;
      case 'link':
        await researchApi.link(pid, { from: subject!, to: form.to ?? '', label: form.label || 'related-to', note: opt('note') }); return;
      case 'unlink':
        await researchApi.unlink(pid, { from: subject!, to: form.to ?? '', label: opt('label') }); return;
      case 'contain':
        await researchApi.contain(pid, { child: subject!, parent: opt('parent') ?? null }); return;
      case 'split':
        await researchApi.split(pid, { id: subject!, into: list('into') }); return;
      case 'merge':
        await researchApi.merge(pid, { ids: list('ids').length ? list('ids') : [subject!], title: form.title ?? '' }); return;
      case 'conclude':
        await researchApi.conclude(pid, {
          task: subject!,
          result: (form.result as EvidenceResult) || 'positive',
          summary: opt('summary'),
          manifest: opt('manifest'),
          output: form.output ? list('output') : undefined,
        }); return;
      case 'supersede':
        await researchApi.supersede(pid, { id: subject!, by: form.by ?? '', reason: opt('reason') }); return;
      case 'invalidate':
        await researchApi.invalidate(pid, { id: subject!, reason: form.reason ?? '' }); return;
      case 'drop':
        await researchApi.drop(pid, { id: subject!, reason: form.reason ?? '' }); return;
      case 'block':
        await researchApi.block(pid, { id: subject!, on: list('on') }); return;
      case 'unblock':
        await researchApi.unblock(pid, { id: subject! }); return;
      case 'contradict':
        await researchApi.contradict(pid, { a: subject!, b: form.b ?? '', note: opt('note') }); return;
      case 'resolve':
        await researchApi.resolve(pid, { a: subject!, b: form.b ?? '', by: opt('by') }); return;
      case 'alias':
        await researchApi.alias(pid, { id: subject!, name: form.name ?? '' }); return;
      case 'status':
        await researchApi.status(pid, { id: subject!, set: form.set ?? '' }); return;
      case 'link-code':
        await researchApi.linkCode(pid, { id: subject!, path: form.path ?? '' }); return;
      case 'link-output':
        await researchApi.linkOutput(pid, { id: subject!, path: form.path ?? '', manifest: opt('manifest') }); return;
    }
  }

  async function submit() {
    setBusy(true); setErr(null);
    try { await dispatch(); await onDone(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const fields: JSX.Element[] = [];
  switch (v) {
    case 'add':
      fields.push(
        <label key="type">type
          <select value={form.type || 'task'} onChange={(e) => set('type', e.target.value)}>
            {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>,
        <label key="title">title<input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} /></label>,
        <label key="as">as(可选编号 / reference 必填 citekey)<input value={form.as ?? ''} onChange={(e) => set('as', e.target.value)} /></label>,
        <label key="parent">parent(可选)<input value={form.parent ?? context?.parent ?? ''} onChange={(e) => set('parent', e.target.value)} /></label>,
        <label key="summary">summary(可选)<input value={form.summary ?? ''} onChange={(e) => set('summary', e.target.value)} /></label>,
      );
      if (form.type === 'task') fields.push(<label key="exp">expectation<input value={form.expectation ?? ''} onChange={(e) => set('expectation', e.target.value)} /></label>);
      if (form.type === 'evidence') fields.push(
        <label key="res">result
          <select value={form.result || 'positive'} onChange={(e) => set('result', e.target.value)}>
            {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>,
      );
      if (form.type === 'reference') fields.push(<label key="url">url<input value={form.url ?? ''} onChange={(e) => set('url', e.target.value)} /></label>);
      break;
    case 'set':
      fields.push(
        <label key="t">title<input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder={subjectNode?.title} /></label>,
        <label key="s">summary<input value={form.summary ?? ''} onChange={(e) => set('summary', e.target.value)} placeholder={subjectNode?.summary} /></label>,
        <label key="x">text 路径<input value={form.text ?? ''} onChange={(e) => set('text', e.target.value)} placeholder={subjectNode?.text} /></label>,
      );
      if (subjectNode?.type === 'task') {
        fields.push(<label key="e">expectation<input value={form.expectation ?? ''} onChange={(e) => set('expectation', e.target.value)} placeholder={subjectNode.expectation} /></label>);
      }
      break;
    case 'link':
      fields.push(
        <label key="to">to<input value={form.to ?? ''} onChange={(e) => set('to', e.target.value)} placeholder="task/007" /></label>,
        <label key="label">label<input value={form.label ?? ''} onChange={(e) => set('label', e.target.value)} placeholder="depends-on / supports / refutes ..." /></label>,
        <label key="note">note(可选,这俩为什么有联系)<input value={form.note ?? ''} onChange={(e) => set('note', e.target.value)} /></label>,
      );
      break;
    case 'unlink':
      fields.push(
        <label key="to">to<input value={form.to ?? ''} onChange={(e) => set('to', e.target.value)} /></label>,
        <label key="label">label(可选,不填删全部到 to 的边)<input value={form.label ?? ''} onChange={(e) => set('label', e.target.value)} /></label>,
      );
      break;
    case 'contain':
      fields.push(
        <label key="p">parent(留空 = 解绑)<input value={form.parent ?? ''} onChange={(e) => set('parent', e.target.value)} placeholder={subjectNode?.parent} /></label>,
      );
      break;
    case 'split':
      fields.push(<label key="into">into(逗号分隔的子 idea 标题)<input value={form.into ?? ''} onChange={(e) => set('into', e.target.value)} placeholder="想法A, 想法B" /></label>);
      break;
    case 'merge':
      fields.push(
        <label key="ids">ids(逗号分隔的 idea id;不填默认仅 subject)<input value={form.ids ?? ''} onChange={(e) => set('ids', e.target.value)} placeholder={subject} /></label>,
        <label key="title">合成的 task title<input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} /></label>,
      );
      break;
    case 'conclude':
      fields.push(
        <label key="r">result<select value={form.result || 'positive'} onChange={(e) => set('result', e.target.value)}>{RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>,
        <label key="s">一句话结论<input value={form.summary ?? ''} onChange={(e) => set('summary', e.target.value)} /></label>,
        <label key="m">manifest(可选 MANIFEST.json 路径)<input value={form.manifest ?? ''} onChange={(e) => set('manifest', e.target.value)} /></label>,
        <label key="o">output(可选,逗号分隔)<input value={form.output ?? ''} onChange={(e) => set('output', e.target.value)} /></label>,
      );
      break;
    case 'supersede':
      fields.push(
        <label key="by">by(新节点 id)<input value={form.by ?? ''} onChange={(e) => set('by', e.target.value)} placeholder="task/024" /></label>,
        <label key="r">reason(可选,为什么取代)<input value={form.reason ?? ''} onChange={(e) => set('reason', e.target.value)} /></label>,
      );
      break;
    case 'invalidate':
    case 'drop':
      fields.push(<label key="r">reason<input value={form.reason ?? ''} onChange={(e) => set('reason', e.target.value)} /></label>);
      break;
    case 'block':
      fields.push(<label key="on">on(逗号分隔被卡的 id)<input value={form.on ?? ''} onChange={(e) => set('on', e.target.value)} placeholder="task/006, task/007" /></label>);
      break;
    case 'unblock':
      fields.push(<div key="info" className="drawer-info">无需字段;点确定即解除阻塞,status 回 active。</div>);
      break;
    case 'contradict':
      fields.push(
        <label key="b">b(另一节点 id)<input value={form.b ?? ''} onChange={(e) => set('b', e.target.value)} /></label>,
        <label key="n">note(可选)<input value={form.note ?? ''} onChange={(e) => set('note', e.target.value)} /></label>,
      );
      break;
    case 'resolve':
      fields.push(
        <label key="b">b(另一节点 id)<input value={form.b ?? ''} onChange={(e) => set('b', e.target.value)} /></label>,
        <label key="by">by(可选,做出隔离实验的 task id)<input value={form.by ?? ''} onChange={(e) => set('by', e.target.value)} /></label>,
      );
      break;
    case 'alias':
      fields.push(<label key="n">name<input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></label>);
      break;
    case 'status': {
      const opts = statusOptions(subjectNode);
      fields.push(
        <label key="s">set
          <select value={form.set || opts[0] || ''} onChange={(e) => set('set', e.target.value)}>
            {opts.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>,
      );
      break;
    }
    case 'link-code':
      fields.push(<label key="p">path(代码目录路径)<input value={form.path ?? ''} onChange={(e) => set('path', e.target.value)} placeholder="experiments/007_xxx" /></label>);
      break;
    case 'link-output':
      fields.push(
        <label key="p">path(产物路径)<input value={form.path ?? ''} onChange={(e) => set('path', e.target.value)} placeholder="output/007_xxx" /></label>,
        <label key="m">manifest(可选)<input value={form.manifest ?? ''} onChange={(e) => set('manifest', e.target.value)} /></label>,
      );
      break;
  }

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="drawer-verb">{verb}</span>
          {subject && <span className="drawer-subject">{subject}</span>}
        </div>
        <div className="drawer-body">{fields}</div>
        {err && <div className="drawer-err">{err}</div>}
        <div className="drawer-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={submit}>{busy ? '提交中…' : '确定'}</button>
        </div>
      </div>
    </div>
  );
}
