import { App, Text } from "@silker/core";
import type { Node } from "@silker/core";
import { Viewport } from "@silker/plugin-viewport";
import { TextEditor } from "@silker/plugin-text-editor";
import { layout } from "./layout";
import { MindMapEdge } from "./Edge";
import { ActiveHighlight } from "./ActiveHighlight";
import { Marquee } from "./Marquee";
import { DragGhost } from "./DragGhost";

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
}

export type LayoutDirection = NonNullable<MindMapOptions["direction"]>;

// 高亮环两态颜色：激活（未编辑）蓝色，编辑紫色
const ACTIVE_COLOR = "#3b82f6";
const EDITING_COLOR = "#a855f7";

// 落点判定间距上限（世界坐标）：合集左缘与左侧节点右缘间距在 0..DROP_RANGE 内视为候选（后期可能需要调整）
const DROP_RANGE = 500;

export class MindMap {
  app: App;
  private root: Text | null = null;
  private viewport: Viewport | null = null;
  private editor: TextEditor;
  private edges: MindMapEdge[] = [];
  private direction: LayoutDirection;
  // 级数样式配置（index 0 为根节点），renderNode 与新建节点按级数取值
  private levelStyles: Style[];
  // 每个节点创建时实际使用的样式，供无级数配置时新建节点沿用参考节点样式
  private nodeStyles = new WeakMap<Text, Style>();
  private highlight: ActiveHighlight;
  // 选中状态（唯一数据源）：size===1 为单选激活态——常驻覆盖层（passive：空覆盖层、
  // 文字由 canvas 渲染，视觉零抖动），打字唤醒为编辑态（输入替换节点文本），点击唤醒则填入文本正常编辑；
  // size>1 为多选（无覆盖层，Tab/Enter/打字唤醒不生效，方向键以选集左上角节点为锚点）
  private selection = new Set<Text>();
  // 单选派生：多选或无选中时为 null（Tab/Enter、打字唤醒仅单选生效）
  private get active(): Text | null {
    return this.selection.size === 1
      ? ([...this.selection][0] as Text)
      : null;
  }
  private marquee: Marquee;
  // 左键按下状态：屏幕坐标用于位移阈值判断，世界坐标作为选框起点
  private marqueeDown: {
    sx: number;
    sy: number;
    wx: number;
    wy: number;
  } | null = null;
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

  constructor(options: MindMapOptions) {
    this.direction = options.direction ?? "left";
    this.levelStyles = options.levelStyles ?? [];
    this.app = new App(options.canvas);
    // 安装视口插件：支持滚轮以鼠标为中心缩放、拖拽平移画布与按包围盒拟合视口
    this.viewport = new Viewport();
    this.app.use(this.viewport);
    // 安装文本编辑插件：输入时重新布局，编辑框就绪后直接监听按键新建节点（包装 add 自动绑定后续节点）
    this.editor = new TextEditor({
      onInput: () => this.relayout(),
      onEditStart: (el, text) => this.bindNodeKeys(el, text),
      // 点击仅激活（常驻覆盖层 + 画布高亮环），进入编辑由打字或点击覆盖层触发
      onActivate: (text) => this.activate(text),
      // 失焦切回激活态视觉时同步高亮环颜色
      onEditEnd: () => this.setHighlightEditing(false),
    });
    this.app.use(this.editor);
    // 激活高亮环挂载在最上层（init 中节点与连线加入后再 add）
    this.highlight = new ActiveHighlight(
      () => this.app.renderer.viewport.scale,
    );
    // 框选矩形（init 中最后 add，绘制在一切之上）
    this.marquee = new Marquee(() => this.app.renderer.viewport.scale);
    // 拖拽反馈层（绘制在高亮环之上）；从右向左布局时落点连线锚点左右互换
    this.ghost = new DragGhost(() => this.app.renderer.viewport.scale);
    this.ghost.mirror = this.direction === "left";
    // 左键框选与节点拖拽
    this.bindMarquee();
    // 激活态键盘导航：方向键切换节点、Tab/Enter 新建、打字进入编辑（编辑态由编辑框自身处理按键）
    document.addEventListener("keydown", this.onGlobalKeydown);
    // 点击画布空白处取消激活态（拖拽平移不触发）
    this.app.onBlankClick = () => this.deactivate();
    // 异步初始化：先布局再挂载渲染（构造函数无法 await，内部顺序保证）
    void this.init(options.data);
  }

