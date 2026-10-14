// 「设置 / 修改密码」的前端接线与文案（服务端行为见 test/account-set-password.test.js）：
// 表单走 account.setPassword，两次输入不一致 / 太短在本地就拦，文案全走 t() 且 en.json 有不含汉字的英文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/screens/title.js'), 'utf8');
const NET = readFileSync(path.join(ROOT, 'public/js/net.js'), 'utf8');
const EN = JSON.parse(readFileSync(path.join(ROOT, 'public/i18n/en.json'), 'utf8'));

test('title.js 走 account.setPassword，两次输入不一致与太短都拦在本地', () => {
  assert.match(SRC, /net\.request\('account.setPassword', \{ password: pwNew \}\)/, '设密码的唯一出口');
  assert.match(SRC, /pwNew !== pwConfirm/, '两次输入要对得上');
  assert.match(SRC, /pwNew\.length < 6/, '太短本地就拦（服务端 BAD_PASSWORD 是同一口径）');
  assert.match(SRC, /net\.accountHasPassword = true/, '成功后就地更新状态，按钮变成「修改密码」');
});

test('入口只给「已带账号在线」的会话，且与「用密码登录」两套表单不互相踩', () => {
  assert.match(SRC, /hasAccount = conn\.status === 'online' && !!net\.accountId/, '身份由服务端裁定（welcome.accountId）');
  assert.match(SRC, /pwSetOpen && hasAccount && !passwordMode/, '登录失败的密码框与设置密码表单不同场');
});

test('net.js 从 welcome 记下 accountHasPassword，en.json 有全部文案的英文', () => {
  assert.match(NET, /this\.accountHasPassword = typeof msg\.accountHasPassword === 'boolean'/);
  for (const zh of [
    '设置密码', '修改密码', '确认密码', '两次输入的密码不一致',
    '密码已设置 —— 换设备时用「代号 + 密码」即可找回账号',
    '设置密码后，换设备或清了浏览器数据时，可用「代号 + 密码」找回账号。',
  ]) {
    assert.ok(SRC.includes(`t('${zh}'`), `源码里 t('${zh}')`);
    assert.equal(typeof EN[zh], 'string', `en.json: ${zh}`);
    assert.ok(EN[zh].length > 0 && !/[一-鿿]/.test(EN[zh]), `English for ${zh}`);
  }
});
