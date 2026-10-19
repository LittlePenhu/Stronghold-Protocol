// public/js/ui/account.js — 账号面板与「忘记密码」的两块界面。
//
// 分工（写在最前面，免得以后又混起来）：
//   · **会话里**的操作走 WebSocket：改密码 / 改代号 / 退出这台设备 / 踢掉其他设备 / 读账号状态 ——
//     它们都需要「我已经是谁」，只有 hello 之后的会话能给这个答案（server/net.js 的 account.*）。
//   · **忘了密码**的两步走 HTTP（server/http/routes.js 的 /account/*）：那样的人根本进不了门，
//     等不到会话。第一步申请拿一个 8 位重置码，第二步用码 + 新密码换一张新设备凭证。
//   · 批准是服主的活（回环 + SP_ADMIN_TOKEN 的 /admin/resets），游戏里没有入口 —— 玩家拿到码之后
//     得把它报给服主，这一步没有代码可以代替。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, MicroLabel, TextField, confirmDialog } from './components.js';
import { toast, toastError } from './toasts.js';
import { ERR_TEXT, NAME_MAX_LEN } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { net, identity } from '../net.js';
import { store } from '../store.js';

/** HTTP 接口的错误码 → 给玩家看的一句话（和 WS 的错误用的是同一批 msgid）。 */
function httpErrorText(code) {
  if (code && ERR_TEXT[code]) return t(ERR_TEXT[code]);
  return t('请求失败，请稍后再试。');
}

/** POST 一个 JSON 到本服，非 2xx 时抛出带 `code` 的错误。 */
async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* 不是 JSON（代理错误页之类） */ }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.code = data?.error || 'HTTP';
    throw err;
  }
  return data || {};
}

const dayText = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString() : '—');

/** 「退出这台设备」之后要不要特别警告：没密码的账号退出就等于丢掉账号。 */
const logoutWarning = (account) => (account?.hasPassword
  ? t('退出后这台设备需要用密码重新登录。继续？')
  : t('这个账号没有设置密码 —— 退出这台设备后就再也进不来了（成绩还在，但没人能登录）。真的要退出？'));

/**
 * 账号面板：当前账号的状态 + 改密码 / 改代号 / 退出这台设备 / 踢掉其他设备。
 * @param {{ open: boolean, onClose: () => void, onRenamed?: (name: string) => void }} props
 */
