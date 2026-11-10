import { capabilityKey, compose } from "@silker/core";
import type {
  App,
  HistoryCommand,
  Plugin,
  SerializedCommand,
  Text,
} from "@silker/core";
import type {
  HistoryCapability,
  TextEditorCapability,
  SelectionCapability,
} from "@silker/core";
import type { MindEdge } from "./Edge";
import type { ActivationController } from "./editing";
import type { MindTree } from "./model";
import type { MindMapChangeType, MindMapNode } from "./types";

// AI 编辑插件：AI 能力契约 + 控制器 + 能力注册插件。
// 包内只定义"AI 编辑"的领域协议（操作 DSL / 上下文快照 / 应用管线），不绑定任何
// 具体 LLM SDK——宿主经 MindMapOptions.ai 注入生成适配器（拿到上下文快照 → 调
// 自家大模型 → 返回操作数组），控制器把操作编译为与手动编辑同源的历史命令
// （mindmap.paste / mindmap.text / mindmap.delete），撤销/重做与历史导入导出
// 全部复用现有链路，AI 编辑与手动编辑在历史语义上无差别。

// ---- AI 操作 DSL（LLM 输出的协议）----

// 在目标节点下插入子树：index 缺省追加到末尾（index 为插入后的兄弟位次，0 起）；
// nodes 为完整子树数据（text 必填，children/style/collapsed 递归可选）。
// target 可选：节点 id / 节点文本 / 路径（"A/B/C"）/ 带序号文本（"文本[2]"），
// 缺省为锚点节点（当前激活节点）
export interface AIMindMapAddOp {
  op: "add";
  target?: string;
  index?: number;
  nodes: MindMapNode[];
}

// 修改目标节点文本（target 缺省为锚点节点）
export interface AIMindMapEditOp {
  op: "edit";
  target?: string;
  text: string;
}

// 移动节点子树到新父节点下（结构重组：换父 / 同父排序）。
// parent 缺省为根节点；index 缺省追加到末尾；不能移动到自身子树内
export interface AIMindMapMoveOp {
  op: "move";
  target?: string;
  parent?: string;
  index?: number;
}

// 删除目标节点及其整个子树（根节点不可删；target 缺省为锚点节点）
export interface AIMindMapDeleteOp {
  op: "delete";
  target?: string;
}

// 用完整新导图数据整体替换当前导图（重排/重构/重新生成类指令）：
// tree 为完整新树数据（根节点 text 必填，children/style/collapsed 递归可选，
// 节点可沿用原 id 或省略——省略时运行时自动生成），一条操作即一个原子变更
export interface AIMindMapRenderOp {
  op: "render";
  tree: MindMapNode;
}

// 回答类回复：AI 对提问/咨询的自然语言回答（不修改导图）。
// LLM 输出 {"op":"answer","text":"..."} 或 {"answer":"..."} 或纯文本均可
export interface AIMindMapAnswerOp {
  op: "answer";
  text: string;
}

// 撤销最近一次变更：直接驱动既有历史链（与手动 Ctrl+Z 完全同源），
// 不进入本次 run 的组合命令；可连用多次，不能与编辑类操作混用
export interface AIMindMapUndoOp {
  op: "undo";
}

// 重做最近一次被撤销的变更：语义与 undo 对称
export interface AIMindMapRedoOp {
  op: "redo";
}

// 读取历史：返回当前撤销/重做栈中各条变更的可读描述（只读，不修改导图）。
// 用户问"刚才改了什么/做过哪些操作"时使用，描述并入本次 run 的 answer
export interface AIMindMapHistoryOp {
  op: "history";
}

export type AIMindMapOp =
  | AIMindMapAddOp
  | AIMindMapEditOp
  | AIMindMapMoveOp
  | AIMindMapDeleteOp
  | AIMindMapRenderOp
  | AIMindMapAnswerOp
  | AIMindMapUndoOp
  | AIMindMapRedoOp
  | AIMindMapHistoryOp;

// 生成适配器的输入：用户指令 + 当前树快照（带 id）+ 锚点/选中上下文。
// tree 经 model.toJSON() 导出，节点 id 与运行时同源；anchorPath 为锚点节点的
// 根起路径（"线性代数/行列式"），供模型在多同名节点时消歧
export interface AIEditRequest {
  prompt: string;
  tree: MindMapNode;
  anchorId: string;
  anchorPath?: string;
  selectionIds: string[];
  // 对话历史（宿主消息流，按时间先后，不含本次 prompt）：多轮上下文，
  // 生成适配器可自行组装多轮消息，defaultAIEditPrompt 渲染进提示词尾部
  history: AIEditTurn[];
}

// 对话流中的一轮：role 限定为用户/助手（宿主侧错误提示、系统层不进入此流）
export interface AIEditTurn {
  role: "user" | "assistant";
  text: string;
}

// 生成适配器契约：宿主实现（调自家 LLM），返回操作数组或其 JSON 字符串
// （控制器自动解析，容错 markdown 代码块包裹）
export type AIEditGenerate = (
  req: AIEditRequest,
) => Promise<AIMindMapOp[] | string>;

export interface AIEditRunOptions {
  // 本次操作的锚点节点 id（上下文与缺省 target 参照），缺省用当前激活节点，再退化为根节点
  anchorId?: string;
  // 对话历史（按时间先后，不含本次指令）：缺省无历史（单轮）
  history?: AIEditTurn[];
}

export interface AIEditResult {
  // 实际生效的变更条数：编辑类 run 为编译执行的命令数，undo/redo run 为成功
  // 驱动历史链的次数（被跳过的无操作不计）
  applied: number;
  ops: AIMindMapOp[];
  // 逐步执行反馈链：每条操作做了什么、落到哪个节点、是否被跳过（如改名前后相同）
  steps: AIEditStep[];
  // AI 的自然语言回答（提问/咨询类指令）：不修改导图，仅回复文本
  answer?: string;
}