  // 单选激活（覆盖层 + 高亮环 + 视口跟随），语义化入口
  private activate(text: Text) {
    // 覆盖层激活态沉底后点击会穿透到画布：唤醒编辑（mouseup）后的同节点 click 不再重复激活，
    // 避免重建覆盖层打断刚进入的编辑
    if (text === this.active && this.editor.isEditing && this.editor.hasFocus())
      return;
    this.setSelection([text]);
  }

  // 点击进入编辑（按下未拖动的 mouseup）：填入节点文本、唤醒编辑态，并把光标定位到点击处
  private wakeEditing(e?: MouseEvent) {
    this.editor.beginEdit(
      true,
      e ? { x: e.clientX, y: e.clientY } : undefined,
    );
    this.setHighlightEditing(true);
  }

  // 命中已选中节点时建立拖拽上下文（画布按下与覆盖层按下共用），未命中或不可拖返回 false
  private tryStartDrag(e: MouseEvent, hit: Text | null): boolean {
    if (!hit || !this.selection.has(hit)) return false;
    const nodes = [...this.selection].filter((n) => n !== this.root);
    if (!nodes.length) return false;
    const hitP = hit.getWorldPoint();
    this.dragState = {
      startScreen: { x: e.clientX, y: e.clientY },
      startWorld: this.toWorld(e),
      nodes,
      origins: nodes.map((n) => ({ x: n.x, y: n.y })),
      grabNode: hit,
      grabBox: { x: hitP.x, y: hitP.y, w: hit.width, h: hit.height },
    };
    this.dragMoved = false;
    // 覆盖层激活态沉底（opacity 0 + z-index -1），按下必落在画布：单选即按在唯一激活节点上，
    // 未超阈值松手视为点击进入编辑（多选无覆盖层，点击走 click 激活流程收敛为单选）
    this.pressOnActive = this.selection.size === 1;
    return true;
  }

