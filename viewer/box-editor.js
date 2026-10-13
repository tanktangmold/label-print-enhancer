// 通用的可拖动矩形：拖框内移动、拖四角缩放（可锁比例）、空白处拖出新框、滚轮缩放、方向键微移。
// 坐标单位由调用方决定（这里用 mm）：host 元素的整个区域 = units.w × units.h。
import { rectFromPoints, zoomBox } from '../core/visual.js';

const CORNERS = ['nw', 'ne', 'sw', 'se'];
const MIN_SIZE_PX = 12;
const NUDGE = 0.5; // 方向键每次移动（单位），Shift ×10

function el(tag, className, parent) {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host  坐标空间（position: relative）
 * @param {() => {w:number,h:number}} opts.units  host 的尺寸（单位）
 * @param {{x,y,w,h}|null} opts.box  初始框
 * @param {boolean} opts.aspectLock  四角缩放是否锁定比例
 * @param {boolean} opts.allowDraw  空白处拖动是否画新框
 * @param {(box) => {box, guides?: {x?:boolean,y?:boolean}}} [opts.constrain]  移动/缩放后的修正（吸附、夹边）
 * @param {(box, info) => string} opts.readout  坐标文字
 * @param {(box, {final:boolean}) => void} opts.onChange
 */
export function createBoxEditor({ host, units, box: initial, aspectLock, allowDraw, constrain = (b) => ({ box: b }), readout, onChange, label }) {
  const layer = el('div', 'edit-layer', host);
  const guideV = el('div', 'edit-guide v', layer);
  const guideH = el('div', 'edit-guide h', layer);
  const frame = el('div', 'edit-box', layer);
  frame.tabIndex = 0;
  frame.setAttribute('role', 'group');
  if (label) frame.setAttribute('aria-label', label);
  const handles = Object.fromEntries(CORNERS.map((c) => [c, el('div', `edit-handle ${c}`, frame)]));
  const tip = el('div', 'edit-readout', frame);

  let box = initial;
  let drag = null;

  const toUnits = (ev) => {
    const r = host.getBoundingClientRect();
    const u = units();
    return { x: ((ev.clientX - r.left) / r.width) * u.w, y: ((ev.clientY - r.top) / r.height) * u.h };
  };
  const unitsPerPx = () => units().w / Math.max(1, host.getBoundingClientRect().width);

  function render(info = {}) {
    frame.hidden = !box;
    guideV.hidden = !info.guides?.x;
    guideH.hidden = !info.guides?.y;
    if (!box) return;
    const u = units();
    Object.assign(frame.style, {
      left: `${(box.x / u.w) * 100}%`,
      top: `${(box.y / u.h) * 100}%`,
      width: `${(box.w / u.w) * 100}%`,
      height: `${(box.h / u.h) * 100}%`,
    });
    tip.textContent = readout(box, info);
  }

  function commit(next, final) {
    const fixed = constrain(next);
    box = fixed.box;
    render(fixed);
    onChange(box, { final, guides: fixed.guides ?? {} });
  }

  function resized(start, corner, p) {
    const right = corner.includes('e');
    const bottom = corner.includes('s');
    const ax = right ? start.x : start.x + start.w; // 对角固定点
    const ay = bottom ? start.y : start.y + start.h;
    const minSize = MIN_SIZE_PX * unitsPerPx();
    let w = Math.max(minSize, right ? p.x - ax : ax - p.x);
    let h = Math.max(minSize, bottom ? p.y - ay : ay - p.y);
    if (aspectLock) {
      const ratio = start.w / start.h;
      if (w / start.w > h / start.h) h = w / ratio;
      else w = h * ratio;
    }
    return { x: right ? ax : ax - w, y: bottom ? ay : ay - h, w, h };
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    const p = toUnits(ev);
    const corner = CORNERS.find((c) => ev.target === handles[c]);
    if (corner && box) drag = { kind: 'resize', corner, start: box, p0: p };
    else if (box && frame.contains(ev.target)) drag = { kind: 'move', start: box, p0: p };
    else if (allowDraw) drag = { kind: 'draw', p0: p };
    else return;
    ev.preventDefault();
    host.setPointerCapture(ev.pointerId);
    frame.focus({ preventScroll: true });
    host.classList.add('dragging-box');
  }

  function onPointerMove(ev) {
    if (!drag) return;
    const p = toUnits(ev);
    const u = units();
    if (drag.kind === 'move') commit({ ...drag.start, x: drag.start.x + p.x - drag.p0.x, y: drag.start.y + p.y - drag.p0.y }, false);
    else if (drag.kind === 'resize') commit(resized(drag.start, drag.corner, p), false);
    else commit(rectFromPoints(drag.p0, p, u.w, u.h), false);
  }

  function onPointerUp(ev) {
    if (!drag) return;
    const wasDraw = drag.kind === 'draw';
    drag = null;
    host.releasePointerCapture?.(ev.pointerId);
    host.classList.remove('dragging-box');
    const minSize = MIN_SIZE_PX * unitsPerPx();
    if (wasDraw && box && (box.w < minSize || box.h < minSize)) return; // 只是点了一下
    if (box) commit(box, true);
  }

  function onWheel(ev) {
    if (!box || !aspectLock) return;
    ev.preventDefault();
    const p = toUnits(ev);
    commit(zoomBox(box, ev.deltaY < 0 ? 1.02 : 1 / 1.02, p.x, p.y), true);
  }

  function onKey(ev) {
    if (!box) return;
    const step = ev.shiftKey ? NUDGE * 10 : NUDGE;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation(); // 别让外层把方向键当翻页
    commit({ ...box, x: box.x + d[0], y: box.y + d[1] }, true);
  }

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('wheel', onWheel, { passive: false });
  frame.addEventListener('keydown', onKey);
  render(box ? constrain(box) : {});

  return {
    get box() {
      return box;
    },
    /** 外部改了框（按钮、面板数值）：只刷新显示，不回调。 */
    set(next) {
      box = next;
      render(next ? constrain(next) : {});
    },
    refresh() {
      render(box ? constrain(box) : {});
    },
    destroy() {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('wheel', onWheel);
      layer.remove();
    },
  };
}