// 单条操作的执行反馈：宿主可直接展示，便于定位"编辑看不到效果"类问题
// （同名文本匹配到其它节点 / 目标不存在整体失败 / 无变化被跳过）
export interface AIEditStep {
  op: AIMindMapOp;
  // 可读描述："在「前端」下添加 3 个子节点" / "将「测试」改为「质量保障」" / "删除「旧方案」及其 2 个子节点"
  label: string;
  // applied = 已执行；skipped = 无实际变化（如 edit 前后文本相同）
  status: "applied" | "skipped";
  // 实际解析到的目标节点（id + 文本）：文本匹配/锚点缺省时可见真实落点
  target?: { id: string; text: string };
}

// 能力键：消费方只认能力名与契约，不认提供方插件
export const AI_EDITING_CAPABILITY =
  capabilityKey<AIEditingController>("mindmap.ai");

export interface AIEditingDeps {
  app: App;
  model: MindTree;
  history: Pick<HistoryCapability, "exec" | "exportJSON">;
  // 撤销/重做入口（门面接线，与手动 Ctrl+Z 完全同源：含编辑态/拖拽守卫、
  // 清空选中态、重布局与宿主通知）：返回是否实际执行了一条命令
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  editor: Pick<TextEditorCapability, "bind">;
  sel: Pick<SelectionCapability<Text>, "items">;
  activation: Pick<
    ActivationController,
    "active" | "activate" | "deactivate" | "editing"
  >;
  onRelayout: () => Promise<void> | void;
  emitChange: (type: MindMapChangeType) => void;
}

// ---- 目标定位（纯函数，导出便于测试）----

// 节点的根起路径："线性代数/行列式"（文本直连，用于消歧提示与请求上下文）
export function nodePath(node: Text): string {
  const parts: string[] = [];
  let cur: Text | null = node;
  while (cur) {
    parts.unshift(cur.text);
    cur = cur.parent as Text | null;
  }
  return parts.join("/");
}

// 先序收集树 + 批内新建节点（同名文本的全量候选）
export function collectTargetCandidates(
  root: Text,
  extra?: Iterable<Text>,
): Text[] {
  const out: Text[] = [];
  const walk = (n: Text) => {
    out.push(n);
    n.children.forEach((c) => walk(c as Text));
  };
  walk(root);
  if (extra) for (const n of extra) if (!out.includes(n)) out.push(n);
  return out;
}

// 解析定位段："矩阵" → { text: "矩阵", nth: 1 }；"矩阵[2]" → 第 2 个同名节点
export function parseTargetSegment(seg: string): { text: string; nth: number } {
  const m = seg.match(/^(.*)\[(\d+)\]$/);
  if (!m) return { text: seg, nth: 1 };
  return { text: m[1], nth: Math.max(1, parseInt(m[2], 10)) };
}

// 在候选列表中按段定位（文本精确匹配 + [n] 序号消歧，n 为 1 起的先序位次）
export function matchTargetSegment(nodes: Text[], seg: string): Text | null {
  const { text, nth } = parseTargetSegment(seg);
  const hits = nodes.filter((n) => n.text === text);
  return hits[nth - 1] ?? null;
}

// 按斜杠路径定位："线性代数/矩阵" / "线性代数/矩阵[2]/行"——从根逐段下钻。
// nodePath 产出的路径以根文本开头，首段命中根文本时跳过
export function resolveTargetByPath(root: Text, path: string): Text | null {
  let cur: Text = root;
  let segs = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs[0] === root.text) segs = segs.slice(1);
  for (const seg of segs) {
    const next = matchTargetSegment(cur.children as Text[], seg);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

// 校验并规整 render 的整树数据：每层必须有 text，children 缺省补空数组
// （LLM 常省略叶子的 children），返回可直接交给 renderNode 的数据树
export function normalizeRenderTree(data: unknown, no = ""): MindMapNode {
  const node = data as MindMapNode | null;
  if (!node || typeof node.text !== "string" || !node.text)
    throw new Error(`AI render 操作的 tree 节点缺少 text${no}`);
  return {
    ...node,
    text: node.text,
    children: Array.isArray(node.children)
      ? node.children.map((c) => normalizeRenderTree(c, no))
      : [],
  };
}

// 校验并规整 LLM 返回（数组 / { ops: [...] } / JSON 字符串），非法即抛错：
// 不做"部分应用"，脏输出整体拒绝，避免半套变更破坏树结构
export function normalizeAIOps(raw: AIMindMapOp[] | string): AIMindMapOp[] {
  let data: unknown = raw;
  if (typeof raw === "string") {
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("AI 返回内容不是合法 JSON");
    }
  }
  const list = Array.isArray(data)
    ? data
    : (data as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(list)) throw new Error("AI 返回格式错误：应为操作数组");
  return list.map((item, i) => {
    const op = item as Record<string, unknown>;
    const no = `（第 ${i + 1} 项）`;
    // target 可选：缺省由控制器解析为锚点节点；提供时支持节点 id 或节点文本匹配，
    // id 只是内部细节，LLM 无需感知
    if (
      op.target !== undefined &&
      op.target !== null &&
      typeof op.target !== "string"
    )
      throw new Error(
        `AI 操作的 target 应为节点 id / 节点文本 / 路径（"A/B"）/ 带序号文本（"文本[2]"）${no}`,
      );
    if (op.op === "add") {
      if (!Array.isArray(op.nodes) || !op.nodes.length)
        throw new Error(`AI add 操作的 nodes 不能为空${no}`);
      // 逐节点规整：校验 text、children 缺省补空数组（LLM 常省略叶子的 children，
      // 直接透传会在 adoptIds 的 children.map 处崩溃）
      op.nodes = op.nodes.map((n, j) =>
        normalizeRenderTree(n, `${no} nodes[${j}]`),
      );
      if (op.index !== undefined && typeof op.index !== "number")
        throw new Error(`AI add 操作的 index 应为数字${no}`);
    } else if (op.op === "edit") {
      if (typeof op.text !== "string")
        throw new Error(`AI edit 操作缺少 text${no}`);
    } else if (op.op === "move") {
      if (
        op.parent !== undefined &&
        op.parent !== null &&
        typeof op.parent !== "string"
      )
        throw new Error(`AI move 操作的 parent 应为节点 id 或文本或路径${no}`);
      if (op.index !== undefined && typeof op.index !== "number")
        throw new Error(`AI move 操作的 index 应为数字${no}`);
    } else if (op.op === "render") {
      if (!op.tree || typeof (op.tree as MindMapNode)?.text !== "string")
        throw new Error(`AI render 操作缺少完整 tree 数据（根节点须有 text）${no}`);
    } else if (op.op === "answer") {
      if (typeof op.text !== "string" || !op.text)
        throw new Error(`AI answer 操作缺少 text${no}`);
    } else if (op.op === "undo" || op.op === "redo" || op.op === "history") {
      // 无载荷操作：undo/redo 驱动既有历史链，history 只读历史记录，无需校验字段
    } else if (op.op !== "delete") {
      throw new Error(`AI 返回了未知操作类型${no}: ${String(op?.op)}`);
    }
    return item as AIMindMapOp;
  });
}

