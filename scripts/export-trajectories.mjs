// 导出会话归档为训练数据（L5）。
//
// 用法：
//   node scripts/export-trajectories.mjs
//   node scripts/export-trajectories.mjs --format openai --limit 200
//   node scripts/export-trajectories.mjs --chat group_1098345913 --out data/exports/mine.jsonl
//   node scripts/export-trajectories.mjs --no-redact        # ⚠️ 会写入真实 QQ 号/群号，慎用
//
// 选项：
//   --out <file>      输出文件（默认 data/exports/trajectories-<时间戳>.jsonl）
//   --format <f>      sharegpt（默认）| openai
//   --chat <key>      只导出某个会话（如 group_123456 / private_10001）
//   --limit <n>       只取最近 n 份归档
//   --no-system       不带系统提示词（默认带）
//   --with-tools      保留工具调用/结果的痕迹（默认不保留）
//   --no-redact       关闭脱敏（默认脱敏 QQ 号 / 群号）
//   --help

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../src/config.js';
import { exportTrajectories } from '../src/trajectory-export.js';

const ARCHIVE_DIR = path.join(DATA_DIR, 'conversations', 'archive');

function parseArgs(argv) {
  const out = {
    out: '', format: 'sharegpt', chat: '', limit: 0,
    includeSystem: true, includeTools: false, redact: true, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--out') out.out = String(argv[++i] ?? '');
    else if (a === '--format') out.format = String(argv[++i] ?? 'sharegpt');
    else if (a === '--chat') out.chat = String(argv[++i] ?? '');
    else if (a === '--limit') out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--no-system') out.includeSystem = false;
    else if (a === '--with-tools') out.includeTools = true;
    else if (a === '--no-redact') out.redact = false;
  }
  if (out.format !== 'openai') out.format = 'sharegpt';
  return out;
}

const HELP = `导出会话归档为训练数据（JSONL）

  --out <file>     输出文件（默认 data/exports/trajectories-<时间戳>.jsonl）
  --format <f>     sharegpt（默认）| openai
  --chat <key>     只导出某个会话（如 group_123456 / private_10001）
  --limit <n>      只取最近 n 份归档
  --no-system      不带系统提示词（默认带）
  --with-tools     保留工具调用/结果的痕迹（默认不保留）
  --no-redact      关闭脱敏（默认脱敏 QQ 号 / 群号）

归档目录：${ARCHIVE_DIR}
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = args.out
  ? path.resolve(args.out)
  : path.join(DATA_DIR, 'exports', `trajectories-${stamp}.jsonl`);

try {
  const r = exportTrajectories({
    archivesDir: ARCHIVE_DIR,
    outFile,
    format: args.format,
    chat: args.chat,
    limit: args.limit,
    includeSystem: args.includeSystem,
    includeTools: args.includeTools,
    redact: args.redact
  });
  console.log(`扫描归档：${r.archives} 份`);
  console.log(`产出样本：${r.count} 条（format=${args.format}${args.redact ? '，已脱敏' : '，⚠️ 未脱敏'}）`);
  console.log(`输出文件：${r.outFile}`);
  if (!r.count) {
    console.log('\n没有产出样本。常见原因：归档目录为空、或归档里没有"一问一答"（只有工具调用）。');
  } else {
    console.log('\n提醒：群聊噪声大，直接用会学到坏模式 —— 建议先人工筛选「好的回复」，');
    console.log('      也可以先从中挑几条做 few-shot 示例放进提示词（比微调便宜得多）。');
  }
} catch (error) {
  console.error(`导出失败：${error?.message ?? error}`);
  process.exit(1);
}
