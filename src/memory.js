// 群友印象记忆：每个会话一个文件夹，每个群友一个以 QQ 号命名的 JSON 文件。
// 目录结构：
//   data/memory/group_<群号>/<QQ>.json
//   data/memory/private_<QQ>/<QQ>.json
// 每个成员文件：{ userId, name, impressions: [{ content, createdAt }], updatedAt, lastConsolidatedAt }
// 旧版单文件 data/memory/group_<群号>.json 会在首次访问时自动迁移。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function legacyFile(chatKey) {
  return path.join(MEMORY_DIR, `${chatDirName(chatKey)}.json`);
}

function chatDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

// 自身记忆（2026-10-03 ②P2）：机器人自己跨会话要记住的私有状态
// （未完成的目标、自己定下的规则、暗牌答案、待办）。与群友印象分开存，
// 不参与成员合并/整理，每会话一个小文件。
function selfFile(chatKey) {
  return path.join(chatDir(chatKey), '_self.json');
}

// 自身记忆的**回收站**（L4b）：淘汰不真删，落这里，管理端可查看与恢复。
// ⚠️ 与 _self.json / _meta.json 一样，必须在扫描成员文件时跳过（见 #ensureChat）。
function selfEvictedFile(chatKey) {
  return path.join(chatDir(chatKey), '_evicted.json');
}

// 回收站上限（条）。它只是"误删保险"，不是第二份全量存储 —— 不设限会换一种方式膨胀。
const SELF_EVICTED_KEEP = 200;
// 自身记忆的默认半衰期（天）：权重每过这么久衰减一半。
const SELF_HALF_LIFE_DAYS = 30;

function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function memberFile(chatKey, userId, name = '') {
  return path.join(chatDir(chatKey), memberFileName(userId, name));
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读自身记忆（数组：{ content, createdAt, kind, score, lastHitAt }）。损坏/不存在 → []。 */
function loadSelf(chatKey) {
  const raw = readJson(selfFile(chatKey), null);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e.content === 'string' && e.content.trim())
    .map((e) => ({
      content: String(e.content).slice(0, 400),
      createdAt: Number(e.createdAt) || 0,
      // 旧数据没有这几个字段 → 补默认值（kind=state、score=1），无需迁移脚本。
      kind: e.kind === 'rule' ? 'rule' : 'state',
      score: Number(e.score) > 0 ? Number(e.score) : 1,
      lastHitAt: Number(e.lastHitAt) || 0
    }));
}

/**
 * 自身记忆的**初始权重**：按来源给分，让"重要的纠正"不容易被淘汰。
 *   kind='rule'（纠正/规则）× 主人触发 → 5
 *   kind='rule' × 普通群友              → 2
 *   kind='state'（普通状态）× 主人触发   → 3
 *   kind='state' × 自身蒸馏/主动记录     → 1
 * ownerActive 由 owner-identity 技能判定；该技能默认关，判定不到时按 false（降级）。
 */
export function initialSelfScore({ kind = 'state', ownerActive = false } = {}) {
  if (kind === 'rule') return ownerActive ? 5 : 2;
  return ownerActive ? 3 : 1;
}

/**
 * 有效权重 = 初始权重 × 时间衰减（半衰期）。
 * 读时计算、不写盘 —— 避免"每读一次改一次文件"的写放大，也不需要迁移旧数据。
 */
export function effectiveSelfScore(entry, now = Date.now(), halfLifeDays = SELF_HALF_LIFE_DAYS) {
  const base = Number(entry?.score);
  const score = base > 0 ? base : 1;
  const last = Number(entry?.lastHitAt) || Number(entry?.createdAt) || now;
  const ageDays = Math.max(0, (now - last) / 86400000);
  const hl = Math.max(0.5, Number(halfLifeDays) || SELF_HALF_LIFE_DAYS);
  return score * Math.pow(0.5, ageDays / hl);
}

function loadMember(chatKey, userId, name = '') {
  const file = memberFile(chatKey, userId, name);
  const raw = readJson(file, null);
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    impressions: Array.isArray(raw?.impressions) ? raw.impressions : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0
  };
}

