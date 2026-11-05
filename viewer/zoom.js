// 放大缩小：预览、框选、拖动调整、编辑 PDF 共用一个比例（相对「适合窗口」的大小）。
// 按钮 −/百分比/+，或按住 Ctrl 滚动滚轮；滚轮缩放时鼠标下面那一点保持不动。
const $ = (id) => document.getElementById(id);
export const ZOOM_STEPS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]);
const WHEEL_STEP = 40; // 滚轮（含触控板捏合）累计这么多 deltaY 换一档

/** 下一档 / 上一档比例（dir = 1 放大，-1 缩小）；不在档位上时跳到最近的一档。 */
export function nextZoom(current, dir) {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current + 1e-9) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-9) ?? ZOOM_STEPS[0];
}

/**
 * @param {object} opts
 * @param {(zoom: number) => void} opts.onChange  比例变了（同步调整好布局，之后才按鼠标位置回滚动）
 */
export function createZoom({ onChange }) {
  const stage = $('stage');
  let value = 1;
  let wheelAcc = 0;

  function render() {
    stage.style.setProperty('--zoom', String(value));
    $('zoomReset').textContent = `${Math.round(value * 100)}%`;
    $('zoomOut').disabled = value <= ZOOM_STEPS[0];
    $('zoomIn').disabled = value >= ZOOM_STEPS.at(-1);
  }

  /** 当前显示的页面元素和它所在的滚动区（编辑 PDF / 框选 / 预览·拖动调整）。 */
  function target() {
    const edit = $('editPage');
    if (edit.offsetParent) return { el: edit, scroller: $('editScroll') };
    const source = $('sourceWrap');
    if (source.offsetParent) return { el: source, scroller: stage };
    return { el: $('paperStage'), scroller: stage };
  }

  /** 改比例；点 (clientX, clientY)（默认滚动区中间）在页面上的位置缩放前后保持不动。 */
  function set(next, at = null) {
    if (next === value) return;
    const { el, scroller } = target();
    const sr = scroller.getBoundingClientRect();
    const p = at ?? { clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height / 2 };
    const r0 = el.getBoundingClientRect();
    const fx = (p.clientX - r0.left) / Math.max(1, r0.width);
    const fy = (p.clientY - r0.top) / Math.max(1, r0.height);
    value = next;
    render();
    onChange(value);
    const r1 = el.getBoundingClientRect();
    scroller.scrollLeft += r1.left + fx * r1.width - p.clientX;
    scroller.scrollTop += r1.top + fy * r1.height - p.clientY;
  }

  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); // 不让浏览器缩放整个页面
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < WHEEL_STEP) return;
    const dir = wheelAcc < 0 ? 1 : -1;
    wheelAcc = 0;
    set(nextZoom(value, dir), { clientX: e.clientX, clientY: e.clientY });
  }

  $('zoomIn').addEventListener('click', () => set(nextZoom(value, 1)));
  $('zoomOut').addEventListener('click', () => set(nextZoom(value, -1)));
  $('zoomReset').addEventListener('click', () => set(1));
  stage.addEventListener('wheel', onWheel, { passive: false });
  render();

  return {
    get value() {
      return value;
    },
    set,
  };
}
