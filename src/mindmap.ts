import { App, Text, VIEWPORT_CAPABILITY } from "@silker/core";
import type { CommandCapability, ExportOptions, HistoryCapability } from "@silker/core";
import type { SelectionCapability, TextEditorCapability, ViewportCapability } from "@silker/core";
import { selectionCapabilityKey, HISTORY_CAPABILITY, TEXT_EDITOR_CAPABILITY } from "@silker/core";
import { EXPORT_CAPABILITY, COMMAND_CAPABILITY, POINTER_CAPABILITY } from "@silker/core";
import { CANVAS_CLICK_CAPABILITY } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import type { TextEditor } from "@silker/plugin-text-editor";
import { BuiltinTreeLayout } from "./layout";
import { AUTO_LAYOUT_CAPABILITY } from "./auto-layout";
import type { AutoLayoutCapability } from "./auto-layout";
import { ActiveHighlight } from "./ActiveHighlight";
import { DragGhost } from "./DragGhost";
import { CollapseToggle } from "./CollapseToggle";
import { MindTree } from "./model";
import { CollapseController } from "./collapse";
import { ActivationController } from "./editing";
import { NodeOperations } from "./operations";
import { KeyboardNav } from "./keyboard";
import { DragInteractions } from "./drag";
import type {
  LayoutDirection,
  MindMapChangeType,
  MindMapNode,
  MindMapOptions,
} from "./types";

// 思维导图场景门面：插件装配 + 公开 API 委托 + init/relayout 挂载顺序。
// 内聚逻辑拆分在同目录各模块（model/drop/collapse/editing/operations/keyboard/drag），
// 依赖单向：drag/keyboard/operations/editing/collapse → model(MindTree) → Edge/core
export class MindMap {
  // 装配与渲染属主：私有——外部经门面语义 API 消费，装配期定制经 MindMapOptions.app 传入
  private app: App;
  // 视口能力（Viewport 插件 install 时注册）：按能力接口消费平移入口，不依赖具体插件实例
  private pan: ViewportCapability | null;
  // 文本编辑能力（TextEditor 插件 install 时注册）：按能力接口消费，不依赖具体插件实例
  private editor: TextEditorCapability;
  private direction: LayoutDirection;
  // 激活高亮环
  private highlight: ActiveHighlight;
  // 拖拽换父：原位虚影框 + 跟随鼠标合集矩形 + 落点连线（可放置提示）
  private ghost: DragGhost;
  // 折叠开关覆盖层：为有子节点的可见节点绘制 −/+ 圆形开关
  private collapseToggle: CollapseToggle;
  // 选中状态（唯一数据源在 Selection 插件，本字段为能力引用）
  private sel: SelectionCapability<Text>;
  // 数据变化回调（构造时从 options 记录）
  private onChange?: (type: MindMapChangeType) => void;
  // 命令模式历史记录：各变更入口把"改树"抽成可逆命令入栈，undo/redo 时重放/逆放。
  // 实现在 @silker/plugin-history，构造器内安装插件后按能力键消费
  private history!: HistoryCapability;
  // 自动布局能力（BuiltinTreeLayout 插件 install 时注册，第三方布局插件可同名覆盖）：
  // 各结构变更路径经 relayout 按能力键消费，注册表缺失属于装配错误（require 兜底）
  private layout!: AutoLayoutCapability;
  // 命令与键位能力：动作注册为命令、按键统一分发（撤销/复制/粘贴/删除等默认键位见构造器）
  private commands!: CommandCapability;
  // 数据模型（节点树/连线/样式缓存的唯一属主）
  private model: MindTree;
  // 激活/编辑控制器（激活态与编辑态两态机）
  private activation: ActivationController;
  // 折叠控制器（开关枚举/命中/悬浮与切换）
  private collapse: CollapseController;
  // 节点操作（新建/删除/复制/粘贴，clipboard 属主）
  private operations: NodeOperations;
  // 键盘导航（方向键/Tab/Enter/全局按键分发）
  private keyboard: KeyboardNav;
  // 拖拽交互（拖拽换父/框选绑定/边缘自动平移）
  private drag: DragInteractions;

