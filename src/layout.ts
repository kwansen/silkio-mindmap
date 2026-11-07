import type { App, Node, Plugin } from "@silker/core"
import { AUTO_LAYOUT_CAPABILITY } from "./auto-layout"
import type { AutoLayoutCapability, AutoLayoutOptions } from "./auto-layout"

// 思维导图树形布局（官方实现）：参数契约见 ./auto-layout（AutoLayoutOptions），
// 实现直接采用能力契约类型，保证实现与契约天然一致
export function layout<T extends Node>(
  root: T,
  options: AutoLayoutOptions
): T {
  // 递归布局子树，返回子树内容相对节点顶部的纵向范围 [top, bottom]（top 可为负）
  function visit(node: Node): { top: number; bottom: number } {
    // 折叠节点视作叶子：子树不参与布局（保持原位，由可见性联动隐藏）
    if (node.collapsed || node.children.length === 0) {
      return { top: 0, bottom: node.height }
    }

    // 先递归布局各子树，拿到它们内容相对各自节点顶部的纵向范围
    const extents = node.children.map(child => visit(child))

    // 按内容实际占位高度纵向堆叠兄弟子树（而非递归高度），保证兄弟分支互不重叠
    let cursor = 0
    const offsets = node.children.map((child, i) => {
      const { top, bottom } = extents[i]
      const offset = cursor - top
      cursor += bottom - top + options.siblingGap
      return offset
    })
    const blockHeight = cursor - options.siblingGap

    // 将子节点块整体平移，使其相对父节点垂直居中
    const shift = (node.height - blockHeight) / 2
    node.children.forEach((child, i) => {
      child.x = options.direction === 'left'
        ? -(child.width + options.levelGap)
        : node.width + options.levelGap
      child.y = offsets[i] + shift
    })

    // 子树内容范围 = 节点自身与子节点块的并集
    return {
      top: Math.min(0, shift),
      bottom: Math.max(node.height, shift + blockHeight),
    }
  }

  visit(root)

  return root
}

// 官方布局插件：install 时自注册 mindmap.auto-layout 能力。第三方布局插件按能力键
// 注册同名能力覆盖官方实现（App.provide 替换 + uninstall 恢复），不 import 本插件
export class BuiltinTreeLayout implements Plugin {
  install(app: App) {
    const impl: AutoLayoutCapability = {
      layout: (root, options: AutoLayoutOptions) => {
        void layout(root, options)
      },
    }
    app.provide(AUTO_LAYOUT_CAPABILITY, impl, {
      provider: "mindmap.builtin-tree-layout",
    })
  }
}
