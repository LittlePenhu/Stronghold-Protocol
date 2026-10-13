// 排行榜存储与聚合的单元测试（server/leaderboard.js）。
//
// 这个文件的重点同样是**不变量**，不是"功能跑通"：
//   · 同一个 matchId 只入账一次（幂等）—— 重复调用不该把成绩翻倍
//   · 归属只认 accountOf 的返回值（调用方从 session 取），跟 result 里带什么无关
//   · 没账号 / 是 AI 的玩家不入榜
//   · 数值全部钳制：负数 / NaN / 荒谬上限不会污染累加器
//   · 口径与 public/js/ui/stats.js 对齐（尤其"局平均首领伤害只算 ≥13 回合"）
//   · 文件损坏时拒绝启动；写盘原子（不留临时文件）
//   · 排序在并列时必须确定（显式三键，不依赖 sort 的稳定性）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Leaderboard, openLeaderboard, LEADERBOARD_FORMAT, LATE_GAME_ROUND, MATCH_LOG_MAX } from '../server/leaderboard.js';

let seq = 0;
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sp-lb-${process.pid}-${seq++}-`));
  return path.join(dir, 'leaderboard.json');
}
const quiet = { info() {}, warn() {}, error() {} };
const fresh = (file = tmpFile()) => new Leaderboard({ file, log: quiet }).load();

/** 一个玩家的结算行（只填用例关心的字段，其余给符合结构的默认值）。 */
function row(playerId, opts = {}) {
  return {
    playerId, seat: opts.seat ?? 0, name: opts.name || playerId, isBot: !!opts.bot, left: !!opts.left,
    alive: opts.alive !== false,
    victory: opts.victory !== undefined ? opts.victory : true,
    roundsPassed: opts.rounds ?? 14,
    eliminatedRound: null, lp: 10, bandId: opts.bandId || 'band1',
    lineup: opts.lineup || [], bonds: opts.bonds || [],
    stats: {
      dmgDealt: opts.dmg ?? 0, kills: 0, leaks: 0, gold: 0, refreshes: 0, merges: 0, itemsEquipped: 0,
      bossDamage: opts.bossDmg ?? 0, activatedLayers: 0, lpLost: 0, perfectRounds: 0,
    },
    title: null, trophies: [], reward: {},
  };
}

/** 一局结算（m.result 的形状）。 */
function result({ victory = true, rounds = 14, hiddenReached = false, hiddenCleared = false, stageId = 'stage1', bossId = 'boss1', players = [] } = {}) {
  return {
    t: 'm.result', victory, roundsPassed: rounds, hiddenReached, hiddenCleared, reason: 'done',
    teamLp: null, modeId: 'solo', difficulty: 'NORMAL', stageId, bossId, hiddenBossId: null,
    seed: 1234, durationMs: 60_000, players,
  };
}

/** 所有玩家都归到一个固定账号上的 accountOf。 */
const toAccount = (id) => () => id;
/** 按 playerId 前缀映射到账号（用于多人局）。 */
const byPlayer = (map) => (pid) => map[pid] || null;

describe('leaderboard: 入账与幂等', () => {
  test('★ 同一个 matchId 入账两次，只累加一次', () => {
    const lb = fresh();
    const r = result({ players: [row('p1', { dmg: 100 })] });
    assert.deepEqual(lb.record(r, { matchId: 'm1', accountOf: toAccount('a_1') }), { skipped: false, recorded: 1 });
    const again = lb.record(r, { matchId: 'm1', accountOf: toAccount('a_1') });
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'duplicate');
    assert.equal(lb.accountView('a_1').games, 1, '不该变成 2 局');
    assert.equal(lb.accountView('a_1').dmg.sum, 100, '伤害不该翻倍');
  });

  test('matchId / accountOf 必填（缺了要立刻炸，而不是静默记一笔坏账）', () => {
    const lb = fresh();
    assert.throws(() => lb.record(result({ players: [] }), { accountOf: () => null }), TypeError);
    assert.throws(() => lb.record(result({ players: [] }), { matchId: 'x' }), TypeError);
  });

  test('没账号的玩家不入榜；AI 不入榜；人类玩家照常入', () => {
    const lb = fresh();
    lb.record(result({
      players: [
        row('p1', { name: '有账号', dmg: 10 }),
        row('p2', { name: '没账号', dmg: 999 }),
        row('p3', { name: 'AI', isBot: true, dmg: 999 }),
      ],
    }), { matchId: 'm1', accountOf: (pid) => (pid === 'p1' ? 'a_1' : null) });
    assert.equal(lb.size, 1);
    assert.equal(lb.accountView('a_1').games, 1);
    assert.equal(lb.accountView('a_1').dmg.sum, 10);
  });

  test('四人局各归各的账号，互不串', () => {
    const lb = fresh();
    lb.record(result({
      players: [row('p1', { dmg: 100 }), row('p2', { dmg: 200 }), row('p3', { dmg: 300 }), row('p4', { dmg: 400 })],
    }), { matchId: 'm1', accountOf: byPlayer({ p1: 'a_1', p2: 'a_2', p3: 'a_3', p4: 'a_4' }) });
    assert.equal(lb.size, 4);
    for (const [i, id] of ['a_1', 'a_2', 'a_3', 'a_4'].entries()) {
      assert.equal(lb.accountView(id).dmg.sum, (i + 1) * 100, `${id} 的伤害串了`);
      assert.equal(lb.accountView(id).games, 1);
    }
  });

  test('归属只认 accountOf —— result 里塞的 playerId / name 影响不了它', () => {
    const lb = fresh();
    // 一个玩家自称是别人（name 和 playerId 都伪装）
    const evil = row('p_victim', { name: '受害者', dmg: 50 });
    lb.record(result({ players: [evil] }), { matchId: 'm1', accountOf: () => 'a_attacker' });
    assert.equal(lb.size, 1);
    assert.ok(lb.accountView('a_attacker'), '成绩必须记在 accountOf 给的那个账号上');
    assert.equal(lb.accountView('a_attacker').dmg.sum, 50);
  });

  test('accountOf 返回 null 的整局跳过（比如玩家中途没了 session）', () => {
    const lb = fresh();
    const res = lb.record(result({ players: [row('p1')] }), { matchId: 'm1', accountOf: () => null });
    assert.deepEqual(res, { skipped: false, recorded: 0 });
    assert.equal(lb.size, 0);
    // 但这局本身仍要记账本（下次同一 matchId 依然会被判重复）
    assert.equal(lb.record(result({ players: [row('p1')] }), { matchId: 'm1', accountOf: () => 'a_1' }).skipped, true);
  });
});

describe('leaderboard: 指标口径（与 public/js/ui/stats.js 对齐）', () => {
  test('胜率 / 隐藏胜率 / 局数与回合数', () => {
    const lb = fresh();
    const acc = toAccount('a_1');
    lb.record(result({ victory: true, hiddenCleared: true, rounds: 15, players: [row('p1', { rounds: 15 })] }), { matchId: 'm1', accountOf: acc });
    lb.record(result({ victory: false, rounds: 8, players: [row('p1', { victory: false, rounds: 8 })] }), { matchId: 'm2', accountOf: acc });
    lb.record(result({ victory: true, rounds: 14, players: [row('p1')] }), { matchId: 'm3', accountOf: acc });
    const a = lb.accountView('a_1');
    assert.equal(a.games, 3);
    assert.equal(a.wins, 2);
    assert.equal(a.hiddenCleared, 1, 'hiddenCleared 是团队级的');
    assert.equal(a.rounds.total, 37);
    assert.equal(a.rounds.max, 15);
  });

  test('地图 / 首领胜率按 result 的 stageId / bossId 分组', () => {
    const lb = fresh();
    const acc = toAccount('a_1');
    lb.record(result({ stageId: 's1', bossId: 'b1', victory: true, players: [row('p1')] }), { matchId: 'm1', accountOf: acc });
    lb.record(result({ stageId: 's1', bossId: 'b2', victory: false, players: [row('p1', { victory: false })] }), { matchId: 'm2', accountOf: acc });
    lb.record(result({ stageId: 's2', bossId: 'b1', victory: true, players: [row('p1')] }), { matchId: 'm3', accountOf: acc });
    const a = lb.accountView('a_1');
    assert.deepEqual(a.stages.s1, { games: 2, wins: 1 });
    assert.deepEqual(a.stages.s2, { games: 1, wins: 1 });
    assert.deepEqual(a.bosses.b1, { games: 2, wins: 2 });
    assert.deepEqual(a.bosses.b2, { games: 1, wins: 0 });
  });

  test('盟约胜率只算 active：不激活不计入胜率，但层数照样记（最高层数看得到）', () => {
    const lb = fresh();
    lb.record(result({
      players: [row('p1', { bonds: [{ bondId: 'yan', active: false, layers: 7 }, { bondId: 'jia', active: true, layers: 3 }] })],
    }), { matchId: 'm1', accountOf: toAccount('a_1') });
    const a = lb.accountView('a_1');
    assert.equal(a.bonds.yan.games, 0, '没激活的盟约不算"用过"');
    assert.equal(a.bonds.yan.maxLayers, 7, '但最高层数要记下来');
    assert.equal(a.bonds.jia.games, 1);
    assert.equal(a.bonds.jia.wins, 1);
  });

  test('惯用干员按出现次数累加（同一局两张同名算两次）', () => {
    const lb = fresh();
    const acc = toAccount('a_1');
    lb.record(result({ players: [row('p1', { lineup: [{ id: 'c1' }, { id: 'c1' }, { id: 'c2' }] })] }), { matchId: 'm1', accountOf: acc });
    lb.record(result({ players: [row('p1', { lineup: [{ id: 'c1' }] })] }), { matchId: 'm2', accountOf: acc });
    const a = lb.accountView('a_1');
    assert.equal(a.chars.c1, 3);
    assert.equal(a.chars.c2, 1);
  });

  test('★ 局平均首领伤害只统计 roundsPassed ≥ 13 的对局', () => {
    const lb = fresh();
    const acc = toAccount('a_1');
    // 14 回合：计入首领伤害
    lb.record(result({ rounds: 14, players: [row('p1', { rounds: 14, dmg: 1000, bossDmg: 600 })] }), { matchId: 'm1', accountOf: acc });
    // 12 回合：伤害计入，首领伤害**不计入**
    lb.record(result({ rounds: 12, players: [row('p1', { rounds: 12, dmg: 500, bossDmg: 100 })] }), { matchId: 'm2', accountOf: acc });
    const a = lb.accountView('a_1');
    assert.equal(a.dmg.sum, 1500);
    assert.equal(a.dmg.n, 2, '普通伤害两局都算');
    assert.equal(a.bossDmg.sum, 600, '12 回合那局的 100 不该进来');
    assert.equal(a.bossDmg.n, 1);
    const boards = lb.boards();
    assert.equal(boards.lateGameRound, LATE_GAME_ROUND);
    assert.equal(boards.players.bossDmg[0].avgBossDmg, 600);
    assert.equal(boards.players.bossDmg[0].bossDmgN, 1);
  });
});

describe('leaderboard: 数值钳制（防的是程序 bug，不是作弊）', () => {
  test('负数 / NaN / Infinity 一律收敛到 0，不污染累加器', () => {
    const lb = fresh();
    lb.record(result({
      rounds: -5,
      players: [row('p1', { rounds: -5, dmg: -100, bossDmg: NaN, lineup: [{}, { id: '' }, { id: 'c1' }], bonds: [{ bondId: 'yan', active: true, layers: -3 }] })],
    }), { matchId: 'm1', accountOf: toAccount('a_1') });
    const a = lb.accountView('a_1');
    assert.equal(a.games, 1);
    assert.equal(a.dmg.sum, 0);
    assert.equal(a.bossDmg.sum, 0);
    assert.equal(a.rounds.total, 0);
    assert.equal(a.rounds.max, 0);
    assert.equal(a.bonds.yan.maxLayers, 0);
    assert.equal(a.chars.c1, 1, '合法的干员 id 仍要记');
  });

  test('荒谬的大数被钳到上限', () => {
    const lb = fresh();
    lb.record(result({
      rounds: 1e9,
      players: [row('p1', { rounds: 1e9, dmg: 1e300, bonds: [{ bondId: 'yan', active: true, layers: 1e9 }] })],
    }), { matchId: 'm1', accountOf: toAccount('a_1') });
    const a = lb.accountView('a_1');
    assert.equal(a.rounds.max, 999);
    assert.ok(a.dmg.sum <= 1e12);
    assert.equal(a.bonds.yan.maxLayers, 999);
  });

  test('结构不对的结果不会炸，只是不入账', () => {
    const lb = fresh();
    assert.deepEqual(lb.record(null, { matchId: 'm1', accountOf: () => 'a_1' }), { skipped: true, reason: 'no-result' });
    assert.deepEqual(lb.record({ players: 'nope' }, { matchId: 'm2', accountOf: () => 'a_1' }), { skipped: true, reason: 'no-result' });
    // players 里混进 null / 缺 playerId 的行也不该炸
    const r = lb.record({ players: [null, {}, row('p1')] }, { matchId: 'm3', accountOf: () => 'a_1' });
    assert.equal(r.recorded, 1);
  });
});

describe('leaderboard: 持久化与崩溃安全', () => {
  test('关掉再开，累计还在；账本也在（幂等性跨重启仍然成立）', () => {
    const file = tmpFile();
    const a = fresh(file);
    a.record(result({ players: [row('p1', { dmg: 777 })] }), { matchId: 'm1', accountOf: toAccount('a_1') });
    const b = fresh(file);
    assert.equal(b.size, 1);
    assert.equal(b.accountView('a_1').dmg.sum, 777);
    assert.equal(b.accountView('a_1').games, 1);
    // 跨重启的幂等
    assert.equal(b.record(result({ players: [row('p1')] }), { matchId: 'm1', accountOf: toAccount('a_1') }).skipped, true);
  });

  test('★ 文件损坏 ⇒ 拒绝启动，而不是当作空榜把人清掉', () => {
    const file = tmpFile();
    fresh(file).record(result({ players: [row('p1')] }), { matchId: 'm1', accountOf: toAccount('a_1') });
    fs.writeFileSync(file, '{ 坏掉的 JSON');
    assert.throws(() => fresh(file), /拒绝启动/);
    fs.writeFileSync(file, JSON.stringify({ format: LEADERBOARD_FORMAT }));
    assert.throws(() => fresh(file), /缺 accounts/);
    fs.writeFileSync(file, JSON.stringify({ format: 42, accounts: {} }));
    assert.throws(() => fresh(file), /format/);
  });

  test('文件不存在 ⇒ 空榜（首次运行）', () => {
    const lb = fresh(path.join(os.tmpdir(), `sp-lb-none-${Date.now()}.json`));
    assert.equal(lb.size, 0);
    assert.equal(lb.loaded, true);
  });

  test('写盘原子：不留临时文件，写的永远是完整 JSON', () => {
    const file = tmpFile();
    const lb = fresh(file);
    for (let i = 0; i < 5; i++) lb.record(result({ players: [row('p1')] }), { matchId: `m${i}`, accountOf: toAccount('a_1') });
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '不该留下临时文件');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(fresh(file).accountView('a_1').games, 5);
  });

  test('openLeaderboard 把加载错误抛给调用方', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'garbage');
    assert.throws(() => openLeaderboard({ file, log: quiet }), /拒绝启动/);
  });

  test('账本超过上限时裁剪最旧的（不会无限增长）', () => {
    const lb = fresh();
    const acc = toAccount('a_1');
    for (let i = 0; i < MATCH_LOG_MAX + 10; i++) {
      lb.record(result({ players: [row('p1')] }), { matchId: `m${i}`, accountOf: acc });
    }
    assert.equal(lb.matches.size, MATCH_LOG_MAX);
    // 最旧的已被裁掉：再记一次 m0 会被当成新的一局（这是裁剪的已知代价，写在这里当文档）
    assert.equal(lb.record(result({ players: [row('p1')] }), { matchId: 'm0', accountOf: acc }).skipped, false);
  });
});

describe('leaderboard: 榜单组装', () => {
  test('胜率榜按胜率降序，并列时局数多的在前，再并列按 id 升序（确定性）', () => {
    const lb = fresh();
    // a_1: 1/1 = 100%（1 局）  a_2: 2/2 = 100%（2 局）  a_3: 1/2 = 50%
    lb.record(result({ players: [row('p1')] }), { matchId: 'm1', accountOf: toAccount('a_1') });
    lb.record(result({ players: [row('p2')] }), { matchId: 'm2', accountOf: toAccount('a_2') });
    lb.record(result({ players: [row('p2')] }), { matchId: 'm3', accountOf: toAccount('a_2') });
    lb.record(result({ victory: true, players: [row('p3')] }), { matchId: 'm4', accountOf: toAccount('a_3') });
    lb.record(result({ victory: false, rounds: 5, players: [row('p3', { victory: false, rounds: 5 })] }), { matchId: 'm5', accountOf: toAccount('a_3') });

    const list = lb.boards().players.winrate;
    assert.deepEqual(list.map((r) => r.accountId), ['a_2', 'a_1', 'a_3'], '100% 的两条应按局数排，a_2 在前');
    assert.equal(list[0].rate, 1);
    assert.equal(list[2].rate, 0.5);
  });

  test('一场没打的账号不进任何榜（rate 为 null 的排最后、不进 withRate 列表）', () => {
    const lb = fresh();
    lb.record(result({ players: [row('p1')] }), { matchId: 'm1', accountOf: toAccount('a_1') });
    // 手工塞一个 0 局的账号（模拟刚注册还没打）
    lb.accounts.set('a_new', { ...JSON.parse(JSON.stringify(lb.accountView('a_1'))), id: 'a_new', games: 0, wins: 0, dmg: { sum: 0, n: 0 }, bossDmg: { sum: 0, n: 0 } });
    const boards = lb.boards();
    assert.equal(boards.players.winrate.some((r) => r.accountId === 'a_new'), false);
    assert.equal(boards.accounts, 2, '但它仍然计入账号总数');
  });

  test('全服聚合：地图 / 首领 / 盟约胜率与干员频率是所有人合起来的', () => {
    const lb = fresh();
    lb.record(result({
      stageId: 's1', bossId: 'b1',
      players: [row('p1', { lineup: [{ id: 'c1' }], bonds: [{ bondId: 'yan', active: true, layers: 5 }] })],
    }), { matchId: 'm1', accountOf: toAccount('a_1') });
    lb.record(result({
      stageId: 's1', bossId: 'b1', victory: false,
      players: [row('p2', { victory: false, lineup: [{ id: 'c1' }, { id: 'c2' }], bonds: [{ bondId: 'yan', active: true, layers: 9 }] })],
    }), { matchId: 'm2', accountOf: toAccount('a_2') });

    const w = lb.boards().world;
    const s1 = w.stages.find((x) => x.id === 's1');
    assert.deepEqual({ games: s1.games, wins: s1.wins, rate: s1.rate }, { games: 2, wins: 1, rate: 0.5 });
    const yan = w.bonds.find((x) => x.id === 'yan');
    assert.equal(yan.games, 2);
    assert.equal(yan.maxLayers, 9, '最高层数取所有人里的最大值');
    assert.equal(yan.avgLayers, 7, '(5+9)/2');
    assert.deepEqual(w.chars.find((x) => x.id === 'c1'), { id: 'c1', count: 2 });
    assert.deepEqual(w.chars.find((x) => x.id === 'c2'), { id: 'c2', count: 1 });
    const rec = w.bondMaxLayers.find((x) => x.id === 'yan');
    assert.equal(rec.maxLayers, 9);
    assert.equal(rec.who, 'a_2', '要指出是谁创下的');
  });

  test('干员频率榜按次数降序，次数并列按 id 升序', () => {
    const lb = fresh();
    const acc = toAccount('a_1');
    lb.record(result({ players: [row('p1', { lineup: [{ id: 'ccc' }, { id: 'aaa' }, { id: 'bbb' }] })] }), { matchId: 'm1', accountOf: acc });
    const chars = lb.boards().world.chars;
    assert.deepEqual(chars.map((c) => c.id), ['aaa', 'bbb', 'ccc'], '次数全为 1，应按 id 升序');
  });

  test('改名同步榜单上的名字快照，accountId 与历史不分裂', () => {
    const lb = fresh();
    lb.record(result({ players: [row('p1', { name: '旧名' })] }), { matchId: 'm1', accountOf: toAccount('a_1') });
    lb.renameAccount('a_1', '新名');
    assert.equal(lb.accountView('a_1').name, '新名');
    assert.equal(lb.accountView('a_1').games, 1, '历史成绩不受改名影响');
    assert.equal(lb.boards().players.games[0].name, '新名');
  });
});
