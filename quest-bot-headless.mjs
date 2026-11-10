#!/usr/bin/env node
'use strict';

/*
 * orion-headless v2 — server-side Discord quest runner.
 * Node >= 18. No dependencies.
 *
 *   DQUEST_TOKEN=... node quest-bot-headless.mjs --all --claim
 */

import fs from 'node:fs';
import path from 'node:path';
import { CFG, ABORTED, abort, sleep, rnd, log, progress, preserveProgress, die, loadEnvFile, applyEnv, parseArgs } from './lib/runtime.mjs';
import { HEADERS, api } from './lib/transport.mjs';
import { notExpired, orbs, nameOf, select, runQuest } from './lib/quests.mjs';

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
    const queue = select(quests, skipped, attempts);
    if (!queue.length) {
      if (cycle === 1) log('no runnable quests available', 'info');
      break;
    }

    log(`cycle ${cycle}: ${queue.length} runnable quest(s)`, 'info');
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

async function testDisplay() {
  CFG.LOG_FILE = '';
  const quests = Array.from({ length: CFG.TEST }, (_, index) => {
    const type = index % 2 ? 'video' : 'game';
    const suffix = index < 2 ? '' : ` ${index + 1}`;
    return { id: `test-${index + 1}`, name: `Example ${type === 'game' ? 'Game' : 'Video'} Quest${suffix}`, type, target: 100 };
  });
  log('test mode: simulated quests; no Discord requests or reward claims');
  for (const value of [0, 25, 50, 75, 100]) {
    if (ABORTED) break;
    for (const q of quests) {
      progress(q.id, q.name, `${q.type} ${value}/${q.target}`, `test ${q.type} progress: ${q.name} — ${value}/${q.target}`);
    }
    await sleep(600);
  }
  preserveProgress();
  if (!ABORTED) {
    for (const q of quests) log(`test quest completed: ${q.name}`, 'ok');
    log('test mode finished', 'ok');
  }
  return 0;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) die('Node >= 18 required (global fetch)', 1);
  if (CFG.TEST) return testDisplay();
  if (!CFG.TOKEN) die('DQUEST_TOKEN is not set', 2);
  if (CFG.TOKEN.startsWith('Bot ')) CFG.TOKEN = CFG.TOKEN.slice(4);
  HEADERS.Authorization = CFG.TOKEN;
  if (CFG.TOKEN.length < 50) die('DQUEST_TOKEN looks truncated (expected ~72 chars)', 2);

  const me = await api('GET', '/users/@me');
  log(`logged in as ${me.username} (${me.id})`, 'ok');

  if (CFG.CHECK || (!CFG.ALL && !CFG.ONLY.length)) {
    const list = await api('GET', '/quests/@me');
    const open = (list.quests ?? []).filter(q => !q.user_status?.completed_at && notExpired(q));
    log(CFG.CHECK ? `${open.length} open quest(s)` : `no selector given — ${open.length} open quest(s):`);
    for (const q of open) log(`  ${nameOf(q)} — ${orbs(q)} orbs`, 'dim');
    if (!CFG.CHECK) log('re-run with --all, or --only <name>');
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
    abort();
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