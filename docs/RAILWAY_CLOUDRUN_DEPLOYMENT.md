# Railway 主機＋Cloud Run 冷備援部署

本文件說明從 Zeabur 搬出後的部署方式：Railway 當主機，Google Cloud Run 當冷備援，
兩邊一律用同一個指令部署同一個 commit。建置約定（Dockerfile、`npm ci --include=dev`、
Node 24）仍以 [ZEABUR_BUILD_CONTRACT.md](ZEABUR_BUILD_CONTRACT.md) 為準。

本文件只描述流程與設定，不代表正式環境已經設定完成。

## 1. 架構

| | Railway（主機） | Cloud Run（冷備援） |
| --- | --- | --- |
| 方案／區域 | Hobby | `asia-east1` |
| 網址 | `https://hr.clmcolor.com`（自訂網域） | `https://salary-scan-standby-<專案編號>.asia-east1.run.app` |
| 平常狀態 | 接所有流量（LINE webhook、LIFF、管理介面） | 不接流量；min-instances 0，沒有請求時不收費 |
| 建置 | repo 根目錄 `Dockerfile`（`railway up` 上傳後偵測到即使用） | 同一個 `Dockerfile`（`gcloud run deploy --source`） |
| 健康檢查 | 部署時打 `/ready`，最多 300 秒 | 啟動檢查打 `/ready`（每 3 秒、最多約 120 秒） |
| 程式內備份與稽核 log | Railway volume `/data`（重新部署不會消失） | 容器內暫存（不掛 volume，重啟即消失） |
| 薪資自動化 | `SALARY_AUTOMATION_ENABLED=true` | 一律 `false`，只有接手時才視情況打開 |
| 部署方式 | `deploy/deploy-all.sh`（關閉 GitHub 自動部署） | `deploy/deploy-all.sh` |

- 資料庫是外部 PostgreSQL，兩邊共用，不搬移。
- 管理員工作階段存在 PostgreSQL（`connect-pg-simple`）。兩邊 `SESSION_SECRET` 相同時，
  切換主備不會讓已登入的人被登出。
- 容器埠 8080（`PORT` 環境變數）。健康檢查端點：
  - `/live`：只確認程序活著，不碰資料庫。
  - `/ready`：伺服器已在監聽，且能對資料庫執行 `SELECT 1`；連不上回 503。
    伺服器在路由註冊完成後才開始監聽，所以啟動完成前平台只會得到連線失敗。
  - `/api/health`：資料庫 `SELECT 1`＋記憶體用量低於 90%，並回報 `version`
    （`package.json`；若平台設了 `APP_VERSION` 則以它為準，**請不要設**）。

```text
                 gh workflow run deploy.yml（或 Actions → Deploy → Run workflow）
                                   │
                 GitHub Actions：deploy/deploy-all.sh（同一個 commit）
                    │ 1. Cloud Run 先部署（金絲雀）        │ 2. 再部署 Railway
                    ▼                                     ▼
        Cloud Run 冷備援（asia-east1）            Railway 主機（hr.clmcolor.com）
                    │ 3. 兩邊 /live、/api/health version 都等於 package.json
                    └───────────────┬─────────────────────┘
                                    ▼
                         外部 PostgreSQL（不搬）
```

## 2. 檔案一覽

| 檔案 | 用途 | 在哪裡跑 |
| --- | --- | --- |
| `deploy/deploy-all.sh` | 一次部署兩邊並驗證版本 | GitHub Actions（主要）；緊急時 Cloud Shell |
| `deploy/cloudrun-env.sh` | Cloud Run 環境變數（bootstrap／update）、狀態、接手／回備援 | GCP Cloud Shell |
| `deploy/gcp-setup.sh` | 一次性 GCP 設定（API、服務帳號、WIF、清理規則、預算） | GCP Cloud Shell |
| `deploy/lib/cloudrun-common.sh` | 上面三支共用的名稱與 Cloud Run 參數 | — |
| `deploy/lib/envtool.py` | 解析 `.env`、合併變數、產生 `--env-vars-file` YAML | 由 `cloudrun-env.sh` 呼叫 |
| `.github/workflows/deploy.yml` | 手動觸發的部署 workflow | GitHub Actions |
| `.github/workflows/standby-health.yml` | 每天檢查主備健康與版本一致 | GitHub Actions |
| `.gcloudignore` | `--source` 上傳時排除的檔案 | gcloud |
| `client/.env.production` | `VITE_LIFF_ID`（打包時寫進前端，非機密） | 建置 |

