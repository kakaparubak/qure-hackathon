# Private VPS deployment

One container runs Fastify, the built live dashboard and Baileys. The database
remains your configured Supabase/Postgres service. The HTTP port is bound only to
VPS localhost; access it through SSH. No domain or public inbound HTTP port is
needed. This setup keeps the current single-process WhatsApp adapter; it does
not split Baileys into a separate service.

## Prerequisites

- A Linux VPS with Docker Engine and Compose **2.30+** (`env_file.format: raw`).
- Enough RAM for the configured 768 MiB runtime limit plus the OS and image build.
  Build steps are not constrained by the runtime memory limit.
- Outbound access to WhatsApp, your database and configured model endpoints.
- Your current code, including local changes that have not been committed yet.

This scaffold was validated with Compose, application tests and a live dashboard
build. A Docker image build/container smoke test could not run in the development
environment because the Docker socket requires privileges and sudo requires an
interactive password. Run the build and readiness checks below on the VPS before
relying on it.

## 1. Transfer the current workspace

From your development machine (replace `user@VPS`):

```sh
ssh user@VPS 'mkdir -p ~/qure'
rsync -az --exclude='.git/' --exclude='node_modules/' --exclude='dist/' \
  --exclude='.baileys/' --include='.env.example' --exclude='.env*' \
  ./ user@VPS:~/qure/
```

This includes uncommitted code while excluding the local environment and default
WhatsApp session. If you use a custom credential directory, exclude it too.
Alternatively, push your code and clone that revision on the VPS.

## 2. Configure and build on the VPS

```sh
cd ~/qure
cp .env.example .env
chmod 600 .env
# Edit .env with your editor, then:
docker compose config --quiet
docker compose build
```

Fill in `DATABASE_URL`, `OPENROUTER_API_KEY`, model IDs/cutoffs and
`WA_PAIRING_NUMBER`. Set `WA_ENABLED=true`; `WA_PAIRING_MODE=code` is convenient
over SSH. Preserve the measured cutoffs (currently primary 0.15/fallback 0.31).
Optional z.ai and queue/check-in settings work as in local development.

Compose reads the service environment as raw `KEY=value`: **do not surround values
with quotes**. This preserves literal `$` characters in credentials. Percent-encode
special characters in database URLs. Environment values are injected only at
runtime, never during the image build. Compose fixes the internal port to 3000
and overrides `WA_AUTH_DIR` to the named volume at `/data/baileys`; leave those
container paths alone. Never print resolved Compose config containing secrets.

## 3. Apply migrations explicitly

For a fresh database, or an existing database managed by the checked-in migration
ledger:

```sh
docker compose run --rm --no-deps qure scripts/migrate.ts
```

`MIGRATION_DATABASE_URL` can override `DATABASE_URL` with a direct/session
connection for this command. An already-baselined database is not reset. A database
created by manual schema push must be reconciled/baselined first; do not apply the
initial migration over existing tables. See `packages/db/README.md`. Startup never
runs migrations automatically, and this deployment does not create a new database.

## 4. Start and pair

Stop your old bot process before switching to the VPS. Pair once on the VPS:

```sh
docker compose up -d
docker compose logs --tail=100 -f qure
```

Enter the printed pairing code in WhatsApp → Linked Devices → Link with phone
number. For QR mode, use `docker compose logs --no-log-prefix --no-color -f qure`
and a sufficiently wide terminal. Treat pairing output as private.

```sh
docker compose ps
curl --fail http://127.0.0.1:3000/ready
```

`/health` is API liveness. `/ready` checks completed runtime wiring, accessible
session/queue schema and (when enabled) an open WhatsApp connection. It remains
503 while pairing, disconnected or missing migrations. The container healthcheck
probes `/ready`; startup has a 90-second grace period. An unhealthy status does
**not** itself restart the container: `unless-stopped` handles process exits,
while Baileys reconnects transient disconnects with bounded/backoff behavior.
Logged-out credentials need operator pairing; do not restart-loop to hide it.

## 5. Open the dashboard through SSH

On your own machine:

```sh
ssh -N -L 3001:127.0.0.1:3000 user@VPS
```

Open **http://localhost:3001/dashboard/**. Keep the tunnel open. The image builds
with `VITE_USE_MOCK=false` and same-origin API requests. Queue updates, chat,
mark-served actions and FHIR downloads all use that tunnel. Do not change the
Compose bind address to `0.0.0.0` to obtain access; SSH already provides it.

## Updates, persistence and resource limits

```sh
# After transferring/pulling changed source:
docker compose build
docker compose run --rm --no-deps qure scripts/migrate.ts
docker compose up -d
```

The `baileys_session` named volume is reused across recreation/rebuild. Its new
volume ownership is initialized for the non-root `bun` user. Use one bot container
per linked session; do not scale replicas or share a live auth directory across
processes. `docker compose down` retains the login; `down -v` deletes it.
Do not rename the Compose project unless you intentionally select a new volume.

The service defaults to 768 MiB RAM/no additional swap and one CPU. Override
`QURE_MEMORY_LIMIT`, `QURE_CPUS` or `QURE_HOST_PORT` in `.env` if necessary, then
recreate the container. The root filesystem is read-only; auth state and a 64 MiB
`/tmp` are writable. Logs rotate at three 10 MiB files. SIGTERM drains active work,
stops queue/check-in workers, closes SSE/WhatsApp and the DB, preserving login
credentials; Docker allows 45 seconds before a forced stop. Uncertain outbound
sends still require reconciliation, as in local operation.

For a consistent credential backup, stop the bot, copy `/data/baileys` with
`docker compose cp` to a private directory **outside the repository**, then start
it again. Protect that backup like the WhatsApp login itself.

## References

- https://bun.sh/guides/ecosystem/docker
- https://docs.docker.com/reference/compose-file/services/
- https://bun.sh/docs/runtime/environment-variables
