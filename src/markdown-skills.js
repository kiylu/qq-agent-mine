// Markdown 技能（L2）：**声明式**技能 —— 一份带 YAML frontmatter 的 `SKILL.md`。
//
// 与另外两型并列，是第三型扩展：
//   skills/<id>/index.js            JS 模块型：注册工具、提供能力（重能力）
//   plugins/<id>/index.js           确定性型：提供能力 / 钩子
//   skills|plugins/<id>/SKILL.md    本型：**只有提示词**（轻玩法，任何人可写）
//
// ── 渐进式披露（这是它不破缓存的关键）──────────────────────────────────
//   · 常驻系统提示词的**只有 name + description**（稳定索引，见 markdownSkillIndexText）；
//   · 正文**不进前缀** —— 要么模型主动调 load_skill 取，要么命中触发词时作为
//     **尾部消息**追加（追加不改前缀字节，caching-contract 铁律二）。
//
// ⚠️ 索引随会话边界刷新，不需要额外的"批量 flush"逻辑：
//    系统提示词在会话内是逐字节复用的（conversation.js 存 prevBuf.systemPrompt），
//    所以增删技能**不会当场打断缓存**，只在下个会话生效 —— 这正是
//    caching-contract.md 里"批量 flush 到会话关闭"想要的效果。
//
// ⚠️ 开关**不写进 config.skills**（那是 JS 技能的命名空间，由 skills/config.js 独占），
//    本型用独立的 config.markdownSkills.items[id]，避免两套开关互相干扰。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig, updateConfig } from './config.js';

// 与 plugin-loader.js 同一约定：以模块自身位置为锚点，且允许环境变量覆盖，
// 让核心测试能在"不加载用户真实扩展"的前提下跑。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = process.env.QQ_AGENT_SKILLS_DIR
  ? path.resolve(process.env.QQ_AGENT_SKILLS_DIR)
  : path.resolve(APP_ROOT, 'skills');
const PLUGINS_DIR = process.env.QQ_AGENT_PLUGINS_DIR
  ? path.resolve(process.env.QQ_AGENT_PLUGINS_DIR)
  : path.resolve(APP_ROOT, 'plugins');
const SCAN_DIRS = [SKILLS_DIR, PLUGINS_DIR];

// 命中统计（谁被加载过、加载过几次）落盘，供管理端展示。
const STATS_FILE = path.join(DATA_DIR, 'markdown-skill-stats.json');

const DEFAULT_MAX_BODY_CHARS = 4000;
const MAX_BODY_CHARS_LIMIT = 20000;
const MAX_SKILLS = 200;

/** 读功能级配置（已补默认值）。 */
export function markdownSkillsConfig() {
  const c = getConfig()?.markdownSkills || {};
  const items = c.items && typeof c.items === 'object' ? c.items : {};
  return {
    // 总开关，默认关 —— 与 owner-identity / account-pool 同一取舍：
    // 会改行为、需要先配置的功能不默认开。
    enabled: c.enabled === true,
    // 'prompt' = 索引写进系统提示词（随会话边界刷新，省一轮工具调用）
    // 'tool'   = 索引不写提示词，改由 list_skills 工具按需取（技能库很大时更省 token）
    indexMode: c.indexMode === 'tool' ? 'tool' : 'prompt',
    maxBodyChars: Math.min(MAX_BODY_CHARS_LIMIT, Math.max(200, Number(c.maxBodyChars) || DEFAULT_MAX_BODY_CHARS)),
    // 是否允许模型用 remember_skill 自己写技能（默认关，留待 L3 后台评审驱动）。
    allowAutoCreate: c.allowAutoCreate === true,
    items
  };
}

export function isMarkdownSkillsEnabled() {
  return markdownSkillsConfig().enabled;
}

export function isMarkdownAutoCreateAllowed() {
  const c = markdownSkillsConfig();
  return c.enabled && c.allowAutoCreate;
}

