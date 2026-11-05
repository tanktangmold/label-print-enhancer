// 页面列表（合并多个 PDF / 图片后的打印顺序）的纯操作。每页是一个引用：
//   { id, src: 第几个源文件, pageNo: 源文件里第几页（从 1 开始）, rotate: 这一页额外旋转 0/90/180/270 }
// 所有函数返回新数组，不改传入的数据。

const ROTATIONS = [0, 90, 180, 270];

/** 一个源文件的全部页面。makeId() 生成唯一 id。 */
export function makePages(srcIndex, count, makeId) {
  return Object.freeze(
    Array.from({ length: count }, (_, i) => Object.freeze({ id: makeId(), src: srcIndex, pageNo: i + 1, rotate: 0 })),
  );
}

/** 把 from 位置的页移到 to 位置（to 是移动后的下标）。 */
export function movePage(pages, from, to) {
  if (from === to || from < 0 || from >= pages.length) return pages;
  const target = Math.min(pages.length - 1, Math.max(0, to));
  const list = pages.filter((_, i) => i !== from);
  list.splice(target, 0, pages[from]);
  return Object.freeze(list);
}

export function removePage(pages, index) {
  if (index < 0 || index >= pages.length) return pages;
  return Object.freeze(pages.filter((_, i) => i !== index));
}

/** 复制一页放在它后面（新 id）。 */
export function duplicatePage(pages, index, id) {
  if (index < 0 || index >= pages.length) return pages;
  const list = [...pages];
  list.splice(index + 1, 0, Object.freeze({ ...pages[index], id }));
  return Object.freeze(list);
}

/** 顺时针旋转 delta 度（90 的倍数）。 */
export function rotatePage(pages, index, delta = 90) {
  if (index < 0 || index >= pages.length) return pages;
  return Object.freeze(
    pages.map((p, i) => {
      if (i !== index) return p;
      const rotate = (((p.rotate + delta) % 360) + 360) % 360;
      return Object.freeze({ ...p, rotate: ROTATIONS.includes(rotate) ? rotate : 0 });
    }),
  );
}

export function appendPages(pages, more) {
  return Object.freeze([...pages, ...more]);
}

/** 只留还在页面列表里的页的编辑内容（删页后清理）。 */
export function keepEditsFor(edits, pages) {
  const alive = new Set(pages.map((p) => p.id));
  return Object.freeze(Object.fromEntries(Object.entries(edits).filter(([id]) => alive.has(id))));
}