  constructor(options: MindMapOptions) {
    this.direction = options.direction ?? "left";
    const edgeStyle = options.edgeStyle ?? "bezier";
    const levelStyles = options.levelStyles ?? [];
    this.onChange = options.onChange;
    // 两种装配模式（对齐 FlowChartOptions.app 语义）：
    // - 便捷模式（缺省，Application 角色）：自建 App 并安装官方外部插件，开箱即用；
    // - 显式装配模式（传 app）：宿主自建 App 并安装官方外部插件（通常用
    //   @silker/preset 的 officialPlugins()，实现均可按契约替换），
    //   本场景只补齐自有插件（BuiltinTreeLayout 等）并接线场景回调
    this.app = options.app ?? new App(options.canvas);
    if (!options.app) {
      // 便捷模式：安装官方外部插件预设（集合与顺序的单一事实来源在 @silker/preset），
      // 各插件 install 时自注册能力，此后仅按能力键消费
      for (const p of officialPlugins()) this.app.use(p);
    }
    // 按能力键显式依赖（require 兜底装配错误，只认能力名与契约，不认插件实例）
    this.history = this.app.require(HISTORY_CAPABILITY);
    this.commands = this.app.require(COMMAND_CAPABILITY);
    this.commands.guard = (e) => this.activation.keymapGuard(e);
    this.commands.register({
      id: "mindmap.undo",
      title: "撤销",
      run: () => this.undo(),
    });
    this.commands.register({
      id: "mindmap.redo",
      title: "重做",
      run: () => this.redo(),
    });
    this.commands.register({
      id: "mindmap.copy",
      title: "复制选中",
      run: () => this.operations.copySelection(),
    });
    this.commands.register({
      id: "mindmap.paste",
      title: "粘贴",
      run: () => this.operations.pasteClipboard(),
    });
    this.commands.register({
      id: "mindmap.delete",
      title: "删除选中",
      run: () => this.operations.deleteSelection(),
    });
    this.commands.bind("mod+z", "mindmap.undo");
    this.commands.bind("mod+shift+z", "mindmap.redo");
    this.commands.bind("mod+y", "mindmap.redo");
    this.commands.bind("mod+c", "mindmap.copy");
    this.commands.bind("mod+v", "mindmap.paste");
    this.commands.bind("delete", "mindmap.delete");
    this.commands.bind("backspace", "mindmap.delete");
    // 插件 install 时自注册视口能力，此处按能力协议显式依赖（只认能力名与契约，不认插件实例）
    this.pan = this.app.require(VIEWPORT_CAPABILITY);
    // 安装官方布局插件（树形布局自注册 mindmap.auto-layout 能力），再装配应用层传入的
    // 第三方插件（可同名覆盖布局，初始数据 init 前生效）；此后仅按能力键消费布局能力
    this.app.use(new BuiltinTreeLayout());
    for (const p of options.plugins ?? []) this.app.use(p);
    this.layout = this.app.require(AUTO_LAYOUT_CAPABILITY);
    // 文本编辑：按能力键取回官方预设（或宿主显式装配）的实例并接线场景回调。
    // 编辑回调（onInput/onEditStart/onActivate/onEditEnd）为场景接线：
    // 输入时重新布局，编辑框就绪后交由激活控制器绑定按键与两态机；
    // 点击仅激活（常驻覆盖层 + 画布高亮环），进入编辑由打字或点击覆盖层触发
    const editor = this.app.require(TEXT_EDITOR_CAPABILITY) as TextEditor;
    editor.onInput = () => this.relayout();
    editor.onEditStart = (el, text) => this.activation.onEditStart(el, text);
    editor.onActivate = (text) => this.activation.activate(text);
    editor.onEditEnd = () => this.activation.onEditEnd();
    this.editor = editor;
    // 选中：按能力键取回官方预设（或宿主显式装配）的实例。
    // 选中语义（激活态覆盖层、高亮环、视口跟随）由激活控制器定义；
    // 框选命中规则 = 可见文本节点与矩形相交
    const sel = this.app.require(selectionCapabilityKey<Text>());
    sel.hitRect = (rect) => this.model.textsInRect(rect);
    // 框选首帧成框：退出选中态（覆盖层交还 canvas，多选态无编辑框）
    sel.onMarqueeStart = () => this.activation.deactivate();
    // 拖框中实时应用激活样式：当前与选框相交的节点立刻高亮
    sel.onMarqueeMove = (_rect, hits) => {
      this.highlight.targets = hits;
    };
    // 框选落定：与选框相交的节点进入选中态（未选中任何节点时保持退出态，
    // 选框残留由插件松手时统一渲染清除）
    sel.onMarqueeEnd = (_rect, hits) => {
      if (hits.length) this.activation.setSelection(hits);
    };
    this.sel = sel;
    // 激活高亮环挂载在最上层（init 中节点与连线加入后再 add）
    this.highlight = new ActiveHighlight();
    // 拖拽反馈层（绘制在高亮环之上）；从右向左布局时落点连线锚点左右互换
    this.ghost = new DragGhost();
    this.ghost.mirror = this.direction === "left";
    // 折叠开关覆盖层（绘制在拖拽反馈层之上、框选矩形之下），开关项渲染时实时枚举
    this.collapseToggle = new CollapseToggle();
    this.collapseToggle.items = () => this.collapse.items();

    // ---- 场景模块装配（插件之后、初始数据 init 之前；highlight/ghost/collapseToggle 注入各 controller）----
    this.model = new MindTree({ levelStyles, edgeStyle });
    this.activation = new ActivationController({
      app: this.app,
      editor: this.editor,
      highlight: this.highlight,
      sel: this.sel,
      history: this.history,
      onNavigate: (key) => this.keyboard.navigate(key),
      onCreateRelated: (e, text) => this.operations.createRelated(e, text),
      onDelete: () => this.operations.deleteSelection(),
      onNodePress: (e) => this.drag.onOverlayDown(e),
      emitChange: (type) => this.emitChange(type),
    });
    this.collapse = new CollapseController({
      model: this.model,
      direction: this.direction,
      sel: this.sel,
      isBusy: () => this.drag.dragState !== null || this.sel.marqueeActive,
      requestRender: () => this.app.requestRender(),
      onRelayout: () => this.relayout(),
      onDeactivate: () => this.activation.deactivate(),
      emitChange: (type) => this.emitChange(type),
    });
    this.operations = new NodeOperations({
      app: this.app,
      model: this.model,
      history: this.history,
      editor: this.editor,
      sel: this.sel,
      activation: this.activation,
      onRelayout: () => this.relayout(),
      emitChange: (type) => this.emitChange(type),
    });
    this.keyboard = new KeyboardNav({
      model: this.model,
      sel: this.sel,
      direction: this.direction,
      activation: this.activation,
      collapse: this.collapse,
      operations: this.operations,
    });
    this.drag = new DragInteractions({
      app: this.app,
      model: this.model,
      ghost: this.ghost,
      highlight: this.highlight,
      history: this.history,
      sel: this.sel,
      pan: this.pan,
      collapse: this.collapse,
      activation: this.activation,
      keyboard: this.keyboard,
      direction: this.direction,
      onRelayout: () => this.relayout(),
      emitChange: (type) => this.emitChange(type),
    });
    // 左键框选与节点拖拽（含全局按键导航，统一由指针能力绑定）
    this.drag.bind();
    // 点击画布空白处取消激活态（拖拽平移不触发）：按能力键注册空白点击回调
    this.app.require(CANVAS_CLICK_CAPABILITY).onBlankClick(() => this.activation.deactivate());
    // 拖拽到画布边缘时自动平移视口（rAF 常驻循环，非拖拽时空转）
    requestAnimationFrame(this.drag.edgePanLoop);
    // 异步初始化：先布局再挂载渲染（构造函数无法 await，内部顺序保证）
    void this.init(options.data);
  }

