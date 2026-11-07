import type { App, Text } from "@silker/core";
import type { HistoryCapability } from "@silker/plugin-history";
import type { SelectionCapability } from "@silker/plugin-selection";
import type { TextEditorCapability } from "@silker/plugin-text-editor";
import type { ActiveHighlight } from "./ActiveHighlight";
import type { MindMapChangeType } from "./types";

// 高亮环两态颜色：激活（未编辑）蓝色，编辑紫色
export const ACTIVE_COLOR = "#3b82f6";
export const EDITING_COLOR = "#a855f7";

export interface ActivationDeps {
  app: App;
  editor: TextEditorCapability;
  highlight: ActiveHighlight;
  sel: Pick<SelectionCapability<Text>, "items" | "set" | "clear">;
  history: Pick<HistoryCapability, "record">;
  // 激活态方向键导航（键盘模块提供）
  onNavigate: (key: string) => void;
  // Tab/Enter 新建节点（操作模块提供）
  onCreateRelated: (e: KeyboardEvent, text: Text) => void;
  // 激活态删除选中（操作模块提供）
  onDelete: () => void;
  // 覆盖层左键按下：与画布按下共用拖拽上下文（拖拽模块提供）
  onNodePress: (e: MouseEvent) => void;
  emitChange: (type: MindMapChangeType) => void;
}

// 激活/编辑控制器：单选激活态与编辑态的两态机（原 MindMap 内联逻辑）。
// editing 为编辑态唯一状态来源（覆盖层常驻、显隐由本状态驱动），editingOld 为编辑会话起点快照
export class ActivationController {
  // 编辑态（唯一状态来源，覆盖层常驻、显隐由本状态驱动）：激活态为 false（方向键导航、
  // Enter/Escape/Delete 走节点操作），打字/IME/粘贴/点击唤醒为 true（按键交给覆盖层默认行为）。
  // 失焦、提交（Enter/Escape）与覆盖层移除时复位
  editing = false;
  // 编辑会话起点快照（仅节点引用与原文字符串，非整树快照）：onEditStart 记录，
  // onEditEnd 对比决定是否把文本变更记入历史
  private editingOld: { node: Text | null; text: string } = {
    node: null,
    text: "",
  };

  constructor(private deps: ActivationDeps) {}

  // 单选派生：多选或无选中时为 null（Tab/Enter、打字唤醒仅单选生效）
  get active(): Text | null {
    return this.deps.sel.items.length === 1
      ? (this.deps.sel.items[0] as Text)
      : null;
  }

  // 单选激活（覆盖层 + 高亮环 + 视口跟随），语义化入口
  activate(text: Text) {
    // 覆盖层隐藏态沉底后点击会穿透到画布：唤醒编辑（mouseup）后的同节点 click 不再重复激活，
    // 避免重建覆盖层打断刚进入的编辑
    if (text === this.active && this.deps.editor.hasFocus()) return;
    this.setSelection([text]);
  }

  // 唤醒编辑态：显示覆盖层接管文字渲染（fill 填入节点文本、point 定位光标），高亮环切编辑色
  wake(fill = false, point?: { x: number; y: number }) {
    this.deps.editor.show({ fill, point });
    this.editing = true;
    this.setHighlightEditing(true);
  }

  // 取消激活：清空选中集合与高亮环，移除常驻覆盖层（文字交还 canvas 渲染）
  deactivate() {
    if (!this.deps.sel.items.length) return;
    this.deps.sel.clear();
    this.deps.highlight.targets = [];
    this.deps.editor.stop();
    this.deps.app.requestRender();
  }

  // 批量设置选中（单选/多选统一入口）：
  // 单选进入激活态（常驻覆盖层 + 高亮环，必要时平移视口）；多选仅多目标高亮环，无覆盖层
  setSelection(nodes: Text[]) {
    if (!nodes.length) {
      this.deactivate();
      return;
    }
    this.deps.sel.set(nodes);
    this.deps.highlight.targets = [...nodes];
    this.deps.highlight.color = ACTIVE_COLOR;
    if (nodes.length === 1) {
      this.deps.editor.start(nodes[0]);
      this.scrollNodeIntoView(nodes[0]);
    } else {
      // 多选态没有编辑框，退出可能残留的单选覆盖层
      this.deps.editor.stop();
    }
    this.deps.app.requestRender();
  }

