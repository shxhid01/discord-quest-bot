import { CFG, sleep, rnd, log } from './runtime.mjs';

const API = 'https://discord.com/api/v9';
const DS = appId => `https://${appId}.discordsays.com/.proxy/acf`;
const DS_ORIGIN = appId => `https://${appId}.discordsays.com`;

/* ── transport ─────────────────────────────────────────────── */

const SUPER_PROPS = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
  client_version: '1.0.9175', os_version: '10.0.19045', os_arch: 'x64',
  system_locale: 'en-US', client_build_number: 644758, native_build_number: 50000,
  client_event_source: null,
})).toString('base64');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';

const HEADERS = {
  Authorization: CFG.TOKEN,
  'Content-Type': 'application/json',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': UA,
  'X-Super-Properties': SUPER_PROPS,
  'X-Discord-Locale': 'en-US',
  'X-Discord-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
  Origin: 'https://discord.com',
  Referer: 'https://discord.com/channels/@me',
};

class HttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

let lastCall = 0;
async function pace() {
  const now = Date.now();
  const scheduled = Math.max(now, lastCall + rnd(CFG.MIN_GAP, CFG.MAX_GAP));
  lastCall = scheduled;
  if (scheduled > now) await sleep(scheduled - now);
}

async function api(method, p, { body, query, attempts = 0, headers } = {}) {
  let url = p.startsWith('http') ? p : API + p;
  if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query);

  await pace();
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: { ...HEADERS, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    if (attempts < CFG.MAX_RETRIES) {
      await sleep(2 ** attempts * 1000 + rnd(200, 800));
      return api(method, p, { body, query, headers, attempts: attempts + 1 });
    }
    throw new HttpError(0, String(e));
  }

  if (res.status === 429 || (res.status >= 500 && res.status !== 501)) {
    if (attempts < CFG.MAX_RETRIES) {
      let after = 1;
      try { after = JSON.parse(text).retry_after ?? after; } catch {}
      log(`retry ${attempts + 1}/${CFG.MAX_RETRIES} in ${after.toFixed(1)}s (HTTP ${res.status})`, 'warn');
      await sleep(after * 1000 + rnd(200, 800));
      return api(method, p, { body, query, headers, attempts: attempts + 1 });
    }
  }

  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw new HttpError(res.status, parsed);
  return parsed;
}

/* discordsays transport — separate origin, own headers, no Discord auth */

async function dsApi(appId, method, p, { body, token, referer, extra } = {}) {
  const res = await fetch(`${DS(appId)}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': UA,
      Origin: DS_ORIGIN(appId),
      Referer: referer,
      ...(token ? { 'X-Auth-Token': token } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw new HttpError(res.status, parsed);
  return parsed;
}

const SKIPPABLE = new Set([403, 404, 410]);
const FATAL_ACTIVITY = 50165;
export { HEADERS, api, dsApi, DS_ORIGIN, SKIPPABLE, FATAL_ACTIVITY };
