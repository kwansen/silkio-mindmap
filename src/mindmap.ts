import { App, Text } from "@silker/core";
import type { Node } from "@silker/core";
import { Viewport, VIEWPORT_CAPABILITY } from "@silker/core-viewport";
import type { ViewportCapability } from "@silker/core-viewport";
import { TextEditor, TEXT_EDITOR_CAPABILITY } from "@silker/plugin-text-editor";
import type { TextEditorCapability } from "@silker/plugin-text-editor";
import { Exporter, EXPORT_CAPABILITY } from "@silker/plugin-exporter";
import type { ExportOptions } from "@silker/plugin-exporter";
import { Selection, selectionCapabilityKey } from "@silker/plugin-selection";
import type { SelectionCapability } from "@silker/plugin-selection";
import { layout } from "./layout";
import { History, HISTORY_CAPABILITY } from "@silker/plugin-history";
import type { HistoryCommand, HistoryCapability } from "@silker/plugin-history";
import { MindMapEdge, MindPathEdge } from "./Edge";
import type { EdgeShape } from "@silker/plugin-edge";

// 思维导图连线类型：贝塞尔单段（MindMapEdge）或直线引出接入（MindPathEdge，path / zBezier）
type MindEdge = MindMapEdge | MindPathEdge
import { ActiveHighlight } from "./ActiveHighlight";
import { DragGhost } from "./DragGhost";
import { CollapseToggle, TOGGLE_RADIUS, TOGGLE_GAP } from "./CollapseToggle";

export interface Style {
  color: string;
  backgroundColor: string;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  radius: number | [number, number, number, number];
  borderColor: string;
  borderWidth: number;
  lineHeight: number;
  padding:
    | number
    | [number]
    | [number, number]
    | [number, number, number]
    | [number, number, number, number];
}

export interface MindMapNode {
  text: string;
  // 节点样式：缺省时按级数回退到 levelStyles 配置（用户数据可覆盖级数配置）
  style?: Style;
  // 子树折叠态：true 时该节点折叠（子树隐藏），缺省为展开
  collapsed?: boolean;
  children: MindMapNode[];
}

// 未配置 levelStyles 且节点缺省 style 时的兜底样式
const defaultStyle: Style = {
  color: "#1f2937",
  backgroundColor: "#ffffff",
  fontSize: 16,
  fontWeight: 400,
  fontFamily: "sans-serif",
  radius: 6,
  borderColor: "#94a3b8",
  borderWidth: 0,
  lineHeight: 1.4,
  padding: [6, 12],
};

export interface MindMapOptions {
  canvas: HTMLCanvasElement;
  data: MindMapNode;
  // 布局方向：'right' 从左往右（子节点在父节点右侧），'left' 从右往左（子节点在父节点左侧），默认 'left'
  direction?: "left" | "right";
  // 按级数的样式配置：index 0 为根节点（一级），依次向深层级递增，超出配置长度时套用最后一项。
  // 节点数据上的 style 优先于级数配置；新建节点（Tab/Enter）按其级数取样式
  levelStyles?: Style[];
  // 数据变化回调：结构变化（新增/删除/拖拽换父）或文本编辑结束且重布局落定后触发，
  // 供宿主持久化等后续操作；当前数据用 toJSON() 导出
  onChange?: (type: MindMapChangeType) => void;
  // 连线样式：'bezier' 单段贝塞尔 S 曲线（默认），'path' 父级水平直线引出 + Z 字折线接入，
  // 'zBezier' 父级水平直线引出 + 贝塞尔曲线接入
  edgeStyle?: EdgeShape;
}

// 数据变化类型：新增节点 / 删除节点 / 拖拽换父 / 文本编辑结束 / 折叠切换
export type MindMapChangeType = "add" | "delete" | "move" | "text" | "collapse";

export type LayoutDirection = NonNullable<MindMapOptions["direction"]>;

// 高亮环两态颜色：激活（未编辑）蓝色，编辑紫色
const ACTIVE_COLOR = "#3b82f6";
const EDITING_COLOR = "#a855f7";

// 落点判定间距上限（世界坐标）：合集左缘与左侧节点右缘间距在 0..DROP_RANGE 内视为候选（后期可能需要调整）
const DROP_RANGE = 500;

export class MindMap {
  app: App;
  private root: Text | null = null;
  // 视口能力（Viewport 插件 install 时注册）：按能力接口消费平移入口，不依赖具体插件实例
  private pan: ViewportCapability | null = null;
  // 文本编辑能力（TextEditor 插件 install 时注册）：按能力接口消费，不依赖具体插件实例
  private editor: TextEditorCapability;
  private edges: MindEdge[] = [];
  private direction: LayoutDirection;
  // 级数样式配置（index 0 为根节点），renderNode 与新建节点按级数取值
  private levelStyles: Style[];
  // 每个节点创建时实际使用的样式，供无级数配置时新建节点沿用参考节点样式
  private nodeStyles = new WeakMap<Text, Style>();
  // 节点数据上的用户自定义样式（未自定义的节点不记录），换父重设样式时与新级数默认样式合并
  private customStyles = new WeakMap<Text, Style>();
  private highlight: ActiveHighlight;
  // 折叠开关覆盖层：为有子节点的可见节点绘制 −/+ 圆形开关
  private collapseToggle: CollapseToggle;
  // 悬浮展开态开关所属节点集合（− 按需显示的数据源）：鼠标压在「节点 + 到各可见子节点
  // 连线」构成的覆盖矩形（或其开关圆）内；父子区域嵌套时可同时命中多个
  private hoverToggles = new Set<Text>();
  // 选中状态（唯一数据源在 Selection 插件，本字段为能力引用）：
  // items length===1 为单选激活态——常驻覆盖层（隐藏态：空覆盖层、文字由 canvas 渲染，
  // 视觉零抖动），打字唤醒为编辑态（输入替换节点文本），点击唤醒则填入文本正常编辑；
  // length>1 为多选（无覆盖层，Tab/Enter/打字唤醒不生效，方向键以选集左上角节点为锚点）
  private sel: SelectionCapability<Text>;
  // 单选派生：多选或无选中时为 null（Tab/Enter、打字唤醒仅单选生效）
  private get active(): Text | null {
    return this.sel.items.length === 1
      ? (this.sel.items[0] as Text)
      : null;
  }
  // 拖拽换父：原位虚影框 + 跟随鼠标合集矩形 + 落点连线（可放置提示）
  private ghost: DragGhost;
  // 拖拽上下文：起点（屏幕/世界）、拖动的子树根、起始局部坐标与合集原始包围盒
  private dragState: {
    startScreen: { x: number; y: number };
    startWorld: { x: number; y: number };
    nodes: Text[];
    origins: { x: number; y: number }[];
    // 鼠标按下的节点及其原始包围盒（合集虚影克隆它并以其为跟随锚点）
    grabNode: Text;
    grabBox: { x: number; y: number; w: number; h: number };
    // 最近一次鼠标屏幕坐标（边缘自动平移的 rAF 循环无鼠标事件时据此重算虚影位置）
    lastScreen: { clientX: number; clientY: number };
  } | null = null;
  private dragMoved = false;
  // 按下命中唯一激活节点（激活态覆盖层沉底，按下必落在画布）：未超阈值松手视为点击进入编辑，
  // 而非画布 click 激活流程
  private pressOnActive = false;
  // 覆盖层上的按下位置（未建立拖拽上下文时用，如根节点）：mouseup 按位移区分点击与拖动
  private overlayDown: { x: number; y: number } | null = null;
  // 拖拽合集虚影：克隆首个被拖节点样式，半透明跟随鼠标
  private dragChip: Text | null = null;
  // 拖拽中原位节点文字的原始颜色（拖拽期间转暗色，结束后恢复）
  private dragFills = new Map<Text, string>();
  // 数据变化回调（构造时从 options 记录）
  private onChange?: (type: MindMapChangeType) => void;
  // 连线样式（构造时从 options 记录）
  private edgeStyle: EdgeShape;
  // 命令模式历史记录：各变更入口把"改树"抽成可逆命令入栈，undo/redo 时重放/逆放。
  // 实现在 @silker/plugin-history，构造器内安装插件后按能力键消费
  private history!: HistoryCapability;
  // 编辑会话起点快照（仅节点引用与原文字符串，非整树快照）：onEditStart 记录，
  // onEditEnd 对比决定是否把文本变更记入历史
  private editingOld: { node: Text | null; text: string } = {
    node: null,
    text: "",
  };
  // 复制/粘贴缓冲：存放选中节点序列化后的子树数据（文本/自定义样式/折叠态/子孙），
  // 复制允许多选整组入档，粘贴仅在单选激活时执行（见 pasteClipboard）
  private clipboard: MindMapNode[] | null = null;
  // 编辑态（唯一状态来源，覆盖层常驻、显隐由本状态驱动）：激活态为 false（方向键导航、
  // Enter/Escape/Delete 走节点操作），打字/IME/粘贴/点击唤醒为 true（按键交给覆盖层默认行为）。
  // 失焦、提交（Enter/Escape）与覆盖层移除时复位
  private editing = false;

