# Getting started

## Requirements

- Docker with the Compose plugin, or Node.js 18 or newer.
- A Discord user token for the account with the quests.

**Keep your token private.** It grants access to your account. Do not share `.env`, commit it, or paste the token into commands or logs. Automating quests may put your Discord account at risk.

## 1. Configure

Create the configuration file:

```bash
cp env.example .env
chmod 600 .env
```

In Discord's developer tools, open **Network**, select a request to `discord.com/api`, and copy the `authorization` request header. Edit `.env` and put that value after `DQUEST_TOKEN=`. Do not include a `Bot ` prefix.

`env.example` enables reward claiming with `DQUEST_CLAIM=true`. Set it to `false` if you do not want automatic claims. Environment variables override values from `.env`.

## 2. Build and check

```bash
docker compose build orion
docker compose run --rm orion --check
docker compose run --rm orion --all --dry-run
```

`--check` lists uncompleted, unexpired quests returned by Discord. The dry run shows which quests Orion would enroll in or run; it does not change quest progress or claim rewards. Some open quests may not be runnable.

## 3. Run quests

```bash
docker compose run --rm orion --all --claim
```

All runnable quests run concurrently by default. Video and heartbeat progress updates are logged. To limit concurrency, provide a number:

```bash
docker compose run --rm orion --all --claim --concurrency 2
```

Achievement quests can automatically authorize their activity with the `identify`, `applications.commands`, and `applications.entitlements` OAuth scopes, without prompting. Orion attempts to revoke the grant it created afterward; the activity receives an authorization code.

## Run on a schedule

```bash
docker compose up -d
docker compose logs -f orion
docker compose stop orion
```

The service runs a pass every 24 hours. Do not run a separate one-shot command while it is active, because both runs could process the same quests.

## Run without Docker

Node.js 18 or newer loads `.env` automatically from the current directory:

```bash
node quest-bot-headless.mjs --check
node quest-bot-headless.mjs --all --dry-run
node quest-bot-headless.mjs --all --claim
```

## Useful options

| Option | Effect |
| --- | --- |
| `--all` | Run all runnable quests. |
| `--only <id\|name,...>` | Run matching quest IDs or name substrings. |
| `--exclude <id\|name,...>` | Skip matching quest IDs or names. |
| `--claim` | Attempt to claim rewards after completion. |
| `--dry-run` | Show the plan without enrolling, advancing, or claiming. |
| `--check` | List open quests and exit. |
| `--once` | Run one cycle without re-polling. |
| `--concurrency <n>` | Limit the number of quests in flight. |
| `--verbose` | Show additional skip details. |
| `--help` | Show all options. |

## Troubleshooting

- **Token missing or unauthorized:** check `DQUEST_TOKEN` in `.env`; replace it if the session was invalidated.
- **No runnable quests:** use `--check` and `--all --dry-run --verbose`. Quests may be completed, expired, excluded, or unsupported. Discord may also filter results by the `client_build_number` in `lib/transport.mjs`; update it to your Discord client's build and rebuild the image if current quests are missing.
- **Enrollment blocked or access suspended:** wait until Discord's stated time before retrying.
- **No progress or achievement failure:** Discord or the activity backend may reject the request; check the logged error. Console-only and in-game achievement quests are not supported.
- **Claim requires CAPTCHA:** claim the reward in Discord.
- **Changed code or client build:** run `docker compose build orion` before starting a new container. An already-running container keeps the old image.
