import { App, EdgePan, Text } from "@silker/core";
import type { Node } from "@silker/core";
import type { ViewportCapability } from "@silker/core";
import type { HistoryCapability, HistoryCommand } from "@silker/core";
import { POINTER_CAPABILITY } from "@silker/core";
import type { SelectionCapability } from "@silker/core";
import { DragGhost } from "./DragGhost";
import type { ActiveHighlight } from "./ActiveHighlight";
import { dropIndex, dropTarget } from "./drop";
import { ACTIVE_COLOR } from "./editing";
import type { ActivationController } from "./editing";
import type { CollapseController } from "./collapse";
import type { KeyboardNav } from "./keyboard";
import type { MindEdge } from "./Edge";
import type { MindTree } from "./model";
import type { MindMapChangeType, Style, LayoutDirection } from "./types";

// 拖拽上下文：起点（屏幕/世界）、拖动的子树根、起始局部坐标与合集原始包围盒
export interface DragState {
  startScreen: { x: number; y: number };
  startWorld: { x: number; y: number };
  nodes: Text[];
  origins: { x: number; y: number }[];
  // 鼠标按下的节点及其原始包围盒（合集虚影克隆它并以其为跟随锚点）
  grabNode: Text;
  grabBox: { x: number; y: number; w: number; h: number };
  // 最近一次鼠标屏幕坐标（边缘自动平移的 rAF 循环无鼠标事件时据此重算虚影位置）
  lastScreen: { clientX: number; clientY: number };
}

export interface DragDeps {
  app: App;
  model: MindTree;
  ghost: DragGhost;
  highlight: ActiveHighlight;
  history: Pick<HistoryCapability, "exec">;
  sel: Pick<SelectionCapability<Text>, "items" | "has" | "beginMarquee" | "marqueeActive">;
  // 视口能力：根节点按下改为经视口能力平移画布
  pan: Pick<ViewportCapability, "beginPan"> | null;
  collapse: Pick<CollapseController, "hit" | "toggle" | "onMove" | "onLeave">;
  activation: Pick<ActivationController, "deactivate" | "wake" | "setSelection">;
  keyboard: Pick<KeyboardNav, "onGlobalKeydown">;
  direction: LayoutDirection;
  onRelayout: () => Promise<void> | void;
  emitChange: (type: MindMapChangeType) => void;
}

// 左键拖拽交互：拖拽换父（拖拽上下文/虚影反馈/落点判定/落点提交）、框选绑定、
// 边缘自动平移与命中工具（原 MindMap 内联逻辑）
export class DragInteractions {
  // 拖拽上下文（非空即拖拽进行中，undo/redo 等入口据此避让）
  dragState: DragState | null = null;
  dragMoved = false;
  // 按下命中唯一激活节点（激活态覆盖层沉底，按下必落在画布）：未超阈值松手视为点击进入编辑，
  // 而非画布 click 激活流程
  pressOnActive = false;
  // 覆盖层上的按下位置（未建立拖拽上下文时用，如根节点）：mouseup 按位移区分点击与拖动
  overlayDown: { x: number; y: number } | null = null;
  // 根节点按下暂存的平移起点：位移超阈值才真正 beginPan 并切换光标，
  // 按下瞬间不改样式，避免点击激活/编辑时光标闪烁
  pendingPan: { x: number; y: number } | null = null;
  // 拖拽合集虚影：克隆首个被拖节点样式，半透明跟随鼠标
  dragChip: Text | null = null;
  // 拖拽中原位节点文字的原始颜色（拖拽期间转暗色，结束后恢复）
  dragFills = new Map<Text, string>();
  // 悬浮命中合并到帧：hoverTargets 是 O(n) 树遍历（每节点 getWorldPoint 矩阵链），
  // 真实鼠标 move 可达 125Hz+，逐事件执行会打满主线程饿死 rAF（拖拽冻结、松手瞬移）
  private hoverFrame = 0;
  private pendingHover: { x: number; y: number } | null = null;
  // 边缘自动平移（core 机制）：拖拽中指针贴近画布边缘时持续平移视口，每次平移
  // 后重算虚影/落点跟随（core 已负责相机-only 呈现，这里只重算跟随物）
  private edgePan: EdgePan;

