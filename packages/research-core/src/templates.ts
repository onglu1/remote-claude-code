import type { ScaffoldOptions } from './scaffold';

/**
 * CLAUDE.md —— 项目根的「工作流入口」。
 * 只放**永不变**的工作流元规则:必读路线、三权分立、产物边界、工作循环、助手/主权者边界、tmux 纪律等。
 * 项目特定的研究主线/约束在 docs/overview.md;具体规范在 docs/conventions/*.md;
 * 当前待办/优先级由 rlab 管理(`rlab next` 实时算出),不写在这里。
 */
export function renderClaudeMd(opts: ScaffoldOptions): string {
  return `# ${opts.projectName}

> 本文件是项目根节点的**工作流入口**——只描述「怎么用这套 AI 工作流」,**永不随技术/方向变更而修改**。
>
> 项目特定的研究主线、动机、约束在 \`docs/overview.md\`;
> 编码/实验/Git/写作等具体规范在 \`docs/conventions/*.md\`;
> 当前待办与优先级由 \`rlab next\` 实时算出,**不写在这里**。
>
> Agent 接手任何工作前,**必须按下方顺序读完 docs 必读文档**,再开始回答或动手。

## 必读文档(顺序读完后才开始工作)

1. \`docs/overview.md\` — 项目宪章(研究主线、动机、约束、当前方向)
2. \`docs/CLAUDE.md\` — docs 索引与阅读路线图
3. \`docs/conventions/collaboration.md\` — 协作行事准则(判断力 > 执行力等)
4. \`docs/conventions/research-workflow.md\` — rlab CLI 用法清单(必做/可做/不能做 + 完整动词)
5. \`docs/conventions/coding.md\` — 编码规范
6. \`docs/conventions/experiments.md\` — 实验流程(MANIFEST、断点续跑、smoke 先行)
7. \`docs/conventions/git.md\` — Git 规范
8. \`docs/conventions/writing.md\` — 文档与绘图规范

读完后回复「已读完背景」,再开始工作。中途遇到具体规范问题,回到对应 conventions 文件查,不要凭印象答。

## 三权分立(永不变的根本原则)

1. **结构主权属于研究者本人**:方向/实验的增删、拆分合并、连边、作废,由人发起(网页操作,或用自然语言让 Agent 代劳)。Agent **绝不擅自重构**知识图。
2. **Agent 的职责**:基于知识库与人对话、回答问题、在人的指令下写代码/跑实验/记录证据。
3. **CLI 守不变量**:schema 校验、只增不毁、传播规则由 \`rlab\` 保证;绕过 = 数据腐败。

## 三类产物各有纪律

- \`research/\` = **结构知识图**。节点 JSON 是真值,**只能通过 \`rlab\` 命令读写**;绝不手改 \`research/nodes/**.json\`,也绝不从 \`research/text/**.md\` 解析结构。Agent **绝不擅自** add/supersede/invalidate/contradict/merge/split——完整的「能做/不能做」边界与动词清单见 \`docs/conventions/research-workflow.md\`。
- \`docs/\` = **散文与规范**。\`overview.md\` 是项目宪章(研究者主写),\`conventions/*.md\` 是跨项目共用规范(改前想清楚是否真要偏离),\`design/\` 按需新增项目特定技术设计。Agent 可在研究者指令下自由编辑。
- \`src/\` + \`experiments/\` + \`output/\` = **代码与实验产物**。\`src/\` 稳定核心库,被所有实验依赖;\`experiments/NNN_*/\` 一次性实验,忠于实验目的即可。**依赖方向单向:experiments 可 import src,src 绝不反向**。具体纪律见 \`conventions/{coding,experiments}.md\`。

## 工作循环(每次任务都走这个闭环)

1. **读图开局**:会话首次先 \`rlab brief --rich\` 拿整张图的状态骨架(几十 KB,放心入上下文);具体方向相关时 \`rlab show <id> --deep\`。
2. **回答前先问图**:研究者问「之前怎么验证 X」「这个 idea 有没有结论」等,先 \`rlab find\` / \`rlab show\` 翻图,**用图里的事实**答,不凭印象编。
3. **接到任务先判断**:看到「核心假设可能不成立」「方法过于简单」「方向有根本问题」等信号,**立刻停下来报告**,列 2-3 条可选方向交研究者决定。绝不因为「算力空着」「之前说过继续」就硬跑。详见 \`collaboration.md\` 的「判断力 > 执行力」。
4. **动手按规范**:写代码遵守 \`conventions/coding.md\`,跑实验遵守 \`conventions/experiments.md\`(MANIFEST、smoke 先行、随跑随存、时间记录)。
5. **结案留下「为什么」**:研究者要求时用 \`rlab conclude\` / \`invalidate\` / \`supersede\` 收尾;**只增不毁**——没有东西被真删,作废与替代都留下原因,以便研究图可追溯。
6. **抛选项给研究者用 AskUserQuestion**:让研究者用方向键和回车快速回答,避免打字。一次最多一个核心问题,选项 2-4 个互斥。

## 助手 vs 主权者(永不变的边界)

- **建议你随时给**:看到孤儿 idea、停滞 thread、可疑 evidence、可作废的旧实验、缺失的对照组,主动指出来让研究者决定。
- **但执行结构变更必须研究者明示**。哪怕你「觉得」应该 \`invalidate\` 或 \`drop\`,也只能**建议、列出 \`rlab affected-by\` 影响范围**,不可代劳。
- **不假装做了 rlab 操作**:做了就有产出有 id 可引用;没做就坦白告诉研究者「这需要我跑 rlab,可以吗?」绝不虚构操作记录或捏造节点 id。
- **拿不准就问**,不要默默猜。比如研究者说「这个实验失败了」,可能是 \`conclude --result negative\`(实验跑完是反例)也可能是 \`invalidate\`(设置错了数据没意义),问清楚再做。

## 工程纪律

- **后台进程一律用 \`tmux\`**:任何长跑(训练/服务/扫描/批量实验)用 \`tmux new-session -d -s <name> "<cmd>"\`,以便随时 \`tmux attach\` 看输出、随时重连。**不用 \`nohup\`**——观测不便,出问题难定位。
- **临时文件别写 \`/\` 分区**:服务器 \`/\` 分区通常很小且全机共享,写满会拖垮其他人。临时日志、中间产物、克隆的外部仓库,写到项目 tmp 或 \`/mnt/<user>/tmp/\`。绝不动 \`/tmp\` 下其他用户的文件。
- **遵守 \`conventions/git.md\` 的提交纪律**:每次一个逻辑变更,中文 commit message 说清「为什么」,模型权重/output/凭据绝不入库。

## 这份文件为什么这么短

具体规范都在 \`docs/conventions/\` 下且可按项目演进。这份 CLAUDE.md **只放跨技术/跨方向都不变的元规则**——读完它你就理解了这个工作流的形状,但还没看到具体操作细节。所以**它指引你去读 docs,然后让 \`rlab\` 给你看现在该做什么**。
`;
}

