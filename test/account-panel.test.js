// test/account-panel.test.js — 账号面板的四条消息（server/net.js）：
//   account.info       读账号状态
//   account.rename     改代号（accountId 不变；有密码时要带密码）
//   account.logout     退出**这台**设备（只撤当前凭证）
//   account.revokeOthers 踢掉其他设备（保留当前凭证）
//
// 钉的不变量（不是「功能跑通」）：
//   · 身份只看 session.accountId —— 消息里不接受名字 / id；
//   · 「退出这台设备」只撤当前那张凭证，别的设备照旧能用（不能误伤）；
//   · 「踢掉其他设备」保留当前这张，撤掉其余全部；
//   · 有密码的账号改名要带密码；没密码的不用；
//   · 没账号的会话这四条全部拒绝，且不产生任何副作用。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Network, SessionRegistry } from '../server/net.js';
import { openAccounts } from '../server/accounts.js';
import { validateC2S, C2S } from '../shared/protocol.js';
import { ERR, PROTOCOL_VERSION } from '../shared/constants.js';

let seq = 0;
const tmpFile = () => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), `sp-acct-panel-${process.pid}-${seq++}-`)),
  'accounts.json',
);
const quiet = { info() {}, warn() {}, error() {} };

function fakeConn() {
  const frames = [];
  return {
    frames,
    conn: {
      session: null, ip: '203.0.113.9', key: null, closing: false, alive: true, drops: 0, dropWindowAt: 0,
      bucket: { take: () => true }, heavy: { take: () => true },
      ws: { readyState: 1, bufferedAmount: 0, send(raw) { frames.push(JSON.parse(raw)); }, close() {} },
    },
    last: () => frames[frames.length - 1],
  };
}

function stack(t, { accountsFile = tmpFile(), withAccounts = true } = {}) {
  const registry = new SessionRegistry();
  const accounts = withAccounts ? openAccounts({ file: accountsFile, log: quiet }) : null;
  const network = new Network({ registry, handler: { onMessage() {} }, log: quiet, accounts });
  t.after(() => network.close());
  const hello = (c, msg) => network.onHelloMsg(c.conn, { t: 'hello', version: PROTOCOL_VERSION, ...msg }, Date.now());
  const send = (c, msg) => network.onFrame(c.conn, JSON.stringify(msg), false);
  return { registry, accounts, network, hello, send };
}

/** 登进来并返回 { conn, token, accountId }。 */
function enter(hello, { name = '喷壶', password = null, token = null } = {}) {
  const c = fakeConn();
  const hello_msg = { rid: 1, name };
  if (password) hello_msg.accountPassword = password;
  if (token) hello_msg.accountToken = token;
  hello(c, hello_msg);
  const w = c.last();
  assert.equal(w.t, 'welcome', JSON.stringify(w));
  return { c, token: w.accountToken || token, accountId: w.accountId };
}

