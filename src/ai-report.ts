import type { SerializedCommand } from "@silkor/core";
import type { MindTree } from "./model";
import type {
  AddPayload,
  DeletePayload,
  EdgePayload,
  LayoutPayload,
  MovePayload,
  PastePayload,
  TextPayload,
} from "./history-payloads";

// 历史描述（AI history 操作的读取实现，纯函数，导出便于测试）：
// 把撤销/重做栈的序列化命令转为人类可读文案。
// 各 kind 命令的载荷形状统一取自 history-payloads.ts（与 commands.ts 生产端、
// history-codec.ts 消费端共享同一类型源）

// 把单条序列化命令转为可读描述："将「前端」改为「前端开发」"。
// 节点文本按 id 经模型解析（已删/已换树节点的文本从载荷内嵌数据读取）；
// 组合命令递归描述子命令并以分号连接；未知 kind 退化为 kind 字符串
export function describeHistoryCommand(
  s: SerializedCommand,
  model: Pick<MindTree, "nodeById">,
): string {
  // 载荷 id 可空（与运行时 Text.id 对齐），null 视为"已不存在的节点"
  const nodeText = (id: string | null | undefined): string =>
    (id ? model.nodeById(id)?.text : null) ?? "（已不存在的节点）";
  if (s.kind === "composite") {
    const p = s.payload as { children?: SerializedCommand[] } | null;
    const children = (p?.children ?? [])
      .map((c) => describeHistoryCommand(c, model))
      .filter(Boolean);
    return children.join("；") || s.kind;
  }
  switch (s.kind) {
    case "mindmap.text": {
      const p = s.payload as TextPayload;
      return `将「${p.before}」改为「${p.after}」`;
    }
    case "mindmap.add": {
      const p = s.payload as AddPayload;
      return `在「${nodeText(p.parentId)}」下添加「${p.node.text}」`;
    }
    case "mindmap.paste": {
      const p = s.payload as PastePayload;
      const first = p.inserts[0];
      if (!first) return "粘贴节点";
      const more =
        p.inserts.length > 1 ? ` 等 ${p.inserts.length} 个节点` : "";
      return `在「${nodeText(first.parentId)}」下粘贴「${first.node.text}」${more}`;
    }
    case "mindmap.delete": {
      const p = s.payload as DeletePayload;
      const first = p.captures[0];
      if (!first) return "删除节点";
      const more = p.captures.length > 1 ? ` 等 ${p.captures.length} 处` : "";
      return `删除「${first.node.text}」${more}`;
    }
    case "mindmap.move": {
      const p = s.payload as MovePayload;
      const m = p.moves[0];
      if (!m) return "移动节点";
      if (m.oldParentId === m.newParentId)
        return `调整「${nodeText(m.nodeId)}」的排序`;
      return `将「${nodeText(m.nodeId)}」移动到「${nodeText(m.newParentId)}」下`;
    }
    case "mindmap.layout": {
      const p = s.payload as LayoutPayload;
      return `调整布局方向为「${p.after}」`;
    }
    case "mindmap.edge": {
      const p = s.payload as EdgePayload;
      return `调整连线样式为「${p.after}」`;
    }
    case "mindmap.render":
      return "AI 重渲染整棵导图";
    default:
      return s.kind;
  }
}
