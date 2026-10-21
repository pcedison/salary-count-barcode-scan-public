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
| `SUPER_ADMIN_PIN` | Optional | Independent supported hash in every environment; plaintext and malformed hashes are rejected at startup |

## SUPER credential policy

`SUPER_ADMIN_PIN` uses an independent SUPER credential in development, test and
production. Any nonempty value must be a supported PBKDF2-SHA512 hash; plaintext
and malformed hashes fail startup with `SUPER_ADMIN_PIN must use a supported hash format`.
An absent, empty or whitespace-only value reports `superAdminConfigured: false`
and rejects SUPER elevation. Ordinary ADMIN login remains available; its credential
does not substitute for an unconfigured SUPER credential.

The accepted formats are `salt:iterations:hash` and legacy `salt:hash`.
The salt contains 32 hexadecimal characters and the digest 128. Explicit iteration
counts must be canonical decimal integers from 1 through 2,000,000 with no leading
zeros. New hashes use 600,000 iterations; legacy hashes use 1,000 and remain supported.

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
| `AUTO_BACKUP_STARTUP_DELAY_MS` | Production defaults to `600000` so startup health checks can stabilize before the first daily backup |
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

維運腳本的 `scripts/lib/postgres-client.mjs` 亦預設驗證外部資料庫憑證；
只有顯式設定上述例外且主機屬於 `.pooler.supabase.com` 才能停用驗證，並顯示警告。
僅 loopback (`localhost`、`127.0.0.1`、`::1`) 合成資料庫使用非 TLS 連線。
連線 URL 的 `sslmode=disable` 不會覆蓋外部 TLS 政策；正式執行前須確認憑證鏈，
不可為讓檢查通過而對任意主機關閉驗證。本次修正沒有更動平台環境變數。

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

## Salary automation email

The monthly salary automation emails the PDF report through exactly one transport.
The choice is made in `getSalaryEmailTransport()` (`server/config/salaryAutomation.ts`)
and shared by startup validation, the scheduler, and the admin config API:

- `RESEND_API_KEY` set (non-blank) → Resend HTTPS API (`POST https://api.resend.com/emails`, port 443). `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and `SMTP_PASS` are ignored.
- `RESEND_API_KEY` empty → SMTP through Nodemailer, unchanged from earlier releases.

| Variable | Transport | Notes |
| --- | --- | --- |
| `SALARY_AUTOMATION_EMAIL_TO` | Both | Comma-separated recipients; required when `SALARY_AUTOMATION_ENABLED=true` |
| `RESEND_API_KEY` | Resend | Secret. Use a *Sending access* key restricted to the sending domain |
| `RESEND_FROM` | Resend | Sender such as `Salary System <payroll@mail.example.com>`; must be on a domain verified in Resend. Falls back to `SMTP_FROM` when unset |
| `SMTP_HOST`, `SMTP_FROM` | SMTP | Both required for SMTP |
| `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | SMTP | Optional; port defaults to `587` |

When `SALARY_AUTOMATION_ENABLED=true`, startup is refused (in every environment,
as before) unless recipients are set and the active transport is complete:
Resend needs `RESEND_FROM` or `SMTP_FROM`; SMTP needs `SMTP_HOST` and `SMTP_FROM`.

### 為什麼需要 Resend

Railway Free/Trial/Hobby 方案封鎖對外 SMTP（官方除錯步驟測試的 25、465、587、2525 都不通），
官方建議改用 HTTPS 寄信服務並以 Resend 為首選
（[Railway Outbound Networking](https://docs.railway.com/reference/outbound-networking)）。
Zeabur 或本機若沒有設定 `RESEND_API_KEY`，行為與先前完全相同。

### Resend 端準備

1. 在 Resend 新增並驗證寄件網域（依指示加上 DNS 紀錄），`RESEND_FROM` 必須使用此網域的地址。
   未驗證網域時 Resend 回傳 403 `validation_error`，且測試模式只能寄給帳號本人。
2. 建立 API key，權限選 **Sending access** 並限定上述網域；不要使用 Full access。
3. 將 `RESEND_API_KEY`、`RESEND_FROM` 設為平台 secret（不要寫進 repo 或 `.env.example`）。
4. 部署後以管理員呼叫 `POST /api/salary-automation/test-email` 寄測試信，
   `GET /api/salary-automation/config` 應顯示 `emailTransport: "resend"` 與 `smtpConfigured: true`。

### 寄送行為

- 單次請求逾時 30 秒；非 2xx 會丟出含 HTTP 狀態碼與 Resend 錯誤名稱/訊息的錯誤，
  訊息會截斷並遮蔽 API key，不含信件內容與附件。
- 月結報表帶 `Idempotency-Key: monthly-salary-report/<YYYY-MM>/<請求內容 SHA-256>`。
  逾時、網路錯誤、429 `rate_limit_exceeded`、409 `concurrent_idempotent_requests` 或 5xx
  會以完全相同的內容自動重試一次，Resend 在 24 小時內會對同一金鑰回傳原結果而不重寄。
  管理員更正後重新寄送時內容不同、金鑰也不同，因此可正常寄出。
  PDF 每次重新產生時位元組不同，所以排程在下一個小時重跑失敗的月結時視為新的一封信。
- 測試信不帶 Idempotency-Key，也不自動重試。
- Resend 限制單封信（含 Base64 後附件）不超過 40MB、收件人最多 50 位
  （[Send Email API](https://resend.com/docs/api-reference/emails/send-email)）。

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

Generate a supported `SUPER_ADMIN_PIN` hash locally for any environment:

```bash
npm run super-pin:hash -- "<independent-super-pin>"
```

If you only want the raw hash value for copying into Zeabur:

```bash
npm run super-pin:hash -- --raw "<independent-super-pin>"
```

The package command invokes `scripts/hash-super-admin-pin.mjs`, which generates
the current format described above. Keep the generated value local and configure
`SUPER_ADMIN_PIN` with the hash in every environment; do not put the plaintext PIN
in that variable or share credential values in logs, reports or pull requests.

## Release gate

Repository CI now runs `npm run verify:release` plus `git diff --check`.

Runtime and dependency freshness is enforced by `verify:ci` and can also be run
directly with:

```bash
npm run runtime:update:audit
```

Run the runtime audit before changing Node.js, npm, Docker base images, GitHub Actions `node-version`, or Zeabur runtime settings. The current runtime contract is Node.js 24.x and npm 11.x.

Before public launch, enable GitHub branch protection so at least these checks are required on `main`:

- `required-checks`
- `docker-smoke`
- `Mobile UI structural checks`
