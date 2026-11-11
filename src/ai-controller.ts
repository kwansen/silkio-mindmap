import { compose } from "@silker/core";
import type {
  App,
  HistoryCommand,
  Plugin,
  SerializedCommand,
  Text,
} from "@silker/core";
import type {
  HistoryCapability,
  SelectionCapability,
} from "@silker/core";
import type { MindEdge } from "./Edge";
import {
  makeDeleteCommand,
  makeMoveCommand,
  makePasteCommand,
  makeRenderCommand,
  makeTextCommand,
} from "./commands";
import type { ActivationController } from "./editing";
import type { MindTree } from "./model";
import type { MindMapChangeType, MindMapNode } from "./types";
import type {
  AIEditGenerate,
  AIEditRequest,
  AIEditResult,
  AIEditRunOptions,
  AIMindMapOp,
  AIEditStep,
} from "./ai-protocol";
import {
  AI_EDITING_CAPABILITY,
  collectTargetCandidates,
  nodePath,
  normalizeRenderTree,
  parseAIResponse,
  parseTargetSegment,
  resolveTargetByPath,
} from "./ai-protocol";
import { describeHistoryCommand } from "./ai-report";

// AI 编辑控制器：run 为唯一入口——快照上下文 → 宿主适配器生成 → 校验规整 →
// 批内编译为历史命令（顺序重放，后续操作可引用批内新建节点）→ 组合命令入栈 →
// 重布局 + 通知宿主。一次 run 对撤销/重做是一个原子单元。
// 包内只定义"AI 编辑"的领域协议（见 ai-protocol.ts），不绑定任何具体 LLM SDK——
// 宿主经 MindMapOptions.ai 注入生成适配器，控制器把操作编译为与手动编辑同源的
// 历史命令（mindmap.paste / mindmap.text / mindmap.delete / mindmap.move /
// mindmap.render），撤销/重做与历史导入导出全部复用现有链路，AI 编辑与手动编辑
// 在历史语义上无差别。

