// 「打印方案」面板：给当前设置起名保存、切换、删除；选中的方案下次打开自动使用。
import { t } from '../core/i18n.js';
import { loadProfiles, saveProfiles } from '../core/storage.js';
import * as P from '../core/profiles.js';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings
 * @param {(settings: object) => void} deps.onApply  切换方案后套用设置
 * @param {(kind: string, text: string) => void} deps.notify
 */
export function createProfilesUI({ getSettings, onApply, notify }) {
  let profiles = P.EMPTY_PROFILES;

  const active = () => P.findProfile(profiles, profiles.active);

  function render() {
    const select = $('profile');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('profile.none');
    select.replaceChildren(
      none,
      ...profiles.list.map((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        return opt;
      }),
    );
    select.value = profiles.active ?? '';
    const current = active();
    const modified = P.isModified(getSettings(), current);
    $('profileState').textContent = current ? (modified ? t('profile.modified') : t('profile.hint')) : t('profile.hint');
    $('profileState').classList.toggle('warn', modified);
    $('btnProfileSave').disabled = !current || !modified;
    $('btnProfileDelete').disabled = !current;
  }

  async function persist(next, message) {
    profiles = next;
    render();
    try {
      await saveProfiles(profiles);
      if (message) notify('info', message);
    } catch (err) {
      notify('error', t('error.saveSettings', { err: err?.message ?? String(err) }));
    }
  }

  function showNameRow(show) {
    $('profileNameRow').hidden = !show;
    if (show) {
      const input = $('profileName');
      input.value = active()?.name ?? '';
      input.focus();
      input.select();
    }
  }

  async function confirmName() {
    const name = P.cleanName($('profileName').value);
    if (!name) {
      $('profileName').focus();
      return;
    }
    showNameRow(false);
    await persist(P.saveAs(profiles, name, getSettings()), t('profile.saved', { name }));
  }

  $('profile').addEventListener('change', (e) => {
    const id = e.target.value || null;
    const next = P.select(profiles, id);
    const profile = P.findProfile(next, id);
    if (profile) onApply(P.applyProfile(getSettings(), profile));
    persist(next);
  });
  $('btnProfileSave').addEventListener('click', () => {
    const current = active();
    if (current) persist(P.update(profiles, current.id, getSettings()), t('profile.saved', { name: current.name }));
  });
  $('btnProfileSaveAs').addEventListener('click', () => showNameRow(true));
  $('btnProfileNameOk').addEventListener('click', confirmName);
  $('btnProfileNameCancel').addEventListener('click', () => showNameRow(false));
  $('profileName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmName();
    if (e.key === 'Escape') showNameRow(false);
  });
  $('btnProfileDelete').addEventListener('click', () => {
    const current = active();
    if (current && window.confirm(t('profile.confirmDelete', { name: current.name }))) {
      persist(P.remove(profiles, current.id), t('profile.deleted', { name: current.name }));
    }
  });

  return {
    /** 读出方案；返回当前（默认）方案，没有则 null。 */
    async init() {
      profiles = await loadProfiles();
      render();
      return active();
    },
    /** 设置变了 / 换了语言：刷新「已修改」提示和文字。 */
    render,
  };
}