  // 按连线样式创建父子连线（统一入口，三处创建点共用）
  private createEdge(from: Text, to: Text): MindEdge {
    if (this.edgeStyle === "bezier") return new MindMapEdge(from, to);
    return new MindPathEdge(from, to, this.edgeStyle);
  }

  // 触发数据变化回调（重布局落定后由各变更入口调用）
  private emitChange(type: MindMapChangeType) {
    this.onChange?.(type);
  }

  // 撤销：真正输入中（编辑态）或拖拽中不响应（避免与进行中的变更互踩）；激活态覆盖层
  // （隐藏态视觉，文字仍由 canvas 渲染）不算编辑，撤销照常执行；回退前先清空选中态，
  // 防止悬空引用（选中/覆盖层指向已摘除的节点）
  async undo() {
    if (this.editing || this.dragState) return;
    const cmd = this.history.undo();
    if (!cmd) return;
    this.deactivate();
    await this.relayout();
    // 直接调用字段而非 emitChange：undo/redo 不产生新变更，仅通知宿主数据已回退
    this.onChange?.(cmd.type as MindMapChangeType);
  }

  // 重做：流程与 undo 对称，方向相反
  async redo() {
    if (this.editing || this.dragState) return;
    const cmd = this.history.redo();
    if (!cmd) return;
    this.deactivate();
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
    if (!this.root) throw new Error("MindMap 尚未初始化完成");
    return this.serializeNode(this.root);
  }

  // 把节点子树序列化为数据节点（toJSON 与复制共用）：文本 + 自定义样式 + 折叠态 + 子孙递归
  private serializeNode(n: Text): MindMapNode {
    const walk = (node: Text): MindMapNode => ({
      text: node.text,
      ...(this.customStyles.has(node) ? { style: this.customStyles.get(node)! } : {}),
      ...(node.collapsed ? { collapsed: true } : {}),
      children: node.children.map((c) => walk(c as Text)),
    });
    return walk(n);
  }

  // 导出整棵树为图片（返回 Blob）：委托导出能力离屏渲染，与当前视口无关；
  // 只渲染树与连线，不含高亮环/选框/拖拽反馈等交互覆盖层
  async toImage(options?: ExportOptions): Promise<Blob> {
    if (!this.root) throw new Error("MindMap 尚未初始化完成");
    // 缺省白底（PNG 需要不透明底色），调用方可覆盖
    return this.app.require(EXPORT_CAPABILITY).export([this.root, ...this.edges], {
      background: "#ffffff",
      ...options,
    });
  }

  constructor(options: MindMapOptions) {
    this.direction = options.direction ?? "left";
    this.edgeStyle = options.edgeStyle ?? "bezier";
    this.levelStyles = options.levelStyles ?? [];
    this.onChange = options.onChange;
    this.app = new App(options.canvas);
    // 安装历史记录插件：命令模式 undo/redo 双栈（默认容量 100），install 时自注册
    // 历史能力，各变更入口按能力键消费（只认能力名与契约，不认插件实例）
    this.app.use(new History());
    this.history = this.app.require(HISTORY_CAPABILITY);
    // 安装视口插件：支持滚轮以鼠标为中心缩放、拖拽平移画布与按包围盒拟合视口；
    // 插件 install 时自注册视口能力，此处按能力协议显式依赖（只认能力名与契约，不认插件实例）
    this.app.use(new Viewport());
    this.pan = this.app.require(VIEWPORT_CAPABILITY);
    // 安装导出插件：install 时自注册导出能力，toImage 按能力键消费
    this.app.use(new Exporter());
    // 安装文本编辑插件：输入时重新布局，编辑框就绪后直接监听按键新建节点（包装 add 自动绑定后续节点）；
    // install 时自注册文本编辑能力，此后仅按能力键消费
    this.app.use(
      new TextEditor({
        onInput: () => this.relayout(),
        onEditStart: (el, text) => {
          // 覆盖层挂载即回到激活态（编辑态由后续打字/点击重新唤醒）
          this.editing = false;
          // 编辑会话起点：定格节点与原文，编辑结束对比决定是否记入历史
          // （覆盖层编辑是持续同步输入，无法在单次 input 边界判定"一次变更"）
          this.editingOld = { node: text, text: text.text };
          this.bindNodeKeys(el, text);
        },
        // 点击仅激活（常驻覆盖层 + 画布高亮环），进入编辑由打字或点击覆盖层触发
        onActivate: (text) => this.activate(text),
        // 失焦切回隐藏态时同步高亮环颜色并复位编辑态；编辑结束视为一次文本变更
        onEditEnd: () => {
          this.editing = false;
          this.setHighlightEditing(false);
          // 文本相对会话起点确有变化才记历史：newText 取编辑结束时的节点文本
          // （此时覆盖层内容已同步进节点）；record 仅入栈不执行，因变更已发生
          const old = this.editingOld;
          if (old.node && old.node.text !== old.text) {
            const node = old.node;
            const before = old.text;
            const after = node.text;
            this.history.record({
              type: "text",
              redo: () => {
                node.text = after;
              },
              undo: () => {
                node.text = before;
              },
            });
          }
          this.emitChange("text");
        },
      }),
    );
    this.editor = this.app.require(TEXT_EDITOR_CAPABILITY);
    // 安装选中插件：单选/多选模型与框选会话（机制），选中语义（激活态覆盖层、
    // 高亮环、视口跟随）由本场景定义；框选命中规则 = 可见文本节点与矩形相交
    this.app.use(new Selection<Text>({ hitRect: (rect) => this.textsInRect(rect) }));
    this.sel = this.app.require(selectionCapabilityKey<Text>());
    // 框选首帧成框：退出选中态（覆盖层交还 canvas，多选态无编辑框）
    this.sel.onMarqueeStart = () => this.deactivate();
    // 拖框中实时应用激活样式：当前与选框相交的节点立刻高亮
    this.sel.onMarqueeMove = (_rect, hits) => {
      this.highlight.targets = hits;
    };
    // 框选落定：与选框相交的节点进入选中态（未选中任何节点时保持退出态，
    // 选框残留由插件松手时统一渲染清除）
    this.sel.onMarqueeEnd = (_rect, hits) => {
      if (hits.length) this.setSelection(hits);
    };
    // 激活高亮环挂载在最上层（init 中节点与连线加入后再 add）
    this.highlight = new ActiveHighlight();
    // 拖拽反馈层（绘制在高亮环之上）；从右向左布局时落点连线锚点左右互换
    this.ghost = new DragGhost();
    this.ghost.mirror = this.direction === "left";
    // 折叠开关覆盖层（绘制在拖拽反馈层之上、框选矩形之下），开关项渲染时实时枚举
    this.collapseToggle = new CollapseToggle();
    this.collapseToggle.items = () => this.collapseItems();
    // 左键框选与节点拖拽
    this.bindMarquee();
    // 激活态键盘导航：方向键切换节点、Tab/Enter 新建、打字进入编辑（编辑态由编辑框自身处理按键）
    document.addEventListener("keydown", this.onGlobalKeydown);
    // 点击画布空白处取消激活态（拖拽平移不触发）
    this.app.onBlankClick = () => this.deactivate();
    // 拖拽到画布边缘时自动平移视口（rAF 常驻循环，非拖拽时空转）
    requestAnimationFrame(this.edgePanLoop);
    // 异步初始化：先布局再挂载渲染（构造函数无法 await，内部顺序保证）
    void this.init(options.data);
  }

  // 单选激活（覆盖层 + 高亮环 + 视口跟随），语义化入口
  private activate(text: Text) {
    // 覆盖层隐藏态沉底后点击会穿透到画布：唤醒编辑（mouseup）后的同节点 click 不再重复激活，
    // 避免重建覆盖层打断刚进入的编辑
    if (text === this.active && this.editor.hasFocus()) return;
    this.setSelection([text]);
  }

  // 唤醒编辑态：显示覆盖层接管文字渲染（fill 填入节点文本、point 定位光标），高亮环切编辑色
  private wake(fill = false, point?: { x: number; y: number }) {
    this.editor.show({ fill, point });
    this.editing = true;
    this.setHighlightEditing(true);
  }

