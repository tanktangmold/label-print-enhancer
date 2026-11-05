// 撤销 / 重做：保存不可变的快照（页面列表、编辑内容、方案里的每页同位置对象）。
export function createHistory(limit = 50) {
  let past = [];
  let future = [];
  return {
    /** 改之前记一次当前状态。 */
    push(snapshot) {
      past = [...past, snapshot].slice(-limit);
      future = [];
    },
    /** 撤销：传入当前状态，返回要恢复到的状态（没有可撤销的返回 null）。 */
    undo(current) {
      if (!past.length) return null;
      const prev = past[past.length - 1];
      past = past.slice(0, -1);
      future = [...future, current];
      return prev;
    },
    redo(current) {
      if (!future.length) return null;
      const next = future[future.length - 1];
      future = future.slice(0, -1);
      past = [...past, current].slice(-limit);
      return next;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    clear() {
      past = [];
      future = [];
    },
  };
}
