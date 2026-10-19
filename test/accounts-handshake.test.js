// 账号握手的端到端测试（server/net.js 的 onHelloMsg + server/accounts.js）。
//
// 这里验的是**从 socket 进来的那条路**：客户端在 hello 里能带什么、服务端怎么裁定身份、
// 以及最关键的 —— **别人能不能靠输入一个名字变成你**。
//
// 每条用例都对应一个具体的攻击面，不是"功能跑通"：
//   · 无凭证 + 别人占着的名字 ⇒ 必须拒（NAME_TAKEN），这是整个系统的那条线
//   · 客户端往 hello 里塞 accountId / 别人的凭证 ⇒ 必须无效
//   · 客户端带着凭证但填了别的名字 ⇒ 名字以账号为准（改输入框改不出一个人）
//   · 恢复已有 session 时不许重新判定身份（否则一次重连就是一个变人的口子）
//   · 密码错与"账号没设密码"不可区分（不泄漏某个名字是否存在）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Network, SessionRegistry, NET_DEFAULTS } from '../server/net.js';
import { openAccounts } from '../server/accounts.js';
import { ERR, PROTOCOL_VERSION } from '../shared/constants.js';

let seq = 0;
const tmpFile = () => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), `sp-acct-hs-${process.pid}-${seq++}-`)),
  'accounts.json',
);
const quiet = { info() {}, warn() {}, error() {} };

/** 一个只收帧的假连接（够 onHelloMsg 用：它只碰 session / ws / ip / key）。 */
function fakeConn() {
  const frames = [];
  return {
    frames,
    conn: {
      session: null, ip: '203.0.113.7', key: null, closing: false,
      ws: { readyState: 1, bufferedAmount: 0, send(raw) { frames.push(JSON.parse(raw)); }, close() {} },
    },
    last: () => frames[frames.length - 1],
  };
}

/** 一套 Network + 账号库，t.after 里收尾。 */
function stack(t, { accountsFile = tmpFile() } = {}) {
  const registry = new SessionRegistry();
  const accounts = openAccounts({ file: accountsFile, log: quiet });
  const network = new Network({ registry, handler: { onMessage() {} }, log: quiet, accounts });
  t.after(() => network.close());
  const hello = (c, msg) => network.onHelloMsg(c.conn, { t: 'hello', version: PROTOCOL_VERSION, ...msg }, Date.now());
  return { registry, accounts, network, hello };
}

describe('账号握手：新玩家与设备凭证', () => {
  test('第一次 hello（不带凭证）⇒ 自动注册，welcome 里带回 accountId 与一次性凭证', (t) => {
    const { accounts, hello } = stack(t);
    const a = fakeConn();
    hello(a, { rid: 1, name: '喷壶' });
    const w = a.last();
    assert.equal(w.t, 'welcome');
    assert.equal(w.name, '喷壶');
    assert.match(w.accountId, /^a_/);
    assert.equal(w.accountNew, true, '应标记为新账号');
    assert.match(w.accountToken, /^[0-9a-f]{32}$/);
    // 服务端真的建了账号，而且凭证能对上
    assert.equal(accounts.size, 1);
    assert.equal(accounts.byCredential(w.accountToken).id, w.accountId);
  });

  test('第二次 hello（带上次的凭证）⇒ 同一个 accountId，不再签发新凭证', (t) => {
    const { hello } = stack(t);
    const first = fakeConn();
    hello(first, { rid: 1, name: '喷壶' });
    const token = first.last().accountToken;
    const id = first.last().accountId;

    const second = fakeConn();
    hello(second, { rid: 2, name: '喷壶', accountToken: token });
    const w = second.last();
    assert.equal(w.accountId, id);
    assert.equal(w.accountToken, undefined, '已有凭证时不该再签发');
    assert.equal(w.accountNew, undefined);
    // 两次是不同的 session（playerId 不同），但归同一个账号
    assert.notEqual(w.playerId, first.last().playerId);
  });

  test('★ 带着凭证却填了别人的名字 ⇒ 名字以账号为准（改输入框改不出一个人）', (t) => {
    const { hello, accounts } = stack(t);
    const mine = fakeConn();
    hello(mine, { rid: 1, name: '喷壶' });
    const myToken = mine.last().accountToken;
    const myId = mine.last().accountId;
    // 另一个人占着别的名字
    const other = fakeConn();
    hello(other, { rid: 2, name: '别人' });
    assert.notEqual(other.last().accountId, myId);

    // 我带着**自己的**凭证，却把名字填成"别人"
    const sneaky = fakeConn();
    hello(sneaky, { rid: 3, name: '别人', accountToken: myToken });
    const w = sneaky.last();
    assert.equal(w.accountId, myId, '身份只能由凭证决定');
    assert.equal(w.name, '喷壶', '名字必须是账号自己的，不能是输入框里那个');
    assert.equal(accounts.size, 2, '不该因此多出一个账号');
  });

  test('客户端往 hello 里塞 accountId / token 字段都没用（身份不自报）', (t) => {
    const { hello, accounts } = stack(t);
    const victim = fakeConn();
    hello(victim, { rid: 1, name: '受害者' });
    const victimId = victim.last().accountId;

    const attacker = fakeConn();
    // 各种"我猜服务端可能会认"的写法，全都不该起作用
    hello(attacker, { rid: 2, name: '攻击者', accountId: victimId, id: victimId, token: victimId });
    const w = attacker.last();
    assert.notEqual(w.accountId, victimId, '不能靠自报 id 变成别人');
    assert.equal(w.name, '攻击者');
    assert.equal(accounts.size, 2);
  });
});

