# Getting started

`orion-headless` drives Discord quests from a server with no browser, no client, and no
userscript host. One Node file, one token.

Read the **Security** section before you start. The token you'll paste is full account
access.

---

## 1. Prerequisites

Pick one path:

**Docker (recommended)** — Docker Engine 24+ and the Compose plugin.
**Bare Node** — Node 18 or newer, nothing else. No `npm install`.

Both work identically. Docker gets you signal handling, restart policy, and log rotation
for free.

You also need an account that actually has quests. Quests are region- and
account-gated; a fresh account may see none.

---

## 2. Get a token

These produce the same ~72-character string. No `Bot ` prefix.

### Method A — DevTools Network tab (most reliable)

1. Open Discord — desktop app or browser.
2. `Ctrl+Shift+I`. The desktop app is Electron, so DevTools works there too.
3. **Network** tab → filter **Fetch/XHR**.
4. Click any request to `discord.com/api`. The client polls constantly, so one appears
   within seconds.
5. **Request Headers → `authorization`**. Copy the value.

### Verify before going further

```bash
curl -s https://discord.com/api/v9/users/@me -H "Authorization: TOKEN_HERE" | head -c 200
```

A JSON user object means you're good. `{"message": "401: Unauthorized"}` means a bad
copy or a dead token.

Or, with the tool itself:

```bash
docker compose run --rm orion --check
```

---

## 3. Configure

```bash
cp env.example .env
chmod 600 .env
$EDITOR .env            # paste DQUEST_TOKEN=
```

`.env` is loaded automatically. Real environment variables always win over the file, so
systemd `Environment=` and `docker compose run -e` override it.

---

## 4. Dry run

```bash
docker compose build
docker compose run --rm orion --all --claim --dry-run
```

You'll get the account line, then one line per quest it *would* enroll in and how it
*would* run it (`would run WATCH_VIDEO (300)`), then per-quest skips with reasons.

Read the skip reasons. `console-only` and `needs in-game achievement` are reported
when applicable; use `--verbose` to see unresolvable task configurations. `--check`
lists uncompleted, unexpired quests returned for the account. Discord may show other
quests that are completed, expired, or excluded from this API response.
Discord may filter the quest list according to the client build advertised in
`X-Super-Properties`. If current quests disappear from `--check`, update
`client_build_number` in `orion-headless.mjs` to the build used by your Discord
client, then rebuild the Docker image.

Nothing is enrolled and nothing is claimed in this mode.

---

## 5. First real run

```bash
docker compose run --rm orion --all --claim
```

You'll see enrollment, progress ticks, `done:` lines, and `claimed:` lines. Then it
exits.

Achievement quests ask for OAuth consent once:

```
Authorize "Some Activity" (123456789) for identify + applications.commands + applications.entitlements? [y/N]
```

Answer `y`, or set `DQUEST_YES=true` to skip the prompt. The grant is created, used, and
revoked in the same run — only the grant this script made is removed, your other
authorizations are untouched.

Without a TTY (cron, CI) the prompt is auto-accepted.

---

## 6. Make it recurring

The default Docker Compose schedule runs every 24 hours.

### Docker Compose (default)

```bash
docker compose up -d
```

The image's default command is `--all --claim --loop 86400`, so the container runs a pass,
sleeps 24 hours, repeats. `restart: unless-stopped` covers host reboots.
`docker compose stop` sends SIGTERM, which the script handles gracefully.

Logs: `docker compose logs -f` and `./data/orion.log`.
If there are no runnable quests, the log says `no runnable quests available`.


### Cron with the one-shot compose file

```cron
17 * * * * cd /srv/orion && docker compose -f docker-compose.once.yml run --rm orion >> /var/log/orion.log 2>&1
```

Randomised minute beats the top-of-hour stampede.

### systemd

`/etc/systemd/system/orion.service`:

```ini
[Unit]
Description=orion-headless
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=orion
WorkingDirectory=/srv/orion
EnvironmentFile=/srv/orion/.env
ExecStart=/usr/bin/node /srv/orion/orion-headless.mjs --all --claim
```

`/etc/systemd/system/orion.timer`:

```ini
[Unit]
Description=Run orion hourly

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now orion.timer
```

---

## 7. Flags

| Flag | Effect |
|---|---|
| `--all` | Every runnable quest |
| `--only <a,b>` | Only quests whose id or name matches |
| `--exclude <a,b>` | Skip matching quests |
| `--claim` | Claim rewards after completion |
| `--dry-run` | Print the plan, touch nothing |
| `--yes` | Auto-accept OAuth consent |
| `--check` | Verify token, list open quests, exit |
| `--once` | One pass, no re-poll cycles |
| `--max-cycles <n>` | Re-poll cycles per pass (default 3) |
| `--max-attempts <n>` | Attempts per quest (default 2) |
| `--concurrency <n>` | Quests in flight (default: all runnable quests) |
| `--loop <s>` | Repeat passes every `s` seconds |
| `--json` | JSON-lines logs |
| `--verbose` | Log skip and detection detail |
| `--log-file <p>` | Append plain logs to a file |

Exit codes: `0` clean, `1` fatal, `2` bad config, `3` some quests failed.

---

## 8. Security

**Anyone with the token controls your account** — messages, servers, payment methods,
everything. Treat it like a password.

- `.env` at `chmod 600`, owned by the service user, never committed.
- Pass it via `env_file` or systemd `EnvironmentFile`, not `-e` on the command line
  (visible in `ps`).
- Changing your Discord password invalidates the token and logs out every session,
  including the script. Re-extract and redeploy.
- The script needs no elevated scopes beyond the per-achievement OAuth grants, which it
  revokes itself.

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| `DQUEST_TOKEN is not set` | `.env` missing or not loaded |
| `looks truncated` | Copied partially, or included `Bot ` plus whitespace |
| `401: Unauthorized` | Dead token — password changed or session killed |
| `enrollment blocked until …` | Discord flagged the account. Wait; retrying does nothing |
| `access suspended until …` | Broader block, same advice |
| `Discord credited no progress` | Heartbeat accepted, ignored. Usual from datacenter IPs |
| `achievement: activity age-gated or delisted` | Error `50165`. Nothing to fix |
| `claim failed: … captcha required` | Claim in the Discord client by hand |
| Everything skipped | Quests aren't automatable. Expected |
| `EACCES` on `/app/data` | Host dir owned by root: `sudo chown -R 1000:1000 ./data` |

Raise `DQUEST_MAX_GAP` to `2000` if you see repeated 429s. Lower `DQUEST_CONCURRENCY` to
`1` on shared IPs.

---

## 10. Removing

```bash
docker compose down
rm -rf ./data .env
```

Nothing is installed on the host and nothing persists outside `./data`.