## 3. 一次性設定

### 3.1 Railway

1. 建立 project 與 service（Hobby）。repo 根目錄有 `Dockerfile`，Railway 會用它建置。
   Railway 的 Config as Code（`railway.json`／`railway.toml`）已棄用，**新服務不會讀取**，
   且 2026-12-01 起完全停止讀取（[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)），
   所以下列設定一律在主控台或服務變數設定：
   - Settings → Deploy → Healthcheck Path：`/ready`
   - 變數 `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300`（健康檢查最多等 300 秒）
   - Settings → Deploy → Restart Policy：On Failure（最多重試 10 次）
   - 變數 `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`（舊部署收到 SIGTERM 後保留 15 秒；程式本身 10 秒內會優雅關閉）
   - Volume 與 `RAILWAY_RUN_UID=0`：見 3.5 節
2. **關閉 GitHub 自動部署**：Service → Settings → Source，不連結 GitHub repo
   （已連結就 Disconnect）。所有部署都走 `railway up`，確保與 Cloud Run 是同一個 commit。
3. Variables：從 Zeabur 複製，並注意：
   - 設 `PORT=8080`（與 Dockerfile 一致，自訂網域的 target port 才固定）。
   - 不需要 `VITE_LIFF_ID`（已在 `client/.env.production`）。
   - 移除 `NPM_CONFIG_PRODUCTION`、`npm_config_production`、`NPM_CONFIG_OMIT`、`npm_config_omit`。
   - `ALLOWED_ORIGINS`、`LINE_LOGIN_CALLBACK_URL`（`https://hr.clmcolor.com/api/line/callback`）、
     `SALARY_AUTOMATION_PUBLIC_BASE_URL` 指向主機網址；`TRUST_PROXY=true`、`SESSION_SECURE=true`。
   - 不要設 `APP_VERSION`；`APP_RUNTIME_DIR`／`APP_BACKUP_DIR`／`APP_LOG_DIR` 不可指向 `/app` 底下
     （Railway 主機改用 3.5 節的 volume 路徑）。
4. 自訂網域 `hr.clmcolor.com`：Settings → Networking 加入網域，依指示設定 DNS。
5. Project token：Project Settings → Tokens，綁定正式環境建立 token，只放進 GitHub secret
   `RAILWAY_TOKEN`。project token 已綁定專案與環境，`railway up` 只需指定 `--service`。

### 3.2 GCP（Cloud Shell）

在瀏覽器開 GCP Cloud Shell（已登入 gcloud）：

```bash
git clone https://github.com/pcedison/salary-count-barcode-scan-public.git
cd salary-count-barcode-scan-public
gcloud config set project <專案 ID>
bash deploy/gcp-setup.sh
```

`gcp-setup.sh` 可重複執行，會：

1. 啟用 API：`run`、`cloudbuild`、`artifactregistry`、`storage`（`--source` 先把原始碼上傳到
   Cloud Storage）、`logging`、`iam`、`iamcredentials`（扮演服務帳號）、`sts`（OIDC token 交換）、
   `cloudresourcemanager`、`serviceusage`、`cloudbilling`、`billingbudgets`。
2. 建立三個服務帳號，只給最小權限：

   | 帳號 | 角色 | 依據 |
   | --- | --- | --- |
   | `salary-standby-runtime`（執行期） | 無任何專案角色 | 程式只連外部 PostgreSQL；日誌由平台收集 |
   | `salary-standby-build`（建置） | `roles/run.builder` | Cloud Run 文件「Build service account」 |
   | `salary-github-deployer`（部署） | `roles/run.sourceDeveloper`、`roles/serviceusage.serviceUsageConsumer`；在上面兩個帳號上的 `roles/iam.serviceAccountUser` | Cloud Run 文件「Deploy from source」 |

   部署帳號**沒有** `run.services.setIamPolicy`，因此不能改「誰可以呼叫服務」。開放未驗證存取
   只在 bootstrap 時由專案擁有者做一次；`deploy-all.sh` 每次部署前會確認仍是公開狀態。