/**
 * docs/CLAUDE.md —— docs 子索引。
 * 列出每份必读文件的角色、什么时候改它、由谁维护。
 */
export function renderDocsClaudeMd(opts: ScaffoldOptions): string {
  return `# ${opts.projectName} — docs/ 子索引

本目录是 Agent 在动手前必读的项目背景集合。根 \`CLAUDE.md\` 已经列了完整阅读顺序,这份子索引说明每份文件的角色与什么时候修改/新增。

## 必读路线图(按此顺序读完)

1. \`overview.md\` — **项目宪章**。研究主线、动机、约束、当前方向。**项目目标和约束变了就改它**,跨项目不共用。
2. \`conventions/collaboration.md\` — **协作行事准则**。判断力 > 执行力、诚实第一、smoke 先行、何时停下报告等原则。**长期稳定,跨项目高度复用**。
3. \`conventions/research-workflow.md\` — **rlab CLI 用法清单**。必做/可做/不能做边界 + 完整动词。**rlab 演进时跟着改**。
4. \`conventions/coding.md\` — **编码规范**。类型标注、显式 import、pathlib、logging、pytest、文件头 docstring。**项目用别的语言时整章替换**。
5. \`conventions/experiments.md\` — **实验流程**。MANIFEST.json、中断安全、smoke、广度优先、时间记录。**ML/科研项目复用度极高**。
6. \`conventions/git.md\` — **Git 规范**。分支命名、提交前缀、禁止提交清单。
7. \`conventions/writing.md\` — **文档与绘图规范**。语言规则、matplotlib 论文风格、文档写作原则。

每份 \`conventions/*.md\` 末尾都留 \`## 项目特定补充\` 段——本项目特有的硬约束(GPU 数、模型路径、framework 选型、命名约定、外部服务端口等)往那里追加,不要稀释通用规则段落。

## 由 rlab 管理(不要手改)

- \`../research/nodes/**.json\` — 节点真值,只能用 \`rlab\` CLI 读写。
- 任何形如 \`tasks/\`、\`evidence/\` 的旧 INDEX 文件,若有,是历史导入产物,结构真值仍在 nodes。

## design/(按需新增,无固定清单)

项目特定的技术设计文档放这里:理论推导、子系统设计、相关工作综述、外部接口规约等。文件名自由(建议带日期或编号便于排序),按需在 conventions 或 overview 里引用。
`;
}

/** docs/overview.md —— 研究宪章(含待研究者填写的占位)。 */
export function renderOverviewMd(opts: ScaffoldOptions): string {
  return [
    '# ' + opts.projectName + ' — 研究宪章(overview)',
    '',
    '> 这是 AI 必读的项目大背景。把"研究什么、为什么、有哪些约束、当前有哪些方向"讲清楚。',
    '',
    '## 现象 / 研究主线',
    '',
    '<一句话讲清楚本项目在研究什么现象、主线是什么>',
    '',
    '## 为什么值得做',
    '',
    '<动机:解决什么问题、对谁有价值、相比已有工作的新意>',
    '',
    '## 约束',
    '',
    '<环境/算力/数据/方法上的硬约束,AI 行动必须贴合>',
    '',
    '## 当前方向(threads)',
    '',
    '<列出当前正在推进的研究方向;正式方向由 rlab 维护,这里只做人读概览>',
    '',
  ].join('\n');
}

