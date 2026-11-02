import { App, Text } from "@silker/core";
import type { Node } from "@silker/core";
import { Viewport } from "@silker/plugin-viewport";
import { TextEditor } from "@silker/plugin-text-editor";
import { layout } from "./layout";
import { MindMapEdge } from "./Edge";
import { ActiveHighlight } from "./ActiveHighlight";

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
  // 节点样式：缺省时按级数回退到 levelStyles 配置（用户数据可覆盖级数配置）
  style?: Style
  children: MindMapNode[]
}

// 未配置 levelStyles 且节点缺省 style 时的兜底样式
const defaultStyle: Style = {
  color: '#1f2937',
  backgroundColor: '#ffffff',
  fontSize: 16,
  fontWeight: 400,
  fontFamily: 'sans-serif',
  radius: 6,
  borderColor: '#94a3b8',
  borderWidth: 0,
  lineHeight: 1.4,
  padding: [6, 12],
}

export interface MindMapOptions {
  canvas: HTMLCanvasElement
  data: MindMapNode
  // 布局方向：'right' 从左往右（子节点在父节点右侧），'left' 从右往左（子节点在父节点左侧），默认 'left'
  direction?: 'left' | 'right'
  // 按级数的样式配置：index 0 为根节点（一级），依次向深层级递增，超出配置长度时套用最后一项。
  // 节点数据上的 style 优先于级数配置；新建节点（Tab/Enter）按其级数取样式
  levelStyles?: Style[]
}

export type LayoutDirection = NonNullable<MindMapOptions['direction']>

// 高亮环两态颜色：激活（未编辑）蓝色，编辑紫色
const ACTIVE_COLOR = '#3b82f6'
const EDITING_COLOR = '#a855f7'



export class MindMap {
  app: App
  private root: Text | null = null
  private viewport: Viewport | null = null
  private editor: TextEditor
  private edges: MindMapEdge[] = []
  private direction: LayoutDirection
  // 级数样式配置（index 0 为根节点），renderNode 与新建节点按级数取值
  private levelStyles: Style[]
  // 每个节点创建时实际使用的样式，供无级数配置时新建节点沿用参考节点样式
  private nodeStyles = new WeakMap<Text, Style>()
  // 激活态：点击或方向键选中但未进入编辑的节点，画布绘制高亮环；
  // 覆盖层常驻于激活节点（passive 激活态：空覆盖层，文字仍由 canvas 渲染，视觉零抖动），
  // 打字唤醒为编辑态：canvas 停止渲染、空覆盖层成为输入缓冲（输入替换节点文本）；点击唤醒则填入节点文本正常编辑
  private active: Text | null = null
  private highlight: ActiveHighlight

  constructor(options: MindMapOptions) {
    this.direction = options.direction ?? 'left'
    this.levelStyles = options.levelStyles ?? []
    this.app = new App(options.canvas)
    // 安装视口插件：支持滚轮以鼠标为中心缩放、拖拽平移画布与按包围盒拟合视口
    this.viewport = new Viewport()
    this.app.use(this.viewport)
    // 安装文本编辑插件：输入时重新布局，编辑框就绪后直接监听按键新建节点（包装 add 自动绑定后续节点）
    this.editor = new TextEditor({
      onInput: () => this.relayout(),
      onEditStart: (el, text) => this.bindNodeKeys(el, text),
      // 点击仅激活（常驻覆盖层 + 画布高亮环），进入编辑由打字或点击覆盖层触发
      onActivate: (text) => this.activate(text),
      // 失焦切回激活态视觉时同步高亮环颜色
      onEditEnd: () => this.setHighlightEditing(false),
    })
    this.app.use(this.editor)
    // 激活高亮环挂载在最上层（init 中节点与连线加入后再 add）
    this.highlight = new ActiveHighlight(() => this.app.renderer.viewport.scale)
    // 激活态键盘导航：方向键切换节点、Tab/Enter 新建、打字进入编辑（编辑态由编辑框自身处理按键）
    document.addEventListener('keydown', this.onGlobalKeydown)
    // 异步初始化：先布局再挂载渲染（构造函数无法 await，内部顺序保证）
    void this.init(options.data)
  }

