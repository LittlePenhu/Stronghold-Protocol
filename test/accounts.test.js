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
  normalizeName, nameProblem, ACCOUNTS_FORMAT, NAME_MAX, PASSWORD_MIN, MAX_TOKENS,
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
    assert.equal(raw.includes(account.tokens[0].hash), true);
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

describe('accounts: 改名与凭证管理', () => {
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

  test('★ 追加凭证（换设备用密码登录）不该把旧设备踢下线', () => {
    const a = fresh();
    const { account, token: phone } = a.register('甲', 'pw123456');
    // 第二台设备用密码登录 → 服务端给它一条**新的**凭证
    const { token: desktop } = a.issueToken(account.id);
    assert.notEqual(desktop, phone);
    // 两条都有效，都指向同一个账号 —— 不是"抢座位"
    assert.equal(a.byCredential(phone).id, account.id);
    assert.equal(a.byCredential(desktop).id, account.id);
    // 重开文件后依然都在
    const reopened = fresh(a.file);
    assert.equal(reopened.byCredential(phone).id, account.id);
    assert.equal(reopened.byCredential(desktop).id, account.id);
  });

  test('凭证数量有上限，超出时淘汰最旧的（不会无限增长）', () => {
    const a = fresh();
    const { account } = a.register('甲');
    const issued = [];
    for (let i = 0; i < MAX_TOKENS + 3; i++) issued.push(a.issueToken(account.id).token);
    assert.equal(a.byAccountId(account.id).tokens.length, MAX_TOKENS);
    // 最早签发的那几条已被淘汰
    assert.equal(a.byCredential(issued[0]), null);
    assert.equal(a.byCredential(issued[1]), null);
    // 最新的几条仍然有效
    assert.equal(a.byCredential(issued.at(-1)).id, account.id);
    // 淘汰掉的哈希不能留在索引里（否则 revokeToken 会去操作一个不存在的凭证）
    assert.equal(a.byToken.size, MAX_TOKENS);
  });

  test('撤销凭证：这一条失效，账号的其他设备不受影响', () => {
    const a = fresh();
    const { account, token: one } = a.register('甲');
    const { token: two } = a.issueToken(account.id);
    assert.equal(a.revokeToken(one), true);
    assert.equal(a.byCredential(one), null, '被撤销的必须失效');
    assert.equal(a.byCredential(two).id, account.id, '其他设备不受影响');
    // 撤销不存在的凭证返回 false（幂等，不抛）
    assert.equal(a.revokeToken('0'.repeat(32)), false);
    assert.equal(a.revokeToken(null), false);
    // 全部撤销后账号还在，只是没有可用凭证了
    a.revokeAllTokens(account.id);
    assert.equal(a.byAccountId(account.id).tokens.length, 0);
    assert.equal(a.size, 1, '账号本身不该被删掉');
  });

  test('publicView 不泄漏凭证哈希 / 密码', () => {
    const a = fresh();
    const { account } = a.register('甲', 'pw123456');
    const v = a.publicView(account);
    assert.deepEqual(Object.keys(v).sort(), ['devices', 'hasPassword', 'id', 'name']);
    assert.equal(JSON.stringify(v).includes(account.tokens[0].hash), false);
    assert.equal(JSON.stringify(v).includes(account.password.hash), false);
  });
});

