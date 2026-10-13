// server/leaderboard.js — 全服排行榜的存储与聚合。
//
// 与 public/js/ui/stats.js（本机统计）的关系：那边把对局记录存在**浏览器**的 localStorage 里，
// 换台机器就没了、也没法把成绩归到谁头上。这里做的是同一批指标，但存在服务端、按**账号**记账。
// 指标口径刻意与那边保持一致（见各 _merge 分支的注释），这样两边的数字能对得上。
//
// ── 为什么入账点是「服务端自己在结算时写」，而不是「客户端上报」──────────────────────
//
// 服务端本来就产出结算数据：server/match/match/settle.js 的 finish() 构建 m.result（胜负、回合数、
// 地图 / 首领 / 难度、每个玩家的 stats / lineup / bonds），lobby 的 onMatchEnd 拿到它。
// 所以：
//   · **谁参加了**只来自服务端座位表（room.seats → playerId → session.accountId），客户端报什么都不参与；
//   · **哪些对局存在**也来自服务端（本文件里那份 matchId 账本）—— 客户端造不出一局不存在的对局；
//   · 唯一的信任缺口是「一局内的数值」（伤害 / 叠层 / 干员），那些本来就在浏览器里算（DESIGN §14），
//     服务端要复算得开 SP_VERIFY=all（会把 CPU 打满）。这一版**接受上报值**，只做数值合理性钳制 ——
//     那挡的不是作弊（熟人之间不需要），而是"程序 bug 把 -3 或者 1e30 写进榜"。
//
// ── 串号 / 串数据的防线（都落在这一层或它的调用方）────────────────────────────────
//
//   1. `accountId` 只由调用方从 **session** 取（lobby 的 accountOf(playerId)），从不来自请求体；
//   2. `matchId` 幂等：同一局重复调用只会入账一次（同一个 Map 里已有就跳过）；
//   3. 每人每局只累加一次（遍历 result.players，一个 playerId 一行）；
//   4. 数值全部走 `int()` 钳制：负数 / NaN / 荒谬上限一律收敛，坏字段不会污染累加器；
//   5. 读接口只返回**聚合后的榜单**，没有"按 id 查任意玩家明细"的入口。
//
// ── 存储 ────────────────────────────────────────────────────────────────────────────
//
// 一个 JSON 文件（`SP_LEADERBOARD_FILE`）。写入是原子的（临时文件 → fsync → rename），
// 加载失败时**拒绝启动**而不是当作空榜 —— 与 server/accounts.js 同一套纪律。

import fs from 'node:fs';
import path from 'node:path';

/** 文件格式版本；将来改结构时用它做迁移。 */
export const LEADERBOARD_FORMAT = 1;

/**
 * 「局平均首领伤害」只统计打到这一回合及以后的对局。
 * 13 = 最终攻势（bossRound 是第 14 回合，见 results.js 的 teamRounds）之前一回合 —— 更早结束的局
 * 几乎不会碰到首领，混进平均里只是把数字拉平。这个常数与 public/js/ui/stats.js 的 LATE_GAME_ROUND 同值。
 */
export const LATE_GAME_ROUND = 13;

/** matchId 账本最多记多少条（只存 id → 时间，纯粹用来防重复入账）。 */
export const MATCH_LOG_MAX = 20_000;

/** 单个榜单最多返回多少行。 */
export const BOARD_MAX = 50;

/** 数值钳制上限 —— 防的是"程序 bug 写进离谱数字"，不是防作弊。 */
const LIMITS = Object.freeze({
  rounds: 999,
  layers: 999,      // = BOND_LAYER_CAP
  dmg: 1e12,
  games: 1e9,
});

const now = () => Date.now();

/** 非负整数，且不超过上限。负数 / NaN / 小数一律收敛到合法值。 */
function int(v, max) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

/** 一局分组计数（地图 / 首领用）。 */
const pair = () => ({ games: 0, wins: 0 });

/** 一个账号的空白累计器。 */
function blank(id, name, at) {
  return {
    id,
    name: name || '',
    games: 0, wins: 0, hiddenCleared: 0,
    rounds: { total: 0, max: 0 },
    dmg: { sum: 0, n: 0 },
    bossDmg: { sum: 0, n: 0 },
    stages: {}, bosses: {},
    bonds: {}, chars: {},
    firstAt: at, lastAt: at,
  };
}