/** docs/conventions/collaboration.md —— 跨项目复用的协作行事准则。 */
export function renderConventionCollaboration(opts: ScaffoldOptions): string {
  return `# ${opts.projectName} — 协作行事准则

> 这些是 Agent 处理任务时的硬性风格约定,优先级**高于**「把活干完」。本文长期稳定、跨项目共用。

## 1. 判断力 > 执行力(最重要)

出现以下信号时,**立刻停止执行**,诚实报告问题、列出 2-3 条可选方向,让研究者决定:

- 核心假设被数据推翻(实验结果与预期相反、且差异显著)
- 方法过于简单可能存在根本缺陷(比如对照组设置错误)
- 方向有根本问题(比如选错了 baseline、选错了 benchmark、选错了指标)
- 资源消耗远超预算(预估 2 小时跑完结果跑了 10 小时还没结束)
- 反复修同一个 bug 修不掉(超过 3 轮还在 trial-and-error)

**绝不**因为「算力空着」「研究者之前说过继续」「不想打扰研究者」就在有问题的方向上继续投入。**判断方向是否值得走,比多跑实验更重要**。

## 2. 诚实第一

- 负结果照样进 evidence,**不要求每个实验都"有效果"**。
- 不夸大效果、不在汇报里掩盖失败。
- 被问到「能否投稿」「是否有创新」「这个想法值得做吗」时给**诚实判断**,而不是顺着研究者的期望说。
- 自己跑错的实验、写错的代码、误判的方向,主动标记并 \`rlab invalidate\` / \`rlab supersede\`,不要悄悄盖过去。

## 3. 快速探针先于放量

任何耗时实验(估计 > 30 分钟)必须先做 smoke / 探针:

1. **小样本验证管道**:用 1-5 条样本走完完整流程,确认数据加载、模型加载、日志输出、错误处理都正常。
2. **前提验证**:核心假设要在 smoke 中就能初步验证(哪怕信号弱)。前提不成立就停下换路。
3. **时间估算**:smoke 跑完后才算出全量耗时;如果远超预期,先汇报再决定要不要跑。

不盲目跑大实验,不"先开起来再说"。

## 4. 抛选项用 AskUserQuestion

需要研究者做选择时,**用 AskUserQuestion 工具**,让研究者用方向键和回车快速回答,避免打字。一次最多一个核心问题,选项 2-4 个、互斥、推荐项放第一个并标 "(推荐)"。

不适用场景:研究者在征求你的分析/意见时(此时直接给观点),或者讨论是开放性头脑风暴时。

## 5. 真实系统优先

在**真实的、被学界认可的框架**上做研究(标准 benchmark、被引用的代码库、官方数据集),避免 toy experiment 自证。如果必须用合成数据,要在 evidence 中明确说明边界。

## 6. 接手工作先看 \`rlab brief\`

每个会话开头先跑 \`rlab brief --rich\` 拿到整张研究图的状态骨架:有哪些 thread/idea/task/evidence、哪些 task 还 open、哪些张力未解、哪些方向停滞。**用图里的事实**回答研究者的问题,不要凭印象编造。

对具体方向感兴趣时再 \`rlab show <id> --deep\` 深挖单子树。

## 7. 后台进程用 tmux,不用 nohup

需要跑长时间的训练/服务/实验进程,用 \`tmux new-session -d -s <name> "<cmd>"\` 启动,以便随时 \`tmux attach\` 看输出。**不要用 nohup**——观测不便,出问题难定位。

## 8. 临时文件别写 /tmp 根

服务器上 \`/\` 分区通常很小且全机共享。所有临时日志、中间产物、克隆的外部仓库,**显式写到项目 tmp 或 \`/mnt/<user>/tmp/\`**,绝不直接 \`/tmp/xxx\`。绝不动 \`/tmp\` 下其他用户的文件。

## 项目特定补充

<本项目特有的协作约定。例如:

- 跑实验前必须确认哪个 vLLM 端口在工作
- 跑前要 \`nvidia-smi\` 确认 GPU 空闲
- 不可在工作时段(9:00-22:00)跑会卡 GPU 的大实验

按需追加,删除尖括号占位提示。>
`;
}