  // 撤销：真正输入中（编辑态）或拖拽中不响应（避免与进行中的变更互踩）；激活态覆盖层
  // （隐藏态视觉，文字仍由 canvas 渲染）不算编辑，撤销照常执行；回退前先清空选中态，
  // 防止悬空引用（选中/覆盖层指向已摘除的节点）
  async undo() {
    if (this.activation.editing || this.drag.dragState) return;
    const cmd = this.history.undo();
    if (!cmd) return;
    this.activation.deactivate();
    await this.relayout();
    // 直接调用字段而非 emitChange：undo/redo 不产生新变更，仅通知宿主数据已回退
    this.onChange?.(cmd.type as MindMapChangeType);
  }

  // 重做：流程与 undo 对称，方向相反
  async redo() {
    if (this.activation.editing || this.drag.dragState) return;
    const cmd = this.history.redo();
    if (!cmd) return;
    this.activation.deactivate();
    await this.relayout();
    this.onChange?.(cmd.type as MindMapChangeType);
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  // 导出当前数据树：文本 + 子树 + 节点自定义样式 + 折叠态（级数默认样式不入档，避免与 levelStyles 重复）
  toJSON(): MindMapNode {
    return this.model.toJSON();
  }

  // 导出整棵树为图片（返回 Blob）：委托导出能力离屏渲染，与当前视口无关；
  // 只渲染树与连线，不含高亮环/选框/拖拽反馈等交互覆盖层
  async toImage(options?: ExportOptions): Promise<Blob> {
    if (!this.model.root) throw new Error("MindMap 尚未初始化完成");
    // 缺省白底（PNG 需要不透明底色），调用方可覆盖
    return this.app.require(EXPORT_CAPABILITY).export([this.model.root, ...this.model.edges], {
      background: "#ffffff",
      ...options,
    });
  }

  // 异步初始化：构造节点树 → 折叠可见性联动 → 布局 → fit 视口 → 挂载节点与连线（元函数组装）
  private async init(data: MindMapNode) {
    const root = this.model.renderNode(data);
    this.model.root = root;
    // 数据可携带折叠态：布局前先按折叠标志联动可见性（布局器跳过折叠子树）
    this.model.applyCollapseVisibility();
    await this.layout.layout(root, {
      direction: this.direction,
      levelGap: 80,
      siblingGap: 20,
    });
    this.pan!.fit(this.model.getBounds(root));
    this.app.add(root);
    // 收集所有父子连线并追加到根节点之后，保证连线绘制在节点上层
    this.model.collectEdges(root, this.model.edges);
    this.app.add(this.model.edges);
    // 激活高亮环最后加入，保证绘制在节点与连线之上；拖拽反馈层在其上
    this.app.add(this.highlight);
    this.app.add(this.ghost);
    this.app.add(this.collapseToggle);
    // 异步初始化完成后必须主动渲染一次：构造函数外的首次 render 发生在 add 之前，画布会是空白
    this.app.requestRender();
  }

  // 覆盖层置顶：换父/新增/撤销等路径会向 app.children 末尾追加新连线，跑到覆盖层之上，
  // relayout 时统一把高亮环/拖拽反馈/折叠开关提升回最上层，保证绘制顺序稳定
  // （框选橡皮筋由选中插件在会话内挂载，不在常驻覆盖层之列）
  private raiseOverlays() {
    for (const n of [this.highlight, this.ghost, this.collapseToggle]) {
      this.app.reorder(n, this.app.children.length);
    }
  }

  // 文本输入后按新尺寸重新布局并渲染（元函数组装：重排 + 渲染）
  private async relayout() {
    if (!this.model.root || !this.pan) return;
    // 折叠可见性联动（undo/redo 换父、拖入折叠节点等路径统一收口于此）
    this.model.applyCollapseVisibility();
    // 新连线可能追加到了覆盖层之上，先归位再渲染
    this.raiseOverlays();
    await this.layout.layout(this.model.root, {
      direction: this.direction,
      levelGap: 80,
      siblingGap: 20,
    });
    this.app.requestRender();
    // 布局会移动节点，编辑框必须在对齐一次，否则覆盖在旧位置上
    this.editor.reposition();
  }

  // 触发数据变化回调（重布局落定后由各变更入口调用）
  private emitChange(type: MindMapChangeType) {
    this.onChange?.(type);
  }
}
