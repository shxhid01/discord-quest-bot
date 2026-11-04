#!/usr/bin/env node
'use strict';

/*
 * orion-headless v2 — server-side Discord quest runner.
 * Node >= 18. No dependencies.
 *
 *   DQUEST_TOKEN=... node orion-headless.mjs --all --claim
 */

import fs from 'node:fs';
import path from 'node:path';

const VERSION = '2.0.0';
const API = 'https://discord.com/api/v9';
const DS = appId => `https://${appId}.discordsays.com/.proxy/acf`;
const DS_ORIGIN = appId => `https://${appId}.discordsays.com`;

/* ── config ────────────────────────────────────────────────── */

const CFG = {
  TOKEN: '',
  MIN_GAP: 700, MAX_GAP: 1300,
  MAX_RETRIES: 3,
  HEARTBEAT_MS: 20500,
  VIDEO_MIN_MS: 7000, VIDEO_MAX_MS: 9500,
  MAX_TIME: 25 * 60 * 1000,
  ACHIEVEMENT_HB_MS: 3 * 60 * 1000,
  CONCURRENCY: Infinity,
  MAX_CYCLES: 3,
  MAX_ATTEMPTS: 2,
  LOOP: 0,
  BLACKLIST: new Set(),
  STATE_DIR: './data',
  LOG_FILE: '',
  ALL: false, CLAIM: false, DRY: false, YES: false,
  JSON: false, VERBOSE: false, CHECK: false,
  ONLY: [], EXCLUDE: [],
};

const COLORS = { info: '\x1b[34m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m' };
let ABORTED = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function log(msg, level = 'info', extra) {
  const ts = new Date().toISOString();
  if (CFG.JSON) console.log(JSON.stringify({ ts, level, msg, ...extra }));
  else console.log(`${COLORS[level] || ''}${ts.slice(11, 19)} ${msg}\x1b[0m`);
  if (CFG.LOG_FILE) {
    try { fs.appendFileSync(CFG.LOG_FILE, `${ts} [${level}] ${msg}\n`); } catch {}
  }
}

function die(msg, code = 2) {
  log(msg, 'err');
  process.exit(code);
}

/* ── env + args ────────────────────────────────────────────── */

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

const envInt = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
const envBool = (k, d) => (process.env[k] == null ? d : /^(1|true|yes|on)$/i.test(process.env[k]));
const envList = k => (process.env[k] || '').split(',').map(s => s.trim()).filter(Boolean);

function applyEnv() {
  CFG.TOKEN = (process.env.DQUEST_TOKEN || '').trim();
  CFG.MIN_GAP = envInt('DQUEST_MIN_GAP', CFG.MIN_GAP);
  CFG.MAX_GAP = Math.max(CFG.MIN_GAP, envInt('DQUEST_MAX_GAP', CFG.MAX_GAP));
  CFG.CONCURRENCY = Math.max(1, envInt('DQUEST_CONCURRENCY', CFG.CONCURRENCY));
  CFG.MAX_CYCLES = Math.max(1, envInt('DQUEST_MAX_CYCLES', CFG.MAX_CYCLES));
  CFG.MAX_ATTEMPTS = Math.max(1, envInt('DQUEST_MAX_ATTEMPTS', CFG.MAX_ATTEMPTS));
  CFG.MAX_TIME = Math.max(60_000, envInt('DQUEST_MAX_TIME_MS', CFG.MAX_TIME));
  CFG.LOOP = Math.max(0, envInt('DQUEST_LOOP_SECONDS', CFG.LOOP));
  CFG.STATE_DIR = process.env.DQUEST_STATE_DIR || CFG.STATE_DIR;
  CFG.LOG_FILE = process.env.DQUEST_LOG_FILE || '';
  CFG.BLACKLIST = new Set(envList('DQUEST_BLACKLIST'));
  CFG.CLAIM = envBool('DQUEST_CLAIM', CFG.CLAIM);
  CFG.DRY = envBool('DQUEST_DRY_RUN', CFG.DRY);
  CFG.YES = envBool('DQUEST_YES', CFG.YES);
}

