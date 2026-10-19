// 全服排行榜（server/leaderboard.js 的读端）。
//
// 与本机统计（screens/stats.js）的区别：那个读浏览器里的 localStorage，只看得见自己的对局；
// 这个向 GET /leaderboard 要服务端聚合好的榜单 —— 谁在哪一项上排第几。
//
// 只做**展示**：排序、并列、口径全在服务端算好（server/leaderboard.js），这里不重算任何东西，
// 免得两边漂移。榜上的 id（stageId / bossId / bondId / 干员 id）用本机的游戏数据解析成名字与图标。
//
// 服务端没启用账号系统时 /leaderboard 返回 { enabled:false }，这里显示一句"未启用"并关掉入口。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Icon, MicroLabel, Spinner, Button } from '../ui/components.js';
import { useGameData, BondGlyph, UnitThumb } from '../ui/gameComponents.js';
import { useDocClass } from '../ui/device.js';
import { createStore, useStore } from '../store.js';
import { net } from '../net.js';
import { fmtNum } from '../ui/gameLogic.js';
import { t, N_ } from '../../../shared/i18n.js';

const ranksStore = createStore({ open: false, tab: 'winrate' });

/** 打开全服排行榜（标题画面 / 大厅的入口）。 */
export function openRanks() { ranksStore.set({ open: true }); }

const TABS = [
  { id: 'winrate', name: N_('胜率'), micro: 'WIN RATE' },
  { id: 'hidden', name: N_('隐藏阶段胜率'), micro: 'HIDDEN CLEAR' },
  { id: 'dmg', name: N_('局平均伤害'), micro: 'AVG DAMAGE' },
  { id: 'bossDmg', name: N_('局平均领袖伤害'), micro: 'AVG BOSS DMG' },
  { id: 'rounds', name: N_('最高回合'), micro: 'BEST ROUNDS' },
  { id: 'games', name: N_('对局数'), micro: 'MATCHES' },
  { id: 'world', name: N_('全服统计'), micro: 'SERVER-WIDE' },
];

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

/** 一行账号榜的单元格（按 tab 取对应的那个数字）。 */
function metricOf(tab, r) {
  switch (tab) {
    case 'winrate': return { main: pct(r.rate), sub: t('{wins} 胜 / {games} 局', { wins: fmtNum(r.wins), games: fmtNum(r.games) }) };
    case 'hidden': return { main: pct(r.hiddenRate), sub: t('通关 {n} 次', { n: fmtNum(r.hiddenCleared) }) };
    case 'dmg': return { main: r.avgDmg == null ? '—' : fmtNum(Math.round(r.avgDmg)), sub: t('样本 {n} 局', { n: fmtNum(r.dmgN) }) };
    case 'bossDmg': return { main: r.avgBossDmg == null ? '—' : fmtNum(Math.round(r.avgBossDmg)), sub: t('样本 {n} 局', { n: fmtNum(r.bossDmgN) }) };
    case 'rounds': return { main: fmtNum(r.roundsMax), sub: t('累计 {n} 回合', { n: fmtNum(r.roundsTotal) }) };
    default: return { main: fmtNum(r.games), sub: t('{wins} 胜', { wins: fmtNum(r.wins) }) };
  }
}

function AccountBoard({ rows, tab }) {
  if (!rows.length) return html`<p class="st-empty">${t('还没有记录 —— 有人在服务端打完一局后，这里就会有排名。')}</p>`;
  const mine = net.accountId;
  return html`<div class="st-tablewrap"><table class="st-table">
    <thead><tr><th>#</th><th>${t('博士代号')}</th><th class="num">${t(TABS.find((x) => x.id === tab)?.name ?? '胜率')}</th></tr></thead>
    <tbody>
      ${rows.map((r, i) => {
        const m = metricOf(tab, r);
        return html`<tr key=${r.accountId} class=${r.accountId === mine ? 'is-me' : ''}>
          <td class="num st-dim">${i + 1}</td>
          <td><span class="st-band">${r.name || r.accountId}${r.accountId === mine ? html`<${MicroLabel} tone="mint">${t('我')}<//>` : null}</span></td>
          <td class="num"><b>${m.main}</b><span class="st-dim"> ${m.sub}</span></td>
        </tr>`;
      })}
    </tbody>
  </table></div>`;
}

function GroupBoard({ rows, gd, kind }) {
  if (!rows.length) return html`<p class="st-empty">${t('暂无数据')}</p>`;
  const nameOf = (id) => (kind === 'bond' ? gd.bond(id)?.name : kind === 'boss' ? gd.boss(id)?.name : gd.stage(id)?.name) || id;
  return html`<div class="st-tablewrap"><table class="st-table">
    <thead><tr><th>${t('名称')}</th><th class="num">${t('通过率')}</th><th class="num">${t('对局数')}</th></tr></thead>
    <tbody>
      ${rows.map((r) => html`<tr key=${r.id}>
        <td><span class="st-band">${kind === 'bond' ? html`<${BondGlyph} bondId=${r.id} size="xs" />` : null}${nameOf(r.id)}</span></td>
        <td class="num"><b>${pct(r.rate)}</b></td>
        <td class="num st-dim">${fmtNum(r.games)}</td>
      </tr>`)}
    </tbody>
  </table></div>`;
}

