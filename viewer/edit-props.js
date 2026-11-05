// 「编辑 PDF」下方的属性栏：按选中对象的类型显示可调项。只在选中对象变化时重建（输入时不重建，免得丢焦点）。
import { t } from '../core/i18n.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'value' || (k in node && typeof v !== 'string')) node[k] = v; // textarea 的内容只能走属性
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function field(labelKey, control) {
  return el('label', { class: 'prop' }, el('span', { text: t(labelKey) }), control);
}

function checkbox(labelKey, checked, onToggle, id) {
  const box = el('input', { type: 'checkbox', checked, id });
  box.addEventListener('change', () => onToggle(box.checked));
  return el('label', { class: 'prop check' }, box, el('span', { text: t(labelKey) }));
}

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} opts.tool  当前工具
 * @param {object|null} opts.selected  选中的对象
 * @param {boolean} opts.isGlobal  选中的是不是「每页同位置」对象
 * @param {false|'select'|'end'} [opts.focusText]  刚加的文字框：把焦点放进输入框（select=全选直接替换，end=光标放最后接着改）
 * @param {string} [opts.hintKey]  没选中时的提示词条
 * @param {(patch: object, o: {commit: boolean}) => void} opts.onEdit  改属性（commit=true 时记入撤销）
 * @param {(on: boolean) => void} opts.onToggleGlobal
 * @param {() => void} opts.onDelete
 */
export function renderProps(container, { tool, selected, isGlobal, focusText = false, hintKey, onEdit, onToggleGlobal, onDelete }) {
  if (!selected) {
    container.replaceChildren(el('p', { class: 'muted small prop-hint', text: t(hintKey ?? `edit.hint.${tool}`) }));
    return;
  }
  const items = [];
  const del = el('button', { type: 'button', class: 'btn small danger', id: 'propDelete', text: t('edit.prop.delete') });
  del.addEventListener('click', onDelete);

  if (selected.type === 'text') {
    const area = el('textarea', { id: 'propText', rows: '2', value: selected.text });
    area.addEventListener('input', () => onEdit({ text: area.value }, { commit: false }));
    area.addEventListener('change', () => onEdit({ text: area.value }, { commit: true }));
    const size = el('input', { type: 'number', id: 'propSize', min: '4', max: '200', step: '0.5', value: String(selected.size) });
    size.addEventListener('change', () => onEdit({ size: size.value }, { commit: true }));
    const color = el('input', { type: 'color', id: 'propColor', value: selected.color });
    color.addEventListener('input', () => onEdit({ color: color.value }, { commit: false }));
    color.addEventListener('change', () => onEdit({ color: color.value }, { commit: true }));
    items.push(
      field('edit.prop.text', area),
      field('edit.prop.size', size),
      field('edit.prop.color', color),
      checkbox('edit.prop.bold', selected.bold, (on) => onEdit({ bold: on }, { commit: true }), 'propBold'),
      checkbox('edit.prop.serif', selected.serif, (on) => onEdit({ serif: on }, { commit: true }), 'propSerif'),
      checkbox('edit.prop.cover', selected.cover, (on) => onEdit({ cover: on }, { commit: true }), 'propCover'),
    );
  }
  if (selected.type === 'mosaic') {
    const block = el('input', { type: 'range', id: 'propBlock', min: '2', max: '20', step: '1', value: String(selected.block) });
    const out = el('output', { text: String(selected.block) });
    block.addEventListener('input', () => {
      out.textContent = block.value;
      onEdit({ block: block.value }, { commit: false });
    });
    block.addEventListener('change', () => onEdit({ block: block.value }, { commit: true }));
    items.push(field('edit.prop.block', el('span', { class: 'range-row' }, block, out)));
  }
  if (selected.type === 'mosaic' || selected.type === 'whiteout') {
    items.push(checkbox('edit.prop.allPages', isGlobal, onToggleGlobal, 'propAllPages'));
  }
  items.push(del);
  container.replaceChildren(el('div', { class: 'prop-row' }, ...items));
  if (focusText && selected.type === 'text') {
    const area = container.querySelector('#propText');
    area.focus();
    if (focusText === 'end') area.setSelectionRange(area.value.length, area.value.length);
    else area.select();
  }
}

const MAX_SHOWN = 60;

/**
 * 点中 PDF 原有文字时的属性栏：显示原文，给「删除」「修改」两个按钮。
 * @param {HTMLElement} container
 * @param {{ run: {str: string}, onDelete: () => void, onEdit: () => void }} opts
 */
export function renderRunProps(container, { run, onDelete, onEdit }) {
  const shown = run.str.length > MAX_SHOWN ? `${run.str.slice(0, MAX_SHOWN)}…` : run.str;
  const del = el('button', { type: 'button', class: 'btn small danger', id: 'runDelete', text: t('edit.run.delete') });
  del.addEventListener('click', onDelete);
  const edit = el('button', { type: 'button', class: 'btn small primary-soft', id: 'runEdit', text: t('edit.run.edit') });
  edit.addEventListener('click', onEdit);
  container.replaceChildren(
    el(
      'div',
      { class: 'prop-row' },
      el('span', { class: 'run-label', text: t('edit.run.label') }),
      el('span', { class: 'run-text', id: 'runText', text: shown }),
      del,
      edit,
    ),
    el('p', { class: 'muted small prop-hint', text: t('edit.run.hint') }),
  );
}