/** docs/conventions/coding.md —— 跨项目复用的编码规范。 */
export function renderConventionCoding(opts: ScaffoldOptions): string {
  return `# ${opts.projectName} — 编码规范

> 通用编码约定。本文以 Python 科研项目为默认假设;其他语言项目用对等规则替换。

## 1. 函数签名必须有类型标注

新写的函数、类方法、公开 API 都加完整类型标注(包括返回值)。这让 IDE 能给静态检查,也让阅读者一眼看懂数据流。

\`\`\`python
def compute_accuracy(preds: torch.Tensor, labels: torch.Tensor) -> float:
    ...
\`\`\`

## 2. 显式 import,禁止通配符

只允许 \`from module import name1, name2\`,**不允许** \`from module import *\`。通配符 import 让"这个符号从哪来"无法追溯,也容易污染命名空间。

\`\`\`python
# OK
from torch.nn.functional import softmax, cross_entropy

# 禁止
from torch.nn.functional import *
\`\`\`

## 3. 文件路径用 pathlib.Path,不用字符串拼接

\`\`\`python
from pathlib import Path

# OK
data_dir = Path("/mnt/data") / project_name / "outputs"
data_dir.mkdir(parents=True, exist_ok=True)
for f in data_dir.glob("*.jsonl"):
    ...

# 不推荐
data_dir = "/mnt/data/" + project_name + "/outputs/"
os.makedirs(data_dir, exist_ok=True)
\`\`\`

## 4. 库代码用 logging,不用 print

库代码(\`src/<lib>/\` 下)用 \`logging\` 模块;脚本入口(\`experiments/\`、\`scripts/\`)可以用 print 直观输出进度,但跨脚本的库函数始终用 logging。

\`\`\`python
import logging
logger = logging.getLogger(__name__)

def load_model(path: Path) -> nn.Module:
    logger.info("Loading model from %s", path)
    ...
\`\`\`

## 5. 配置 YAML/JSON,输出 JSON/JSONL

- **配置文件**:用 YAML(人写好读)或 JSON(机器友好)。
- **实验输出**:用 JSON(单结果)或 JSONL(append 流)。每行 JSONL 必须能被 \`json.loads()\` 单独解析。
- **不用** pickle 存可读结果(只用在中间状态缓存)。

## 6. 测试用 pytest,聚焦核心算法正确性

- 测试文件命名 \`test_<module>.py\` 与源码同级或在 \`tests/\` 下。
- 重点测**核心算法**(数学正确性、边界条件、回归用例),不强求 100% 覆盖率。
- 外部 IO(磁盘、网络、模型加载)用 fixture 或注入 fake,保持单测速度。

## 7. 文件头 docstring(每个 src/ 下的 .py 都必须有)

\`\`\`python
"""
<一句话概述>

<详细说明:做什么、为什么、核心逻辑、与其他模块关系>
"""
\`\`\`

- 让读者不看代码就能理解文件功能。
- 测试文件说明测试对象与场景。
- 语言用英文(代码本身就是英文上下文)。

## 8. 行内注释只加在以下位置

- 非显而易见的算法步骤(为什么这样做)
- 重要的分支判断
- 容易误解的参数/返回值
- 性能相关的设计选择
- 与外部系统交互的假设

不要写"i 自增 1"这种废话注释。

## 9. 张量/矩阵约定(ML 项目通用)

- 权重矩阵 PyTorch 约定:shape \`[out_features, in_features]\`。
- 行向量约定:\`Y = X @ W.T\`(与 \`nn.Linear\` 一致)。
- 数学公式里的 \`W\`(in × out)= 代码里的 \`W.T\`,转换要写在注释里。
- 写入权重前 \`.T\` 转回 PyTorch 格式再 \`.copy_()\`。

## 10. 推理上下文用 \`torch.no_grad()\`

\`\`\`python
with torch.no_grad():
    logits = model(input_ids)
\`\`\`

省显存、避免梯度图意外保留。inference 时永远加,training 时按需。

## 项目特定补充

<本项目特有的编码约定。例如:

- 我们用的 framework 版本(PyTorch 2.6+cu124,Transformers 4.45)
- 项目专用 helper(\`src/utils.py\` 的某函数)调用规范
- 子模块(如 \`eval_fi/\`)禁止直接编辑
- 命令行入口(\`python -m mymodule\`)的 entrypoint 路径

按需追加,删除尖括号占位提示。>
`;
}

/** docs/conventions/experiments.md —— 跨项目复用的实验流程规范。 */
export function renderConventionExperiments(opts: ScaffoldOptions): string {
  return `# ${opts.projectName} — 实验流程规范

> 怎么设计、运行、保存、归档一个实验。本文长期稳定,跨 ML/科研项目高度复用。

## 1. 实验数据标签(MANIFEST.json)

**每个实验输出目录都必须包含 \`MANIFEST.json\`**。没有 MANIFEST 的数据不可用于论文、不可作为后续实验的基线。

必须字段示例:

\`\`\`json
{
  "experiment": "007-ablation-rotation",
  "purpose": "验证 rotation matrix 对 attention head 输出方差的影响",
  "date": "2026-06-22",
  "model": "Llama-3.1-8B-Instruct",
  "hardware": "4x A100-PCIE-40GB",
  "config": {
    "rotation_method": "hadamard",
    "rate": 1e-6,
    "max_tokens": 256
  },
  "sample_config": {
    "task": "gsm8k",
    "sample_count": 200,
    "seeds": [0, 1]
  },
  "status": "complete",
  "evidence_doc": "docs/evidence/007-rotation-ablation.md"
}
\`\`\`

规则:

- **创建输出目录时立即写 MANIFEST**,不要等实验跑完。
- \`status\` 字段从 \`running\` → \`complete\` / \`failed\` / \`superseded\`。\`superseded\` 表示已被后续实验替代。
- 探针/调参的小实验也要 MANIFEST(可以简化字段),否则数据没法追溯。
- 数据迁移过来的加 \`"migrated_from"\` 字段记录来源。

## 2. 中断安全与恢复

**写入侧**:

- 每条 sample 完成后**立即 append** 到 JSONL,写后 flush。
- summary.json 每批(如 50 条)重生成。
- **禁止临时文件 rename 模式**——直接写目标路径。

**恢复侧**:

- 启动前扫描输出目录,已完成的跳过,未完成的从断点 append 续跑。
- 有效 sample 判定:能被 \`json.loads()\` 解析的完整行;尾部截断行丢弃。
- 恢复时日志报告跳过和续跑的组合(几条新跑、几条跳过)。

**异常 sample**:

- 错误 sample 记录到 JSONL 但标记 \`"error": true\` + 错误类型 + traceback 摘要。
- 聚合统计时排除 \`error: true\`,**但不静默丢弃**——保留供调查。

## 3. 实验执行原则:广度优先

1. **先全面后精确**:每个维度至少一轮数据,再回头加厚单维度。
2. **粗扫在先**:先跑 low/mid/high 三点确认趋势,再细化。
3. **齐头并进**:以 round 为单位推进所有任务,而不是把第一个任务跑到完美再开始第二个。
4. **随跑随存**:每条 sample 完成即 append,**不要**等批次结束再写。
5. **模型切换最少化**:同模型所有任务连续执行,减少加载开销。

## 4. 时间记录

- **每条 output 记录**必须包含 \`elapsed_sec\`(该条耗时秒数)和 \`timestamp\`(ISO 8601)。
- **evidence 文档**必须在「实验设置」或「元信息」部分注明实验总耗时(wall-clock)、起止时间、机器配置。

\`\`\`python
import time, datetime
start = time.time()
... run sample ...
record = {
    "input": ...,
    "output": ...,
    "elapsed_sec": time.time() - start,
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
\`\`\`

## 5. 长实验先 smoke

任何预估超过 30 分钟的实验:**先跑 1-5 条 smoke**,确认模型服务、数据加载、日志、错误处理都正常,再 scale up。前提不成立就停下换路,**不要**"先开起来再说"。

## 6. 实验目录 README 要求

每个 \`experiments/<exp_name>/\` 必须含 \`README.md\`(中文):

1. **宏观视角**:在本项目研究中的位置、服务哪个 thread 或研究问题
2. **关联编号**:对应 \`rlab\` 中的 task/evidence id
3. **实验概要**:做了什么、对比什么、核心参数
4. **运行方式**:命令行、前置条件(GPU、环境、依赖服务)
5. **输出说明**:输出文件位置、格式、解读方法

## 7. 效率优先(正确性前提下)

正确性确认后,**优化效率再放量**:并发请求、批处理、复用服务进程、避免冷启动。不要用串行慢跑跑大规模实验。验证并发与串行结果一致后再 scale。

## 8. evidence 归档时机

实验跑完且结论确认后**才**写 evidence 节点(\`rlab conclude task/NNN ...\`):

- evidence 重点:**数据说明什么、学到什么**,而不是"我跑了什么命令"。
- 自然语言描述,避免贴大段配置或 log。
- 每份 evidence 独立可读(假设读者没看过对应 task)。
- 失败/无效的 evidence 用 \`rlab invalidate\` 标记原因,保留备查。

## 项目特定补充

<本项目特有的实验规则。例如:

- 必须用 vLLM 部署作为推理后端,不可直接 transformers.generate
- 实验脚本默认 batch_size=16,A100-40GB 不可超
- 跑前先 \`source env.sh\` 加载 \`TMPDIR\` 等关键环境变量
- 特定 benchmark 的版本/数据路径

按需追加,删除尖括号占位提示。>
`;
}

