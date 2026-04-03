# Deployment

## How The Delivery Path Actually Works

For Telegram Mini Apps, the frontend must be hosted on a public HTTPS URL.

Recommended path:

1. Code lives in GitHub.
2. GitHub Actions builds and deploys to your VPS.
3. VPS runs frontend, API, and resolver.
4. Telegram bot opens the frontend URL as a Mini App.

## Recommended Production Topology

```text
GitHub
  -> GitHub Actions
  -> SSH to VPS
  -> docker compose pull/build + up -d
  -> Nginx/Caddy reverse proxy
  -> https://app.your-domain.com
```

## Runtime Split

### Frontend

- static assets served by Nginx/Caddy
- public URL used by Telegram Mini App button

### API

- private container exposed through reverse proxy
- serves `/api/*`

### Resolver

- internal worker container
- not exposed publicly

## Domain Plan

Use separate subdomains from the start:

- `app.your-domain.com` for the Mini App frontend
- `api.your-domain.com` for backend API, or proxy it under `/api`

For MVP, same-domain with reverse proxy is simpler:

- `https://app.your-domain.com/`
- `https://app.your-domain.com/api/*`

## GitHub Secrets You Will Need

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`

You will also need app secrets on the server:

- TON endpoint keys if used
- resolver wallet secret
- STON.fi configuration if needed
- bot and Mini App config

## Recommended Server Layout

```text
/opt/ton-native-pm/
  docker-compose.yml
  .env
  infra/
```

## Deployment Sequence

### Step 1

Provision a VPS with:

- Docker
- Docker Compose
- Nginx or Caddy
- a domain with HTTPS

### Step 2

Create a CI pipeline that does:

1. Checks out repository
2. Builds images or uploads source
3. Connects to VPS over SSH
4. Restarts services

### Step 3

Point your Telegram bot Mini App button to the public frontend URL.

That is the moment the Mini App becomes visible inside Telegram.

## What Not To Do First

Do not spend the first days on:

- complicated Kubernetes setup
- multi-server topology
- fancy observability
- custom deployment platform

One VPS is enough for hackathon MVP.

## Suggested First Deploy Milestone

Before writing serious contract logic, you want this already working:

1. Push to GitHub.
2. GitHub deploys to VPS.
3. VPS serves a placeholder Mini App page at a public HTTPS URL.
4. Telegram opens it.

If this loop works, the rest becomes normal product work.