describe('账号握手：名字被占用（防串号的主战场）', () => {
  test('★ 名字已被占用 + 没有凭证 + 没有密码 ⇒ NAME_TAKEN', (t) => {
    const { hello, accounts } = stack(t);
    const owner = fakeConn();
    hello(owner, { rid: 1, name: '喷壶' });
    const before = accounts.size;

    const impostor = fakeConn();
    hello(impostor, { rid: 2, name: '喷壶' });
    const w = impostor.last();
    assert.equal(w.t, 'error');
    assert.equal(w.code, ERR.NAME_TAKEN);
    assert.equal(impostor.conn.session, null, '被拒的连接不该拿到 session');
    assert.equal(accounts.size, before, '不该多出账号');
  });

  test('大小写 / 全角 / 首尾空格的等价写法一样挡住', (t) => {
    const { hello } = stack(t);
    const owner = fakeConn();
    hello(owner, { rid: 1, name: 'PenHu' });
    for (const name of ['penhu', 'PENHU', 'ｐｅｎｈｕ']) {
      const c = fakeConn();
      hello(c, { rid: 2, name });
      assert.equal(c.last().code, ERR.NAME_TAKEN, `${name} 应被挡住`);
      assert.equal(c.conn.session, null);
    }
  });

  test('名字被占用 + 密码对 ⇒ 放行，且是同一个账号（换设备）', (t) => {
    const { hello, accounts } = stack(t);
    const first = fakeConn();
    hello(first, { rid: 1, name: '喷壶', accountPassword: 'pw123456' });
    const id = first.last().accountId;

    // 第二台设备：没有凭证，只有名字 + 密码
    const second = fakeConn();
    hello(second, { rid: 2, name: '喷壶', accountPassword: 'pw123456' });
    const w = second.last();
    assert.equal(w.t, 'welcome');
    assert.equal(w.accountId, id, '必须是同一个账号');
    assert.match(w.accountToken, /^[0-9a-f]{32}$/, '换设备应拿到新凭证');
    assert.equal(accounts.byCredential(first.last().accountToken).id, id, '旧设备仍有效（不是抢座位）');
    assert.equal(accounts.byCredential(w.accountToken).id, id);
    assert.equal(accounts.size, 1);
  });

  test('★ 没设密码的账号在握手层返回 NO_PASSWORD（不是「密码不正确」）', (t) => {
    // 这条测试原先断言握手层把「密码错」与「没设密码」都映射成 BAD_CREDENTIALS，
    // 理由是「不泄漏账号是否存在」。2026-10-13 改成 NO_PASSWORD —— 前端需要区分这两种情况，
    // 否则没设密码的玩家会卡在「密码不正确」的死循环里（那个密码根本不存在）。
    // 要守住的底线仍然是：**拒绝时不签发任何 session、不给出任何凭证**。
    const { hello } = stack(t);
    const a = fakeConn();
    hello(a, { rid: 1, name: '甲', accountPassword: 'pw123456' });   // 设了密码
    const b = fakeConn();
    hello(b, { rid: 2, name: '乙' });                              // 没设密码

    // 设了密码 + 错密码 → BAD_CREDENTIALS（提示不变）
    const c = fakeConn();
    hello(c, { rid: 3, name: '甲', accountPassword: 'wrong' });
    assert.equal(c.last().code, ERR.BAD_CREDENTIALS);
    assert.equal(c.last().detail, 'BAD_CREDENTIALS');
    assert.equal(c.conn.session, null, '拒绝时不建 session');

    // 没设密码 + 任意密码 → NO_PASSWORD
    const d = fakeConn();
    hello(d, { rid: 4, name: '乙', accountPassword: 'pw123456' });
    assert.equal(d.last().code, ERR.NO_PASSWORD);
    assert.equal(d.last().detail, 'NO_PASSWORD');
    assert.equal(d.conn.session, null, '同样不建 session');
    assert.equal(d.last().accountId, undefined, '也不回 accountId');
    assert.equal(d.last().accountToken, undefined, '更不发凭证');
  });

  test('密码太短在注册路径上被拒', (t) => {
    const { hello, accounts } = stack(t);
    const c = fakeConn();
    hello(c, { rid: 1, name: '新人', accountPassword: '12345' });
    assert.equal(c.last().code, ERR.BAD_PASSWORD);
    assert.equal(accounts.size, 0);
  });
});

