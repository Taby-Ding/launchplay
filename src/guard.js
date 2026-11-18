'use strict';
/**
 * guard.js —— 家长守护模式（主进程）
 *
 * 安全边界：
 *  · 密码只以 scrypt(salt, 32) 哈希存盘，明文与哈希都不会发给渲染层；
 *  · 家长守护配置不接受 state:save 覆盖，只能走 guard:configure（需先验证密码）；
 *  · 题目与答案都在主进程，渲染层只拿到题干和选项，提交选项索引由主进程判定；
 *  · 计时基于 Date.now() 的绝对时间戳并落盘，重启 / 关机都不清零。
 *
 * 计时规则（重要）：
 *  · 只统计程序真正在运行的时间，关机 / 重启 / 系统睡眠期间不计入使用时长；
 *  · 但重启前的累计时长不丢失，重启后接着算；
 *  · 系统时间被往回调时不倒扣、也不额外补时，避免改时间绕过；
 *  · 强制休息与答错锁定用绝对结束时间戳，重启后继续生效，防止靠重启跳过。
 *
 * 能力边界：任务管理器结束进程属于操作系统层面的强制手段，任何普通应用都无法
 * 真正阻止；本模块能拦住应用内的退出、切桌面、添加应用等路径，配合 lockdown.js
 * 做轻量加固（进程被结束后自动拉起）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WRONG_LOCK_MS = 60 * 1000;      // 答错后等待 1 分钟自动换题
const UNLOCK_MS = 5 * 60 * 1000;      // 验证密码后的临时放行窗口
const GAP_MAX_MS = 2 * 60 * 1000;     // 单次间隔超过 2 分钟视为「程序没在跑」，不算使用时长
const PERSIST_MS = 10 * 1000;         // 每 10 秒落盘一次，避免频繁写 JSON

/* ---------------- 密码 ---------------- */
function hashPassword(pwd) {
  const passSalt = crypto.randomBytes(16).toString('hex');
  const passHash = crypto.scryptSync(String(pwd), passSalt, 32).toString('hex');
  return { passSalt, passHash };
}

