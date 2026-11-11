import type { App, Node, Text } from "@silker/core";
import type { HistoryCapability } from "@silker/core";
import type { SelectionCapability } from "@silker/core";
import type { ClipboardEntry } from "@silker/core";
import { makeAddCommand, makeDeleteCommand, makePasteCommand } from "./commands";
import type { ActivationController } from "./editing";
import type { MindTree } from "./model";
import type { MindMapChangeType, MindMapNode } from "./types";

export interface NodeOperationsDeps {
  app: App;
  model: MindTree;
  history: Pick<HistoryCapability, "exec">;
  sel: Pick<SelectionCapability<Text>, "items" | "has">;
  activation: Pick<ActivationController, "active" | "activate" | "deactivate">;
  // 挂载节点登记点击激活（经命令 redo 的 bindNode 统一收口，见 commands.ts）
  bindNode: (node: Text) => void;
  onRelayout: () => Promise<void> | void;
  emitChange: (type: MindMapChangeType) => void;
}

// 节点操作：新建（Tab/Enter）、删除选中、复制/粘贴。剪贴板机制在 plugin-clipboard
//（原生 copy/paste 事件分发），本类只提供载荷的序列化/还原与外部文本建节点
export class NodeOperations {
  constructor(private deps: NodeOperationsDeps) {}

  // Tab 创建子节点、Enter 在当前节点下方创建兄弟节点，随后进入编辑并重布局
  // （编辑态由 bindNodeKeys 调用，激活态由 onGlobalKeydown 以合成事件调用）
  async createRelated(e: KeyboardEvent, text: Text) {
    const isChild = e.key === "Tab";
    // 根节点回车（无父级可建兄弟节点）忽略，不创建任何节点
    if (!isChild && !text.parent) return;
    const parent = isChild ? text : ((text.parent as Text | null) ?? text);
    // 目标父级处于折叠态时先展开，避免新建节点被可见性联动隐藏
    this.deps.model.expand(parent);
    // 新节点按级数取样式：Tab 建子节点深度 +1，Enter 建兄弟节点深度不变
    const style = this.deps.model.newNodeStyle(
      text,
      this.deps.model.depthOf(text) + (isChild ? 1 : 0),
    );
    // 插入位置在构造命令前定格：Tab 建子追加到末尾，Enter 建兄弟插在当前节点之后
    // （统一走 index splice，undo/redo 重放同一位置，不依赖创建时的树状态）
    const index = isChild
      ? parent.children.length
      : parent.children.indexOf(text) + 1;
    const node = this.deps.model.createNode(text, style);
    const edge = this.deps.model.createEdge(parent, node);
    // 新增节点命令：redo/undo 对称地增删子节点与连线（工厂统一形状，序列化载荷
    // node 定格完整子树数据、父级与连线按 id 引用）
    this.deps.history.exec(
      makeAddCommand(this.deps, { parent, node, index, edge }),
    );
    await this.deps.onRelayout();
    // 新节点进入激活态（常驻覆盖层，打字即编辑）
    this.deps.activation.activate(node);
    this.deps.emitChange("add");
  }

  // 删除选中节点（单选/多选统一走 selection）及其整个子树（根节点不可删除）：
  // 摘除各子树、清理关联连线，重布局后激活第一个被删节点的存活父级（均被删时退化为根节点）
  async deleteSelection() {
    const root = this.deps.model.root;
    if (!root) return;
    const targets = [...this.deps.sel.items].filter((n) => n !== root);
    if (!targets.length) return;
    // 收集全部目标子树内节点：连线清理需覆盖子树内子孙节点间的连线，不止顶层目标
    const subtree = new Set<Node>();
    const collect = (n: Node) => {
      subtree.add(n);
      n.children.forEach(collect);
    };
    targets.forEach(collect);
    // 删除前定格各目标的父级与位置（死连线由命令工厂在 redo 首帧按当时树状态
    // 定格——exec 立即执行 redo，此刻树未变，两序等价，无需编译期重复计算）
    const captures = targets.map((node) => ({
      node,
      parent: node.parent as Text,
      index: (node.parent as Text).children.indexOf(node),
    }));
    // 删除命令（工厂统一形状）：多选目标合并为一条，undo 一次全回退
    this.deps.history.exec(makeDeleteCommand(this.deps, captures));
    // 清空选中态，重布局后激活存活的父节点（activate 会重建覆盖层，旧覆盖层随之卸载）
    this.deps.activation.deactivate();
    await this.deps.onRelayout();
    this.deps.activation.activate(
      captures.map((c) => c.parent).find((p) => !subtree.has(p)) ?? root,
    );
    this.deps.emitChange("delete");
  }