export function AccountPanel({ open, onClose, onRenamed }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null);     // null | 'password' | 'rename'
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confPw, setConfPw] = useState('');
  const [newName, setNewName] = useState('');
  const [renamePw, setRenamePw] = useState('');

  // 面板每打开一次都重新问一遍服务端 —— 设备数 / 有没有密码会随别的设备变化。
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    net.request('account.info', {}, { timeout: 6000 })
      .then((msg) => { if (alive && msg?.account) setInfo(msg.account); })
      .catch((e) => { if (alive) toastError(e); });
    return () => { alive = false; };
  }, [open]);

  const resetForms = () => {
    setMode(null); setOldPw(''); setNewPw(''); setConfPw(''); setNewName(''); setRenamePw('');
  };

  const submitPassword = async () => {
    if (newPw.length < 6) { toast(t('密码至少 6 位'), 'warn'); return; }
    if (newPw !== confPw) { toast(t('两次输入的密码不一致'), 'warn'); return; }
    if (info?.hasPassword && !oldPw) { toast(t('请输入当前密码'), 'warn'); return; }
    setBusy(true);
    try {
      const msg = await net.request('account.setPassword', info?.hasPassword ? { password: newPw, oldPassword: oldPw } : { password: newPw });
      if (msg?.account) setInfo(msg.account);
      net.accountHasPassword = true;
      resetForms();
      toast(t('密码已更新 —— 换设备时用「代号 + 密码」即可找回账号'), 'success');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const submitRename = async () => {
    const name = newName.trim();
    if (!name) { toast(t('请输入新的代号'), 'warn'); return; }
    if (info?.hasPassword && !renamePw) { toast(t('请输入当前密码'), 'warn'); return; }
    setBusy(true);
    try {
      const msg = await net.request('account.rename', info?.hasPassword ? { name, password: renamePw } : { name });
      if (msg?.account) {
        setInfo(msg.account);
        identity.saveName(msg.account.name);
        store.set((s) => ({ me: { ...s.me, name: msg.account.name } }));
        onRenamed?.(msg.account.name);
      }
      resetForms();
      toast(t('代号已更改 —— 成绩仍记在同一个账号上'), 'success');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const logout = async () => {
    if (!(await confirmDialog({ title: t('退出这台设备'), text: logoutWarning(info) }))) return;
    setBusy(true);
    try {
      const msg = await net.request('account.logout');
      if (msg?.account) setInfo(msg.account);
      identity.forgetAccount();
      toast(t('已退出这台设备 —— 下次要用密码（或重置码）登录'), 'success');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const revokeOthers = async () => {
    if (!(await confirmDialog({ title: t('踢掉其他设备'), text: t('其他设备上的登录会立刻失效，只能靠密码重新进来。继续？') }))) return;
    setBusy(true);
    try {
      const msg = await net.request('account.revokeOthers');
      if (msg?.account) setInfo(msg.account);
      toast(t('已撤销其他设备的登录'), 'success');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const actions = [html`<${Button} variant="ghost" onClick=${onClose}>${t('关闭')}<//>`];

  return html`<${Modal} open=${open} title=${t('账号')} micro="ACCOUNT" onClose=${onClose} actions=${actions} width="min(560px, 94vw)">
    ${!info ? html`<p class="acc-loading">${t('正在读取账号信息…')}</p>` : html`
      <dl class="acc-facts">
        <div><dt>${t('代号')}</dt><dd>${info.name}</dd></div>
        <div><dt>${t('注册时间')}</dt><dd>${dayText(info.createdAt)}</dd></div>
        <div><dt>${t('密码')}</dt><dd>${info.hasPassword ? t('已设置') : t('未设置')}</dd></div>
        <div><dt>${t('已登录设备')}</dt><dd>${t('{n} 台', { n: String(info.devices) })}</dd></div>
      </dl>
      ${info.resetPending ? html`<p class="acc-hint acc-hint--warn">${t('这个账号有一条密码重置申请：把重置码报给服主，批准后用「忘记密码」设新密码。')}</p>` : null}
      ${!info.hasPassword ? html`<p class="acc-hint acc-hint--warn">${t('还没有设置密码 —— 现在清了浏览器数据或换设备就进不来了。建议先设一个。')}</p>` : null}

      ${mode === null ? html`<div class="acc-actions">
        <${Button} variant="secondary" onClick=${() => setMode('password')}>${info.hasPassword ? t('修改密码') : t('设置密码')}<//>
        <${Button} variant="secondary" onClick=${() => { setNewName(info.name); setMode('rename'); }}>${t('改代号')}<//>
        ${info.devices > 1 ? html`<${Button} variant="secondary" onClick=${revokeOthers} disabled=${busy}>${t('踢掉其他设备')}<//>` : null}
        <${Button} variant="ghost" onClick=${logout} disabled=${busy}>${t('退出这台设备')}<//>
      </div>` : null}

      ${mode === 'password' ? html`<div class="acc-form">
        <p class="acc-hint">${info.hasPassword
          ? t('改密码要先输当前密码 —— 拿到这台设备的人不该能直接把密码换掉。')
          : t('设置密码后，换设备或清了浏览器数据时，可用「代号 + 密码」找回账号。')}</p>
        ${info.hasPassword ? html`<${TextField} label=${t('当前密码')} micro="CURRENT" size="lg" icon="key" type="password"
          value=${oldPw} maxLength=${128} onInput=${setOldPw} />` : null}
        <${TextField} label=${t('新密码')} micro="NEW" size="lg" icon="key" type="password"
          value=${newPw} maxLength=${128} onInput=${setNewPw} onEnter=${submitPassword} />
        <${TextField} label=${t('确认新密码')} micro="CONFIRM" size="lg" icon="key" type="password"
          value=${confPw} maxLength=${128} onInput=${setConfPw} onEnter=${submitPassword} />
        <div class="acc-actions">
          <${Button} variant="primary" onClick=${submitPassword} disabled=${busy || !newPw || !confPw}>${t('保存密码')}<//>
          <${Button} variant="ghost" onClick=${resetForms} disabled=${busy}>${t('取消')}<//>
        </div>
      </div>` : null}

      ${mode === 'rename' ? html`<div class="acc-form">
        <p class="acc-hint">${t('改名不换账号：历史成绩不会分裂成两份，别人也不能靠改名占走你的记录。')}</p>
        <${TextField} label=${t('新代号')} micro="CALLSIGN" size="lg" icon="user"
          value=${newName} maxLength=${NAME_MAX_LEN} onInput=${setNewName} onEnter=${submitRename} />
        ${info.hasPassword ? html`<${TextField} label=${t('当前密码')} micro="CURRENT" size="lg" icon="key" type="password"
          value=${renamePw} maxLength=${128} onInput=${setRenamePw} onEnter=${submitRename} />` : null}
        <div class="acc-actions">
          <${Button} variant="primary" onClick=${submitRename} disabled=${busy || !newName.trim()}>${t('保存代号')}<//>
          <${Button} variant="ghost" onClick=${resetForms} disabled=${busy}>${t('取消')}<//>
        </div>
      </div>` : null}
    `}
  <//>`;
}

/**
 * 「忘记密码」：申请拿码 → 报给服主 → 批准后填码 + 新密码 → 服务端签发一张新的设备凭证。
 * @param {{ open: boolean, onClose: () => void, initialName?: string,
 *           onDone?: (name: string) => void }} props
 */
export function ForgotPasswordPanel({ open, onClose, initialName = '', onDone }) {
  const [name, setName] = useState(initialName);
  const [ticket, setTicket] = useState(null);   // { code, expiresAt }
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [conf, setConf] = useState('');
  const [busy, setBusy] = useState(false);

  // 每次打开都从当前的代号输入框起手（玩家通常先把代号敲进去了才想起忘了密码）。
  useEffect(() => {
    if (!open) return;
    setName((n) => n || initialName);
  }, [open, initialName]);

  const requestCode = async () => {
    const wanted = name.trim();
    if (!wanted) { toast(t('请输入博士代号'), 'warn'); return; }
    setBusy(true);
    try {
      const data = await postJson('/account/reset-request', { name: wanted });
      setTicket(data);
      setCode(data.code || '');
      toast(t('已生成重置码 —— 把它报给服主，等他批准后再填回这里'), 'success');
    } catch (e) { toast(httpErrorText(e.code), 'warn'); } finally { setBusy(false); }
  };

  const complete = async () => {
    const wanted = name.trim();
    if (!wanted) { toast(t('请输入博士代号'), 'warn'); return; }
    if (!code.trim()) { toast(t('请输入重置码'), 'warn'); return; }
    if (pw.length < 6) { toast(t('密码至少 6 位'), 'warn'); return; }
    if (pw !== conf) { toast(t('两次输入的密码不一致'), 'warn'); return; }
    setBusy(true);
    try {
      const data = await postJson('/account/reset-complete', { name: wanted, code: code.trim(), password: pw });
      if (data?.token) identity.saveAccountToken(data.token);
      identity.saveName(data?.name || wanted);
      toast(t('密码已重置 —— 现在可以直接进入'), 'success');
      onDone?.(data?.name || wanted);
      onClose?.();
    } catch (e) { toast(httpErrorText(e.code), 'warn'); } finally { setBusy(false); }
  };

  const actions = [
    html`<${Button} variant="ghost" onClick=${onClose}>${t('取消')}<//>`,
    ticket ? html`<${Button} variant="primary" onClick=${complete} disabled=${busy || !code.trim() || !pw || !conf}>${t('重置密码')}<//>`
      : html`<${Button} variant="primary" onClick=${requestCode} disabled=${busy || !name.trim()}>${t('获取重置码')}<//>`,
  ];

  return html`<${Modal} open=${open} title=${t('忘记密码')} micro="RECOVERY" tone="gold" onClose=${onClose} actions=${actions} width="min(560px, 94vw)">
    <p class="acc-hint">${t('重置要服主批准：先申请拿到重置码，把它报给服主；批准后回到这里，用码设置新密码。')}</p>
    <${TextField} label=${t('博士代号')} micro="CALLSIGN" size="lg" icon="user"
      value=${name} maxLength=${NAME_MAX_LEN} onInput=${setName} onEnter=${ticket ? complete : requestCode} />
    ${!ticket ? html`<p class="acc-hint acc-hint--warn">${t('申请不验证身份 —— 谁都能为任何代号申请，真正拦人的是服主那一步批准。')}</p>` : html`
      <div class="acc-ticket">
        <${MicroLabel}>${t('重置码')}<//>
        <b class="acc-ticket__code num">${ticket.code}</b>
        <p class="acc-hint t-lo">${t('把上面的码发给服主，请他在服务器上批准。批准后在这里填入同一个码和新密码。')}</p>
      </div>
      <${TextField} label=${t('重置码')} micro="CODE" size="lg" icon="key"
        value=${code} maxLength=${16} onInput=${setCode} />
      <${TextField} label=${t('新密码')} micro="NEW" size="lg" icon="key" type="password"
        value=${pw} maxLength=${128} onInput=${setPw} onEnter=${complete} />
      <${TextField} label=${t('确认新密码')} micro="CONFIRM" size="lg" icon="key" type="password"
        value=${conf} maxLength=${128} onInput=${setConf} onEnter=${complete} />
      <button type="button" class="acc-link fsbtn tapx" onClick=${requestCode} disabled=${busy}>
        ${t('没收到？重新申请一个码')}</button>
    `}
  <//>`;
}
