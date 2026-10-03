// 技能缓存影响体检自测（2026-10-03）
//
// 背景：会话从"每轮新开"改为"每轮延续"后，外部 Skill/Plugin 有两个容易踩的坑：
//   · promptSections(context) 每轮内容不同 → systemPrompt 逐字节不等 → 会话 fresh
//   · before-llm-messages 改写既有 system 消息 → 击穿前缀缓存，且**不**触发 fresh
// manager.cacheImpactOf() 用确定性探测把这两类实现特征识别出来。
//
// 本测试用三个"探针技能"验证检测逻辑本身正确（不依赖真实 Skill）：
//   1. push 式 hook          → level=warn（pushOnlyHook）
//   2. 改写 system 的 hook   → level=danger（systemRewriteHook）
//   3. 动态 promptSections   → level=danger（dynamicSections）
//   4. 静态实现              → level=ok
//   5. available() 抖动      → level=warn（unstableAvailable）
//   6. 异步 hook             → 不误判，提示人工确认
//   7. onlyActive 过滤与 report 汇总
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-cache-impact-'));

let pass = 0, fail = 0;
function ok(name, extra = '') {
  pass++;
  console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`);
}
function bad(name, error) {
  fail++;
  console.log(`  ✗ ${name}\n      ${error?.stack || error}`);
}

async function check(name, fn) {
  try { await fn(); ok(name); } catch (error) { bad(name, error); }
}

async function main() {
  const { SkillManager } = await import('../src/skills/manager.js');
  const { normalizeManifest } = await import('../src/skills/manifest.js');

  const mk = (id, extra = {}) => ({
    manifest: normalizeManifest({ id, name: id, enabledByDefault: true }).manifest,
    ...extra
  });

  console.log('\n=== 技能缓存影响体检 ===\n');

  // ── 1. push 式 hook：只新增消息，不改既有 system ────────────────────────
  await check('push 式 before-llm-messages：识别为 warn（pushOnlyHook）', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('push-hook', {
      hooks: {
        'before-llm-messages': ({ messages }) => {
          messages.push({ role: 'system', content: '【脑内闪过】新知识' });
        }
      }
    }));
    const r = await mgr.cacheImpactOf('push-hook', {});
    assert.equal(r.pushOnlyHook, true, '应识别为 push 式');
    assert.equal(r.systemRewriteHook, false, '不应误判为改写');
    assert.equal(r.level, 'warn');
  });

  // ── 2. 改写既有 system：最阴险的一类 ───────────────────────────────────
  await check('改写 system 的 hook：识别为 danger（systemRewriteHook）', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('rewrite-hook', {
      hooks: {
        'before-llm-messages': ({ messages }) => {
          // 经典错误写法：把跨轮记忆追加到既有 system content 尾部
          messages[0].content = `${messages[0].content}\n\n【跨轮记忆】上次聊到……`;
        }
      }
    }));
    const r = await mgr.cacheImpactOf('rewrite-hook', {});
    assert.equal(r.systemRewriteHook, true, '应识别为改写 system');
    assert.equal(r.level, 'danger');
    assert.ok(r.notes.some((n) => n.includes('不触发 fresh')), '提示应点明不触发 fresh');
  });

  // ── 2b. 整条替换 index0 也算改写 ────────────────────────────────────────
  await check('替换掉 index0 system 消息：同样识别为 danger', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('replace-sys', {
      hooks: {
        'before-llm-messages': ({ messages }) => {
          messages.unshift({ role: 'system', content: '我插到最前面' });
        }
      }
    }));
    const r = await mgr.cacheImpactOf('replace-sys', {});
    assert.equal(r.systemRewriteHook, true, 'unshift 后 index0 不再是原 system，应判改写');
    assert.equal(r.level, 'danger');
  });

  // ── 2c. 给 system 附加字段也算改写（同一条消息内容变了） ─────────────────
  await check('给 system 消息附加字段：识别为 danger', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('annotate-sys', {
      hooks: {
        'before-llm-messages': ({ messages }) => {
          messages[0].cache_control = { type: 'ephemeral' };
        }
      }
    }));
    const r = await mgr.cacheImpactOf('annotate-sys', {});
    assert.equal(r.systemRewriteHook, true, '有额外键即视为改动了该消息');
  });

  // ── 3. 动态 promptSections：随上下文变化 ────────────────────────────────
  await check('动态 promptSections：识别为 danger（dynamicSections）', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('dynamic-sections', {
      promptSections: (ctx) => ([
        { id: 'dyn', title: '当前群', content: `当前群是 ${ctx.chatName}，会话号 ${ctx.sessionId}` }
      ])
    }));
    const r = await mgr.cacheImpactOf('dynamic-sections', {});
    assert.equal(r.dynamicSections, true, '应识别为动态');
    assert.equal(r.level, 'danger');
    assert.ok(Array.isArray(r.sectionSample) && r.sectionSample.length >= 1, '应给出动态段样例');
    assert.equal(r.sectionSample[0].id, 'dyn');
  });

  // ── 3b. 静态 promptSections 不应误报 ────────────────────────────────────
  await check('静态 promptSections：不误报（level=ok）', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('static-sections', {
      promptSections: () => ([{ id: 'const', content: '一段固定的说明文字' }])
    }));
    const r = await mgr.cacheImpactOf('static-sections', {});
    assert.equal(r.dynamicSections, false, '固定输出不应判动态');
    assert.equal(r.level, 'ok');
  });

  // ── 4. 完全静态实现：ok ─────────────────────────────────────────────────
  await check('无 hook、无 promptSections：level=ok 且给出说明', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('plain'));
    const r = await mgr.cacheImpactOf('plain', {});
    assert.equal(r.level, 'ok');
    assert.ok(r.notes.some((n) => n.includes('未发现')), 'ok 时应给出正面结论');
  });

  // ── 5. available() 抖动 ─────────────────────────────────────────────────
  await check('available() 连续两次不一致：识别为 warn', async () => {
    const mgr = new SkillManager({ log: () => {} });
    let n = 0;
    mgr.register(mk('flappy-avail', {
      available: () => { n += 1; return n % 2 === 1; }   // 每次调用翻转
    }));
    const r = await mgr.cacheImpactOf('flappy-avail', {});
    assert.equal(r.unstableAvailable, true, '应识别为不稳定');
    assert.equal(r.level, 'warn');
  });

  // ── 6. 异步 hook：现在能 await，真实改写要能被识别 ──────────────────────
  await check('异步 before-llm-messages：await 后能识别改写（不再一律漏判）', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('async-hook', {
      hooks: {
        'before-llm-messages': async ({ messages }) => {
          messages[0].content = '异步改写';
        }
      }
    }));
    const r = await mgr.cacheImpactOf('async-hook', {});
    assert.equal(r.systemRewriteHook, true, 'await 后应识别出异步改写');
    assert.equal(r.level, 'danger');
  });

  await check('异步 hook 但未改写 system：不误报', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('async-benign', {
      hooks: {
        'before-llm-messages': async ({ messages }) => {
          await Promise.resolve();
          messages.push({ role: 'system', content: '追加新消息（无害）' });
        }
      }
    }));
    const r = await mgr.cacheImpactOf('async-benign', {});
    assert.equal(r.systemRewriteHook, false, '只 push 不算改写');
    assert.equal(r.pushOnlyHook, true, '应识别为 push 式');
    assert.equal(r.level, 'warn');
  });

  // ── 6b. 静态扫描：数据依赖型改写（空上下文试跑观察不到）────────────────
  await check('静态扫描：源码里有 system 改写模式时判 danger', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-probe-'));
    // 模拟 conversation-memory 的写法：有内容才改 system（空上下文试跑无改写）
    fs.writeFileSync(path.join(dir, 'index.js'), `
      function appendToSystem(messages, text) {
        if (!text) return;
        const sys = messages.find((m) => m && m.role === 'system');
        if (sys && typeof sys.content === 'string') { sys.content += text; return; }
        messages.unshift({ role: 'system', content: text });
      }
      export const hooks = {
        async 'before-llm-messages'({ messages }) {
          const text = '';            // 空上下文下为空 → 试跑观察不到改写
          appendToSystem(messages, text);
        }
      };
    `);
    const mgr = new SkillManager({ log: () => {} });
    mgr.register({
      ...mk('data-dependent'),
      dir,
      entryPath: path.join(dir, 'index.js')
    });
    const r = await mgr.cacheImpactOf('data-dependent', {});
    assert.equal(r.staticSystemWrite, true, '静态扫描应命中');
    assert.equal(r.level, 'danger');
    assert.ok(r.notes.some((n) => n.includes('静态扫描')), '提示应标明来自静态扫描');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('静态扫描：普通插件不误报', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-clean-'));
    fs.writeFileSync(path.join(dir, 'index.js'), `
      export const providers = { 'demo.cap': () => 'ok' };
      export const hooks = { 'after-tool': () => { console.log('observe'); } };
    `);
    const mgr = new SkillManager({ log: () => {} });
    mgr.register({ ...mk('clean-plugin'), dir, entryPath: path.join(dir, 'index.js') });
    const r = await mgr.cacheImpactOf('clean-plugin', {});
    assert.equal(r.staticSystemWrite, false, '干净插件不应命中');
    assert.equal(r.level, 'ok');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── 7. report：onlyActive 过滤与 summary ────────────────────────────────
  await check('cacheImpactReport：只体检生效中的技能，summary 计数正确', async () => {
    const mgr = new SkillManager({ log: () => {} });
    mgr.register(mk('r-danger', {
      hooks: { 'before-llm-messages': ({ messages }) => { messages[0].content = 'x'; } }
    }));
    mgr.register(mk('r-ok'));
    // 未启用的技能：用一个 available=false 的实现模拟不可用
    const disabled = mk('r-disabled');
    disabled.available = () => ({ ok: false, reason: '缺少 Key' });
    mgr.register(disabled);

    const rep = await mgr.cacheImpactReport({}, { onlyActive: true });
    const ids = rep.skills.map((s) => s.id);
    assert.ok(ids.includes('r-danger'), '生效技能应在报告里');
    assert.ok(!ids.includes('r-disabled'), '不可用技能应被过滤');
    assert.equal(rep.summary.total, rep.skills.length);
    assert.equal(rep.summary.danger, 1, '应统计出 1 个 danger');
    assert.equal(rep.summary.danger + rep.summary.warn + rep.summary.ok, rep.summary.total);

    const all = await mgr.cacheImpactReport({}, { onlyActive: false });
    assert.ok(all.skills.map((s) => s.id).includes('r-disabled'), 'onlyActive=false 应包含不可用技能');
  });

  // ── 8. 未知 id 不抛错 ───────────────────────────────────────────────────
  await check('cacheImpactOf：未知 id 返回安全兜底（不抛错）', async () => {
    const mgr = new SkillManager({ log: () => {} });
    const r = await mgr.cacheImpactOf('不存在', {});
    assert.equal(r.level, 'ok');
    assert.equal(r.dynamicSections, false);
  });

  console.log(`\n通过 ${pass}，失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
