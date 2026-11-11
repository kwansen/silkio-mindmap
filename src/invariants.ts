// 包内不变量断言：把此前只靠注释纪律维持的隐式契约（连线表只经原语变更、
// 命令 redo/undo 的挂载/摘除对称、节点父子关系与命令定格一致等）提为运行期
// 显式校验。违例即抛错——这类错误静默延续会腐蚀历史重放与场景一致性
//（连线丢失/节点重复挂载/undo 回到错误位置），尽早暴露优于静默脏数据。
// 断言只捕获编程错误（纪律被绕开、时序被破坏），不校验用户输入；
// 宿主可在生产环境经 setInvariantsEnabled(false) 关闭（关闭后仅剩调用开销）
let enabled = true;

export function setInvariantsEnabled(value: boolean) {
  enabled = value;
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (enabled && !condition) throw new Error(`[mindmap] 不变量违例: ${message}`);
}