function WorldBoards({ world, gd }) {
  return html`
    <${Section} title=${t('地图胜率')} micro="STAGES"><${GroupBoard} rows=${world.stages} gd=${gd} kind="stage" /><//>
    <${Section} title=${t('首领胜率')} micro="BOSSES"><${GroupBoard} rows=${world.bosses} gd=${gd} kind="boss" /><//>
    <${Section} title=${t('羁绊胜率')} micro="BONDS"><${GroupBoard} rows=${world.bonds} gd=${gd} kind="bond" /><//>
    <${Section} title=${t('羁绊最高层数')} micro="BOND RECORDS">
      <div class="st-tablewrap"><table class="st-table">
        <thead><tr><th>${t('名称')}</th><th class="num">${t('最高层数')}</th><th>${t('达成者')}</th></tr></thead>
        <tbody>${world.bondMaxLayers.map((r) => html`<tr key=${r.id}>
          <td><span class="st-band"><${BondGlyph} bondId=${r.id} size="xs" />${gd.bond(r.id)?.name || r.id}</span></td>
          <td class="num"><b>${fmtNum(r.maxLayers)}</b></td>
          <td class="st-dim">${r.whoName || '—'}</td>
        </tr>`)}</tbody>
      </table></div>
    <//>
    <${Section} title=${t('惯用干员')} micro="OPERATORS">
      <div class="st-tablewrap"><table class="st-table">
        <thead><tr><th>${t('名称')}</th><th class="num">${t('出现次数')}</th></tr></thead>
        <tbody>${world.chars.slice(0, 30).map((r) => html`<tr key=${r.id}>
          <td><span class="st-band"><${UnitThumb} id=${r.id} size="xs" />${gd.chess(r.id)?.name || r.id}</span></td>
          <td class="num"><b>${fmtNum(r.count)}</b></td>
        </tr>`)}</tbody>
      </table></div>
    <//>`;
}

function Section({ title, micro, children }) {
  return html`<section class="st-sec">
    <header class="st-sec__h"><h3>${title}</h3><${MicroLabel}>${micro}<//></header>
    ${children}
  </section>`;
}

function RanksScreen({ onClose }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const tab = useStore((s) => s.tab, Object.is, ranksStore);
  useDocClass('sp-stats-open');
  // 本机游戏数据（把榜上的 id 解析成名字与图标）。加载完之前 gd.bond() 之类会返回 undefined ——
  // 渲染时都带 `|| id` 兜底，所以最坏情况是短暂显示 id。
  const gd = useGameData();

  useEffect(() => {
    let alive = true;
    fetch('/leaderboard', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) setState({ loading: false, error: null, data: d }); })
      .catch((e) => { if (alive) setState({ loading: false, error: String(e?.message || e), data: null }); });
    return () => { alive = false; };
  }, []);

  const d = state.data;
  const rows = d && d.players ? (d.players[tab] || []) : [];

  return html`<div class="st" role="dialog" aria-modal="true">
    <header class="st-top">
      <${MicroLabel} tone="mint">SERVER RANKINGS<//>
      <h2 class="st-title">${t('全服排行榜')}</h2>
      <div class="st-top__r">
        <${Button} variant="ghost" size="sm" icon="close" onClick=${onClose} title=${t('关闭')}>${t('关闭')}<//>
      </div>
    </header>
    <nav class="st-tabs">
      ${TABS.map((x) => html`<button key=${x.id} type="button" class=${`st-tab${tab === x.id ? ' is-on' : ''}`}
        data-tab=${x.id} onClick=${() => ranksStore.set({ tab: x.id })}>${t(x.name)}</button>`)}
    </nav>
    <main class="st-body" data-tab=${tab}>
      ${state.loading || !gd.ready ? html`<div class="st-loading"><${Spinner} size="md" /></div>`
        : state.error ? html`<p class="st-empty">${t('拿不到排行榜：{msg}', { msg: state.error })}</p>`
          : d && d.enabled === false ? html`<p class="st-empty">${t('这个服务器没有启用账号系统，所以还没有全服排行榜。')}</p>`
            : tab === 'world'
              ? html`<${WorldBoards} world=${d.world} gd=${gd} />`
              : html`<${AccountBoard} rows=${rows} tab=${tab} />`}
    </main>
    <footer class="st-note">
      ${d && d.enabled ? html`<${Icon} name="info" />${t('全服数据：按服务端结算的对局累计，榜单对所有访客可见。战绩里的伤害与叠层由客户端上报，未做复核。')}` : null}
    </footer>
  </div>`;
}

/** 挂载点（main.js），与 StatsHost 同一处。 */
export function RanksHost() {
  const open = useStore((s) => s.open, Object.is, ranksStore);
  if (!open) return null;
  return html`<${RanksScreen} onClose=${() => ranksStore.set({ open: false })} />`;
}
