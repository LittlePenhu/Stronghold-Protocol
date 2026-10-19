// Title screen: season-style backdrop, big title 卫戍协议：盟约, remembered nickname, 开始, the language menu
// (中文 | English | every pack in public/i18n/, ui/lang.js; a title in an alphabetic script — English — is the big one and
// the small wordmark above it hides).
//
// Pressing 开始 validates the nickname (1..NAME_MAX_LEN chars, no control characters), stores it,
// marks this tab as "entered" (so reloads skip the title) and hands the name to net.js, which
// sends `hello` (now, or as soon as the socket is open). The router then shows the lobby.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.
//
// The full art, under the login box: 下载完整素材 (ui/assetDownload.js — its dialog downloads from this server) and
// 导入素材包 (ui/assetImport.js — the player's own folder or zip, no server download) side by side, so an import never
// opens the download (docs/history/0.3.0.md §32.14.39).
//
// Plugins (DESIGN §32 P1a, the design study's §7.4): when the server has unofficial plugins (content.plugins of /healthz or
// welcome — content.js installedCount), the footer says 「本服务器安装了 N 个插件」 — a button that loads the list
// (ui/pluginPanel.js InstalledPlugins, which fetches the catalogue when it opens); nothing on a server without any, which
// the page never asks for its catalogue — and the title page loads none of the panel's code.

import { ResumeMatchButton } from '../ui/resumeMatch.js';
import { AssetDownloadButton } from '../ui/assetDownload.js';
import { AssetImportButton } from '../ui/assetImport.js';
import { AccountPanel, ForgotPasswordPanel } from '../ui/account.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, APP_VERSION, DEV_BUILD } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill } from '../ui/components.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { openRanks } from './ranks.js';
import { toast, toastError } from '../ui/toasts.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, PwaInstallButton, detectFeatures } from '../ui/device.js';
import { LangToggle, useLang } from '../ui/lang.js';
import { t, N_ } from '../../../shared/i18n.js';
import { scriptOf } from '../../../shared/i18nPacks.js';
import { GIcon } from '../ui/gameComponents.js';
import { SettingsModal } from '../ui/settings.js';
import { installedCount } from '../content.js';
import { NoticesButton } from '../ui/notices.js';
import { sanitizeName, isValidName } from '../ui/playerName.js';

export { stripLoneSurrogates, sanitizeName, isValidName } from '../ui/playerName.js';

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  net.setName(name);
  return true;
}

// data/assets.json `ui` keys are 'group/key' (docs/ASSETS.md).
const BACKDROP_KEYS = ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02'];
const RIDGE_KEYS = ['titleRidges', 'entry/bg_mountains_tiled'];

/**
 * Find a UI image URL in data/assets.json (tolerant of a few plausible shapes).
 * @param {any} assets
 * @param {string[]} names
 * @returns {string|null}
 */
