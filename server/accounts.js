// server/accounts.js — 账号系统（用户名 + 服务端签发的设备凭证 + 可选密码）。
//
// 为什么需要它：全服排行榜要有「谁的成绩」这个概念。本地统计（public/js/ui/stats.js）用的是
// 浏览器里的 localStorage，换台机器就没了，也没法把成绩归到一个人身上。
//
// ── 三条防串号的设计（这个模块存在的理由）────────────────────────────────────────────
//
//  1. **身份只由服务端裁定。** `accountId` 是服务端用 CSPRNG 生成的（`a_` + 16 字节 hex），
//     客户端**从不自报**。收到的一切 ID 都只用来"找"，不用来"成为"。
//     （这条沿用 server/net.js 已有的做法：playerId 也是服务端发的 `p_` + randomBytes。）
//
//  2. **用户名不能当密码。** 用户名要显示在排行榜上，所以它是**公开**的。
//     如果注册/登录只认用户名，那任何人输 `喷壶` 就能接管这个账号 —— 那正是串号。
//     所以：用户名只用来**找**账号，进得来要靠 ①设备凭证 或 ②密码。
//     而且用户名一旦被占用，**没有凭证/密码的人根本进不来**（不是"进去再改"）。
//
//  3. **accountId 与显示名分离。** 改名不换 `accountId`：历史成绩不会因为改名而分裂成两份，
//     也不会有人靠改名去"占"别人的过去。
//
// ── 凭证为什么不存明文 ──────────────────────────────────────────────────────────────
//
// 文件里存的是 `sha256(token)`。凭证本身是 128 位随机（无法暴力枚举），存哈希之后即使
// accounts.json 被读走，也**不能直接拿来登录**（攻击者需要原像）。密码同理，用 scrypt。
//
// ── 存储 ────────────────────────────────────────────────────────────────────────────
//
// 一个 JSON 文件（`SP_ACCOUNTS_FILE`，默认 `accounts.json`）。这个部署的规模（几个人到几十人）
// 用不上数据库，而且服务器现在**零持久化依赖** —— 引入 sqlite 会给 node:24-slim 加一层编译负担。
// 写入是**原子**的（临时文件 → fsync → rename），所以任何时刻进程被杀都不会读到半个文件。
// 加载失败时**拒绝启动**而不是当作空库：宁可服务起不来让人发现，也不能把一堆账号静默清空。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 文件格式版本；将来改结构时用它做迁移。 */
export const ACCOUNTS_FORMAT = 1;

/** 用户名长度上限（与协议里的 NAME_MAX_LEN 保持同一量级）。 */
export const NAME_MAX = 16;
/** 密码长度上下限。 */
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;

/** scrypt 参数。N=2^14 在服务器上约 50ms，够挡离线爆破又不至于拖慢登录。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 128 位随机凭证（hex，32 字符），与 net.js 的 newToken 同一规格。 */
export const newToken = () => crypto.randomBytes(16).toString('hex');
const newAccountId = () => `a_${crypto.randomBytes(8).toString('hex')}`;

/**
 * 用户名的规范化形式：用于唯一性判定。
 * 做 NFKC + 去首尾空白 + 折叠内部连续空白 + 小写 —— 挡掉 "喷壶" 与 "喷 壶" / "PenHu" 与 "penhu"
 * 这类看起来不同、实际会被认成两个人的情况（也会挡掉一部分形近冒充）。
 */
export function normalizeName(name) {
  return String(name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 用户名是否合法（长度、字符）。控制字符和不可见字符一律拒绝。 */
export function nameProblem(name) {
  const raw = String(name ?? '');
  if (!raw.trim()) return 'empty';
  if (raw.length > NAME_MAX) return 'too_long';
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/.test(raw)) return 'control_chars';
  if (raw !== raw.trim()) return 'surrounding_space';
  return null; // null = 合法
}

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex'),
  n: SCRYPT.N,
  r: SCRYPT.r,
  p: SCRYPT.p,
});

