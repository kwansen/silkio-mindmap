import { App, Text } from "@silker/core";
import { Viewport } from "@silker/plugin-viewport";
import { TextEditor } from "@silker/plugin-text-editor";
import { layout } from "./layout";
import { MindMapEdge } from "./Edge";

export interface Style {
  color: string
  backgroundColor: string
  fontSize: number
  fontWeight: number
  fontFamily: string
  radius: number | [number, number, number, number]
  borderColor: string
  borderWidth: number
  lineHeight: number
  padding: number | [number] | [number, number] | [number, number, number] | [number, number, number, number]
}

export interface MindMapNode {
  text: string
  style: Style
  children: MindMapNode[]
}

export interface MindMapOptions {
  canvas: HTMLCanvasElement
  data: MindMapNode
  // 布局方向：'right' 从左往右（子节点在父节点右侧），'left' 从右往左（子节点在父节点左侧），默认 'left'
  direction?: 'left' | 'right'
}

export type LayoutDirection = NonNullable<MindMapOptions['direction']>



export class MindMap {
  app: App
  private root: Text | null = null
  private viewport: Viewport | null = null
  private editor: TextEditor
  private edges: MindMapEdge[] = []
  private direction: LayoutDirection

  constructor(options: MindMapOptions) {
    this.direction = options.direction ?? 'left'
    this.app = new App(options.canvas)
    // 安装视口插件：支持滚轮以鼠标为中心缩放、拖拽平移画布与按包围盒拟合视口
    this.viewport = new Viewport()
    this.app.use(this.viewport)
    // 安装文本编辑插件：输入时重新布局，编辑框就绪后直接监听按键新建节点（包装 add 自动绑定后续节点）
    this.editor = new TextEditor({
      onInput: () => this.relayout(),
      onEditStart: (el, text) => this.bindNodeKeys(el, text),
    })
    this.app.use(this.editor)
    // 异步初始化：先布局再挂载渲染（构造函数无法 await，内部顺序保证）
    void this.init(options.data)
  }

  // 异步初始化：构造节点树 → 布局 → fit 视口 → 挂载节点与连线（元函数组装）
  private async init(data: MindMapNode) {
    const root = await layout(this.renderNode(data), { direction: this.direction, levelGap: 80, siblingGap: 20 })
    this.root = root
    this.viewport!.fit(this.getBounds(root))
    this.app.add(root)
    // 收集所有父子连线并追加到根节点之后，保证连线绘制在节点上层
    this.collectEdges(root, this.edges)
    this.app.add(this.edges)
    // 异步初始化完成后必须主动渲染一次：构造函数外的首次 render 发生在 add 之前，画布会是空白
    this.app.render()
  }

  // 文本输入后按新尺寸重新布局并渲染（元函数组装：重排 + 渲染）
  private async relayout() {
    if (!this.root || !this.viewport) return
    await layout(this.root, { direction: this.direction, levelGap: 80, siblingGap: 20 })
    this.app.render()
    // 布局会移动节点，编辑框必须在对齐一次，否则覆盖在旧位置上
    this.editor.reposition()
  }

  // 直接监听编辑框按键：Tab 创建子节点、Enter 创建兄弟节点（拦截默认行为）
  private bindNodeKeys(el: HTMLDivElement, text: Text) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        this.onKeydown(e, text)
      }
    })
  }

  // Tab 创建子节点、Enter 在当前节点下方创建兄弟节点，随后进入编辑并重布局
  private async onKeydown(e: KeyboardEvent, text: Text) {
    console.log('[MindMap] onKeydown', e.key, 'from:', text.text)
    const isChild = e.key === 'Tab'
    const parent = isChild ? text : (text.parent as Text | null) ?? text
    const node = this.createNode(text)
    if (isChild) {
      parent.add(node)
    } else {
      // 根节点无父时退化为在末尾追加子节点
      const index = parent === text ? parent.children.length - 1 : parent.children.indexOf(text)
      parent.children.splice(index + 1, 0, node)
      node.parent = parent
    }
    const edge = new MindMapEdge(parent, node)
    this.edges.push(edge)
    this.app.add(edge)
    this.editor.bind(node)
    await this.relayout()
    // 手动调用公开的编辑方法，让新节点直接进入编辑状态
    this.editor.start(node)
  }

  // 复制参考节点的字体与盒子样式创建默认新节点（元函数：样式拷贝）
  private createNode(ref: Text): Text {
    return new Text({
      x: 0,
      y: 0,
      wrap: true,
      // 新节点与初始节点保持一致的最大宽度约束，否则长文本会无限撑开
      widthRange: ref.widthRange ?? [0, 200],
      text: '新节点',
      fontSize: ref.fontSize,
      fontWeight: ref.fontWeight,
      fill: ref.fill,
      fontFamily: ref.fontFamily,
      padding: ref.padding,
      lineHeight: ref.lineHeight,
      boxStyle: ref.boxStyle,
    })
  }

  // 递归收集所有父子连线（每条边绑定父子节点，元函数：被构造时调用）
  private collectEdges(node: Text, edges: MindMapEdge[]) {
    node.children.forEach(child => {
      const c = child as Text
      edges.push(new MindMapEdge(node, c))
      this.collectEdges(c, edges)
    })
  }

  // 递归遍历子树，把每个节点的世界包围盒并入总范围（元函数：被 getBounds 调用）
  private collectBounds(node: Text, bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
    const p = node.getWorldPoint()
    bounds.minX = Math.min(bounds.minX, p.x)
    bounds.minY = Math.min(bounds.minY, p.y)
    bounds.maxX = Math.max(bounds.maxX, p.x + node.width)
    bounds.maxY = Math.max(bounds.maxY, p.y + node.height)
    node.children.forEach(child => this.collectBounds(child as Text, bounds))
  }

  // 计算整棵树的世界包围盒（从无穷大范围开始递归收拢）
  private getBounds(root: Text) {
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    this.collectBounds(root, bounds)
    return bounds
  }

  // 第一次递归：把数据节点转成 Text 节点树（x/y 留空，由布局器统一确定）
  renderNode(data: MindMapNode): Text {
    const text = new Text({
      x: 0,
      y: 0,
      wrap: true,
      widthRange: [0, 200],
      text: data.text,
      fontSize: data.style.fontSize,
      fontWeight: data.style.fontWeight,
      fill: data.style.color,
      fontFamily: data.style.fontFamily,
      padding: data.style.padding,
      lineHeight: data.style.lineHeight,
      boxStyle: {
        fill: data.style.backgroundColor,
        stroke: data.style.borderColor,
        lineWidth: data.style.borderWidth,
        radius: data.style.radius,
      },
    })
    // 递归调用自身，将每个子数据转成子节点并挂到当前节点下
    data.children.forEach(child => text.add(this.renderNode(child)))
    return text
  }
}