  // 复制选中节点：把各选中节点的子树序列化为剪贴板载荷（多选可整组复制）。
  // 沿祖先链过滤只留最顶层节点——子孙会随祖先子树整体序列化，若重复入队
  // （选中 a、b、c 且 a→b→c），粘贴时同一分支会被添加两份。
  // 无选中时兜底当前激活节点（编辑态光标折叠复制节点走此路径）；
  // 均无返回 null（copy 事件不拦截，放行原生行为）
  copySelection(): ClipboardEntry | null {
    const items = this.deps.sel.items.length
      ? [...this.deps.sel.items]
      : this.deps.activation.active
        ? [this.deps.activation.active]
        : [];
    if (!items.length) return null;
    const roots = items.filter((n) => {
      let p = n.parent as Text | null;
      while (p) {
        if (this.deps.sel.has(p)) return false;
        p = p.parent as Text | null;
      }
      return true;
    });
    const payload = roots.map((n) => this.deps.model.serializeNode(n));
    return {
      kind: "mindmap",
      payload,
      // text 通道输出层级大纲文本：顶层无缩进，子孙按深度叠加 Tab——粘贴到飞书等
      // 大纲类应用即还原树形层级（与 parseTextTree 解析规则互逆）
      text: toOutlineText(payload).join("\n"),
    };
  }

  // 粘贴剪贴板载荷：仅单选激活时执行（多选/无选中不粘贴）——复制的子树按序追加为
  // 激活节点的子节点（追加在其子级末尾），样式按级数解析；随后激活最后一个粘贴节点
  // 并重布局，整次粘贴记为一条可撤销的 add 命令
  async pasteFromEntry(entry: ClipboardEntry) {
    // 载荷边界校验：剪贴板载荷可能来自外部应用（结构不可信），仅接受
    // { text: string, ... } 形状的节点数组，脏载荷静默丢弃不粘贴
    const raw: unknown = entry.payload;
    const nodes = Array.isArray(raw)
      ? raw.filter(
          (n): n is MindMapNode =>
            !!n &&
            typeof n === "object" &&
            typeof (n as MindMapNode).text === "string",
        )
      : [];
    if (!nodes.length || !this.deps.model.root) return;
    const anchor = this.deps.activation.active;
    if (!anchor) return;
    // 目标父级即激活节点，处于折叠态时先展开，避免粘贴节点被可见性联动隐藏
    const parent = anchor;
    this.deps.model.expand(parent);
    // 插入位置在构造命令前定格：追加到子级末尾（统一走 index splice，
    // undo/redo 重放同一索引，不依赖粘贴时的树状态）。子树插入编排
    // （渲染子树/收集内连线/建父子连线）走模型原语 buildSubtreeInsert，
    // 与 AI add 共用同一份；粘贴前剥除 id：粘贴出的子树须是新节点
    //（自动生成新 id），不与源子树共享 id
    const index = parent.children.length;
    const inserts = nodes.map((data, i) =>
      this.deps.model.buildSubtreeInsert(
        parent,
        this.deps.model.stripIds(data),
        index + i,
      ),
    );
    // 粘贴命令（工厂统一形状）：redo/undo 对称地增删子树节点、父子连线与子树内部连线
    this.deps.history.exec(makePasteCommand(this.deps, inserts));
    await this.deps.onRelayout();
    // 最后一个粘贴节点进入激活态（常驻覆盖层，打字即编辑）
    this.deps.activation.activate(inserts[inserts.length - 1].node);
    this.deps.emitChange("add");
  }