describe('账号握手：session 恢复时不许重新判定身份', () => {
  test('★ 拿着会话 token 重连，改名字 / 改 accountToken 都不影响他是谁', (t) => {
    const { hello, accounts, registry } = stack(t);
    const first = fakeConn();
    hello(first, { rid: 1, name: '喷壶' });
    const sessionToken = first.last().token;    // 会话重连令牌
    const accountId = first.last().accountId;

    // 换个 socket 上来，带会话 token —— 同时把名字改成别人的、还塞一个假的账号凭证
    const again = fakeConn();
    hello(again, { rid: 2, name: '管理员', token: sessionToken, accountToken: 'f'.repeat(32) });
    const w = again.last();
    assert.equal(w.t, 'welcome');
    assert.equal(w.resumed, true);
    assert.equal(w.accountId, accountId, '恢复的是同一个账号');
    assert.equal(w.name, '喷壶', '名字以账号为准，不能靠重连改名');
    assert.equal(accounts.size, 1);
    assert.equal(registry.size, 1, '应是同一个 session 被接管，不是新建');
  });

  test('会话重连时若账号已被删掉 ⇒ 降级成无账号 session，而不是崩掉', (t) => {
    const { hello, accounts } = stack(t);
    const first = fakeConn();
    hello(first, { rid: 1, name: '喷壶' });
    const sessionToken = first.last().token;
    // 人为把账号从库里抹掉（模拟管理员手工清库）
    for (const rec of accounts.list()) { accounts.byId.delete(rec.id); accounts.byName.clear(); accounts.byToken.clear(); }

    const again = fakeConn();
    hello(again, { rid: 2, name: '喷壶', token: sessionToken });
    assert.equal(again.last().t, 'welcome', '不该崩，应正常恢复');
    assert.equal(again.last().accountId, undefined, '账号没了就不该再声称归属');
  });
});

describe('账号握手：不带账号库时行为不变', () => {
  test('accounts = null ⇒ 任意名字都能进，welcome 里没有账号字段（既有测试依赖这一点）', (t) => {
    const registry = new SessionRegistry();
    const network = new Network({ registry, handler: { onMessage() {} }, log: quiet });
    t.after(() => network.close());
    const c = fakeConn();
    network.onHelloMsg(c.conn, { t: 'hello', version: PROTOCOL_VERSION, rid: 1, name: '随便' }, Date.now());
    const w = c.last();
    assert.equal(w.t, 'welcome');
    assert.equal(w.accountId, undefined);
    assert.equal(w.accountToken, undefined);
    assert.equal(w.name, '随便');
    // 同一个名字再来一次也是新 session（没有账号概念，名字不唯一）
    const c2 = fakeConn();
    network.onHelloMsg(c2.conn, { t: 'hello', version: PROTOCOL_VERSION, rid: 2, name: '随便' }, Date.now());
    assert.equal(c2.last().t, 'welcome');
    assert.notEqual(c2.last().playerId, w.playerId);
  });
});

describe('账号握手：库坏掉时不静默放行', () => {
  test('账号文件损坏 ⇒ 抛错让启动失败，而不是把所有人当成新玩家', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ 这不是 JSON');
    assert.throws(() => openAccounts({ file, log: quiet }), (e) => e.code === 'STORE');
  });

  test('NET_DEFAULTS 未被账号改动（构造 Network 不传 accounts 也照常）', () => {
    const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
    assert.equal(network.accounts, null);
    assert.equal(network.opts.ratePerSec, NET_DEFAULTS.ratePerSec);
    network.close();
  });
});
