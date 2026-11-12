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
import { CLIPBOARD_CAPABILITY } from "@silker/core";
import type { ClipboardCapability } from "@silker/core";
import { BuiltinTreeLayout } from "./layout";
import { AUTO_LAYOUT_CAPABILITY } from "./auto-layout";
import type { AutoLayoutCapability } from "./auto-layout";
import { ActiveHighlight } from "./ActiveHighlight";
import { DragGhost } from "./DragGhost";
import { CollapseToggle } from "./CollapseToggle";
import { MindTree } from "./model";
import { createMindmapCodec } from "./history-codec";
import { CollapseController } from "./collapse";
import { ActivationController, hasDocumentTextSelection } from "./editing";
import { NodeOperations } from "./operations";
import { AIEditingController, AIEditingPlugin } from "./ai";
import { KeyboardNav } from "./keyboard";
import { DragInteractions } from "./drag";
import type { MindEdge } from "./Edge";
import type { EdgePayload, LayoutPayload } from "./history-payloads";
import type {
  LayoutDirection,
  LayoutDirectionRef,
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
  // 布局方向共享引用（唯一状态源）：模型与各交互控制器按引用读取同一份值，
  // 切换方向只改这一处状态，无需逐模块 setDirection 同步
  private dir: LayoutDirectionRef;
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
  // 命令与键位能力：动作注册为命令、按键统一分发（撤销/删除等默认键位见构造器；
  // 复制走 mod+c 命令写系统剪贴板，粘贴走原生 paste 事件，不绑 mod+v）
  private commands!: CommandCapability;
  // 剪贴板能力（Clipboard 插件 install 时注册，未装配时为 null——复制/粘贴命令降级为无操作）：
  // 场景以 consumer 身份参与 copy/paste 事件分发
  private clipboard: ClipboardCapability | null;
  // 数据模型（节点树/连线/样式缓存的唯一属主）
  private model: MindTree;
  // 激活/编辑控制器（激活态与编辑态两态机）
  private activation: ActivationController;
  // 折叠控制器（开关枚举/命中/悬浮与切换）
  private collapse: CollapseController;
  // 节点操作（新建/删除/复制/粘贴，载荷序列化与外部文本建节点）
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
  // 异步初始化 promise：构造函数无法 await，宿主可在 ready 落定后安全操作场景
  // （如 selectRoot 选中根节点）
  private ready: Promise<void>;
  // 已登记点击激活的节点（WeakSet 去重）：bindNode 为命令 redo 挂载路径的统一
  // 登记入口（见 commands.ts），重复挂载/换树重放不重复登记
  private boundNodes = new WeakSet<Text>();
  // 布局间距（MindMapOptions.levelGap/siblingGap，缺省 48/12）：init 初始布局与
  // relayout 重布局共用同一份，避免两处硬编码漂移
  private levelGap: number;
  private siblingGap: number;

  constructor(options: MindMapOptions) {
    this.dir = { value: options.direction ?? "left" };
    const edgeStyle = options.edgeStyle ?? "bezier";
    const levelStyles = options.levelStyles ?? [];
    this.levelGap = options.levelGap ?? 48;
    this.siblingGap = options.siblingGap ?? 12;
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
      run: () => {
        const entry = this.operations.copySelection();
        if (entry) void this.clipboard?.write(entry);
      },
    });
    this.commands.register({
      id: "mindmap.paste",
      title: "粘贴",
      run: async () => {
        const entry = await this.clipboard?.read("mindmap");
        if (entry) await this.operations.pasteFromEntry(entry);
      },
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
    // mod+c 绑复制命令（写系统剪贴板；Chrome 无选区时 Ctrl+C 不派发 copy 事件，
    // 需命令路径兜底）；粘贴不绑 mod+v——paste 事件必发且零权限，走原生事件分发
    this.commands.bind("mod+c", "mindmap.copy");
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
    // 输入时重新布局，并同步发出变更通知（宿主 UI 如文档标题/自动保存随每次输入
    // 实时更新；历史记录不受影响，仍由 onEditEnd 以整个编辑会话为一次变更入栈）。
    // 编辑回调载荷为能力契约的 EditableText，本场景以具体 Text 节点工作，在接线处收窄
    editor.onInput = (payload) => {
      const text = payload as Text;
      void this.relayout().then(() => {
        // autoWidth 节点随输入长宽，可能越出视口：布局落定后按新包围盒平移
        // （原 text-editor 插件的输入跟随行为上移至场景）
        const p = text.getWorldPoint();
        if (
          this.app.camera.scrollIntoView({
            minX: p.x,
            minY: p.y,
            maxX: p.x + text.width,
            maxY: p.y + text.height,
          })
        )
          this.app.requestCameraRender();
      });
      this.emitChange("text");
    };
    editor.onEditStart = (el, text) => this.activation.onEditStart(el, text as Text);
    editor.onActivate = (text) => this.activation.activate(text as Text);
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
    this.ghost.mirror = this.dir.value === "left";
    this.ghost.vertical = this.dir.value === "down";
    // 折叠开关覆盖层（绘制在拖拽反馈层之上、框选矩形之下），开关项渲染时实时枚举
    this.collapseToggle = new CollapseToggle();
    this.collapseToggle.items = () => this.collapse.items();

    // ---- 场景模块装配（插件之后、初始数据 init 之前；highlight/ghost/collapseToggle 注入各 controller）----
    // 模型接入场景增删入口（连线表同步原语据此联动场景连线层）与方向共享引用
    this.model = new MindTree({
      levelStyles,
      edgeStyle,
      direction: this.dir,
      app: this.app,
    });
    // 拖拽落点连线镜像按目标节点子侧判定（双向布局下左右两侧各自互换，
    // 单侧布局兜底 mirror 与 model.sideOf 结果一致）
    this.ghost.sideOf = (n) => this.model.sideOf(n) === "left";
    this.activation = new ActivationController({
      app: this.app,
      editor: this.editor,
      highlight: this.highlight,
      sel: this.sel,
      history: this.history,
      onNavigate: (key) => void this.keyboard.navigate(key),
      onCreateRelated: (e, text) => this.operations.createRelated(e, text),
      onDelete: () => this.operations.deleteSelection(),
      onNodePress: (e) => this.drag.onOverlayDown(e),
      emitChange: (type) => this.emitChange(type),
    });
    this.collapse = new CollapseController({
      model: this.model,
      direction: this.dir,
      sel: this.sel,
      // 拖拽或框选进行中（编辑不算：折叠开关在编辑会话中仍可用），
      // 谓词由 busyState 单一出处派生
      isBusy: () => {
        const state = this.busyState();
        return state.dragging || state.marquee;
      },
      requestRender: () => this.app.requestOverlayRender(),
      onRelayout: () => this.relayout(),
      onDeactivate: () => this.activation.deactivate(),
      emitChange: (type) => this.emitChange(type),
    });
    this.operations = new NodeOperations({
      app: this.app,
      model: this.model,
      history: this.history,
      // 挂载节点登记点击激活（命令 redo 统一收口，见 bindNode 方法）
      bindNode: (n) => this.bindNode(n),
      sel: this.sel,
      activation: this.activation,
      onRelayout: () => this.relayout(),
      emitChange: (type) => this.emitChange(type),
    });
    // 剪贴板接线：场景以 consumer 身份注册到 Clipboard 插件（原生 copy/paste 事件
    // 分发；未装配插件时 clipboard 为 null，复制/粘贴命令降级为无操作）
    this.clipboard = this.app.capability(CLIPBOARD_CAPABILITY) ?? null;
    if (this.clipboard) {
      const unregister = this.clipboard.register({
        kind: "mindmap",
        // copy 全权决策（场景 UX，机制层不窥探选区/编辑状态）。选区语义收口为
        // "有选区即原生，无选区画布接管"：文档内存在非折叠文字选区（编辑覆盖层
        // 内选中文字，或宿主页面其它区域如 AI 面板）→ 原生复制；无选区（激活态/
        // 光标折叠的编辑态）→ 复制当前选中/激活节点子树
        onCopy: () => {
          if (hasDocumentTextSelection()) return "native";
          return this.operations.copySelection();
        },
        deserialize: (entry) => void this.operations.pasteFromEntry(entry),
        // 纯文本粘贴全权决策：编辑态覆盖层内纯文字（无换行/Tab）→ 原生粘贴到
        // 光标；结构化文本（如飞书大纲复制，含换行/Tab）与其余画布态 → 解析为
        // 节点树粘贴（文本形状的含义是本场景的领域知识）
        onPasteText: ({ target, text }) => {
          if (!text) return "native";
          if (this.activation.editing && target?.isContentEditable && !/[\n\t]/.test(text)) {
            return "native";
          }
          void this.operations.pasteText(text);
          return "handled";
        },
      });
      // 注销并入 cleanups，destroy 时撤销事件分发参与
      this.cleanups.push(unregister);
    }
    this.keyboard = new KeyboardNav({
      model: this.model,
      sel: this.sel,
      direction: this.dir,
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
      direction: this.dir,
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
        // 挂载节点登记点击激活（命令 redo 统一收口，见 bindNode 方法）
        bindNode: (n) => this.bindNode(n),
        sel: this.sel,
        activation: this.activation,
        // 画布交互忙守卫（拖拽/框选），谓词由 busyState 单一出处派生
        busy: () => {
          const state = this.busyState();
          return state.dragging || state.marquee;
        },
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
    // 异步初始化：先布局再挂载渲染（构造函数无法 await，内部顺序保证）；
    // promise 留档供 selectRoot 等宿主调用等待就绪。初始化失败（数据/布局异常）
    // 经 onError 通知宿主并兜底 console.error，避免静默的 unhandled rejection
    //（ready 保持 resolved，selectRoot 等后续调用安全跳过）
    this.ready = this.init(options.data).catch((err) => {
      console.error("[MindMap] 初始化失败", err);
      options.onError?.(err);
    });
  }

  // 交互忙状态单一出处：各入口的避让谓词（门面 busy、折叠开关 isBusy）均由本方法
  // 派生——新增交互态（如动画锁）只改这里，避免多处谓词手写漂移
  private busyState() {
    return {
      editing: this.activation.editing,
      dragging: this.drag.dragState !== null,
      marquee: this.sel.marqueeActive,
    };
  }

  // 交互忙判定：编辑会话中或拖拽进行中视为忙——撤销/重做/全选等
  // 全局变更入口据此避让，避免与进行中的变更互踩（此前各入口重复手写同一对条件）
  private get busy(): boolean {
    const state = this.busyState();
    return state.editing || state.dragging;
  }

  // 全选：全部可见节点进入多选态（高亮环 + 批量拖拽/删除/复制可用）。
  // 编辑态（mod+a 属输入框原生全选）或拖拽中不响应，避免与进行中的会话互踩
  selectAll() {
    if (this.busy) return;
    if (!this.model.root) return;
    const all: Text[] = [];
    this.model.collectTexts(this.model.root, all);
    const visible = all.filter((n) => n.visible);
    if (!visible.length) return;
    this.activation.setSelection(visible);
  }

  // 选中根节点：等待异步初始化完成后进入单选激活态（高亮环 + 方向键导航可用），
  // 供宿主在新建/切换导图后默认聚焦根节点；已拆卸或初始化失败时静默跳过
  async selectRoot(): Promise<void> {
    await this.ready;
    if (this.destroyed || !this.model.root) return;
    this.activation.setSelection([this.model.root]);
  }

  // 撤销：真正输入中（编辑态）或拖拽中不响应（避免与进行中的变更互踩）；激活态覆盖层
  // （隐藏态视觉，文字仍由 canvas 渲染）不算编辑，撤销照常执行；回退前先清空选中态，
  // 防止悬空引用（选中/覆盖层指向已摘除的节点）。
  // 返回是否实际撤销了一条命令（无可撤销或被守卫拦截返回 false），AI 控制器据此
  // 区分"已撤销"与"没有可撤销"的步骤反馈
  async undo(): Promise<boolean> {
    if (this.busy) return false;
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
    if (this.busy) return false;
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

  // 适应视图：按整棵可见子树的世界包围盒拟合视口（缩放 + 居中）
  fit() {
    if (!this.model.root || !this.pan) return;
    this.pan.fit(this.model.getBounds(this.model.root));
  }

  // 居中视图：保持当前缩放不变，仅平移视口使整棵子树包围盒中心对齐画布中心
  center() {
    if (!this.model.root || !this.pan) return;
    this.pan.center(this.model.getBounds(this.model.root));
  }

  // 设置布局方向（数据与场景实例保持不动）：同步更新门面/模型/各控制器的方向状态与
  // 拖拽反馈层朝向，翻转既有连线纵向标志后整体重布局。根节点锚定语义：布局器只写
  // 子节点相对坐标、从不移动根节点，这里也不调整视口——根节点在屏幕上的位置保持
  // 原地不动，子树绕其重排（不整体居中，避免画面跳动）。
  // 方向设置记入历史（变更已发生故 record 而非 exec）：undo/redo 由 applyDirection
  // 恢复方向状态，重布局由 undo/redo 流程统一执行
  async setLayout(direction: LayoutDirection) {
    if (!this.model.root || !this.pan) return;
    const before = this.dir.value;
    if (before === direction) return;
    this.applyDirection(direction);
    await this.relayout();
    this.history.record({
      type: "layout",
      redo: () => this.applyDirection(direction),
      undo: () => this.applyDirection(before),
      // 序列化载荷：纯方向快照，重建时经 onDirection 回调恢复门面方向状态
      toJSON: (): { kind: "mindmap.layout"; payload: LayoutPayload } => ({
        kind: "mindmap.layout",
        payload: { before, after: direction },
      }),
    });
    this.emitChange("layout");
  }

  // 应用布局方向到门面/模型/各控制器（数据与场景实例不动）：方向为共享引用唯一状态源，
  // 改 ref.value 即全员生效；模型侧只翻转既有连线纵向标志。重布局由调用方统一执行
  //（setLayout 与历史 undo/redo 共用，undo/redo 后 MindMap.undo/redo 的 relayout
  // 按共享 ref 重排）
  private applyDirection(direction: LayoutDirection) {
    this.dir.value = direction;
    this.model.applyDirection(direction);
    this.ghost.mirror = direction === "left";
    this.ghost.vertical = direction === "down";
  }

  // 设置连线样式（数据与场景实例保持不动）：按新样式重建连线对象，场景换入换出
  // 经 replaceEdges 原语统一收口（模型连线表与场景连线层同一处维护，见 model.ts）。
  // 锚点在渲染前刷新（update），无需重布局，仅请求重绘；样式未变化时无操作。
  // 设置记入历史（变更已发生故 record 而非 exec）：undo/redo 直接换回重建前的
  // 旧连线对象数组（对象引用稳定，无需再走重建），场景同步同样走原语
  setEdgeStyle(shape: EdgeShape) {
    if (!this.model.root) return;
    const prev = [...this.model.edges];
    const before = this.model.setEdgeStyle(shape);
    if (before === null) return;
    const next = [...this.model.edges];
    this.app.requestRender();
    this.history.record({
      type: "edge",
      redo: () => {
        this.model.replaceEdges(next);
      },
      undo: () => {
        this.model.replaceEdges(prev);
      },
      // 序列化载荷：纯样式快照，重建时经 model.setEdgeStyle 按当前连线表重建
      //（重建沿用原连线 id，跨命令按 id 解析的引用保持一致）
      toJSON: (): { kind: "mindmap.edge"; payload: EdgePayload } => ({
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
      // 编解码器重建节点经命令 redo 的 bindNode 统一登记点击激活（WeakSet 去重）
      bindNode: (n) => this.bindNode(n),
    });
    return this.history.importJSON?.(data, (s) => codec.decode(s)) ?? false;
  }

  // 挂载节点登记点击激活（幂等）：命令 redo 挂载路径与编解码器重建路径的统一入口，
  // 生产方不再各自手工 editor.bind（WeakSet 去重，重复挂载/换树重放不重复登记）
  private bindNode(n: Text) {
    if (this.boundNodes.has(n)) return;
    this.boundNodes.add(n);
    this.editor.bind(n);
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
      direction: this.dir.value,
      levelGap: this.levelGap,
      siblingGap: this.siblingGap,
    });
    this.pan!.center(this.model.getBounds(root));
    // destroy 可能先于异步布局完成：已拆卸则不再挂载任何节点
    if (this.destroyed) return;
    this.app.add(root);
    // 收集所有父子连线并经 mountEdges 原语挂载（模型连线表与场景连线层同一处维护），
    // 追加到根节点之后保证连线绘制在节点上层
    const edges: MindEdge[] = [];
    this.model.collectEdges(root, edges);
    this.model.mountEdges(edges);
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
      direction: this.dir.value,
      levelGap: this.levelGap,
      siblingGap: this.siblingGap,
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
    this.app.remove([...this.model.edges]);
    this.app.remove(this.highlight);
    this.app.remove(this.ghost);
    this.app.remove(this.collapseToggle);
    for (const p of this.scenePlugins) this.app.uninstall(p);
    this.scenePlugins = [];
  }
}
