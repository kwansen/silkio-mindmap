import { capabilityKey } from "@silker/core"
import type { Node } from "@silker/core"

// 自动布局能力：契约由 mindmap（Domain Core）定义，官方实现是 BuiltinTreeLayout
// 插件（install 时自注册），第三方布局插件按能力键注册同名能力覆盖官方实现
// （App.provide 替换 + uninstall 恢复），不与官方插件互相依赖

// 布局参数：direction 为布局方向（left 从右往左 / right 从左往左），
// levelGap 为父子水平间距，siblingGap 为兄弟垂直间距
export interface AutoLayoutOptions {
  direction: "left" | "right"
  levelGap: number
  siblingGap: number
}

// 自动布局能力契约：输入可见树的根节点，原地写入各节点世界坐标 x/y。
// 契约语义（实现方必须遵守）：
// 1. 折叠节点（collapsed === true）视作叶子：其子树不参与布局、坐标保持原样
//    （可见性由宿主 applyCollapseVisibility 统一联动，布局器不负责隐藏）
// 2. 只写 x/y，不改 width/height/collapsed/children 结构——尺寸重测是宿主的职责
// 3. 根节点自身的 x/y 不动，只排布后代
// 4. 同步签名：布局是纯计算，异步需求（如动画）由实现方在能力之外自行叠加
export interface AutoLayoutCapability {
  layout(root: Node, options: AutoLayoutOptions): void
}

// 能力键：消费方只认能力名与契约，不认提供方插件
export const AUTO_LAYOUT_CAPABILITY =
  capabilityKey<AutoLayoutCapability>("mindmap.auto-layout")