function loadMeta(chatKey) {
  const raw = readJson(metaFile(chatKey), null);
  return { lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0 };
}

export class MemoryStore {
  constructor() {
    this.cache = new Map(); // chatKey -> Map(userId|_n_xx, member)
  }

  /** 扫描所有有记忆的会话（文件夹或旧版单文件）。 */
  listChats() {
    const out = new Set();
    try {
      for (const f of fs.readdirSync(MEMORY_DIR)) {
        if (fs.statSync(path.join(MEMORY_DIR, f)).isDirectory()) {
          const m = /^(group|private)_(\d+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        } else {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  /** 旧版单文件 → 新版每成员文件。迁移后旧文件移到 backups/。 */
  #migrateLegacy(chatKey) {
    const legacy = legacyFile(chatKey);
    if (!fs.existsSync(legacy)) return;
    try {
      if (fs.statSync(legacy).isDirectory()) return;
      const old = readJson(legacy, null);
      if (!old) return;
      const notes = getConfig().memberNotes || {};
      const nameToQq = {};
      for (const [qq, name] of Object.entries(notes)) {
        if (name) nameToQq[String(name)] = String(qq);
      }
      const migrated = [];
      for (const e of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
        if (!e?.content) continue;
        const target = String(e.target || '').trim();
        let userId = /^\d{5,15}$/.test(target) ? target : (nameToQq[target] || '');
        migrated.push({
          userId,
          name: target,
          content: String(e.content).slice(0, 300),
          createdAt: Number(e.createdAt) || Date.now()
        });
      }
      // 旧的 activeTopic/pendingThought 直接丢弃（本版只保留群友印象）
      for (const m of migrated) this.#appendRaw(chatKey, m.userId, m.name, m.content, m.createdAt);
      const backupDir = path.join(MEMORY_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, path.basename(legacy));
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(legacy, backup);
    } catch (error) {
      console.error('[memory] 旧记忆迁移失败:', error?.message ?? error);
    }
  }

  #ensureChat(chatKey) {
    this.#migrateLegacy(chatKey);
    if (!this.cache.has(chatKey)) {
      const map = new Map();
      try {
        for (const f of fs.readdirSync(chatDir(chatKey))) {
          // _meta / _self / _evicted 是会话级元数据，不是"群友印象"文件，必须跳过。
          if (!f.endsWith('.json') || f === '_meta.json' || f === '_self.json' || f === '_evicted.json') continue;
          const raw = readJson(path.join(chatDir(chatKey), f), null);
          if (!raw) continue;
          const key = raw.userId ? String(raw.userId) : `_n_${f}`;
          map.set(key, loadMember(chatKey, raw.userId, raw.name));
        }
      } catch { /* 尚无文件夹 */ }
      this.#mergeNameDuplicates(chatKey, map);
      this.cache.set(chatKey, map);
    }
    return this.cache.get(chatKey);
  }

  /**
   * 合并"同一个人被存成两份"的历史数据。
   *
   * 背景：早期没有 QQ 号时会按名字落文件（_n_xxx.json）。后来拿到 QQ 号再次写入时，
   * 会新建 <QQ>.json，但旧的 _n_ 文件不会被清理 → 同一个人在记忆里出现两次，
   * 印象重复、整理时互相干扰，也让"印象总数"虚高。
   *
   * 规则：无 QQ 号的条目，只要有同名（且该名字对应的条目有 QQ 号），
   * 就把它的印象并入该 QQ 号条目，然后删除 _n_ 文件。
   */
  #mergeNameDuplicates(chatKey, map) {
    const nameToId = new Map();
    for (const m of map.values()) {
      const uid = String(m.userId || '').trim();
      const nm = String(m.name || '').trim();
      if (uid && nm) nameToId.set(nm, uid);
    }
    const toDelete = [];
    for (const [key, m] of map.entries()) {
      const uid = String(m.userId || '').trim();
      if (uid) continue;                       // 已有 QQ 号，不是兜底条目
      const nm = String(m.name || '').trim();
      const targetId = nameToId.get(nm);
      if (!targetId) continue;
      const target = map.get(targetId);
      if (!target) continue;

      const seen = new Set(target.impressions.map((e) => e.content));
      let added = 0;
      for (const e of m.impressions) {
        if (seen.has(e.content)) continue;
        seen.add(e.content);
        target.impressions.push({ ...e });
        added += 1;
      }
      if (added) {
        target.impressions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(m.updatedAt) || 0);
        writeJson(memberFile(chatKey, targetId, target.name), target);
      }
      // 删除已被并入的兜底文件
      try { fs.rmSync(memberFile(chatKey, '', nm), { force: true }); } catch { /* ignore */ }
      toDelete.push(key);
      console.log(`[memory] 合并重复记忆：${nm}（无 QQ 号）→ ${targetId}，并入 ${added} 条`);
    }
    for (const k of toDelete) map.delete(k);
  }

  #appendRaw(chatKey, userId, name, content, createdAt = Date.now()) {
    const map = this.#ensureChat(chatKey);
    const key = userId ? String(userId) : `_n_${memberFileName('', name)}`;
    const member = map.get(key) || loadMember(chatKey, userId, name);
    const entry = {
      content: String(content ?? '').slice(0, 300),
      createdAt: Number(createdAt) || Date.now()
    };
    if (!member.impressions.some((e) => e.content === entry.content)) {
      member.impressions.push(entry);
    }
    member.userId = String(userId ?? member.userId ?? '');
    member.name = String(name || member.name || '');
    member.updatedAt = Date.now();
    writeJson(memberFile(chatKey, userId, name), member);
    map.set(key, member);
    return entry;
  }

