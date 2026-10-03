// 群文件 / 私聊文件上传 + 配额预检 + 到期删除。
//
// 实测结论（协议端行为，2026-09-30 在测试群验证）：
//   · upload_group_file 参数吃**本地绝对路径**，返回 { file_id }
//   · upload_file: false = 只入库（群文件列表里能看到，不发消息），true = 入库并直接发出来
//   · get_group_file_system_info 返回 { file_count, limit_count, used_space, total_space }
//   · delete_group_file 用 file_id 删除
//   · 机器人上传群文件**不需要是管理员**（普通成员有独立配额）
//
// ⚠️ 风险提示（代码里无法消除，只能靠开关与频率控制）：
//   文件一旦进群，全体群员可见可下载；事后删除也收不回别人已下载的副本。

import fs from 'node:fs';

/** 从 OneBot 返回里稳地取 file_id（不同实现字段层级不一致）。 */
function pickFileId(res) {
  return String(res?.file_id ?? res?.data?.file_id ?? '').trim();
}

/**
 * 查群文件配额。
 * @returns {{ok:boolean, fileCount?:number, limitCount?:number, usedSpace?:number, totalSpace?:number, error?:string}}
 */
export async function groupQuota(onebot, groupId) {
  try {
    const data = await onebot.call('get_group_file_system_info', { group_id: Number(groupId) });
    return {
      ok: true,
      fileCount: Number(data?.file_count ?? 0),
      limitCount: Number(data?.limit_count ?? 0),
      usedSpace: Number(data?.used_space ?? 0),
      totalSpace: Number(data?.total_space ?? 0),
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 上传一个文件到指定会话。
 * @param {object} opts
 * @param {object} opts.onebot    钩子 ctx 里的 onebot（已认证）
 * @param {string} opts.chatKey   'group:123' / 'private:456'
 * @param {string} opts.filePath  本地绝对路径
 * @param {string} [opts.name]    群文件里显示的名字
 * @param {boolean} [opts.publish] true = 入库并直接发出来；false = 只入库
 * @param {number}  [opts.timeoutMs]
 * @param {boolean} [opts.checkQuota] 上传前是否预检群文件配额
 * @returns {Promise<{ok:boolean, fileId?:string, scope?:string, error?:string, quota?:object}>}
 */
export async function uploadFile({ onebot, chatKey, filePath, name, publish = true, timeoutMs = 600000, checkQuota = true }) {
  if (!onebot?.call) return { ok: false, error: '没有可用的 onebot 客户端（不在钩子/工具上下文里）' };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: `文件不存在：${filePath}` };

  const [kind, id] = String(chatKey || '').split(':');
  if (!kind || !id) return { ok: false, error: `非法会话 key：${chatKey}` };

  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    return { ok: false, error: `读不到文件大小：${error?.message ?? error}` };
  }
  if (size <= 0) return { ok: false, error: '文件大小为 0' };

  const fileName = String(name || filePath.split(/[\\/]/).pop() || 'file').slice(0, 120);
  let quota = null;

  if (kind === 'group') {
    if (checkQuota) {
      quota = await groupQuota(onebot, id);
      if (quota.ok) {
        if (quota.limitCount > 0 && quota.fileCount >= quota.limitCount) {
          return { ok: false, quota, error: `本群群文件数量已满（${quota.fileCount}/${quota.limitCount}），请先清理旧文件` };
        }
        if (quota.totalSpace > 0 && quota.usedSpace + size > quota.totalSpace) {
          const need = Math.ceil((quota.usedSpace + size - quota.totalSpace) / 1024 / 1024);
          return { ok: false, quota, error: `本群群文件空间不足，还差约 ${need} MB，请先清理旧文件` };
        }
      }
      // 配额查询失败不阻断上传（有的协议端不实现该接口），继续走
    }
    try {
      const res = await onebot.call('upload_group_file', {
        group_id: Number(id),
        file: filePath,
        name: fileName,
        folder: '',
        upload_file: publish !== false,
      }, timeoutMs);
      const fileId = pickFileId(res);
      if (!fileId) return { ok: false, quota, error: '协议端返回里没有 file_id（上传可能未完成）' };
      return { ok: true, fileId, scope: 'group', quota, size };
    } catch (error) {
      return { ok: false, quota, error: `上传群文件失败：${error?.message ?? error}` };
    }
  }

  // 私聊文件：协议端实现差异最大的一条路，失败要给出可操作的建议
  try {
    const res = await onebot.call('upload_private_file', {
      user_id: Number(id),
      file: filePath,
      name: fileName,
      upload_file: true,
    }, timeoutMs);
    const fileId = pickFileId(res);
    if (!fileId) return { ok: false, error: '协议端返回里没有 file_id（私聊文件上传可能未完成）' };
    return { ok: true, fileId, scope: 'private', size };
  } catch (error) {
    return {
      ok: false,
      error: `私聊文件发送失败：${error?.message ?? error}。`
        + '部分协议端不支持私聊文件，可以改成让群友在群里发起，或改用「上传到群文件」。',
    };
  }
}

/** 删除群文件（用于到期清理）。 */
export async function deleteGroupFile(onebot, groupId, fileId) {
  try {
    await onebot.call('delete_group_file', { group_id: Number(groupId), file_id: String(fileId) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 把文件切成若干块（超过单文件上限时用）。
 * 只在 PDF 之后需要"分卷"时调用；按字节均分，落在最近的页边界上由调用方保证。
 * 这里做的是通用字节切分（不解析格式），所以分了卷的 PDF 每卷都能单独打开。
 */
export function splitFileBySize(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  if (size <= maxBytes) return [filePath];
  const parts = Math.ceil(size / maxBytes);
  const chunk = Math.ceil(size / parts);
  const ext = (filePath.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0];
  const stem = ext ? filePath.slice(0, -ext.length) : filePath;
  const out = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let i = 0; i < parts; i++) {
      const start = i * chunk;
      const len = Math.min(chunk, size - start);
      if (len <= 0) break;
      const target = `${stem}.part${i + 1}of${parts}${ext}`;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.writeFileSync(target, buf);
      out.push(target);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
