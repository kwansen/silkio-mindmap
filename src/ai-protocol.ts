import { capabilityKey } from "@silkor/core";
import type { Text } from "@silkor/core";
import type { MindMapNode } from "./types";

// AI 编辑领域协议：操作 DSL（LLM 输出的协议）+ 请求/结果契约 + 目标定位与
// 输出规整纯函数。本模块不绑定任何具体 LLM SDK——宿主经 MindMapOptions.ai 注入
// 生成适配器（拿到上下文快照 → 调自家大模型 → 返回操作数组），控制器（ai-controller）
// 把操作编译为与手动编辑同源的历史命令。

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

// AI 控制器类型（能力键引用）：实现见 ai-controller.ts（此处 type-only 前向声明，
// 避免协议模块反向依赖控制器）
export type AIEditingController = import("./ai-controller").AIEditingController;

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