/** docs/conventions/git.md —— 跨项目复用的 Git 规范。 */
export function renderConventionGit(opts: ScaffoldOptions): string {
  return `# ${opts.projectName} — Git 规范

> 简单、明确、可追溯。本文长期稳定。

## 1. 分支命名

- \`main\` / \`master\`:稳定分支,默认从这里切。
- \`feat/<描述>\`:新功能开发(如 \`feat/streaming-eval\`)。
- \`fix/<描述>\`:Bug 修复(如 \`fix/oom-on-long-prompt\`)。
- \`exp/<实验名>\`:一次性实验性分支(如 \`exp/quantize-int4\`),做完决定保留或丢弃。
- \`docs/<描述>\`:仅文档更新。

分支名小写、用 \`-\` 连接,不超过 50 字符。

## 2. 提交前缀(Conventional Commits)

\`\`\`
feat: 新功能
fix:  修 bug
docs: 文档
test: 测试
refactor: 重构(不改行为)
chore: 杂事(依赖升级、构建脚本)
exp:  实验代码/数据
perf: 性能优化
\`\`\`

格式:\`<type>: <一句话描述>\`(中文 OK)。

示例:

\`\`\`
feat: 加 rotation matrix 接入 attention head
fix: 修复长 prompt 触发 OOM 的边界
docs: 补 MANIFEST.json 字段说明
exp: 跑 quantize-int4 在 gsm8k 的对照
\`\`\`

## 3. 每次提交一个逻辑变更

- 不要把"加功能 + 修无关 bug + 改格式"塞一个提交。
- 大功能拆成多个小提交,每个都能独立 build/test 过。
- Commit message 重点说**为什么**改,而不是堆"什么文件改了哪行"——后者 \`git diff\` 看得到。

## 4. 禁止提交清单

**绝不**提交以下内容(配 \`.gitignore\`):

- 模型权重(\`*.bin\`、\`*.safetensors\`、\`*.pth\`)
- 大型输出数据(\`output/\`、\`results/\`、\`logs/\`,只保留 \`.gitkeep\` 占位)
- 密钥/凭据(\`.env\`、\`credentials.json\`、SSH 私钥)
- 临时缓存(\`__pycache__/\`、\`*.pyc\`、\`.pytest_cache/\`、\`.ipynb_checkpoints/\`)
- 备份文件(\`*.bak\`、\`*~\`、\`*.swp\`)
- 编辑器配置(\`.vscode/\`、\`.idea/\`,除非项目共享配置)

\`rlab init\` 已生成基础 \`.gitignore\`,根据项目实际再补。

## 5. 合并策略

- 短分支(< 5 commits)用 fast-forward merge 保线性历史:\`git merge --ff-only feat/xxx\`。
- 长分支或带回滚意义的分支用 merge commit:\`git merge --no-ff feat/xxx\`。
- 不要 force-push 共享分支(\`main\` / \`master\`)。

## 6. 中文 commit message 鼓励

中文项目中文写 commit 更准。但**类型前缀保持英文**(\`feat:\` 不写"功能:"),方便工具解析。

## 项目特定补充

<本项目特有的 Git 约定。例如:

- 必须挂 pre-commit hook 跑 ruff/black
- 跨子模块改动要单独 commit
- 实验数据用 git-lfs 管理(配置见 \`.gitattributes\`)
- PR 模板要求

按需追加,删除尖括号占位提示。>
`;
}

