// test/account-reset.test.js — 密码重置（服主批准制）：accounts.js 的单元行为 + 两条 HTTP 接口。
//
// 流程：忘记密码的玩家在标题画面申请 → 服务端发一个 8 位重置码（库里只存 sha256）→ 玩家把码报给服主
// → 服主在服务器上 approve（回环 + SP_ADMIN_TOKEN）→ 玩家用「码 + 新密码」换一张新设备凭证。
//
// 钉的不变量：
//   · 申请**不验证身份**，但没批准的码一步也走不动（RESET_PENDING）；
//   · 码只存哈希，重放同一个码不行（RESET_BAD_CODE）；
//   · 完成重置会**撤销全部旧设备凭证** —— 重置的典型场景就是「号可能被别人上了」；
//   · 过期失效；重新申请会覆盖旧码；
//   · /admin/* 没配 token 或不是回环时一律 404（不承认自己存在）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccounts, RESET_TTL_MS } from '../server/accounts.js';
import { startServer } from '../server/index.js';
import { isAdminRequest } from '../server/http/routes.js';
import { ERR } from '../shared/constants.js';

let seq = 0;
const tmpFile = () => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), `sp-acct-reset-${process.pid}-${seq++}-`)),
  'accounts.json',
);
const quiet = { info() {}, warn() {}, error() {} };

