/**
 * budget-guard —— 预算哨兵
 *
 * 干一件事：盯着今日 AI 花费，到预算档位时主动私聊管理员预警。
 * 纯本地数据：sessions 目录算花费、cost-guard.json 拿会话排行、
 * OneBot HTTP API 发消息（只在预警那一刻发，平时零网络请求）。
 *
 * 数据口径（与 ai-status 的 computeTodayCost 一致）：
 *   花费 = data/sessions/*.json 里 startedAt 是今天的记录，
 *         按 src/model-prices.js 的峰谷计价逐条累加。
 *   预算 = 插件设置 dailyBudget > 0 优先；否则核心 budget.dailyCostYuan。
 *
 * 预警规则：thresholds 档位（默认 50/80/100），每档每天只发一次；
 * 跨天自动清零。发送目标默认主人名单第一人（私聊）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { resolveModelPrice, sumCostByTime } from '../../src/model-prices.js';
import { escapeCqText } from '../../src/util.js';

// 版本号从 plugin.json 读，不再手写 —— 手写的下场就是版本升了启动日志还印旧号，
// 排查时被它带偏（mc-status / weather-card 都栽过）。读不到退化成 v?，不影响启动。
const BUILD_TAG = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'plugin.json'), 'utf8'));
    return `v${j.version}`;
  } catch { return 'v?'; }
})();

let api = null;
let timer = null;
let fetchRef = null;
const STATE_FILE = path.join(DATA_DIR, 'budget-guard-state.json');

/* ── 设置读取 ─────────────────────────────────────────────── */
const st = () => api?.config?.() || {};
const enabled = () => st().enabled !== false;

/** 每日预算（元）。插件设置优先，其次核心配置；都没设返回 0。 */
export function dailyBudget() {
  const mine = Number(st().dailyBudget);
  if (Number.isFinite(mine) && mine > 0) return mine;
  try {
    const core = Number(getConfig()?.budget?.dailyCostYuan);
    if (Number.isFinite(core) && core > 0) return core;
  } catch { /* 核心配置读不到就算了 */ }
  return 0;
}

/** 档位列表（百分比数字，升序去重）。 */
export function thresholds() {
  const raw = String(st().thresholds ?? '50,80,100');
  return [...new Set(raw.split(/[,，、\s]+/).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

/* ── 今日花费（口径同 ai-status） ──────────────────────────── */
const localDay = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 扫描 sessions 目录算今日花费（元，精确值）。 */
export function computeTodayCost() {
  const cfg = getConfig() || {};
  const model = cfg.api?.model || '';
  const price = resolveModelPrice(model, cfg);
  if (!price || (!price.in && !price.out)) return 0;
  const today = localDay(Date.now());
  const rows = [];
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    if (!fs.existsSync(dir)) return 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!j?.startedAt || !j?.usage) continue;
      if (localDay(j.startedAt) !== today) continue;
      rows.push({
        at: j.startedAt,
        promptTokens: j.usage.promptTokens,
        completionTokens: j.usage.completionTokens,
        cachedTokens: j.usage.cachedTokens
      });
    }
  } catch { return 0; }
  return sumCostByTime(rows, price).cost ?? 0;
}

/** 今日各会话 token 排行（读 cost-guard.json，本来就算好了）。 */
export function chatRanking(topN = 3) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cost-guard.json'), 'utf8'));
    if (j.day !== localDay(Date.now())) return [];
    return Object.entries(j.chats || {})
      .map(([chatKey, tokens]) => ({ chatKey, tokens: Number(tokens) || 0 }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, topN);
  } catch { return []; }
}

/* ── 状态持久化（跨天清零） ────────────────────────────────── */
function readState() {
  const today = localDay(Date.now());
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j.day === today) return j;
  } catch { /* 没有文件或坏了，都当新的一天 */ }
  return { day: localDay(Date.now()), fired: [] };
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
  } catch (e) { api?.log?.(`写状态失败：${e.message}`); }
}

/* ── 预警发送（OneBot HTTP API，只在触发时调用） ────────────── */
async function onebotSend(kind, id, segments) {
  const cfg = getConfig()?.snowluma || {};
  const base = String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.httpAccessToken || cfg.accessToken || '');
  const res = await fetchRef(`${base}/${kind === 'private' ? 'send_private_msg' : 'send_group_msg'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}`);
}

/** 预警目标：设置里指定，或主人名单第一人（私聊）。返回 null=无处可发。 */
function notifyTarget() {
  const t = String(st().notifyTarget ?? '').trim();
  if (t) {
    const m = /^(private|group):(\d+)$/.exec(t);
    if (m) return { kind: m[1], id: m[2] };
    api?.log?.(`notifyTarget 格式不对（${t}），应为 private:QQ号 或 group:群号，忽略`);
  }
  try {
    const ids = String(getConfig()?.skills?.['owner-identity']?.ids ?? '').trim();
    const first = ids.split(/[,，\s]+/).filter(Boolean)[0];
    if (first) return { kind: 'private', id: first };
  } catch { /* 读不到就放弃 */ }
  return null;
}

