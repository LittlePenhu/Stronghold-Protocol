// test/account-set-password.test.js — account.setPassword：给**当前会话**的账号设置 / 更换密码
// （server/net.js onSetPasswordMsg → server/accounts.js setPassword）。
//
// 钉的不变量（不是「功能跑通」）：
//   · 身份只看 session.accountId（服务端裁定）—— 消息里不接受名字 / id，不存在「改别人的密码」；
//   · 设 / 改密码**不动任何设备凭证**：老设备不该因为补了密码就被踢下线；
//   · 短密码（< 6 位）被拒（BAD_PASSWORD），且**拒了就不落库**；
//   · 没账号的会话（未开账号系统 / 无账号）改不了任何密码；
//   · welcome.accountHasPassword 如实反映账号状态（false → true），前端据此显示「设置/修改密码」。
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
  fs.mkdtempSync(path.join(os.tmpdir(), `sp-acct-pw-${process.pid}-${seq++}-`)),
  'accounts.json',
);
const quiet = { info() {}, warn() {}, error() {} };

/** 假连接：onFrame 需要 bucket / heavy，回复进 frames。 */
function fakeConn() {
  const frames = [];
  return {
    frames,
    conn: {
      session: null, ip: '203.0.113.7', key: null, closing: false, alive: true, drops: 0, dropWindowAt: 0,
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

describe('account.setPassword：给当前账号设置 / 更换密码', () => {
  test('protocol：只收 128 字符以内的字符串密码', () => {
    assert.ok(C2S['account.setPassword'], 'C2S 认识 account.setPassword');
    assert.equal(validateC2S({ t: 'account.setPassword', password: 'abcdef' }), null);
    assert.equal(validateC2S({ t: 'account.setPassword', password: '' }), null, '空串由服务端按坏密码拒');
    assert.notEqual(validateC2S({ t: 'account.setPassword' }), null);
    assert.notEqual(validateC2S({ t: 'account.setPassword', password: 123456 }), null);
    assert.notEqual(validateC2S({ t: 'account.setPassword', password: 'x'.repeat(129) }), null);
  });

  test('注册时没设密码 → 设上之后「代号 + 密码」能登录并换发凭证', (t) => {
    const { hello, send } = stack(t);
    const first = fakeConn();
    hello(first, { rid: 1, name: '喷壶' });
    const w0 = first.last();
    assert.equal(w0.accountHasPassword, false, 'welcome 如实说「没设密码」');

    send(first, { t: 'account.setPassword', password: 'newpass1', rid: 2 });
    assert.equal(first.last().t, 'ok', JSON.stringify(first.last()));

    // 换一条连接、不带凭证、只带「代号 + 密码」—— 这正是换设备时的那条路
    const second = fakeConn();
    hello(second, { rid: 3, name: '喷壶', accountPassword: 'newpass1' });
    const w = second.last();
    assert.equal(w.t, 'welcome', JSON.stringify(w));
    assert.equal(w.accountId, w0.accountId, '还是同一个账号');
    assert.match(w.accountToken, /^[0-9a-f]{32}$/, '换发了新的设备凭证');
    assert.equal(w.accountHasPassword, true, 'welcome 现在说「有密码」');
  });

  test('短密码被拒（BAD_PASSWORD）且不落库 —— 拒了就当没发生过', (t) => {
    const { hello, send } = stack(t);
    const c = fakeConn();
    hello(c, { rid: 1, name: '喷壶' });

    send(c, { t: 'account.setPassword', password: '12345', rid: 2 });
    const r = c.last();
    assert.equal(r.t, 'error');
    assert.equal(r.code, ERR.BAD_PASSWORD, JSON.stringify(r));

    // 账号仍然没有密码：用「代号 + 空密码想蒙混」的路依旧是 NO_PASSWORD，而不是 BAD_CREDENTIALS
    const second = fakeConn();
    hello(second, { rid: 3, name: '喷壶', accountPassword: '12345' });
    assert.equal(second.last().code, ERR.NO_PASSWORD, '密码没有被短的那个覆盖');
  });

  test('设 / 改密码不动设备凭证：已有凭证照样回到同一个账号', (t) => {
    const { hello, send } = stack(t);
    const first = fakeConn();
    hello(first, { rid: 1, name: '喷壶' });
    const token = first.last().accountToken;
    const id = first.last().accountId;

    send(first, { t: 'account.setPassword', password: 'first-pass', rid: 2 });
    assert.equal(first.last().t, 'ok');
    // 已经有密码之后，改密码**必须带旧密码** —— 否则拿到设备凭证的人能把主人锁在门外
    send(first, { t: 'account.setPassword', password: 'hijack-pass', rid: 21 });
    assert.equal(first.last().t, 'error');
    assert.equal(first.last().code, ERR.BAD_CREDENTIALS, '不带旧密码的改动被拒绝');
    send(first, { t: 'account.setPassword', password: 'second-pass', oldPassword: 'first-pass', rid: 22 });
    assert.equal(first.last().t, 'ok', '带旧密码就走同一条消息');

    // 旧凭证没有被撤销
    const resumed = fakeConn();
    hello(resumed, { rid: 4, name: '随便填的名字都不算数', accountToken: token });
    assert.equal(resumed.last().accountId, id, '凭证优先，名字随便填');

    // 旧密码失效、新密码生效
    const bad = fakeConn();
    hello(bad, { rid: 5, name: '喷壶', accountPassword: 'first-pass' });
    assert.equal(bad.last().code, ERR.BAD_CREDENTIALS);
    const good = fakeConn();
    hello(good, { rid: 6, name: '喷壶', accountPassword: 'second-pass' });
    assert.equal(good.last().t, 'welcome');
    assert.equal(good.last().accountId, id);
  });

  test('没账号的会话改不了密码：未开账号系统 ⇒ BAD_MSG', (t) => {
    const { hello, send } = stack(t, { withAccounts: false });
    const c = fakeConn();
    hello(c, { rid: 1, name: '喷壶' });
    assert.equal(c.last().t, 'welcome');
    assert.equal(c.last().accountId, undefined, '没开账号系统就没有账号');
    send(c, { t: 'account.setPassword', password: 'whatever1', rid: 2 });
    const r = c.last();
    assert.equal(r.t, 'error');
    assert.equal(r.code, ERR.BAD_MSG, JSON.stringify(r));
  });

  test('没 hello 的连接连消息都进不来（不存在匿名改密码）', (t) => {
    const { send } = stack(t);
    const c = fakeConn();
    send(c, { t: 'account.setPassword', password: 'whatever1', rid: 1 });
    const r = c.last();
    assert.equal(r.t, 'error');
    assert.equal(r.code, ERR.BAD_MSG);
    assert.match(String(r.detail || ''), /hello required/);
  });
});
