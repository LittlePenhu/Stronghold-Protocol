// test/room-list.test.js — 实时在线房间列表（S2C `lobby.rooms` / `welcome.rooms`；server/lobby.js roomList / broadcastRooms）。
//
// 钉的不变量（不是「功能跑通」）：
//   · 列表只推给**不在房间里**的会话 —— 成员看 room.state，两套信息不重复发；
//   · 每帧都是**全量快照**，客户端直接覆盖，没有增量协议要维护；
//   · 行里只有房间码 / 模式 / 难度 / 是否对局 / 人数（博士 / AI / 观战）/ 房主显示名 ——
//     **没有玩家 id、没有座位明细**（这是「有哪些房间可以进」的目录，不是房间内部状态）；
//   · 顺序确定（创建时间升序，同毫秒按房间码）；
//   · 房间一有变化（创建 / 加入 / AI 补位 / 开打 / 打完 / 解散）旁观者立刻拿到新列表，
//     刚被请出房间的人（解散路径）也拿到。
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { S2C, validateC2S } from '../shared/protocol.js';
import { MAX_SEATS } from '../shared/constants.js';

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect() { const c = await TestClient.connect(getUrl()); open.add(c); return c; },
    async player(name, token) {
      const c = await this.connect();
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createRoom(c, mode = 'coop', difficulty = 'NORMAL') {
  await ok(c, { t: 'room.create', mode, difficulty });
  return c.waitFor('room.state', (s) => s.hostId === c.id);
}
async function joinRoom(c, code) {
  await ok(c, { t: 'room.join', code });
  return c.waitFor('room.state', (s) => s.code === code && !!seatOf(s, c.id));
}

describe('实时在线房间列表 (lobby.rooms)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: StubMatch, lobbyGraceMs: 60_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => {
    await pool.closeAll();
    // 断线的房间要等 60s 宽限才消失 —— 测试之间手动清场，别让上一个的房间污染下一个的列表断言
    for (const room of [...srv.lobby.rooms.values()]) srv.lobby.disposeRoom(room, 'test teardown');
  });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  test('protocol: `lobby.rooms` 是 S2C，不是客户端能发的意图', () => {
    assert.ok(S2C.includes('lobby.rooms'), 'S2C 认识 lobby.rooms');
    assert.notEqual(validateC2S({ t: 'lobby.rooms', rooms: [] }), null, '客户端发它是非法消息');
  });

  test('welcome.rooms 是初始快照：没有房间时也是空数组，有房间时是当时那份', async () => {
    const alone = await pool.player('SoloWatcher');
    const w0 = alone.log.find((m) => m.t === 'welcome');
    assert.deepEqual(w0.rooms, [], '空表也是数组（客户端不用判 undefined）');

    const host = await pool.player('Host');
    const st = await createRoom(host);
    await pool.player('LateJoiner').then(async (late) => {
      const w = late.log.find((m) => m.t === 'welcome');
      assert.equal(w.rooms.length, 1);
      assert.equal(w.rooms[0].code, st.code);
    });
  });

  test('创建 / 加入：旁观者拿到全量快照 —— 行里只有房间码/模式/难度/对局/人数/房主名，没有玩家 id', async () => {
    const watcher = await pool.player('Watcher');
    const host = await pool.player('Host');
    const st = await createRoom(host, 'coop', 'HARD');

    const first = await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 1);
    const row = first.rooms[0];
    assert.deepEqual(Object.keys(row).sort(), ['bots', 'code', 'difficulty', 'host', 'humans', 'inMatch', 'mode', 'spectators'],
      '行的形状就是这几列 —— 多出 playerId / seats 就是泄漏了房间内部状态');
    assert.equal(row.code, st.code);
    assert.equal(row.mode, 'coop');
    assert.equal(row.difficulty, 'HARD');
    assert.equal(row.inMatch, false);
    assert.equal(row.humans, 1);
    assert.equal(row.bots, 0);
    assert.equal(row.spectators, 0);
    assert.equal(row.host, 'Host');
    assert.ok(row.humans + row.bots <= MAX_SEATS);

    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    const second = await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 1 && m.rooms[0].humans === 2);
    assert.equal(second.rooms[0].host, 'Host', '房主没变');
  });

  test('成员不收 lobby.rooms：房间里的人看 room.state，列表只给旁观者', async () => {
    const watcher = await pool.player('Watcher');
    const host = await pool.player('Host');
    const guest = await pool.player('Guest');
    const st = await createRoom(host);
    await joinRoom(guest, st.code);
    await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 1 && m.rooms[0].humans === 2);

    // 到这里为止的推送都消费完了：接下来的一次变化，旁观者收到、成员收不到
    watcher.clearInbox();
    guest.clearInbox();
    host.clearInbox();
    await ok(host, { t: 'room.addBot' });
    await watcher.waitFor('lobby.rooms', (m) => m.rooms[0].bots === 1);
    await guest.expectNone('lobby.rooms');
    await host.expectNone('lobby.rooms');
  });

  test('AI 补位 / 开打 / 打完：bots 与 inMatch 的变化都推给旁观者', async () => {
    const watcher = await pool.player('Watcher');
    const host = await pool.player('Host');
    const st = await createRoom(host);
    await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 1 && m.rooms[0].humans === 1);

    await ok(host, { t: 'room.addBot' });
    const withBot = await watcher.waitFor('lobby.rooms', (m) => m.rooms[0].bots === 1);
    assert.equal(withBot.rooms[0].inMatch, false);

    await ok(host, { t: 'room.start' });
    const playing = await watcher.waitFor('lobby.rooms', (m) => m.rooms[0].inMatch === true);
    assert.equal(playing.rooms[0].code, st.code);

    // StubMatch：所有人类 g.infoReady 即结算，房间回到大厅（inMatch false）也要推
    await ok(host, { t: 'g.infoReady' });
    const done = await watcher.waitFor('lobby.rooms', (m) => m.rooms[0].inMatch === false, 5000);
    assert.equal(done.rooms[0].humans, 1);
  });

  test('解散：最后一个博士离开 → 空列表推给旁观者，离开的人自己也拿到', async () => {
    const watcher = await pool.player('Watcher');
    const host = await pool.player('Host');
    const guest = await pool.player('Guest');
    const st = await createRoom(host);
    await joinRoom(guest, st.code);
    await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 1 && m.rooms[0].humans === 2);

    await ok(guest, { t: 'room.leave' });
    await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 1 && m.rooms[0].humans === 1);
    await ok(host, { t: 'room.leave' });
    const empty = await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 0);
    assert.deepEqual(empty.rooms, []);
    // 最后离开的房主刚被请出房间，也以旁观者身份拿到空表
    const forHost = await host.waitFor('lobby.rooms', (m) => m.rooms.length === 0);
    assert.deepEqual(forHost.rooms, []);
  });

  test('多房间顺序确定：创建时间升序（同毫秒按房间码），每帧都是完整列表', async () => {
    const watcher = await pool.player('Watcher');
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const host = await pool.player(`Host${i}`);
      const st = await createRoom(host, 'solo', 'FUNNY');
      codes.push(st.code);
      await sleep(5); // 同毫秒才走房间码 tie-break；这里拉开时间，断言创建顺序
    }
    const list = await watcher.waitFor('lobby.rooms', (m) => m.rooms.length === 3);
    assert.deepEqual(list.rooms.map((r) => r.code), codes, '按创建时间排序');
    // solo 房间也在列表里（显示谁在线），但没有可加入的座位语义 —— 行形状不变
    assert.deepEqual([...new Set(list.rooms.map((r) => r.mode))], ['solo']);
  });
});
