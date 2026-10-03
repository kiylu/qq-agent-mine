// jm-comic 下载引擎：接口签名/解密、多域名容错、图片下载。
// 这一层不含任何"业务编排"，也不持有工具/钩子状态，方便单独测试。
//
// 对齐 jmcomic 2.7.7 的移动端 API（JmApiClient）：
//   · token = md5(秒级时间戳 + 密钥)，tokenparam = "<ts>,2.1.7"
//   · 响应体 = AES-256-ECB(base64) 加密，key = md5(ts + secret) 的 32 字节
//   · 必须用 App 的 UA —— 实测桌面 Chrome UA 会被判 "Not legal request"（code 401）
//   · 图片直链要带 v=时间戳 的 query；不带会拿到空数据
//   · scramble_id 由 /chapter_view_template 单独返回（用另一把密钥 18comicAPPContent）

import crypto from 'node:crypto';

export const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const UA_APP =
  'Mozilla/5.0 (Linux; Android 9; V1938CT Build/PQ3A.190705.11211812; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Safari/537.36';

export const APP_VERSION = '2.1.7';
export const APP_TOKEN_SECRET = '185Hcomic3PAPP7R';
export const APP_DATA_SECRET = '185Hcomic3PAPP7R';
export const APP_TOKEN_SECRET_2 = '18comicAPPContent'; // /chapter_view_template 专用密钥

export const IMAGE_DOMAINS = [
  'cdn-msp.jmapiproxy1.cc',
  'cdn-msp.jmapiproxy2.cc',
  'cdn-msp2.jmapiproxy2.cc',
  'cdn-msp3.jmapiproxy2.cc',
  'cdn-msp.jmapinodeudzn.net',
  'cdn-msp3.jmapinodeudzn.net',
];
export const DEFAULT_API_DOMAINS = ['www.cdnhjk.net', 'www.cdngwc.cc', 'www.cdngwc.net', 'www.cdngwc.club'];
export const DEFAULT_WEB_DOMAINS = ['18comic.vip', '18comic.org', 'jm-comic2.cc', 'jm-comic3.cc'];

export const IMAGE_SUFFIXES = ['.jpg', '.jpeg', '.webp', '.png', '.gif'];

const md5hex = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const tsSeconds = () => Math.floor(Date.now() / 1000);

// ───────────────────────── 通用小工具 ─────────────────────────

export function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  return [v];
}