  // 命中可拖节点时建立拖拽上下文（画布按下与覆盖层按下共用），未命中或不可拖返回 false：
  // 命中已选中节点 → 拖整组选中子树；命中未选中节点 → 无需先激活，单独拖它；
  // 根节点不可拖（无父可换），返回 false 交回平移/点击编辑/框选流程
  private tryStartDrag(e: MouseEvent, hit: Text | null): boolean {
    if (!hit) return false;
    // 根节点不可拖动（无父可换），按下走视口平移
    if (hit === this.root) return false;
    if (!this.sel.has(hit)) {
      // 未选中的节点：拖动即单独拖它；未超阈值松手仍走 click 激活流程（不进编辑）
      this.startDrag(e, [hit], hit);
      this.pressOnActive = false;
      return true;
    }
    const nodes = [...this.sel.items].filter((n) => n !== this.root);
    if (!nodes.length) return false;
    this.startDrag(e, nodes, hit);
    this.pressOnActive = this.sel.items.length === 1;
    return true;
  }

  // 建立拖拽上下文：定格起点、记录各节点原位与按下节点包围盒
  private startDrag(e: MouseEvent, nodes: Text[], grabNode: Text) {
    const grabP = grabNode.getWorldPoint();
    this.dragState = {
      startScreen: { x: e.clientX, y: e.clientY },
      startWorld: this.toWorld(e),
      nodes,
      origins: nodes.map((n) => ({ x: n.x, y: n.y })),
      grabNode,
      grabBox: {
        x: grabP.x,
        y: grabP.y,
        w: grabNode.width,
        h: grabNode.height,
      },
      lastScreen: { clientX: e.clientX, clientY: e.clientY },
    };
    this.dragMoved = false;
  }

  // 拖拽帧更新：按当前屏幕坐标重算合集虚影/跟随芯片/落点候选并渲染。
  // mousemove 与边缘自动平移的 rAF 循环共用（平移后无需鼠标移动，虚影也要跟随世界坐标变化）
  private updateDrag(pos: { clientX: number; clientY: number }) {
    const drag = this.dragState;
    if (!drag) return;
    // 节点本体不再跟随移动，由反馈层代替：合集虚影 = 按下节点原始包围盒 + 拖拽位移
    const cur = this.toWorld(pos);
    const dx = cur.x - drag.startWorld.x;
    const dy = cur.y - drag.startWorld.y;
    this.ghost.floatBox = {
      x: drag.grabBox.x + dx,
      y: drag.grabBox.y + dy,
      w: drag.grabBox.w,
      h: drag.grabBox.h,
    };
    // 合集虚影跟随鼠标
    if (this.dragChip) {
      this.dragChip.x = this.ghost.floatBox!.x;
      this.dragChip.y = this.ghost.floatBox!.y;
    }
    // 候选落点：命中时跳过被拖子树，取其下方的真实目标
    const subtree = new Set<Node>();
    const collect = (n: Node) => {
      subtree.add(n);
      n.children.forEach(collect);
    };
    drag.nodes.forEach(collect);
    const t = this.dropTarget(drag, subtree);
    this.ghost.target = t;
    this.app.requestRender();
  }

  // 边缘自动平移：拖拽中鼠标贴近画布边缘时持续平移视口（越近越快），松手即停。
  // 平移改变世界↔屏幕映射，需按 lastScreen 重算虚影位置（无需鼠标再动）
  private edgePanLoop = () => {
    const drag = this.dragState;
    if (drag && this.dragMoved) {
      const rect = this.app.canvas.getBoundingClientRect();
      const zone = 48;
      const { clientX: x, clientY: y } = drag.lastScreen;
      const axis = (near: number, far: number) => {
        if (near < zone) return -Math.max(4, 12 * (1 - near / zone));
        if (far < zone) return Math.max(4, 12 * (1 - far / zone));
        return 0;
      };
      const vx = axis(x - rect.left, rect.right - x);
      const vy = axis(y - rect.top, rect.bottom - y);
      if (vx || vy) {
        const vp = this.app.renderer.viewport;
        this.app.renderer.setViewport({ ...vp, x: vp.x + vx, y: vp.y + vy });
        this.updateDrag(drag.lastScreen);
      }
    }
    requestAnimationFrame(this.edgePanLoop);
  };

  // 取消激活：清空选中集合与高亮环，移除常驻覆盖层（文字交还 canvas 渲染）
  private deactivate() {
    if (!this.sel.items.length) return;
    this.sel.clear();
    this.highlight.targets = [];
    this.editor.stop();
    this.app.requestRender();
  }

  // 折叠可见性联动：折叠节点的整个子树置为不可见（含连线），展开则恢复可见。
  // 连线可见性跟随端点：任一端不可见即隐藏。relayout 统一调用，覆盖所有结构变更路径
  private applyCollapseVisibility() {
    if (!this.root) return;
    const hideAll = (n: Text) => {
      n.visible = false;
      n.children.forEach((c) => hideAll(c as Text));
    };
    const walk = (n: Text) => {
      n.visible = true;
      n.children.forEach((c) => {
        const t = c as Text;
        if (n.collapsed) hideAll(t);
        else walk(t);
      });
    };
    walk(this.root);
    this.edges.forEach((e) => {
      e.visible = e.fromNode.visible && e.toNode.visible;
    });
  }

  // 枚举当前应显示的折叠开关（有子节点且可见的节点），开关圆心在节点子侧边缘外。
  // 折叠态（+）常显；展开态（−）仅鼠标悬浮该节点时显示（拖拽/框选中一律隐藏）
  private collapseItems(): { node: Text; x: number; y: number; collapsed: boolean }[] {
    if (!this.root) return [];
    const ltr = this.direction === "right";
    // 拖拽或框选进行中隐藏全部展开态开关，避免与交互反馈叠加
    const busy = this.dragState !== null || this.sel.marqueeActive;
    const out: { node: Text; x: number; y: number; collapsed: boolean }[] = [];
    const walk = (n: Text) => {
      // 隐藏子树整体跳过（折叠时子孙不可见，也不显示其开关）
      if (!n.visible) return;
      if (n.children.length && (n.collapsed || (!busy && this.hoverToggles.has(n)))) {
        const p = n.getWorldPoint();
        out.push({
          node: n,
          x: ltr ? p.x + n.width + TOGGLE_GAP : p.x - TOGGLE_GAP,
          y: p.y + n.height / 2,
          collapsed: n.collapsed,
        });
      }
      n.children.forEach((c) => walk(c as Text));
    };
    walk(this.root);
    return out;
  }

  // 世界坐标命中的折叠开关（留少量点击余量），未命中返回 null
  private hitCollapseToggle(w: { x: number; y: number }): Text | null {
    const slop = 4;
    for (const it of this.collapseItems()) {
      if (Math.hypot(w.x - it.x, w.y - it.y) <= TOGGLE_RADIUS + slop) {
        return it.node;
      }
    }
    return null;
  }

  // 切换折叠：翻转标志后重布局（内部统一联动可见性）；选中态指向被隐藏节点时清空。
  // 展开时鼠标正压在开关上，加入悬浮集合让 − 持续可见（否则松手即隐藏）
  private async toggleCollapse(node: Text) {
    node.collapsed = !node.collapsed;
    if (node.collapsed) this.hoverToggles.delete(node);
    else this.hoverToggles.add(node);
    if ([...this.sel.items].some((s) => !s.visible)) this.deactivate();
    await this.relayout();
    this.emitChange("collapse");
  }

  // 节点到各可见子节点连线构成的覆盖矩形（不含节点自身盒体）：连线（三种 shape 皆然）
  // 始终落在 [节点近端边缘, 子锚点] × [父锚 y, 子锚 y] 的范围内。悬浮节点本体不触发显示，
  // 仅连线区域触发；无可见子节点返回 null（无连线即无区域）
  private toggleHoverRect(n: Text) {
    const ltr = this.direction === "right";
    const p = n.getWorldPoint();
    // 起点为节点近端边缘（悬浮节点本体不算），纵向含父锚 y（连线由此引出）
    let x0 = ltr ? p.x + n.width : p.x;
    let x1 = x0;
    let y0 = p.y + n.height / 2;
    let y1 = y0;
    let has = false;
    n.children.forEach((c) => {
      const t = c as Text;
      if (!t.visible) return;
      const cp = t.getWorldPoint();
      const ax = ltr ? cp.x : cp.x + t.width;
      const ay = cp.y + t.height / 2;
      x0 = Math.min(x0, ax);
      x1 = Math.max(x1, ax);
      y0 = Math.min(y0, ay);
      y1 = Math.max(y1, ay);
      has = true;
    });
    return has ? { x0, y0, x1, y1 } : null;
  }

