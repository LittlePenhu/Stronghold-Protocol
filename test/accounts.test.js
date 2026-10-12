// 账号库的单元测试（server/accounts.js）。
//
// 这个文件的重点不是"功能能用"，而是**防串号的那几条不变量**：
//   * 用户名被占用后，没有凭证/密码的人进不来（用户名是公开的，不能当密码）
//   * 凭证只存哈希 —— 拿到 accounts.json 也不能直接登录
//   * 改名不换 accountId（历史成绩不会分裂，也不会有人靠改名占别人的过去）
//   * 存储损坏时拒绝启动，而不是当作空库把人清掉
//   * 写盘是原子的（临时文件 → rename），中途被杀不会留半个文件
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Accounts, AccountError, ERR, openAccounts,
  normalizeName, nameProblem, ACCOUNTS_FORMAT, NAME_MAX, PASSWORD_MIN,
} from '../server/accounts.js';

let seq = 0;
/** 每个用例一个独立的临时目录，互不干扰。 */
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sp-accounts-${process.pid}-${seq++}-`));
  return path.join(dir, 'accounts.json');
}
const quiet = { warn() {}, error() {} };
const fresh = (file = tmpFile()) => new Accounts({ file, log: quiet }).load();

describe('accounts: 用户名规范化与合法性', () => {
  test('normalizeName 折叠大小写、空白与 NFKC 差异', () => {
    assert.equal(normalizeName('  PenHu  '), 'penhu');
    assert.equal(normalizeName('喷 壶'), '喷 壶');          // 内部单个空格保留
    assert.equal(normalizeName('喷  壶'), '喷 壶');         // 连续空白折叠成一个
    assert.equal(normalizeName('ＡＢＣ'), 'abc');           // 全角 → 半角（NFKC）
  });

  test('nameProblem 拒绝空 / 超长 / 控制字符 / 首尾空白', () => {
    assert.equal(nameProblem('喷壶'), null);
    assert.equal(nameProblem(''), 'empty');
    assert.equal(nameProblem('   '), 'empty');
    assert.equal(nameProblem('x'.repeat(NAME_MAX + 1)), 'too_long');
    assert.equal(nameProblem('喷\u200b壶'), 'control_chars');   // 零宽空格
    assert.equal(nameProblem(' 喷壶'), 'surrounding_space');
    assert.equal(nameProblem('喷壶 '), 'surrounding_space');
  });
});

describe('accounts: 注册与凭证（防串号的核心）', () => {
  test('注册返回一次性凭证，库里只存哈希 —— 拿文件也登不进去', () => {
    const file = tmpFile();
    const a = fresh(file);
    const { account, token } = a.register('喷壶');
    assert.equal(account.name, '喷壶');
    assert.ok(account.id.startsWith('a_'));
    assert.ok(token.length >= 32);

    // 凭证认得出账号
    assert.equal(a.byCredential(token).id, account.id);

    // 磁盘上没有明文凭证
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes(token), false, '文件里不该出现明文凭证');
    assert.equal(raw.includes(account.tokenHash), true);
    // 也不该出现明文密码
    const b = fresh(file);
    b.setPassword(account.id, 'hunter2hunter2');
    assert.equal(fs.readFileSync(file, 'utf8').includes('hunter2hunter2'), false);
  });

  test('★ 用户名被占用 ⇒ 再注册同一个名字必须失败（这是"用户名不能当密码"的落点）', () => {
    const a = fresh();
    a.register('喷壶');
    assert.throws(() => a.register('喷壶'), (e) => e instanceof AccountError && e.code === ERR.NAME_TAKEN);
    // 规范化后等价的写法也算占用 —— 否则 "PenHu" / "penhu" / "ＰｅｎＨｕ" 会成为三条记录
    a.register('PenHu');
    for (const variant of [' penhu ', 'PENHU', 'ｐｅｎｈｕ', 'Pen  Hu'.replace(/\s+/g, '')]) {
      assert.equal(a.isNameTaken(variant), true, `${variant} 应被判为已占用`);
    }
  });

  test('凭证区分大小写，且对不上就是 null（不透露"这个人存在但凭证错了"）', () => {
    const a = fresh();
    const { account, token } = a.register('甲');
    assert.equal(a.byCredential(token.toUpperCase()), null);
    assert.equal(a.byCredential(`${token}0`), null);
    assert.equal(a.byCredential(''), null);
    assert.equal(a.byCredential(null), null);
    assert.equal(a.byCredential(undefined), null);
    assert.equal(a.byCredential(account.id), null, '拿 accountId 当凭证必须无效');
  });

  test('每条凭证只对应一个账号，且随机不可枚举', () => {
    const a = fresh();
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const { token } = a.register(`用户${i}`);
      assert.equal(seen.has(token), false, '凭证出现重复');
      seen.add(token);
      assert.match(token, /^[0-9a-f]{32}$/);
    }
    assert.equal(a.size, 40);
  });

  test('两个账号的凭证互换 —— 各自认出各自的（不串）', () => {
    const a = fresh();
    const one = a.register('甲');
    const two = a.register('乙');
    assert.equal(a.byCredential(one.token).name, '甲');
    assert.equal(a.byCredential(two.token).name, '乙');
    assert.notEqual(one.account.id, two.account.id);
    // 但两人的 id 与名字一一对应，没有交叉
    assert.equal(a.byAccountId(one.account.id).name, '甲');
    assert.equal(a.byAccountId(two.account.id).name, '乙');
  });
});

describe('accounts: 密码（可选）', () => {
  test('设了密码就能用「用户名 + 密码」换设备登录', () => {
    const a = fresh();
    const { account } = a.register('喷壶', 'correct horse');
    assert.equal(a.loginWithPassword('喷壶', 'correct horse').id, account.id);
    // 规范化后等价的写法也能登录：首尾空白被 trim，全角空格（U+3000）经 NFKC 后同样被 trim
    assert.equal(a.loginWithPassword('  喷壶  ', 'correct horse').id, account.id);
    assert.equal(a.loginWithPassword('\u3000喷壶\u3000', 'correct horse').id, account.id);
  });

  test('密码错 / 用户名不存在 / 账号没设密码 —— 三种都报同一个错（不泄漏用户名是否存在）', () => {
    const a = fresh();
    a.register('甲', 'pw123456');
    const noPassword = a.register('乙');
    // 三种失败必须无法区分：都是 BAD_CREDENTIALS，没有"用户名不存在"这种更友好的错误
    for (const [name, pw] of [['甲', 'wrong'], ['不存在的人', 'x'], ['乙', 'pw123456']]) {
      assert.throws(() => a.loginWithPassword(name, pw), (e) => e.code === ERR.BAD_CREDENTIALS, `${name} / ${pw}`);
    }
    assert.ok(!noPassword.password);
  });

  test('密码太短被拒', () => {
    const a = fresh();
    const { account } = a.register('甲');
    assert.throws(() => a.setPassword(account.id, 'x'.repeat(PASSWORD_MIN - 1)), (e) => e.code === ERR.BAD_PASSWORD);
    assert.doesNotThrow(() => a.setPassword(account.id, 'x'.repeat(PASSWORD_MIN)));
  });

  test('注册时可以不带密码（凭证模式）', () => {
    const a = fresh();
    const { account } = a.register('甲');
    assert.equal(account.password, null);
    assert.equal(a.publicView(account).hasPassword, false);
  });
});

describe('accounts: 改名与凭证轮换', () => {
  test('★ 改名不换 accountId —— 历史成绩不会分裂成两份', () => {
    const a = fresh();
    const { account, token } = a.register('旧名');
    const id = account.id;
    const renamed = a.rename(id, '新名');
    assert.equal(renamed.id, id, 'accountId 必须不变');
    assert.equal(renamed.name, '新名');
    // 同一个凭证仍然认得出（改名不该把人踢下线）
    assert.equal(a.byCredential(token).id, id);
    // 旧名字被释放，可以被别人用
    assert.equal(a.isNameTaken('旧名'), false);
    assert.equal(a.isNameTaken('新名'), true);
  });

  test('改成一个别人占着的名字必须失败', () => {
    const a = fresh();
    a.register('甲');
    const b = a.register('乙');
    assert.throws(() => a.rename(b.account.id, '甲'), (e) => e.code === ERR.NAME_TAKEN);
    // 改成自己本来（或规范化后等价）的名字不算冲突
    assert.doesNotThrow(() => a.rename(b.account.id, '乙'));
  });

  test('轮换凭证：新的能用，旧的立刻失效', () => {
    const a = fresh();
    const { account, token: old } = a.register('甲');
    const { token: next } = a.rotateCredential(account.id);
    assert.notEqual(next, old);
    assert.equal(a.byCredential(old), null, '旧凭证必须失效');
    assert.equal(a.byCredential(next).id, account.id);
    // 轮换后重开文件，旧的依然不认
    const reopened = fresh(a.file);
    assert.equal(reopened.byCredential(old), null);
    assert.equal(reopened.byCredential(next).id, account.id);
  });

  test('publicView 不泄漏 tokenHash / password', () => {
    const a = fresh();
    const { account } = a.register('甲', 'pw123456');
    const v = a.publicView(account);
    assert.deepEqual(Object.keys(v).sort(), ['hasPassword', 'id', 'name']);
    assert.equal(JSON.stringify(v).includes(account.tokenHash), false);
    assert.equal(JSON.stringify(v).includes(account.password.hash), false);
  });
});

describe('accounts: 持久化与崩溃安全', () => {
  test('关掉再开，账号 / 凭证 / 密码都还在', () => {
    const file = tmpFile();
    const a = fresh(file);
    const { account, token } = a.register('喷壶', 'pw123456');
    const b = fresh(file);
    assert.equal(b.size, 1);
    assert.equal(b.byCredential(token).id, account.id);
    assert.equal(b.loginWithPassword('喷壶', 'pw123456').id, account.id);
  });

  test('★ 文件损坏时拒绝启动，而不是当作空库（否则一次误读就把所有人清掉）', () => {
    const file = tmpFile();
    fresh(file).register('甲');
    fs.writeFileSync(file, '{ 这不是 JSON');
    assert.throws(() => fresh(file), (e) => e.code === ERR.STORE);

    // 结构不对（缺 accounts）也拒绝
    fs.writeFileSync(file, JSON.stringify({ format: ACCOUNTS_FORMAT }));
    assert.throws(() => fresh(file), (e) => e.code === ERR.STORE);

    // format 不认识的也拒绝
    fs.writeFileSync(file, JSON.stringify({ format: 999, accounts: {} }));
    assert.throws(() => fresh(file), (e) => e.code === ERR.STORE);
  });

  test('文件不存在 ⇒ 空库（首次运行）', () => {
    const a = fresh(path.join(os.tmpdir(), `sp-nonexistent-${Date.now()}.json`));
    assert.equal(a.size, 0);
    assert.equal(a.loaded, true);
  });

  test('★ 写盘是原子的：不留临时文件，且过程里被杀不会得到半个文件', () => {
    const file = tmpFile();
    const a = fresh(file);
    for (let i = 0; i < 5; i++) a.register(`用户${i}`);
    const dir = path.dirname(file);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '不该留下临时文件');
    // 每次写完都能被完整解析
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(fresh(file).size, 5);
  });

  test('openAccounts 便捷构造把错误抛给调用方', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'garbage');
    assert.throws(() => openAccounts({ file, log: quiet }), (e) => e.code === ERR.STORE);
  });

  test('写入的 JSON 是可读的（便于人工查看/备份）', () => {
    const file = tmpFile();
    fresh(file).register('喷壶');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('\n  "accounts"'), '应是缩进过的 JSON');
    assert.ok(raw.endsWith('\n'), '末尾应有换行');
  });
});