export class Leaderboard {
  /**
   * @param {{ file?: string, log?: { info?: Function, warn: Function, error: Function } }} [opts]
   */
  constructor({ file = process.env.SP_LEADERBOARD_FILE || 'leaderboard.json', log = console } = {}) {
    this.file = path.resolve(file);
    this.log = log;
    /** @type {Map<string, any>} accountId → 累计 */
    this.accounts = new Map();
    /** @type {Map<string, number>} matchId → 时间（幂等账本） */
    this.matches = new Map();
    this.loaded = false;
    this.dirty = false;
    this.updatedAt = 0;
  }

  // ── 载入 / 写盘（与 server/accounts.js 同一套纪律）──────────────────────────────

  /** 读盘。文件不存在 ⇒ 空榜（首次运行）。文件存在但坏了 ⇒ **抛错**（调用方应让它中断启动）。 */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') { this.loaded = true; return this; }
      throw new Error(`leaderboard: 读取 ${this.file} 失败：${e?.code || e?.message}`, { cause: e });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`leaderboard: ${this.file} 不是合法 JSON（${e.message}）—— 拒绝启动，避免把它当成空榜覆盖掉`, { cause: e });
    }
    if (!data || typeof data !== 'object' || !data.accounts || typeof data.accounts !== 'object') {
      throw new Error(`leaderboard: ${this.file} 结构不对（缺 accounts）—— 拒绝启动`);
    }
    if (data.format !== LEADERBOARD_FORMAT) {
      throw new Error(`leaderboard: ${this.file} 的 format 是 ${data.format}，本代码读 ${LEADERBOARD_FORMAT}`);
    }
    for (const [id, rec] of Object.entries(data.accounts)) {
      if (!rec || typeof rec !== 'object') continue;
      this.accounts.set(id, {
        ...blank(id, rec.name, rec.firstAt || 0),
        ...rec,
        id,
        rounds: { ...blank(id).rounds, ...(rec.rounds || {}) },
        dmg: { ...blank(id).dmg, ...(rec.dmg || {}) },
        bossDmg: { ...blank(id).bossDmg, ...(rec.bossDmg || {}) },
        stages: { ...(rec.stages || {}) },
        bosses: { ...(rec.bosses || {}) },
        bonds: { ...(rec.bonds || {}) },
        chars: { ...(rec.chars || {}) },
      });
    }
    for (const [id, at] of Object.entries(data.matches || {})) this.matches.set(id, Number(at) || 0);
    this.updatedAt = Number(data.updatedAt) || 0;
    this.loaded = true;
    return this;
  }

  /** 原子写：临时文件 → fsync → rename。任何时刻被杀都不会留下半个文件。 */
  save() {
    const data = {
      format: LEADERBOARD_FORMAT,
      updatedAt: this.updatedAt,
      accounts: Object.fromEntries(this.accounts),
      // 账本按插入顺序落盘（Map 保序），裁剪时删的也是最旧的
      matches: Object.fromEntries(this.matches),
    };
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(data)}\n`);   // 榜单不需要人读，压成一行省空间
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    return this;
  }

  flush() { if (this.dirty) this.save(); return this; }

  get size() { return this.accounts.size; }

  // ── 写入 ──────────────────────────────────────────────────────────────────────

  /**
   * 一局结算入账。**幂等**：同一个 matchId 再调一次不会重复累加。
   *
   * @param {any} result 服务端结算出来的 m.result 结构（server/match/results.js buildResult）
   * @param {{ matchId: string, accountOf: (playerId: string) => (string | null) }} opts
   *        `accountOf` 必须由调用方从 **session** 取（lobby 传的就是 session.accountId）——
   *        这是"排名归到谁头上"唯一可信的来源，绝不能换成请求体里的字段。
   * @returns {{ skipped: boolean, reason?: string, recorded?: number }}
   */
  record(result, { matchId, accountOf }) {
    if (typeof matchId !== 'string' || !matchId) throw new TypeError('leaderboard.record: matchId 必填');
    if (typeof accountOf !== 'function') throw new TypeError('leaderboard.record: accountOf 必填');
    if (!result || !Array.isArray(result.players)) return { skipped: true, reason: 'no-result' };
    if (this.matches.has(matchId)) return { skipped: true, reason: 'duplicate' };

    const at = now();
    let recorded = 0;
    for (const row of result.players) {
      if (!row || row.isBot || !row.playerId) continue;
      const accountId = accountOf(row.playerId);
      if (!accountId) continue;                                  // 没账号的玩家不入榜（随时能补上账号）
      const acc = this.accounts.get(accountId) || blank(accountId, row.name, at);
      this._merge(acc, row, result, at);
      this.accounts.set(accountId, acc);
      recorded += 1;
    }

    this.matches.set(matchId, at);
    this._trimMatches();
    this.updatedAt = at;
    this.dirty = true;
    this.save();
    return { skipped: false, recorded };
  }

  /**
   * 把一行结算数据并进一个账号的累计器。
   * 指标口径与 public/js/ui/stats.js 的 aggregateStats 对齐（那边是本机统计，两边应该能对上数）。
   */
  _merge(acc, row, result, at) {
    const won = !!row.victory;                 // = victory && alive，见 results.js 的 `cleared`
    const rounds = int(row.roundsPassed, LIMITS.rounds);

    acc.name = row.name || acc.name;           // 名字是快照，改名后由调用方同步（见 renameAccount）
    acc.games += 1;
    if (won) acc.wins += 1;
    if (result.hiddenCleared) acc.hiddenCleared += 1;   // 团队级：清掉隐秘核心算全队的

    acc.rounds.total += rounds;
    if (rounds > acc.rounds.max) acc.rounds.max = rounds;

    const st = row.stats || {};
    acc.dmg.sum += int(st.dmgDealt, LIMITS.dmg);
    acc.dmg.n += 1;                                     // 服务端每局都有 stats，所以分母就是局数
    if (rounds >= LATE_GAME_ROUND) {                    // 首领伤害只看打到 13 回合及以后的局
      acc.bossDmg.sum += int(st.bossDamage, LIMITS.dmg);
      acc.bossDmg.n += 1;
    }

    if (result.stageId) {
      const e = acc.stages[result.stageId] || (acc.stages[result.stageId] = pair());
      e.games += 1;
      if (won) e.wins += 1;
    }
    if (result.bossId) {
      const e = acc.bosses[result.bossId] || (acc.bosses[result.bossId] = pair());
      e.games += 1;
      if (won) e.wins += 1;
    }

    // 干员：按出现次数（同一局带两张同名算 2 次，与 stats.js 的 chars[].count 一致）
    for (const u of row.lineup || []) {
      if (!u || !u.id) continue;
      acc.chars[u.id] = int((acc.chars[u.id] || 0) + 1, LIMITS.games);
    }

    // 盟约：胜率按「激活了的局数」算（active），最高层数取历史最大 layers。
    // **不叠层的盟约不在这里排除** —— 那是展示层的口径（bonds.json 的 noStack，见 screens/stats.js），
    // 服务端如实记账，谁想怎么展示由前端决定。
    for (const b of row.bonds || []) {
      if (!b || !b.bondId) continue;
      const e = acc.bonds[b.bondId] || (acc.bonds[b.bondId] = { games: 0, wins: 0, sumLayers: 0, maxLayers: 0 });
      const layers = int(b.layers, LIMITS.layers);
      if (layers > e.maxLayers) e.maxLayers = layers;
      if (!b.active) continue;
      e.games += 1;
      if (won) e.wins += 1;
      e.sumLayers += layers;
    }

    acc.lastAt = at;
    return acc;
  }

  /** 账本裁剪：只留最近的 MATCH_LOG_MAX 条（Map 保序，删最旧的）。 */
  _trimMatches() {
    const over = this.matches.size - MATCH_LOG_MAX;
    if (over <= 0) return;
    let i = 0;
    for (const k of this.matches.keys()) {
      if (i++ >= over) break;
      this.matches.delete(k);
    }
  }

  /**
   * 改名后同步榜单上的名字快照（accountId 不变 —— 历史成绩不会分裂）。
   * @param {string} accountId @param {string} name
   */
  renameAccount(accountId, name) {
    const acc = this.accounts.get(accountId);
    if (!acc || !name || acc.name === name) return acc || null;
    acc.name = name;
    this.dirty = true;
    this.save();
    return acc;
  }

  /** 某个账号的明细（内部 / 管理用）。 */
  accountView(accountId) { return this.accounts.get(accountId) || null; }

  /** 全部账号的累计（管理用）。 */
  list() { return [...this.accounts.values()]; }

  // ── 读出：榜单 ────────────────────────────────────────────────────────────────

  /**
   * 组装给客户端看的榜单。
   * **只返回聚合结果**，不返回任何原始对局 —— 榜上每个人看到的都是同样的公开数据。
   * id（stageId / bossId / bondId / 干员 id）原样返回，名字与图标由客户端用自己的游戏数据解析。
   * @returns {any}
   */
  boards() {
    const all = [...this.accounts.values()];
    const list = all.map((a) => ({
      accountId: a.id,
      name: a.name,
      games: a.games,
      wins: a.wins,
      hiddenCleared: a.hiddenCleared,
      rate: a.games > 0 ? a.wins / a.games : null,
      hiddenRate: a.games > 0 ? a.hiddenCleared / a.games : null,
      roundsTotal: a.rounds.total,
      roundsMax: a.rounds.max,
      avgDmg: a.dmg.n > 0 ? a.dmg.sum / a.dmg.n : null,
      dmgN: a.dmg.n,
      avgBossDmg: a.bossDmg.n > 0 ? a.bossDmg.sum / a.bossDmg.n : null,
      bossDmgN: a.bossDmg.n,
      lastAt: a.lastAt,
    }));

    // 排序：主键降序 → 局数降序 → accountId 升序（**显式写全三键**，不依赖 Array#sort 的稳定性，
    // 与 stats.js 的 rankByRate 同一个理由：并列时结果必须确定）
    const rateDesc = (key) => (a, b) => (
      (num(b[key]) - num(a[key]))
      || (b.games - a.games)
      || (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0)
    );
    const totalDesc = (key) => (a, b) => (
      (num(b[key]) - num(a[key]))
      || (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0)
    );
    // rate 为 null（一场没打 / 分母 0）的排在最后，不参与"最高胜率"的争夺
    const withRate = (key) => list.filter((r) => r[key] != null);

    const players = {
      winrate: cap(withRate('rate').sort(rateDesc('rate'))),
      hidden: cap(withRate('hiddenRate').sort(rateDesc('hiddenRate'))),
      dmg: cap(list.filter((r) => r.avgDmg != null).sort(totalDesc('avgDmg'))),
      bossDmg: cap(list.filter((r) => r.avgBossDmg != null).sort(totalDesc('avgBossDmg'))),
      rounds: cap(list.filter((r) => r.games > 0).sort(totalDesc('roundsMax'))),
      games: cap(list.filter((r) => r.games > 0).sort(totalDesc('games'))),
    };

    // 全服聚合（把所有人的分组数据合起来 —— "这张图在全服范围内好不好打"）
    const stages = new Map(), bosses = new Map(), bonds = new Map(), chars = new Map();
    for (const a of all) {
      for (const [id, e] of Object.entries(a.stages)) {
        const g = stages.get(id) || pair(); g.games += e.games; g.wins += e.wins; stages.set(id, g);
      }
      for (const [id, e] of Object.entries(a.bosses)) {
        const g = bosses.get(id) || pair(); g.games += e.games; g.wins += e.wins; bosses.set(id, g);
      }
      for (const [id, e] of Object.entries(a.bonds)) {
        const g = bonds.get(id) || { games: 0, wins: 0, sumLayers: 0, maxLayers: 0, who: null, whoName: null };
        g.games += e.games; g.wins += e.wins; g.sumLayers += e.sumLayers;
        if (e.maxLayers > g.maxLayers) { g.maxLayers = e.maxLayers; g.who = a.id; g.whoName = a.name; }
        bonds.set(id, g);
      }
      for (const [id, n] of Object.entries(a.chars)) chars.set(id, (chars.get(id) || 0) + n);
    }

    const groupRate = (m) => [...m.entries()].map(([id, e]) => ({
      id, games: e.games, wins: e.wins, rate: e.games > 0 ? e.wins / e.games : null,
    }));

    const world = {
      stages: groupRate(stages).sort((a, b) => (b.games - a.games) || (num(b.rate) - num(a.rate)) || cmpId(a, b)),
      bosses: groupRate(bosses).sort((a, b) => (b.games - a.games) || (num(b.rate) - num(a.rate)) || cmpId(a, b)),
      bonds: [...bonds.entries()].map(([id, e]) => ({
        id, games: e.games, wins: e.wins, rate: e.games > 0 ? e.wins / e.games : null,
        avgLayers: e.games > 0 ? e.sumLayers / e.games : null, maxLayers: e.maxLayers,
      })).sort((a, b) => (b.games - a.games) || (num(b.rate) - num(a.rate)) || cmpId(a, b)),
      chars: [...chars.entries()].map(([id, count]) => ({ id, count }))
        .sort((a, b) => (b.count - a.count) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      bondMaxLayers: [...bonds.entries()].map(([id, e]) => ({
        id, maxLayers: e.maxLayers, who: e.who || null, whoName: e.whoName || null,
      })).sort((a, b) => (b.maxLayers - a.maxLayers) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };

    return {
      updatedAt: this.updatedAt,
      accounts: this.accounts.size,
      matches: this.matches.size,
      lateGameRound: LATE_GAME_ROUND,
      players,
      world,
    };
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);
const cmpId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const cap = (arr) => arr.slice(0, BOARD_MAX);

/** 便捷构造：加载失败会把错误抛给调用方（让它决定是否中断启动）。 */
export function openLeaderboard(opts) {
  return new Leaderboard(opts).load();
}