  // 悬浮命中集合：鼠标压在展开态节点的连线覆盖矩形（不含节点本体，或其开关圆）内即命中，
  // 折叠态不依赖悬浮（+ 常显）；父子区域嵌套时同一点可命中多个节点
  private hoverToggleTargets(w: { x: number; y: number }): Set<Text> {
    const out = new Set<Text>();
    if (!this.root) return out;
    const ltr = this.direction === "right";
    const walk = (n: Text) => {
      if (!n.visible) return;
      if (n.children.length && !n.collapsed) {
        const r = this.toggleHoverRect(n);
        if (r && w.x >= r.x0 && w.x <= r.x1 && w.y >= r.y0 && w.y <= r.y1) {
          out.add(n);
        } else {
          // 矩形外但压在开关圆上（从节点移向开关的过渡区），保持显示
          const p = n.getWorldPoint();
          const cx = ltr ? p.x + n.width + TOGGLE_GAP : p.x - TOGGLE_GAP;
          const cy = p.y + n.height / 2;
          if (Math.hypot(w.x - cx, w.y - cy) <= TOGGLE_RADIUS + 4) out.add(n);
        }
      }
      n.children.forEach((c) => walk(c as Text));
    };
    walk(this.root);
    return out;
  }

  // 批量设置选中（单选/多选统一入口）：
  // 单选进入激活态（常驻覆盖层 + 高亮环，必要时平移视口）；多选仅多目标高亮环，无覆盖层
  private setSelection(nodes: Text[]) {
    if (!nodes.length) {
      this.deactivate();
      return;
    }
    this.sel.set(nodes);
    this.highlight.targets = [...nodes];
    this.highlight.color = ACTIVE_COLOR;
    if (nodes.length === 1) {
      this.editor.start(nodes[0]);
      this.scrollNodeIntoView(nodes[0]);
    } else {
      // 多选态没有编辑框，退出可能残留的单选覆盖层
      this.editor.stop();
    }
    this.app.requestRender();
  }

  // 屏幕坐标转世界坐标（视口逆变换；接受鼠标事件或裸坐标，供 rAF 循环复用）
  private toWorld(pos: { clientX: number; clientY: number }) {
    const rect = this.app.canvas.getBoundingClientRect();
    const vp = this.app.renderer.viewport;
    return {
      x: (pos.clientX - rect.left - vp.x) / vp.scale,
      y: (pos.clientY - rect.top - vp.y) / vp.scale,
    };
  }

