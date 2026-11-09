import { capabilityKey, compose } from "@silker/core";
import type { App, HistoryCommand, Plugin, Text } from "@silker/core";
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

// 回答类回复：AI 对提问/咨询的自然语言回答（不修改导图）。
// LLM 输出 {"op":"answer","text":"..."} 或 {"answer":"..."} 或纯文本均可
export interface AIMindMapAnswerOp {
  op: "answer";
  text: string;
}

export type AIMindMapOp =
  | AIMindMapAddOp
  | AIMindMapEditOp
  | AIMindMapMoveOp
  | AIMindMapDeleteOp
  | AIMindMapAnswerOp;

// 生成适配器的输入：用户指令 + 当前树快照（带 id）+ 锚点/选中上下文。
// tree 经 model.toJSON() 导出，节点 id 与运行时同源；anchorPath 为锚点节点的
// 根起路径（"线性代数/行列式"），供模型在多同名节点时消歧
export interface AIEditRequest {
  prompt: string;
  tree: MindMapNode;
  anchorId: string;
  anchorPath?: string;
  selectionIds: string[];
}

// 生成适配器契约：宿主实现（调自家 LLM），返回操作数组或其 JSON 字符串
// （控制器自动解析，容错 markdown 代码块包裹）
export type AIEditGenerate = (
  req: AIEditRequest,
) => Promise<AIMindMapOp[] | string>;

export interface AIEditRunOptions {
  // 本次操作的锚点节点 id（上下文与缺省 target 参照），缺省用当前激活节点，再退化为根节点
  anchorId?: string;
}

export interface AIEditResult {
  // 实际编译并执行的命令条数（被规整掉的无操作不计）
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
  history: Pick<HistoryCapability, "exec">;
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

// 按斜杠路径定位："线性代数/矩阵" / "线性代数/矩阵[2]/行"——从根逐段下钻
export function resolveTargetByPath(root: Text, path: string): Text | null {
  let cur: Text = root;
  for (const raw of path.split("/")) {
    const seg = raw.trim();
    if (!seg) continue;
    const next = matchTargetSegment(cur.children as Text[], seg);
    if (!next) return null;
    cur = next;
  }
  return cur;
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
      op.nodes.forEach((n, j) => {
        if (typeof (n as MindMapNode)?.text !== "string")
          throw new Error(`AI add 操作的 nodes[${j}] 缺少 text${no}`);
      });
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
    } else if (op.op === "answer") {
      if (typeof op.text !== "string" || !op.text)
        throw new Error(`AI answer 操作缺少 text${no}`);
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
  const obj = data as { ops?: unknown; answer?: unknown } | null;
  const answer =
    typeof obj?.answer === "string" && obj.answer ? obj.answer : undefined;
  if (obj?.ops !== undefined) return { ops: normalizeAIOps(obj.ops as AIMindMapOp[]), answer };
  if (answer !== undefined) return { ops: [], answer };
  throw new Error("AI 返回格式错误：应为操作数组或回答文本");
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
    "target 定位规则（按优先级）：节点 id（最稳）；路径 \"A/B/C\"（同名节点必用路径）；\"文本[n]\"（第 n 个同名节点，n 从 1 起）；纯文本（仅全局唯一时可用）。",
    "",
    "执行前先审视结构合理性：若指令会造成明显不当的层级（如把一级主题挂到末级知识点下），先在 answer 里说明问题并给出建议，未经用户确认不要机械执行大范围结构变更。",
    "不要改动指令未涉及的部分。",
    "",
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
    };

    this.busy = true;
    let raw: AIMindMapOp[] | string;
    try {
      raw = await this.generate(req);
    } finally {
      this.busy = false;
    }
    const { ops, answer } = parseAIResponse(raw);

    // 编译全部命令成功才应用（exec 前抛错 = 本次 run 无任何副作用）
    const { commands, created, steps, focus } = this.compile(ops, anchorId);
    if (!commands.length) return { applied: 0, ops, steps, answer };
    // 清空选中态：AI 可能删除选中节点，先摘除悬空的覆盖层引用
    this.deps.activation.deactivate();
    this.deps.history.exec(compose("ai", ...commands));
    // 新建节点补挂点击激活绑定（splice 挂载不经 app.add 包装，同 paste 纪律）
    created.forEach((n) => this.deps.editor.bind(n));
    await this.deps.onRelayout();
    // 最后一个新建节点进入激活态，便于继续手动编辑（无新建则保持退出态）
    if (created.length) this.deps.activation.activate(created[created.length - 1]);
    // 画布居中到最后落点（新建/移动）：AI 变更常发生在视口外，不聚焦会"看不到效果"
    if (focus) this.deps.app.camera.centerOn(focus.x + focus.width / 2, focus.y + focus.height / 2);
    this.deps.emitChange("ai");
    return { applied: commands.length, ops, steps, answer };
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
  } {
    const { model, app } = this.deps;
    const root = model.root!;
    // 批内会话注册表：新建节点 id → 运行时节点（redo 前不在树上，nodeById 查不到）
    const session = new Map<string, Text>();
    // 批内新建（尚未入 model.edges）的连线：delete 的连线清理需覆盖这些
    const pendingEdges: MindEdge[] = [];
    // 批内已删除目标节点 id：后续操作引用即编译失败
    const deleted = new Set<string>();
    const commands: HistoryCommand[] = [];
    const created: Text[] = [];
    // 逐步执行反馈链：宿主可直接展示，便于定位"编辑看不到效果"类问题
    const steps: AIEditStep[] = [];
    // 最后落点（新建/移动）：run 据此居中视口
    let focus: Text | null = null;
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
    const ensureTarget = (target: string | undefined, no: string): Text => {
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
      if (deleted.has(node.id!))
        throw new Error(`AI 操作目标已被本次删除: "${raw ?? "锚点节点"}"${no}`);
      return node;
    };
    const exists = (id: string) => byId(id) !== null;
    // 沿用 AI 给出的节点 id（保证后续操作可引用），与现有树/批内冲突时剥除（运行时自动生成新 id）
    const adoptIds = (data: MindMapNode): MindMapNode => ({
      ...data,
      id: data.id && !exists(data.id) ? data.id : undefined,
      children: data.children.map((c) => adoptIds(c)),
    });
    const registerSubtree = (node: Text) => {
      session.set(node.id!, node);
      node.children.forEach((c) => registerSubtree(c as Text));
    };

    for (const [i, op] of ops.entries()) {
      const no = `（第 ${i + 1} 项）`;
      // 回答类操作已在 parseAIResponse 提取为 answer，防御性跳过
      if (op.op === "answer") continue;
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

      // delete：目标子树快照 + 端点在子树内的连线清理（含批内新建的 pending 连线），
      // 复用 delete 命令形状（kind: mindmap.delete）
      const node = ensureTarget(op.target, no);
      if (node === model.root) throw new Error("AI 不能删除根节点");
      const parent = node.parent as Text;
      const index = parent.children.indexOf(node);
      const subtree = new Set<object>();
      const collect = (n: object) => {
        subtree.add(n);
        (n as Text).children.forEach(collect);
      };
      collect(node);
      const dead = [...model.edges, ...pendingEdges].filter(
        (e) => subtree.has(e.fromNode) || subtree.has(e.toNode),
      );
      commands.push({
        type: "delete",
        redo: () => {
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
      deleted.add(node.id!);
    }

    return { commands, created, steps, focus };
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
