// 命令模式的历史记录：不存快照，只存可逆操作（命令自带 redo/undo，直接改树）
// type 用于 undo/redo 后触发 onChange，让宿主按变更类型持久化
export interface Command {
  readonly type: "add" | "delete" | "move" | "text";
  redo(): void;
  undo(): void;
}

// 历史记录管理器：undo/redo 双栈；容量上限 100，超出丢最旧（防长会话内存无界增长）
export class History {
  private static readonly LIMIT = 100;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  // 执行命令并记录：redo() 立即生效，入 undo 栈；新变更使既有重做分支失效，清空 redo 栈
  exec(cmd: Command): void {
    cmd.redo();
    this.record(cmd);
  }

  // 仅入栈不执行：用于"变更已发生"的场景（如文本编辑提交时节点文本已被覆盖层同步）
  record(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > History.LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  // 弹出 undo 栈顶执行 undo()，移入 redo 栈（返回命令供调用方取 type 触发 onChange）
  undo(): Command | undefined {
    const cmd = this.undoStack.pop();
    if (!cmd) return undefined;
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd;
  }

  redo(): Command | undefined {
    const cmd = this.redoStack.pop();
    if (!cmd) return undefined;
    cmd.redo();
    this.undoStack.push(cmd);
    return cmd;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