// 解析 AI 响应为「操作 + 回答」：编辑类指令产出操作序列，提问/咨询类产出
// 自然语言回答（answer）。容错三层——
// 1. JSON 数组 / {ops:[...]}：标准操作序列，可含 {"op":"answer","text":...}（提取为 answer）
// 2. {answer:"..."} / {ops:[...],answer:"..."}：回答可独立或伴随操作
// 3. 非 JSON 纯文本：整体视为回答（LLM 对提问的直答；模型输出坏 JSON 时也能
//    看到它实际说了什么，便于诊断）
export function parseAIResponse(
  raw: AIMindMapOp[] | string,
): { ops: AIMindMapOp[]; answer?: string } {
  let data: unknown = raw;
  if (typeof raw === "string") {
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    try {
      data = JSON.parse(text);
    } catch {
      return { ops: [], answer: text };
    }
  }
  if (Array.isArray(data)) {
    const ops = normalizeAIOps(data);
    const rest = ops.filter(
      (o): o is Exclude<AIMindMapOp, AIMindMapAnswerOp> => o.op !== "answer",
    );
    const answer = ops.find((o): o is AIMindMapAnswerOp => o.op === "answer")?.text;
    return { ops: rest, answer };
  }
  const obj = data as
    | { ops?: unknown; answer?: unknown; text?: unknown; children?: unknown }
    | null;
  const answer =
    typeof obj?.answer === "string" && obj.answer ? obj.answer : undefined;
  if (obj?.ops !== undefined) return { ops: normalizeAIOps(obj.ops as AIMindMapOp[]), answer };
  // 裸树对象（{text, children, ...}）：整体视为 render 重渲染操作——模型对
  // "重新生成/重排"类指令直接输出新导图 JSON 时无需包装成操作数组
  if (typeof obj?.text === "string" && Array.isArray(obj?.children))
    return { ops: [{ op: "render", tree: normalizeRenderTree(data) }] };
  if (answer !== undefined) return { ops: [], answer };
  throw new Error("AI 返回格式错误：应为操作数组或回答文本");
}

// ---- 历史描述（history 操作的读取实现，纯函数，导出便于测试）----

// 各 kind 命令的载荷形状（与 history-codec.ts 的对应接口一致，仅取描述所需字段）
interface HistoryPastePayload {
  inserts: Array<{ parentId: string; node: MindMapNode }>;
}
interface HistoryDeletePayload {
  captures: Array<{ node: MindMapNode }>;
}
interface HistoryMovePayload {
  moves: Array<{
    nodeId: string;
    oldParentId: string;
    newParentId: string;
  }>;
}
interface HistoryTextPayload {
  before: string;
  after: string;
}

// 把单条序列化命令转为可读描述："将「前端」改为「前端开发」"。
// 节点文本按 id 经模型解析（已删/已换树节点的文本从载荷内嵌数据读取）；
// 组合命令递归描述子命令并以分号连接；未知 kind 退化为 kind 字符串
export function describeHistoryCommand(
  s: SerializedCommand,
  model: Pick<MindTree, "nodeById">,
): string {
  const nodeText = (id: string): string =>
    model.nodeById(id)?.text ?? "（已不存在的节点）";
  if (s.kind === "composite") {
    const p = s.payload as { children?: SerializedCommand[] } | null;
    const children = (p?.children ?? [])
      .map((c) => describeHistoryCommand(c, model))
      .filter(Boolean);
    return children.join("；") || s.kind;
  }
  switch (s.kind) {
    case "mindmap.text": {
      const p = s.payload as HistoryTextPayload;
      return `将「${p.before}」改为「${p.after}」`;
    }
    case "mindmap.add": {
      const p = s.payload as { parentId: string; node: MindMapNode };
      return `在「${nodeText(p.parentId)}」下添加「${p.node.text}」`;
    }
    case "mindmap.paste": {
      const p = s.payload as HistoryPastePayload;
      const first = p.inserts[0];
      if (!first) return "粘贴节点";
      const more =
        p.inserts.length > 1 ? ` 等 ${p.inserts.length} 个节点` : "";
      return `在「${nodeText(first.parentId)}」下粘贴「${first.node.text}」${more}`;
    }
    case "mindmap.delete": {
      const p = s.payload as HistoryDeletePayload;
      const first = p.captures[0];
      if (!first) return "删除节点";
      const more = p.captures.length > 1 ? ` 等 ${p.captures.length} 处` : "";
      return `删除「${first.node.text}」${more}`;
    }
    case "mindmap.move": {
      const p = s.payload as HistoryMovePayload;
      const m = p.moves[0];
      if (!m) return "移动节点";
      if (m.oldParentId === m.newParentId)
        return `调整「${nodeText(m.nodeId)}」的排序`;
      return `将「${nodeText(m.nodeId)}」移动到「${nodeText(m.newParentId)}」下`;
    }
    case "mindmap.layout": {
      const p = s.payload as { after: string };
      return `调整布局方向为「${p.after}」`;
    }
    case "mindmap.edge": {
      const p = s.payload as { after: string };
      return `调整连线样式为「${p.after}」`;
    }
    case "mindmap.render":
      return "AI 重渲染整棵导图";
    default:
      return s.kind;
  }
}