export function findUiAsset(assets, names) {
  if (!assets || typeof assets !== 'object') return null;
  const asUrl = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url || v.path || v.src || null;
    return null;
  };
  const ui = assets.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    for (const n of names) {
      const u = asUrl(ui[n]);
      if (u) return u;
    }
  }
  const lists = [Array.isArray(ui) ? ui : null, Array.isArray(assets.files) ? assets.files : null].filter(Boolean);
  for (const list of lists) {
    for (const n of names) {
      const hit = list.map(asUrl).find((u) => typeof u === 'string' && u.includes('/ui/') && u.toLowerCase().split('/').pop().startsWith(n.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

// Dot-matrix watchtower emblem (13×14 bitmap; dots grow toward the base for depth).
const EMBLEM = [
  'XXX..XXX..XXX',
  'XXX..XXX..XXX',
  'XXXXXXXXXXXXX',
  '.XXXXXXXXXXX.',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXX.XXXX..',
  '..XXXX.XXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX',
  'XXXXXXXXXXXXX',
];

function Emblem() {
  const dots = useMemo(() => {
    const out = [];
    EMBLEM.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== 'X') return;
        const rad = 0.2 + (r / (EMBLEM.length - 1)) * 0.2;
        const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
        out.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent, d: (r * 13 + c) % 7 });
      });
    });
    return out;
  }, []);
  return html`<div class="emblem" aria-hidden="true">
    <span class="emblem__bracket emblem__bracket--l"></span>
    <svg class="emblem__svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map((d, i) => html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : `d${d.d}`} />`)}
    </svg>
    <span class="emblem__bracket emblem__bracket--r"></span>
  </div>`;
}

function Ridges() {
  return html`<svg class="title-bg__ridges" viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#16231f" /><stop offset="1" stop-color="#0a0e0d" />
      </linearGradient>
      <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0f1714" /><stop offset=".6" stop-color="#080b0a" />
      </linearGradient>
      <linearGradient id="ridge-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17f9b7" stop-opacity="0" />
        <stop offset=".3" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset=".7" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset="1" stop-color="#17f9b7" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="ridge ridge--far" fill="url(#ridge-far)" stroke="url(#ridge-edge)"
      d="M0 420V250l120-40 90 30 90-70 60 20 80-70 80 55 80-25 90 70 90-20 80 50 100-15 90 25 90-55 90-55 70-55 70 45 80-20 90 65 80-20 100 55 100-20 100 40v180z" />
    <path class="ridge ridge--near" fill="url(#ridge-near)" stroke="url(#ridge-edge)"
      d="M0 420V322l160-32 100 20 120-50 90 40 130-20 120 50 140-30 140 35 120-35 140 20 140-50 120 30 120-20 120 40 160-20v147z" />
  </svg>`;
}

const STATUS_TEXT = {
  idle: N_('准备连接'), connecting: N_('正在连接服务器'), connected: N_('已连接服务器'), handshaking: N_('正在验证身份'),
  online: N_('已连接服务器'), reconnecting: N_('连接中断，正在重连'), closed: N_('连接已关闭'),
};

/** Title screen component. */
export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  useLang(); // re-render on a language switch
  const currentName = useStore((s) => s.me.name);
  const [name, setName] = useState(() => currentName || identity.loadName() || '');
  // An import may restore the current name while this screen remains behind the stats overlay.
  useEffect(() => {
    if (currentName) setName((draft) => draft || currentName);
  }, [currentName]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 账号（server/accounts.js）：密码用于「换设备 / 清了浏览器数据后把账号找回来」。
  // 平时根本不出现 —— 只有服务端拒绝握手（代号被占、密码错）或玩家自己点「用密码登录」才展开。
  const [password, setPassword] = useState('');
  const [askPassword, setAskPassword] = useState(false);
  // 「设置 / 修改密码」：给**当前账号**补一把备用钥匙（设备凭证丢了时靠「代号 + 密码」找回）。
  // 只有已经带着账号在线（welcome.accountId）才出现 —— 注册时没设密码的账号从此有了补救入口。
  const [pwSetOpen, setPwSetOpen] = useState(false);
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  // 已发出 hello、正在等结果。**失败之前不让玩家进大厅** —— 不然他会在里面看到「未连接」却不知道为什么。
  const [pending, setPending] = useState(false);
  const errAtStart = useRef(null);
  // 账号面板（ui/account.js）：状态 / 改密码 / 改代号 / 退出这台设备 / 踢掉其他设备
  const [accountOpen, setAccountOpen] = useState(false);
  // 「忘记密码」：申请 → 报码给服主 → 批准后设新密码（ui/account.js ForgotPasswordPanel）
  const [forgotOpen, setForgotOpen] = useState(false);
  // the list of the server's plugins once loaded (ui/pluginPanel.js — a component in state: set through an updater)
  const [Installed, setInstalled] = useState(null);
  const openPlugins = () => {
    import('../ui/pluginPanel.js').then((m) => setInstalled(() => m.InstalledPlugins), (err) => console.warn('[plugins] the list did not load', err));
  };
  const installed = useStore(installedCount);
  const assetsSettled = useData('assets');
  const assets = data.get('assets');
  const backdrop = findUiAsset(assets, BACKDROP_KEYS);
  const ridges = findUiAsset(assets, RIDGE_KEYS);
  // Track load/fail per URL (not as booleans reset in effects: an image can load before an effect runs).
  const [bgLoadedUrl, setBgLoadedUrl] = useState(null);
  const [ridgesLoadedUrl, setRidgesLoadedUrl] = useState(null);
  const [ridgesFailedUrl, setRidgesFailedUrl] = useState(null);
  const bgLoaded = !!backdrop && bgLoadedUrl === backdrop;
  const ridgesLoaded = !!ridges && ridgesLoadedUrl === ridges;
  const ridgesFailed = !!ridges && ridgesFailedUrl === ridges;
  // CSS ridgelines only when there is no ridge art (avoids a swap flash when the art arrives).
  const cssRidges = assetsSettled && (!ridges || ridgesFailed);

  const valid = isValidName(name);
  const acctError = conn.lastError?.code || null;
  const nameTaken = acctError === 'NAME_TAKEN';
  const badCredentials = acctError === 'BAD_CREDENTIALS';
  // 「这个代号没设过密码」：继续显示密码框只会让人一遍遍试错 —— 密码不存在，
  // 试多少次都是 BAD_CREDENTIALS。改成收起密码框 + 给一条出路（换代号 / 回原浏览器）。
  const noPassword = acctError === 'NO_PASSWORD';
  // 服务端说「这个代号有人了」或「密码不对」⇒ 展开密码输入框（那是唯一的自救方式）
  const passwordMode = askPassword || nameTaken || badCredentials;
  // 已经带着账号在线（welcome 回了 accountId）才谈得上「给这个账号设密码」
  const hasAccount = conn.status === 'online' && !!net.accountId;

  /** 给当前账号设置 / 更换密码（account.setPassword）：身份由服务端裁定，改的永远是"自己"的账号。 */
  const submitSetPassword = () => {
    if (pwNew.length < 6) { toast(t('密码至少 6 位'), 'warn'); return; }
    if (pwNew !== pwConfirm) { toast(t('两次输入的密码不一致'), 'warn'); return; }
    net.request('account.setPassword', { password: pwNew }).then(() => {
      net.accountHasPassword = true;
      setPwSetOpen(false);
      setPwNew('');
      setPwConfirm('');
      toast(t('密码已设置 —— 换设备时用「代号 + 密码」即可找回账号'), 'success');
    }).catch((err) => toastError(err));
  };

  /** 从「这个代号没密码」的死角里退出来：清掉本地凭证，重新以新代号开始。 */
  const resetAccount = () => {
    identity.forgetAccount?.();
    net.clearPassword?.();
    setPassword('');
    setAskPassword(false);
    errAtStart.current = null;
    // 走 net.clearError() 而不是直接赋值 lastError：直接赋值不 emit，
    // 订阅 store 的组件不会重渲染，提示条会一直挂在屏幕上。
    net.clearError?.();
  };

  const start = () => {
    if (!valid) { toast(t('请输入博士代号'), 'warn'); return; }
    // 没设过密码的账号不该再要密码 —— 直接当新代号放行（服务端会判名字被占而拒绝，
    // 所以玩家必须真的换一个名字，而不会以为是自己密码输了）。
    if (passwordMode && !noPassword && !password) { toast(t('请输入密码'), 'warn'); return; }
    if (noPassword) return;                 // 按钮是「换一个代号」，不直接提交
    identity.saveName(name);
    // 记下点下去那一刻的错误，好把这一次握手的结果与上一次的残影区分开
    errAtStart.current = conn.lastError?.code || null;
    net.setName(name);
    if (passwordMode) net.usePassword(password);
    setPending(true);
  };

  // 等这一次 hello 的结果。**成功才真的进入** —— 失败就留在标题画面，
  // 因为错误已经写进 conn.lastError，下面的提示条会把它显示出来。
  // （如果直接进大厅，玩家会在里面看到「未连接」却不知道为什么，也没地方改代号。）
  useEffect(() => {
    if (!pending) return;
    if (conn.status === 'online') {
      setPending(false);
      const finalName = net.serverName || name;
      identity.setEntered(true);
      store.set((s) => ({ me: { ...s.me, name: finalName }, session: { ...s.session, entered: true } }));
      return;
    }
    const code = conn.lastError?.code || null;
    if (code && code !== errAtStart.current) setPending(false);
  }, [pending, conn.status, conn.lastError]);

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  // a title in an alphabetic script (English, French …) is the big one in the display face and the wordmark above it
  // hides; a CJK / kana / Hangul title keeps the Chinese layout (shared/i18nPacks.js scriptOf — a pack needs no flag)
  const alphabetic = scriptOf(t('卫戍协议')) === 'alphabetic';
  return html`<div class="screen title-screen">
    <div class=${`title-bg${bgLoaded ? ' has-art' : ''}${ridgesLoaded ? ' has-ridges' : ''}`} aria-hidden="true">
      ${backdrop ? html`<img class="title-bg__art" src=${backdrop} alt="" draggable=${false}
        onLoad=${() => setBgLoadedUrl(backdrop)} />` : null}
      <div class="title-bg__glow"></div>
      <div class="title-bg__radar"><div class="title-bg__sweep"></div></div>
      <div class="title-bg__target"></div>
      ${cssRidges ? html`<${Ridges} />` : null}
      ${ridges && !ridgesFailed ? html`<div class="title-bg__ridge-art" style=${`background-image:url("${ridges}")`}>
        <img src=${ridges} alt="" hidden onLoad=${() => setRidgesLoadedUrl(ridges)} onError=${() => setRidgesFailedUrl(ridges)} />
      </div>` : null}
      <div class="title-bg__haze"></div>
      <span class="cross" style="left:7%;top:22%"></span>
      <span class="cross" style="left:93%;top:30%"></span>
      <span class="cross" style="left:14%;top:70%"></span>
      <span class="cross" style="left:88%;top:62%"></span>
      <span class="cross" style="left:60%;top:12%"></span>
    </div>

    <div class="title-corner title-corner--tl">
      <span class="title-corner__mark"></span>
      <div><${MicroLabel} tone="mint">RHODES ISLAND // SIMULATION SERVICE<//><br /><${MicroLabel}>TACTICAL CO-OP NODE · 02<//></div>
    </div>
    <div class="title-corner title-corner--tr">
      <div>
        <div class="title-corner__tools">
          <${Button} variant="ghost" size="sm" icon="chart" class="title-stats" onClick=${openStats} title=${t('统计数据')}>${t('统计')}<//>
          <${Button} variant="ghost" size="sm" icon="crown" class="title-ranks" onClick=${openRanks} title=${t('全服排行榜')}>${t('排行')}<//>
          <${LangToggle} class="title-lang" />
        </div>
        <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
      </div>
    </div>

    <main class="title-main">
      <${Emblem} />
      ${alphabetic ? null : html`<div class="title-en">
        <span class="title-en__a">STRONGHOLD PROTOCOL</span>
        <span class="title-en__b">ALLIANCE</span>
      </div>`}
      <h1 class=${`title-cn${alphabetic ? ' title-cn--latin' : ''}`}>${t('卫戍协议')}<span class="title-cn__colon">${alphabetic ? ': ' : '：'}</span><em>${t('盟约')}</em></h1>
      <p class="title-tag">${t('调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。')}</p>

      <div class="title-login">
        ${pendingJoin ? html`<div class="title-invite">
          <${Icon} name="key" />
          <span>${t('收到同盟邀请')}</span><b class="num">${pendingJoin}</b><span class="t-lo">${t('· 输入代号后将自动加入')}</span>
        </div>` : null}
        ${nameTaken || badCredentials || noPassword ? html`<div class="title-invite" role="alert">
          <${Icon} name="info" />
          <span>${noPassword
            ? t('这个代号没有设过密码 —— 输多少次都不对。请在当初注册的那个浏览器里打开（凭证只存在那里），或者换一个代号。')
            : nameTaken
              ? t('这个代号已经有人用了 —— 如果那是你，用密码登录；否则换一个。')
              : t('密码不正确')}</span>
        </div>` : null}
        <${TextField} label=${t('博士代号')} micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
          placeholder=${t('输入你的代号（最多 {NAME_MAX_LEN} 字）', { NAME_MAX_LEN })} autoFocus=${!touchUi}
          onInput=${setName} onEnter=${start} />
        ${passwordMode && !noPassword ? html`<${TextField} label=${t('密码')} micro="PASSWORD" size="lg" icon="key" type="password"
          value=${password} maxLength=${128} onInput=${setPassword} onEnter=${start} />` : null}
        ${noPassword ? html`<button type="button" class="title-alt fsbtn tapx" onClick=${resetAccount}>
          ${t('换一个代号')}</button>` : null}
        <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons"
          disabled=${!valid || pending || (passwordMode && !noPassword && !password)} onClick=${start}>
          ${noPassword ? t('开始') : passwordMode ? t('用密码登录') : t('开始')}<//>
        ${!passwordMode && valid ? html`<button type="button" class="title-alt fsbtn tapx" onClick=${() => setAskPassword(true)}>
          ${t('换设备了？用密码登录')}</button>` : null}
        ${(passwordMode && !noPassword) || noPassword ? html`<button type="button" class="title-alt fsbtn tapx" onClick=${() => setForgotOpen(true)}>
          ${noPassword ? t('忘记密码？申请重置') : t('忘记密码？')}</button>` : null}
        ${hasAccount && !passwordMode && !noPassword ? html`<button type="button" class="title-alt fsbtn tapx" onClick=${() => setAccountOpen(true)}>
          ${t('账号')}</button>` : null}
        ${hasAccount && !passwordMode && !noPassword ? html`<button type="button" class="title-alt fsbtn tapx" onClick=${() => setPwSetOpen(!pwSetOpen)}>
          ${net.accountHasPassword ? t('修改密码') : t('设置密码')}</button>` : null}
        ${pwSetOpen && hasAccount && !passwordMode ? html`<div class="title-pwset">
          <p class="title-pwset__hint t-lo">${t('设置密码后，换设备或清了浏览器数据时，可用「代号 + 密码」找回账号。')}</p>
          <${TextField} label=${t('密码')} micro="PASSWORD" size="lg" icon="key" type="password"
            value=${pwNew} maxLength=${128} onInput=${setPwNew} onEnter=${submitSetPassword} />
          <${TextField} label=${t('确认密码')} micro="CONFIRM" size="lg" icon="key" type="password"
            value=${pwConfirm} maxLength=${128} onInput=${setPwConfirm} onEnter=${submitSetPassword} />
          <${Button} variant="primary" size="lg" block=${true} disabled=${!pwNew || !pwConfirm} onClick=${submitSetPassword}>
            ${net.accountHasPassword ? t('修改密码') : t('设置密码')}<//>
        </div>` : null}
        <div class="title-conn">
          <span class=${`status-dot ${dotClass}`}></span>
          <span>${STATUS_TEXT[conn.status] ? t(STATUS_TEXT[conn.status]) : conn.status}</span>
          ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
          <${GuideButton} class="title-guide" label=${t('玩法说明')} />
          <button type="button" class="title-settings fsbtn tapx" aria-label=${t('设置')} title=${t('设置')}
            onClick=${() => setSettingsOpen(true)}><${GIcon} name="gear" /></button>
          <${FullscreenButton} class="title-fs" />
        </div>
      </div>
      <div class="title-assets">
        <${AssetDownloadButton} />
        <${AssetImportButton} />
      </div>
    </main>

    <${SettingsModal} open=${settingsOpen} onClose=${() => setSettingsOpen(false)} />
    <${AccountPanel} open=${accountOpen} onClose=${() => setAccountOpen(false)} onRenamed=${(n) => setName(n)} />
    <${ForgotPasswordPanel} open=${forgotOpen} initialName=${name} onClose=${() => setForgotOpen(false)}
      onDone=${(n) => {
        // 重置成功后客户端已经拿到新凭证（identity.saveAccountToken），这里只把界面恢复成「可以正常开始」的样子
        setName(n);
        net.clearError?.();
        errAtStart.current = null;
      }} />
    ${Installed ? html`<${Installed} open=${true} onClose=${() => setInstalled(null)} />` : null}

    <footer class="title-foot">
      <${ResumeMatchButton} />
      <${PwaInstallButton} />
      <${NoticesButton} />
      ${installed ? html`<button type="button" class="title-plugins" data-testid="title-plugins" onClick=${openPlugins}>
        <${Icon} name="info" />${t('本服务器安装了 {n} 个插件', { n: installed })}</button>` : null}
      <span>${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')}</span>
      <span class="title-foot__meta">
        <a class="title-repo" href="https://github.com/sganggs/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">${t('项目仓库')}</a>
        <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
        ${DEV_BUILD ? html`<span class="title-dev" role="note">${t('开发版 · 不稳定，请勿用于公开服务器')}</span>` : null}
      </span>
    </footer>
  </div>`;
}