  // 激活节点：更新高亮环目标，常驻覆盖层以激活态（光标透明）覆盖节点并聚焦，必要时平移视口
  private activate(text: Text) {
    this.active = text
    this.highlight.target = text
    this.highlight.color = ACTIVE_COLOR
    this.app.render()
    this.editor.start(text, { passive: true })
    this.scrollNodeIntoView(text)
  }

  // 按编辑状态切换高亮环颜色并重绘（激活蓝色 / 编辑紫色）
  private setHighlightEditing(editing: boolean) {
    this.highlight.color = editing ? EDITING_COLOR : ACTIVE_COLOR
    this.app.render()
  }

  // 激活节点越出屏幕时平移视口（编辑由 editor.start 自带滚动，此处仅覆盖键盘导航）
  private scrollNodeIntoView(text: Text) {
    const vp = this.app.renderer.viewport
    const p = text.getWorldPoint()
    const sx = p.x * vp.scale + vp.x
    const sy = p.y * vp.scale + vp.y
    const right = sx + text.width * vp.scale
    const bottom = sy + text.height * vp.scale
    const dx = sx < 20
      ? 20 - sx
      : right > window.innerWidth - 20
        ? window.innerWidth - 20 - right
        : 0
    const dy = sy < 20
      ? 20 - sy
      : bottom > window.innerHeight - 20
        ? window.innerHeight - 20 - bottom
        : 0
    if (dx === 0 && dy === 0) return
    this.app.renderer.setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy })
    this.app.render()
  }

  // 全局按键（覆盖层常驻可编辑、持有焦点时由其自身两态机处理）：
  // 覆盖层失焦时重新聚焦交还输入（不吞键），方向键导航，Tab/Enter 新建节点
  private onGlobalKeydown = (e: KeyboardEvent) => {
    // 覆盖层持焦时其 keydown 处理器已接管；失焦挂载态才走到这里
    if (this.editor.isEditing && this.editor.hasFocus()) return
    // 仅响应画布或页面空白处的按键，页面其它控件输入不受影响
    const target = e.target as HTMLElement
    if (target !== document.body && target !== this.app.canvas) return
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      if (this.active) void this.createRelated(e, this.active)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (this.active) void this.deleteNode(this.active)
      return
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      this.navigate(e.key)
      return
    }
    // 打字或 IME 组合：重新聚焦常驻覆盖层并唤醒编辑态，默认输入/组合直接落在其上（不吞键，IME 首字符不丢）
    if ((e.key.length === 1 || e.keyCode === 229 || e.key === 'Process') && this.active) {
      this.editor.focusForTyping()
    }
  }

  // 方向键导航：上下在整棵树内按视觉位置选垂直方向最近的节点（可跨分支），左右按布局方向进入首子节点或回父节点
  private navigate(key: string) {
    if (!this.root) return
    if (!this.active) {
      this.activate(this.root)
      return
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      this.navigateVertical(key)
      return
    }
    const parent = this.active.parent as Text | null
    // direction 'right' 子节点在右侧：Right 进入首子节点，Left 回父节点；direction 'left' 相反
    const toChild = this.direction === 'right' ? key === 'ArrowRight' : key === 'ArrowLeft'
    if (toChild) {
      if (this.active.children.length) this.activate(this.active.children[0] as Text)
    } else if (parent) {
      this.activate(parent)
    }
  }

  // 垂直导航：↑↓ 选择上/下方最近的可导航节点 —— 先取水平区间重叠者（正上/正下），
  // 无重叠时再取斜向矩形间距最近者（斜上/斜下），←→ 仍负责层级移动
  private navigateVertical(key: 'ArrowUp' | 'ArrowDown') {
    const current = this.active!
    const cp = current.getWorldPoint()
    const cur = { left: cp.x, right: cp.x + current.width, cy: cp.y + current.height / 2 }
    const below = key === 'ArrowDown'
    const all: Text[] = []
    this.collectTexts(this.root!, all)
    const cands = all.filter(n => {
      if (n === current) return false
      const p = n.getWorldPoint()
      const cy = p.y + n.height / 2
      return below ? cy > cur.cy + 0.5 : cy < cur.cy - 0.5
    })
    if (!cands.length) return
    // 世界包围盒与垂直距离工具
    const rect = (n: Text) => {
      const p = n.getWorldPoint()
      return { left: p.x, right: p.x + n.width, cy: p.y + n.height / 2 }
    }
    const distY = (n: Text) => Math.abs(rect(n).cy - cur.cy)
    let best: Text | null = null
    let bestScore = Infinity
    // 第一优先：水平区间与当前节点重叠（正上/正下），垂直距离最近者
    for (const n of cands) {
      const r = rect(n)
      if (r.left < cur.right && r.right > cur.left && distY(n) < bestScore) {
        bestScore = distY(n)
        best = n
      }
    }
    // 第二优先：斜上/斜下，按 水平间距 + 垂直距离 度量取最近（列相邻性优先于微小的高度差）
    if (best === null) {
      for (const n of cands) {
        const r = rect(n)
        const dx = Math.max(0, cur.left - r.right, r.left - cur.right)
        const d = dx + distY(n)
        if (d < bestScore) {
          bestScore = d
          best = n
        }
      }
    }
    if (best) this.activate(best)
  }

  // 递归收集子树内全部文本节点（元函数：被 navigateVertical 调用）
  private collectTexts(node: Text, out: Text[]) {
    out.push(node)
    node.children.forEach(child => this.collectTexts(child as Text, out))
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
    // 激活高亮环最后加入，保证绘制在节点与连线之上
    this.app.add(this.highlight)
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

  // 编辑框按键两态机（飞书模型）——以 DOM 类名为唯一状态来源（覆盖层常驻，blur/唤醒随时切换外观）：
  // 激活态（passive 类，文字透明、由 canvas 渲染）：方向键拦截并切换节点；打字/IME/点击唤醒编辑态交还默认行为
  // 编辑态（覆盖层文字可见，canvas 停止渲染）：方向键移动光标；Tab 建子节点；Enter/Escape 提交（切回激活态视觉）
  private bindNodeKeys(el: HTMLDivElement, text: Text) {
    // 唤醒为编辑态：canvas 停止渲染文字；fill 为 true（点击进入）时填入节点文本做正常编辑，
    // 打字/IME/粘贴进入则保持空覆盖层（输入内容经 input 同步替换节点文本）
    const wake = (fill = false) => {
      this.editor.beginEdit(fill)
      this.setHighlightEditing(true)
    }
    el.addEventListener('keydown', (e) => {
      const passive = el.classList.contains('silker-text-passive')
      // 临时诊断日志（复现问题后移除）
      console.log('[SilkerKeys] keydown', JSON.stringify(e.key), 'keyCode=', e.keyCode, 'passive=', passive)
      if (passive && e.key.startsWith('Arrow')) {
        // 激活态方向键：接管为节点导航（覆盖层随 activate 转移到新节点）
        e.preventDefault()
        this.navigate(e.key)
        return
      }
      if (passive && e.key === 'Escape') {
        e.preventDefault()
        this.editor.enterPassive()
        return
      }
      if (passive && e.key === 'Enter') {
        // 激活态回车：新建兄弟节点（编辑态回车才是提交）
        e.preventDefault()
        void this.createRelated(e, text)
        return
      }
      if (passive && (e.key === 'Delete' || e.key === 'Backspace')) {
        // 激活态删除：删掉节点及其子树（编辑态下删除键交给默认文本删除）
        e.preventDefault()
        void this.deleteNode(text)
        return
      }
      // 可打印字符或 IME 组合键：仅唤醒为编辑态（canvas 停止渲染文字），不吞键 ——
      // 打字/组合直接落入空覆盖层，经 input 同步替换节点文本
      if (passive && (e.key.length === 1 || e.key === 'Process' || e.keyCode === 229)) {
        wake()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        // 覆盖层常驻：节点切换由 activate → editor.start 完成卸载重建，无需先失焦
        void this.createRelated(e, text)
      } else if (e.key === 'Enter' || e.key === 'Escape') {
        // 阻止换行，提交 = 切回激活态视觉（覆盖层保持挂载可编辑，IME 不被打断），高亮环切回蓝色
        e.preventDefault()
        this.editor.enterPassive()
        this.setHighlightEditing(false)
      }
    })
    // 打字/组合/粘贴：空覆盖层唤醒（输入替换节点文本）；点击：填入节点文本正常编辑
    el.addEventListener('input', () => wake())
    el.addEventListener('compositionstart', () => wake())
    el.addEventListener('mousedown', () => wake(true))
  }

  // Tab 创建子节点、Enter 在当前节点下方创建兄弟节点，随后进入编辑并重布局
  // （编辑态由 bindNodeKeys 调用，激活态由 onGlobalKeydown 以合成事件调用）
  private async createRelated(e: KeyboardEvent, text: Text) {
    console.log('[MindMap] createRelated', e.key, 'from:', text.text)
    const isChild = e.key === 'Tab'
    const parent = isChild ? text : (text.parent as Text | null) ?? text
    // 新节点按级数取样式：Tab 建子节点深度 +1，Enter 建兄弟节点深度不变
    const style = this.newNodeStyle(text, this.depthOf(text) + (isChild ? 1 : 0))
    const node = this.createNode(text, style)
    this.nodeStyles.set(node, style)
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
    // 新节点进入激活态（常驻覆盖层，打字即编辑）
    this.activate(node)
  }

  // 删除节点及其整个子树（根节点不可删除）：摘除子树、清理关联连线，重布局后激活父节点
  private async deleteNode(text: Text) {
    if (!this.root || text === this.root) return
    // 收集子树内全部节点
    const subtree = new Set<Node>()
    const collect = (n: Node) => {
      subtree.add(n)
      n.children.forEach(collect)
    }
    collect(text)
    // 从父节点摘除子树（子孙随子树一起离开渲染树）
    const parent = text.parent as Text
    parent.remove(text)
    // 清理起点或终点在子树内的连线，并从渲染树移除
    const dead = this.edges.filter(e => subtree.has(e.fromNode) || subtree.has(e.toNode))
    this.edges = this.edges.filter(e => !dead.includes(e))
    dead.forEach(e => {
      const i = this.app.children.indexOf(e)
      if (i !== -1) this.app.children.splice(i, 1)
    })
    // 清空指向被删节点的激活态，重布局后激活父节点（activate 会重建覆盖层，旧覆盖层随之卸载）
    this.active = null
    this.highlight.target = null
    await this.relayout()
    this.activate(parent)
  }

  // 节点在树中的级数（根节点为 0），由 parent 链向上回溯
  private depthOf(node: Text): number {
    let depth = 0
    let p = node.parent as Text | null
    while (p) {
      depth++
      p = p.parent as Text | null
    }
    return depth
  }

  // 新节点样式解析：配置了级数样式按级数取值，否则沿用参考节点的实际样式（旧行为）
  private newNodeStyle(ref: Text, depth: number): Style {
    if (this.levelStyles.length) return this.levelStyle(depth)
    return this.nodeStyles.get(ref) ?? defaultStyle
  }

  // 按解析出的样式创建默认新节点，宽度范围与参考节点保持一致（元函数：样式构造）
  private createNode(ref: Text, style: Style): Text {
    return this.createText('新节点', style, ref.widthRange ?? [0, 200])
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
  // 样式解析优先级：节点数据 style > levelStyles[depth]（超出配置长度套用最后一项）> 兜底样式
  renderNode(data: MindMapNode, depth = 0): Text {
    const style = data.style ?? this.levelStyle(depth)
    const text = this.createText(data.text, style)
    this.nodeStyles.set(text, style)
    // 递归调用自身，将每个子数据转成子节点并挂到当前节点下
    data.children.forEach(child => text.add(this.renderNode(child, depth + 1)))
    return text
  }

  // 按级数取样式配置，超出配置长度时套用最后一项，未配置时兜底
  private levelStyle(depth: number): Style {
    if (!this.levelStyles.length) return defaultStyle
    return this.levelStyles[Math.min(depth, this.levelStyles.length - 1)]
  }

  // 由样式配置构造 Text 节点（renderNode 与新建节点共用，保证两处映射一致）
  private createText(text: string, style: Style, widthRange?: [number, number]): Text {
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
    })
  }
}