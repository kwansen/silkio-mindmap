import { Text } from "@silker/core";
import type { EdgeShape } from "@silker/plugin-edge";
import { MindMapEdge, MindPathEdge } from "./Edge";
import type { MindEdge } from "./Edge";
import { defaultStyle } from "./types";
import type { MindMapNode, Style } from "./types";

// 思维导图数据模型：持有节点树与连线集合，负责建模（数据 → Text 树）、级数样式解析、
// 折叠可见性联动与序列化导出。只做模型维护，不涉及交互与覆盖层（各 controller 单向依赖本模块）
export class MindTree {
  // 树根节点（init 挂载后非空，未初始化前为 null）
  root: Text | null = null;
  // 全部父子连线（换父/增删节点时由各命令闭包同步维护）
  edges: MindEdge[] = [];
  // 级数样式配置（index 0 为根节点），renderNode 与新建节点按级数取值
  readonly levelStyles: Style[];
  // 每个节点创建时实际使用的样式，供无级数配置时新建节点沿用参考节点样式
  readonly nodeStyles = new WeakMap<Text, Style>();
  // 节点数据上的用户自定义样式（未自定义的节点不记录），换父重设样式时与新级数默认样式合并
  readonly customStyles = new WeakMap<Text, Style>();
  // 连线样式（构造时从 options 记录）
  private edgeStyle: EdgeShape;

  constructor(options: { levelStyles: Style[]; edgeStyle: EdgeShape }) {
    this.levelStyles = options.levelStyles;
    this.edgeStyle = options.edgeStyle;
  }

  // 按连线样式创建父子连线（统一入口，三处创建点共用）
  createEdge(from: Text, to: Text): MindEdge {
    if (this.edgeStyle === "bezier") return new MindMapEdge(from, to);
    return new MindPathEdge(from, to, this.edgeStyle);
  }

  // 导出当前数据树：文本 + 子树 + 节点自定义样式 + 折叠态（级数默认样式不入档，避免与 levelStyles 重复）
  toJSON(): MindMapNode {
    if (!this.root) throw new Error("MindMap 尚未初始化完成");
    return this.serializeNode(this.root);
  }

  // 把节点子树序列化为数据节点（toJSON 与复制共用）：文本 + 自定义样式 + 折叠态 + 子孙递归
  serializeNode(n: Text): MindMapNode {
    const walk = (node: Text): MindMapNode => ({
      text: node.text,
      ...(this.customStyles.has(node) ? { style: this.customStyles.get(node)! } : {}),
      ...(node.collapsed ? { collapsed: true } : {}),
      children: node.children.map((c) => walk(c as Text)),
    });
    return walk(n);
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
    this.edges.forEach((e) => {
      e.visible = e.fromNode.visible && e.toNode.visible;
    });
  }

  // 收集世界矩形相交的全部文本节点（相交即选中，含部分压线的节点）
  textsInRect(rect: { x: number; y: number; width: number; height: number }): Text[] {
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

  // 新节点样式解析：配置了级数样式按级数取值，否则沿用参考节点的实际样式（旧行为）
  newNodeStyle(ref: Text, depth: number): Style {
    if (this.levelStyles.length) return this.levelStyle(depth);
    return this.nodeStyles.get(ref) ?? defaultStyle;
  }

  // 按解析出的样式创建默认新节点，宽度范围与参考节点保持一致（元函数：样式构造）
  createNode(ref: Text, style: Style): Text {
    return this.createText("新节点", style, ref.widthRange ?? [0, 200]);
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
