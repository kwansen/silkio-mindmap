import { Text } from "@silkor/core";
import type { App, EdgeShape } from "@silkor/core";
import { invariant } from "./invariants";
import { MindMapEdge, MindPathEdge } from "./Edge";
import type { MindEdge } from "./Edge";
import type { PasteInsert } from "./commands";
import { defaultStyle } from "./types";
import type { LayoutDirection, LayoutDirectionRef, MindMapNode, Style } from "./types";

// 思维导图数据模型：持有节点树与连线集合，负责建模（数据 → Text 树）、级数样式解析、
// 折叠可见性联动与序列化导出。只做模型维护，不涉及交互与覆盖层（各 controller 单向依赖本模块）。
// 连线表与样式缓存为私有状态，只能经下方原语访问——"连线表↔场景同步"与
// "节点样式登记"两条不变量由本类收口，外部不得绕开（此前双份真值漂移的收口点）
export class MindTree {
  // 树根节点（init 挂载后非空，未初始化前为 null）
  root: Text | null = null;
  // 全部父子连线（私有真值，换父/增删节点时经 mount/unmount/replace 原语同步维护；
  // 外部经 edges 只读访问器消费）
  private _edges: MindEdge[] = [];
  // 连线身份集合（_edges 的 O(1) 成员查询镜像）：仅由下方三原语同步维护，
  // 断言消费——重复挂载/摘除不存在连线等"双写漂移"类错误在原语入口即暴露。
  // 不参与任何业务逻辑（查询仍走 _edges 或端点匹配）
  private _edgeSet = new Set<MindEdge>();
  // 连线表只读访问器：查询类消费方（死连线计算/连线查找/导出）按只读序列消费，
  // 编译期阻断外部直写（push/赋值），结构变更必须走 mount/unmount/replace 原语
  get edges(): readonly MindEdge[] {
    return this._edges;
  }
  // 级数样式配置（index 0 为根节点），renderNode 与新建节点按级数取值
  readonly levelStyles: Style[];
  // 每个节点创建时实际使用的样式，供无级数配置时新建节点沿用参考节点样式
  // （私有真值：读经 styleOf，写经 renderNode/applyNodeStyle/registerNodeStyle 收口）
  private readonly nodeStyles = new WeakMap<Text, Style>();
  // 节点数据上的用户自定义样式（未自定义的节点不记录），换父重设样式时与新级数默认样式合并
  // （私有真值：读经 customStyleOf，写经 renderNode/registerCustomStyle 收口）
  private readonly customStyles = new WeakMap<Text, Style>();
  // 连线样式（构造时从 options 记录）
  private edgeStyle: EdgeShape;
  // 布局方向共享引用（门面创建并分发，切换方向只改这一处状态）：
  // down 时父子连线为纵向（父底缘连子顶缘），both 时根节点的子树分堆左右两侧
  //（连线仍为横向，锚点按父子相对位置自适应）
  readonly directionRef: LayoutDirectionRef;
  // 场景增删入口（可选，测试/纯数据场景缺省）：连线表同步原语经此同步场景连线层，
  // 缺省时只维护连线表本身
  private app: Pick<App, "add" | "remove"> | null;

  constructor(options: {
    levelStyles: Style[];
    edgeStyle: EdgeShape;
    direction?: LayoutDirectionRef;
    app?: Pick<App, "add" | "remove">;
  }) {
    this.levelStyles = options.levelStyles;
    this.edgeStyle = options.edgeStyle;
    this.directionRef = options.direction ?? { value: "left" };
    this.app = options.app ?? null;
  }

  // 方向切换的模型侧联动：方向状态由门面经共享 ref 直接改写（directionRef.value = d），
  // 本方法只翻转既有连线的纵向标志（连线类别只由 edgeStyle 决定，横向/纵向渲染由
  // vertical 标志在渲染时动态分支，无需重建连线对象）
  applyDirection(direction: LayoutDirection) {
    const vertical = direction === "down";
    this._edges.forEach((e) => (e.vertical = vertical));
  }

  // 连线表与场景的同步原语（唯一出口）：命令 redo/undo、连线样式切换、编解码器
  // 重建统一走此收口——模型连线表与场景连线层由同一处维护，命令闭包不再手工双写
  //（此前遗漏一处即静默脏数据，是双份真值问题的收口点）
  mountEdges(edges: MindEdge[]) {
    for (const e of edges) {
      invariant(!this._edgeSet.has(e), "mountEdges: 连线已在连线表中（重复挂载）");
      this._edgeSet.add(e);
      // 可见性入表即按端点对齐（applyCollapseVisibility 的同一规则）：新建连线
      // 默认可见，而 init（数据自带折叠态）等路径挂载晚于可见性联动、折叠子树内
      // 的端点已不可见——不在此落标志，折叠里的连线会以幽灵连线渲染出来
      e.visible = e.fromNode.visible && e.toNode.visible;
    }
    this._edges.push(...edges);
    this.app?.add(edges);
  }

