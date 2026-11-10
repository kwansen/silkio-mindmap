import { App, Text, VIEWPORT_CAPABILITY } from "@silker/core";
import type { EdgeShape } from "@silker/core";
import type {
  CommandCapability,
  ExportOptions,
  HistoryCapability,
  HistorySnapshot,
  Plugin,
} from "@silker/core";
import type { SelectionCapability, TextEditorCapability, ViewportCapability } from "@silker/core";
import { selectionCapabilityKey, HISTORY_CAPABILITY, TEXT_EDITOR_CAPABILITY } from "@silker/core";
import { EXPORT_CAPABILITY, COMMAND_CAPABILITY, POINTER_CAPABILITY } from "@silker/core";
import { CANVAS_CLICK_CAPABILITY } from "@silker/core";
import { BuiltinTreeLayout } from "./layout";
import { AUTO_LAYOUT_CAPABILITY } from "./auto-layout";
import type { AutoLayoutCapability } from "./auto-layout";
import { ActiveHighlight } from "./ActiveHighlight";
import { DragGhost } from "./DragGhost";
import { CollapseToggle } from "./CollapseToggle";
import { MindTree } from "./model";
import { createMindmapCodec } from "./history-codec";
import { CollapseController } from "./collapse";
import { ActivationController } from "./editing";
import { NodeOperations } from "./operations";
import { AIEditingController, AIEditingPlugin } from "./ai";
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
  // AI 编辑控制器（AIEditingPlugin 经此提供 mindmap.ai 能力；门面经 ai getter 暴露）
  private aiController: AIEditingController;
  // 键盘导航（方向键/Tab/Enter/全局按键分发）
  private keyboard: KeyboardNav;
  // 拖拽交互（拖拽换父/框选绑定/边缘自动平移）
  private drag: DragInteractions;
  // 构造期安装的插件（官方树形布局 + 应用层第三方）：destroy 时对称卸载
  private scenePlugins: Plugin[] = [];
  // 交互监听清理函数（指针绑定等），destroy 时统一执行
  private cleanups: Array<() => void> = [];
  // 已拆卸标志：destroy 后 init 不再挂载节点（init 为异步，可能与 destroy 竞争）
  private destroyed = false;

  constructor(options: MindMapOptions) {
    this.direction = options.direction ?? "left";
    const edgeStyle = options.edgeStyle ?? "bezier";
    const levelStyles = options.levelStyles ?? [];
    this.onChange = options.onChange;
    // 显式装配（starter-kit 模式）：宿主自建 App 并装配官方外部插件（通常用
    // @silker/preset 的 officialPlugins()，实现均可按契约替换），本场景只补齐
    // 自有插件（BuiltinTreeLayout 等）并接线场景回调；
    // 场景包不依赖 preset，装配缺口由下方 require 兜底报错
    this.app = options.app;
    // 按能力键显式依赖（require 兜底装配错误，只认能力名与契约，不认插件实例）
    this.history = this.app.require(HISTORY_CAPABILITY);
    this.commands = this.app.require(COMMAND_CAPABILITY);
    this.commands.guard = (e) => this.activation.keymapGuard(e);
    this.commands.register({
      id: "mindmap.undo",
      title: "撤销",
      run: async () => {
        await this.undo();
      },
    });
    this.commands.register({
      id: "mindmap.redo",
      title: "重做",
      run: async () => {
        await this.redo();
      },
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
    this.commands.register({
      id: "mindmap.selectAll",
      title: "全选",
      run: () => this.selectAll(),
    });
    this.commands.bind("mod+a", "mindmap.selectAll");
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
    // 第三方插件（可同名覆盖布局，初始数据 init 前生效）；此后仅按能力键消费布局能力。
    // 安装清单留存，destroy 时对称卸载
    this.scenePlugins = [new BuiltinTreeLayout(), ...(options.plugins ?? [])];
    for (const p of this.scenePlugins) this.app.use(p);
    this.layout = this.app.require(AUTO_LAYOUT_CAPABILITY);
    // 文本编辑：按能力键取回官方预设（或宿主显式装配）的实例并接线场景回调。
    // 编辑回调（onInput/onEditStart/onActivate/onEditEnd）为场景接线：
    // 输入时重新布局，编辑框就绪后交由激活控制器绑定按键与两态机；
    // 点击仅激活（常驻覆盖层 + 画布高亮环），进入编辑由打字或点击覆盖层触发
    const editor = this.app.require(TEXT_EDITOR_CAPABILITY);
    editor.onInput = () => this.relayout();
    editor.onEditStart = (el, text) => this.activation.onEditStart(el, text);
    editor.onActivate = (text) => this.activation.activate(text);
    editor.onEditEnd = () => this.activation.onEditEnd();
    this.editor = editor;
    // 选中：按能力键取回宿主装配（通常为官方预设）的实例。
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
    // 拖拽反馈层（绘制在高亮环之上）；从右向左布局时落点连线锚点左右互换，
    // 纵向布局（down）落点连线走垂直方向
    this.ghost = new DragGhost();
    this.ghost.mirror = this.direction === "left";
    this.ghost.vertical = this.direction === "down";
    // 折叠开关覆盖层（绘制在拖拽反馈层之上、框选矩形之下），开关项渲染时实时枚举
    this.collapseToggle = new CollapseToggle();
    this.collapseToggle.items = () => this.collapse.items();

    // ---- 场景模块装配（插件之后、初始数据 init 之前；highlight/ghost/collapseToggle 注入各 controller）----
    this.model = new MindTree({ levelStyles, edgeStyle, direction: this.direction });
    // 拖拽落点连线镜像按目标节点子侧判定（双向布局下左右两侧各自互换，
    // 单侧布局兜底 mirror 与 model.sideOf 结果一致）
    this.ghost.sideOf = (n) => this.model.sideOf(n) === "left";
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
      requestRender: () => this.app.requestOverlayRender(),
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
    // 左键框选与节点拖拽（含全局按键导航，统一由指针能力绑定）；
    // 指针绑定返回的撤销函数并入 cleanups，destroy 时统一执行
    this.cleanups.push(this.drag.bind());
    // AI 编辑插件：控制器依赖场景模块（在 operations 之后装配），install 注册
    // mindmap.ai 能力并留档 scenePlugins（destroy 时随场景对称卸载）
    this.aiController = new AIEditingController(
      {
        app: this.app,
        model: this.model,
        history: this.history,
        // AI 的 undo/redo 操作与手动 Ctrl+Z 完全同源（含编辑态/拖拽守卫、
        // 清选中、重布局与宿主通知），返回是否实际执行供步骤反馈区分跳过
        undo: () => this.undo(),
        redo: () => this.redo(),
        editor: this.editor,
        sel: this.sel,
        activation: this.activation,
        onRelayout: () => this.relayout(),
        emitChange: (type) => this.emitChange(type),
      },
      options.ai ?? null,
    );
    const aiPlugin = new AIEditingPlugin(this.aiController);
    this.scenePlugins.push(aiPlugin);
    this.app.use(aiPlugin);
    // 点击画布空白处取消激活态（拖拽平移不触发）：按能力键注册空白点击回调
    this.app.require(CANVAS_CLICK_CAPABILITY).onBlankClick(() => this.activation.deactivate());
    // 异步初始化：先布局再挂载渲染（构造函数无法 await，内部顺序保证）
    void this.init(options.data);
  }

  // 全选：全部可见节点进入多选态（高亮环 + 批量拖拽/删除/复制可用）。
  // 编辑态（mod+a 属输入框原生全选）或拖拽中不响应，避免与进行中的会话互踩
  selectAll() {
    if (this.activation.editing || this.drag.dragState) return;
    if (!this.model.root) return;
    const all: Text[] = [];
    this.model.collectTexts(this.model.root, all);
    const visible = all.filter((n) => n.visible);
    if (!visible.length) return;
    this.activation.setSelection(visible);
  }

  // 撤销：真正输入中（编辑态）或拖拽中不响应（避免与进行中的变更互踩）；激活态覆盖层
  // （隐藏态视觉，文字仍由 canvas 渲染）不算编辑，撤销照常执行；回退前先清空选中态，
  // 防止悬空引用（选中/覆盖层指向已摘除的节点）。
  // 返回是否实际撤销了一条命令（无可撤销或被守卫拦截返回 false），AI 控制器据此
  // 区分"已撤销"与"没有可撤销"的步骤反馈
  async undo(): Promise<boolean> {
    if (this.activation.editing || this.drag.dragState) return false;
    const cmd = this.history.undo();
    if (!cmd) return false;
    this.activation.deactivate();
    await this.relayout();
    // 直接调用字段而非 emitChange：undo/redo 不产生新变更，仅通知宿主数据已回退
    this.onChange?.(cmd.type as MindMapChangeType);
    return true;
  }

  // 重做：流程与 undo 对称，方向相反
  async redo(): Promise<boolean> {
    if (this.activation.editing || this.drag.dragState) return false;
    const cmd = this.history.redo();
    if (!cmd) return false;
    this.activation.deactivate();
    await this.relayout();
    this.onChange?.(cmd.type as MindMapChangeType);
    return true;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  // AI 编辑能力：run(prompt) 执行一次 AI 编辑（生成适配器经 MindMapOptions.ai 注入）。
  // 门面直接暴露控制器实例（本场景自有插件，非宿主可替换的外部能力）
  get ai(): AIEditingController {
    return this.aiController;
  }

  // 导出当前数据树：文本 + 子树 + 节点自定义样式 + 折叠态（级数默认样式不入档，避免与 levelStyles 重复）
  toJSON(): MindMapNode {
    return this.model.toJSON();
  }

  // 设置布局方向（数据与场景实例保持不动）：同步更新门面/模型/各控制器的方向状态与
  // 拖拽反馈层朝向，翻转既有连线纵向标志后整体重布局。根节点锚定语义：布局器只写
  // 子节点相对坐标、从不移动根节点，这里也不调整视口——根节点在屏幕上的位置保持
  // 原地不动，子树绕其重排（不整体居中，避免画面跳动）。
  // 方向设置记入历史（变更已发生故 record 而非 exec）：undo/redo 由 applyDirection
  // 恢复方向状态，重布局由 undo/redo 流程统一执行
  async setLayout(direction: LayoutDirection) {
    if (!this.model.root || !this.pan) return;
    const before = this.direction;
    if (before === direction) return;
    this.applyDirection(direction);
    await this.relayout();
    this.history.record({
      type: "layout",
      redo: () => this.applyDirection(direction),
      undo: () => this.applyDirection(before),
      // 序列化载荷：纯方向快照，重建时经 onDirection 回调恢复门面方向状态
      toJSON: () => ({
        kind: "mindmap.layout",
        payload: { before, after: direction },
      }),
    });
    this.emitChange("layout");
  }

  // 应用布局方向到门面/模型/各控制器（数据与场景实例不动）：翻转既有连线纵向标志，
  // 重布局由调用方统一执行（setLayout 与历史 undo/redo 共用，undo/redo 后
  // MindMap.undo/redo 的 relayout 按 this.direction 重排）
  private applyDirection(direction: LayoutDirection) {
    this.direction = direction;
    this.model.setDirection(direction);
    this.ghost.mirror = direction === "left";
    this.ghost.vertical = direction === "down";
    this.collapse.setDirection(direction);
    this.keyboard.setDirection(direction);
    this.drag.setDirection(direction);
  }

  // 设置连线样式（数据与场景实例保持不动）：按新样式重建连线对象并替换场景中的连线层。
  // 锚点在渲染前刷新（update），无需重布局，仅请求重绘；样式未变化时无操作。
  // 设置记入历史（变更已发生故 record 而非 exec）：undo/redo 直接换回重建前的
  // 旧连线对象数组（对象引用稳定，无需再走重建），场景同步增删
  setEdgeStyle(shape: EdgeShape) {
    if (!this.model.root) return;
    const prev = [...this.model.edges];
    const before = this.model.setEdgeStyle(shape);
    if (before === null) return;
    const next = [...this.model.edges];
    this.app.remove(prev);
    this.app.add(next);
    this.app.requestRender();
    this.history.record({
      type: "edge",
      redo: () => {
        this.model.edges.length = 0;
        this.model.edges.push(...next);
        this.app.remove(prev);
        this.app.add(next);
      },
      undo: () => {
        this.model.edges.length = 0;
        this.model.edges.push(...prev);
        this.app.remove(next);
        this.app.add(prev);
      },
      // 序列化载荷：纯样式快照，重建时经 model.setEdgeStyle 按当前连线表重建
      //（重建沿用原连线 id，跨命令按 id 解析的引用保持一致）
      toJSON: () => ({
        kind: "mindmap.edge",
        payload: { before, after: shape },
      }),
    });
    this.emitChange("edge");
  }

  // 导出历史栈为可序列化快照（撤销栈在先、重做栈在后）：栈内含不可序列化命令
  // （如三方闭包命令）时返回 null，拒绝部分导出
  exportHistory(): HistorySnapshot | null {
    return this.history.exportJSON?.() ?? null;
  }

  // 导入历史快照替换当前撤销/重做栈：命令按 kind 经领域编解码器重建，节点引用
  // 按 id 解析——数据节点 id 须与导出时同源（用带 id 的 toJSON() 往返），任一
  // 命令重建失败返回 false 且原栈不变
  importHistory(data: HistorySnapshot): boolean {
    const codec = createMindmapCodec({
      model: this.model,
      app: this.app,
      // 布局方向命令重建：恢复门面/模型/各控制器方向状态（重布局由 undo/redo 流程统一执行）
      onDirection: (d) => this.applyDirection(d),
    });
    return this.history.importJSON?.(data, (s) => codec.decode(s)) ?? false;
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
    this.pan!.center(this.model.getBounds(root));
    // destroy 可能先于异步布局完成：已拆卸则不再挂载任何节点
    if (this.destroyed) return;
    this.app.add(root);
    // 收集所有父子连线并追加到根节点之后，保证连线绘制在节点上层
    this.model.collectEdges(root, this.model.edges);
    this.app.add(this.model.edges);
    // 交互覆盖层注册为常驻顶层（按绘制次序：高亮环 → 拖拽反馈 → 折叠开关），
    // 之后新增节点/连线由 App 自动保持覆盖层置顶
    this.app.addOverlay(this.highlight);
    this.app.addOverlay(this.ghost);
    this.app.addOverlay(this.collapseToggle);
    // 异步初始化完成后必须主动渲染一次：构造函数外的首次 render 发生在 add 之前，画布会是空白
    this.app.requestRender();
  }

  // 文本输入后按新尺寸重新布局并渲染（元函数组装：重排 + 渲染）
  private async relayout() {
    if (!this.model.root || !this.pan) return;
    // 折叠可见性联动（undo/redo 换父、拖入折叠节点等路径统一收口于此）
    this.model.applyCollapseVisibility();
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

  // 完整拆卸（幂等，页面级销毁或显式装配下重建场景用）：
  // 1) 撤销指针监听；
  // 2) 复位接线在宿主插件上的场景回调（编辑器/选中/空白点击可能为显式装配的
  //    宿主所有，避免已销毁门面被插件回调持有），并结束进行中的编辑会话；
  // 3) 注销场景命令（键位随命令一并移除）并复位分发守卫；
  // 4) 移除场景节点与覆盖层（常驻置顶注册随之注销）；
  // 5) 卸载构造期安装的插件（能力注册表沿 previous 链撤销/恢复）。
  // 宿主自建的 App 与官方插件（显式装配）不受影响，可继续复用
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // 历史栈随场景废弃：栈内命令闭包引用本场景节点/模型，场景销毁后命令失效，
    // 不清空会让切换文档后的新场景残留旧场景的撤销/重做（且作用于已销毁对象）
    this.history.clear?.();
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.editor.onInput = undefined;
    this.editor.onEditStart = undefined;
    this.editor.onActivate = undefined;
    this.editor.onEditEnd = undefined;
    this.editor.stop();
    this.sel.hitRect = () => [];
    this.sel.onMarqueeStart = null;
    this.sel.onMarqueeMove = null;
    this.sel.onMarqueeEnd = null;
    this.app.require(CANVAS_CLICK_CAPABILITY).onBlankClick(null);
    for (const id of [
      "mindmap.undo",
      "mindmap.redo",
      "mindmap.copy",
      "mindmap.paste",
      "mindmap.delete",
      "mindmap.selectAll",
    ]) {
      this.commands.unregister(id);
    }
    this.commands.guard = null;
    if (this.model.root) this.app.remove(this.model.root);
    this.app.remove(this.model.edges);
    this.app.remove(this.highlight);
    this.app.remove(this.ghost);
    this.app.remove(this.collapseToggle);
    for (const p of this.scenePlugins) this.app.uninstall(p);
    this.scenePlugins = [];
  }
}
