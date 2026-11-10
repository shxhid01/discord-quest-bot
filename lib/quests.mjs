import { CFG, ABORTED, sleep, rnd, log, progress, finishProgress } from './runtime.mjs';
import { api, dsApi, DS_ORIGIN, SKIPPABLE, FATAL_ACTIVITY } from './transport.mjs';

/* ── quest parsing ─────────────────────────────────────────── */

const CONSOLE_ONLY = new Set(['PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION']);
const taskKeys = t => (t ? Object.keys(t) : []);

const selectTaskConfig = c => {
  const v2 = c?.task_config_v2, old = c?.task_config;
  if (taskKeys(v2?.tasks).length) return v2;
  if (taskKeys(old?.tasks).length) return old;
  return v2 ?? old ?? null;
};

// Exact desktop keys win, console variants last.
const TASK_TYPES = [
  { m: k => k === 'ACHIEVEMENT_IN_ACTIVITY', type: 'ACHIEVEMENT' },
  { m: k => k === 'PLAY_ACTIVITY', type: 'ACTIVITY' },
  { m: k => k.includes('VIDEO'), type: 'WATCH_VIDEO', prefer: ['WATCH_VIDEO'] },
  { m: k => k.startsWith('PLAY'), type: 'GAME', prefer: ['PLAY_ON_DESKTOP'] },
  { m: k => k.startsWith('STREAM'), type: 'STREAM', prefer: ['STREAM_ON_DESKTOP'] },
  { m: k => k.includes('ACTIVITY'), type: 'ACTIVITY' },
];

function detectType(cfg, legacyAppId) {
  const keys = taskKeys(cfg?.tasks);
  for (const { m, type, prefer } of TASK_TYPES) {
    const key = (prefer && keys.find(k => prefer.includes(k)))
      || keys.find(k => m(k) && !CONSOLE_ONLY.has(k));
    if (key) {
      const task = cfg.tasks[key];
      return { type, keyName: key, target: task?.target ?? 0, appId: task?.applications?.[0]?.id ?? legacyAppId ?? null };
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
    progress(q.id, t.name, `video ${ts}/${t.target}s${typeof server === 'number' ? ` (credited ${server})` : ''}`, `video progress: ${t.name} — submitted ${ts}/${t.target}s${typeof server === 'number' ? `, credited ${server}/${t.target}s` : ''}`);
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
    if (typeof v === 'number') progress(q.id, t.name, `${t.type.toLowerCase()} ${v}/${t.target}`, `${t.type.toLowerCase()} progress: ${t.name} — ${v}/${t.target}`);
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

async function bypassAchievement(q, t) {
  const appId = String(t.appId || '');
  if (!/^\d+$/.test(appId)) { log('achievement: no usable appId', 'warn'); return false; }

  let before;
  try {
    before = new Set((await api('GET', '/oauth2/tokens'))
      .filter(tk => tk.application?.id === appId).map(tk => tk.id));
  } catch { log('achievement: could not snapshot grants, aborting', 'warn'); return false; }

  try {
    log(`achievement: authorizing activity ${appId} with identify, applications.commands, and applications.entitlements scopes`, 'warn');

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
  } finally {
    finishProgress(q.id);
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
    if (keys.length === 1 && keys[0] === 'ACHIEVEMENT_IN_GAME') { log(`needs in-game achievement: ${label}`, 'dim'); skipped.add(q.id); continue; }

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
export { notExpired, orbs, nameOf, select, runQuest };