describe('密码重置（accounts.js）', () => {
  test('申请 → 未批准不能完成 → 批准后设新密码，旧凭证全撤', () => {
    const a = openAccounts({ file: tmpFile(), log: quiet });
    const reg = a.register('喷壶', 'oldpass1');
    const oldToken = reg.token;

    const { code, expiresAt } = a.requestReset('喷壶');
    assert.match(code, /^[A-Z2-9]{8}$/, '8 位人读码（不含 0/O/1/I）');
    assert.ok(expiresAt > Date.now() + RESET_TTL_MS - 5000, '默认 7 天');

    // 库里只有哈希
    const raw = fs.readFileSync(a.file, 'utf8');
    assert.equal(raw.includes(code), false, '重置码不能以明文落盘');

    assert.throws(() => a.completeReset({ name: '喷壶', code, password: 'newpass1' }), (e) => e.code === ERR.RESET_PENDING);
    assert.throws(() => a.completeReset({ name: '喷壶', code: 'WRONGCOD', password: 'newpass1' }), (e) => e.code === ERR.RESET_PENDING,
      '批准前连码对不对都不告诉');

    assert.deepEqual(a.approveReset({ code }), { name: '喷壶' });
    const done = a.completeReset({ name: '喷壶', code, password: 'newpass1' });
    assert.match(done.token, /^[0-9a-f]{32}$/);

    // 旧凭证全撤：那张老 token 再也换不回账号
    assert.equal(a.byCredential(oldToken), null, '重置后旧设备凭证作废');
    assert.equal(a.byCredential(done.token)?.id, done.account.id, '新凭证可用');

    // 密码换掉了：旧的进不来，新的进得来
    assert.throws(() => a.authenticate({ name: '喷壶', password: 'oldpass1' }), (e) => e.code === ERR.BAD_CREDENTIALS);
    assert.equal(a.authenticate({ name: '喷壶', password: 'newpass1' }).account.id, reg.account.id);

    // 码是一次性的
    assert.throws(() => a.completeReset({ name: '喷壶', code, password: 'another1' }), (e) => e.code === ERR.RESET_BAD_CODE);
  });

  test('重新申请会覆盖旧码；按代号批准也行；未知代号 NO_ACCOUNT', () => {
    const a = openAccounts({ file: tmpFile(), log: quiet });
    a.register('喷壶', 'oldpass1');

    const first = a.requestReset('喷壶');
    const second = a.requestReset('喷壶');
    assert.notEqual(first.code, second.code);
    assert.throws(() => a.approveReset({ code: first.code }), (e) => e.code === ERR.RESET_BAD_CODE, '旧码已被覆盖');

    assert.deepEqual(a.approveReset({ name: '喷壶' }), { name: '喷壶' }, '服主只知道代号时按名批准');
    assert.equal(a.completeReset({ name: '喷壶', code: second.code, password: 'newpass1' }).account.name, '喷壶');

    assert.throws(() => a.requestReset('查无此人'), (e) => e.code === ERR.NO_ACCOUNT);
  });

  test('过期：批准与完成都拒绝，且要用新申请', () => {
    const a = openAccounts({ file: tmpFile(), log: quiet });
    const reg = a.register('喷壶', 'oldpass1');
    const { code } = a.requestReset('喷壶');
    // 白盒：把有效期拨到过去（没有可注入的时钟，直接改记录）
    a.byId.get(reg.account.id).reset.expiresAt = Date.now() - 1000;

    assert.throws(() => a.approveReset({ code }), (e) => e.code === ERR.RESET_EXPIRED);
    assert.throws(() => a.completeReset({ name: '喷壶', code, password: 'newpass1' }), (e) => e.code === ERR.RESET_EXPIRED);
    assert.deepEqual(a.pendingResets().map((r) => r.expired), [true]);
  });

  test('短密码在完成这一步被拒（BAD_PASSWORD），码不被消耗', () => {
    const a = openAccounts({ file: tmpFile(), log: quiet });
    a.register('喷壶', 'oldpass1');
    const { code } = a.requestReset('喷壶');
    a.approveReset({ code });

    assert.throws(() => a.completeReset({ name: '喷壶', code, password: '12345' }), (e) => e.code === ERR.BAD_PASSWORD);
    // 码还在：补一个合法密码就能完成
    assert.equal(a.completeReset({ name: '喷壶', code, password: 'goodpass1' }).account.name, '喷壶');
  });

  test('info：面板看到的字段（设备数 / 有没有密码 / 有无待批申请）', () => {
    const a = openAccounts({ file: tmpFile(), log: quiet });
    const reg = a.register('喷壶', 'oldpass1');
    const before = a.info(reg.account.id);
    assert.equal(before.hasPassword, true);
    assert.equal(before.devices, 1);
    assert.equal(before.resetPending, false);

    a.requestReset('喷壶');
    assert.equal(a.info(reg.account.id).resetPending, true);
    assert.equal(a.info(reg.account.id).resetApproved, false);
    a.approveReset({ name: '喷壶' });
    assert.equal(a.info(reg.account.id).resetApproved, true);
  });
});