3. 建立 Workload Identity Pool `github-actions` 與 OIDC Provider `salary-deploy-main`，條件為
   `repository == pcedison/salary-count-barcode-scan-public`、`ref == refs/heads/main`、
   `workflow_ref == …/.github/workflows/deploy.yml@refs/heads/main`，並把部署帳號的
   `roles/iam.workloadIdentityUser` 綁給這個 repo。GitHub 不需要任何 GCP 金鑰。
4. Artifact Registry repo `cloud-run-source-deploy` 設定清理規則：每個映像只保留最近 2 版
   （約一天內生效）。這個 repo 在第一次 `--source` 部署時才建立，所以 bootstrap 之後要**再跑一次**
   `bash deploy/gcp-setup.sh`。
5. 預算警示 `salary-standby-budget`：US$1，實際花費達 50%、90%、100% 時寄信給帳單帳戶管理員與使用者。
   帳單幣別不是 USD 時改用 `BUDGET_AMOUNT=30TWD bash deploy/gcp-setup.sh`，或依腳本提示在主控台
   Billing → Budgets & alerts 建立。預算只會通知，不會停用服務。
6. 印出要填到 GitHub 的 variables（都不是祕密）。

### 3.3 建立 Cloud Run 備援（bootstrap）

1. 從 Zeabur 匯出服務變數成 `.env` 格式，用 Cloud Shell 的「上傳」放到 **repo 外**，例如 `~/zeabur.env`。
   放在 repo 內又沒被 `.gitignore` 排除時，腳本會拒絕執行。
2. 執行：

   ```bash
   PRIMARY_URL=https://hr.clmcolor.com bash deploy/cloudrun-env.sh bootstrap ~/zeabur.env
   ```

   腳本只列變數名稱，不印任何值；暫存檔放在權限 600 的 `mktemp` 目錄，結束時刪除。轉換時會：

   | 變數 | 處理 |
   | --- | --- |
   | `SALARY_AUTOMATION_ENABLED` | 強制 `false` |
   | `ALLOWED_ORIGINS` | `主機網址,備援網址` |
   | `LINE_LOGIN_CALLBACK_URL` | `備援網址/api/line/callback`（路由見 `server/routes/line/auth.routes.ts`）；其他 LINE 變數都沒設時省略 |
   | `SALARY_AUTOMATION_PUBLIC_BASE_URL` | 備援網址（PDF 產生器會用它開啟列印頁） |
   | `VITE_LIFF_ID` | 丟掉（只在打包時使用） |
   | `PORT`、`K_SERVICE`、`K_REVISION`、`K_CONFIGURATION` | 丟掉（Cloud Run 保留名稱，設了會部署失敗） |
   | `ZEABUR_*` | 丟掉（Zeabur 平台變數） |
   | 不在 `.env.example`／`envValidator.ts` 的名稱 | 警告但仍設定（例如 `PAYROLL_WRITES_PAUSED`） |

3. **第一次部署前還不知道網址**的處理：Cloud Run 有固定格式網址
   `https://<服務>-<專案編號>.<區域>.run.app`，腳本先用專案編號算出這個網址填進上面三個變數。
   部署完成後確認這個網址確實可用；若不可用，改用服務回報的 `status.url` 重設三個變數
   （會多一個 revision，映像相同）。要指定其他網址可設 `STANDBY_URL=...`。
4. 部署使用 `/ready` 當啟動檢查：連不上資料庫或環境變數驗證失敗時部署會失敗。Cloud Run 的對外
   IP 不固定，若資料庫有 IP 白名單，需先允許 Cloud Run 連線。
