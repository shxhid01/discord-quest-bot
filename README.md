# Orion Headless

Run supported Discord quests from Docker or Node.js. Orion discovers quests for your account, enrolls when needed, reports progress, and can claim rewards.

> Your Discord token grants access to your account. Keep `.env` private and never share its contents. Automating quests may put your account at risk.

## Quick start

Requires Docker with Compose and a Discord user token. See [Getting started](GETTING-STARTED.md) for token setup, Node.js usage, and troubleshooting.

```bash
cp env.example .env
chmod 600 .env
# Edit .env and set DQUEST_TOKEN

docker compose build orion
docker compose run --rm orion --all --dry-run
docker compose run --rm orion --all --claim
```

The dry run does not enroll, advance, or claim quests. The real run processes all runnable quests concurrently; add `--concurrency 2` to limit simultaneous quests.

## Common commands

```bash
# Preview fake quest progress without contacting Discord
docker compose run --rm orion --test

# List open quests
docker compose run --rm orion --check

# Run only quests matching a name or ID
docker compose run --rm orion --only "quest name" --claim

# Run a pass every 24 hours
docker compose up -d

# View logs or stop the recurring service
docker compose logs -f orion
docker compose stop orion
```

The recurring service runs `--all --claim --loop 86400`. Avoid running a one-shot command at the same time as the recurring service: both could process the same quests.

## Code structure

- `quest-bot-headless.mjs` — CLI entry point and run loop.
- `lib/runtime.mjs` — configuration, arguments, and logging.
- `lib/transport.mjs` — Discord HTTP requests.
- `lib/quests.mjs` — quest selection and task handlers.

## Limitations

Console-only quests and in-game achievements cannot be automated. Stream and activity quests require a usable DM or voice channel; Discord may still reject or not credit progress. Some reward claims require a CAPTCHA in Discord. Activity achievements may automatically authorize an application without prompting; Orion attempts to revoke its grant afterward, but the activity receives an authorization code.

Run `docker compose run --rm orion --help` for all options.