/** docs/conventions/writing.md —— 跨项目复用的文档与绘图规范。 */
export function renderConventionWriting(opts: ScaffoldOptions): string {
  return `# ${opts.projectName} — 文档与绘图规范

> 写给人看的东西怎么写、画给论文用的图怎么画。

## 1. 语言规则

- **代码**(标识符、注释、docstring):英文。代码本身就是英文上下文,中文标识符不利于工具链。
- **文档**(\`docs/*.md\`、\`README.md\`、evidence、task):中文。研究者中文思考,中文文档读得更准。
- **图表**:**图中文字必须英文**——论文风格,投稿时不用重画。

## 2. 文档写作原则

- **自然语言为主**,避免大段贴命令/配置/log;那些放代码块或链接到附件。
- **每个文档独立可读**:假设读者第一次接触本文,不要"承接上一篇"地写。
- **重点是「为什么」和「学到了什么」**,不只是"做了什么"。
- **简洁**:能 100 字说清的不写 500 字。
- **结构清晰**:用 \`##\` 二级标题划分逻辑段,避免一长段铺到底。

## 3. evidence 写作要点

- 第一段:**核心结论**一两句话。读者可能只读这一段就走。
- 后续:实验设置(简要)、数据(表格或图)、结论分析、局限/边界。
- **负结果照样写**——"我们假设 X,数据显示不成立,可能原因是 Y"。这有信息量。
- 不要堆原始命令——可以在末尾给一个"复现:\`<script-path>\`"的链接,自己跑过的人能找到代码。

## 4. task 写作要点

- 第一段:**想验证什么、为什么值得做**。
- \`expectation\` 字段:**事先**写下预期结果(如"如果假设 X 成立,我们应该看到 metric M 比 baseline 高至少 5%")。这是事后判断"实验是否成功"的锚点,避免后视镜偏误。
- 设计简述:对照组、变量、控制变量、benchmark。
- 关联:这个 task 服务哪个 thread、由哪个 idea 衍生。

## 5. matplotlib 论文风格(默认配置)

所有用于论文的图都用 matplotlib + serif 字体 + 色盲友好配色 + 同时保存 PDF/PNG。**所有图中文字必须英文**。

\`\`\`python
import matplotlib.pyplot as plt
plt.rcParams.update({
    'font.family': 'serif',
    'font.size': 11,
    'axes.labelsize': 12,
    'legend.fontsize': 10,
    'figure.dpi': 300,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
})
plt.style.use('tableau-colorblind10')  # 色盲友好配色
\`\`\`

保存:

\`\`\`python
fig.savefig("figures/rotation_ablation.pdf")  # 矢量
fig.savefig("figures/rotation_ablation.png", dpi=300)  # 高 DPI 位图
\`\`\`

- PDF 是论文首选(矢量、无失真)
- PNG 用于网页/PPT/快速预览
- 文件名小写、用 \`_\` 连接,与对应 evidence 文档编号对齐(如 \`fig_007_rotation.pdf\`)

## 6. 图表内容原则

- **一个图回答一个问题**,不要把 4 个独立现象塞一张图。
- **坐标轴标签必有单位**(\`Accuracy (%)\`、\`Latency (ms)\`)。
- **图例放在不挡数据的位置**(常用 \`loc='best'\` 或显式坐标)。
- **error bar**:多 seed 实验用 \`errorbar\` 或阴影带显示方差。
- **配色**:用一致的 baseline 颜色(如 baseline 灰、proposed 蓝),让多张图之间能横向对照。

## 项目特定补充

<本项目特有的文档/绘图约定。例如:

- LaTeX 论文模板路径
- 公司/学校 branding 配色 hex 码
- 数据可视化用的特定 library(plotly、bokeh 等)
- 投稿目标会议/期刊的具体图片规范

按需追加,删除尖括号占位提示。>
`;
}

/**
 * docs/conventions/research-workflow.md —— rlab CLI 完整用法。
 * 把原 CLAUDE.md 的"研究图共享工作台"整段搬来,加上完整的 33 动词清单。
 */