describe('密码重置（HTTP /account/* 与 /admin/*）', () => {
  test('申请 → 未批准 403 → 服主批准 → 完成拿到新凭证 → 重放 403', async (t) => {
    const accountsFile = tmpFile();
    const store = openAccounts({ file: accountsFile, log: quiet });
    store.register('喷壶', 'oldpass1');

    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accountsFile, leaderboardFile: null, assetIndex: false });
    t.after(() => srv.close());
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    // 1) 申请
    let res = await post('/account/reset-request', { name: '喷壶' });
    assert.equal(res.status, 200);
    const { code } = await res.json();
    assert.match(code, /^[A-Z2-9]{8}$/);

    // 2) 没批准就完成 → 403 RESET_PENDING
    res = await post('/account/reset-complete', { name: '喷壶', code, password: 'newpass1' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'RESET_PENDING');

    // 3) 服主接口：没 token → 404（连存在都不承认）
    const prevToken = process.env.SP_ADMIN_TOKEN;
    delete process.env.SP_ADMIN_TOKEN;
    try {
      res = await fetch(`${base}/admin/resets`);
      assert.equal(res.status, 404, '没配 SP_ADMIN_TOKEN 时不存在');
      process.env.SP_ADMIN_TOKEN = 'unit-test-admin-token';
      res = await fetch(`${base}/admin/resets`);
      assert.equal(res.status, 404, '不带 token 也是 404');
      res = await fetch(`${base}/admin/resets`, { headers: { 'x-admin-token': 'wrong-token' } });
      assert.equal(res.status, 404, 'token 不对还是 404');

      // 4) 列队 + 批准
      res = await fetch(`${base}/admin/resets`, { headers: { 'x-admin-token': 'unit-test-admin-token' } });
      assert.equal(res.status, 200);
      const listed = await res.json();
      assert.equal(listed.resets.length, 1);
      assert.equal(listed.resets[0].name, '喷壶');
      assert.equal(listed.resets[0].approved, false);
      assert.equal(JSON.stringify(listed).includes(code), false, '列表里不出现码本身');

      res = await post('/admin/resets/approve', { code }, { 'x-admin-token': 'unit-test-admin-token' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { approved: true, name: '喷壶' });

      // 5) 批准后完成 → 新凭证
      res = await post('/account/reset-complete', { name: '喷壶', code, password: 'newpass1' });
      assert.equal(res.status, 200);
      const done = await res.json();
      assert.equal(done.name, '喷壶');
      assert.match(done.token, /^[0-9a-f]{32}$/);

      // 6) 同一个码重放 → 403
      res = await post('/account/reset-complete', { name: '喷壶', code, password: 'another1' });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'RESET_BAD_CODE');
    } finally {
      if (prevToken === undefined) delete process.env.SP_ADMIN_TOKEN;
      else process.env.SP_ADMIN_TOKEN = prevToken;
    }
  });

  test('坏的请求体 / 未知代号 / GET 方法', async (t) => {
    const accountsFile = tmpFile();
    openAccounts({ file: accountsFile, log: quiet }).register('喷壶', 'oldpass1');
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accountsFile, leaderboardFile: null, assetIndex: false });
    t.after(() => srv.close());
    const base = `http://127.0.0.1:${srv.port}`;

    let res = await fetch(`${base}/account/reset-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/account/reset-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '查无此人' }) });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'NO_ACCOUNT');

    res = await fetch(`${base}/account/reset-request`);
    assert.equal(res.status, 405, 'GET 不行');

    res = await fetch(`${base}/account/nope`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

describe('服主接口的来源闸（isAdminRequest）', () => {
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });

  test('公网来源伪造 X-Forwarded-For 不算本机', () => {
    const prev = process.env.SP_ADMIN_TOKEN;
    process.env.SP_ADMIN_TOKEN = 'token-abcdef';
    try {
      // frpc 转进来的流量：来源是私网容器地址，头里写什么都不能信
      assert.equal(isAdminRequest(req('172.18.0.7', { 'x-forwarded-for': '127.0.0.1', 'x-admin-token': 'token-abcdef' })), false);
      assert.equal(isAdminRequest(req('203.0.113.9', { 'x-admin-token': 'token-abcdef' })), false);
      // 真回环 + 对 token 才放行（含 IPv4-mapped 写法）
      assert.equal(isAdminRequest(req('127.0.0.1', { 'x-admin-token': 'token-abcdef' })), true);
      assert.equal(isAdminRequest(req('::ffff:127.0.0.1', { 'x-admin-token': 'token-abcdef' })), true);
      // token 不对 / 没带
      assert.equal(isAdminRequest(req('127.0.0.1', { 'x-admin-token': 'wrong' })), false);
      assert.equal(isAdminRequest(req('127.0.0.1', {})), false);
      // 没配 token ⇒ 这条路不存在
      delete process.env.SP_ADMIN_TOKEN;
      assert.equal(isAdminRequest(req('127.0.0.1', { 'x-admin-token': 'token-abcdef' })), false);
    } finally {
      if (prev === undefined) delete process.env.SP_ADMIN_TOKEN;
      else process.env.SP_ADMIN_TOKEN = prev;
    }
  });
});
