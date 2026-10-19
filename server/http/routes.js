// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * /studio and /studio/… → the plugin studio (server/studio/index.js: for this machine and the local network only — any
//     other client gets the 404 page; its API also takes POST / PUT / DELETE), when the server has one;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, the vanilla content
//     hash `content.vanilla`, the modded content sets in use `content.sets` and — only when there are some — how many
//     unofficial plugins the server has, `content.plugins` (the title screen's count before any hello) — DESIGN §32 —,
//     sockets, sessions,
//     rooms, matches and the process figures — pid, RSS / heap / external memory and the event-loop delay histogram
//     (processMetrics.js: a server-run field, a verification replay and a bot's rehearsal all step on this thread) —),
//     never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) for a loopback or private-network client only — the maintainer's
//     decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or proxy on this
//     machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { processMetrics } from './processMetrics.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { clientAddress, isLocalIp } from '../net.js';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const MAX_URL_LENGTH = 4096;

/** `{ plugins: n }` when the server has n > 0 unofficial plugins (the lobby's visual sets count them), else nothing. */
function pluginCount(lobby) {
  let n;
  try { n = Number(lobby?.plugins?.unofficial?.()) || 0; } catch { n = 0; }
  let notices = false;
  try { notices = lobby?.plugins?.hasNotices?.() === true; } catch { /* optional catalogue hint */ }
  return { ...(n > 0 ? { plugins: n } : {}), ...(notices ? { notices: true } : {}) };
}

/** The content sets with gameplay plugins rooms hold now (DESIGN §32.6; 0 without any). */
function contentSets(lobby) {
  try { return Number(lobby?.plugins?.contentInUse?.()) || 0; } catch { return 0; }
}

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, content?: { cs: string } | null,
 *           leaderboard?: import('../leaderboard.js').Leaderboard | null,
 *           traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null }} health
 *   content: the server's vanilla content (server/plugins/identity.js)
 * @param {boolean} [withTraffic]
 */
export function healthReport({ startedAt, network, registry, lobby, content = null, traffic, assetIndex, views, trusted }, withTraffic = false) {
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    // what its rooms play (DESIGN §32): the vanilla content hash, and how many content sets with gameplay plugins rooms
    // hold now (P1c, §32.6 — a room's cosmetic plugins leave its cs the vanilla one, §32.3); how many unofficial plugins
    // it has, when it has some (a page's title screen says so; P1a)
    ...(content ? { content: { vanilla: content.cs, sets: contentSets(lobby), ...pluginCount(lobby) } } : {}),
    sockets: network.connectionCount, sessions: registry.size, process: processMetrics(), ...lobby.stats(),
  };
  if (trusted && Object.keys(trusted).length) report.plugins = trusted;
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * GET /leaderboard 的响应体 —— 全服排行榜（只读聚合）。
 *
 * 这是排行榜**唯一**的对外读接口：只返回聚合后的榜单，没有"按 id 查任意玩家明细"的入口，
 * 所以拿到这个 URL 的人只能看到本来就公开的排名，看不到任何一局的原始记录。
 * 服务端没启用账号系统（或没配榜单文件）时返回 `{ enabled: false }`，前端据此隐藏入口。
 * @param {{ leaderboard?: import('../leaderboard.js').Leaderboard | null }} health
 */
export function leaderboardReport({ leaderboard }) {
  if (!leaderboard) return { enabled: false };
  return { enabled: true, ...leaderboard.boards() };
}

// ---------------------------------------------------------------------------------------------------
// 账号：密码重置（HTTP，两步）+ 服主批准（仅回环）
// ---------------------------------------------------------------------------------------------------
//
// 为什么这两步不走 WebSocket：它们必须发生在 **hello 之前** —— 忘了密码又丢了设备凭证的人
// 根本登不进来，没有任何会话可用。其余账号操作（改密码 / 改名 / 退出设备 / 踢掉其他设备）
// 都在会话里，走 WS（server/net.js 的 account.*）。

const MAX_JSON_BODY = 4096;

/** 这些码可以回给浏览器；其余（STORE 等）折成 500，避免把文件路径之类的信息漏出去。 */
const PUBLIC_ACCOUNT_ERRORS = new Set(['BAD_NAME', 'BAD_PASSWORD', 'NO_ACCOUNT', 'RESET_PENDING', 'RESET_BAD_CODE', 'RESET_EXPIRED']);
const ACCOUNT_ERROR_STATUS = Object.freeze({
  BAD_NAME: 400, BAD_PASSWORD: 400, NO_ACCOUNT: 404,
  RESET_PENDING: 403, RESET_BAD_CODE: 403, RESET_EXPIRED: 410,
});