  // 从连线表与场景中摘除指定连线（按对象同一性过滤）
  unmountEdges(edges: MindEdge[]) {
    for (const e of edges) {
      invariant(this._edgeSet.has(e), "unmountEdges: 连线不在连线表中（摘除不存在的连线）");
      this._edgeSet.delete(e);
    }
    const set = new Set(edges);
    this._edges = this._edges.filter((e) => !set.has(e));
    this.app?.remove(edges);
  }

  // 整表替换：摘除当前全部连线、换入新连线表（对象引用稳定，undo/redo 双向可用）
  replaceEdges(next: MindEdge[]) {
    const prev = [...this._edges];
    this._edges.length = 0;
    this._edges.push(...next);
    // 重建身份镜像；替换表内不得含重复连线（成员数须与表长一致）
    this._edgeSet = new Set(next);
    invariant(this._edgeSet.size === next.length, "replaceEdges: 替换表内存在重复连线");
    if (this.app) {
      this.app.remove(prev);
      this.app.add(next);
    }
  }

  // 展开折叠节点（唯一出口）：翻标志并联动可见性。新建/粘贴/外部文本/拖入/AI 移入
  // 等所有"目标折叠先展开"路径统一走此原语，避免多处手写漂移
  expand(node: Text) {
    if (!node.collapsed) return;
    node.collapsed = false;
    this.applyCollapseVisibility();
  }

  // 切换连线样式：bezier 与 path 系是两个连线类，无法原地改 shape，按新样式重建全部
  // 连线对象并继承原连线的纵向标志、可见性与 id（id 稳定保证历史命令按 id 解析的
  // 引用一致性）。场景换入换出经 replaceEdges 原语同步（模型连线表与场景连线层
  // 由同一处维护）。
  // 样式未变化时不做任何事，返回 null；变化时返回切换前的样式（历史命令载荷取 before）
  setEdgeStyle(shape: EdgeShape): EdgeShape | null {
    if (shape === this.edgeStyle) return null;
    const before = this.edgeStyle;
    this.edgeStyle = shape;
    const next = this._edges.map((e) => {
      const ne = this.createEdge(e.fromNode, e.toNode);
      ne.id = e.id;
      ne.vertical = e.vertical;
      ne.visible = e.visible;
      return ne;
    });
    this.replaceEdges(next);
    return before;
  }

  // 按连线样式创建父子连线（统一入口，三处创建点共用）；纵向布局（down）创建垂直连线
  createEdge(from: Text, to: Text): MindEdge {
    if (this.directionRef.value === "down") {
      if (this.edgeStyle === "bezier") return new MindMapEdge(from, to, true);
      return new MindPathEdge(from, to, this.edgeStyle, true);
    }
    if (this.edgeStyle === "bezier") return new MindMapEdge(from, to);
    return new MindPathEdge(from, to, this.edgeStyle);
  }

  // 导出当前数据树：文本 + 子树 + 节点自定义样式 + 折叠态（级数默认样式不入档，避免与 levelStyles 重复）
  toJSON(): MindMapNode {
    if (!this.root) throw new Error("MindMap 尚未初始化完成");
    return this.serializeNode(this.root);
  }

  // 把节点子树序列化为数据节点（toJSON 与复制共用）：id + 文本 + 自定义样式 + 折叠态 + 子孙递归
  serializeNode(n: Text): MindMapNode {
    const walk = (node: Text): MindMapNode => ({
      id: node.id ?? undefined,
      text: node.text,
      ...(this.customStyles.has(node) ? { style: this.customStyles.get(node)! } : {}),
      ...(node.collapsed ? { collapsed: true } : {}),
      children: node.children.map((c) => walk(c as Text)),
    });
    return walk(n);
  }