describe('账号面板：account.info / rename / logout / revokeOthers', () => {
  test('protocol：四条消息都在 C2S 里，字段范围正确', () => {
    assert.ok(C2S['account.info'] && C2S['account.logout'] && C2S['account.revokeOthers'] && C2S['account.rename']);
    assert.equal(validateC2S({ t: 'account.info' }), null);
    assert.equal(validateC2S({ t: 'account.rename', name: '新名字' }), null);
    assert.equal(validateC2S({ t: 'account.rename', name: '新名字', password: 'secret1' }), null);
    assert.notEqual(validateC2S({ t: 'account.rename' }), null, '改名必须给名字');
    assert.notEqual(validateC2S({ t: 'account.rename', name: '' }), null, '空名字不行');
    assert.notEqual(validateC2S({ t: 'account.rename', name: 'x'.repeat(13) }), null, '超过代号上限');
  });

  test('account.info：真实反映设备数 / 有没有密码 / 注册时间', (t) => {
    const { hello, send } = stack(t);
    const a = enter(hello);
    send(a.c, { t: 'account.info', rid: 2 });
    const r = a.c.last();
    assert.equal(r.t, 'ok', JSON.stringify(r));
    assert.equal(r.account.name, '喷壶');
    assert.equal(r.account.hasPassword, false);
    assert.equal(r.account.devices, 1);
    assert.ok(Number.isFinite(r.account.createdAt) && r.account.createdAt > 0, '注册时间');
    assert.equal(r.account.id, a.accountId, '面板里的 id 就是服务端裁定的那个');
  });

  test('account.rename：没密码时直接改；名字被占 / 超长被拒；accountId 不变', (t) => {
    const { hello, send } = stack(t);
    const a = enter(hello);
    // 占掉一个名字
    const other = enter(hello, { name: '别人' });

    send(a.c, { t: 'account.rename', name: '新代号', rid: 2 });
    assert.equal(a.c.last().t, 'ok', JSON.stringify(a.c.last()));
    assert.equal(a.c.last().account.name, '新代号');

    send(a.c, { t: 'account.rename', name: '别人', rid: 3 });
    assert.equal(a.c.last().t, 'error');
    assert.equal(a.c.last().code, ERR.NAME_TAKEN, '撞名字被拒');

    send(a.c, { t: 'account.rename', name: 'x'.repeat(13), rid: 4 });
    assert.equal(a.c.last().t, 'error');
    // 超长在协议层就被挡下（isStr 的 max），到不了 accounts.nameProblem 的 BAD_NAME
    assert.equal(a.c.last().code, ERR.BAD_MSG);

    // accountId 不变：老连接回来还是同一个账号，成绩不会分裂
    const back = enter(hello, { name: '随便', token: a.token });
    assert.equal(back.accountId, a.accountId);
    assert.equal(other.accountId !== a.accountId, true);
  });

  test('account.rename：有密码时必须带当前密码', (t) => {
    const { hello, send } = stack(t);
    const a = enter(hello);
    send(a.c, { t: 'account.setPassword', password: 'pass1234', rid: 2 });
    assert.equal(a.c.last().t, 'ok');

    send(a.c, { t: 'account.rename', name: '偷改的名字', rid: 3 });
    assert.equal(a.c.last().t, 'error');
    assert.equal(a.c.last().code, ERR.BAD_CREDENTIALS, '有密码就得验');

    send(a.c, { t: 'account.rename', name: '偷改的名字', password: 'wrong-pass', rid: 4 });
    assert.equal(a.c.last().code, ERR.BAD_CREDENTIALS, '密码错也不行');

    send(a.c, { t: 'account.rename', name: '自己改的', password: 'pass1234', rid: 5 });
    assert.equal(a.c.last().t, 'ok', JSON.stringify(a.c.last()));
    assert.equal(a.c.last().account.name, '自己改的');
  });

  test('account.logout：只撤当前凭证，别的设备照旧能用', (t) => {
    const { hello, send } = stack(t);
    const first = enter(hello);
    send(first.c, { t: 'account.setPassword', password: 'pass1234', rid: 2 });
    // 第二台设备用「代号 + 密码」登录，拿到自己的凭证
    const second = enter(hello, { name: '喷壶', password: 'pass1234' });
    assert.equal(second.accountId, first.accountId);
    assert.notEqual(second.token, first.token, '两台设备各有一张凭证');

    send(first.c, { t: 'account.logout', rid: 3 });
    const r = first.c.last();
    assert.equal(r.t, 'ok', JSON.stringify(r));
    assert.equal(r.account.devices, 1, '只剩另一台那一张');

    // 第一台那张已经作废：拿它回来会被名字占用挡住
    const dead = fakeConn();
    hello(dead, { rid: 9, name: '喷壶', accountToken: first.token });
    assert.equal(dead.last().t, 'error', '撤销后的凭证进不来');
    assert.equal(dead.last().code, ERR.NAME_TAKEN);

    // 第二台那张还好用
    const alive = enter(hello, { name: '随便', token: second.token });
    assert.equal(alive.accountId, first.accountId);
  });

  test('account.revokeOthers：保留当前这张，其余全撤', (t) => {
    const { hello, send } = stack(t);
    const first = enter(hello);
    send(first.c, { t: 'account.setPassword', password: 'pass1234', rid: 2 });
    const second = enter(hello, { name: '喷壶', password: 'pass1234' });
    const third = enter(hello, { name: '喷壶', password: 'pass1234' });

    send(first.c, { t: 'account.revokeOthers', rid: 3 });
    const r = first.c.last();
    assert.equal(r.t, 'ok', JSON.stringify(r));
    assert.equal(r.account.devices, 1, '连自己一共只剩一张');

    const alive = enter(hello, { name: '随便', token: first.token });
    assert.equal(alive.accountId, first.accountId, '当前这台没被误伤');
    for (const gone of [second, third]) {
      const dead = fakeConn();
      hello(dead, { rid: 9, name: '喷壶', accountToken: gone.token });
      assert.equal(dead.last().code, ERR.NAME_TAKEN, '其他设备被踢');
    }
  });

  test('没账号的会话：四条全拒（BAD_MSG），不写入任何东西', (t) => {
    const { send, accounts } = stack(t, { withAccounts: true });
    // 直接伪造一个没有 session 的连接
    const c = fakeConn();
    for (const [id, msg] of [[1, { t: 'account.info' }], [2, { t: 'account.rename', name: '名字' }],
      [3, { t: 'account.logout' }], [4, { t: 'account.revokeOthers' }]]) {
      send(c, { ...msg, rid: id });
      assert.equal(c.last().t, 'error', msg.t);
      assert.equal(c.last().code, ERR.BAD_MSG, `${msg.t} 需要会话`);
    }
    assert.equal(accounts.size, 0, '一条都没落库');

    const off = stack(t, { withAccounts: false });
    const sess = enter(off.hello);
    for (const [id, msg] of [[5, { t: 'account.info' }], [6, { t: 'account.logout' }]]) {
      off.send(sess.c, { ...msg, rid: id });
      assert.equal(sess.c.last().code, ERR.BAD_MSG, `${msg.t} 在没开账号库时也要拒绝`);
    }
  });
});
