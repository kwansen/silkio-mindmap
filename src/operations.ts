import type { App, Node, Text } from "@silker/core";
import type { HistoryCapability, HistoryCommand } from "@silker/core";
import type { SelectionCapability } from "@silker/core";
import type { TextEditorCapability } from "@silker/core";
import type { MindEdge } from "./Edge";
import type { ActivationController } from "./editing";
import type { MindTree } from "./model";
import type { MindMapChangeType, MindMapNode } from "./types";

export interface NodeOperationsDeps {
  app: App;
  model: MindTree;
  history: Pick<HistoryCapability, "exec">;
  editor: Pick<TextEditorCapability, "bind">;
  sel: Pick<SelectionCapability<Text>, "items" | "has">;
  activation: Pick<ActivationController, "active" | "activate" | "deactivate">;
  onRelayout: () => Promise<void> | void;
  emitChange: (type: MindMapChangeType) => void;
}

// 节点操作：新建（Tab/Enter）、删除选中、复制/粘贴（原 MindMap 内联逻辑）。
// clipboard 为复制/粘贴缓冲的唯一属主
export class NodeOperations {
  // 复制/粘贴缓冲：存放选中节点序列化后的子树数据（文本/自定义样式/折叠态/子孙），
  // 复制允许多选整组入档，粘贴仅在单选激活时执行（见 pasteClipboard）
  private clipboard: MindMapNode[] | null = null;

  constructor(private deps: NodeOperationsDeps) {}

  // Tab 创建子节点、Enter 在当前节点下方创建兄弟节点，随后进入编辑并重布局
  // （编辑态由 bindNodeKeys 调用，激活态由 onGlobalKeydown 以合成事件调用）
  async createRelated(e: KeyboardEvent, text: Text) {
    console.log("[MindMap] createRelated", e.key, "from:", text.text);
    const isChild = e.key === "Tab";
    // 根节点回车（无父级可建兄弟节点）忽略，不创建任何节点
    if (!isChild && !text.parent) return;
    const parent = isChild ? text : ((text.parent as Text | null) ?? text);
    // 目标父级处于折叠态时先展开，避免新建节点被可见性联动隐藏
    if (parent.collapsed) {
      parent.collapsed = false;
      this.deps.model.applyCollapseVisibility();
    }
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
    this.deps.model.nodeStyles.set(node, style);
    const edge = this.deps.model.createEdge(parent, node);
    // 新增节点命令：redo/undo 对称地增删子节点与连线（结构重放走静默原语，
    // 不产生中间事件，变更由命令后的 emitChange 统一补发）
    const cmd: HistoryCommand = {
      type: "add",
      redo: () => {
        parent.attachChild(node, index);
        this.deps.app.add(edge);
        this.deps.model.edges.push(edge);
      },
      undo: () => {
        parent.detachChild(node);
        this.deps.model.edges = this.deps.model.edges.filter((edge2) => edge2 !== edge);
        this.deps.app.remove(edge);
      },
    };
    this.deps.history.exec(cmd);
    this.deps.editor.bind(node);
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
    // 删除前定格各目标的父级与位置，及起点或终点在子树内的待清理连线
    const captures = targets.map((node) => ({
      node,
      parent: node.parent as Text,
      index: (node.parent as Text).children.indexOf(node),
    }));
    const dead = this.deps.model.edges.filter(
      (e) => subtree.has(e.fromNode) || subtree.has(e.toNode),
    );
    // 删除命令：多选目标合并为一条，undo 一次全回退
    const cmd: HistoryCommand = {
      type: "delete",
      redo: () => {
        captures.forEach(({ node, parent }) => parent.remove(node));
        this.deps.model.edges = this.deps.model.edges.filter((e) => !dead.includes(e));
        dead.forEach((e) => this.deps.app.remove(e));
      },
      undo: () => {
        // 逆序插回：同父多目标按索引从大到小还原，前序插入不影响后序索引
        for (let i = captures.length - 1; i >= 0; i--) {
          const { node, parent, index } = captures[i];
          parent.attachChild(node, index);
        }
        dead.forEach((e) => {
          this.deps.model.edges.push(e);
          this.deps.app.add(e);
        });
      },
    };
    this.deps.history.exec(cmd);
    // 清空选中态，重布局后激活存活的父节点（activate 会重建覆盖层，旧覆盖层随之卸载）
    this.deps.activation.deactivate();
    await this.deps.onRelayout();
    this.deps.activation.activate(
      captures.map((c) => c.parent).find((p) => !subtree.has(p)) ?? root,
    );
    this.deps.emitChange("delete");
  }