  // 粘贴外部文本：含换行或 Tab 的结构化文本按缩进解析为节点树走节点粘贴路径
  // （对齐飞书大纲式粘贴）；纯文字在激活节点下新建子节点承载（对齐 Figma/Miro
  // 的跨应用粘贴行为）。复用 createRelated 的 add 命令模式：样式按级数解析、
  // 追加到子级末尾、走 history 可逆命令，随后激活新节点并重布局。
  // 无激活节点或空文本时忽略
  async pasteText(text: string) {
    const parent = this.deps.activation.active;
    if (!parent || !text) return;
    // 结构化文本（含换行或 Tab）：解析为节点树后复用节点粘贴（含层级、历史、激活）
    if (/[\n\t]/.test(text)) {
      const tree = parseTextTree(text);
      if (tree.length) {
        await this.pasteFromEntry({ kind: "mindmap", payload: tree, text });
        return;
      }
    }
    // 目标父级处于折叠态时先展开，避免新建节点被可见性联动隐藏
    this.deps.model.expand(parent);
    // 新节点级数 = 激活节点级数 + 1（按级数解析样式）
    const depth = this.deps.model.depthOf(parent) + 1;
    const style = this.deps.model.newNodeStyle(parent, depth);
    // 插入位置在构造命令前定格：追加到子级末尾（统一走 index splice，
    // undo/redo 重放同一索引，不依赖粘贴时的树状态）
    const index = parent.children.length;
    const node = this.deps.model.createNode(parent, style);
    node.text = text;
    const edge = this.deps.model.createEdge(parent, node);
    this.deps.history.exec(
      makeAddCommand(this.deps, { parent, node, index, edge }),
    );
    await this.deps.onRelayout();
    this.deps.activation.activate(node);
    this.deps.emitChange("add");
  }
}

// 层级大纲文本：节点树扁平化为行数组，深度 d 的节点行首叠加 d×4 空格——与飞书
// CF_TEXT 的缩进约定一致（其复制即 4 空格/层），双向互操作；与 parseTextTree
// （Tab 与 4 空格组均计一层深度）互逆，供 text/plain 剪贴板通道使用。
// 顶层兄弟子树之间插入空行——飞书的纯文本解析器按空行切块生成顶层节点（其自身
// 复制即此格式，无空行时整段会被聚合为单节点）；空行在 parseTextTree 中被过滤，
// 往返解析不受影响
function toOutlineText(nodes: MindMapNode[], depth = 0): string[] {
  return nodes.flatMap((n, i) => {
    const block = [
      "    ".repeat(depth) + n.text,
      ...toOutlineText(n.children ?? [], depth + 1),
    ];
    return depth <= 1 && i > 0 ? ["", ...block] : block;
  });
}

// 结构化文本解析为节点树（编辑态/激活态粘贴多行缩进文本）：按行拆分，行首
// Tab 与 4 空格组计缩进深度，以最小缩进为顶层，栈式构建父子层级；
// 空行跳过，每行文本 trim 后作为节点文本
function parseTextTree(text: string): MindMapNode[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length);
  if (!lines.length) return [];
  const depthOf = (line: string): number => {
    let tabs = 0;
    let spaces = 0;
    for (const ch of line) {
      if (ch === "\t") {
        tabs++;
        spaces = 0;
      } else if (ch === " ") {
        spaces++;
      } else break;
    }
    return tabs + Math.floor(spaces / 4);
  };
  const min = Math.min(...lines.map(depthOf));
  const roots: MindMapNode[] = [];
  const stack: { depth: number; node: MindMapNode }[] = [];
  for (const line of lines) {
    const depth = Math.max(0, depthOf(line) - min);
    const node: MindMapNode = { text: line.trim(), children: [] };
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const top = stack[stack.length - 1];
    if (top) top.node.children.push(node);
    else roots.push(node);
    stack.push({ depth, node });
  }
  return roots;
}