export function renderConventionResearchWorkflow(opts: ScaffoldOptions): string {
  return `# ${opts.projectName} — 研究图工作流(rlab CLI 用法)

> 研究图是研究者和 Agent 的**共享工作台**。本文是 Agent 操作研究图的完整使用手册。
> 结构真值在 \`research/nodes/**.json\`,**只能用 \`rlab\` 命令读写**(已全局安装,在任意终端可调)。

## 节点的两层结构:JSON 真值 + 散文版

每个 thread / idea / task / evidence 节点都由**两份文件**共同表达:

1. **\`research/nodes/<type>s/<id>.json\`** — **结构真值**。短摘要、状态、边、result、manifest 等。**只允许 \`rlab\` 命令读写,绝不手改**。schema 校验在 CLI 里,绕过 = 数据腐败。
2. **\`research/text/<type>/<id>.md\`** — **给人和 AI 读的散文版**。Agent 可以(也应该)在研究者要求时手写或编辑这份 md。**结构上 rlab 不解析它**,但**任何 Agent 接手任何节点前都应该读这份 md**——这是项目长期记忆的真正承载。

### 散文 md 应该写什么

- **thread**: 研究主线全景、核心问题、关键判断的演进、当前阶段、与其他 thread 的关系
- **idea**: 想法的来龙去脉、动机、预期价值、与现有 evidence 的关联、验证它需要的实验
- **task**: 完整的**实验设计** — 动机(为什么做)、目的(要回答什么)、设计(对照/变量/控制)、工具与数据集、做法步骤、预期结果与判定标准、实际跑下来发现了什么
- **evidence**: **实验报告** — 目的、setup、数据规模、关键发现(配图/表/数字)、与预期对照、局限边界、对下游 task/idea 的指引
- **reference**: 论文的关键贡献、与本项目的关系(借鉴/对照/反驳)、关键数据点

### 何时写

- **task 写散文**:开始写实验脚本前、定下实验设计时;实验跑完后回填"实际发现"段
- **evidence 写散文**:实验跑完且数据稳定、要 conclude 时;**conclude 前 md 必须存在**(没有 md 的 evidence 是临时记录)
- **thread/idea 写散文**:首次创建时写一两段,随阶段推进追加

### 命名约定

- 路径:\`research/text/<type>/<id>.md\`,例如 \`research/text/task/007.md\`、\`research/text/evidence/03.md\`、\`research/text/thread/01.md\`
- 编号与 JSON 节点 id 完全一致(\`task/007\` ↔ \`research/text/task/007.md\`)
- 网页节点详情页会自动加载这份 md 并渲染,所以**写好它就直接在网页上能看到**

### Agent 必读

接手任何节点级工作前(回答 task 进展、调整 evidence 结论、决定下一个实验等),**先读对应的 \`research/text/<type>/<id>.md\`**——它比 JSON 里的 \`summary\` 字段详细得多,你需要的上下文都在那里。

## 你必须做的

### 每个会话开头先读图

\`\`\`bash
rlab brief --rich
\`\`\`

拿到整张图的状态卷积骨架(几十 KB,放心入上下文):各 thread 下子状态计数、张力数、最新 evidence 等。这是回答研究者任何"现状"类问题的起点。

如某方向相关,进一步:

\`\`\`bash
rlab show <id> --deep      # 深挖单子树
\`\`\`

### 回答前先问图

研究者问「之前怎么验证 X」「这个 idea 有没有结论」「我们试过哪些 baseline」等问题时,**先翻图再答**:

\`\`\`bash
rlab find <关键词>          # 全文搜
rlab list --type task --status open
rlab show task/007         # 看单节点详情
\`\`\`

**用图里的事实**回答,不是凭印象编造。研究图就是项目的长期记忆。

### 回答「现在该做什么」用 rlab next

\`\`\`bash
rlab next
\`\`\`

它列出全部 open task + 未解 tension + 被作废拖累的下游 + 孤儿 idea + 停滞 thread。直接复制给研究者看,然后一起决定优先级。

## 你可以做的(只在研究者明确要求下)

### 新增节点

\`\`\`bash
# 研究者:"把这个想法记成 idea"
rlab add idea --title 'XYZ' --parent thread/003

# 研究者:"建一个实验做 X"
rlab add task --title '对照实验 ABC' --parent thread/003 --expectation '预期会看到 metric Y 提升 5%'

# 研究者:"记一篇相关论文"
rlab add reference --title 'ReaLM (DAC 2025)' --as k2025-realm --url '...'
\`\`\`

### 推进/结论节点

\`\`\`bash
# 研究者:"这个实验做完了,结果是阳性"
rlab conclude task/007 --result positive --summary '排序确认' --output output/007 --manifest output/007/MANIFEST.json

# 研究者:"这个实验跑完发现是反例"
rlab conclude task/008 --result negative --summary '反例'

# 研究者:"暂时阻塞这个"
rlab block task/009 --on task/010 --note '依赖 010 的环境'
rlab unblock task/009
\`\`\`

### 记录张力 / 替代 / 作废

\`\`\`bash
# 研究者:"这两个结论矛盾"
rlab contradict evidence/005 evidence/009 --note '设置微差'
# 后来澄清:
rlab resolve <tension-id> --note '换种 metric 后两者不再冲突'

# 研究者:"废弃这个旧版本,用新版"
rlab supersede task/013 --by task/024 --reason '重新设计'

# 研究者:"这个证据塌了"
rlab invalidate evidence/002 --reason 'fi_server 参数有误'
# 然后看影响(要能列出东西,前提是这条链路当初用 --label depends-on 连过边——见下面「连边」):
rlab affected-by evidence/002      # 列出被这条作废拖累的下游

# 研究者:"这个想法不值得继续"
rlab drop idea/015 --reason '方向不值得'
\`\`\`

### 拆分 / 合并 / 连边

\`\`\`bash
# 研究者:"这个想法拆成两个子方向"(split/merge 目前只认 idea 节点,--into 是逗号分隔的一个参数)
rlab split idea/015 --into '子方向 A,子方向 B'

# 研究者:"这几个想法算是想通了,可以立项了"(合并的产物固定是新建一个 task)
rlab merge idea/015 idea/016 --title '立项:统一做法'

# 一般化的连边
rlab link task/007 evidence/008 --label produces
rlab unlink task/007 evidence/008

# 表达"这个依赖那个还没做完的" —— affected-by 只沿 label=depends-on 的边反向找下游,
# 别的 label(比如上面的 produces)不会被它计入,想让 affected-by 有用就得显式连这条边
rlab link task/010 task/009 --label depends-on

# 容器关系(子节点搬家)
rlab contain thread/003 idea/015
\`\`\`

### 关联外部产物

\`\`\`bash
rlab link-code task/007 --path src/rotation_module.py
rlab link-output task/007 --path output/007
\`\`\`

## 你绝对不能做的

- **不许自驱重构知识图**:研究者没明示,你就**绝不** add / supersede / invalidate / contradict / merge / split。哪怕你「觉得」应该。这是三权分立的核心边界。
- **不许手改 \`research/nodes/**.json\`**:schema 校验在 CLI 里,绕过 = 数据腐败。下次 \`rlab doctor\` 会报错。
- **不许从 \`research/text/**.md\` 解析结构**:散文是给人看的,**结构永远在 JSON**。如果需要结构化信息,用 \`rlab show --json\`。
- **不许假装做了 rlab 操作**:做就做了、有产出有 id 可以引用;没做就坦白告诉研究者"这需要我跑 rlab,可以吗?"

## 完整动词清单

**读**(都安全,随便用):

\`\`\`
brief [--rich]              # 整张图骨架
show <id> [--deep]           # 单节点详情(--deep 展开子树)
find <q>                     # 全文搜
list [--type T] [--status S] # 列节点
next                         # 综合"该做什么"
open                         # 列 open task
tensions                     # 列未解张力
stale [--days N]             # 列长期没更新的节点
orphans                      # 列孤儿 idea
stagnant [--days N]          # 列停滞 thread
affected-by <id>             # 反向传播:被这条作废拖累的下游
analyze                      # 图统计(类型分布、状态分布等)
\`\`\`

**写**(只在研究者明示时用):

\`\`\`
add <type> --title ...       # 新增节点
set <id> <field> <value>     # 改字段
link <from> <to> [--label L] # 连一条边
unlink <from> <to>           # 断一条边
contain <parent> <child>     # 容器关系
split <id> --into ...        # 拆分
merge <id> --into <other>    # 合并
conclude <task-id> --result ... # 任务结案,自动建 evidence
supersede <id> --by <new-id> # 替代
invalidate <id> --reason ... # 作废
drop <id> --reason ...       # 弃置 idea
block <id> --on <other-id>   # 阻塞
unblock <id>                 # 解阻
contradict <a> <b> --note    # 记一条张力
resolve <tension-id> --note  # 澄清张力
alias <id> --as <slug>       # 改短名(reference 常用)
status <id> <new-status>     # 改状态(慎用,通常 conclude/invalidate 等会自动改)
link-code <id> --path        # 关联代码
link-output <id> --path      # 关联输出目录
\`\`\`

所有命令都支持 \`--json\` 输出结构化结果。\`rlab --help\` 看完整签名,\`rlab <verb> --help\` 看单动词参数。

## 一些常见问答

**Q: 我能不能"建议研究者 invalidate 一下 evidence/002"?**
A: 能。建议是 Agent 的职责。**但不要直接执行**,等研究者明确说"做"再做。

**Q: 研究者一句话说"刚才那个实验失败了",我应该 conclude 还是 invalidate?**
A: 看上下文。"实验跑完发现是反例" → \`conclude --result negative\`;"实验设置错了、跑出来的数没意义" → \`invalidate --reason ...\`。**拿不准就问**研究者。

**Q: 我想"顺手"把孤儿 idea 都 drop 了,可以吗?**
A: 不可以。\`drop\` 是结构变更,必须研究者明示。你能做的是用 \`rlab orphans\` 列出来,问研究者要不要处理。

## 项目特定补充

<本项目特有的 rlab 用法约定。例如:

- 默认 thread/idea/task 命名前缀(项目编号)
- 必填字段(如 task 必须填 \`expectation\`)
- 特殊关系:某项目把"对照实验"统一连 \`compared-with\` 边
- 触发什么条件要立刻通知研究者(如 5 个连续 negative evidence)

按需追加,删除尖括号占位提示。>
`;
}