/** 读一个 JSON 对象请求体（上限 4 KB）。坏 JSON / 超长 / 非对象 → null。 */
function readJsonBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve) => {
    let size = 0;
    let dead = false;
    const chunks = [];
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > limit) { dead = true; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      if (!chunks.length) { resolve(null); return; }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
      } catch { resolve(null); }
    });
    req.on('error', () => { if (!dead) { dead = true; resolve(null); } });
  });
}

/**
 * 重置申请的频率闸（进程内存）：同一来源 10 分钟最多 5 次。
 * 防的不是猜码（8 位、32 个字符的字母表 ≈ 1.1e12），而是别让人把 accounts.json 当日志刷。
 */
const RESET_WINDOW_MS = 10 * 60 * 1000;
const RESET_MAX_PER_WINDOW = 5;
const resetHits = new Map();

function resetRateLimited(ip, nowMs = Date.now()) {
  const list = (resetHits.get(ip) || []).filter((t) => nowMs - t < RESET_WINDOW_MS);
  if (list.length >= RESET_MAX_PER_WINDOW) { resetHits.set(ip, list); return true; }
  list.push(nowMs);
  resetHits.set(ip, list);
  // 长跑进程里不留垃圾：来源表超过 5000 条时顺手清掉过期的
  if (resetHits.size > 5000) for (const [k, v] of resetHits) if (!v.length || nowMs - v[v.length - 1] > RESET_WINDOW_MS) resetHits.delete(k);
  return false;
}

/** 严格的本机判断 —— 只用回环，**不含**私网。frpc 容器（私网地址）转进来的公网流量不该被当成服主。 */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:0:127.0.0.1']);
const isLoopback = (ip) => LOOPBACK_IPS.has(String(ip || ''));

/**
 * 宿主机在容器里的样子：默认网关。
 *
 * 玩家从公网进来是 frpc 容器转发的，容器看到的来源是 **frpc 的容器 IP**；而服主在宿主机上
 * `curl 127.0.0.1:3000` 时，经过 docker 的端口 NAT，容器看到的来源是**网桥网关**（172.x.0.1）。
 * 所以「只在回环上」这条判断在容器里会永远不成立 —— 必须把宿主机网关也算进「本机」。
 * frpc 的容器 IP 与网关不同，公网流量因此仍然进不来。
 * @returns {string | null} the gateway address, or null (not Linux / unreadable)
 */
let gatewayCache;
function hostGateway() {
  if (gatewayCache !== undefined) return gatewayCache;
  gatewayCache = null;
  try {
    const text = readFileSync('/proc/net/route', 'utf8');
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 2 && f[1] === '00000000' && /^[0-9a-fA-F]{8}$/.test(f[2])) {
        const bytes = f[2].match(/../g).reverse().map((b) => parseInt(b, 16));
        gatewayCache = bytes.join('.');
        break;
      }
    }
  } catch { /* 不是 Linux，或 /proc 不可读：只认回环 */ }
  return gatewayCache;
}

/** 去掉 IPv4-mapped 前缀，好和网关地址直接比。 */
const bareIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

/**
 * 服主接口的闸：没配 SP_ADMIN_TOKEN 就当作不存在；配了还要**来源是本机**（回环或宿主机网关）
 * 且 token 正确。
 *
 * 来源只认**原始连接地址**（`req.socket.remoteAddress`），不看 `X-Forwarded-For` —— 公网流量由
 * frpc 转发，来源是私网地址，`clientAddress` 的 trustProxy 规则会把转发的头当真，那样任何人
 * 都能伪造成 127.0.0.1。token 仍是唯一真正的凭据，这层只是别把门开在错误的地方。
 */