  // 编辑会话开始（TextEditor onEditStart 回调入口）
  onEditStart(el: HTMLDivElement, text: Text) {
    // 覆盖层挂载即回到激活态（编辑态由后续打字/点击重新唤醒）
    this.editing = false;
    // 编辑会话起点：定格节点与原文，编辑结束对比决定是否记入历史
    // （覆盖层编辑是持续同步输入，无法在单次 input 边界判定"一次变更"）
    this.editingOld = { node: text, text: text.text };
    this.bindNodeKeys(el, text);
  }

  // 编辑会话结束（TextEditor onEditEnd 回调入口）：失焦切回隐藏态时同步高亮环颜色并复位
  // 编辑态；编辑结束视为一次文本变更
  onEditEnd() {
    this.editing = false;
    this.setHighlightEditing(false);
    // 文本相对会话起点确有变化才记历史：newText 取编辑结束时的节点文本
    // （此时覆盖层内容已同步进节点）；record 仅入栈不执行，因变更已发生
    const old = this.editingOld;
    if (old.node && old.node.text !== old.text) {
      const node = old.node;
      const before = old.text;
      const after = node.text;
      this.deps.history.record({
        type: "text",
        redo: () => {
          node.text = after;
        },
        undo: () => {
          node.text = before;
        },
      });
    }
    this.deps.emitChange("text");
  }

  // 键位分发守卫：onGlobalKeydown 与命令插件共用。覆盖层持焦时普通按键由其 keydown
  // 处理器接管；修饰键组合（Ctrl/Cmd/Alt）仍走全局分发——否则激活态覆盖层会把
  // Ctrl+C 的 "c" 当可打印字符唤醒编辑态。编辑态下撤销/复制交给输入框原生行为，
  // 组合键一律不拦。仅响应画布、页面空白处与覆盖层（未编辑时）的按键，页面其它控件输入不受影响
  keymapGuard(e: KeyboardEvent): boolean {
    if (
      this.deps.editor.hasFocus() &&
      (this.editing || !(e.ctrlKey || e.metaKey || e.altKey))
    ) {
      return false;
    }
    const target = e.target as HTMLElement;
    return (
      this.deps.editor.hasFocus() ||
      target === document.body ||
      target === this.deps.app.canvas
    );
  }

  // 按编辑状态切换高亮环颜色并重绘（激活蓝色 / 编辑紫色）
  private setHighlightEditing(editing: boolean) {
    this.deps.highlight.color = editing ? EDITING_COLOR : ACTIVE_COLOR;
    this.deps.app.requestRender();
  }

  // 激活节点越出屏幕时平移视口（编辑由 editor.start 自带滚动，此处仅覆盖键盘导航）
  private scrollNodeIntoView(text: Text) {
    const vp = this.deps.app.camera.viewport;
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
    this.deps.app.camera.setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy });
    this.deps.app.requestRender();
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
        this.deps.onNavigate(e.key);
        return;
      }
      if (passive && e.key === "Escape") {
        e.preventDefault();
        this.deps.editor.hide();
        return;
      }
      if (passive && e.key === "Enter") {
        // 激活态回车：新建兄弟节点（编辑态回车才是提交）
        e.preventDefault();
        void this.deps.onCreateRelated(e, text);
        return;
      }
      if (passive && (e.key === "Delete" || e.key === "Backspace")) {
        // 激活态删除：删掉选中集合（单选即当前节点）及其子树（编辑态下删除键交给默认文本删除）
        e.preventDefault();
        void this.deps.onDelete();
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
        void this.deps.onCreateRelated(e, text);
      } else if (e.key === "Enter" || e.key === "Escape") {
        // 阻止换行，提交 = 切回激活态（覆盖层隐藏并保持挂载可编辑，IME 不被打断），高亮环切回蓝色
        e.preventDefault();
        this.deps.editor.hide();
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
      this.deps.onNodePress(e);
    });
  }
}