/** 消毒路径片段：去掉 Windows 非法字符与首尾空白/点。 */
export function sanitizeSegment(raw, fallback) {
  let s = String(raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  return (s || fallback).slice(0, 80);
}

export function suffixOf(name, fallback = '.jpg') {
  const clean = String(name ?? '').split('?')[0];
  const m = clean.match(/\.[a-zA-Z0-9]{2,5}$/);
  const s = m ? m[0].toLowerCase() : fallback;
  return IMAGE_SUFFIXES.includes(s) ? s : fallback;
}

/**
 * 严格判断"这个文件名是不是一张图"——**只看真实扩展名，不做任何回退猜测**。
 *
 * ⚠️ 绝对不要用 `IMAGE_SUFFIXES.includes(suffixOf(name))` 代替它：
 * `suffixOf()` 对识别不了的扩展名会**回退成 '.jpg'**（那是为"CDN 有时不给扩展名"设计的），
 * 于是 `suffixOf('x.pdf')` 也是 '.jpg' → 被误判成图片。
 * 实测踩过：用那个写法做删除判断，把 PDF 和 metadata.json 一起删掉，目录整个变空。
 * 凡是"按扩展名决定删/移动文件"的地方，都必须用这个严格版本。
 */
export function isImageFileName(name) {
  const clean = String(name ?? '').split('?')[0];
  const m = clean.match(/\.[a-zA-Z0-9]{2,5}$/);
  return Boolean(m) && IMAGE_SUFFIXES.includes(m[0].toLowerCase());
}

/** 统一的图片文件名：<stem><ext>，stem 里的非数字字符换成下划线。 */
export function imageFileName(rawName, index) {
  const base = String(rawName ?? '').split('?')[0].split('/').pop() || `${String(index).padStart(5, '0')}.jpg`;
  const ext = suffixOf(base);
  const stem = (base.replace(/\.[a-zA-Z0-9]{2,5}$/, '') || String(index).padStart(5, '0')).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${stem}${ext}`;
}

/**
 * 把漫画 ID 归一化：从 "jm123456" / "JM-123456" / 链接里取出纯数字。
 * ⚠️ 必须带数字边界断言：没有 (?<!\d)…(?!\d) 时，"123456789012" 会被截成 "123456789"
 * 当成合法 ID 去联网（实测踩过，白白轮询 8 个域名）。
 */
export function normalizeAlbumId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = s.match(/(?<!\d)(\d{2,9})(?!\d)/);
  if (!m) return '';
  const id = m[1].replace(/^0+(?=\d)/, '');
  return /^\d{2,9}$/.test(id) ? id : '';
}

/** 域名候选：用户填的排最前（他填的是"已知可用"），随后是内置 API 域名与网页域名。 */
export function domainCandidates(userDomains = '') {
  const extra = String(userDomains || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  return [...new Set([...extra, ...DEFAULT_API_DOMAINS, ...DEFAULT_WEB_DOMAINS])];
}

// ───────────────────────── 解密/解析 ─────────────────────────

/** {code, data(base64 密文)} → AES-256-ECB 解密（key = md5(ts+secret)）→ JSON。 */
export function decodeApiEnvelope(text, ts) {
  const json = JSON.parse(String(text));
  if (!json || typeof json !== 'object') return null;
  if (json.code !== undefined && Number(json.code) !== 200) return null;
  if (typeof json.data !== 'string' || !json.data) return null;

  const key = Buffer.from(md5hex(`${ts}${APP_DATA_SECRET}`), 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
  decipher.setAutoPadding(false); // 自己按 PKCS#7 去填充，避免个别响应让 node 抛 bad decrypt
  const plain = Buffer.concat([decipher.update(Buffer.from(json.data, 'base64')), decipher.final()]);
  const pad = plain.length ? plain[plain.length - 1] : 0;
  const body = pad > 0 && pad <= 16 && pad <= plain.length ? plain.subarray(0, plain.length - pad) : plain;
  return JSON.parse(body.toString('utf8'));
}

/** 网页兜底解析：抓 og:url 取 ID、var page_arr 取图片名、var scramble_id、og:image。 */
export function parseWebHtml(html) {
  const h = String(html || '');
  if (!h || h.length < 200) return null;
  const grab = (re) => {
    const m = h.match(re);
    return m ? String(m[1]) : '';
  };
  const id = grab(/<meta\s+property="og:url"\s+content="[^"]*?\/(?:photo|album)\/(\d+)/i)
    || grab(/<input[^>]+id="album_id"[^>]*value="(\d+)"/i);
  if (!id) return null;

  let images = [];
  const imagesRaw = grab(/var\s+page_arr\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (imagesRaw) {
    try {
      images = JSON.parse(imagesRaw.replace(/'/g, '"'));
    } catch {
      images = [];
    }
  }
  const name = grab(/<title>([\s\S]*?)\|/);
  return {
    id,
    name: name.trim(),
    images,
    series: [],
    series_id: '0',
    scramble_id: grab(/var\s+scramble_id\s*=\s*(\d+)\s*;/),
    _ogImage: grab(/<meta\s+property="og:image"\s+content="([^"]+)"/i),
  };
}

export function normalizeAlbum(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') throw new Error(`本子 JM${fallbackId} 的数据读不出来`);
  const id = firstString(raw.id, raw.album_id, fallbackId) || String(fallbackId);
  const series = asArray(raw.series)
    .map((ch) => ({ id: firstString(ch?.id), name: firstString(ch?.name), sort: Number(ch?.sort) || 0 }))
    .filter((ch) => ch.id);
  series.sort((a, b) => a.sort - b.sort || Number(a.id) - Number(b.id));
  return {
    id,
    name: firstString(raw.name, raw.title) || `JM${id}`,
    authors: asArray(raw.author ?? raw.authors).map((x) => firstString(x)).filter(Boolean),
    tags: asArray(raw.tags).map((x) => firstString(x)).filter(Boolean),
    series,
    images: asArray(raw.images).map((x) => firstString(x)).filter(Boolean),
    ogImage: firstString(raw._ogImage),
  };
}

export function normalizePhoto(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') throw new Error(`章节 ${fallbackId} 的数据读不出来`);
  const id = firstString(raw.id, raw.photo_id, fallbackId) || String(fallbackId);
  return {
    id,
    name: firstString(raw.name, raw.title) || `JM${id}`,
    seriesId: firstString(raw.series_id, '0'),
    images: asArray(raw.images).map((x) => firstString(x)).filter(Boolean),
  };
}

// ───────────────────────── 客户端 ─────────────────────────

/**
 * 建一个绑定到具体配置的客户端。
 * @param {object} opts
 * @param {Function} opts.fetchImpl  fetch 实现（来自 api.fetch 或 globalThis.fetch）
 * @param {Function} opts.timeoutMs  () => 超时毫秒
 * @param {string}   opts.domains    用户填的备用域名
 * @param {Function} opts.warn       日志
 */
export function createClient({ fetchImpl, timeoutMs, domains = '', warn = () => {} }) {
  const getTimeout = () => (typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs) || 30000;

  async function httpGet(url, { headers = {}, timeoutOverride, retries = 1, asText = false } = {}) {
    if (typeof fetchImpl !== 'function') return { ok: false, status: 0, text: '', error: '运行环境没有可用的 fetch' };
    const t = timeoutOverride || getTimeout();
    const signal = AbortSignal.timeout(t);
    let lastError = '';

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'user-agent': UA_DESKTOP, accept: '*/*', ...headers },
          redirect: 'follow',
          signal,
        });
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          text: asText || buf.length < 4 * 1024 * 1024 ? buf.toString('utf8') : '',
          buffer: buf,
          url: res.url || url,
        };
      } catch (error) {
        lastError = error?.name === 'TimeoutError' ? `超时（${Math.round(t / 1000)} 秒）` : error?.message ?? String(error);
        if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    return { ok: false, status: 0, text: '', error: lastError, url };
  }

  /** 请求禁漫接口拿 JSON，多域名轮询 + 解密。全挂时抛错（带前几个失败原因）。 */
  async function jmApi(apiPath) {
    const candidates = domainCandidates(domains);
    const errors = [];

    for (const domain of candidates) {
      const base = `https://${domain}`;

      if (DEFAULT_API_DOMAINS.includes(domain)) {
        const ts = tsSeconds();
        const res = await httpGet(`${base}${apiPath}`, {
          headers: {
            'user-agent': UA_APP,
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
            referer: `${base}/`,
            origin: base,
            token: md5hex(`${ts}${APP_TOKEN_SECRET}`),
            tokenparam: `${ts},${APP_VERSION}`,
          },
        });
        if (res.ok) {
          try {
            const data = decodeApiEnvelope(res.text, ts);
            if (data !== null) return data;
          } catch (error) {
            warn(`接口响应解密失败（${domain}）：${error?.message ?? error}`);
          }
          errors.push(`${domain}: 响应解不开（域名可能已失效）`);
          continue;
        }
        errors.push(`${domain}: HTTP ${res.status || '网络失败'}${res.error ? ` ${res.error}` : ''}`);
        continue;
      }

      // 网页端兜底：/album/{id} 或 /photo/{id} 页面里内嵌了同一份数据
      const idMatch = apiPath.match(/[?&]id=(\d+)/);
      const webPath = idMatch ? `${apiPath.startsWith('/album') ? '/album' : '/photo'}/${idMatch[1]}` : apiPath;
      const res = await httpGet(`${base}${webPath}`, {
        headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' },
        asText: true,
      });
      if (res.ok) {
        const data = parseWebHtml(res.text);
        if (data !== null) return data;
        errors.push(`${domain}: 网页里没找到漫画数据`);
        continue;
      }
      errors.push(`${domain}: HTTP ${res.status || '网络失败'}${res.error ? ` ${res.error}` : ''}`);
    }

    throw new Error(
      `所有禁漫域名都连不上（共试 ${candidates.length} 个）：${errors.slice(0, 4).join('；')}。`
        + '可以把当前可用的域名填进技能设置的「备用站点域名」，或检查本机网络/代理。',
    );
  }

  /**
   * 取该章节的 scramble_id（还原算法必需，必须每次现查，不能写死）。
   * 接口用另一把密钥，且响应不是 JSON（HTML 片段）。失败返回 0（= 不还原）。
   */
  async function fetchScrambleId(photoId) {
    const ts = tsSeconds();
    const q = `/chapter_view_template?id=${encodeURIComponent(photoId)}&mode=vertical&page=0`
      + `&app_img_shunt=1&express=off&v=${ts}`;
    for (const domain of DEFAULT_API_DOMAINS) {
      const res = await httpGet(`https://${domain}${q}`, {
        headers: {
          'user-agent': UA_APP,
          accept: 'text/html,application/xhtml+xml,*/*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: `https://${domain}/`,
          token: md5hex(`${ts}${APP_TOKEN_SECRET_2}`),
          tokenparam: `${ts},${APP_VERSION}`,
        },
        retries: 0,
        asText: true,
      });
      if (!res.ok) continue;
      const m = String(res.text).match(/var\s+scramble_id\s*=\s*(\d+)/);
      if (m) return Number(m[1]) || 0;
    }
    warn(`拿不到 JM${photoId} 的 scramble_id（这个本子将不做竖切还原）`);
    return 0;
  }

  const albumInfo = (albumId) => jmApi(`/album?id=${encodeURIComponent(albumId)}`).then((r) => normalizeAlbum(r, albumId));
  const photoInfo = (photoId) => jmApi(`/chapter?id=${encodeURIComponent(photoId)}`).then((r) => normalizePhoto(r, photoId));

  const buildImageUrl = (domain, photoId, fileName) =>
    `https://${domain}/media/photos/${photoId}/${encodeURIComponent(String(fileName).split('/').pop())}`;

  /** 下载一张图：图片域名与 query 都轮询（缺 v 参数会返回空数据）。 */
  async function fetchImage(photoId, fileName) {
    const ts = tsSeconds();
    const variants = [`v=${ts}`, ''];
    const errors = [];
    for (const domain of IMAGE_DOMAINS) {
      for (const q of variants) {
        const url = `${buildImageUrl(domain, photoId, fileName)}${q ? `?${q}` : ''}`;
        const res = await httpGet(url, {
          headers: {
            'user-agent': UA_APP,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            referer: `https://${IMAGE_DOMAINS[0]}/`,
            'accept-language': 'zh-CN,zh;q=0.9',
          },
          retries: 0,
        });
        if (res.ok && res.buffer?.length > 512) return res.buffer;
        errors.push(`${domain}${q ? '(带v)' : '(不带v)'}: ${res.status || res.error || '空数据'}`);
      }
    }
    throw new Error(errors.slice(0, 3).join('；'));
  }

  return { httpGet, jmApi, albumInfo, photoInfo, fetchScrambleId, fetchImage, buildImageUrl };
}