export function isAdminRequest(req) {
  const token = process.env.SP_ADMIN_TOKEN;
  if (!token) return false;
  const peer = bareIp(req.socket?.remoteAddress);
  const gw = hostGateway();
  if (!isLoopback(peer) && !(gw && peer === gw)) return false;
  const got = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 把 AccountError 翻成 JSON 错误；不认识的码按 500 处理（并记日志，不回内部信息）。 */
function sendAccountError(req, res, e, log) {
  const code = typeof e?.code === 'string' && PUBLIC_ACCOUNT_ERRORS.has(e.code) ? e.code : null;
  if (!code) {
    log.error('[http] account route failed', e);
    sendError(req, res, 500, '服务器内部错误 · Internal error');
    return;
  }
  sendJson(req, res, ACCOUNT_ERROR_STATUS[code] || 400, { error: code });
}

/**
 * `/account/reset-request` 与 `/account/reset-complete`。
 * 两步都不需要会话；申请**不验证身份**（谁都能为任何代号申请），真正的闸是服主批准。
 * `reset-compete` 成功后回一张新的设备凭证 —— 客户端存进 localStorage 再正常 hello 即可。
 */
async function handleAccountRoute(req, res, parts, health, { trustProxy, log }) {
  const accounts = health.accounts;
  if (!accounts) { sendJson(req, res, 404, { error: 'DISABLED' }); return; }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(req, res, 405, { error: 'METHOD' });
    return;
  }
  if (parts.rawPath === '/account/reset-request') {
    if (resetRateLimited(clientAddress(req, trustProxy).ip)) { sendJson(req, res, 429, { error: 'RATE' }); return; }
    const body = await readJsonBody(req);
    if (!body || typeof body.name !== 'string') { sendJson(req, res, 400, { error: 'BAD_MSG' }); return; }
    try {
      const r = accounts.requestReset(body.name);
      sendJson(req, res, 200, { code: r.code, expiresAt: r.expiresAt });
    } catch (e) { sendAccountError(req, res, e, log); }
    return;
  }
  if (parts.rawPath === '/account/reset-complete') {
    const body = await readJsonBody(req);
    if (!body || typeof body.name !== 'string' || typeof body.code !== 'string' || typeof body.password !== 'string') {
      sendJson(req, res, 400, { error: 'BAD_MSG' });
      return;
    }
    try {
      const r = accounts.completeReset({ name: body.name, code: body.code, password: body.password });
      sendJson(req, res, 200, { name: r.account.name, token: r.token });
    } catch (e) { sendAccountError(req, res, e, log); }
    return;
  }
  sendJson(req, res, 404, { error: 'NOT_FOUND' });
}

/**
 * 服主接口（只在回环 + SP_ADMIN_TOKEN 时存在）：
 *   GET  /admin/resets            → { resets: [{ name, requestedAt, expiresAt, approved, expired }] }
 *   POST /admin/resets/approve    → body { code } 或 { name } → { approved: true, name }
 * 玩家在游戏里申请后拿到一个 8 位重置码，报给服主；服主 approve 之后玩家才能用这个码设新密码。
 */
async function handleAdminRoute(req, res, parts, health, { trustProxy, log }) {
  if (!isAdminRequest(req)) { sendJson(req, res, 404, { error: 'NOT_FOUND' }); return; }
  const accounts = health.accounts;
  if (!accounts) { sendJson(req, res, 503, { error: 'DISABLED' }); return; }
  if (req.method === 'GET' && parts.rawPath === '/admin/resets') {
    sendJson(req, res, 200, { resets: accounts.pendingResets() });
    return;
  }
  if (req.method === 'POST' && parts.rawPath === '/admin/resets/approve') {
    const body = await readJsonBody(req);
    if (!body) { sendJson(req, res, 400, { error: 'BAD_MSG' }); return; }
    try {
      const r = accounts.approveReset({
        code: typeof body.code === 'string' ? body.code : null,
        name: typeof body.name === 'string' ? body.name : null,
      });
      sendJson(req, res, 200, { approved: true, name: r.name });
    } catch (e) { sendAccountError(req, res, e, log); }
    return;
  }
  sendJson(req, res, 404, { error: 'NOT_FOUND' });
}

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object, trustProxy?: 'auto' | boolean,
 *           csp?: string | null,
 *           studio?: { handles: (rawPath: string) => boolean, handle: (req: any, res: any, rawPath: string, query: string) => Promise<void> } | null }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY); studio: the
 *   plugin studio (server/studio/index.js), or none
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, trustProxy = 'auto', studio = null, csp = null, trustedRuntime = null }) {
  const ctx = { trustProxy, log };
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (trustedRuntime && parts.rawPath.startsWith('/x/') && await trustedRuntime.route(req,res,parts.rawPath)) return;
    if (studio && studio.handles(parts.rawPath)) { await studio.handle(req, res, parts.rawPath, parts.query); return; }
    // 账号：改密码 / 改名 / 退出设备走 WebSocket（要会话）；只有「忘记密码」的两步和服主的批准走 HTTP ——
    // 忘了密码的人根本进不了门，等不来一个会话。见 handleAccountRoute。
    if (parts.rawPath.startsWith('/account/')) { await handleAccountRoute(req, res, parts, health, ctx); return; }
    // 服主接口：只在**回环**（SSH 里 curl）且带 SP_ADMIN_TOKEN 时存在，别的情况一律 404 —— 不承认自己存在。
    if (parts.rawPath.startsWith('/admin/')) { await handleAdminRoute(req, res, parts, health, ctx); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    // 全服排行榜（只读）。没有缓存头 —— 榜单一变就该看到新的，而且它本来就很小。
    if (parts.rawPath === '/leaderboard') {
      sendJson(req, res, 200, leaderboardReport(health));
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    if (csp) res.setHeader('Content-Security-Policy', csp);
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