  /** 记一条对群友的印象。extra: { userId, target } */
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId ?? '').trim();
    const target = String(extra.target ?? '').trim().slice(0, 60);
    if (!userId && !target) return null;
    return this.#appendRaw(chatKey, userId, target || userId, content);
  }

  /** 所有成员的印象（扁平列表，兼容旧消费方）。 */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const map = this.#ensureChat(chatKey);
    const memberImpression = [];
    for (const m of map.values()) {
      for (const e of m.impressions) {
        memberImpression.push({
          userId: String(m.userId || ''),
          target: String(m.name || m.userId || '某人'),
          content: e.content,
          createdAt: e.createdAt
        });
      }
    }
    memberImpression.sort((a, b) => b.createdAt - a.createdAt);
    return { memberImpression };
  }

  /** 成员级视图（记忆页签用）。 */
  members(chatKey) {
    const map = this.#ensureChat(chatKey);
    const list = [];
    for (const m of map.values()) {
      if (!m.impressions.length) continue;
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 单个成员的印象（含空成员）。 */
  getMember(chatKey, userId) {
    const map = this.#ensureChat(chatKey);
    const m = map.get(String(userId)) || loadMember(chatKey, String(userId));
    return {
      userId: String(m.userId || userId || ''),
      name: String(m.name || ''),
      impressions: (m.impressions || []).map((e) => ({ ...e })),
      updatedAt: Number(m.updatedAt) || 0
    };
  }

  /** 编辑群友印象（管理端）：QQ 号由调用方提供，自动回填名字，保存备注到配置。 */
  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    const entries = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const member = {
      userId: uid,
      name: finalName,
      impressions: entries,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    // 备注写入配置 memberNotes
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt,
      note: String(note ?? '').trim()
    };
  }

  /** 手动替换某成员的全部印象（管理端编辑用）。返回更新后的成员。 */
  replaceMember(chatKey, userId, name, contents) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const member = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    // 单个成员替换也备份原文件（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt
    };
  }

  /** 删除某成员的印象文件。 */
  removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    const map = this.#ensureChat(chatKey);
    const m = map.get(uid) || loadMember(chatKey, uid);
    map.delete(uid);
    try { fs.rmSync(memberFile(chatKey, uid, m.name), { force: true }); } catch { /* ignore */ }
    return true;
  }

  /**
   * 删除一个会话的**全部**记忆（记忆页「删除本会话记忆」按钮）。
   * 成员文件、_meta.json、旧版单文件与备份一并清掉；目录本身保留
   * （可能是挂载点/被占用，删不掉也无妨——里面已空）。
   * @returns {boolean} 是否删掉了东西
   */
  removeChat(chatKey) {
    const dir = chatDir(chatKey);
    let removed = false;
    try {
      for (const f of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        removed = true;
      }
    } catch { /* 目录不存在 = 没有记忆可删 */ }
    // 旧版单文件（迁移前的形态）
    try { fs.rmSync(legacyFile(chatKey), { force: true }); removed = true; } catch { /* ignore */ }
    // 内存缓存同步清掉，否则同进程内 members() 还能读到旧数据
    this.#ensureChat(chatKey).clear();
    return removed;
  }

  remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;
    const map = this.#ensureChat(chatKey);
    let removed = false;
    for (const [key, m] of [...map.entries()]) {
      if (userId) {
        if (String(m.userId) === String(userId)) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      } else if (target) {
        const matchName = String(target).trim();
        if (String(m.name || m.userId) === matchName) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      }
    }
    return removed;
  }

  clear(chatKey) {
    const map = this.#ensureChat(chatKey);
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    writeJson(metaFile(chatKey), { lastConsolidatedAt: Date.now() });
  }

  /**
   * 生成提示词里的【对群友的印象】摘要。
   * opts.userIds 提供时只包含这些成员（相关成员注入，控制 token）。
   */
  formatForPrompt(chatKey, { userIds = null } = {}) {
    const notes = getConfig().memberNotes || {};
    const all = this.members(chatKey);
    if (!all.length) return '';
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))  // 无 QQ 号的旧数据始终带上
      : all.slice(0, 15);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      for (const e of m.impressions.slice(-3)) lines.push(`- ${who}：${e.content}`);
    }
    return lines.join('\n');
  }

  // ── 自身记忆（selfNote，2026-10-03 ②P2）──────────────────────────────
  // 与群友印象分开：这是"机器人自己的状态"，不按成员归属，也不参与整理合并。
  // 出口有两个：① 模型主动调 remember_self 工具；② 会话关闭时由蒸馏自动写入。

  /**
   * 追加一条自身记忆。同样内容（去重后）不重复写。
   * @param {object} [opts]
   * @param {number}  [opts.max]         条目上限（默认 40）
   * @param {'state'|'rule'} [opts.kind]  'rule' = 纠正/规则（权重更高）
   * @param {boolean} [opts.ownerActive]  本次是否由主人触发（决定初始权重）
   * @param {number}  [opts.score]        显式指定初始权重（给了就不再按 kind 推算）
   * @param {number}  [opts.halfLifeDays] 衰减半衰期（天）
   * @returns {{content:string, createdAt:number, kind:string, score:number}|null}
   */
  appendSelf(chatKey, content, { max = 40, kind = 'state', ownerActive = false, score, halfLifeDays } = {}) {
    const text = String(content ?? '').trim().slice(0, 400);
    if (!text) return null;
    const list = loadSelf(chatKey);
    const dup = list.find((e) => e.content === text);
    if (dup) return dup;
    const entry = {
      content: text,
      createdAt: Date.now(),
      kind: kind === 'rule' ? 'rule' : 'state',
      score: Number(score) > 0 ? Number(score) : initialSelfScore({ kind, ownerActive }),
      lastHitAt: 0
    };
    list.push(entry);
    // 超上限时按**有效权重**升序淘汰（同分先淘汰更旧的），而不是纯 FIFO ——
    // 否则"主人明确纠正过"的条目会仅仅因为来得早而被后来的普通状态挤掉。
    // 被淘汰的不真删，进回收站，管理端可查看与恢复。
    const kept = list.length > max ? this.#evictLowestSelf(chatKey, list, max, halfLifeDays) : list;
    try { writeJson(selfFile(chatKey), kept); } catch (error) {
      console.warn('[memory] 写自身记忆失败:', error?.message ?? error);
    }
    return entry;
  }

  /** 按有效权重保留前 max 条，其余写进回收站。返回保留后的数组。 */
  #evictLowestSelf(chatKey, list, max, halfLifeDays) {
    const now = Date.now();
    const ranked = list
      .map((e) => ({ e, s: effectiveSelfScore(e, now, halfLifeDays) }))
      .sort((a, b) => (a.s !== b.s ? a.s - b.s : (a.e.createdAt || 0) - (b.e.createdAt || 0)));
    const dropCount = Math.max(0, ranked.length - max);
    const dropped = ranked.slice(0, dropCount).map((x) => x.e);
    const kept = ranked.slice(dropCount).map((x) => x.e);
    this.#pushEvictedSelf(chatKey, dropped);
    return kept;
  }

  /** 把淘汰的自身记忆追加进回收站（保留最近 SELF_EVICTED_KEEP 条）。 */
  #pushEvictedSelf(chatKey, entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    try {
      const prev = readJson(selfEvictedFile(chatKey), null);
      const list = Array.isArray(prev) ? prev : [];
      const now = Date.now();
      for (const e of entries) {
        list.push({
          content: String(e.content ?? '').slice(0, 400),
          kind: e.kind === 'rule' ? 'rule' : 'state',
          score: Number(e.score) || 1,
          createdAt: Number(e.createdAt) || 0,
          evictedAt: now
        });
      }
      writeJson(selfEvictedFile(chatKey), list.slice(-SELF_EVICTED_KEEP));
    } catch (error) {
      console.warn('[memory] 写自身记忆回收站失败:', error?.message ?? error);
    }
  }

  /** 读全部自身记忆（新的在前）。 */
  selfNotes(chatKey) {
    return loadSelf(chatKey).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 是否已有自身记忆（用于"蒸馏前先看有没有值得写的"这类判断）。 */
  hasSelf(chatKey) {
    return loadSelf(chatKey).length > 0;
  }

  /** 清空某会话的自身记忆（随 removeChat 一起清；也可单独调）。回收站不受影响。 */
  clearSelf(chatKey) {
    try { fs.rmSync(selfFile(chatKey), { force: true }); return true; } catch { return false; }
  }

  /** 回收站：被淘汰的自身记忆（按淘汰时间倒序）。 */
  evictedSelf(chatKey) {
    const raw = readJson(selfEvictedFile(chatKey), null);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e && typeof e.content === 'string' && e.content.trim())
      .map((e) => ({
        content: String(e.content).slice(0, 400),
        kind: e.kind === 'rule' ? 'rule' : 'state',
        score: Number(e.score) || 1,
        createdAt: Number(e.createdAt) || 0,
        evictedAt: Number(e.evictedAt) || 0
      }))
      .sort((a, b) => (b.evictedAt || 0) - (a.evictedAt || 0));
  }

  /**
   * 从回收站恢复一条（按内容匹配，取最近淘汰的那条）。恢复后回到 `_self.json`，
   * 权重沿用原值 —— 不因"被淘汰过"而永久降权。
   * @returns {{content:string, createdAt:number}|null}
   */
  restoreSelf(chatKey, content) {
    const text = String(content ?? '').trim();
    if (!text) return null;
    const raw = readJson(selfEvictedFile(chatKey), null);
    const list = Array.isArray(raw) ? raw : [];
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (String(list[i]?.content ?? '').trim() === text) { idx = i; break; }
    }
    if (idx < 0) return null;
    const item = list[idx];
    list.splice(idx, 1);
    try { writeJson(selfEvictedFile(chatKey), list); } catch { /* ignore */ }
    return this.appendSelf(chatKey, item.content, { kind: item.kind, score: item.score });
  }

  /** 清空回收站。 */
  clearEvictedSelf(chatKey) {
    try { fs.rmSync(selfEvictedFile(chatKey), { force: true }); return true; } catch { return false; }
  }

  /**
   * 渲染【自身状态】段（供提示词注入 —— 与【记忆】同属易变区，别放稳定前缀）。
   * 返回 '' 表示没有可注入的内容。
   *
   * ⚠️ 取的是**有效权重最高的前 limit 条**，不是"最近 limit 条"。存储上限（40）
   * 远大于注入窗口（limit=10），只按时间取会让"重要但来得早"的纠正**还没被淘汰
   * 就先不被注入**（等于白记）—— 这是权重机制里最关键的一环。
   */
  formatSelfForPrompt(chatKey, { limit = 10, halfLifeDays } = {}) {
    const list = loadSelf(chatKey);
    if (!list.length) return '';
    const now = Date.now();
    const picked = list
      .map((e) => ({ e, s: effectiveSelfScore(e, now, halfLifeDays) }))
      .sort((a, b) => (b.s !== a.s ? b.s - a.s : (b.e.createdAt || 0) - (a.e.createdAt || 0)))
      .slice(0, Math.max(1, Number(limit) || 10))
      .map((x) => x.e)
      // 注入顺序回到时间升序：读起来自然，且与旧行为一致（只改了"选哪几条"）。
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lines = ['【自身状态】以下是你自己需要跨轮保留的事（未完成的目标、自己定的规则、待办、答案等）：'];
    for (const e of picked) lines.push(`- ${e.content}`);
    return lines.join('\n');
  }

  // ── 自动整理（consolidation）──

  consolidationState(chatKey) {
    const map = this.#ensureChat(chatKey);
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of map.values()) {
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt: loadMeta(chatKey).lastConsolidatedAt || lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  /**
   * 记录一次整理完成的时间。
   * 同时写会话级 _meta.json（供冷却判断）与各成员文件的 lastConsolidatedAt。
   * userIds 为空时只更新会话级时间。
   */
  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    try {
      fs.mkdirSync(chatDir(chatKey), { recursive: true });
      const prev = readJson(metaFile(chatKey), {}) || {};
      writeJson(metaFile(chatKey), { ...prev, lastConsolidatedAt: Number(at) || Date.now() });
    } catch (error) {
      console.warn('[memory] 写整理时间失败:', error?.message ?? error);
    }
    const map = this.#ensureChat(chatKey);
    for (const uid of userIds || []) {
      const key = String(uid ?? '').trim();
      if (!key) continue;
      const m = map.get(key);
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(memberFile(chatKey, m.userId, m.name), m); } catch { /* ignore */ }
    }
  }

  /**
   * 用整理结果整体替换本会话的印象（按成员写回各自文件）。
   * next.memberImpression: [{ userId?, target?, content }]
   */
  replaceConsolidated(chatKey, next) {
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    const groups = new Map(); // key -> { userId, name, contents }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const content = cut(item?.content, 300);
      if (!content) continue;
      const userId = cut(item?.userId, 40) || '';
      const name = cut(item?.target, 60) || userId;
      const key = userId || `_n_${memberFileName('', name)}`;
      if (!groups.has(key)) groups.set(key, { userId, name, contents: [] });
      groups.get(key).contents.push(content);
    }
    const map = this.#ensureChat(chatKey);
    // 整理前把整个会话文件夹备份到 data/memory/backups/<会话>/（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.mkdirSync(backupDir, { recursive: true });
      for (const m of map.values()) {
        const src = memberFile(chatKey, m.userId, m.name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
      }
      const metaSrc = metaFile(chatKey);
      if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, path.join(backupDir, '_meta.json'));
    } catch { /* 备份失败不阻塞整理 */ }
    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    for (const g of groups.values()) {
      for (const content of g.contents) {
        this.#appendRaw(chatKey, g.userId, g.name, content, now);
      }
      const file = memberFile(chatKey, g.userId, g.name);
      const member = loadMember(chatKey, g.userId, g.name);
      member.lastConsolidatedAt = now;
      member.updatedAt = now;
      writeJson(file, member);
      map.set(g.userId || `_n_${memberFileName('', g.name)}`, member);
    }
    writeJson(metaFile(chatKey), { lastConsolidatedAt: now });
    const totalAfter = [...map.values()].reduce((n, m) => n + m.impressions.length, 0);
    return { memberImpression: groups.size ? this.query(chatKey).memberImpression : [], count: totalAfter };
  }
}