/** 定时安全比较（长度不同也走同样的时间，避免用长度泄漏信息）。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // 仍然走一次比较，避免"长度不同立刻返回"成为旁路
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function verifyPassword(password, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  const got = crypto.scryptSync(String(password), rec.salt, SCRYPT.keylen, {
    N: rec.n || SCRYPT.N, r: rec.r || SCRYPT.r, p: rec.p || SCRYPT.p,
  }).toString('hex');
  return safeEqual(got, rec.hash);
}

/** 注册失败的原因（会被翻成给玩家看的文案）。 */
export const ERR = Object.freeze({
  NAME_TAKEN: 'NAME_TAKEN',
  BAD_NAME: 'BAD_NAME',
  BAD_PASSWORD: 'BAD_PASSWORD',
  NO_ACCOUNT: 'NO_ACCOUNT',
  BAD_CREDENTIALS: 'BAD_CREDENTIALS',
  STORE: 'STORE',
});

export class AccountError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 账号库。
 *
 * 并发：Node 单进程单线程 —— 每次 `register` / `rename` 都是同步跑完的，
 * 不存在两个请求交错改同一份内存状态的可能。这是这个架构最大的红利，也是为什么
 * 这里不需要锁：**只要所有写路径都是同步的**。写盘同样同步（writeFileSync + rename）。
 */
export class Accounts {
  /**
   * @param {{ file?: string, log?: { warn: Function, error: Function } }} [opts]
   */
  constructor({ file = process.env.SP_ACCOUNTS_FILE || 'accounts.json', log = console } = {}) {
    this.file = path.resolve(file);
    this.log = log;
    /** @type {Map<string, any>} accountId → record */
    this.byId = new Map();
    /** @type {Map<string, string>} normalizeName(name) → accountId */
    this.byName = new Map();
    /** @type {Map<string, string>} sha256(token) → accountId */
    this.byToken = new Map();
    this.loaded = false;
    this.dirty = false;
  }

  // ── 载入 / 写盘 ────────────────────────────────────────────────────────────────