  // 左键交互（框选 + 拖拽换父）：
  // 按下命中已选中节点 → 拖拽上下文，超阈值后整组选中子树跟随移动，松手落点有效则换父；
  // 按下空白或未选中节点 → 框选上下文，超阈值显示选框，松手批量激活相交节点；
  // 未超阈值的普通点击不处理，交给节点激活/空白取消逻辑
  private bindMarquee() {
    const canvas = this.app.canvas;
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const w = this.toWorld(e);
      // 折叠开关命中优先于节点拖拽/框选
      const toggle = this.hitCollapseToggle(w);
      if (toggle) {
        void this.toggleCollapse(toggle);
        return;
      }
      const hit = this.hitText(w);
      // 命中已选中节点：进入拖拽（根节点不可拖动，剔除后为空则退回框选）
      if (this.tryStartDrag(e, hit)) return;
      // 未建立拖拽上下文但命中已选中节点（如根节点）：记录按下位置供 mouseup 判定点击进入编辑
      if (hit && this.sel.has(hit)) {
        this.overlayDown = { x: e.clientX, y: e.clientY };
      }
      // 根节点不可拖拽：按下改为经视口能力平移画布，不进入框选
      if (hit === this.root) {
        this.pan?.beginPan(e);
        return;
      }
      // 空白按下：框选会话由选中插件接管（橡皮筋 + 松手落定多选）
      this.sel.beginMarquee(e);
    });
    // 悬浮驱动展开态开关显隐：压在连线覆盖矩形（或其开关圆）内显示 −，离开即隐藏；
    // 集合变化才重绘。激活节点被覆盖层遮住时 canvas 收不到 move，悬浮态保持不闪断
    canvas.addEventListener("mousemove", (e) => {
      const next = this.hoverToggleTargets(this.toWorld(e));
      const cur = this.hoverToggles;
      const same =
        next.size === cur.size && [...next].every((n) => cur.has(n));
      if (!same) {
        this.hoverToggles = next;
        this.app.requestRender();
      }
    });
    canvas.addEventListener("mouseleave", () => {
      if (this.hoverToggles.size) {
        this.hoverToggles.clear();
        this.app.requestRender();
      }
    });
    window.addEventListener("mousemove", (e) => {
      const drag = this.dragState;
      if (drag) {
        // 位移超过阈值才算拖拽，普通点击不触发
        if (
          !this.dragMoved &&
          Math.hypot(
            e.clientX - drag.startScreen.x,
            e.clientY - drag.startScreen.y,
          ) <= 3
        )
          return;
        // 首帧进入拖拽：退出选中态（含覆盖层）、节点本体降透明度形成原位虚影、定格各包围盒
        if (!this.dragMoved) {
          this.dragMoved = true;
          this.deactivate();
          // 原位虚影不用 opacity（多层父级叠加后几乎不可见）：文字转暗色 + 高亮环切虚线暗蓝
          this.dragFills.clear();
          // 高亮环跟随被拖子树：拖拽父节点时其可见子孙同样加虚线环（折叠隐藏的子树
          // 不画环，否则折叠拖拽时会出现幽灵环；拖未选中节点时旧激活环需移除）
          const targets = new Set<Text>();
          const collectTargets = (n: Node) => {
            if (targets.has(n as Text) || !(n as Text).visible) return;
            targets.add(n as Text);
            n.children.forEach(collectTargets);
          };
          drag.nodes.forEach(collectTargets);
          this.highlight.targets = [...targets];
          drag.nodes.forEach((n) => {
            this.dragFills.set(n, n.fill);
            n.fill = "#4b5563";
          });
          this.highlight.dashed = true;
          this.highlight.color = "blue";
          // 合集虚影克隆鼠标按下的节点（框选多个时拖的是按住的那个，而非集合第一个）
          this.dragChip = this.cloneTextStyle(drag.grabNode);
          this.dragChip.opacity = 0.5;
          this.ghost.add(this.dragChip);
        }
        // 节点本体不再跟随移动，由反馈层代替：合集虚影 = 按下节点原始包围盒 + 拖拽位移
        // （虚影/落点计算在 updateDrag，与边缘自动平移共用）
        drag.lastScreen = { clientX: e.clientX, clientY: e.clientY };
        this.updateDrag(e);
      }
    });
    window.addEventListener("mouseup", (e) => {
      const drag = this.dragState;
      if (drag) {
        this.dragState = null;
        // 未超阈值的普通点击：按在唯一激活节点上时进入编辑，其余交给 click 激活流程
        if (!this.dragMoved) {
          this.dragMoved = false;
          if (this.pressOnActive) {
            this.pressOnActive = false;
            this.wake(true, { x: e.clientX, y: e.clientY });
          }
          return;
        }
        this.dragMoved = false;
        this.pressOnActive = false;
        void this.commitDrop(drag.nodes, this.ghost.target);
        return;
      }
      // 按下未建立拖拽上下文的已选中节点（如根节点）：无位移视为点击进入编辑
      const down = this.overlayDown;
      this.overlayDown = null;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 3) {
        this.wake(true, { x: e.clientX, y: e.clientY });
      }
    });
  }

  // 世界坐标命中的最上层文本节点（选框/高亮环等辅助节点不参与命中）
  // exclude 为被拖子树：拖动中鼠标点总是压在被拖节点上，需跳过它们取其下方的真实目标
  private hitText(
    w: { x: number; y: number },
    exclude?: Set<Node>,
  ): Text | null {
    // 先序遍历即渲染序（后绘制在上层），收集全部命中的文本节点后倒序取最上层
    const hits: Text[] = [];
    const walk = (n: Node) => {
      // 拖拽合集虚影是克隆节点，不参与命中；折叠隐藏的节点不可命中
      if (n instanceof DragGhost) return;
      if (n instanceof Text && n.visible) {
        // Node.hitTest 只逆变换自身矩阵，对树内嵌套节点不准；这里用完整世界矩阵换算到局部坐标再判
        const local = n.getWorldTransform().inverse().transformPoint(w);
        if (
          local.x >= 0 &&
          local.x <= n.width &&
          local.y >= 0 &&
          local.y <= n.height
        )
          hits.push(n);
      }
      n.children.forEach(walk);
    };
    this.app.children.forEach(walk);
    for (let i = hits.length - 1; i >= 0; i--) {
      if (!exclude || !exclude.has(hits[i])) return hits[i];
    }
    return null;
  }

  // 克隆节点样式（文本、字体、盒样式等，不含位置与层级），用于拖拽合集的透明虚影
  private cloneTextStyle(src: Text): Text {
    const opts: ConstructorParameters<typeof Text>[0] = {
      text: src.text,
      fill: src.fill,
      stroke: src.stroke,
      lineWidth: src.lineWidth,
      fontSize: src.fontSize,
      fontWeight: src.fontWeight,
      fontFamily: src.fontFamily,
      padding: src.padding,
      lineHeight: src.lineHeight,
      wrap: src.wrap,
      widthRange: src.widthRange
        ? [src.widthRange[0], src.widthRange[1]]
        : undefined,
      boxStyle: { ...src.boxStyle },
    };
    if (!src.autoWidth) opts.width = src.width;
    return new Text(opts);
  }

  // 落点候选判定：不做鼠标悬浮命中，按几何间距——
  // 从左向右布局（direction 'right'）取合集左缘到左侧节点右缘的间距，
  // 从右向左布局（direction 'left'）镜像取合集右缘到右侧节点左缘的间距；
  // 间距在 0..DROP_RANGE 内为候选，多个候选取水平间距最小者（同层节点边缘对齐时间距相同，
  // 退而取与合集中心垂直距离最近者）。被拖子树内的节点不作候选。
  // 垂直命中带是节点的「子树纵向跨度」（自身 + 全部后代的 y 区间并集）而非节点自身：
  // 悬浮在目标纵向范围之外（如一级节点下方的空白区）也能命中它；贴着某个后代悬浮时
  // 后代水平间距更小仍优先，故深处节点不会被祖先抢走
  private dropTarget(
    drag: NonNullable<MindMap["dragState"]>,
    subtree: Set<Node>,
  ): Text | null {
    const f = this.ghost.floatBox;
    if (!f) return null;
    const ltr = this.direction === "right";
    const centerY = f.y + f.h / 2;
    let best: Text | null = null;
    let bestGap = Infinity;
    let bestDy = Infinity;
    // 后序遍历：返回以 n 为根的子树纵向跨度 [minY, maxY]（隐藏子树不参与跨度与候选）
    const walk = (n: Node): [number, number] => {
      if (!n.visible) return [Infinity, -Infinity];
      const p = n.getWorldPoint();
      let minY = p.y;
      let maxY = p.y + n.height;
      n.children.forEach((c) => {
        const [cy0, cy1] = walk(c);
        if (cy0 < minY) minY = cy0;
        if (cy1 > maxY) maxY = cy1;
      });
      if (n instanceof Text && !subtree.has(n)) {
        const vOverlap =
          Math.min(f.y + f.h, maxY) - Math.max(f.y, minY);
        if (vOverlap > 0) {
          const gap = ltr ? f.x - (p.x + n.width) : p.x - (f.x + f.w);
          if (gap >= 0 && gap <= DROP_RANGE) {
            const dy = Math.abs(centerY - (p.y + n.height / 2));
            if (gap < bestGap || (gap === bestGap && dy < bestDy)) {
              best = n;
              bestGap = gap;
              bestDy = dy;
            }
          }
        }
      }
      return [minY, maxY];
    };
    this.app.children.forEach(walk);
    return best;
  }

  // 落点提交：有效目标时把拖动子树顶层节点挂到目标节点下（换父并换线），随后重布局落定；
  // 无有效目标则仅恢复不透明度并重布局（回到原位，相当于取消）
  private async commitDrop(nodes: Text[], target: Text | null) {
    // 拖拽合集垂直中点：决定在目标子节点列表中的插入位置（清空反馈层前先定格）
    const dropY = this.ghost.floatBox
      ? this.ghost.floatBox.y + this.ghost.floatBox.h / 2
      : Infinity;
    // 恢复文字颜色与高亮环样式，清空拖拽反馈层
    this.dragFills.forEach((fill, n) => (n.fill = fill));
    this.dragFills.clear();
    this.highlight.dashed = false;
    this.highlight.color = ACTIVE_COLOR;
    this.ghost.floatBox = null;
    this.ghost.target = null;
    if (this.dragChip) {
      this.ghost.remove(this.dragChip);
      this.dragChip = null;
    }
    const subtree = new Set<Node>();
    const collect = (n: Node) => {
      subtree.add(n);
      n.children.forEach(collect);
    };
    nodes.forEach(collect);
    const parent = target && !subtree.has(target) ? target : null;
    if (parent) {
      // 目标处于折叠态时先展开，避免挂载后的节点被可见性联动隐藏
      if (parent.collapsed) {
        parent.collapsed = false;
        this.applyCollapseVisibility();
      }
      // 同一目标父级插入多个节点时依次后移；基座索引按原子节点位置只算一次
      const insertIndex = new Map<Text, number>();
      // 摘除前定格每个被移动节点的原父级/原位置/原样式与两侧连线，命令据此重放与逆放
      const moves: {
        node: Text;
        oldParent: Text;
        oldIndex: number;
        newIndex: number;
        oldStyle: Style;
        newStyle: Style;
        oldEdge: MindEdge;
        newEdge: MindEdge;
      }[] = [];
      for (const n of nodes) {
        const old = n.parent as Text;
        // 原父级也在被拖子树内（多选时父子同选）：保持原父子结构，跟随父级一起挂载
        if (subtree.has(old)) continue;
        // 基于落点垂直位置插入到目标子节点列表的对应位置，而非一律追加到最后
        let newIndex = insertIndex.get(parent) ?? this.dropIndex(parent, dropY);
        insertIndex.set(parent, newIndex + 1);
        // 同父移动：落点序号按原布局含自身统计，落在原位置之后时需扣掉自身；
        // 扣除后与原位置相同则确实无变化，跳过
        if (old === parent) {
          if (newIndex > old.children.indexOf(n)) newIndex--;
          if (newIndex === old.children.indexOf(n)) continue;
          const edge = this.edges.find(
            (e) => e.fromNode === old && e.toNode === n,
          )!;
          moves.push({
            node: n,
            oldParent: old,
            oldIndex: old.children.indexOf(n),
            newIndex,
            oldStyle: this.nodeStyles.get(n)!,
            newStyle: this.nodeStyles.get(n)!,
            oldEdge: edge,
            newEdge: edge,
          });
          continue;
        }
        // 换父后新级数 = 目标级数 + 1：按新级数默认样式与用户自定义样式合并定格
        // （未配置级数样式时 redo 跳过应用，保持原样，与旧行为一致）
        const newStyle = {
          ...this.levelStyle(this.depthOf(parent) + 1),
          ...this.customStyles.get(n),
        };
        const oldEdge = this.edges.find(
          (e) => e.fromNode === old && e.toNode === n,
        )!;
        moves.push({
          node: n,
          oldParent: old,
          oldIndex: old.children.indexOf(n),
          newIndex,
          oldStyle: this.nodeStyles.get(n)!,
          newStyle,
          oldEdge,
          newEdge: this.createEdge(parent, n),
        });
      }
      // 移动命令：多选目标合并为一条，undo 一次全回退（逆序插回，防同父索引失效）
      const cmd: HistoryCommand = {
        type: "move",
        redo: () => {
          for (const m of moves) {
            m.oldParent.remove(m.node);
            parent.children.splice(m.newIndex, 0, m.node);
            m.node.parent = parent;
            // 换线：移除旧父连线，加入新父连线
            this.edges = this.edges.filter((e) => e !== m.oldEdge);
            const i = this.app.children.indexOf(m.oldEdge);
            if (i !== -1) this.app.children.splice(i, 1);
            this.edges.push(m.newEdge);
            this.app.add(m.newEdge);
            if (this.levelStyles.length)
              this.applyNodeStyle(m.node, m.newStyle);
          }
        },
        undo: () => {
          for (const m of [...moves].reverse()) {
            parent.remove(m.node);
            m.oldParent.children.splice(m.oldIndex, 0, m.node);
            m.node.parent = m.oldParent;
            // 换线反向：移除新父连线，还原旧父连线
            this.edges = this.edges.filter((e) => e !== m.newEdge);
            const i = this.app.children.indexOf(m.newEdge);
            if (i !== -1) this.app.children.splice(i, 1);
            this.edges.push(m.oldEdge);
            this.app.add(m.oldEdge);
            this.applyNodeStyle(m.node, m.oldStyle);
          }
        },
      };
      this.history.exec(cmd);
    }
    await this.relayout();
    if (parent) this.emitChange("move");
    // 拖拽后保持选中：单选回到激活态（覆盖层），多选保持批量选中
    this.setSelection(nodes);
  }

  // 落点插入位置：按拖拽合集垂直中点与目标现有子节点的垂直中点比较，
  // 返回应插入的序号（子节点垂直堆叠，中点在其上方的都排在前面；无落点信息时兜底追加到末尾）
  private dropIndex(parent: Text, dropY: number): number {
    let index = 0;
    for (const child of parent.children) {
      const c = child as Text;
      // 折叠隐藏的子节点不占位统计
      if (!c.visible) continue;
      if (c.getWorldPoint().y + c.height / 2 < dropY) index++;
    }
    return index;
  }

  // 收集世界矩形相交的全部文本节点（相交即选中，含部分压线的节点）
  private textsInRect(rect: { x: number; y: number; width: number; height: number }): Text[] {
    if (!this.root) return [];
    const left = rect.x;
    const right = rect.x + rect.width;
    const top = rect.y;
    const bottom = rect.y + rect.height;
    const out: Text[] = [];
    this.collectTexts(this.root, out);
    return out.filter((n) => {
      // 折叠隐藏的节点不参与框选
      if (!n.visible) return false;
      const p = n.getWorldPoint();
      return (
        p.x < right &&
        p.x + n.width > left &&
        p.y < bottom &&
        p.y + n.height > top
      );
    });
  }

  // 按编辑状态切换高亮环颜色并重绘（激活蓝色 / 编辑紫色）
  private setHighlightEditing(editing: boolean) {
    this.highlight.color = editing ? EDITING_COLOR : ACTIVE_COLOR;
    this.app.requestRender();
  }

  // 激活节点越出屏幕时平移视口（编辑由 editor.start 自带滚动，此处仅覆盖键盘导航）
  private scrollNodeIntoView(text: Text) {
    const vp = this.app.renderer.viewport;
    const p = text.getWorldPoint();
    const sx = p.x * vp.scale + vp.x;
    const sy = p.y * vp.scale + vp.y;
    const right = sx + text.width * vp.scale;
    const bottom = sy + text.height * vp.scale;
    const dx =
      sx < 20
        ? 20 - sx
        : right > window.innerWidth - 20
          ? window.innerWidth - 20 - right
          : 0;
    const dy =
      sy < 20
        ? 20 - sy
        : bottom > window.innerHeight - 20
          ? window.innerHeight - 20 - bottom
          : 0;
    if (dx === 0 && dy === 0) return;
    this.app.renderer.setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy });
    this.app.requestRender();
  }

  // 全局按键（覆盖层常驻可编辑、持有焦点时由其自身两态机处理）：
  // 覆盖层失焦时重新聚焦交还输入（不吞键），方向键导航，Tab/Enter 新建节点
  private onGlobalKeydown = (e: KeyboardEvent) => {
    // 覆盖层持焦时普通按键由其 keydown 处理器接管；修饰键组合（Ctrl/Cmd/Alt，
    // 复制/粘贴/撤销等）仍走全局处理——否则激活态覆盖层会把 Ctrl+C 的 "c" 当可打印
    // 字符唤醒编辑态。编辑态下撤销/复制交给输入框原生行为，组合键一律不拦
    if (
      this.editor.hasFocus() &&
      (this.editing || !(e.ctrlKey || e.metaKey || e.altKey))
    ) {
      return;
    }
    // 仅响应画布、页面空白处的按键（覆盖层持焦放行的修饰键组合除外），页面其它控件输入不受影响
    const target = e.target as HTMLElement;
    if (
      !this.editor.hasFocus() &&
      target !== document.body &&
      target !== this.app.canvas
    ) {
      return;
    }
    // 撤销/重做快捷键：仅非编辑态响应（编辑态内撤销由输入框原生行为处理）；
    // 需在下方修饰键直接放行之前判定。Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做
    if (!this.editing && (e.ctrlKey || e.metaKey)) {
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) void this.redo();
        else void this.undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        void this.redo();
        return;
      }
      // Ctrl/Cmd+C 复制选中节点（多选可整组复制），Ctrl/Cmd+V 粘贴（仅单选激活时生效）；
      // 编辑态不拦截，覆盖层内粘贴走原生文本粘贴
      if (key === "c") {
        e.preventDefault();
        this.copySelection();
        return;
      }
      if (key === "v") {
        e.preventDefault();
        void this.pasteClipboard();
        return;
      }
    }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      if (this.active) void this.createRelated(e, this.active);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void this.deleteSelection();
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      this.navigate(e.key);
      return;
    }
    // 打字或 IME 组合：唤醒编辑态并聚焦常驻覆盖层，默认输入/组合直接落在其上（不吞键，IME 首字符不丢）
    if (
      (e.key.length === 1 || e.keyCode === 229 || e.key === "Process") &&
      this.active
    ) {
      this.wake();
    }
  };

  // 方向键导航：上下在整棵树内按视觉位置选垂直方向最近的节点（可跨分支），左右按布局方向进入首子节点或回父节点
  // 多选时以选集左上角节点为锚点，先收敛为单选再导航（Tab/Enter 在多选下不生效，见 onGlobalKeydown）
  private navigate(key: string) {
    if (!this.root) return;
    if (!this.sel.items.length) {
      this.activate(this.root);
      return;
    }
    const current = this.active ?? this.topLeftSelection();
    if (!this.active) this.activate(current);
    if (key === "ArrowUp" || key === "ArrowDown") {
      this.navigateVertical(key, current);
      return;
    }
    const parent = current.parent as Text | null;
    // direction 'right' 子节点在右侧：Right 进入首子节点，Left 回父节点；direction 'left' 相反
    const toChild =
      this.direction === "right" ? key === "ArrowRight" : key === "ArrowLeft";
    if (toChild) {
      if (!current.children.length) return;
      // 折叠节点进入首子节点前先展开
      if (current.collapsed) void this.toggleCollapse(current);
      this.activate(current.children[0] as Text);
    } else if (parent) {
      this.activate(parent);
    }
  }

  // 选集中最靠左上角的节点：先取最上（y 最小，0.5 容差抗浮点误差），同高取最左（x 最小）
  private topLeftSelection(): Text {
    return [...this.sel.items].reduce((best, n) => {
      const bp = best.getWorldPoint();
      const np = n.getWorldPoint();
      if (np.y < bp.y - 0.5) return n;
      if (np.y <= bp.y + 0.5 && np.x < bp.x) return n;
      return best;
    });
  }

  // 垂直导航：↑↓ 选择上/下方最近的可导航节点 —— 先取水平区间重叠者（正上/正下），
  // 无重叠时再取斜向矩形间距最近者（斜上/斜下），←→ 仍负责层级移动
  private navigateVertical(key: "ArrowUp" | "ArrowDown", current: Text) {
    const cp = current.getWorldPoint();
    const cur = {
      left: cp.x,
      right: cp.x + current.width,
      cy: cp.y + current.height / 2,
    };
    const below = key === "ArrowDown";
    const all: Text[] = [];
    this.collectTexts(this.root!, all);
    const cands = all.filter((n) => {
      // 折叠隐藏的节点不参与导航
      if (!n.visible) return false;
      if (n === current) return false;
      const p = n.getWorldPoint();
      const cy = p.y + n.height / 2;
      return below ? cy > cur.cy + 0.5 : cy < cur.cy - 0.5;
    });
    if (!cands.length) return;
    // 世界包围盒与垂直距离工具
    const rect = (n: Text) => {
      const p = n.getWorldPoint();
      return { left: p.x, right: p.x + n.width, cy: p.y + n.height / 2 };
    };
    const distY = (n: Text) => Math.abs(rect(n).cy - cur.cy);
    let best: Text | null = null;
    let bestScore = Infinity;
    // 第一优先：水平区间与当前节点重叠（正上/正下），垂直距离最近者
    for (const n of cands) {
      const r = rect(n);
      if (r.left < cur.right && r.right > cur.left && distY(n) < bestScore) {
        bestScore = distY(n);
        best = n;
      }
    }
    // 第二优先：斜上/斜下，按 水平间距 + 垂直距离 度量取最近（列相邻性优先于微小的高度差）
    if (best === null) {
      for (const n of cands) {
        const r = rect(n);
        const dx = Math.max(0, cur.left - r.right, r.left - cur.right);
        const d = dx + distY(n);
        if (d < bestScore) {
          bestScore = d;
          best = n;
        }
      }
    }
    if (best) this.activate(best);
  }

  // 递归收集子树内全部文本节点（元函数：被 navigateVertical 调用）
  private collectTexts(node: Text, out: Text[]) {
    out.push(node);
    node.children.forEach((child) => this.collectTexts(child as Text, out));
  }

  // 异步初始化：构造节点树 → 折叠可见性联动 → 布局 → fit 视口 → 挂载节点与连线（元函数组装）
  private async init(data: MindMapNode) {
    const root = this.renderNode(data);
    this.root = root;
    // 数据可携带折叠态：布局前先按折叠标志联动可见性（布局器跳过折叠子树）
    this.applyCollapseVisibility();
    await layout(root, {
      direction: this.direction,
      levelGap: 80,
      siblingGap: 20,
    });
    this.pan!.fit(this.getBounds(root));
    this.app.add(root);
    // 收集所有父子连线并追加到根节点之后，保证连线绘制在节点上层
    this.collectEdges(root, this.edges);
    this.app.add(this.edges);
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
      const i = this.app.children.indexOf(n);
      if (i !== -1) this.app.children.splice(i, 1);
      this.app.add(n);
    }
  }

  // 文本输入后按新尺寸重新布局并渲染（元函数组装：重排 + 渲染）
  private async relayout() {
    if (!this.root || !this.pan) return;
    // 折叠可见性联动（undo/redo 换父、拖入折叠节点等路径统一收口于此）
    this.applyCollapseVisibility();
    // 新连线可能追加到了覆盖层之上，先归位再渲染
    this.raiseOverlays();
    await layout(this.root, {
      direction: this.direction,
      levelGap: 80,
      siblingGap: 20,
    });
    this.app.requestRender();
    // 布局会移动节点，编辑框必须在对齐一次，否则覆盖在旧位置上
    this.editor.reposition();
  }

  // 编辑框按键两态机（飞书模型）——以 this.editing 为唯一状态来源（覆盖层常驻，blur/唤醒随时切换显隐）：
  // 激活态（editing=false，覆盖层隐藏、文字由 canvas 渲染）：方向键拦截并切换节点；打字/IME/点击唤醒编辑态交还默认行为
  // 编辑态（editing=true，覆盖层接管文字渲染）：方向键移动光标；Tab 建子节点；Enter/Escape 提交（切回激活态视觉）
  private bindNodeKeys(el: HTMLDivElement, text: Text) {
    el.addEventListener("keydown", (e) => {
      const passive = !this.editing;
      if (passive && e.key.startsWith("Arrow")) {
        // 激活态方向键：接管为节点导航（覆盖层随 activate 转移到新节点）
        e.preventDefault();
        this.navigate(e.key);
        return;
      }
      if (passive && e.key === "Escape") {
        e.preventDefault();
        this.editor.hide();
        return;
      }
      if (passive && e.key === "Enter") {
        // 激活态回车：新建兄弟节点（编辑态回车才是提交）
        e.preventDefault();
        void this.createRelated(e, text);
        return;
      }
      if (passive && (e.key === "Delete" || e.key === "Backspace")) {
        // 激活态删除：删掉选中集合（单选即当前节点）及其子树（编辑态下删除键交给默认文本删除）
        e.preventDefault();
        void this.deleteSelection();
        return;
      }
      // 修饰键组合（Ctrl/Cmd/Alt 系统快捷键，如复制/粘贴/撤销）：不唤醒编辑态，
      // 放行冒泡给全局按键处理器；编辑态下本分支不触发，交给输入框原生行为
      if (passive && (e.ctrlKey || e.metaKey || e.altKey)) return;
      // 可打印字符或 IME 组合键：仅唤醒为编辑态（覆盖层接管文字渲染），不吞键 ——
      // 打字/组合直接落入空覆盖层，经 input 同步替换节点文本
      if (
        passive &&
        (e.key.length === 1 || e.key === "Process" || e.keyCode === 229)
      ) {
        this.wake();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        // 覆盖层常驻：节点切换由 activate → editor.start 完成卸载重建，无需先失焦
        void this.createRelated(e, text);
      } else if (e.key === "Enter" || e.key === "Escape") {
        // 阻止换行，提交 = 切回激活态（覆盖层隐藏并保持挂载可编辑，IME 不被打断），高亮环切回蓝色
        e.preventDefault();
        this.editor.hide();
        this.editing = false;
        this.setHighlightEditing(false);
      }
    });
    // 打字/组合：空覆盖层唤醒（输入替换节点文本）；右键菜单粘贴不经过 keydown，
    // 由覆盖层的 paste 监听先行显示（本处 input 唤醒补齐编辑态状态）；左键按下：与画布按下共用拖拽上下文，
    // 未超阈值松手（mouseup 统一判定）才视为点击进入编辑，避免拖拽激活节点时误触发编辑
    el.addEventListener("input", () => this.wake());
    el.addEventListener("compositionstart", () => this.wake());
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        // 非左键（如右键菜单粘贴前）保持原行为：立即唤醒
        this.wake(true);
        return;
      }
      // 覆盖层恰好盖住激活节点：命中即它本身；根节点不可拖时仅记录按下位置供 mouseup 判定点击
      if (!this.tryStartDrag(e, this.hitText(this.toWorld(e)))) {
        this.overlayDown = { x: e.clientX, y: e.clientY };
      }
    });
  }

  // Tab 创建子节点、Enter 在当前节点下方创建兄弟节点，随后进入编辑并重布局
  // （编辑态由 bindNodeKeys 调用，激活态由 onGlobalKeydown 以合成事件调用）
  private async createRelated(e: KeyboardEvent, text: Text) {
    console.log("[MindMap] createRelated", e.key, "from:", text.text);
    const isChild = e.key === "Tab";
    // 根节点回车（无父级可建兄弟节点）忽略，不创建任何节点
    if (!isChild && !text.parent) return;
    const parent = isChild ? text : ((text.parent as Text | null) ?? text);
    // 目标父级处于折叠态时先展开，避免新建节点被可见性联动隐藏
    if (parent.collapsed) {
      parent.collapsed = false;
      this.applyCollapseVisibility();
    }
    // 新节点按级数取样式：Tab 建子节点深度 +1，Enter 建兄弟节点深度不变
    const style = this.newNodeStyle(
      text,
      this.depthOf(text) + (isChild ? 1 : 0),
    );
    // 插入位置在构造命令前定格：Tab 建子追加到末尾，Enter 建兄弟插在当前节点之后
    // （统一走 index splice，undo/redo 重放同一位置，不依赖创建时的树状态）
    const index = isChild
      ? parent.children.length
      : parent.children.indexOf(text) + 1;
    const node = this.createNode(text, style);
    this.nodeStyles.set(node, style);
    const edge = this.createEdge(parent, node);
    // 新增节点命令：redo/undo 对称地增删子节点与连线
    const cmd: HistoryCommand = {
      type: "add",
      redo: () => {
        parent.children.splice(index, 0, node);
        node.parent = parent;
        this.app.add(edge);
        this.edges.push(edge);
      },
      undo: () => {
        const i = parent.children.indexOf(node);
        if (i !== -1) parent.children.splice(i, 1);
        node.parent = null;
        this.edges = this.edges.filter((edge2) => edge2 !== edge);
        const ci = this.app.children.indexOf(edge);
        if (ci !== -1) this.app.children.splice(ci, 1);
      },
    };
    this.history.exec(cmd);
    this.editor.bind(node);
    await this.relayout();
    // 新节点进入激活态（常驻覆盖层，打字即编辑）
    this.activate(node);
    this.emitChange("add");
  }

  // 删除选中节点（单选/多选统一走 selection）及其整个子树（根节点不可删除）：
  // 摘除各子树、清理关联连线，重布局后激活第一个被删节点的存活父级（均被删时退化为根节点）
  private async deleteSelection() {
    if (!this.root) return;
    const targets = [...this.sel.items].filter((n) => n !== this.root);
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
    const dead = this.edges.filter(
      (e) => subtree.has(e.fromNode) || subtree.has(e.toNode),
    );
    // 删除命令：多选目标合并为一条，undo 一次全回退
    const cmd: HistoryCommand = {
      type: "delete",
      redo: () => {
        captures.forEach(({ node, parent }) => parent.remove(node));
        this.edges = this.edges.filter((e) => !dead.includes(e));
        dead.forEach((e) => {
          const i = this.app.children.indexOf(e);
          if (i !== -1) this.app.children.splice(i, 1);
        });
      },
      undo: () => {
        // 逆序插回：同父多目标按索引从大到小还原，前序插入不影响后序索引
        for (let i = captures.length - 1; i >= 0; i--) {
          const { node, parent, index } = captures[i];
          parent.children.splice(index, 0, node);
          node.parent = parent;
        }
        dead.forEach((e) => {
          this.edges.push(e);
          this.app.add(e);
        });
      },
    };
    this.history.exec(cmd);
    // 清空选中态，重布局后激活存活的父节点（activate 会重建覆盖层，旧覆盖层随之卸载）
    this.deactivate();
    await this.relayout();
    this.activate(
      captures.map((c) => c.parent).find((p) => !subtree.has(p)) ?? this.root,
    );
    this.emitChange("delete");
  }

  // 复制选中节点：把各选中节点的子树序列化入剪贴板缓冲（多选可整组复制）。
  // 沿祖先链过滤只留最顶层节点——子孙会随祖先子树整体序列化，若重复入队
  // （选中 a、b、c 且 a→b→c），粘贴时同一分支会被添加两份
  private copySelection() {
    if (!this.sel.items.length) return;
    const roots = [...this.sel.items].filter((n) => {
      let p = n.parent as Text | null;
      while (p) {
        if (this.sel.has(p)) return false;
        p = p.parent as Text | null;
      }
      return true;
    });
    this.clipboard = roots.map((n) => this.serializeNode(n));
  }

  // 粘贴剪贴板：仅单选激活时执行（多选/无选中不粘贴）——复制的子树按序追加为激活节点
  // 的子节点（追加在其子级末尾），样式按级数解析；随后激活最后一个粘贴节点并重布局，
  // 整次粘贴记为一条可撤销的 add 命令
  private async pasteClipboard() {
    if (!this.clipboard?.length || !this.root) return;
    const anchor = this.active;
    if (!anchor) return;
    // 目标父级即激活节点，处于折叠态时先展开，避免粘贴节点被可见性联动隐藏
    const parent = anchor;
    if (parent.collapsed) {
      parent.collapsed = false;
      this.applyCollapseVisibility();
    }
    // 插入位置在构造命令前定格：追加到子级末尾（统一走 index splice，
    // undo/redo 重放同一索引，不依赖粘贴时的树状态）
    const index = parent.children.length;
    // 新节点级数 = 激活节点级数 + 1（按级数解析样式）；renderNode 递归还原子孙
    // 与自定义样式/折叠态，子树内部连线在命令外定格创建
    // （redo/undo 只做挂载/摘除，重复创建会导致连线翻倍且撤销残留）
    const depth = this.depthOf(parent) + 1;
    const inserts = this.clipboard.map((data, i) => {
      const node = this.renderNode(data, depth);
      const inner: MindEdge[] = [];
      this.collectEdges(node, inner);
      const edge = this.createEdge(parent, node);
      return { parent, node, edge, inner, index: index + i };
    });
    // 粘贴命令：redo/undo 对称地增删子树节点、父子连线与子树内部连线
    const cmd: HistoryCommand = {
      type: "add",
      redo: () => {
        inserts.forEach(({ parent: p, node, edge, inner, index: idx }) => {
          p.children.splice(idx, 0, node);
          node.parent = p;
          this.app.add(edge);
          this.app.add(inner);
          this.edges.push(edge, ...inner);
        });
      },
      undo: () => {
        // 逆序摘除：前序摘除不影响后序兄弟索引
        for (let i = inserts.length - 1; i >= 0; i--) {
          const { parent: p, node, edge, inner } = inserts[i];
          const ci = p.children.indexOf(node);
          if (ci !== -1) p.children.splice(ci, 1);
          node.parent = null;
          const removed = [edge, ...inner];
          this.edges = this.edges.filter((e) => !removed.includes(e));
          removed.forEach((e2) => {
            const ai = this.app.children.indexOf(e2);
            if (ai !== -1) this.app.children.splice(ai, 1);
          });
        }
      },
    };
    this.history.exec(cmd);
    // 为粘贴子树绑定点击激活（app.add 包装只覆盖经它挂载的节点，splice 挂载的需手动绑定）
    inserts.forEach(({ node }) => this.editor.bind(node));
    await this.relayout();
    // 最后一个粘贴节点进入激活态（常驻覆盖层，打字即编辑）
    this.activate(inserts[inserts.length - 1].node);
    this.emitChange("add");
  }

  // 节点在树中的级数（根节点为 0），由 parent 链向上回溯
  private depthOf(node: Text): number {
    let depth = 0;
    let p = node.parent as Text | null;
    while (p) {
      depth++;
      p = p.parent as Text | null;
    }
    return depth;
  }

  // 新节点样式解析：配置了级数样式按级数取值，否则沿用参考节点的实际样式（旧行为）
  private newNodeStyle(ref: Text, depth: number): Style {
    if (this.levelStyles.length) return this.levelStyle(depth);
    return this.nodeStyles.get(ref) ?? defaultStyle;
  }

  // 按解析出的样式创建默认新节点，宽度范围与参考节点保持一致（元函数：样式构造）
  private createNode(ref: Text, style: Style): Text {
    return this.createText("新节点", style, ref.widthRange ?? [0, 200]);
  }

  // 递归收集所有父子连线（每条边绑定父子节点，元函数：被构造时调用）
  private collectEdges(node: Text, edges: MindEdge[]) {
    node.children.forEach((child) => {
      const c = child as Text;
      edges.push(this.createEdge(node, c));
      this.collectEdges(c, edges);
    });
  }

  // 递归遍历子树，把每个可见节点的世界包围盒并入总范围（元函数：被 getBounds 调用；
  // 世界变换数学由 Core 的 Node.getBounds 契约提供）
  private collectBounds(
    node: Text,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
  ) {
    const b = node.getBounds();
    bounds.minX = Math.min(bounds.minX, b.minX);
    bounds.minY = Math.min(bounds.minY, b.minY);
    bounds.maxX = Math.max(bounds.maxX, b.maxX);
    bounds.maxY = Math.max(bounds.maxY, b.maxY);
    // 折叠隐藏的子树不并入包围盒（fit 视口与图片导出只覆盖可见部分）
    node.children.forEach((child) => {
      if ((child as Text).visible) this.collectBounds(child as Text, bounds);
    });
  }

  // 计算整棵树的世界包围盒（从无穷大范围开始递归收拢）
  private getBounds(root: Text) {
    const bounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    this.collectBounds(root, bounds);
    return bounds;
  }

  // 第一次递归：把数据节点转成 Text 节点树（x/y 留空，由布局器统一确定）
  // 样式解析优先级：节点数据 style > levelStyles[depth]（超出配置长度套用最后一项）> 兜底样式
  renderNode(data: MindMapNode, depth = 0): Text {
    const style = data.style ?? this.levelStyle(depth);
    const text = this.createText(data.text, style);
    text.collapsed = data.collapsed ?? false;
    this.nodeStyles.set(text, style);
    if (data.style) this.customStyles.set(text, data.style);
    // 递归调用自身，将每个子数据转成子节点并挂到当前节点下
    data.children.forEach((child) =>
      text.add(this.renderNode(child, depth + 1)),
    );
    return text;
  }

  // 按级数取样式配置，超出配置长度时套用最后一项，未配置时兜底
  private levelStyle(depth: number): Style {
    if (!this.levelStyles.length) return defaultStyle;
    return this.levelStyles[Math.min(depth, this.levelStyles.length - 1)];
  }

  // 将样式应用到已有节点（换父后级数变化时重设外观），同步刷新级数样式缓存并重测尺寸
  private applyNodeStyle(text: Text, style: Style) {
    text.fontSize = style.fontSize;
    text.fontWeight = style.fontWeight;
    text.fill = style.color;
    text.fontFamily = style.fontFamily;
    text.padding = style.padding;
    text.lineHeight = style.lineHeight;
    text.boxStyle = {
      fill: style.backgroundColor,
      stroke: style.borderColor,
      lineWidth: style.borderWidth,
      radius: style.radius,
    };
    this.nodeStyles.set(text, style);
    text.measure();
  }

  // 由样式配置构造 Text 节点（renderNode 与新建节点共用，保证两处映射一致）
  private createText(
    text: string,
    style: Style,
    widthRange?: [number, number],
  ): Text {
    return new Text({
      x: 0,
      y: 0,
      wrap: true,
      widthRange: widthRange ?? [0, 200],
      text,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fill: style.color,
      fontFamily: style.fontFamily,
      padding: style.padding,
      lineHeight: style.lineHeight,
      boxStyle: {
        fill: style.backgroundColor,
        stroke: style.borderColor,
        lineWidth: style.borderWidth,
        radius: style.radius,
      },
    });
  }
}
