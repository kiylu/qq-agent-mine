// 轨迹导出（L5）：把会话归档转成训练数据（ShareGPT / OpenAI messages）。
//
// ── 为什么要这个 ────────────────────────────────────────────────────────
// 本项目的人设目前**全靠提示词**（实测提示词约 12256 字符/轮）。攒够高质量样本后，
// 可以把"怎么说话"内化进模型权重 —— 省掉一大块固定前缀（对高频群聊是真金白银），
// 人设也更稳、不被长上下文稀释。
//
// ⚠️ 微调学到的是**风格**，不是记忆 —— 它不会让机器人记住群友，那仍靠 memory 系统。
// ⚠️ **隐私是最大风险**：群聊归档里有真实 QQ 号 / 群号 / 人名。
//    默认 `redact: true` 脱敏；要原始数据必须显式关掉。
// ⚠️ 群聊噪声大（灌水 / @ / 表情），直接拿去训会学到坏模式 ——
//    导出只是第一步，真要用还得人工筛选"好的回复"。
//
// 建议路径：先导出 → 先从中精选 few-shot 示例放进提示词（便宜、随时可改）
//          → 人设定稿、few-shot 不够用了，再考虑微调。

import fs from 'node:fs';
import path from 'node:path';

// QQ 号 / 群号常见是 5~12 位数字。
const NUM_RE = /\b\d{5,12}\b/g;

/** 脱敏：QQ 号、群号、`#消息id` 一类数字统一替换。 */
export function redactText(text) {
  return String(text ?? '')
    .replace(/QQ[:：]\s*\d{5,12}/g, 'QQ:<id>')
    .replace(/(group|private)[:_]\d{5,12}/g, '$1:<id>')
    .replace(NUM_RE, '<num>');
}

/**
 * 从工具调用里取出机器人**实际说出口的话**。
 *
 * 为什么需要：本项目的设定是"所有行为都通过工具完成"，机器人发言走 `send_message`
 * （要发到别的会话则 `send_to`），文本在 `tool_calls[].function.arguments.messages` 里，
 * 而 `assistant.content` 通常是空的。只读 content 会导出成"群友说了一堆、机器人一个字没说"，
 * 这种样本没有训练价值。
 *
 * 分条发送的（messages 是数组）用换行拼回去，保留"一句话一条"的节奏。
 */
export function extractSaidText(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  const out = [];
  for (const c of toolCalls) {
    const name = c?.function?.name;
    if (name !== 'send_message' && name !== 'send_to') continue;
    let args = c?.function?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { continue; }
    }
    const raw = args?.messages ?? args?.message ?? args?.text;
    if (Array.isArray(raw)) {
      for (const x of raw) {
        const t = String(x ?? '').trim();
        if (t) out.push(t);
      }
    } else if (typeof raw === 'string' && raw.trim()) {
      out.push(raw.trim());
    }
  }
  return out.join('\n');
}

/** content 可能是字符串，也可能是 parts 数组（文本 + 图片/视频）。 */
export function flattenContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (typeof p?.text === 'string' && p.text.trim()) parts.push(p.text.trim());
    else if (p?.type === 'image_url') parts.push('[图片]');
    else if (p?.type === 'video_url') parts.push('[视频]');
  }
  return parts.join('\n');
}

/**
 * 把一个归档转成样本数组（一条归档通常产出 0 或 1 个样本）。
 *
 * @param {object} archive 会话归档（含 messages / systemPrompt）
 * @param {object} [opts]
 * @param {'sharegpt'|'openai'} [opts.format]
 * @param {boolean} [opts.includeSystem] 是否带上系统提示词
 * @param {boolean} [opts.includeTools]  是否保留工具调用/结果的痕迹（默认否）
 * @param {boolean} [opts.redact]        是否脱敏（默认是）
 * @returns {Array<object>}
 */