// ── frontmatter 解析（极简 YAML：key: value 一行一条，够用且零依赖）──

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function parseFrontmatter(raw) {
  const out = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** `triggers: a, b` 或 `triggers: [a, b]` 都支持。 */
function normalizeTriggers(v) {
  let s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s
    .split(/[,，]/)
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .slice(0, 20);
}

function parseSkillFile(file) {
  let text;
  try { text = stripBom(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const front = parseFrontmatter(m[1]);
  const body = String(m[2] || '').trim();
  const name = String(front.name || '').trim();
  const description = String(front.description || '').trim();
  // 至少要有一项可展示的元数据，否则索引里是一行空内容，没有意义。
  if (!name && !description) return null;
  return {
    name: name || path.basename(path.dirname(file)),
    description,
    triggers: normalizeTriggers(front.triggers),
    category: String(front.category || 'utility').trim() || 'utility',
    enabledInFile: front.enabled !== 'false' && front.enabled !== false,
    source: String(front.source || '').trim(),   // 'auto' 表示模型自动写的
    body
  };
}

// ── 扫描（带内存缓存；写入/删除后显式失效）──

let cache = null;

export function reloadMarkdownSkills() {
  cache = null;
  return listMarkdownSkills();
}

function scan() {
  if (cache) return cache;
  const out = [];
  const seen = new Set();
  for (const root of SCAN_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(root, ent.name);
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const parsed = parseSkillFile(file);
      if (!parsed) continue;
      if (seen.has(ent.name)) continue;
      seen.add(ent.name);
      out.push({
        ...parsed,
        id: ent.name,
        dir,
        relDir: path.relative(APP_ROOT, dir).replace(/\\/g, '/')
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  if (out.length > MAX_SKILLS) out.length = MAX_SKILLS;
  cache = out;
  return out;
}

// ── 命中统计 ──

function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function saveStats(stats) {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    const tmp = `${STATS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 1), 'utf8');
    fs.renameSync(tmp, STATS_FILE);
  } catch { /* 统计失败不影响主流程 */ }
}

/** 记一次"这个技能被加载了"（模型调 load_skill，或触发词命中自动追加）。 */
export function recordMarkdownSkillHit(id) {
  const key = String(id ?? '').trim();
  if (!key) return false;
  const stats = loadStats();
  const cur = stats[key] && typeof stats[key] === 'object' ? stats[key] : {};
  stats[key] = { hits: (Number(cur.hits) || 0) + 1, lastHitAt: Date.now() };
  saveStats(stats);
  return true;
}

/** 清空某技能的命中统计（删除技能时一并调）。 */
export function clearMarkdownSkillStats(id) {
  const key = String(id ?? '').trim();
  if (!key) return false;
  const stats = loadStats();
  if (!(key in stats)) return false;
  delete stats[key];
  saveStats(stats);
  return true;
}

// ── 对外读取 ──

/** 列出全部 Markdown 技能（含启用状态与命中统计，不含正文）。 */
export function listMarkdownSkills() {
  const cfg = markdownSkillsConfig();
  const stats = loadStats();
  return scan().map((s) => {
    const item = cfg.items[s.id];
    const enabled = item && item.enabled !== undefined ? item.enabled !== false : s.enabledInFile;
    const st = stats[s.id] && typeof stats[s.id] === 'object' ? stats[s.id] : {};
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      category: s.category,
      relDir: s.relDir,
      source: s.source === 'auto' ? 'auto' : 'manual',
      enabled,
      hits: Number(st.hits) || 0,
      lastHitAt: Number(st.lastHitAt) || 0,
      bodyChars: s.body.length
    };
  });
}

/** 取单个技能；withBody=true 时带正文。 */
export function getMarkdownSkill(id, { withBody = false } = {}) {
  const s = scan().find((x) => x.id === String(id ?? ''));
  if (!s) return null;
  const base = {
    id: s.id, name: s.name, description: s.description, triggers: s.triggers,
    category: s.category, relDir: s.relDir, bodyChars: s.body.length
  };
  return withBody ? { ...base, body: s.body } : base;
}

/** 当前**生效**的技能（总开关开 + 该技能未被单独关闭）。 */
export function activeMarkdownSkills() {
  if (!isMarkdownSkillsEnabled()) return [];
  return listMarkdownSkills().filter((s) => s.enabled);
}

// ── 提示词：稳定索引 ──

/**
 * 索引段（写进系统提示词）。空串表示不注入。
 * ⚠️ 必须**逐字节稳定**：只有 name + description，不含命中次数/时间这类每轮会变的东西。
 */
export function markdownSkillIndexText() {
  const cfg = markdownSkillsConfig();
  if (!cfg.enabled || cfg.indexMode !== 'prompt') return '';
  const list = activeMarkdownSkills();
  if (!list.length) return '';
  const lines = [
    '【可加载技能】',
    '下面这些技能**只在需要时才加载正文**：判断当前场景用得上时，用 load_skill 工具按名字取（不要凭名字猜内容）。'
  ];
  for (const s of list) {
    lines.push(`- ${s.name}${s.description ? `：${s.description}` : ''}`);
  }
  return lines.join('\n');
}

/** 把技能正文渲染成注入用的尾部消息。 */
export function renderMarkdownSkillBody(skill) {
  const cfg = markdownSkillsConfig();
  const body = String(skill?.body || '').trim().slice(0, cfg.maxBodyChars);
  return `【技能：${skill?.name || skill?.id || ''}】\n${body}`;
}

/** 触发词命中 → 返回命中的技能（带正文），最多 limit 个。 */
export function matchMarkdownSkills(text, { limit = 1 } = {}) {
  const cfg = markdownSkillsConfig();
  if (!cfg.enabled) return [];
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const hits = [];
  for (const s of activeMarkdownSkills()) {
    const full = getMarkdownSkill(s.id, { withBody: true });
    if (!full) continue;
    if (full.triggers.some((k) => k && t.includes(k))) hits.push(full);
    if (hits.length >= Math.max(1, limit)) break;
  }
  return hits;
}

// ── 写入 / 删除（remember_skill 工具、管理端）──

const ID_RE = /^[a-zA-Z0-9._-]{1,40}$/;

export function saveMarkdownSkill({ id, name, description, triggers = [], category = 'utility', body = '', source = '' }) {
  const sid = String(id ?? '').trim();
  if (!ID_RE.test(sid)) throw new Error('技能 id 只允许字母/数字/._-，且不超过 40 个字符');
  const dir = path.join(SKILLS_DIR, sid);
  // 目录必须锁在 skills/ 之内（防 ../ 逃逸）
  if (!path.resolve(dir).startsWith(path.resolve(SKILLS_DIR) + path.sep)) throw new Error('非法的技能 id');
  fs.mkdirSync(dir, { recursive: true });
  const list = Array.isArray(triggers) ? triggers.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [];
  const text = [
    '---',
    `name: ${String(name ?? '').trim() || sid}`,
    `description: ${String(description ?? '').trim()}`,
    `triggers: ${list.join(', ')}`,
    `category: ${String(category ?? 'utility').trim() || 'utility'}`,
    ...(source ? [`source: ${String(source).trim()}`] : []),
    '---',
    '',
    String(body ?? '').trim(),
    ''
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
  reloadMarkdownSkills();
  return getMarkdownSkill(sid, { withBody: true });
}

export function deleteMarkdownSkill(id) {
  const s = scan().find((x) => x.id === String(id ?? ''));
  if (!s) return false;
  try { fs.rmSync(path.join(s.dir, 'SKILL.md'), { force: true }); } catch { return false; }
  // 目录里若还有别的文件（scripts/ 之类）就保留，别把作者的东西一起删了。
  try {
    if (fs.readdirSync(s.dir).length === 0) fs.rmdirSync(s.dir);
  } catch { /* ignore */ }
  clearMarkdownSkillStats(s.id);
  reloadMarkdownSkills();
  return true;
}

/** 单个技能的开 / 关。 */
export function setMarkdownSkillEnabled(id, enabled) {
  const key = String(id ?? '').trim();
  if (!key) return false;
  const cfg = markdownSkillsConfig();
  const items = { ...cfg.items };
  items[key] = { ...(items[key] && typeof items[key] === 'object' ? items[key] : {}), enabled: !!enabled };
  updateConfig({ markdownSkills: { items } });
  return true;
}

/** 功能级设置（总开关 / 索引模式 / 正文字数上限 / 自动创建）。 */
export function updateMarkdownSkillsSettings(patch = {}) {
  const next = {};
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.indexMode !== undefined) next.indexMode = patch.indexMode === 'tool' ? 'tool' : 'prompt';
  if (patch.maxBodyChars !== undefined) {
    next.maxBodyChars = Math.min(MAX_BODY_CHARS_LIMIT, Math.max(200, Number(patch.maxBodyChars) || DEFAULT_MAX_BODY_CHARS));
  }
  if (patch.allowAutoCreate !== undefined) next.allowAutoCreate = !!patch.allowAutoCreate;
  if (!Object.keys(next).length) return markdownSkillsConfig();
  updateConfig({ markdownSkills: next });
  return markdownSkillsConfig();
}