  // 复制选中节点：把各选中节点的子树序列化入剪贴板缓冲（多选可整组复制）。
  // 沿祖先链过滤只留最顶层节点——子孙会随祖先子树整体序列化，若重复入队
  // （选中 a、b、c 且 a→b→c），粘贴时同一分支会被添加两份
  copySelection() {
    if (!this.deps.sel.items.length) return;
    const roots = [...this.deps.sel.items].filter((n) => {
      let p = n.parent as Text | null;
      while (p) {
        if (this.deps.sel.has(p)) return false;
        p = p.parent as Text | null;
      }
      return true;
    });
    this.clipboard = roots.map((n) => this.deps.model.serializeNode(n));
  }

  // 粘贴剪贴板：仅单选激活时执行（多选/无选中不粘贴）——复制的子树按序追加为激活节点
  // 的子节点（追加在其子级末尾），样式按级数解析；随后激活最后一个粘贴节点并重布局，
  // 整次粘贴记为一条可撤销的 add 命令
  async pasteClipboard() {
    if (!this.clipboard?.length || !this.deps.model.root) return;
    const anchor = this.deps.activation.active;
    if (!anchor) return;
    // 目标父级即激活节点，处于折叠态时先展开，避免粘贴节点被可见性联动隐藏
    const parent = anchor;
    if (parent.collapsed) {
      parent.collapsed = false;
      this.deps.model.applyCollapseVisibility();
    }
    // 插入位置在构造命令前定格：追加到子级末尾（统一走 index splice，
    // undo/redo 重放同一索引，不依赖粘贴时的树状态）
    const index = parent.children.length;
    // 新节点级数 = 激活节点级数 + 1（按级数解析样式）；renderNode 递归还原子孙
    // 与自定义样式/折叠态，子树内部连线在命令外定格创建
    // （redo/undo 只做挂载/摘除，重复创建会导致连线翻倍且撤销残留）
    const depth = this.deps.model.depthOf(parent) + 1;
    const inserts = this.clipboard.map((data, i) => {
      const node = this.deps.model.renderNode(data, depth);
      const inner: MindEdge[] = [];
      this.deps.model.collectEdges(node, inner);
      const edge = this.deps.model.createEdge(parent, node);
      return { parent, node, edge, inner, index: index + i };
    });
    // 粘贴命令：redo/undo 对称地增删子树节点、父子连线与子树内部连线（结构重放走静默原语）
    const cmd: HistoryCommand = {
      type: "add",
      redo: () => {
        inserts.forEach(({ parent: p, node, edge, inner, index: idx }) => {
          p.attachChild(node, idx);
          this.deps.app.add(edge);
          this.deps.app.add(inner);
          this.deps.model.edges.push(edge, ...inner);
        });
      },
      undo: () => {
        // 逆序摘除：前序摘除不影响后序兄弟索引
        for (let i = inserts.length - 1; i >= 0; i--) {
          const { parent: p, node, edge, inner } = inserts[i];
          p.detachChild(node);
          const removed = [edge, ...inner];
          this.deps.model.edges = this.deps.model.edges.filter((e) => !removed.includes(e));
          removed.forEach((e2) => this.deps.app.remove(e2));
        }
      },
    };
    this.deps.history.exec(cmd);
    // 为粘贴子树绑定点击激活（app.add 包装只覆盖经它挂载的节点，splice 挂载的需手动绑定）
    inserts.forEach(({ node }) => this.deps.editor.bind(node));
    await this.deps.onRelayout();
    // 最后一个粘贴节点进入激活态（常驻覆盖层，打字即编辑）
    this.deps.activation.activate(inserts[inserts.length - 1].node);
    this.deps.emitChange("add");
  }
}