5. 完成後：
   - 把印出的網址設成 GitHub variable `STANDBY_URL`。
   - LINE Developers → LINE Login channel → Callback URL **加上**備援的 `/api/line/callback`
     （保留主機的；Callback URL 可以有多個）。
   - `shred -u ~/zeabur.env` 刪除匯出檔。
   - 再跑一次 `bash deploy/gcp-setup.sh` 套用映像清理規則。

### 3.4 GitHub

Settings → Secrets and variables → Actions：

| 種類 | 名稱 | 值 |
| --- | --- | --- |
| Secret | `RAILWAY_TOKEN` | Railway project token（唯一的祕密） |
| Variable | `GCP_PROJECT_ID`、`GCP_WIF_PROVIDER`、`GCP_DEPLOY_SA` | `gcp-setup.sh` 印出的值 |
| Variable | `CLOUD_RUN_SERVICE`、`CLOUD_RUN_REGION`、`CLOUD_RUN_RUNTIME_SA`、`CLOUD_RUN_BUILD_SA` | `gcp-setup.sh` 印出的值（服務與區域可省略，預設 `salary-scan-standby`、`asia-east1`） |
| Variable | `RAILWAY_SERVICE` | Railway 服務名稱或 ID |
| Variable | `PRIMARY_URL` | `https://hr.clmcolor.com` |
| Variable | `STANDBY_URL` | bootstrap 印出的 Cloud Run 網址（每日健康檢查用） |

### 3.5 Railway volume（程式內備份與稽核 log）

Supabase 免費方案不提供資料庫備份，目前唯一的備份是程式每天寫進 `APP_BACKUP_DIR` 的 JSON 檔
（加密，每類最多保留 7 份）。預設路徑在容器內（`/home/node/.local/state/barcode_scan_V3/`），
重新部署就消失，所以 Railway 主機要掛一個 volume 專放備份與稽核 log。

設定步驟（第一次用 `deploy-all.sh` 部署 Railway 之前完成）：

