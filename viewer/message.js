// 预览区顶部的提示条（全部用 textContent，文件名等外部内容不会被当成 HTML）。
import { t } from '../core/i18n.js';

const box = () => document.getElementById('message');
const TOAST_MS = 6000; // 没有按钮的普通提示过一会儿自动消失，不一直挡着工具条
let hideTimer = 0;

/** 任何抛出来的东西都转成能显示的文字（有的 API 会 reject null 或非 Error）。 */
export function errorText(err) {
  return err?.message ?? (err == null ? t('error.unknown') : String(err));
}

export function hideMessage() {
  clearTimeout(hideTimer);
  box().hidden = true;
}

/** kind: 'info' | 'error'；actions: [{ label, onClick, primary? }] */
export function showMessage(kind, text, actions = []) {
  clearTimeout(hideTimer);
  const el = box();
  el.className = `message ${kind}`;
  const body = document.createElement('div');
  body.textContent = text;
  const row = document.createElement('div');
  row.className = 'actions';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${action.primary ? 'primary' : 'secondary'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', async () => {
      try {
        await action.onClick();
      } catch (err) {
        console.error('[label-print] action failed', err);
        showMessage('error', t('error.action', { err: errorText(err) }));
      }
    });
    row.append(btn);
  }
  if (kind === 'error') {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn secondary';
    close.textContent = t('btn.close');
    close.addEventListener('click', hideMessage);
    row.append(close);
  }
  el.replaceChildren(body, ...(row.childElementCount ? [row] : []));
  el.hidden = false;
  if (kind === 'info' && !actions.length) hideTimer = setTimeout(hideMessage, TOAST_MS);
}