  // 历史命令载荷专用序列化：与 serializeNode 的差别是每个节点都定格"创建时实际生效
  // 的样式"（customStyles 优先，缺省用 nodeStyles）——导入重建按显式样式还原，
  // 不依赖重建时刻的级数上下文，避免 depth 漂移导致样式偏差
  serializeForHistory(n: Text): MindMapNode {
    const walk = (node: Text): MindMapNode => ({
      id: node.id ?? undefined,
      text: node.text,
      style: this.customStyles.get(node) ?? this.nodeStyles.get(node),
      ...(node.collapsed ? { collapsed: true } : {}),
      children: node.children.map((c) => walk(c as Text)),
    });
    return walk(n);
  }

  // 剪贴板粘贴前深拷贝并剥除 id：粘贴出的节点须是新节点（Node 自动生成新 id），
  // 不得与源子树共享 id
  stripIds(data: MindMapNode): MindMapNode {
    return {
      ...data,
      id: undefined,
      children: data.children.map((c) => this.stripIds(c)),
    };
  }

  // 按 id 在树中查找节点（历史命令导入重建的引用解析入口；脱离树的节点查不到，
  // 由编解码器的会话注册表兜底）
  nodeById(id: string): Text | null {
    if (!this.root) return null;
    let found: Text | null = null;
    const walk = (n: Text) => {
      if (found) return;
      if (n.id === id) {
        found = n;
        return;
      }
      n.children.forEach((c) => walk(c as Text));
    };
    walk(this.root);
    return found;
  }

  // 一次性建立 id → 节点索引（O(n) 快照）：供 AI 编译等"同批内多次按 id 查找"
  // 的场景复用，避免逐次 nodeById 全树遍历（O(n·k)）。编译期结构不变
  //（expand 只改折叠标志不动结构），快照在批内有效；结构变更后须重建
  indexById(): Map<string, Text> {
    const map = new Map<string, Text>();
    if (!this.root) return map;
    const walk = (n: Text) => {
      map.set(n.id!, n);
      n.children.forEach((c) => walk(c as Text));
    };
    walk(this.root);
    return map;
  }

  // 折叠可见性联动：折叠节点的整个子树置为不可见（含连线），展开则恢复可见。
  // 连线可见性跟随端点：任一端不可见即隐藏。relayout 统一调用，覆盖所有结构变更路径
  applyCollapseVisibility() {
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
    this._edges.forEach((e) => {
      e.visible = e.fromNode.visible && e.toNode.visible;
    });
  }

  // 收集世界矩形相交的全部文本节点（相交即选中，含部分压线的节点）。
  // 世界矩阵自根向下传播：每节点只做一次 parentWorld × local 乘法，不逐节点
  // 重建父链（getWorldPoint 是 O(depth) 矩阵链重建，1200 节点单次命中测试
  // ~50ms 级；拖框中该函数逐鼠标事件调用，是框选卡顿主因）
  textsInRect(rect: { x: number; y: number; width: number; height: number }): Text[] {
    if (!this.root) return [];
    const left = rect.x;
    const right = rect.x + rect.width;
    const top = rect.y;
    const bottom = rect.y + rect.height;
    const out: Text[] = [];
    // 折叠子树整体不可见（applyCollapseVisibility 联动整 subtree），整枝跳过
    const walk = (n: Text, parentWorld: DOMMatrix) => {
      if (!n.visible) return;
      const world = parentWorld.multiply(n.localTransform);
      const p = world.transformPoint({ x: 0, y: 0 });
      if (
        p.x < right &&
        p.x + n.width > left &&
        p.y < bottom &&
        p.y + n.height > top
      )
        out.push(n);
      n.children.forEach((c) => walk(c as Text, world));
    };
    walk(this.root, new DOMMatrix());
    return out;
  }

  // 递归收集子树内全部文本节点（被 textsInRect 与键盘垂直导航共用）
  collectTexts(node: Text, out: Text[]) {
    out.push(node);
    node.children.forEach((child) => this.collectTexts(child as Text, out));
  }

  // 节点在树中的级数（根节点为 0），由 parent 链向上回溯
  depthOf(node: Text): number {
    let depth = 0;
    let p = node.parent as Text | null;
    while (p) {
      depth++;
      p = p.parent as Text | null;
    }
    return depth;
  }

  // 节点子侧判定（横向布局语义：子节点在该节点的左/右侧）：
  // 单侧布局（left/right）全局一致；双向布局（both）按节点与根节点的世界坐标相对
  // 位置判定——布局把左分子树放在根左侧、右分放在右侧，几何位置即分堆真值，
  // 交互层（折叠/导航/拖放）据此按节点逐个判定，无需布局回传分堆结果。
  // 纵向布局（down）与根节点本身返回 'right'（调用方仅在横向语境消费）
  sideOf(node: Text): "left" | "right" {
    const direction = this.directionRef.value;
    if (direction === "down") return "right";
    if (direction !== "both") return direction;
    if (!this.root || node === this.root) return "right";
    const rp = this.root.getWorldPoint();
    const p = node.getWorldPoint();
    return p.x < rp.x ? "left" : "right";
  }