  // 取消激活：清空选中集合与高亮环，移除常驻覆盖层（文字交还 canvas 渲染）
  private deactivate() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.highlight.targets = [];
    this.editor.deactivate();
    this.app.render();
  }

  // 批量设置选中（单选/多选统一入口）：
  // 单选进入激活态（常驻覆盖层 + 高亮环，必要时平移视口）；多选仅多目标高亮环，无覆盖层
  private setSelection(nodes: Text[]) {
    if (!nodes.length) {
      this.deactivate();
      return;
    }
    this.selection = new Set(nodes);
    this.highlight.targets = nodes;
    this.highlight.color = ACTIVE_COLOR;
    if (nodes.length === 1) {
      this.editor.start(nodes[0], { passive: true });
      this.scrollNodeIntoView(nodes[0]);
    } else {
      // 多选态没有编辑框，退出可能残留的单选覆盖层
      this.editor.deactivate();
    }
    this.app.render();
  }

  // 屏幕坐标转世界坐标（视口逆变换）
  private toWorld(e: MouseEvent) {
    const rect = this.app.canvas.getBoundingClientRect();
    const vp = this.app.renderer.viewport;
    return {
      x: (e.clientX - rect.left - vp.x) / vp.scale,
      y: (e.clientY - rect.top - vp.y) / vp.scale,
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
      const hit = this.hitText(w);
      // 命中已选中节点：进入拖拽（根节点不可拖动，剔除后为空则退回框选）
      if (this.tryStartDrag(e, hit)) return;
      // 未建立拖拽上下文但命中已选中节点（如根节点）：记录按下位置供 mouseup 判定点击进入编辑
      if (hit && this.selection.has(hit)) {
        this.overlayDown = { x: e.clientX, y: e.clientY };
      }
      this.marqueeDown = { sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y };
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
          if (this.selection.size) {
            this.selection.clear();
            this.editor.deactivate();
          }
          // 原位虚影不用 opacity（多层父级叠加后几乎不可见）：文字转暗色 + 高亮环切虚线暗蓝
          this.dragFills.clear();
          drag.nodes.forEach((n) => {
            this.dragFills.set(n, n.fill);
            n.fill = "#4b5563";
          });
          this.highlight.dashed = true;
          this.highlight.color = "#c1cfffff";
          // 合集虚影克隆鼠标按下的节点（框选多个时拖的是按住的那个，而非集合第一个）
          this.dragChip = this.cloneTextStyle(drag.grabNode);
          this.dragChip.opacity = 0.5;
          this.ghost.add(this.dragChip);
        }
        // 节点本体不再跟随移动，由反馈层代替：合集虚影 = 按下节点原始包围盒 + 拖拽位移
        const cur = this.toWorld(e);
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
        this.app.render();
        return;
      }
      const down = this.marqueeDown;
      if (!down) return;
      // 位移超过阈值才进入框选，普通点击不画框
      if (
        !this.marquee.start &&
        Math.hypot(e.clientX - down.sx, e.clientY - down.sy) <= 3
      )
        return;
      this.marquee.start = { x: down.wx, y: down.wy };
      this.marquee.end = this.toWorld(e);
      // 进入框选即退出选中态（覆盖层交还 canvas，多选态无编辑框），仅首帧执行一次
      if (this.selection.size) {
        this.selection.clear();
        this.editor.deactivate();
      }
      // 拖动过程中实时应用激活样式：当前与选框相交的节点立刻高亮
      this.highlight.targets = this.textsInRect(
        this.marquee.start,
        this.marquee.end,
      );
      this.app.render();
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
            this.wakeEditing(e);
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
      if (
        down &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 3
      ) {
        this.wakeEditing(e);
      }
      const marquee = this.marqueeDown;
      this.marqueeDown = null;
      if (!marquee || !this.marquee.start || !this.marquee.end) return;
      const { start, end } = this.marquee;
      // 复位选框（清空起止点即不再绘制）
      this.marquee.start = null;
      this.marquee.end = null;
      this.setSelection(this.textsInRect(start, end));
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
      // 拖拽合集虚影是克隆节点，不参与命中
      if (n instanceof DragGhost) return;
      if (n instanceof Text) {
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
    const walk = (n: Node) => {
      if (n instanceof Text && !subtree.has(n)) {
        const p = n.getWorldPoint();
        // 垂直方向局限在同一水平带：候选节点与合集的 y 区间必须有交集
        const vOverlap =
          Math.min(f.y + f.h, p.y + n.height) - Math.max(f.y, p.y);
        if (vOverlap <= 0) {
          n.children.forEach(walk);
          return;
        }
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
      n.children.forEach(walk);
    };
    this.app.children.forEach(walk);
    return best;
  }

  // 落点提交：有效目标时把拖动子树顶层节点挂到目标节点下（换父并换线），随后重布局落定；
  // 无有效目标则仅恢复不透明度并重布局（回到原位，相当于取消）
  private async commitDrop(nodes: Text[], target: Text | null) {
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
      for (const n of nodes) {
        const old = n.parent as Text;
        // 目标就是当前父级：无变化
        if (old === parent) continue;
        // 原父级也在被拖子树内（多选时父子同选）：保持原父子结构，跟随父级一起挂载
        if (subtree.has(old)) continue;
        old.remove(n);
        parent.add(n);
        // 换线：移除旧父连线，加入新父连线
        const dead = this.edges.filter(
          (e) => e.fromNode === old && e.toNode === n,
        );
        this.edges = this.edges.filter((e) => !dead.includes(e));
        dead.forEach((e) => {
          const i = this.app.children.indexOf(e);
          if (i !== -1) this.app.children.splice(i, 1);
        });
        const edge = new MindMapEdge(parent, n);
        this.edges.push(edge);
        this.app.add(edge);
      }
    }
    await this.relayout();
    // 拖拽后保持选中：单选回到激活态（覆盖层），多选保持批量选中
    this.setSelection(nodes);
  }

  // 收集世界矩形相交的全部文本节点（相交即选中，含部分压线的节点）
  private textsInRect(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): Text[] {
    if (!this.root) return [];
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    const out: Text[] = [];
    this.collectTexts(this.root, out);
    return out.filter((n) => {
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
    this.app.render();
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
    this.app.render();
  }

  // 全局按键（覆盖层常驻可编辑、持有焦点时由其自身两态机处理）：
  // 覆盖层失焦时重新聚焦交还输入（不吞键），方向键导航，Tab/Enter 新建节点
  private onGlobalKeydown = (e: KeyboardEvent) => {
    // 覆盖层持焦时其 keydown 处理器已接管；失焦挂载态才走到这里
    if (this.editor.isEditing && this.editor.hasFocus()) return;
    // 仅响应画布或页面空白处的按键，页面其它控件输入不受影响
    const target = e.target as HTMLElement;
    if (target !== document.body && target !== this.app.canvas) return;
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
    // 打字或 IME 组合：重新聚焦常驻覆盖层并唤醒编辑态，默认输入/组合直接落在其上（不吞键，IME 首字符不丢）
    if (
      (e.key.length === 1 || e.keyCode === 229 || e.key === "Process") &&
      this.active
    ) {
      this.editor.focusForTyping();
    }
  };

  // 方向键导航：上下在整棵树内按视觉位置选垂直方向最近的节点（可跨分支），左右按布局方向进入首子节点或回父节点
  // 多选时以选集左上角节点为锚点，先收敛为单选再导航（Tab/Enter 在多选下不生效，见 onGlobalKeydown）
  private navigate(key: string) {
    if (!this.root) return;
    if (!this.selection.size) {
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
      if (current.children.length)
        this.activate(current.children[0] as Text);
    } else if (parent) {
      this.activate(parent);
    }
  }

  // 选集中最靠左上角的节点：先取最上（y 最小，0.5 容差抗浮点误差），同高取最左（x 最小）
  private topLeftSelection(): Text {
    return [...this.selection].reduce((best, n) => {
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

  // 异步初始化：构造节点树 → 布局 → fit 视口 → 挂载节点与连线（元函数组装）
  private async init(data: MindMapNode) {
    const root = await layout(this.renderNode(data), {
      direction: this.direction,
      levelGap: 80,
      siblingGap: 20,
    });
    this.root = root;
    this.viewport!.fit(this.getBounds(root));
    this.app.add(root);
    // 收集所有父子连线并追加到根节点之后，保证连线绘制在节点上层
    this.collectEdges(root, this.edges);
    this.app.add(this.edges);
    // 激活高亮环最后加入，保证绘制在节点与连线之上；拖拽反馈层在其上，框选矩形绘制在最顶层
    this.app.add(this.highlight);
    this.app.add(this.ghost);
    this.app.add(this.marquee);
    // 异步初始化完成后必须主动渲染一次：构造函数外的首次 render 发生在 add 之前，画布会是空白
    this.app.render();
  }

  // 文本输入后按新尺寸重新布局并渲染（元函数组装：重排 + 渲染）
  private async relayout() {
    if (!this.root || !this.viewport) return;
    await layout(this.root, {
      direction: this.direction,
      levelGap: 80,
      siblingGap: 20,
    });
    this.app.render();
    // 布局会移动节点，编辑框必须在对齐一次，否则覆盖在旧位置上
    this.editor.reposition();
  }

  // 编辑框按键两态机（飞书模型）——以 DOM 类名为唯一状态来源（覆盖层常驻，blur/唤醒随时切换外观）：
  // 激活态（passive 类，文字透明、由 canvas 渲染）：方向键拦截并切换节点；打字/IME/点击唤醒编辑态交还默认行为
  // 编辑态（覆盖层文字可见，canvas 停止渲染）：方向键移动光标；Tab 建子节点；Enter/Escape 提交（切回激活态视觉）
  private bindNodeKeys(el: HTMLDivElement, text: Text) {
    // 唤醒为编辑态：canvas 停止渲染文字；fill 为 true（点击进入）时填入节点文本做正常编辑，
    // 打字/IME/粘贴进入则保持空覆盖层（输入内容经 input 同步替换节点文本）
    const wake = (fill = false) => {
      this.editor.beginEdit(fill);
      this.setHighlightEditing(true);
    };
    el.addEventListener("keydown", (e) => {
      const passive = el.classList.contains("silker-text-passive");
      // 临时诊断日志（复现问题后移除）
      console.log(
        "[SilkerKeys] keydown",
        JSON.stringify(e.key),
        "keyCode=",
        e.keyCode,
        "passive=",
        passive,
      );
      if (passive && e.key.startsWith("Arrow")) {
        // 激活态方向键：接管为节点导航（覆盖层随 activate 转移到新节点）
        e.preventDefault();
        this.navigate(e.key);
        return;
      }
      if (passive && e.key === "Escape") {
        e.preventDefault();
        this.editor.enterPassive();
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
      // 可打印字符或 IME 组合键：仅唤醒为编辑态（canvas 停止渲染文字），不吞键 ——
      // 打字/组合直接落入空覆盖层，经 input 同步替换节点文本
      if (
        passive &&
        (e.key.length === 1 || e.key === "Process" || e.keyCode === 229)
      ) {
        wake();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        // 覆盖层常驻：节点切换由 activate → editor.start 完成卸载重建，无需先失焦
        void this.createRelated(e, text);
      } else if (e.key === "Enter" || e.key === "Escape") {
        // 阻止换行，提交 = 切回激活态视觉（覆盖层保持挂载可编辑，IME 不被打断），高亮环切回蓝色
        e.preventDefault();
        this.editor.enterPassive();
        this.setHighlightEditing(false);
      }
    });
    // 打字/组合/粘贴：空覆盖层唤醒（输入替换节点文本）；左键按下：与画布按下共用拖拽上下文，
    // 未超阈值松手（mouseup 统一判定）才视为点击进入编辑，避免拖拽激活节点时误触发编辑
    el.addEventListener("input", () => wake());
    el.addEventListener("compositionstart", () => wake());
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        // 非左键（如右键菜单粘贴前）保持原行为：立即唤醒
        wake(true);
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
    // 新节点按级数取样式：Tab 建子节点深度 +1，Enter 建兄弟节点深度不变
    const style = this.newNodeStyle(
      text,
      this.depthOf(text) + (isChild ? 1 : 0),
    );
    const node = this.createNode(text, style);
    this.nodeStyles.set(node, style);
    if (isChild) {
      parent.add(node);
    } else {
      // 根节点无父时退化为在末尾追加子节点
      const index =
        parent === text
          ? parent.children.length - 1
          : parent.children.indexOf(text);
      parent.children.splice(index + 1, 0, node);
      node.parent = parent;
    }
    const edge = new MindMapEdge(parent, node);
    this.edges.push(edge);
    this.app.add(edge);
    this.editor.bind(node);
    await this.relayout();
    // 新节点进入激活态（常驻覆盖层，打字即编辑）
    this.activate(node);
  }

  // 删除选中节点（单选/多选统一走 selection）及其整个子树（根节点不可删除）：
  // 摘除各子树、清理关联连线，重布局后激活第一个被删节点的存活父级（均被删时退化为根节点）
  private async deleteSelection() {
    if (!this.root) return;
    const targets = [...this.selection].filter((n) => n !== this.root);
    if (!targets.length) return;
    // 收集各子树内全部节点，并记住被删前各自的父级
    const subtree = new Set<Node>();
    const collect = (n: Node) => {
      subtree.add(n);
      n.children.forEach(collect);
    };
    const parents: Text[] = [];
    for (const text of targets) {
      collect(text);
      parents.push(text.parent as Text);
      (text.parent as Text).remove(text);
    }
    // 清理起点或终点在子树内的连线，并从渲染树移除
    const dead = this.edges.filter(
      (e) => subtree.has(e.fromNode) || subtree.has(e.toNode),
    );
    this.edges = this.edges.filter((e) => !dead.includes(e));
    dead.forEach((e) => {
      const i = this.app.children.indexOf(e);
      if (i !== -1) this.app.children.splice(i, 1);
    });
    // 清空选中态，重布局后激活存活的父节点（activate 会重建覆盖层，旧覆盖层随之卸载）
    this.selection.clear();
    this.highlight.targets = [];
    await this.relayout();
    this.activate(parents.find((p) => !subtree.has(p)) ?? this.root);
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
  private collectEdges(node: Text, edges: MindMapEdge[]) {
    node.children.forEach((child) => {
      const c = child as Text;
      edges.push(new MindMapEdge(node, c));
      this.collectEdges(c, edges);
    });
  }

  // 递归遍历子树，把每个节点的世界包围盒并入总范围（元函数：被 getBounds 调用）
  private collectBounds(
    node: Text,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
  ) {
    const p = node.getWorldPoint();
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.maxX = Math.max(bounds.maxX, p.x + node.width);
    bounds.maxY = Math.max(bounds.maxY, p.y + node.height);
    node.children.forEach((child) => this.collectBounds(child as Text, bounds));
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
    this.nodeStyles.set(text, style);
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
