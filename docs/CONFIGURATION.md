# Configuration

## Environment policy

- Development and local scripts may use a workspace `.env`.
- Production must use platform secrets or a secret manager, not a workspace `.env`.
- The server now refuses to start in production when a workspace `.env` exists, unless `ALLOW_DOTENV_IN_PRODUCTION=true` is set as an emergency override.
- Production backups and audit logs must resolve outside the workspace directory.

## Required variables

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `production`, or `test` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Production | At least 32 characters |
| `SESSION_SECURE` | Production | Must be `true` in production |
| `BACKUP_ENCRYPTION_KEY` | Production backup protection | At least 32 characters, or use `ENCRYPTION_KEY` |
| `ENCRYPTION_KEY` | AES / backup protection | At least 32 characters |
| `SUPER_ADMIN_PIN` | Optional | Must be hashed in production |

## Optional variables

| Variable | Notes |
| --- | --- |
| `PORT` | Default `5000`; many platforms inject this automatically |
| `SESSION_TIMEOUT` | Admin session timeout in minutes |
| `SESSION_SAME_SITE` | `lax`, `strict`, or `none` |
| `TRUST_PROXY` | Set `true` behind a reverse proxy |
| `ALLOWED_ORIGINS` | CORS allowlist |
| `SCAN_DEVICE_TOKEN` | Enables protected scan device flows |
| `USE_AES_ENCRYPTION` | Set `true` only when AES mode is intentionally enabled |
| `ENCRYPTION_SALT` | Explicit AES salt |
| `ALLOW_DOTENV_IN_PRODUCTION` | Emergency override only; bypasses the production `.env` guard |
| `PGSSLREJECT_UNAUTHORIZED` | Keep default secure behavior unless a known self-signed pooler host requires `false` |

## Platform variable hygiene

Do not set the following variables in deployment platforms unless you explicitly want build dependencies omitted:

- `NPM_CONFIG_PRODUCTION`
- `npm_config_production`
- `NPM_CONFIG_OMIT`
- `npm_config_omit`

This project builds the frontend with `vite` and the server bundle with `esbuild`, so build-time dependency omission can break Docker and hosted platform builds with errors such as `sh: vite: not found`.

## PostgreSQL SSL exception policy

Production keeps certificate validation enabled by default.

If you are using a known Supabase pooler host that presents an untrusted certificate chain in your deployment environment, you may set:

- `PGSSLREJECT_UNAUTHORIZED=false`

This exception is only accepted for known Supabase pooler hosts and should not be used for arbitrary database hosts.

## Runtime path variables

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_RUNTIME_DIR` | OS-specific state directory | Parent directory for runtime data |
| `APP_BACKUP_DIR` | `<APP_RUNTIME_DIR>/backups` | Must be outside the workspace in production |
| `APP_LOG_DIR` | `<APP_RUNTIME_DIR>/logs` | Must be outside the workspace in production |

Default runtime roots:

- Windows: `%LOCALAPPDATA%\\barcode_scan_V3`
- Linux/macOS: `$XDG_STATE_HOME/barcode_scan_V3` or `~/.local/state/barcode_scan_V3`

## LINE variables

LINE features require the full set below. Partial configuration is rejected at startup.

- `LINE_LOGIN_CHANNEL_ID`
- `LINE_LOGIN_CHANNEL_SECRET`
- `LINE_LOGIN_CALLBACK_URL`
- `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`
- `LINE_MESSAGING_CHANNEL_SECRET`

## Production example

```env
NODE_ENV=production
DATABASE_URL=postgresql://<db-user>:<db-password>@db.example.test:5432/<db-name>
SESSION_SECRET=replace-with-at-least-32-characters
SESSION_SECURE=true
SESSION_SAME_SITE=lax
TRUST_PROXY=true
BACKUP_ENCRYPTION_KEY=replace-with-at-least-32-characters
APP_RUNTIME_DIR=/var/lib/barcode_scan_V3
APP_BACKUP_DIR=/var/lib/barcode_scan_V3/backups
APP_LOG_DIR=/var/lib/barcode_scan_V3/logs
LOG_LEVEL=info
```

## Secret generation

Generate fresh application secrets locally:

```bash
npm run secrets:generate
```

This prints a deployment-ready env block for:

- `SESSION_SECRET`
- `ENCRYPTION_KEY`
- `ENCRYPTION_SALT`
- `USE_AES_ENCRYPTION=true`

## Release gate

Repository CI now runs `npm run verify:release` plus `git diff --check`.

Before public launch, enable GitHub branch protection so at least these checks are required on `main`:

- `required-checks`
- `docker-smoke`