const HELP = `
orion-headless v${VERSION} — server-side Discord quest runner

Usage: DQUEST_TOKEN=... node orion-headless.mjs [selector] [options]

Selectors (one required unless --check):
  --all                    Run every runnable quest
  --only <id|name,...>     Run only quests matching these ids or name substrings
  --exclude <id|name,...>  Skip quests matching these ids or name substrings

Options:
  --claim                  Claim rewards after completion
  --dry-run                Print the plan, touch nothing
  --yes                    Skip the OAuth consent prompt for achievements
  --check                  Verify the token and list quests, then exit
  --once                   Single pass, no re-poll cycles
  --max-cycles <n>         Re-poll cycles per pass (default ${CFG.MAX_CYCLES})
  --max-attempts <n>       Attempts per quest before giving up (default ${CFG.MAX_ATTEMPTS})
  --concurrency <n>        Quests in flight at once (default: all)
  --loop <seconds>         Re-run passes forever, sleeping between (for Docker)
  --json                   JSON-lines logs
  --verbose                Log skips and detection detail
  --log-file <path>        Append plain logs to a file
  -h, --help               This text
  -v, --version            Version

Environment: DQUEST_TOKEN, DQUEST_BLACKLIST, DQUEST_CONCURRENCY, DQUEST_CLAIM,
             DQUEST_DRY_RUN, DQUEST_LOOP_SECONDS, DQUEST_STATE_DIR, DQUEST_LOG_FILE
`;