  /**
   * 读盘。文件不存在 ⇒ 空库（首次运行）。文件存在但坏了 ⇒ **抛错**（调用方应让它中断启动）。
   * @returns {this}
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') { this.loaded = true; return this; }
      throw new AccountError(ERR.STORE, `读取 ${this.file} 失败：${e?.code || e?.message}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new AccountError(ERR.STORE, `${this.file} 不是合法 JSON（${e.message}）—— 拒绝启动，避免把它当成空库覆盖掉`);
    }
    if (!data || typeof data !== 'object' || !data.accounts || typeof data.accounts !== 'object') {
      throw new AccountError(ERR.STORE, `${this.file} 结构不对（缺 accounts）—— 拒绝启动`);
    }
    if (data.format !== ACCOUNTS_FORMAT) {
      throw new AccountError(ERR.STORE, `${this.file} 的 format 是 ${data.format}，本代码读 ${ACCOUNTS_FORMAT}`);
    }
    for (const [id, rec] of Object.entries(data.accounts)) {
      if (!rec || typeof rec !== 'object' || !rec.name) continue;
      this.byId.set(id, rec);
      this.byName.set(rec.nameLower || normalizeName(rec.name), id);
      if (rec.tokenHash) this.byToken.set(rec.tokenHash, id);
    }
    this.loaded = true;
    return this;
  }

  /** 原子写：临时文件 → fsync → rename。任何时刻被杀都不会留下半个文件。 */
  save() {
    const data = { format: ACCOUNTS_FORMAT, accounts: Object.fromEntries(this.byId) };
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fs.fsyncSync(fd);              // 先让内容落盘，再改名 —— 否则断电可能得到空文件
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);   // rename 在同一文件系统内是原子的
    this.dirty = false;
    return this;
  }

  /** 有改动才写盘。 */
  flush() { if (this.dirty) this.save(); return this; }

  get size() { return this.byId.size; }

  // ── 查 ────────────────────────────────────────────────────────────────────────

  /** 按 accountId 取（内部用，调用方拿到的 id 必须来自 session，不能来自客户端请求体）。 */
  byAccountId(id) { return this.byId.get(id) || null; }

  byName_(name) {
    const id = this.byName.get(normalizeName(name));
    return id ? this.byId.get(id) || null : null;
  }

  /** 凭证 → 账号。凭证对不上就 null（不会透露"这个账号存在但凭证错了"）。 */
  byCredential(token) {
    if (typeof token !== 'string' || !token) return null;
    const id = this.byToken.get(sha256(token));
    return id ? this.byId.get(id) || null : null;
  }

  /** 用户名是否已被占用（注册界面用；只回答是与否，不透露别的）。 */
  isNameTaken(name) { return this.byName.has(normalizeName(name)); }

  // ── 写 ────────────────────────────────────────────────────────────────────────

  /**
   * 注册。成功后返回 `{ account, token }` —— **token 只在这一次返回**（库里只存哈希）。
   * @param {string} name
   * @param {string|null} [password]
   */
  register(name, password = null) {
    const bad = nameProblem(name);
    if (bad) throw new AccountError(ERR.BAD_NAME, bad);
    if (this.isNameTaken(name)) throw new AccountError(ERR.NAME_TAKEN);
    if (password != null && (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
      throw new AccountError(ERR.BAD_PASSWORD);
    }
    const clean = String(name).normalize('NFKC').trim();
    const id = newAccountId();
    const token = newToken();
    const t = now();
    const rec = {
      id,
      name: clean,
      nameLower: normalizeName(clean),
      tokenHash: sha256(token),
      password: password != null ? hashPassword(password) : null,
      createdAt: t,
      updatedAt: t,
    };
    this.byId.set(id, rec);
    this.byName.set(rec.nameLower, id);
    this.byToken.set(rec.tokenHash, id);
    this.dirty = true;
    this.save();
    return { account: rec, token };
  }

  /**
   * 用「用户名 + 密码」登录（换设备时用；没设密码的账号走不通这条）。
   * 用户名不存在与密码错误返回同一个错误 —— 不告诉对方"这个用户名存在"。
   */
  loginWithPassword(name, password) {
    const rec = this.byName_(name);
    if (!rec || !rec.password || !verifyPassword(password, rec.password)) {
      throw new AccountError(ERR.BAD_CREDENTIALS);
    }
    return rec;
  }

  /** 改名。accountId 不变 ⇒ 历史成绩不会分裂。 */
  rename(accountId, newName) {
    const rec = this.byId.get(accountId);
    if (!rec) throw new AccountError(ERR.NO_ACCOUNT);
    const bad = nameProblem(newName);
    if (bad) throw new AccountError(ERR.BAD_NAME, bad);
    const nextLower = normalizeName(newName);
    const owner = this.byName.get(nextLower);
    if (owner && owner !== accountId) throw new AccountError(ERR.NAME_TAKEN);
    this.byName.delete(rec.nameLower);
    rec.name = String(newName).normalize('NFKC').trim();
    rec.nameLower = nextLower;
    rec.updatedAt = now();
    this.byName.set(nextLower, accountId);
    this.dirty = true;
    this.save();
    return rec;
  }

  /** 设/改密码（也可以用来清掉密码传 null）。 */
  setPassword(accountId, password) {
    const rec = this.byId.get(accountId);
    if (!rec) throw new AccountError(ERR.NO_ACCOUNT);
    if (password != null && (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
      throw new AccountError(ERR.BAD_PASSWORD);
    }
    rec.password = password != null ? hashPassword(password) : null;
    rec.updatedAt = now();
    this.dirty = true;
    this.save();
    return rec;
  }

  /**
   * 换发凭证：旧的立即失效。
   * 用途：怀疑凭证泄露、或者换设备时把凭证带走之后再作废旧的。
   * @returns {{ account: any, token: string }}
   */
  rotateCredential(accountId) {
    const rec = this.byId.get(accountId);
    if (!rec) throw new AccountError(ERR.NO_ACCOUNT);
    if (rec.tokenHash) this.byToken.delete(rec.tokenHash);
    const token = newToken();
    rec.tokenHash = sha256(token);
    rec.updatedAt = now();
    this.byToken.set(rec.tokenHash, accountId);
    this.dirty = true;
    this.save();
    return { account: rec, token };
  }

  /** 给外部看的账号快照（**不含** tokenHash / password，避免不小心漏给客户端）。 */
  publicView(account) {
    if (!account) return null;
    return { id: account.id, name: account.name, hasPassword: !!account.password };
  }

  /** 全量快照列表（管理用途）。 */
  list() { return [...this.byId.values()]; }
}

/** 便捷构造：加载失败会把错误抛给调用方（让它决定是否中断启动）。 */
export function openAccounts(opts) {
  return new Accounts(opts).load();
}