/** 追加进 .gitignore 的片段。 */
export const GITIGNORE_SNIPPET: string = [
  '# --- research workflow ---',
  'output/*',
  '!output/.gitkeep',
  'research/.index/',
  '*.bak',
  '',
].join('\n');

export interface TemplateFile {
  path: string;
  render: (opts: ScaffoldOptions) => string;
}

/**
 * 需写入仓库的模板文件(path 相对仓库根)。
 * 顺序与 CLAUDE.md / docs/CLAUDE.md 必读路线一致,Agent 顺读时观感连贯。
 */
export const TEMPLATE_FILES: TemplateFile[] = [
  { path: 'CLAUDE.md', render: renderClaudeMd },
  { path: 'docs/CLAUDE.md', render: renderDocsClaudeMd },
  { path: 'docs/overview.md', render: renderOverviewMd },
  { path: 'docs/conventions/collaboration.md', render: renderConventionCollaboration },
  { path: 'docs/conventions/research-workflow.md', render: renderConventionResearchWorkflow },
  { path: 'docs/conventions/coding.md', render: renderConventionCoding },
  { path: 'docs/conventions/experiments.md', render: renderConventionExperiments },
  { path: 'docs/conventions/git.md', render: renderConventionGit },
  { path: 'docs/conventions/writing.md', render: renderConventionWriting },
];