export function archiveToSamples(archive, {
  format = 'sharegpt', includeSystem = true, includeTools = false, redact = true
} = {}) {
  const msgs = Array.isArray(archive?.messages) ? archive.messages : [];
  const sys = [];
  const turn = [];

  // ⚠️ 归档里的 systemPrompt 是**独立字段** —— conversation.js 存缓冲时把 system
  //    从 messages 里剥掉了（`messages` 是不含 system 的序列）。所以这里优先取字段，
  //    再兜底扫 messages 里可能存在的 system 条目。
  const sysField = typeof archive?.systemPrompt === 'string' ? archive.systemPrompt.trim() : '';
  if (sysField) sys.push(sysField);

  for (const m of msgs) {
    const role = m?.role;
    if (role === 'system') {
      const t = flattenContent(m.content);
      if (t) sys.push(t);
      continue;
    }
    if (role === 'user') {
      const t = flattenContent(m.content);
      if (t) turn.push({ role: 'user', content: t });
      continue;
    }
    if (role === 'assistant') {
      const t = flattenContent(m.content);
      if (t) { turn.push({ role: 'assistant', content: t }); continue; }
      // content 为空 → 从工具调用里捞真实发言（本项目发言走 send_message）。
      const said = extractSaidText(m.tool_calls);
      if (said) { turn.push({ role: 'assistant', content: said }); continue; }
      // 只调工具、确实没说话（如 web_search / 收藏表情）—— 训练样本里没有可学的话。
      if (includeTools && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const names = m.tool_calls.map((c) => c?.function?.name).filter(Boolean).join(', ');
        turn.push({ role: 'assistant', content: `[工具调用] ${names}` });
      }
      continue;
    }
    if (role === 'tool' && includeTools) {
      const t = flattenContent(m.content);
      if (t) turn.push({ role: 'tool', content: t.slice(0, 500) });
    }
  }

  // 归档可能从半截对话开始（缓冲是"沉默为界"切出来的）→ 丢掉开头没有 user 的部分。
  while (turn.length && turn[0].role !== 'user') turn.shift();

  // 至少要有一问一答，否则没有训练价值。
  if (!turn.some((x) => x.role === 'user') || !turn.some((x) => x.role === 'assistant')) return [];

  const fin = (s) => (redact ? redactText(s) : s);
  const systemText = includeSystem && sys.length ? fin(sys[0]) : '';

  if (format === 'openai') {
    const messages = [];
    if (systemText) messages.push({ role: 'system', content: systemText });
    for (const t of turn) messages.push({ role: t.role, content: fin(t.content) });
    return [{ messages }];
  }

  const conversations = turn.map((t) => ({
    from: t.role === 'assistant' ? 'gpt' : 'human',
    value: fin(t.content)
  }));
  const out = { conversations };
  if (systemText) out.system = systemText;
  return [out];
}

/** 读归档目录（按关闭时间升序）。chat 非空时只取该会话的归档。 */
export function loadArchives({ dir, chat = '', limit = 0 } = {}) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    if (chat && !f.startsWith(`${chat}.`)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.messages)) out.push({ file: f, ...raw });
    } catch { /* 单份读坏跳过 */ }
  }
  out.sort((a, b) => (Number(a.closedAt) || 0) - (Number(b.closedAt) || 0));
  if (limit > 0) return out.slice(-limit);
  return out;
}

/** 导出到 JSONL 文件。返回 { count, archives, outFile }。 */
export function exportTrajectories({
  archivesDir, outFile, format = 'sharegpt', chat = '', limit = 0,
  includeSystem = true, includeTools = false, redact = true
} = {}) {
  if (!archivesDir || !outFile) throw new Error('archivesDir / outFile 必填');
  const archives = loadArchives({ dir: archivesDir, chat, limit });
  const lines = [];
  for (const a of archives) {
    for (const s of archiveToSamples(a, { format, includeSystem, includeTools, redact })) {
      lines.push(JSON.stringify(s));
    }
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return { count: lines.length, archives: archives.length, outFile };
}