const fmtTok = (n) => {
  n = Number(n) || 0;
  return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n);
};

/* ── 核心检查 ──────────────────────────────────────────────── */
export async function check({ dryRun = false } = {}) {
  const budget = dailyBudget();
  const cost = computeTodayCost();
  if (budget <= 0) { lastSnapshot = { cost, pct: 0, action: 'no-budget' }; return lastSnapshot; }

  const pct = (cost / budget) * 100;
  const state = readState();
  const th = thresholds();

  // 已达到且未发过的最高档（一次只发一档，跨档突进也只补最高那档，避免轰炸）
  let hit = null;
  for (const t of th) {
    if (pct >= t && !state.fired.includes(t)) hit = t;
  }
  if (hit == null) { lastSnapshot = { cost, pct, action: 'none' }; return lastSnapshot; }

  // 触发最高档时，把所有已越过的档一起标记——否则下一轮会把漏掉的低档再补发一遍
  for (const t of th) {
    if (pct >= t && !state.fired.includes(t)) state.fired.push(t);
  }
  if (dryRun) { writeState(state); lastSnapshot = { cost, pct, action: 'would-send' }; return lastSnapshot; }
  writeState(state);

  const target = notifyTarget();
  if (!target) {
    api?.log?.('预算到档但找不到预警目标（主人名单和 notifyTarget 都没配）');
    lastSnapshot = { cost, pct, action: 'no-target' };
    return lastSnapshot;
  }

  const lines = [
    `⚠️ 预算哨兵：今日已花费 ¥${cost.toFixed(2)} / 预算 ¥${budget.toFixed(2).replace(/\.00$/, '')}（${Math.floor(pct)}%，达到 ${hit}% 档）`
  ];
  const rank = chatRanking(3);
  if (rank.length) {
    lines.push('烧得最多的会话：');
    for (const r of rank) {
      lines.push(`· ${r.chatKey.startsWith('group:') ? '群 ' + r.chatKey.slice(6) : '私聊 ' + r.chatKey.slice(8)}：${fmtTok(r.tokens)} token`);
    }
  }
  try {
    await onebotSend(target.kind, target.id, [{ type: 'text', data: { text: escapeCqText(lines.join('\n')) } }]);
    api?.log?.(`预算预警已发（${hit}% 档，花费 ¥${cost.toFixed(2)}）`);
    lastSnapshot = { cost, pct, action: 'sent' };
    return lastSnapshot;
  } catch (e) {
    api?.error?.(`预算预警发送失败：${e.message}`);
    lastSnapshot = { cost, pct, action: 'send-failed' };
    return lastSnapshot;
  }
}

/* ── 生命周期 ──────────────────────────────────────────────── */
export function setup(a) {
  api = a;
  fetchRef = a.fetch; // 需要清单声明 web_fetch 权限
  a.log(`预算哨兵已加载（${BUILD_TAG}，预算 ${dailyBudget() > 0 ? '¥' + dailyBudget() : '未设置'}）`);
}

export function activate() {
  if (!enabled() || !fetchRef) return;
  const everyMin = Math.max(1, Number(st().checkIntervalMin) || 5);
  timer = setInterval(() => { check().catch(() => {}); }, everyMin * 60000);
  timer.unref?.();
  const boot = setTimeout(() => { check().catch(() => {}); }, 10 * 1000);
  boot.unref?.();
  api?.log?.(`预算哨兵已启用：每 ${everyMin} 分钟检查一次`);
}

export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* ── 状态面板上报（status.<插件id> 协议，同步返回缓存值） ────── */
let lastSnapshot = { cost: 0, pct: 0, action: '' };
export const providers = {
  'status.budget-guard': () => {
    if (!enabled()) return null;
    // 注意协议约束：必须同步返回。这里给的是最近一次 check 的缓存值
    //（check 是异步网络/IO 操作，不能放在这里）；还没跑过 check 时显示引导语。
    const budget = dailyBudget();
    if (budget <= 0) {
      return {
        icon: '💰',
        title: '预算哨兵',
        adminOnly: true,
        priority: 70,
        lines: [['预算', '未设置'], ['监控', '待配置 dailyBudget']]
      };
    }
    return {
      icon: '💰',
      title: '预算哨兵',
      adminOnly: true, // 花费和预算属于敏感信息，默认只给管理员看
      priority: 70,
      lines: [
        ['预算使用', `${Math.floor(lastSnapshot.pct)}%`],
        ['今日预警', lastSnapshot.action === 'sent' ? '已发' : '未触发']
      ]
    };
  }
};

// 给测试用的出口
export const internals = {
  dailyBudget, thresholds, computeTodayCost, chatRanking, readState, writeState,
  notifyTarget, check
};