describe('accounts: authenticate —— 统一认证入口（防串号的最后一道门）', () => {
  test('凭证对得上就认它，名字填什么都无所谓（玩家不能靠改输入框"成为"别人）', () => {
    const a = fresh();
    const { account, token } = a.register('喷壶');
    for (const name of ['喷壶', 'penhu', '管理员', '']) {
      const r = a.authenticate({ name, token });
      assert.equal(r.account.id, account.id, `name=${name} 时不该换人`);
      assert.equal(r.created, false);
      assert.equal(r.token, null, '已有凭证时不该再签发');
    }
  });

  test('名字空闲 ⇒ 注册新账号并签发凭证', () => {
    const a = fresh();
    const r = a.authenticate({ name: '新来的' });
    assert.equal(r.created, true);
    assert.equal(r.account.name, '新来的');
    assert.ok(typeof r.token === 'string' && r.token.length === 32);
    assert.equal(a.byCredential(r.token).id, r.account.id);
  });

  test('★ 名字被占用 + 没有凭证 + 没有密码 ⇒ 拒绝（这正是"用户名不能当密码"）', () => {
    const a = fresh();
    a.register('PenHu');
    assert.throws(
      () => a.authenticate({ name: 'PenHu' }),
      (e) => e instanceof AccountError && e.code === ERR.NAME_TAKEN,
    );
    // 大小写 / 全角 / 首尾空白变体一样被挡住（用拉丁名测 —— 中文名没有大小写变体）
    for (const variant of ['PENHU', 'ｐｅｎｈｕ', ' PenHu ', 'penhu']) {
      assert.throws(() => a.authenticate({ name: variant }), (e) => e.code === ERR.NAME_TAKEN, variant);
    }
    // 用别人账号的 accountId 当凭证也没用
    const victim = a.byName_('PenHu');
    assert.throws(() => a.authenticate({ name: 'PenHu', token: victim.id }), (e) => e.code === ERR.NAME_TAKEN);
  });

  test('名字被占用 + 密码正确 ⇒ 放行并追加一条新凭证（换设备）', () => {
    const a = fresh();
    const first = a.authenticate({ name: '喷壶', password: 'pw123456' });
    assert.equal(first.created, true);
    const second = a.authenticate({ name: '喷壶', password: 'pw123456' });
    assert.equal(second.account.id, first.account.id, '必须是同一个账号');
    assert.equal(second.created, false);
    assert.ok(second.token, '换设备登录应拿到新凭证');
    assert.equal(a.byCredential(first.token).id, first.account.id, '旧设备仍有效');
    assert.equal(a.byCredential(second.token).id, first.account.id);
  });

test('★ NO_PASSWORD 不扩大既有的信息暴露面', () => {
    // 这条测试原先断言「密码错」与「没设密码」返回同一个码。那在 2026-10-13 被推翻了：
    // 没设密码的用户会卡在死循环里（前端一遍遍显示「密码不正确」，而正确的密码不存在）。
    // 现在没设密码返回 NO_PASSWORD。下面钉住「为什么这没有让门槛变低」——
    // 注意**账号存在性本来就能被区分**，这是「打开就玩」这个设计固有的：
    // 一个没人用的名字 + 合法长度的密码 = 注册成功（进得去）；
    // 一个已被占用的名字 + 密码 = 拒绝。所以 NO_PASSWORD 不是新增的泄漏面，
    // 它只是把「存在、且没设密码」这一种**原本就会被拒绝**的情况说得更准确。
    const a = fresh();
    a.register('甲', 'pw123456');
    a.register('乙');   // 存在、没设密码

    // 1) 设了密码 + 错密码 → BAD_CREDENTIALS
    assert.throws(() => a.authenticate({ name: '甲', password: 'wrong1' }), (e) => e.code === ERR.BAD_CREDENTIALS);

    // 2) 没设密码 + 任意密码 → NO_PASSWORD（修复本身）
    assert.throws(() => a.authenticate({ name: '乙', password: 'whatever1' }), (e) => e.code === ERR.NO_PASSWORD);

    // 3) 三条路径都不给出**任何凭证**
    assert.equal(a.byCredential('whatever1'), null);
    assert.equal(a.list().length, 2, '甲乙都没被动过');

    // 4) ★ 真正的防线：不管错误码是什么，光知道名字都进不去别人的账号。
    //    （唯一能进自己账号的路径是持有服务端签发的凭证，或知道自己的密码。）
    assert.equal(a.list().find((x) => x.name === '乙').tokens.length, 1, '乙的凭证没被多发');
  });

  test('★ 两条不同凭证同时在线，互不串号', () => {
    const a = fresh();
    const one = a.authenticate({ name: '甲' });
    const two = a.authenticate({ name: '乙' });
    assert.notEqual(one.account.id, two.account.id);
    // 各自拿各自的凭证，反复认证都不会换人
    for (let i = 0; i < 5; i++) {
      assert.equal(a.authenticate({ name: '随便', token: one.token }).account.id, one.account.id);
      assert.equal(a.authenticate({ name: '随便', token: two.token }).account.id, two.account.id);
    }
    // 交叉：甲的凭证 + 乙的名字 ⇒ 还是甲（凭证优先）
    assert.equal(a.authenticate({ name: '乙', token: one.token }).account.id, one.account.id);
  });

  test('凭证无效时不会被静默降级成"新注册"（否则一次凭证出错就多出一个重名账号）', () => {
    const a = fresh();
    const { account } = a.register('喷壶');
    // 一个长得像但不对的凭证
    assert.throws(() => a.authenticate({ name: '喷壶', token: 'f'.repeat(32) }), (e) => e.code === ERR.NAME_TAKEN);
    assert.equal(a.size, 1, '不该多出账号');
    assert.equal(a.byAccountId(account.id).tokens.length, 1, '不该多出凭证');
  });

  test('非法用户名在注册路径上被拒（authenticate 也走同一套校验）', () => {
    const a = fresh();
    assert.throws(() => a.authenticate({ name: '   ' }), (e) => e.code === ERR.BAD_NAME);
    assert.throws(() => a.authenticate({ name: 'x'.repeat(NAME_MAX + 1) }), (e) => e.code === ERR.BAD_NAME);
    assert.equal(a.size, 0);
  });

  test('老格式（单个 tokenHash）的文件仍能读进来', () => {
    const file = tmpFile();
    // 手写一份"上一版"的文件：凭证哈希存在 tokenHash 里
    const hash = 'ab'.repeat(32);
    fs.writeFileSync(file, JSON.stringify({
      format: ACCOUNTS_FORMAT,
      accounts: {
        a_legacy: { id: 'a_legacy', name: '老人', nameLower: '老人', tokenHash: hash, password: null, createdAt: 1, updatedAt: 1 },
      },
    }, null, 2));
    const a = fresh(file);
    assert.equal(a.size, 1);
    assert.equal(a.byAccountId('a_legacy').tokens.length, 1, '单个 tokenHash 应被升级成 tokens 数组');
    assert.equal(a.byAccountId('a_legacy').tokenHash, undefined, '旧字段应被清掉');
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

describe('accounts: 没设密码的账号不会卡死在「密码不正确」', () => {
  // 这组用例钉的是一个真发生过的死循环（2026-10-13）：账号没设密码、浏览器凭证又丢了，
  // 前端只会显示「密码不正确」，玩家一遍遍试错却永远等不到那个根本不存在的密码。
  const code = (f) => { try { f(); return null; } catch (e) { return e.code; } };

  test('没设密码的账号 + 任意密码 → NO_PASSWORD（而不是 BAD_CREDENTIALS）', () => {
    const a = fresh();
    a.register('喷壶');
    assert.equal(code(() => a.authenticate({ name: '喷壶', password: '瞎打的' })), ERR.NO_PASSWORD);
  });

  test('设了密码的账号 + 错密码 → 仍是 BAD_CREDENTIALS（提示不变）', () => {
    const a = fresh();
    a.register('甲', 'pw123456');
    assert.equal(code(() => a.authenticate({ name: '甲', password: 'wrong' })), ERR.BAD_CREDENTIALS);
  });

  test('★ NO_PASSWORD 不泄漏凭证，也不多发一张（真正的防线是「拿不到凭证」）', () => {
    const a = fresh();
    a.register('喷壶');
    assert.throws(() => a.authenticate({ name: '喷壶', password: 'whatever1' }), (e) => e.code === ERR.NO_PASSWORD);
    assert.equal(a.size, 1, '账号数没变');
    assert.equal(a.list()[0].tokens.length, 1, '也没有多发一张凭证');
    assert.equal(a.byCredential('whatever1'), null);
  });

  test('设了密码就能换设备回来（这个死循环有出口）', () => {
    const a = fresh();
    a.register('甲', 'pw123456');
    const r = a.authenticate({ name: '甲', password: 'pw123456' });
    assert.equal(r.account.name, '甲');
    assert.ok(r.token, '换设备登录会拿到一张新凭证');
    assert.equal(a.byCredential(r.token).name, '甲');
  });
});
