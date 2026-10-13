// 实时在线房间列表的行逻辑与文案（服务端行为见 test/room-list.test.js）：
// 一行可做的操作是纯逻辑（roomRowActions），「加入」/「观战」走 room.join / room.spectate ——
// 与输同盟密钥完全同一条协议路径；文案全走 t()，en.json 里有不含汉字的英文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_SEATS, MAX_SPECTATORS } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/screens/lobby.js'), 'utf8');
const EN = JSON.parse(readFileSync(path.join(ROOT, 'public/i18n/en.json'), 'utf8'));
const mod = () => import(pathToFileURL(path.join(ROOT, 'public/js/screens/lobby.js')).href);

const row = (o = {}) => ({
  code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', inMatch: false, humans: 1, bots: 0, spectators: 0, host: 'Host', ...o,
});

test('roomRowActions: 只有同盟房间可进；加入看空位与开没开打；观战看观战席', async () => {
  const { roomRowActions } = await mod();
  assert.deepEqual(roomRowActions(row()), { canJoin: true, canSpectate: true });
  assert.deepEqual(roomRowActions(row({ mode: 'solo' })), { canJoin: false, canSpectate: false }, '独立模拟没有别人的座位');
  assert.deepEqual(roomRowActions(row({ inMatch: true })), { canJoin: false, canSpectate: true }, '对局中走观战席');
  assert.deepEqual(roomRowActions(row({ humans: MAX_SEATS, bots: 0 })), { canJoin: false, canSpectate: true }, '博士席满');
  assert.deepEqual(roomRowActions(row({ humans: 1, bots: MAX_SEATS - 1 })), { canJoin: false, canSpectate: true }, 'AI 补满也算满');
  assert.deepEqual(roomRowActions(row({ spectators: MAX_SPECTATORS })), { canJoin: true, canSpectate: false }, '观战席满');
});

test('lobby.js 的两条入口走 room.join / room.spectate，文案全走 t() 且 en.json 有英文', () => {
  assert.match(SRC, /net\.request\('room\.join'/, '加入 = 与输密钥同一条 room.join');
  assert.match(SRC, /net\.request\('room\.spectate'/, '观战 = 与输密钥同一条 room.spectate');
  for (const zh of ['在线同盟', '暂无在线房间', '对局中', '房主：{name}', '加入']) {
    assert.ok(SRC.includes(`t('${zh}'`), `源码里 t('${zh}')`);
    assert.equal(typeof EN[zh], 'string', `en.json: ${zh}`);
    assert.ok(EN[zh].length > 0 && !/[一-鿿]/.test(EN[zh]), `English for ${zh}`);
  }
});