  constructor(private deps: DragDeps) {
    this.edgePan = new EdgePan(deps.app, (x, y) => this.updateDrag({ clientX: x, clientY: y }));
  }

  // 左键交互（框选 + 拖拽换父）：
  // 按下命中已选中节点 → 拖拽上下文，超阈值后整组选中子树跟随移动，松手落点有效则换父；
  // 按下空白或未选中节点 → 框选上下文，超阈值显示选框，松手批量激活相交节点；
  // 未超阈值的普通点击不处理，交给节点激活/空白取消逻辑
  bind() {
    // 统一指针监听：绑定/撤销与屏幕→世界坐标换算由指针能力承担（机制层），
    // 本场景只声明各事件的交互策略；返回撤销函数由门面并入 cleanups 统一管理
    const pointer = this.deps.app.require(POINTER_CAPABILITY);
    const unbind = pointer.bind(this.deps.app.canvas, {
      onDown: (e, w) => {
        if (e.button !== 0) return;
        // 折叠开关命中优先于节点拖拽/框选
        const toggle = this.deps.collapse.hit(w);
        if (toggle) {
          void this.deps.collapse.toggle(toggle);
          return;
        }
        const hit = this.hitText(w);
        // 命中已选中节点：进入拖拽（根节点不可拖动，剔除后为空则退回框选）
        if (this.tryStart(e, hit)) return;
        // 未建立拖拽上下文但命中已选中节点（如根节点）：记录按下位置供 mouseup 判定点击进入编辑
        if (hit && this.deps.sel.has(hit)) {
          this.overlayDown = { x: e.clientX, y: e.clientY };
        }
        // 根节点不可拖拽：按下仅暂存平移起点，位移超阈值后才经视口能力开始平移
        // （beginPan 会切换 grabbing 光标，提前切换会让点击激活/编辑出现光标闪烁）
        if (hit === this.deps.model.root) {
          this.pendingPan = { x: e.clientX, y: e.clientY };
          return;
        }
        // 空白按下：框选会话由选中插件接管（橡皮筋 + 松手落定多选）
        this.deps.sel.beginMarquee(e);
      },
      // 悬浮驱动展开态开关显隐（状态属主为折叠控制器）
      onCanvasMove: (_e, w) => {
        // 框选会话中跳过悬浮检测：hoverTargets 是 O(n) 矩阵链树遍历，节点多时
        // 与框选命中叠加会打满每帧预算；橡皮筋期间开关悬浮无交互意义
        if (this.deps.sel.marqueeActive) return;
        // 合并到每帧最多一次悬浮命中检测，事件只记录最新位置
        this.pendingHover = w;
        if (this.hoverFrame) return;
        this.hoverFrame = requestAnimationFrame(() => {
          this.hoverFrame = 0;
          if (this.pendingHover) this.deps.collapse.onMove(this.pendingHover);
        });
      },
      onCanvasLeave: () => this.deps.collapse.onLeave(),
      onWindowMove: (e) => {
        // 根节点按下的延迟平移：位移超过阈值才真正开始平移（同时切换 grabbing 光标），
        // 阈值与节点拖拽一致；beginPan 以当前事件为起点，阈值内的微小位移不计入
        if (this.pendingPan) {
          if (
            Math.hypot(
              e.clientX - this.pendingPan.x,
              e.clientY - this.pendingPan.y,
            ) <= 3
          )
            return;
          this.pendingPan = null;
          this.deps.pan?.beginPan(e);
          return;
        }
        const drag = this.dragState;
        if (!drag) return;
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
          this.deps.activation.deactivate();
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
          this.deps.highlight.targets = [...targets];
          drag.nodes.forEach((n) => {
            this.dragFills.set(n, n.fill);
            n.fill = "#4b5563";
          });
          this.deps.highlight.dashed = true;
          this.deps.highlight.color = "blue";
          // 合集虚影克隆鼠标按下的节点（框选多个时拖的是按住的那个，而非集合第一个）
          this.dragChip = this.cloneTextStyle(drag.grabNode);
          this.dragChip.opacity = 0.5;
          this.deps.ghost.add(this.dragChip);
        }
        // 节点本体不再跟随移动，由反馈层代替：合集虚影 = 按下节点原始包围盒 + 拖拽位移
        // （虚影/落点计算在 updateDrag，与边缘自动平移共用）
        drag.lastScreen = { clientX: e.clientX, clientY: e.clientY };
        // 边缘自动平移：记录指针位置并确保会话循环在跑（首帧即启动，幂等）
        this.edgePan.start(e.clientX, e.clientY);
        this.updateDrag(e);
      },
      onWindowUp: (e) => {
        // 根节点按下未达到平移阈值即松手：清掉暂存的平移起点，交给点击编辑判定
        this.pendingPan = null;
        const drag = this.dragState;
        if (drag) {
          this.dragState = null;
          // 未超阈值的普通点击：按在唯一激活节点上时进入编辑，其余交给 click 激活流程
          if (!this.dragMoved) {
            this.dragMoved = false;
            if (this.pressOnActive) {
              this.pressOnActive = false;
              this.deps.activation.wake(true, { x: e.clientX, y: e.clientY });
            }
            return;
          }
          this.dragMoved = false;
          this.pressOnActive = false;
          void this.commitDrop(drag.nodes, this.deps.ghost.target);
          return;
        }
        // 按下未建立拖拽上下文的已选中节点（如根节点）：无位移视为点击进入编辑
        const down = this.overlayDown;
        this.overlayDown = null;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 3) {
          this.deps.activation.wake(true, { x: e.clientX, y: e.clientY });
        }
      },
      // 激活态键盘导航：方向键切换节点、Tab/Enter 新建、打字进入编辑（编辑态由编辑框自身处理按键）
      onKeydown: (e) => this.deps.keyboard.onGlobalKeydown(e),
    });
    // 卸载时取消挂起的悬浮检测帧，避免解绑后仍回调 collapse.onMove
    return () => {
      if (this.hoverFrame) {
        cancelAnimationFrame(this.hoverFrame);
        this.hoverFrame = 0;
      }
      this.pendingHover = null;
      unbind();
    };
  }
  // 覆盖层左键按下：与画布按下共用拖拽上下文（覆盖层恰好盖住激活节点，命中即它本身），
  // 根节点不可拖时仅记录按下位置供 mouseup 判定点击
  onOverlayDown(e: MouseEvent) {
    if (!this.tryStart(e, this.hitText(this.deps.app.camera.toWorld(e.clientX, e.clientY)))) {
      this.overlayDown = { x: e.clientX, y: e.clientY };
    }
  }

  // 命中可拖节点时建立拖拽上下文（画布按下与覆盖层按下共用），未命中或不可拖返回 false：
  // 命中已选中节点 → 拖整组选中子树；命中未选中节点 → 无需先激活，单独拖它；
  // 根节点不可拖（无父可换），返回 false 交回平移/点击编辑/框选流程
  tryStart(e: MouseEvent, hit: Text | null): boolean {
    if (!hit) return false;
    // 根节点不可拖动（无父可换），按下走视口平移
    if (hit === this.deps.model.root) return false;
    if (!this.deps.sel.has(hit)) {
      // 未选中的节点：拖动即单独拖它；未超阈值松手仍走 click 激活流程（不进编辑）
      this.startDrag(e, [hit], hit);
      this.pressOnActive = false;
      return true;
    }
    const nodes = [...this.deps.sel.items].filter((n) => n !== this.deps.model.root);
    if (!nodes.length) return false;
    this.startDrag(e, nodes, hit);
    this.pressOnActive = this.deps.sel.items.length === 1;
    return true;
  }

  // 建立拖拽上下文：定格起点、记录各节点原位与按下节点包围盒
  private startDrag(e: MouseEvent, nodes: Text[], grabNode: Text) {
    const grabP = grabNode.getWorldPoint();
    this.dragState = {
      startScreen: { x: e.clientX, y: e.clientY },
      startWorld: this.deps.app.camera.toWorld(e.clientX, e.clientY),
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
    const cur = this.deps.app.camera.toWorld(pos.clientX, pos.clientY);
    const dx = cur.x - drag.startWorld.x;
    const dy = cur.y - drag.startWorld.y;
    this.deps.ghost.floatBox = {
      x: drag.grabBox.x + dx,
      y: drag.grabBox.y + dy,
      w: drag.grabBox.w,
      h: drag.grabBox.h,
    };
    // 合集虚影跟随鼠标
    if (this.dragChip) {
      this.dragChip.x = this.deps.ghost.floatBox!.x;
      this.dragChip.y = this.deps.ghost.floatBox!.y;
    }
    // 候选落点：命中时跳过被拖子树，取其下方的真实目标
    const subtree = new Set<Node>();
    const collect = (n: Node) => {
      subtree.add(n);
      n.children.forEach(collect);
    };
    drag.nodes.forEach(collect);
    const t = dropTarget(
      this.deps.app.children,
      this.deps.ghost.floatBox,
      subtree,
      this.deps.direction,
      (n) => this.deps.model.sideOf(n),
      this.deps.model.root,
    );
    this.deps.ghost.target = t;
    // 拖拽反馈（虚影/落点连线）均为覆盖层：轻量路径，不重光栅化场景
    this.deps.app.requestOverlayRender();
  }

  // 世界坐标命中的最上层文本节点（选框/高亮环等辅助节点不参与命中）
  // exclude 为被拖子树：拖动中鼠标点总是压在被拖节点上，需跳过它们取其下方的真实目标
  hitText(
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
    this.deps.app.children.forEach(walk);
    for (let i = hits.length - 1; i >= 0; i--) {
      if (!exclude || !exclude.has(hits[i])) return hits[i];
    }
    return null;
  }

  // 克隆节点样式（文本、字体、盒样式等，不含位置与层级），用于拖拽合集的透明虚影
  cloneTextStyle(src: Text): Text {
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

  // 落点提交：有效目标时把拖动子树顶层节点挂到目标节点下（换父并换线），随后重布局落定；
  // 无有效目标则仅恢复不透明度并重布局（回到原位，相当于取消）
  async commitDrop(nodes: Text[], target: Text | null) {
    // 拖拽会话结束：停止边缘自动平移
    this.edgePan.stop();
    // 拖拽合集中心点：决定在目标子节点列表中的插入位置（横向按 y、纵向按 x 排序，
    // 清空反馈层前先定格；无合集盒时兜底 Infinity 追加到末尾）
    const f = this.deps.ghost.floatBox;
    const dropPoint = f
      ? { x: f.x + f.w / 2, y: f.y + f.h / 2 }
      : { x: Infinity, y: Infinity };
    // 恢复文字颜色与高亮环样式，清空拖拽反馈层
    this.dragFills.forEach((fill, n) => (n.fill = fill));
    this.dragFills.clear();
    this.deps.highlight.dashed = false;
    this.deps.highlight.color = ACTIVE_COLOR;
    this.deps.ghost.floatBox = null;
    this.deps.ghost.target = null;
    if (this.dragChip) {
      this.deps.ghost.remove(this.dragChip);
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
        this.deps.model.applyCollapseVisibility();
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
        // 基于落点中心位置插入到目标子节点列表的对应位置，而非一律追加到最后
        let newIndex = insertIndex.get(parent) ?? dropIndex(parent, dropPoint, this.deps.direction);
        insertIndex.set(parent, newIndex + 1);
        // 同父移动：落点序号按原布局含自身统计，落在原位置之后时需扣掉自身；
        // 扣除后与原位置相同则确实无变化，跳过
        if (old === parent) {
          if (newIndex > old.children.indexOf(n)) newIndex--;
          if (newIndex === old.children.indexOf(n)) continue;
          const edge = this.deps.model.edges.find(
            (e) => e.fromNode === old && e.toNode === n,
          )!;
          moves.push({
            node: n,
            oldParent: old,
            oldIndex: old.children.indexOf(n),
            newIndex,
            oldStyle: this.deps.model.nodeStyles.get(n)!,
            newStyle: this.deps.model.nodeStyles.get(n)!,
            oldEdge: edge,
            newEdge: edge,
          });
          continue;
        }
        // 换父后新级数 = 目标级数 + 1：按新级数默认样式与用户自定义样式合并定格
        // （未配置级数样式时 redo 跳过应用，保持原样，与旧行为一致）
        const newStyle = {
          ...this.deps.model.levelStyle(this.deps.model.depthOf(parent) + 1),
          ...this.deps.model.customStyles.get(n),
        };
        const oldEdge = this.deps.model.edges.find(
          (e) => e.fromNode === old && e.toNode === n,
        )!;
        moves.push({
          node: n,
          oldParent: old,
          oldIndex: old.children.indexOf(n),
          newIndex,
          oldStyle: this.deps.model.nodeStyles.get(n)!,
          newStyle,
          oldEdge,
          newEdge: this.deps.model.createEdge(parent, n),
        });
      }
      // 移动命令：多选目标合并为一条，undo 一次全回退（逆序插回，防同父索引失效）
      const cmd: HistoryCommand = {
        type: "move",
        redo: () => {
          for (const m of moves) {
            m.oldParent.remove(m.node);
            parent.attachChild(m.node, m.newIndex);
            // 换线：移除旧父连线，加入新父连线
            this.deps.model.edges = this.deps.model.edges.filter((e) => e !== m.oldEdge);
            this.deps.app.remove(m.oldEdge);
            this.deps.model.edges.push(m.newEdge);
            this.deps.app.add(m.newEdge);
            if (this.deps.model.levelStyles.length)
              this.deps.model.applyNodeStyle(m.node, m.newStyle);
          }
        },
        undo: () => {
          for (const m of [...moves].reverse()) {
            parent.remove(m.node);
            m.oldParent.attachChild(m.node, m.oldIndex);
            // 换线反向：移除新父连线，还原旧父连线
            this.deps.model.edges = this.deps.model.edges.filter((e) => e !== m.newEdge);
            this.deps.app.remove(m.newEdge);
            this.deps.model.edges.push(m.oldEdge);
            this.deps.app.add(m.oldEdge);
            this.deps.model.applyNodeStyle(m.node, m.oldStyle);
          }
        },
        // 序列化载荷：节点/父级/连线全部按 id 引用（同父多选时多条 move 共享
        // newParentId；连线经会话注册表按 id 去重，换父前后的连线引用保持同一实例）
        toJSON: () => ({
          kind: "mindmap.move",
          payload: {
            moves: moves.map((m) => ({
              nodeId: m.node.id,
              oldParentId: m.oldParent.id,
              oldIndex: m.oldIndex,
              newParentId: parent.id,
              newIndex: m.newIndex,
              oldStyle: m.oldStyle,
              newStyle: m.newStyle,
              oldEdgeId: m.oldEdge.id,
              newEdgeId: m.newEdge.id,
            })),
          },
        }),
      };
      this.deps.history.exec(cmd);
    }
    await this.deps.onRelayout();
    if (parent) this.deps.emitChange("move");
    // 拖拽后保持选中：单选回到激活态（覆盖层），多选保持批量选中
    this.deps.activation.setSelection(nodes);
  }
}