function verifyPassword(pwd, salt, hash) {
  if (!salt || !hash || typeof pwd !== 'string') return false;
  try {
    const a = Buffer.from(crypto.scryptSync(pwd, salt, 32).toString('hex'), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/* ---------------- 题库 ---------------- */
/**
 * 格式：{ q: "题干", options: ["A","B",...], answer: 正确选项下标(0 起) }
 * answer 也允许直接写正确选项的文字，会自动换算成下标。
 */
const DEFAULT_QUESTIONS = [
  { q: '1 + 1 = ?', options: ['1', '2', '3', '4'], answer: 1 },
  { q: '太阳从哪个方向升起？', options: ['东', '南', '西', '北'], answer: 0 },
  { q: '一年有多少个月？', options: ['10', '11', '12', '13'], answer: 2 },
  { q: '7 × 8 = ?', options: ['48', '54', '56', '64'], answer: 2 },
  { q: '水的化学式是？', options: ['CO2', 'H2O', 'O2', 'NaCl'], answer: 1 },
  { q: '下列哪个是哺乳动物？', options: ['鲨鱼', '企鹅', '鲸鱼', '蜻蜓'], answer: 2 },
  { q: '一个小时有多少分钟？', options: ['30', '60', '90', '100'], answer: 1 },
  { q: '中国的首都是？', options: ['上海', '广州', '北京', '深圳'], answer: 2 },
  { q: '圆周率 π 约等于？', options: ['2.14', '3.14', '4.14', '5.14'], answer: 1 },
  { q: '彩虹通常有几种颜色？', options: ['5', '6', '7', '8'], answer: 2 },
  { q: '36 ÷ 6 = ?', options: ['4', '5', '6', '7'], answer: 2 },
  { q: '下面哪个是偶数？', options: ['13', '21', '24', '35'], answer: 2 },
  { q: '一天有多少小时？', options: ['12', '20', '24', '36'], answer: 2 },
  { q: '光速比声速？', options: ['慢', '一样快', '快', '无法比较'], answer: 2 },
  { q: '9 的平方是？', options: ['18', '27', '64', '81'], answer: 3 },
];

function normalizeQuiz(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.questions) ? raw.questions : null);
  if (!arr || !arr.length) return { ok: false, error: '题库为空，或不是 { "questions": [...] } 格式' };
  const out = [];
  for (const it of arr) {
    if (!it || typeof it.q !== 'string' || !Array.isArray(it.options) || it.options.length < 2) continue;
    let ans = -1;
    if (typeof it.answer === 'number' && Number.isInteger(it.answer)) ans = it.answer;
    else if (typeof it.answer === 'string') {
      ans = it.options.findIndex((o) => String(o).trim() === it.answer.trim());
    }
    if (ans < 0 || ans >= it.options.length) continue;
    out.push({
      q: it.q.trim().slice(0, 200),
      options: it.options.map((o) => String(o).trim().slice(0, 120)),
      answer: ans,
    });
    if (out.length >= 2000) break;
  }
  if (!out.length) return { ok: false, error: '没有有效题目（每题需 q / options / answer）' };
  return { ok: true, questions: out };
}

/* ---------------- 服务 ---------------- */
class GuardService {
  /**
   * @param {{getCfg:Function,setCfg:Function,send:Function,dataDir:string}} opts
   */
  constructor(opts) {
    this.getCfg = opts.getCfg;
    this.setCfg = opts.setCfg;
    this.send = opts.send;
    this.dataDir = opts.dataDir;
    this.quizFile = path.join(opts.dataDir, 'quiz.json');

    const c = this.cfg;
    const now = Date.now();
    this.usageMs = Math.max(0, Number(c.usageMs) || 0);
    this.lastAt = Number(c.lastAt) || 0;
    this.restUntil = Number(c.restUntil) || 0;
    this.wrongUntil = Number(c.wrongUntil) || 0;

    // 上次进程可能在休息中被关闭：结束时间还没到就继续休息，到了就恢复
    this.state = this.restUntil > now ? 'resting' : 'running';
    if (this.state === 'running') this.restUntil = 0;
    // 关键：启动瞬间把时间基准挪到「现在」，关机 / 重启那段间隔不会被算成使用时长
    this.lastAt = now;

    this.unlockedUntil = 0;
    this.currentQ = null;
    this.lastQIndex = -1;
    this._lastPersist = 0;

    this.timer = setInterval(() => this.tick(), 1000);
  }

  get cfg() { return this.getCfg() || {}; }
  get unlocked() { return Date.now() < this.unlockedUntil; }
  get enabled() { return !!(this.cfg.enabled && this.cfg.passHash); }
  /** 是否需要拦住"退出 / 切桌面 / 添加应用"等动作 */
  get blocking() { return this.enabled && !this.unlocked; }
  get restLeft() { return Math.max(0, Math.ceil((this.restUntil - Date.now()) / 1000)); }
  get wrongLeft() { return Math.max(0, Math.ceil((this.wrongUntil - Date.now()) / 1000)); }
  /** 轻量加固是否开启（供主进程查询） */
  get lockdown() { return !!(this.enabled && this.cfg.lockdown && !this.unlocked); }

  publicCfg() {
    const c = this.cfg;
    return {
      enabled: !!c.enabled && !!c.passHash,
      hasPassword: !!c.passHash,
      intervalMin: clampInt(c.intervalMin, 5, 240, 60),
      restMin: clampInt(c.restMin, 1, 120, 10),
      quizEnabled: c.quizEnabled !== false,
      lockdown: !!c.lockdown,
    };
  }

  verify(pwd) {
    if (!verifyPassword(pwd, this.cfg.passSalt, this.cfg.passHash)) return { ok: false, error: '密码不正确' };
    this.unlockedUntil = Date.now() + UNLOCK_MS;
    this.push();
    return { ok: true, unlocked: true };
  }

  configure(patch) {
    // 首次配置（守护还没启用、也没有密码）必须放行，否则永远设不了密码；
    // 一旦启用过，后续任何改动都要求先验证密码。
    const wasEnabled = this.enabled;
    if (wasEnabled && !this.unlocked) return { ok: false, error: '请先验证家长守护密码' };
    const p = patch && typeof patch === 'object' ? patch : {};
    const c = { ...this.cfg };
    if (typeof p.enabled === 'boolean') c.enabled = p.enabled;
    if (typeof p.quizEnabled === 'boolean') c.quizEnabled = p.quizEnabled;
    if (typeof p.lockdown === 'boolean') c.lockdown = p.lockdown;
    if (p.intervalMin !== undefined) c.intervalMin = clampInt(p.intervalMin, 5, 240, 60);
    if (p.restMin !== undefined) c.restMin = clampInt(p.restMin, 1, 120, 10);
    if (typeof p.password === 'string' && p.password.trim()) {
      const pw = p.password.trim();
      if (pw.length < 4) return { ok: false, error: '密码至少 4 位' };
      Object.assign(c, hashPassword(pw));
    }
    if (c.enabled && !c.passHash) return { ok: false, error: '开启前请先设置家长守护密码' };

    // 开关状态变化 = 新的一轮，从零开始计时；不改变开关时保留已累计时长
    if (c.enabled !== wasEnabled || p.resetTimer === true) {
      const now = Date.now();
      this.usageMs = 0;
      this.lastAt = now;
      this.restUntil = 0;
      this.wrongUntil = 0;
      this.state = 'running';
      this.currentQ = null;
      c.usageMs = 0; c.lastAt = now; c.restUntil = 0; c.wrongUntil = 0;
    }
    this.setCfg(c);
    if (!c.enabled || !c.passHash) this.endRest();
    this.push();
    return { ok: true, cfg: this.publicCfg() };
  }

  /* ---- 题库 ---- */
  questions() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.quizFile, 'utf8').replace(/^\uFEFF/, ''));
      const n = normalizeQuiz(raw);
      if (n.ok) return n.questions;
    } catch { /* 没导入或文件坏了就用内置题库 */ }
    return DEFAULT_QUESTIONS;
  }

  quizInfo() {
    let source = '内置题库';
    let count = DEFAULT_QUESTIONS.length;
    let custom = false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.quizFile, 'utf8').replace(/^\uFEFF/, ''));
      const n = normalizeQuiz(raw);
      if (n.ok) { source = '自导入题库'; count = n.questions.length; custom = true; }
    } catch { /* ignore */ }
    return { source, count, custom, path: this.quizFile };
  }

  importQuiz(srcPath) {
    if (!srcPath || typeof srcPath !== 'string') return { ok: false, error: '未选择文件' };
    let n;
    try {
      const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, ''));
      n = normalizeQuiz(raw);
    } catch (e) {
      return { ok: false, error: '读取失败：' + (e && e.message) };
    }
    if (!n.ok) return n;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.quizFile, JSON.stringify({ version: 1, questions: n.questions }, null, 2), 'utf8');
    } catch (e) {
      return { ok: false, error: '保存失败：' + (e && e.message) };
    }
    this.currentQ = null;
    this.lastQIndex = -1;
    this.wrongUntil = 0;
    this.persist();
    return { ok: true, count: n.questions.length };
  }

  /** 导出一份样本题库到数据目录，方便照着格式改 */
  exportSample() {
    const out = path.join(this.dataDir, 'questions.sample.json');
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ version: 1, questions: DEFAULT_QUESTIONS }, null, 2), 'utf8');
      return { ok: true, path: out };
    } catch (e) {
      return { ok: false, error: (e && e.message) || '写入失败' };
    }
  }

  /* ---- 答题 ---- */
  nextQuestion() {
    if (this.wrongLeft > 0) return { ok: false, locked: true, left: this.wrongLeft, error: `答错了，${this.wrongLeft} 秒后自动换题` };
    const qs = this.questions();
    let i = Math.floor(Math.random() * qs.length);
    if (qs.length > 1) {
      let guard = 0;
      while (i === this.lastQIndex && guard++ < 8) i = Math.floor(Math.random() * qs.length);
    }
    this.lastQIndex = i;
    this.currentQ = qs[i];
    return { ok: true, q: this.currentQ.q, options: this.currentQ.options };
  }

  answer(idx) {
    if (!this.currentQ) return { ok: false, error: '当前没有题目，请先取题' };
    if (this.wrongLeft > 0) return { ok: false, locked: true, left: this.wrongLeft };
    const correct = Number(idx) === this.currentQ.answer;
    if (correct) {
      this.wrongUntil = 0;
      this.endRest();
      return { ok: true, correct: true };
    }
    this.wrongUntil = Date.now() + WRONG_LOCK_MS;
    this.persist();
    return { ok: true, correct: false, left: Math.ceil(WRONG_LOCK_MS / 1000) };
  }

  /* ---- 现实时间计时 ---- */
  /**
   * 每秒一拍，但增量取自 Date.now() 而不是「+1」。
   * 这样即使进程被挂起、系统睡眠或重启，计时也不会失真。
   */
  tick() {
    const now = Date.now();
    if (!this.enabled) {
      if (this.state !== 'running') this.endRest();
      else { this.lastAt = now; this.push(); }
      return;
    }
    // 家长临时放行期间不累计使用时长（家长自己在设置里操作不算孩子看电视）
    if (this.unlocked) { this.lastAt = now; this.push(); return; }

    let delta = now - this.lastAt;
    if (delta < 0) delta = 0;                 // 系统时间被往回调：不倒扣，也不补时
    if (delta > GAP_MAX_MS) delta = 1000;     // 关机 / 睡眠 / 崩溃期间不算使用时长
    this.lastAt = now;

    if (this.state === 'resting') {
      if (now >= this.restUntil) this.endRest();
    } else {
      this.usageMs += delta;
      if (this.usageMs >= this.publicCfg().intervalMin * 60 * 1000) this.startRest(now);
    }
    this.push();
    if (now - this._lastPersist >= PERSIST_MS) this.persist(now);
  }

  startRest(now = Date.now()) {
    this.state = 'resting';
    this.restUntil = now + this.publicCfg().restMin * 60 * 1000;
    this.usageMs = 0;
    this.currentQ = null;
    this.wrongUntil = 0;
    this.persist(now);
    this.push();
  }

  endRest() {
    this.state = 'running';
    this.restUntil = 0;
    this.usageMs = 0;
    this.lastAt = Date.now();
    this.currentQ = null;
    this.wrongUntil = 0;
    this.persist(this.lastAt);
    this.push();
  }

  /** 把绝对时间戳写回配置；setCfg 由主进程接到 store.save() */
  persist(now = Date.now()) {
    this._lastPersist = now;
    this.setCfg({
      ...this.cfg,
      usageMs: Math.round(this.usageMs),
      lastAt: this.lastAt,
      restUntil: this.restUntil,
      wrongUntil: this.wrongUntil,
    });
  }

  push() {
    try {
      this.send('guard:state', {
        active: this.state === 'resting',
        state: this.state,
        restLeft: this.restLeft,
        wrongLeft: this.wrongLeft,
        unlocked: this.unlocked,
        enabled: this.enabled,
        cfg: this.publicCfg(),
      });
    } catch { /* 窗口还没建好时忽略 */ }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.persist();   // 退出前把最新时间戳落盘，下次启动能接着算
  }
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

module.exports = {
  GuardService,
  hashPassword,
  verifyPassword,
  normalizeQuiz,
  DEFAULT_QUESTIONS,
};