1. Railway 服務 → 新增 Volume，掛載路徑 `/data`。
2. 服務變數：

   | 變數 | 值 | 原因 |
   | --- | --- | --- |
   | `APP_BACKUP_DIR` | `/data/backups` | 備份寫進 volume |
   | `APP_LOG_DIR` | `/data/logs` | 稽核 log 寫進 volume |
   | `RAILWAY_RUN_UID` | `0` | Railway 的 volume 以 root 擁有，非 root 映像需要這個設定（[Volumes](https://docs.railway.com/guides/volumes)） |

3. 部署後確認（見下方）。

`RAILWAY_RUN_UID=0` 只讓容器以 root「啟動」，應用程式仍以 `node` 執行：映像的進入點
`scripts/container-entrypoint.sh` 在以 root 啟動時，只會在 volume 掛載路徑
（Railway 提供的 `RAILWAY_VOLUME_MOUNT_PATH`）底下建立 `APP_RUNTIME_DIR`／`APP_BACKUP_DIR`／
`APP_LOG_DIR` 並交給 `node`（權限 700），把 `HOME` 設回 `/home/node`，再用 `setpriv` 降權
（含 `no_new_privs`）後啟動程式。路徑不在 volume 底下時只記錄警告、不改權限。
以 `node` 啟動時（Cloud Run、CI）直接執行，行為與先前相同。CI 的 docker-smoke 會以 root 加上
root 擁有的 volume 實際啟動一次，檢查程式以 `node` 執行且兩個目錄可寫。

`/data/backups`、`/data/logs` 在工作目錄 `/app` 之外，符合 `envValidator` 的
「正式環境備份與 log 路徑不得在 workspace 內」檢查（有單元測試涵蓋）。

確認備份有寫進 volume：

- 部署日誌：啟動時會出現 `Delaying startup daily backup by 600000 ms`，約 10 分鐘後出現
  `daily backup created at /data/backups/daily/backup-<時間>.json` 與 `Created daily backup backup-<時間>`。
  之後每 24 小時一次。
- 檔案：`railway ssh --service <服務> ls -la /data/backups/daily /data/logs`。
- API：以 SUPER 管理員登入後開 `https://hr.clmcolor.com/api/dashboard/backups`，回傳的清單應包含上述檔案。
- 重新部署一次後再檢查：舊的備份檔仍在；24 小時內重新部署時，啟動 10 分鐘後的日誌會是
  `Skipping daily backup because a fresh daily backup already exists`（程式從備份目錄讀到既有檔案，
  證明 volume 有保留）。

注意與限制：

- **掛 volume 的服務每次部署都會有短暫停機**：Railway 不允許兩個部署同時掛同一個 volume，
  即使設了健康檢查也一樣（[Healthchecks and Restarts](https://docs.railway.com/guides/healthchecks-and-restarts)）。
  `deploy-all.sh` 的部署後驗證會重試，涵蓋這段時間；也請避開上班打卡時段部署。
- 掛 volume 的服務不能使用多個 replica（[Volumes reference](https://docs.railway.com/reference/volumes)）。
- Hobby 方案 volume 預設 5 GB，可線上擴充、不能縮小；依實際使用量計費，每 GB 每秒 US$0.00000006
  （約每 GB 每月 US$0.16），從每月 US$5 的使用額度扣（[Pricing](https://railway.com/pricing)）。
  備份檔很小，正常用量遠低於 1 GB。
- 這**只防止重新部署造成的遺失**，不防 Railway 帳號、專案被刪或區域層級的災難，也不能取代資料庫本身的備份。
  Railway 對 volume 另有手動／排程備份（每日保留 6 天、每週 27 天、每月 89 天；
  [Backups](https://docs.railway.com/reference/backups)），同樣存放在 Railway 內，有相同限制；
  文件未說明 Hobby 是否提供。要防帳號或區域災難，需定期把備份複製到 Railway 以外的地方（另案）。
- Cloud Run 備援**不掛 volume**：容器檔案系統在記憶體中且不持久，接手期間產生的程式內備份會占用
  記憶體並在 instance 重啟後消失。接手期間若需要備份，請在 Railway 恢復後手動建立一次。

## 4. 平常怎麼部署

合併到 `main` 之後：

- 網頁：Actions → **Deploy** → Run workflow（分支選 `main`）。
- CLI：

  ```bash
  gh workflow run deploy.yml --ref main
  gh run watch
  ```

`deploy-all.sh` 的流程：

1. 工作樹必須乾淨，`HEAD` 必須等於 `origin/main`；印出 commit SHA 與 `package.json` version。
2. **Cloud Run 先部署**（`--source .`，不帶任何環境變數旗標，服務上既有的變數保留不動，只換映像）。
   新 revision 通過 `/ready` 才接流量，失敗時舊 revision 繼續服務，Railway 也不會被動到。
   部署後確認最新 revision 已就緒、100% 流量指向它、`commit-sha` label 等於本次 commit。
3. **再部署 Railway**（`railway up --ci --service …`）。`--ci` 會等到部署狀態 SUCCESS
   （健康檢查通過並切換流量）才回 0，FAILED／CRASHED 回 1。因為掛了 volume，切換時主機會短暫停機（3.5 節）。
4. 對兩邊打 `/live` 與 `/api/health`，重試到 120 秒（涵蓋 Cloud Run 冷啟動），兩邊 version
   都要等於 `package.json`，否則 workflow 失敗。

| 失敗在哪一步 | 結果 | 怎麼處理 |
| --- | --- | --- |
| 前置檢查／Cloud Run 建置或啟動 | 兩邊都沒變 | 修正後重新執行 |
| Railway | Cloud Run 已是新版本，主機仍是舊版本 | 看 Railway 建置日誌，修正後重新執行 |
| 部署後驗證 | 兩邊可能不一致 | 依錯誤訊息處理，重新執行 |

Cloud Run 先部署的另一個好處：主機故障、Railway 無法部署時，修正版仍會先上到 Cloud Run。

緊急時也可以在 Cloud Shell 跑同一支腳本（需安裝 `@railway/cli` 並設好環境變數；
`RAILWAY_TOKEN` 用 `read -rs RAILWAY_TOKEN && export RAILWAY_TOKEN` 輸入，不要寫在命令列）。
不要在個人電腦上部署。

回退：

- Cloud Run：`gcloud run services update-traffic salary-scan-standby --region asia-east1 --to-revisions <舊 revision>=100`。
  固定流量後 `deploy-all.sh` 會因「流量沒有 100% 指向最新 revision」而失敗，恢復時用 `--to-latest`。
- Railway：Deployments 頁面對舊的部署按 Redeploy。
- 資料庫相關的回退仍依 [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) 第 8 節。

## 5. 每日健康檢查

`.github/workflows/standby-health.yml` 每天台灣時間約 09:13 執行（也可手動 Run workflow）：

- 兩邊 `/ready` 必須 200（能連資料庫）、`/api/health` 必須 200 且 `healthy`，且兩邊 version 相同。
- 任何一項失敗 job 就失敗，GitHub 寄信通知（排程 workflow 的失敗通知寄給最後修改 cron 的人）。
- 沒設 `PRIMARY_URL` 或 `STANDBY_URL` 時略過，不算失敗。
- 不檢查兩邊環境變數是否一致；換金鑰時要自己兩邊都更新（見第 7 節）。
- 公開 repo 連續 60 天沒有活動時，GitHub 會自動停用排程 workflow，需到 Actions 頁面重新啟用。

## 6. 備援切換

### 6.1 切換到備援（主機故障）

1. 確認主機真的不可用（Railway 狀態頁、`curl https://hr.clmcolor.com/ready`）。
2. 讓 Cloud Run 接手：

   ```bash
   bash deploy/cloudrun-env.sh activate
   ```

   相當於 `gcloud run services update … --min-instances 1 --no-cpu-throttling --update-labels standby-mode=active`。
   `--no-cpu-throttling` 讓 CPU 在沒有請求時也持續配置，程式內的排程（監控、備份、保留期處理、
   薪資自動化）才會照時間執行；`min-instances 1` 避免冷啟動。接手期間跑部署，`deploy-all.sh`
   會看到 `standby-mode=active` label 而保留這兩項設定。
3. LINE Developers：
   - Messaging API → Webhook URL 改成 `備援網址/api/line/webhook`。
   - LIFF → Endpoint URL 的網域改成備援網址（路徑維持原設定，例如 `/clock-in`）。打卡 QR code 指向
     `https://liff.line.me/<LIFF ID>`，不需要重印。
   - Callback URL 在 bootstrap 時已加入，不用改。
4. 管理介面改用備援網址登入。
5. 薪資自動化：**同一時間只能一台開**。只有在確定 Railway 不會同時執行（服務已停止，或已把 Railway 的
   `SALARY_AUTOMATION_ENABLED` 改成 `false`）且當期需要時，才打開 Cloud Run 的：

   ```bash
   gcloud run services update salary-scan-standby --region asia-east1 \
     --update-env-vars SALARY_AUTOMATION_ENABLED=true
   ```

6. Cloud Run 不掛 volume，檔案系統在記憶體中、不持久：程式內的 JSON 備份會占用記憶體，
   instance 重啟就消失（3.5 節）。Railway 恢復後先手動建立一次備份。

### 6.2 切回主機

1. 確認 Railway 恢復（`/ready` 200），且版本與 Cloud Run 相同（必要時先跑一次 Deploy）。
2. 回到冷備援（同時把 Cloud Run 的薪資自動化關掉）：

   ```bash
   bash deploy/cloudrun-env.sh standby
   ```

   相當於 `--min-instances 0 --cpu-throttling --update-env-vars SALARY_AUTOMATION_ENABLED=false --update-labels standby-mode=standby`。
3. LINE Webhook URL 與 LIFF Endpoint URL 改回主機。
4. 若接手時把 Railway 的 `SALARY_AUTOMATION_ENABLED` 改成 `false`，改回 `true`。
5. `bash deploy/cloudrun-env.sh status` 確認模式是 `standby`。

## 7. 換金鑰與改環境變數

兩邊的環境變數各自保存，**換金鑰時 Railway 與 Cloud Run 都要更新**：

1. Railway：Service → Variables 修改。
2. Cloud Run：把要改的變數寫成一個只含那幾行的 `.env` 檔（放在 repo 外），然後：

   ```bash
   bash deploy/cloudrun-env.sh update ~/rotate.env
   shred -u ~/rotate.env
   ```

   `update` 會讀出服務目前的變數、合併檔案裡列出的變數、整批套用（值不會出現在命令列參數上），
   只印出「新增／更新了哪些變數名稱」。沒有變更時不會動服務。新 revision 通過 `/ready`
   才接流量，失敗時舊 revision 繼續服務。
3. `bash deploy/cloudrun-env.sh status` 列出 Cloud Run 上的變數名稱，與 Railway 對照有無遺漏。

`SALARY_AUTOMATION_ENABLED`、`ALLOWED_ORIGINS`、`LINE_LOGIN_CALLBACK_URL`、
`SALARY_AUTOMATION_PUBLIC_BASE_URL` 是備援專屬的值，`update` 不會用檔案內容覆寫它們；
真的要改時用 `gcloud run services update … --update-env-vars 名稱=值`（這些都不是祕密）。

## 8. 薪資自動化只能一台開

| 狀況 | Railway | Cloud Run | Zeabur |
| --- | --- | --- | --- |
| 搬家期間 | 正式切換前 `false` | `false` | 停用前保持原狀，停用後不再執行 |
| 平常 | `true` | `false` | — |
| 主機故障、Cloud Run 接手 | 已停止或 `false` | 需要時才 `true` | — |
| 切回主機 | `true` | `false`（`standby` 子指令會設） | — |

`monthly_salary_runs` 以單一 `INSERT … ON CONFLICT` 取得每月執行權，同月份不會被兩台同時取得；
這只是最後一道保護，不能取代上面的規則。

## 9. 費用與清理

- Cloud Run 平常 min-instances 0、CPU 只在處理請求時計費，每日健康檢查只會短暫喚醒一次。
  接手模式（min-instances 1、CPU 常駐）會持續計費，切回後要執行 `standby`。
- `--source` 每次部署會用 Cloud Build 建置，並在 Artifact Registry 留下映像。映像含 Chromium，
  每版數百 MB，平常主要的費用就是這裡的儲存空間，所以清理規則只保留 2 版。
  原始碼壓縮檔會留在 `run-sources-<專案>-asia-east1` bucket，需要時可在 Cloud Storage 設生命週期規則刪除舊檔。
- Railway volume 依用量計費（3.5 節）。
- 預算警示見 3.2 第 5 點。

## 10. 疑難排解

| 症狀 | 處理 |
| --- | --- |
| `工作樹不乾淨`／`HEAD 不等於 origin/main` | 只能部署乾淨的最新 `main`；GitHub Actions 中通常是有人在部署途中又推了 main，重新執行即可 |
| Cloud Run 部署卡在啟動檢查 | `gcloud run services logs read salary-scan-standby --region asia-east1 --limit 100`；多半是資料庫連不上或 `envValidator` 拒絕啟動 |
| Cloud Run 回 403 | 未開放未驗證存取。在 Cloud Shell：`gcloud run services add-iam-policy-binding salary-scan-standby --region asia-east1 --member=allUsers --role=roles/run.invoker` |
| version 不一致 | 檢查兩邊是否設了 `APP_VERSION`；重新執行 Deploy |
| GitHub Actions 驗證 GCP 失敗 | WIF 只接受 `main` 分支上的 `deploy.yml`；確認 `GCP_WIF_PROVIDER`、`GCP_DEPLOY_SA` 與 `gcp-setup.sh` 印出的一致 |
| `railway up` 未授權 | `RAILWAY_TOKEN` 必須是 project token（不是 account token），且綁定正式環境 |

## 11. 已知限制

- `/api/health` 只回報 `package.json` 的 version，同一版本的不同 commit 無法從 HTTP 區分；
  commit 記錄在 Cloud Run 的 `commit-sha` label 與 Railway 部署訊息（`deploy-all <SHA> v<version>`）。
- 每日健康檢查不比對兩邊環境變數。
- 本文件的切換方式是修改 LINE 設定，不切換 `hr.clmcolor.com` 的 DNS。