function parseArgs(argv) {
  const next = i => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) die(`missing value for ${argv[i]}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--all': CFG.ALL = true; break;
      case '--only': CFG.ONLY.push(...next(i++).split(',').map(s => s.trim()).filter(Boolean)); break;
      case '--exclude': CFG.EXCLUDE.push(...next(i++).split(',').map(s => s.trim()).filter(Boolean)); break;
      case '--claim': CFG.CLAIM = true; break;
      case '--dry-run': CFG.DRY = true; break;
      case '--yes': case '-y': CFG.YES = true; break;
      case '--check': CFG.CHECK = true; break;
      case '--once': CFG.MAX_CYCLES = 1; break;
      case '--max-cycles': CFG.MAX_CYCLES = Math.max(1, Number(next(i++)) || 1); break;
      case '--max-attempts': CFG.MAX_ATTEMPTS = Math.max(1, Number(next(i++)) || 1); break;
      case '--concurrency': CFG.CONCURRENCY = Math.max(1, Number(next(i++)) || 1); break;
      case '--loop': CFG.LOOP = Math.max(0, Number(next(i++)) || 0); break;
      case '--json': CFG.JSON = true; break;
      case '--verbose': CFG.VERBOSE = true; break;
      case '--log-file': CFG.LOG_FILE = next(i++); break;
      case '-h': case '--help': console.log(HELP); process.exit(0);
      case '-v': case '--version': console.log(VERSION); process.exit(0);
      default: die(`unknown flag: ${a}`);
    }
  }
}

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

/* ── quest parsing ─────────────────────────────────────────── */

const CONSOLE_ONLY = new Set(['PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION']);
const UNAUTOMATABLE = new Set(['ACHIEVEMENT_IN_GAME']);
const taskKeys = t => (t ? Object.keys(t) : []);
const taskAt = (t, k) => (t ? t[k] : undefined);

const selectTaskConfig = c => {
  const v2 = c?.task_config_v2, old = c?.task_config;
  if (taskKeys(v2?.tasks).length) return v2;
  if (taskKeys(old?.tasks).length) return old;
  return v2 ?? old ?? null;
};

const appIdFor = (cfg, key, legacy) =>
  taskAt(cfg?.tasks, key)?.applications?.[0]?.id ?? legacy ?? null;

// Exact desktop keys win, console variants last.
function detectType(cfg, legacyAppId) {
  const keys = taskKeys(cfg?.tasks);
  const table = [
    { m: k => k === 'ACHIEVEMENT_IN_ACTIVITY', type: 'ACHIEVEMENT' },
    { m: k => k === 'PLAY_ACTIVITY', type: 'ACTIVITY' },
    { m: k => k.includes('VIDEO'), type: 'WATCH_VIDEO', prefer: ['WATCH_VIDEO'] },
    { m: k => k.startsWith('PLAY'), type: 'GAME', prefer: ['PLAY_ON_DESKTOP'] },
    { m: k => k.startsWith('STREAM'), type: 'STREAM', prefer: ['STREAM_ON_DESKTOP'] },
    { m: k => k.includes('ACTIVITY'), type: 'ACTIVITY' },
  ];
  for (const { m, type, prefer } of table) {
    const key = (prefer && keys.find(k => prefer.includes(k)))
      || keys.find(k => m(k) && !CONSOLE_ONLY.has(k));
    if (key) {
      return { type, keyName: key, target: taskAt(cfg.tasks, key)?.target ?? 0, appId: appIdFor(cfg, key, legacyAppId) };
    }
  }
  return null;
}

const notExpired = q => {
  const t = new Date(q?.config?.expires_at ?? 0).getTime();
  return Number.isNaN(t) || t > Date.now();
};

const orbs = q => (q?.config?.rewards_config?.rewards ?? [])
  .reduce((n, r) => n + (Number(r?.orb_quantity) || 0), 0);

const nameOf = q => q.config?.messages?.quest_name ?? q.id;

const matches = (q, needles) => needles.some(n => {
  const s = n.toLowerCase();
  return q.id === n || nameOf(q).toLowerCase().includes(s);
});

/* ── stream key ────────────────────────────────────────────── */

let streamKeyCache;
async function streamKey(userId) {
  if (streamKeyCache !== undefined) return streamKeyCache;
  try {
    const dms = await api('GET', '/users/@me/channels');
    if (dms?.length) return (streamKeyCache = `call:${dms[0].id}:${userId}`);
    const guilds = await api('GET', '/users/@me/guilds');
    for (const g of guilds ?? []) {
      try {
        const chans = await api('GET', `/guilds/${g.id}/channels`);
        const vc = chans?.find(c => c.type === 2);
        if (vc) return (streamKeyCache = `guild:${g.id}:${vc.id}:${userId}`);
      } catch {}
    }
  } catch {}
  return (streamKeyCache = null);
}

/* ── handlers ──────────────────────────────────────────────── */

async function video(q, t, userStatus) {
  const key = t.keyName;
  let cur = userStatus?.progress?.[key]?.value ?? 0;
  const started = Date.now();
  log(`video: ${t.name} (${cur}/${t.target}s)`, 'dim');

  while (cur < t.target) {
    if (ABORTED) throw new Error('aborted');
    const ms = rnd(CFG.VIDEO_MIN_MS, CFG.VIDEO_MAX_MS);
    await sleep(ms);
    cur += ms / 1000 + (Math.random() * 0.02 - 0.01);
    const ts = Number(Math.min(t.target, cur).toFixed(6));
    const r = await api('POST', `/quests/${q.id}/video-progress`, { body: { timestamp: ts } });
    const server = r?.progress?.[key]?.value ?? r?.progress?.WATCH_VIDEO?.value;
    log(`video progress: ${t.name} — submitted ${ts}/${t.target}s${typeof server === 'number' ? `, credited ${server}/${t.target}s` : ''}`, 'info');
    if (server > cur) cur = Math.min(t.target, server);
    if (r?.completed_at) return;
    if (Date.now() - started > CFG.MAX_TIME) throw new Error('timeout');
  }
}

async function heartbeatLoop(q, t, key, budget = CFG.MAX_TIME) {
  const started = Date.now();
  let cur = 0, stalls = 0;
  const beat = { stream_key: key, application_id: String(t.appId ?? ''), terminal: false };

  while (cur < t.target) {
    if (ABORTED) throw new Error('aborted');
    const r = await api('POST', `/quests/${q.id}/heartbeat`, { body: beat });
    const v = r?.progress?.[t.keyName]?.value;
    if (typeof v === 'number') log(`${t.type.toLowerCase()} progress: ${t.name} — ${v}/${t.target}`, 'info');
    if (typeof v === 'number') { cur = v; stalls = 0; }
    else if (++stalls >= 5) throw new Error('Discord credited no progress');
    if (cur >= t.target) {
      await api('POST', `/quests/${q.id}/heartbeat`, { body: { ...beat, terminal: true } }).catch(() => {});
      return;
    }
    if (Date.now() - started > budget) throw new Error('timeout');
    await sleep(rnd(CFG.HEARTBEAT_MS - 1500, CFG.HEARTBEAT_MS + 1500));
  }
}

let rl;
async function ask(appName, appId) {
  if (CFG.YES) return true;
  if (!process.stdin.isTTY) return true;
  if (!rl) rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`Authorize "${appName ?? appId}" (${appId}) for identify + applications.commands + applications.entitlements? [y/N] `);
  return /^y/i.test(a.trim());
}

async function bypassAchievement(q, t) {
  const appId = String(t.appId || '');
  if (!/^\d+$/.test(appId)) { log('achievement: no usable appId', 'warn'); return false; }

  let before;
  try {
    before = new Set((await api('GET', '/oauth2/tokens'))
      .filter(tk => tk.application?.id === appId).map(tk => tk.id));
  } catch { log('achievement: could not snapshot grants, aborting', 'warn'); return false; }

  let appName = null;
  try { appName = (await api('GET', `/applications/public?application_ids=${appId}`))?.[0]?.name; } catch {}

  try {
    if (!(await ask(appName, appId))) { log('consent declined', 'warn'); return false; }

    const auth = await api('POST', '/oauth2/authorize', {
      query: { response_type: 'code', client_id: appId, scope: 'identify applications.commands applications.entitlements' },
      body: { permissions: '0', authorize: true, integration_type: 1, location_context: { guild_id: '10000', channel_id: '10000', channel_type: 10000 } },
    });
    const code = new URL(auth.location).searchParams.get('code');
    if (!code) throw new Error('no code');

    const { ticket } = await api('POST', `/applications/${appId}/proxy-tickets`, { body: {} });
    if (!ticket) throw new Error('no proxy ticket');

    const referer = `${DS_ORIGIN(appId)}/?instance_id=cl&platform=desktop&discord_proxy_ticket=${encodeURIComponent(ticket)}`;

    const a1 = await dsApi(appId, 'POST', '/authorize', { body: { code }, referer });
    const token = a1?.token;
    if (!token) throw new Error('no discordsays token');

    await dsApi(appId, 'POST', '/quest/progress', {
      body: { progress: t.target, quest_id: q.id },
      token,
      referer,
      extra: { 'X-Discord-Quest-ID': q.id },
    });

    log(`achievement: "${t.name}" completed via discordsays`, 'ok');
    return true;
  } catch (e) {
    if (e.body?.code === FATAL_ACTIVITY) log(`achievement: activity age-gated or delisted (${FATAL_ACTIVITY})`, 'warn');
    else log(`achievement: bypass failed — ${e.body?.message ?? e.message}`, 'warn');
    return false;
  } finally {
    try {
      const after = await api('GET', '/oauth2/tokens');
      for (const tk of after) {
        if (tk.application?.id === appId && !before.has(tk.id)) {
          await api('DELETE', `/oauth2/tokens/${tk.id}`).catch(() => {});
        }
      }
    } catch {}
  }
}

const sealed = q => q.traffic_metadata_sealed ?? null;

const claim = q => api('POST', `/quests/${q.id}/claim-reward`, {
  body: {
    platform: 0, location: 11, is_targeted: false,
    metadata_sealed: null, traffic_metadata_sealed: sealed(q),
  },
});

const enroll = q => api('POST', `/quests/${q.id}/enroll`, {
  body: {
    location: 11, is_targeted: false,
    metadata_sealed: null, traffic_metadata_sealed: sealed(q),
  },
});

/* ── one quest ─────────────────────────────────────────────── */

async function runQuest(q, t, userId) {
  const label = t.name;
  try {
    if (!q.user_status?.enrolled_at) {
      if (CFG.DRY) { log(`would enroll: ${label}`, 'dim'); return 'ok'; }
      log(`enroll: ${label}`);
      await enroll(q);
      await sleep(rnd(800, 1500));
    }

    if (CFG.DRY) { log(`would run ${t.type} (${t.target}): ${label}`, 'dim'); return 'ok'; }

    switch (t.type) {
      case 'WATCH_VIDEO':
        await video(q, t, q.user_status);
        break;
      case 'GAME':
        await heartbeatLoop(q, t, null);
        break;
      case 'STREAM':
      case 'ACTIVITY': {
        const key = await streamKey(userId);
        if (!key) throw new Error('no stream key');
        await heartbeatLoop(q, t, key);
        break;
      }
      case 'ACHIEVEMENT': {
        const key = await streamKey(userId);
        const beatOk = await heartbeatLoop(q, t, key, CFG.ACHIEVEMENT_HB_MS).then(() => true).catch(() => false);
        if (!beatOk && !(await bypassAchievement(q, t))) throw new Error('achievement not credited');
        break;
      }
      default:
        throw new Error(`no handler for ${t.type}`);
    }

    log(`done: ${label}`, 'ok');

    if (CFG.CLAIM) {
      await sleep(rnd(2500, 6000));
      try {
        const r = await claim(q);
        if (r?.claimed_at) log(`claimed: ${label}`, 'ok');
        else log(`claim not confirmed: ${label}`, 'warn');
      } catch (e) {
        const captcha = JSON.stringify(e.body ?? '').toLowerCase().includes('captcha');
        log(`claim failed: ${label} — ${captcha ? 'captcha required, claim in the client' : (e.body?.message ?? e.message)}`, 'warn');
      }
    }
    return 'ok';
  } catch (e) {
    if (ABORTED) return 'fail';
    if (SKIPPABLE.has(e.status)) {
      log(`skip: ${label} (HTTP ${e.status})`, 'warn');
      return 'skip';
    }
    log(`fail: ${label} — ${e.body?.message ?? e.message}`, 'err');
    return 'fail';
  }
}

/* ── selection ─────────────────────────────────────────────── */

function select(quests, skipped, attempts) {
  const work = [];
  for (const q of quests ?? []) {
    const label = nameOf(q);
    if (q.user_status?.completed_at || !notExpired(q) || CFG.BLACKLIST.has(q.id) || skipped.has(q.id)) continue;
    if ((attempts.get(q.id) ?? 0) >= CFG.MAX_ATTEMPTS) continue;
    if (CFG.ONLY.length && !matches(q, CFG.ONLY)) continue;
    if (CFG.EXCLUDE.length && matches(q, CFG.EXCLUDE)) continue;

    const cfg = selectTaskConfig(q.config);
    const keys = taskKeys(cfg?.tasks);
    if (!keys.length) { skipped.add(q.id); continue; }
    if (keys.every(k => CONSOLE_ONLY.has(k))) { log(`console-only: ${label}`, 'dim'); skipped.add(q.id); continue; }
    const named = keys.find(k => UNAUTOMATABLE.has(k));
    if (named && keys.length === 1) { log(`needs in-game achievement: ${label}`, 'dim'); skipped.add(q.id); continue; }

    const t = detectType(cfg, q.config?.application?.id);
    if (!t || t.target <= 0 || (['GAME', 'STREAM'].includes(t.type) && !t.appId)) {
      if (CFG.VERBOSE) log(`unresolvable task config: ${label}`, 'dim');
      skipped.add(q.id);
      continue;
    }
    t.name = label;
    work.push({ q, t });
  }
  return work.sort((a, b) => orbs(b.q) - orbs(a.q) || a.t.target - b.t.target);
}

/* ── pass ──────────────────────────────────────────────────── */

function heartbeatFile() {
  try {
    fs.mkdirSync(CFG.STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.STATE_DIR, '.heartbeat'), String(Date.now()));
  } catch {}
}

async function pass(me) {
  const list = await api('GET', '/quests/@me');
  const now = Date.now();
  const until = s => { const t = new Date(s ?? 0).getTime(); return Number.isNaN(t) || t > now; };
  if (list.quest_enrollment_blocked_until && until(list.quest_enrollment_blocked_until))
    return log(`enrollment blocked until ${list.quest_enrollment_blocked_until}`, 'err'), { blocked: true };
  if (list.quest_access_suspended_until && until(list.quest_access_suspended_until))
    return log(`access suspended until ${list.quest_access_suspended_until}`, 'err'), { blocked: true };

  const skipped = new Set();
  const attempts = new Map();
  const out = { ok: 0, skip: 0, fail: 0 };

  let quests = list.quests ?? [];
  for (let cycle = 1; ; cycle++) {
    const work = select(quests, skipped, attempts);
    if (!work.length) {
      if (cycle === 1) log('no runnable quests available', 'info');
      break;
    }

    log(`cycle ${cycle}: ${work.length} runnable quest(s)`, 'info');
    const queue = [...work];
    const lanes = Array.from({ length: Math.min(CFG.CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const { q, t } = queue.shift();
        const r = await runQuest(q, t, me.id);
        out[r]++;
        if (r === 'skip') skipped.add(q.id);
        if (r === 'fail') {
          const n = (attempts.get(q.id) ?? 0) + 1;
          attempts.set(q.id, n);
          if (n >= CFG.MAX_ATTEMPTS) { skipped.add(q.id); log(`giving up: ${t.name}`, 'warn'); }
        }
      }
    });
    await Promise.all(lanes);

    if (ABORTED || cycle >= CFG.MAX_CYCLES || CFG.DRY) break;

    const fresh = await api('GET', '/quests/@me');
    quests = fresh.quests ?? quests;
    if (!select(quests, skipped, attempts).length) break;
    await sleep(rnd(2500, 4500));
  }
  return out;
}

/* ── main ──────────────────────────────────────────────────── */

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) die('Node >= 18 required (global fetch)', 1);
  if (!CFG.TOKEN) die('DQUEST_TOKEN is not set', 2);
  if (CFG.TOKEN.startsWith('Bot ')) CFG.TOKEN = CFG.TOKEN.slice(4);
  HEADERS.Authorization = CFG.TOKEN;
  if (CFG.TOKEN.length < 50) die('DQUEST_TOKEN looks truncated (expected ~72 chars)', 2);

  const me = await api('GET', '/users/@me');
  log(`logged in as ${me.username} (${me.id})`, 'ok');

  if (CFG.CHECK) {
    const list = await api('GET', '/quests/@me');
    const open = (list.quests ?? []).filter(q => !q.user_status?.completed_at && notExpired(q));
    log(`${open.length} open quest(s)`);
    for (const q of open) log(`  ${nameOf(q)} — ${orbs(q)} orbs`, 'dim');
    return 0;
  }

  if (!CFG.ALL && !CFG.ONLY.length) {
    const list = await api('GET', '/quests/@me');
    const open = (list.quests ?? []).filter(q => !q.user_status?.completed_at && notExpired(q));
    log(`no selector given — ${open.length} open quest(s):`);
    for (const q of open) log(`  ${nameOf(q)} — ${orbs(q)} orbs`, 'dim');
    log('re-run with --all, or --only <name>');
    return 0;
  }

  let failures = 0;
  do {
    const out = await pass(me);
    if (out.blocked) break;
    failures = out.fail;
    log(`pass finished — ok ${out.ok}, skipped ${out.skip}, failed ${out.fail}`, out.fail ? 'warn' : 'ok');
    heartbeatFile();
    if (!CFG.LOOP || ABORTED) break;
    log(`sleeping ${CFG.LOOP}s`, 'dim');
    const until = Date.now() + CFG.LOOP * 1000;
    while (Date.now() < until && !ABORTED) await sleep(500);
  } while (!ABORTED);

  return failures ? 3 : 0;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (ABORTED) process.exit(0);
    ABORTED = true;
    log('shutting down (finishing in-flight request)', 'warn');
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

loadEnvFile(process.env.DQUEST_ENV_FILE || '.env');
applyEnv();
parseArgs(process.argv.slice(2));
main().then(code => process.exit(code)).catch(e => {
  log(`fatal: ${e.body?.message ?? e.message}`, 'err');
  process.exit(1);
});