// 给宿主的缺省提示词模板：把请求渲染为大模型可直接使用的指令（含操作 schema 与
// 树数据）。接真实 LLM 时把它作为消息发出，返回的 JSON 交给控制器 run 解析即可
export function defaultAIEditPrompt(req: AIEditRequest): string {
  return [
    "你是思维导图编辑助手。需要修改导图时输出操作 JSON 数组；仅提问/咨询（无需修改导图）时直接输出回答文本，不要输出 JSON，也不要用代码块包裹回答。",
    "若回答之外还需修改导图，可输出 {\"ops\":[...],\"answer\":\"回答文本\"}。",
    "复杂指令拆成多个操作按序输出（可引用前序操作新建的节点文本）。",
    "可用操作（target 可省略，缺省为锚点节点）：",
    '- {"op":"add","target":"<可选>","index":<可选插入位次,0起>,"nodes":[{"text":"...","children":[]}]} 在目标节点下插入子树',
    '- {"op":"edit","target":"<可选>","text":"<新文本>"} 修改节点文本',
    '- {"op":"move","target":"<可选>","parent":"<新父节点,缺省根节点>","index":<可选位次>} 移动节点子树（换父或同父排序）',
    '- {"op":"delete","target":"<可选>"} 删除节点及其子树（谨慎使用）',
    '- {"op":"render","tree":{"text":"...","children":[...]}} 用完整新导图数据整体替换当前导图（重排/重构/重新生成类指令用；小改动请用上述增量操作）。render 之后的操作引用新树中的节点（新树节点可沿用原 id，也可省略 id）',
    '- {"op":"undo"} 撤销最近一次变更（可多条连用，不能与编辑类操作混用）；用户要求撤销/撤回/反悔时使用',
    '- {"op":"redo"} 重做最近一次被撤销的变更（限制同 undo）；用户要求恢复被撤销的修改时使用',
    '- {"op":"history"} 读取当前撤销/重做历史记录（只读，各条变更的描述会并入回答返回）；用户询问"刚才改了什么/做过哪些操作"时使用',
    "target 定位规则（按优先级）：节点 id（最稳；下方导图数据中每个节点都带 id，多条操作引用同一节点时必须用 id，不要用文本）；路径 \"A/B/C\"（次选）；\"文本[n]\"（第 n 个同名节点，n 从 1 起）；纯文本（仅全局唯一时可用）。",
    "",
    "执行前先审视结构合理性：若指令会造成明显不当的层级（如把一级主题挂到末级知识点下），先在 answer 里说明问题并给出建议，未经用户确认不要机械执行大范围结构变更。",
    "不要改动指令未涉及的部分。",
    "",
    // 对话历史：多轮上下文（不含本次指令），取最近若干轮防止提示词膨胀
    ...(req.history.length
      ? [
          "对话历史（按时间先后，最近在前，仅供理解上下文，无需回应其中内容）：",
          ...req.history
            .slice(-12)
            .reverse()
            .map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.text}`),
          "",
        ]
      : []),
    `用户指令：${req.prompt}`,
    `锚点节点 id：${req.anchorId}`,
    req.anchorPath ? `锚点节点路径：${req.anchorPath}` : "",
    req.selectionIds.length
      ? `当前选中节点 id：${req.selectionIds.join("、")}`
      : "",
    "",
    "当前导图数据：",
    JSON.stringify(req.tree),
  ]
    .filter(Boolean)
    .join("\n");
}

// AI 编辑控制器：run 为唯一入口——快照上下文 → 宿主适配器生成 → 校验规整 →
// 批内编译为历史命令（顺序重放，后续操作可引用批内新建节点）→ 组合命令入栈 →
// 重布局 + 通知宿主。一次 run 对撤销/重做是一个原子单元
export class AIEditingController {
  // 生成适配器（MindMapOptions.ai 注入；未配置时 run 报错）
  private generate: AIEditGenerate | null;
  // 防并发：上一轮生成/应用未落定前拒绝新一轮
  private busy = false;

  constructor(
    private deps: AIEditingDeps,
    generate: AIEditGenerate | null,
  ) {
    this.generate = generate;
  }

  // 执行一次 AI 编辑：失败（适配器抛错 / 返回非法 / 目标不存在）时整体不生效
  async run(
    prompt: string,
    options: AIEditRunOptions = {},
  ): Promise<AIEditResult> {
    if (this.busy) throw new Error("AI 编辑进行中，请稍候");
    const { model, activation } = this.deps;
    const root = model.root;
    if (!root) throw new Error("思维导图尚未初始化完成");
    if (!this.generate)
      throw new Error("未配置 AI 生成适配器（MindMapOptions.ai）");
    const text = prompt.trim();
    if (!text) throw new Error("请输入 AI 指令");
    if (activation.editing) throw new Error("请先结束当前编辑再执行 AI 操作");

    const anchorId = options.anchorId ?? activation.active?.id ?? root.id!;
    const anchorNode = model.nodeById(anchorId) ?? root;
    const req: AIEditRequest = {
      prompt: text,
      tree: model.toJSON(),
      anchorId,
      anchorPath: nodePath(anchorNode),
      selectionIds: this.deps.sel.items.map((n) => n.id!).filter(Boolean),
      history: options.history ?? [],
    };

    this.busy = true;
    let raw: AIMindMapOp[] | string;
    try {
      raw = await this.generate(req);
    } finally {
      this.busy = false;
    }
    const { ops, answer } = parseAIResponse(raw);

    // undo/redo 直接驱动既有历史链（与手动 Ctrl+Z 同源），不进入本次 run 的组合
    // 命令：与编辑类操作混用即整体拒绝（避免"先撤销再在同一批里改新树"的时序歧义）；
    // history 只读，可与任意操作共存
    if (
      ops.some((o) => o.op === "undo" || o.op === "redo") &&
      ops.some(
        (o) =>
          o.op === "add" ||
          o.op === "edit" ||
          o.op === "move" ||
          o.op === "delete" ||
          o.op === "render",
      )
    )
      throw new Error("AI 的 undo/redo 操作不能与编辑类操作混用，请分开执行");

    // 纯控制链（undo/redo/history，无编辑类操作）：逐条驱动既有历史链，
    // 每条 undo/redo 经门面完成清选中/重布局/宿主通知；无命令入栈，本次
    // run 不产生新变更（可连用多次）
    if (ops.some((o) => o.op === "undo" || o.op === "redo")) {
      const steps: AIEditStep[] = [];
      const answers = answer ? [answer] : [];
      let applied = 0;
      for (const op of ops) {
        if (op.op === "undo") {
          const ok = await this.deps.undo();
          if (ok) applied++;
          steps.push({
            op,
            label: ok ? "撤销最近一次变更" : "没有可撤销的变更，已跳过",
            status: ok ? "applied" : "skipped",
          });
        } else if (op.op === "redo") {
          const ok = await this.deps.redo();
          if (ok) applied++;
          steps.push({
            op,
            label: ok ? "重做最近一次被撤销的变更" : "没有可重做的变更，已跳过",
            status: ok ? "applied" : "skipped",
          });
        } else if (op.op === "history") {
          answers.push(this.readHistoryReport());
          steps.push({ op, label: "读取历史记录", status: "applied" });
        }
      }
      return {
        applied,
        ops,
        steps,
        answer: answers.filter(Boolean).join("\n\n") || undefined,
      };
    }

    // 编译全部命令成功才应用（exec 前抛错 = 本次 run 无任何副作用）
    const { commands, created, steps, focus, activate, historyText } =
      this.compile(ops, anchorId);
    // history 操作的历史描述并入 AI 回答（与 answer 可共存）
    const mergedAnswer =
      [answer, historyText].filter(Boolean).join("\n\n") || undefined;
    if (!commands.length)
      return { applied: 0, ops, steps, answer: mergedAnswer };
    // 清空选中态：AI 可能删除选中节点，先摘除悬空的覆盖层引用
    this.deps.activation.deactivate();
    this.deps.history.exec(compose("ai", ...commands));
    // 新建节点补挂点击激活绑定（splice 挂载不经 app.add 包装，同 paste 纪律）
    created.forEach((n) => this.deps.editor.bind(n));
    await this.deps.onRelayout();
    // 最后落点进入激活态，便于继续手动编辑（render 整树替换激活新根，
    // 避免激活到深层叶子；无新建则保持退出态）
    const activateNode = activate ?? (created.length ? created[created.length - 1] : null);
    if (activateNode) this.deps.activation.activate(activateNode);
    // 画布居中到最后落点（新建/移动）：AI 变更常发生在视口外，不聚焦会"看不到效果"
    if (focus) this.deps.app.camera.centerOn(focus.x + focus.width / 2, focus.y + focus.height / 2);
    this.deps.emitChange("ai");
    return { applied: commands.length, ops, steps, answer: mergedAnswer };
  }

  // 把操作序列编译为历史命令：编译期不改动树结构（树变更只发生在 redo 里），
  // 批内前序操作的新建节点/连线经会话注册表对后续操作可见（先 add 再 edit
  // 新节点等链式指令可用）。任一操作目标非法即抛错，整体拒绝。
  // fallbackId 为本次 run 的锚点节点 id：op.target 缺省时的目标
  private compile(
    ops: AIMindMapOp[],
    fallbackId: string,
  ): {
    commands: HistoryCommand[];
    created: Text[];
    steps: AIEditStep[];
    // 最后落点（最后新建/移动的节点）：供 run 聚焦视口
    focus: Text | null;
    // 指定激活节点（render 整树替换激活新根）；缺省沿用"最后新建节点"规则
    activate: Text | null;
    // history 操作读取的历史描述（无 history 操作时为 null），并入 run 的 answer
    historyText: string | null;
  } {
    const { model, app } = this.deps;
    const root = model.root!;
    // 批内会话注册表：新建节点 id → 运行时节点（redo 前不在树上，nodeById 查不到）
    const session = new Map<string, Text>();
    // 批内新建（尚未入 model.edges）的连线：move 的旧连线查找需覆盖这些；
    // delete 的死连线改在 redo 时按当时 model.edges 计算（届时批内连线均已入表）
    const pendingEdges: MindEdge[] = [];
    // 批内已删除目标节点 id → 删除发生的操作序号（"第 N 项"）：delete 引用已删
    // 子树内节点时记为跳过（子树已随前者一并删除），其余操作引用即编译失败
    const deleted = new Map<string, string>();
    const commands: HistoryCommand[] = [];
    const created: Text[] = [];
    // 逐步执行反馈链：宿主可直接展示，便于定位"编辑看不到效果"类问题
    const steps: AIEditStep[] = [];
    // 最后落点（新建/移动）：run 据此居中视口
    let focus: Text | null = null;
    // 指定激活节点（render 整树替换激活新根）；null 时沿用"最后新建节点"规则
    let activate: Text | null = null;
    // history 操作读取的历史描述：run 并入 answer
    let historyText: string | null = null;
    const targetOf = (node: Text): AIEditStep["target"] => ({
      id: node.id!,
      text: node.text,
    });

    const byId = (id: string): Text | null =>
      session.get(id) ?? model.nodeById(id);
    // 目标解析（target 缺省锚点节点）。target 四种形态：
    // 1. 节点 id（最稳，含批内新建）；2. 路径 "A/B/C"（同名消歧首选）；
    // 3. "文本[n]"（第 n 个同名节点，先序 1 起）；4. 纯文本（全局唯一时直接命中，
    //    多个同名即抛消歧错误，列出各节点路径供模型改用路径/序号）
    const ensureTarget = (
      target: string | undefined,
      no: string,
      allowDeleted = false,
    ): Text => {
      const raw = target?.trim();
      let node: Text | null;
      if (!raw) {
        node = byId(fallbackId);
      } else if (byId(raw)) {
        node = byId(raw);
      } else if (raw.includes("/")) {
        node = resolveTargetByPath(root, raw);
      } else {
        // 纯文本 / "文本[n]"：全局候选内匹配，多同名未给序号即抛消歧错误
        const cands = collectTargetCandidates(root, session.values());
        const { text, nth } = parseTargetSegment(raw);
        const hits = cands.filter((n) => n.text === text);
        if (hits.length > 1 && !/\[\d+\]$/.test(raw)) {
          const paths = hits.map((n) => nodePath(n));
          throw new Error(
            `目标「${text}」匹配到 ${paths.length} 个节点：${paths.join("、")}；请改用路径（如 "${paths[0]}"）或序号（如 "${text}[2]"）定位${no}`,
          );
        }
        node = hits[nth - 1] ?? null;
        if (!node && hits.length) {
          const paths = hits.map((n) => nodePath(n));
          throw new Error(
            `目标「${text}」同名节点共 ${paths.length} 个：${paths.join("、")}；序号 [${nth}] 超出范围${no}`,
          );
        }
      }
      if (!node) {
        if (raw && !raw.includes("/")) {
          const near = collectTargetCandidates(root, session.values())
            .filter((n) => n.text.includes(parseTargetSegment(raw).text))
            .slice(0, 5)
            .map((n) => nodePath(n));
          throw new Error(
            `无法定位 AI 操作目标节点: "${raw}"${no}${near.length ? `；相近节点：${near.join("、")}` : ""}`,
          );
        }
        throw new Error(
          raw
            ? `无法定位 AI 操作目标节点: "${raw}"${no}`
            : `无法定位锚点节点${no}`,
        );
      }
      // 目标在批内已移除子树内（含子树后代）：delete 连同整个子树删除、render
      // 整树替换——引用这些节点的操作在 redo 时已无从落地，delete 允许放行
      //（由调用方记为跳过），其余操作编译期即拒绝并说明移除来源
      for (let p: Text | null = node; p; p = p.parent as Text | null) {
        const by = deleted.get(p.id!);
        if (by && !allowDeleted)
          throw new Error(
            `AI 操作目标已在${by}被移除: "${raw ?? "锚点节点"}"${no}（delete 连同子树删除、render 整树替换，后续操作请引用现存节点）`,
          );
      }
      return node;
    };
    const exists = (id: string) => byId(id) !== null;
    // 沿用 AI 给出的节点 id（保证后续操作可引用），与现有树/批内冲突时剥除（运行时自动生成新 id）
    const adoptIds = (data: MindMapNode): MindMapNode => ({
      ...data,
      id: data.id && !exists(data.id) ? data.id : undefined,
      // 防御：children 已在 normalizeAIOps 规整，此处兜底三方直接调用 run 的场景
      children: (data.children ?? []).map((c) => adoptIds(c)),
    });
    const registerSubtree = (node: Text) => {
      session.set(node.id!, node);
      node.children.forEach((c) => registerSubtree(c as Text));
    };

    for (const [i, op] of ops.entries()) {
      const no = `（第 ${i + 1} 项）`;
      // 回答类操作已在 parseAIResponse 提取为 answer，防御性跳过
      if (op.op === "answer") continue;
      // undo/redo 已在 run 分流为纯控制链（驱动既有历史链、不入本次组合命令），
      // 防御性跳过避免误编译为 delete
      if (op.op === "undo" || op.op === "redo") continue;
      // history：只读历史记录，不产生命令——描述并入 run 的 answer
      if (op.op === "history") {
        historyText = this.readHistoryReport();
        steps.push({ op, label: "读取历史记录", status: "applied" });
        continue;
      }
      if (op.op === "add") {
        const parent = ensureTarget(op.target, no);
        // 目标折叠时先展开（同 createRelated/paste 纪律：展开不入命令），避免新建子树被可见性联动隐藏
        if (parent.collapsed) {
          parent.collapsed = false;
          model.applyCollapseVisibility();
        }
        const depth = model.depthOf(parent) + 1;
        const index = Math.max(
          0,
          Math.min(op.index ?? parent.children.length, parent.children.length),
        );
        const inserts = op.nodes.map((data, i) => {
          const node = model.renderNode(adoptIds(data), depth);
          const inner: MindEdge[] = [];
          model.collectEdges(node, inner);
          const edge = model.createEdge(parent, node);
          pendingEdges.push(edge, ...inner);
          registerSubtree(node);
          created.push(node);
          return { parent, node, edge, inner, index: index + i };
        });
        // 复用 paste 命令形状（kind: mindmap.paste）：多插入点 + 内嵌子树 +
        // 连线按 id 引用，编解码器无需感知 AI 来源
        commands.push({
          type: "add",
          redo: () => {
            inserts.forEach(({ parent: p, node, edge, inner, index: idx }) => {
              p.attachChild(node, idx);
              this.deps.app.add(edge);
              this.deps.app.add(inner);
              model.edges.push(edge, ...inner);
            });
          },
          undo: () => {
            for (let i = inserts.length - 1; i >= 0; i--) {
              const { parent: p, node, edge, inner } = inserts[i];
              p.detachChild(node);
              const removed = [edge, ...inner];
              model.edges = model.edges.filter((e) => !removed.includes(e));
              removed.forEach((e2) => app.remove(e2));
            }
          },
          toJSON: () => ({
            kind: "mindmap.paste",
            payload: {
              inserts: inserts.map(
                ({ parent: p, node, edge, inner, index: idx }) => ({
                  parentId: p.id,
                  index: idx,
                  node: model.serializeForHistory(node),
                  edgeId: edge.id,
                  innerEdgeIds: inner.map((e) => e.id),
                }),
              ),
            },
          }),
        });
        steps.push({
          op,
          label: `在「${parent.text}」下添加 ${op.nodes.length} 个节点`,
          status: "applied",
          target: targetOf(parent),
        });
        focus = inserts[inserts.length - 1].node;
        continue;
      }

      if (op.op === "move") {
        const node = ensureTarget(op.target, no);
        if (node === model.root) throw new Error(`AI 不能移动根节点${no}`);
        const newParent = op.parent ? ensureTarget(op.parent, no) : root;
        // 不能移动到自身子树内（会成环）
        const subtree = new Set<object>();
        const collect = (n: object) => {
          subtree.add(n);
          (n as Text).children.forEach(collect);
        };
        collect(node);
        if (subtree.has(newParent))
          throw new Error(
            `不能把「${node.text}」移动到它自己的子树内（「${nodePath(newParent)}」）${no}`,
          );
        const oldParent = node.parent as Text;
        const oldIndex = oldParent.children.indexOf(node);
        const newIndex = Math.max(
          0,
          Math.min(
            op.index ?? newParent.children.length,
            newParent.children.length,
          ),
        );
        if (oldParent === newParent && newIndex === oldIndex) {
          steps.push({
            op,
            label: `「${node.text}」位置未变化，已跳过`,
            status: "skipped",
            target: targetOf(node),
          });
          continue;
        }
        // 复用拖拽 move 命令形状（kind: mindmap.move）：换父换线 + 级数样式重设，
        // 连线按 id 引用；批内新建节点的连线在 pendingEdges 中
        const oldEdge =
          model.edges.find((e) => e.fromNode === oldParent && e.toNode === node) ??
          pendingEdges.find((e) => e.fromNode === oldParent && e.toNode === node)!;
        const newEdge =
          oldParent === newParent ? oldEdge : model.createEdge(newParent, node);
        const oldStyle = model.nodeStyles.get(node)!;
        const newStyle = {
          ...model.levelStyle(model.depthOf(newParent) + 1),
          ...model.customStyles.get(node),
        };
        // 目标折叠时先展开（同 add 纪律），避免移入的子树被可见性联动隐藏
        if (newParent.collapsed && newParent !== oldParent) {
          newParent.collapsed = false;
          model.applyCollapseVisibility();
        }
        const np = newParent;
        commands.push({
          type: "move",
          redo: () => {
            oldParent.remove(node);
            np.attachChild(node, newIndex);
            if (newEdge !== oldEdge) {
              model.edges = model.edges.filter((e) => e !== oldEdge);
              app.remove(oldEdge);
              model.edges.push(newEdge);
              app.add(newEdge);
            }
            if (model.levelStyles.length) model.applyNodeStyle(node, newStyle);
          },
          undo: () => {
            np.remove(node);
            oldParent.attachChild(node, oldIndex);
            if (newEdge !== oldEdge) {
              model.edges = model.edges.filter((e) => e !== newEdge);
              app.remove(newEdge);
              model.edges.push(oldEdge);
              app.add(oldEdge);
            }
            model.applyNodeStyle(node, oldStyle);
          },
          toJSON: () => ({
            kind: "mindmap.move",
            payload: {
              moves: [
                {
                  nodeId: node.id,
                  oldParentId: oldParent.id,
                  oldIndex,
                  newParentId: np.id,
                  newIndex,
                  oldStyle,
                  newStyle,
                  oldEdgeId: oldEdge.id,
                  newEdgeId: newEdge.id,
                },
              ],
            },
          }),
        });
        steps.push({
          op,
          label:
            oldParent === newParent
              ? `将「${node.text}」移动到第 ${newIndex + 1} 位`
              : `将「${node.text}」移动到「${np.text}」下`,
          status: "applied",
          target: targetOf(node),
        });
        focus = node;
        continue;
      }

      if (op.op === "edit") {
        const node = ensureTarget(op.target, no);
        const before = node.text;
        const after = op.text;
        if (before === after) {
          // 无实际变化：记为跳过（提示改名落点，便于发现同名误匹配）
          steps.push({
            op,
            label: `「${node.text}」文本未变化，已跳过`,
            status: "skipped",
            target: targetOf(node),
          });
          continue;
        }
        // 复用文本命令形状（kind: mindmap.text）
        commands.push({
          type: "text",
          redo: () => {
            node.text = after;
          },
          undo: () => {
            node.text = before;
          },
          toJSON: () => ({
            kind: "mindmap.text",
            payload: { nodeId: node.id, before, after },
          }),
        });
        steps.push({
          op,
          label: `将「${before}」改为「${after}」`,
          status: "applied",
          target: targetOf(node),
        });
        continue;
      }

      // render：整树替换。旧树节点全部登记进 deleted（后续操作引用旧 id 时，
      // delete 记为跳过、其余操作编译失败并指向新树）；新树沿用 AI 给出的 id
      //（批内去重，后续操作可引用），经 renderNode 重建节点、collectEdges 重建连线，
      // redo/undo 以对象引用整体换入换出场景；序列化见 toJSON（mindmap.render）
      if (op.op === "render") {
        const data = normalizeRenderTree(op.tree, no);
        const markGone = (n: Text) => {
          deleted.set(n.id!, no);
          n.children.forEach((c) => markGone(c as Text));
        };
        markGone(root);
        // 批内去重：与既有 id（含前序操作新建节点）冲突或重复出现的 id 剥除，
        // 运行时自动生成新 id，避免会话注册表被同 id 覆盖产生歧义
        const seenIds = new Set<string>();
        const adopt = (node: MindMapNode): MindMapNode => ({
          ...node,
          id:
            typeof node.id === "string" &&
            node.id &&
            !seenIds.has(node.id) &&
            !session.has(node.id)
              ? (seenIds.add(node.id), node.id)
              : undefined,
          children: node.children.map(adopt),
        });
        const newRoot = model.renderNode(adopt(data), 0);
        const newEdges: MindEdge[] = [];
        model.collectEdges(newRoot, newEdges);
        const oldEdges = [...model.edges];
        registerSubtree(newRoot);
        const bindAll = (n: Text) => {
          created.push(n);
          n.children.forEach((c) => bindAll(c as Text));
        };
        bindAll(newRoot);
        let nodeCount = 0;
        const count = (n: Text) => {
          nodeCount++;
          n.children.forEach((c) => count(c as Text));
        };
        count(newRoot);
        commands.push({
          type: "ai",
          redo: () => {
            const prevRoot = model.root!;
            const prevEdges = [...model.edges];
            app.remove(prevRoot);
            app.remove(prevEdges);
            model.root = newRoot;
            model.edges = newEdges;
            app.add(newRoot);
            app.add(newEdges);
          },
          undo: () => {
            app.remove(newRoot);
            app.remove(newEdges);
            model.root = root;
            model.edges = oldEdges;
            app.add(root);
            app.add(oldEdges);
          },
          // 序列化：双侧整树定格快照 + collectEdges 深度先序配对的连线 id，
          // 解码侧据此整树重建并按 id 回写连线，跨命令按 id 解析的引用保持一致
          toJSON: () => ({
            kind: "mindmap.render",
            payload: {
              before: {
                root: model.serializeForHistory(root),
                edgeIds: oldEdges.map((e) => e.id),
              },
              after: {
                root: model.serializeForHistory(newRoot),
                edgeIds: newEdges.map((e) => e.id),
              },
            },
          }),
        });
        steps.push({
          op,
          label: `用新数据重渲染整棵导图（${nodeCount} 个节点）`,
          status: "applied",
          target: targetOf(newRoot),
        });
        activate = newRoot;
        focus = newRoot;
        continue;
      }

      // delete：目标子树快照 + 端点在子树内的连线清理（含批内新建的 pending 连线），
      // 复用 delete 命令形状（kind: mindmap.delete）
      const node = ensureTarget(op.target, no, true);
      // 目标已随前序操作移除（重复删除同一节点 / 删除已删子树的后代 / render
      // 整树替换后引用旧节点）：目标早已不在树上，记为跳过，不再编译出空转命令
      let deletedIn: string | null = null;
      for (let p: Text | null = node; p; p = p.parent as Text | null) {
        const by = deleted.get(p.id!);
        if (by) {
          deletedIn = by;
          break;
        }
      }
      if (deletedIn) {
        steps.push({
          op,
          label: `「${node.text}」已在${deletedIn}被移除，本条跳过`,
          status: "skipped",
          target: targetOf(node),
        });
        continue;
      }
      if (node === model.root) throw new Error("AI 不能删除根节点");
      const parent = node.parent as Text;
      const index = parent.children.indexOf(node);
      // 编译期子树仅用于反馈文案（"及其 N 个子节点"）；死连线在 redo 时按当时
      // 树状态计算——编译期树未变（批内前序 move 尚未执行），此刻收集会把
      // "即将被移出子树的节点"也计入（先 move x 的子节点 b 再 delete x 时，
      // b 子树自身的 b→c 连线会被误判为死连线，redo 时被错误删除且不再恢复，
      // 表现为连线消失、刷新后才回来）。redo 时子树已是移动后的真实结构，
      // 且前序操作的连线（pendingEdges）均已入 model.edges，据此计算即为准确死集
      const subtree = new Set<object>();
      const collect = (n: object) => {
        subtree.add(n);
        (n as Text).children.forEach(collect);
      };
      collect(node);
      let dead: MindEdge[] = [];
      commands.push({
        type: "delete",
        redo: () => {
          const liveSubtree = new Set<object>();
          const collectLive = (n: object) => {
            liveSubtree.add(n);
            (n as Text).children.forEach(collectLive);
          };
          collectLive(node);
          dead = model.edges.filter(
            (e) => liveSubtree.has(e.fromNode) || liveSubtree.has(e.toNode),
          );
          parent.remove(node);
          model.edges = model.edges.filter((e) => !dead.includes(e));
          dead.forEach((e) => app.remove(e));
        },
        undo: () => {
          parent.attachChild(node, index);
          dead.forEach((e) => {
            model.edges.push(e);
            app.add(e);
          });
        },
        toJSON: () => ({
          kind: "mindmap.delete",
          payload: {
            captures: [
              {
                parentId: parent.id,
                index,
                node: model.serializeForHistory(node),
              },
            ],
            dead: dead.map((e) => ({
              id: e.id,
              fromId: e.fromNode.id,
              toId: e.toNode.id,
            })),
          },
        }),
      });
      steps.push({
        op,
        label:
          `删除「${node.text}」${subtree.size > 1 ? `及其 ${subtree.size - 1} 个子节点` : ""}`.trim(),
        status: "applied",
        target: targetOf(node),
      });
      deleted.set(node.id!, no);
    }

    return { commands, created, steps, focus, activate, historyText };
  }

  // 读取历史：把撤销/重做双栈的序列化命令转为可读描述（history 操作的返回内容）。
  // 撤销栈按"最近在前"排列，重做栈按重放次序排列；历史栈不可序列化（含三方
  // 闭包命令）时提示不可读
  private readHistoryReport(): string {
    const snap = this.deps.history.exportJSON?.();
    if (!snap) return "历史记录暂不可读（包含无法序列化的命令）";
    const describe = (list: readonly SerializedCommand[]) =>
      list
        .map((s, i) => `${i + 1}. ${describeHistoryCommand(s, this.deps.model)}`)
        .join("\n");
    // 导出按栈底→栈顶排列：撤销栈反转后最近变更在前，重做栈保持重放次序
    const undoDesc = describe([...snap.undo].reverse());
    const redoDesc = describe(snap.redo);
    return [
      undoDesc
        ? `可撤销 ${snap.undo.length} 条（最近在前）：\n${undoDesc}`
        : "没有可撤销的变更",
      redoDesc
        ? `可重做 ${snap.redo.length} 条（按重放次序）：\n${redoDesc}`
        : "没有可重做的变更",
    ].join("\n");
  }
}

// AI 编辑插件：install 时向能力注册表提供 mindmap.ai 能力（控制器由场景门面
// 装配并注入依赖），destroy 场景卸载插件时能力随注册表撤销/恢复
export class AIEditingPlugin implements Plugin {
  constructor(private controller: AIEditingController) {}

  install(app: App) {
    app.provide(AI_EDITING_CAPABILITY, this.controller, {
      version: "1.0.0",
      provider: "@silker/mindmap/ai",
    });
  }
}
