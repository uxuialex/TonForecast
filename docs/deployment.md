# Deployment

This repository already contains the deploy path used in production.

The relevant files are:

- [docker-compose.yml](../docker-compose.yml)
- [infra/nginx/miniapp.conf](../infra/nginx/miniapp.conf)
- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
- [apps/miniapp/tonconnect-manifest.json](../apps/miniapp/tonconnect-manifest.json)
- [apps/miniapp/app.js](../apps/miniapp/app.js)

For a full fork-and-customize guide, read [docs/self-hosting.md](self-hosting.md).

## How The Runtime Is Wired

The deploy workflow assumes:

1. the repository already exists on the VPS
2. the server has Docker and Docker Compose
3. `.env.local` already exists on the server
4. a public reverse proxy forwards your domain to `127.0.0.1:3010`

The current compose topology is:

```text
Public domain
  -> host reverse proxy
  -> 127.0.0.1:3010
  -> miniapp container (nginx)
  -> /api/* proxied to api container
```

## What The Workflow Actually Does

The current [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) does this on each push to `main`:

1. SSH to the VPS
2. export a runtime backup through a one-off `api` container before touching containers
3. `git fetch --tags origin main`
4. `git reset --hard` to the exact triggering commit or the manually requested `target_ref`
5. remove stale `ton-forecast-api` and `ton-forecast-miniapp` containers
6. rebuild and recreate `api` and `miniapp`
7. smoke-check `/`, `/api/runtime/health`, `/api/runtime/version`, `/api/prices`, and `/api/markets?status=OPEN`
8. rollback to the previous commit and restore the runtime backup through a one-off `api` container if those checks fail

That split is intentional. Recreating `miniapp` after `api` avoids stale nginx upstream state inside Docker.

When you run the workflow manually, you can optionally provide `target_ref` as a branch, tag, or commit SHA. That gives you a clean “deploy this exact version” path without logging into the VPS.

The workflow no longer depends on `node` being installed on the VPS host. Runtime backup and restore execute through `docker compose run --rm --no-deps api node ...`, so the only hard runtime dependency on the host remains Docker/Compose.

## GitHub Secrets

Set these repository secrets:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`

Typical `DEPLOY_PATH`:

```text
/opt/ton-forecast
```

## First-Time VPS Setup

### 1. Clone The Repository

```bash
git clone https://github.com/your-org/your-fork.git /opt/ton-forecast
cd /opt/ton-forecast
```

### 2. Create Runtime Env

```bash
cp .env.example .env.local
```

Then fill:

- `RESOLVER_MNEMONIC`
- `RESOLVER_WALLET_VERSION`
- `TREASURY_ADDRESS`
- `TON_API_ENDPOINT`
- `TON_API_KEY` or `TONCENTER_API_KEY`
- `TON_API_ENDPOINTS`
- `CMC_API_KEY`
- `ADMIN_TOKEN`
- `ADMIN_ALLOWED_WALLETS`

### 3. Start The Stack

```bash
docker compose up -d --build
```

### 4. Put A Reverse Proxy In Front

The compose stack binds the Mini App to:

```text
127.0.0.1:3010
```

Your host-level reverse proxy should send your public app domain there.

## Telegram-Specific Deploy Checklist

Before you announce your public URL:

1. Update [apps/miniapp/tonconnect-manifest.json](../apps/miniapp/tonconnect-manifest.json) to your domain.
2. Update `TWA_RETURN_URL` in [apps/miniapp/app.js](../apps/miniapp/app.js) to your own bot link.
3. Make sure your Telegram bot points to the same public frontend URL.

## Smoke Tests

After deploy, these checks should work on the VPS:

```bash
curl -I http://127.0.0.1:3010
curl http://127.0.0.1:3010/api/runtime/health
curl http://127.0.0.1:3010/api/runtime/version
curl http://127.0.0.1:3010/api/prices
curl "http://127.0.0.1:3010/api/markets?status=OPEN"
curl "http://127.0.0.1:3010/api/my-markets?userAddress=0:..."
```

And from outside:

```bash
curl -I https://app.your-domain.com
curl https://app.your-domain.com/api/runtime/health
curl https://app.your-domain.com/api/runtime/version
curl https://app.your-domain.com/api/prices
```

## Manual Recovery

If GitHub Actions already updated the code on disk but containers are stale:

```bash
cd /opt/ton-forecast
git fetch origin main
git reset --hard origin/main
docker rm -f $(docker ps -aq --filter "name=ton-forecast-api") 2>/dev/null || true
docker compose up -d --build --force-recreate --no-deps api
docker compose up -d --force-recreate --no-deps miniapp
```

## Common Failure Modes

### `502 Bad Gateway`

Usually means the `miniapp` container is still proxying to an old `api` container IP. Recreate `miniapp`.

### `429` From TON RPC

Usually means your endpoint needs an API key or a better rate-limit plan.

### Old UI In Telegram

Telegram caches webviews aggressively. Bump the asset/script version in [apps/miniapp/index.html](../apps/miniapp/index.html), then reopen the Mini App from the bot.
