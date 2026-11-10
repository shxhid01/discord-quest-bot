import fs from 'node:fs';

const VERSION = '2.0.0';

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
  ALL: false, CLAIM: false, DRY: false,
  JSON: false, VERBOSE: false, CHECK: false, TEST: 0,
  ONLY: [], EXCLUDE: [],
};

const COLORS = { info: '\x1b[34m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m' };
let ABORTED = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const progressEntries = new Map();
let progressLines = 0;

const showProgress = () => process.stdout.isTTY && !CFG.JSON && process.env.TERM !== 'dumb';

function clearProgress() {
  if (!progressLines) return;
  process.stdout.write(`\x1b[${progressLines}A\x1b[0J`);
  progressLines = 0;
}

// Treat non-ASCII characters as two cells so wide characters cannot wrap the display.
function fitCell(value, width) {
  let text = '', used = 0;
  for (const char of value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')) {
    const cells = char.codePointAt(0) < 128 ? 1 : 2;
    if (used + cells > width) break;
    text += char;
    used += cells;
  }
  return text + ' '.repeat(width - used);
}

function drawProgress() {
  if (!showProgress() || !progressEntries.size) return;
  const width = Math.max(1, process.stdout.columns || 80);
  const columns = Math.min(progressEntries.size, Math.max(1, Math.floor((width + 3) / 27)));
  const cellWidth = Math.max(1, Math.min(36, Math.floor((width - (columns - 1) * 3) / columns)));
  const height = process.stdout.rows || 24;
  const entries = [...progressEntries.values()];
  if (height < 4) {
    process.stdout.write(fitCell(`${entries.length} active quests`, width) + '\n');
    progressLines = 1;
    return;
  }
  const groups = Math.max(1, Math.floor((height - 2) / 2));
  const visible = entries.slice(0, groups * columns);
  const lines = [];
  for (let i = 0; i < visible.length; i += columns) {
    const group = visible.slice(i, i + columns);
    lines.push(group.map(entry => fitCell(entry.name, cellWidth)).join(' | '));
    lines.push(group.map(entry => fitCell(entry.value, cellWidth)).join(' | '));
  }
  if (visible.length < entries.length) lines.push(fitCell(`+${entries.length - visible.length} more quests`, width));
  process.stdout.write(lines.join('\n') + '\n');
  progressLines = lines.length;
}

function progress(id, name, value, message) {
  if (!showProgress()) return log(message);
  clearProgress();
  progressEntries.set(id, { name, value });
  if (CFG.LOG_FILE) {
    try { fs.appendFileSync(CFG.LOG_FILE, `${new Date().toISOString()} [info] ${message}\n`); } catch {}
  }
  drawProgress();
}

function finishProgress(id) {
  if (!progressEntries.has(id)) return;
  clearProgress();
  progressEntries.delete(id);
  drawProgress();
}

function preserveProgress() {
  progressEntries.clear();
  progressLines = 0;
}

function log(msg, level = 'info', extra) {
  const ts = new Date().toISOString();
  if (progressLines) clearProgress();
  if (CFG.JSON) console.log(JSON.stringify({ ts, level, msg, ...extra }));
  else console.log(`${COLORS[level] || ''}${ts.slice(11, 19)} ${msg}\x1b[0m`);
  if (CFG.LOG_FILE) {
    try { fs.appendFileSync(CFG.LOG_FILE, `${ts} [${level}] ${msg}\n`); } catch {}
  }
  drawProgress();
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
}

const HELP = `
orion-headless v${VERSION} — server-side Discord quest runner

Usage: DQUEST_TOKEN=... node quest-bot-headless.mjs [selector] [options]

Selectors (one required unless --check or --test):
  --all                    Run every runnable quest
  --only <id|name,...>     Run only quests matching these ids or name substrings
  --exclude <id|name,...>  Skip quests matching these ids or name substrings

Options:
  --claim                  Claim rewards after completion
  --dry-run                Print the plan, touch nothing
  --test [n], -test [n]    Show n fake quests (default 2); no Discord requests
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
      case '--test': case '-test': {
        const count = argv[i + 1];
        if (count != null && (!count.startsWith('-') || /^-\d/.test(count))) {
          if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || Number(count) < 1) die('test quest count must be a positive integer');
          CFG.TEST = Number(count);
          i++;
        } else {
          CFG.TEST = 2;
        }
        break;
      }
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
export { CFG, ABORTED, sleep, rnd, log, progress, finishProgress, preserveProgress, die, loadEnvFile, applyEnv, parseArgs };
export const abort = () => { ABORTED = true; };