  // 新节点样式解析：配置了级数样式按级数取值，否则沿用参考节点的实际样式（旧行为）
  newNodeStyle(ref: Text, depth: number): Style {
    if (this.levelStyles.length) return this.levelStyle(depth);
    return this.nodeStyles.get(ref) ?? defaultStyle;
  }

  // 节点实际生效样式读取（nodeStyles 私有真值的只读出口）：AI move/拖拽换父定格
  // undo 还原样式时读取"创建时生效样式"
  styleOf(node: Text): Style | undefined {
    return this.nodeStyles.get(node);
  }

  // 用户自定义样式读取（customStyles 私有真值的只读出口）：换父重设样式时与
  // 新级数默认样式合并
  customStyleOf(node: Text): Style | undefined {
    return this.customStyles.get(node);
  }

  // 节点样式登记（nodeStyles 私有真值的写出口，测试/外部建桩场景补登记用；
  // 常规路径由 renderNode/createNode/applyNodeStyle 内部登记）
  registerNodeStyle(node: Text, style: Style) {
    this.nodeStyles.set(node, style);
  }

  // 用户自定义样式登记（customStyles 私有真值的写出口，测试/外部建桩场景用）
  registerCustomStyle(node: Text, style: Style) {
    this.customStyles.set(node, style);
  }

  // 按解析出的样式创建默认新节点，宽度范围与参考节点保持一致（元函数：样式构造）。
  // 创建即登记实际生效样式（nodeStyles 收口）：调用方不再手工 set，避免漏登记漂移
  createNode(ref: Text, style: Style): Text {
    const node = this.createText("新节点", style, ref.widthRange ?? [0, 200]);
    this.nodeStyles.set(node, style);
    return node;
  }

  // 子树插入编排原语（AI add 与剪贴板粘贴共用同一份，消除两处手写漂移）：
  // 渲染数据子树（级数 = 目标级数 + 1，按级数解析样式）→ 深度先序收集子树内连线 →
  // 创建父子连线，返回 paste 命令工厂所需的完整插入载荷。
  // index 为插入后的兄弟位次（0 起），由调用方定格（命令重放不依赖创建时树状态）
  buildSubtreeInsert(parent: Text, data: MindMapNode, index: number): PasteInsert {
    const node = this.renderNode(data, this.depthOf(parent) + 1);
    const inner: MindEdge[] = [];
    this.collectEdges(node, inner);
    return { parent, node, edge: this.createEdge(parent, node), inner, index };
  }

  // 递归收集所有父子连线（每条边绑定父子节点，元函数：被构造时调用）
  collectEdges(node: Text, edges: MindEdge[]) {
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
  getBounds(root: Text) {
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
  // 样式解析优先级：节点数据 style > levelStyles[depth]（超出配置长度套用最后一项）> 兜底样式。
  // styleAsDefault（历史命令导入重建用）：数据显式 style 只写入 nodeStyles 缓存、
  // 不登记 customStyles——载荷定格的是"当时生效样式"，不改变节点未来的级数样式语义；
  // 数据 id 透传（未提供时 Node 自动生成），供历史命令按 id 恢复引用同一性
  renderNode(data: MindMapNode, depth = 0, styleAsDefault = false): Text {
    const style = data.style ?? this.levelStyle(depth);
    const text = this.createText(data.text, style, undefined, data.id);
    text.collapsed = data.collapsed ?? false;
    this.nodeStyles.set(text, style);
    if (data.style && !styleAsDefault) this.customStyles.set(text, data.style);
    // 递归调用自身，将每个子数据转成子节点并挂到当前节点下
    data.children.forEach((child) =>
      text.add(this.renderNode(child, depth + 1, styleAsDefault)),
    );
    return text;
  }

  // 按级数取样式配置，超出配置长度时套用最后一项，未配置时兜底
  levelStyle(depth: number): Style {
    if (!this.levelStyles.length) return defaultStyle;
    return this.levelStyles[Math.min(depth, this.levelStyles.length - 1)];
  }

  // 将样式应用到已有节点（换父后级数变化时重设外观），同步刷新级数样式缓存并重测尺寸
  applyNodeStyle(text: Text, style: Style) {
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
    id?: string,
  ): Text {
    return new Text({
      id,
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
