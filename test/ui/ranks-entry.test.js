// 「全服排行榜」的入口与空状态（界面接线，服务端行为见 test/leaderboard.test.js）：
//
// 钉的不变量：
//   · 标题画面、大厅、房间三处都能打开全服榜（登录后会直接进大厅，标题那个按钮点不到）；
//   · 本机统计里的「排行」tab 给一条去全服榜的路：**没玩过**时也有（空状态 + 跳转按钮），
//     有记录时也有（tab 顶部）；
//   · 两个都是全屏覆盖层，跳转必须先关统计再开榜单，否则关榜单会露出下面那一层；
//   · 文案全走 t()，en.json 里有不含汉字的英文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const TITLE = read('public/js/screens/title.js');
const LOBBY = read('public/js/screens/lobby.js');
const ROOM = read('public/js/screens/room.js');
const STATS = read('public/js/screens/stats.js');
const RANKS = read('public/js/screens/ranks.js');
const EN = JSON.parse(read('public/i18n/en.json'));

test('三处入口都能打开全服榜', () => {
  for (const [name, src, id] of [
    ['title', TITLE, null],
    ['lobby', LOBBY, 'lobby-ranks'],
    ['room', ROOM, 'room-ranks'],
  ]) {
    assert.match(src, /import \{ openRanks \} from '\.\/ranks\.js'/, `${name}: 引入 openRanks`);
    assert.match(src, /onClick=\$\{openRanks\}/, `${name}: 按钮接 openRanks`);
    if (id) assert.ok(src.includes(`data-testid="${id}"`), `${name}: 便于定位的 testid`);
  }
});

test('统计弹窗的「排行」tab 通向全服榜：有记录时在顶部，没记录时在空状态里', () => {
  assert.match(STATS, /import \{ openRanks \} from '\.\/ranks\.js'/, '统计页引入全服榜');
  assert.match(STATS, /function GlobalRanksLink\(/, '跳转组件');
  // 先关统计再开榜单：两个都是全屏覆盖层
  assert.match(STATS, /onClick=\$\{\(\) => \{ closeStats\(\); openRanks\(\); \}\}/, '先关统计再开榜单');
  // 空状态：只有排行 tab 额外给这条路
  assert.match(STATS, /function EmptyState\(\{ tab \}\)/, '空状态组件');
  assert.match(STATS, /\$\{tab === 'ranks' \? html`<\$\{GlobalRanksLink\} \/>` : null\}/, '只有排行 tab 给跳转');
  assert.match(STATS, /: empty \? html`<\$\{EmptyState\} tab=\$\{tab\} \/>`/, '没记录时走空状态');
  // 有记录时的排行 tab 顶部
  const rankings = STATS.slice(STATS.indexOf('function Rankings('), STATS.indexOf('/** A stored match re-viewed'));
  assert.match(rankings, /<\$\{GlobalRanksLink\} \/>/, '有记录时也放一个');
  assert.match(rankings, /if \(!agg\.count\) return html`<div class="st-emptywrap">/, '有记录但都不计入时也给');
});

test('全服榜本身不依赖本机记录，也没有被本机空状态挡住', () => {
  assert.match(RANKS, /fetch\('\/leaderboard'/, '向服务端要榜单');
  // 只看代码：不 import 本机统计模块，也不读它的记录（注释里提到 localStorage 是解释区别，不算）
  assert.doesNotMatch(RANKS, /import .*['"]\.\.?\/ui\/stats\.js['"]/, '不引入本机统计的数据层');
  assert.doesNotMatch(RANKS, /import .*['"]\.\/stats\.js['"]/, '不引入统计页面');
  assert.doesNotMatch(RANKS, /loadStats\(|stats\.records/, '不读本机记录');
  assert.match(RANKS, /d\.enabled === false/, '服务端没开账号系统时给一句话');
});

test('en.json 有新增文案的英文（不含汉字、非空）', () => {
  for (const zh of ['查看全服排行榜', '全服榜由服务端结算，没玩过也能看。', '全服排行榜']) {
    const en = EN[zh];
    assert.equal(typeof en, 'string', `en.json: ${zh}`);
    assert.ok(en.length > 0 && !/[一-鿿]/.test(en), `English for ${zh}`);
  }
});