export interface AIEditingDeps {
  app: App;
  model: MindTree;
  history: Pick<HistoryCapability, "exec" | "exportJSON">;
  // 撤销/重做入口（门面接线，与手动 Ctrl+Z 完全同源：含编辑态/拖拽守卫、
  // 清空选中态、重布局与宿主通知）：返回是否实际执行了一条命令
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  // 挂载节点登记点击激活（经命令 redo 的 bindNode 统一收口，见 commands.ts）
  bindNode: (node: Text) => void;
  sel: Pick<SelectionCapability<Text>, "items">;
  activation: Pick<
    ActivationController,
    "active" | "activate" | "deactivate" | "editing"
  >;
  // 画布交互忙守卫（拖拽/框选进行中，编辑态由 activation.editing 单独判定）：
  // run 入口与 exec 前各查一次——生成期间用户可能开始拖拽，exec 前不复查会与
  // 进行中的变更互踩（拖拽态持有 ghost/高亮引用，AI 删除目标节点即悬空）
  busy?: () => boolean;
  onRelayout: () => Promise<void> | void;
  emitChange: (type: MindMapChangeType) => void;
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
    if (this.deps.busy?.())
      throw new Error("画布交互进行中（拖拽/框选），请稍后再执行 AI 操作");

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
    // exec 前复查交互忙态：生成期间用户可能开始拖拽/框选，带伤执行会互踩
    if (this.deps.busy?.())
      throw new Error("AI 编辑被画布交互打断（拖拽/框选进行中），请重试");
    // 清空选中态：AI 可能删除选中节点，先摘除悬空的覆盖层引用
    this.deps.activation.deactivate();
    this.deps.history.exec(compose("ai", ...commands));
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
    const { model, app, bindNode } = this.deps;
    const root = model.root!;
    // 树索引快照（O(n) 一次遍历）：批内多次按 id 查找复用，避免逐次 nodeById
    // 全树遍历（O(n·k)）。编译期结构不变（expand 只改折叠标志），快照有效
    const treeIndex = model.indexById();
    // 批内会话注册表：新建节点 id → 运行时节点（redo 前不在树上，nodeById 查不到）
    const session = new Map<string, Text>();
    // 批内新建（尚未入模型连线表）的连线：move 的旧连线查找需覆盖这些；
    // delete 的死连线改在 redo 时按当时连线表计算（届时批内连线均已入表）
    const pendingEdges: MindEdge[] = [];
    // 批内已删除目标节点 id → 删除发生的操作序号（"第 N 项"）：delete 引用已删
    // 子树内节点时记为跳过（子树已随前者一并删除），其余操作引用即编译失败
    const deleted = new Map<string, string>();
    // 批内已移动的节点 id：同一节点在批内移动两次会让后一条 move 命令定格的
    // oldParent/oldIndex 失真（undo 回到错误位置），move 后再删除会让 delete 命令
    // 的定格父级失真——编译期即拒绝，请拆分为多次 run
    const moved = new Set<string>();
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
      session.get(id) ?? treeIndex.get(id) ?? null;
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
        // 目标折叠时先展开（expand 原语统一收口，展开不入命令），避免新建子树被可见性联动隐藏
        model.expand(parent);
        const index = Math.max(
          0,
          Math.min(op.index ?? parent.children.length, parent.children.length),
        );
        // 子树插入编排走模型原语 buildSubtreeInsert（与剪贴板粘贴共用同一份：
        // 渲染子树 → 收集内连线 → 建父子连线），AI 侧只做批内登记
        const inserts = op.nodes.map((data, i) => {
          const ins = model.buildSubtreeInsert(parent, adoptIds(data), index + i);
          pendingEdges.push(ins.edge, ...ins.inner);
          registerSubtree(ins.node);
          created.push(ins.node);
          return ins;
        });
        // 复用 paste 命令形状（kind: mindmap.paste）：多插入点 + 内嵌子树 +
        // 连线按 id 引用，编解码器无需感知 AI 来源
        commands.push(makePasteCommand({ app, model, bindNode }, inserts));
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
        if (moved.has(node.id!))
          throw new Error(
            `节点「${node.text}」在本批内已被移动，同批内不能再次移动同一节点${no}（请拆分为多次执行）`,
          );
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
        const oldStyle = model.styleOf(node)!;
        const newStyle = {
          ...model.levelStyle(model.depthOf(newParent) + 1),
          ...model.customStyleOf(node),
        };
        // 目标折叠时先展开（expand 原语，同 add 纪律），避免移入的子树被可见性联动隐藏
        if (newParent !== oldParent) model.expand(newParent);
        commands.push(
          makeMoveCommand({ app, model, bindNode }, [
            {
              node,
              oldParent,
              oldIndex,
              newParent,
              newIndex,
              oldStyle,
              newStyle,
              oldEdge,
              newEdge,
            },
          ]),
        );
        steps.push({
          op,
          label:
            oldParent === newParent
              ? `将「${node.text}」移动到第 ${newIndex + 1} 位`
              : `将「${node.text}」移动到「${newParent.text}」下`,
          status: "applied",
          target: targetOf(node),
        });
        moved.add(node.id!);
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
        commands.push(makeTextCommand(node, before, after));
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
        commands.push(
          makeRenderCommand(
            { app, model, bindNode },
            { root, edges: oldEdges },
            { root: newRoot, edges: newEdges },
          ),
        );
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
      if (moved.has(node.id!))
        throw new Error(
          `节点「${node.text}」在本批内已被移动，同批内不能移动后再删除同一节点${no}（请拆分为多次执行）`,
        );
      const parent = node.parent as Text;
      const index = parent.children.indexOf(node);
      // 编译期子树仅用于反馈文案（"及其 N 个子节点"）；死连线在 redo 时按当时
      // 树状态计算——编译期树未变（批内前序 move 尚未执行），此刻收集会把
      // "即将被移出子树的节点"也计入（先 move x 的子节点 b 再 delete x 时，
      // b 子树自身的 b→c 连线会被误判为死连线，redo 时被错误删除且不再恢复，
      // 表现为连线消失、刷新后才回来）。redo 时子树已是移动后的真实结构，
      // 且前序操作的连线（pendingEdges）均已入模型连线表，据此计算即为准确死集
      const subtree = new Set<object>();
      const collect = (n: object) => {
        subtree.add(n);
        (n as Text).children.forEach(collect);
      };
      collect(node);
      // 死连线由工厂在 redo 首帧按当时树状态定格（编译期树未变，批内前序 move
      // 尚未执行，届时收集才准确；届时批内连线均已入模型连线表）
      commands.push(
        makeDeleteCommand({ app, model, bindNode }, [{ node, parent, index }]),
      );
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
