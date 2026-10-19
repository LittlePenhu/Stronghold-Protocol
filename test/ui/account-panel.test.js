// 「账号面板 / 忘记密码」的前端接线与文案（服务端行为见 test/account-panel.test.js、test/account-reset.test.js）：
//
// 这个文件不渲染 DOM（仓库里的 ui 测试都是这种"读源码钉接线"的做法），钉的是**接线**：
//   · 会话里的四件事走 WS（account.info / setPassword / rename / logout / revokeOthers）；
//   · 改密码 / 改名在账号已有密码时**必须带**旧密码字段；
//   · 「退出这台设备」成功之后要真的忘掉本地凭证（否则下次还会拿那张已撤销的凭证去握手）；
//   · 忘了密码的第二步只走 HTTP /account/reset-complete，成功后把新凭证存进 identity；
//   · 全部文案走 t()，en.json 里有不含汉字的英文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACC = readFileSync(path.join(ROOT, 'public/js/ui/account.js'), 'utf8');
const TITLE = readFileSync(path.join(ROOT, 'public/js/screens/title.js'), 'utf8');
const EN = JSON.parse(readFileSync(path.join(ROOT, 'public/i18n/en.json'), 'utf8'));

test('面板的四条 WS 消息就是 server/net.js 处理的那四个，不多不少', () => {
  assert.match(ACC, /net\.request\('account\.info'/, 'account.info');
  assert.match(ACC, /net\.request\('account\.setPassword'/, 'account.setPassword');
  assert.match(ACC, /net\.request\('account\.rename'/, 'account.rename');
  assert.match(ACC, /net\.request\('account\.logout'/, 'account.logout');
  assert.match(ACC, /net\.request\('account\.revokeOthers'/, 'account.revokeOthers');
});

test('改密码 / 改名在已有密码时带 oldPassword / password —— 与 accounts.js 的闸同一条口径', () => {
  assert.match(ACC, /info\?\.hasPassword \? \{ password: newPw, oldPassword: oldPw \} : \{ password: newPw \}/,
    '改密码：有密码才要旧密码');
  assert.match(ACC, /info\?\.hasPassword \? \{ name, password: renamePw \} : \{ name \}/,
    '改名：有密码才要密码');
});

test('退出这台设备之后忘掉本地凭证；踢其他设备不动当前这张', () => {
  assert.match(ACC, /net\.request\('account\.logout'\)[\s\S]{0,200}identity\.forgetAccount\(\)/, '退出后清 localStorage');
  assert.match(ACC, /net\.request\('account\.revokeOthers'\)/, '踢其他设备走独立消息');
  // 没密码的账号退出是不可逆的 —— 界面必须先说清楚
  assert.match(ACC, /logoutWarning/, '退出前有措辞区分「有密码 / 没密码」');
  assert.match(ACC, /没有设置密码 —— 退出这台设备后就再也进不来了/, '没密码时的警告文案在');
});

test('忘记密码：申请与完成各走一条 HTTP 接口，成功即存下新凭证', () => {
  assert.match(ACC, /postJson\('\/account\/reset-request'/, '申请拿码');
  assert.match(ACC, /postJson\('\/account\/reset-complete'/, '用码换新密码');
  assert.match(ACC, /identity\.saveAccountToken\(data\.token\)/, '新凭证存进 identity');
});

test('title.js 把两块面板挂上，且入口只在合适的时机出现', () => {
  assert.match(TITLE, /import \{ AccountPanel, ForgotPasswordPanel \} from '\.\.\/ui\/account\.js'/, '引入两块面板');
  assert.match(TITLE, /<\$\{AccountPanel\} open=\$\{accountOpen\}/, '账号面板挂在标题画面');
  assert.match(TITLE, /<\$\{ForgotPasswordPanel\} open=\$\{forgotOpen\}/, '忘记密码面板挂在标题画面');
  assert.match(TITLE, /onClick=\$\{\(\) => setForgotOpen\(true\)\}/, '有「忘记密码」入口');
  assert.match(TITLE, /onDone=\$\{\(n\) => \{/, '重置完成后回填代号');
});

test('en.json 有全部新增文案的英文（不含汉字、非空）', () => {
  const keys = [
    '账号', '忘记密码', '忘记密码？', '忘记密码？申请重置', '重置码', '获取重置码', '重置密码',
    '当前密码', '新密码', '确认新密码', '保存密码', '退出这台设备', '踢掉其他设备', '改代号',
    '新代号', '保存代号', '注册时间', '已登录设备', '已设置', '未设置', '代号',
    '这个代号没有对应的账号。', '重置申请还没被服主批准 —— 把重置码报给服主，等他确认。',
    '重置码不对（或者已经被新的申请覆盖了）。', '重置码过期了，请重新申请。',
  ];
  for (const zh of keys) {
    const en = EN[zh];
    assert.equal(typeof en, 'string', `en.json: ${zh}`);
    assert.ok(en.length > 0 && !/[一-鿿]/.test(en), `English for ${zh}`);
  }
});
