```markdown
# orion-headless

Server-side Discord quest runner. No browser, no client, no userscript host — a single
Node file that talks to Discord's HTTP API with a user token.

It enrolls in quests, drives progress, and optionally claims the reward. Video, activity,
game, stream, and achievement-in-activity quests are handled; everything else is skipped
with a reason.

---

## Requirements

- Node **18 or newer** (uses global `fetch`)
- A user token from the account that owns the quests
- No npm dependencies
- ~100 MB RAM, no disk, no database

## Install

```bash
git clone <repo> && cd orion-headless
chmod +x orion-headless.mjs
export DQUEST_TOKEN='...'
node orion-headless.mjs --all --dry-run
```

`--dry-run` prints what it would enroll in and run, and touches nothing.

## Getting the token

Any of these. They all produce the same string — a ~72-character token, sometimes
prefixed with `MT` or `OT`, **without** the `Bot ` prefix.

### Method 1 — Network tab (most reliable, all clients)

1. Open Discord (desktop app or browser).
2. Open DevTools: `Ctrl+Shift+I`. In the desktop app it also works — it is Electron.
3. Go to **Network**, filter to **Fetch/XHR**.
4. Click any request to `discord.com/api`. The client polls constantly, so one appears
   within seconds; `/api/v9/science` or a `/messages` call is fine.
5. **Request Headers → `authorization`**. Copy the value.

### Method 2 — Console

```js
(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m)
  .find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()
```

If that returns `undefined`, the build moved the export. Method 1 always works.

### Method 3 — Local Storage

DevTools → **Application** → **Local Storage** → `https://discord.com` → key `token`.
The value is JSON-quoted; strip the surrounding `"`.

This is frequently `null` on current builds. Don't rely on it.

### Verify it before running

```bash
curl -s https://discord.com/api/v9/users/@me \
  -H "Authorization: $DQUEST_TOKEN" | head -c 200
```

A JSON user object means it works. `{"message": "401: Unauthorized"}` means you copied
it wrong, or it's dead.

**Anyone holding this token has full control of your account** — messages, payments,
everything. Store it in a `chmod 600` env file, never in a repo. Changing your Discord
password invalidates it and logs every session out.

## Usage

```
DQUEST_TOKEN=... node orion-headless.mjs [flags]
```

| Flag | Effect |
|---|---|
| `--all` | Run every runnable quest. Without it, nothing is selected. |
| `--claim` | Auto-claim rewards after completion. Off by default. |
| `--dry-run` | Enroll and run nothing; print the plan. |
| `--yes` | Skip the OAuth consent prompt for achievement quests. |

Exit codes: `0` clean, `1` fatal.

## How it works

### 1. Discovery

`GET /api/v9/quests/@me` returns the quest list. Each entry carries
`config.task_config_v2.tasks` — a map of task keys to targets — plus
`traffic_metadata_sealed`, a server-signed blob the client echoes back on enroll and claim.
The script filters out completed, expired, and blacklisted quests, then resolves one
task key per quest.

### 2. Task selection

Task keys are matched exactly first and by prefix last:

| Key | Handler |
|---|---|
| `WATCH_VIDEO*` | video |
| `PLAY_ON_DESKTOP` | game |
| `STREAM_ON_DESKTOP` | stream |
| `PLAY_ACTIVITY` | activity |
| `ACHIEVEMENT_IN_ACTIVITY` | achievement |
| `PLAY_ON_XBOX`, `PLAY_ON_PLAYSTATION` | skipped (no console here) |
| `ACHIEVEMENT_IN_GAME` | skipped (needs the retail game linked) |

Ordering matters. Matching `PLAY` by prefix before checking `PLAY_ACTIVITY` routes activity
quests into the game handler, which waits for heartbeats that never come. Exact keys win.

### 3. Execution

| Type | Endpoint | Mechanism |
|---|---|---|
| video | `POST /quests/{id}/video-progress` | Posts a monotonically increasing `timestamp` every 7–9.5s, tracking real elapsed time, until `target` |
| game | `POST /quests/{id}/heartbeat` | Sends `application_id` with no `stream_key` every ~20s |
| stream / activity | `POST /quests/{id}/heartbeat` | Same, with a `stream_key` built from a DM or guild voice channel |
| achievement | heartbeat, then discordsays | Heartbeat attempt first; on failure, the OAuth bypass |

A final `terminal: true` beat closes out game/stream/activity runs.

### 4. The achievement bypass

`ACHIEVEMENT_IN_ACTIVITY` is validated by the activity's own backend, not Discord's. The
flow:

1. `GET /oauth2/tokens` — snapshot existing grants for the app
2. Prompt for consent
3. `POST /oauth2/authorize` — yields an auth code
4. `POST /applications/{id}/proxy-tickets` — yields a proxy ticket
5. `POST {appId}.discordsays.com/.proxy/acf/authorize` — exchanges the code for a DS token
6. `POST .../.proxy/acf/quest/progress` — posts `{progress: target, quest_id: id}`
7. Revoke **only** the grant created in step 3, diffed against the step 1 snapshot

Step 5's referer carries the proxy ticket. Steps 5–6 are what the browser CSP blocks —
running server-side, they're just requests.

### 5. Politeness

700–1300ms between calls, three retries with backoff on 429 and 5xx, `retry_after`
honoured. All runnable quests run concurrently by default; set `DQUEST_CONCURRENCY` or
`--concurrency` to limit them. Video updates show submitted timestamps and any
server-reported credit; heartbeat updates show server-reported progress. If Discord
reports nothing five beats running, the task fails instead of walking the bar to 100%.

## What it does not do

- Console quests, and quests requiring an achievement inside a retail game
- Captcha solving — a challenged claim prints a warning and leaves the reward unclaimed
- Presence hiding (nothing is visible in Discord, so nothing needs hiding)
- Any UI

## Deploying

The script exits when there's nothing left to run, so cron it hourly rather than daemonising:

```cron
0 * * * * systemctl start orion.service
```

See the deployment notes for the systemd unit. Docker works too:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY orion-headless.mjs .
CMD ["node", "orion-headless.mjs", "--all", "--claim"]
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401: Unauthorized` | Bad token, or password changed |
| `enrollment blocked until ...` | Discord flagged the account. Wait it out; retrying is futile |
| `access suspended until ...` | Broader than an enrollment block. Same advice |
| `Discord credited no progress` | Heartbeat accepted but ignored — usual for game/stream from a datacenter IP |
| `HTTP 50165` | Activity is age-gated or delisted; Discord refuses the proxy ticket |
| `consent declined` | Answer `y`, or pass `--yes` |
| Nothing runs | Everything was skipped — read the reasons, they're printed |


```

