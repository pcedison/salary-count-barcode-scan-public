#!/usr/bin/env bash
# Cloud Run 冷備援的一次性 GCP 設定。在 GCP Cloud Shell 以專案擁有者執行；可重複執行（冪等）。
# 詳細說明見 docs/RAILWAY_CLOUDRUN_DEPLOYMENT.md。
#
# 做的事：
#   1. 啟用 --source 部署與 Workload Identity Federation 需要的 API
#   2. 建立三個服務帳號並只給最小角色：
#        執行期 salary-standby-runtime：不給任何專案角色（只連外部 PostgreSQL）
#        建置用 salary-standby-build：roles/run.builder
#        部署用 salary-github-deployer：roles/run.sourceDeveloper、
#          roles/serviceusage.serviceUsageConsumer，並可 actAs 上面兩個帳號
#   3. 建立 GitHub OIDC 的 Workload Identity Pool／Provider，只接受
#      本 repo 的 main 分支上的 deploy.yml，並把部署用帳號綁給它
#   4. Artifact Registry repo cloud-run-source-deploy 只保留最近 2 版映像
#   5. 預算警示（US$1，50%／90%／100% 寄信給帳單帳戶管理員）
#   6. 印出要填到 GitHub repo variables 的值（都不是祕密）
#
# 選填環境變數：GCP_PROJECT_ID（預設 gcloud 目前專案）、CLOUD_RUN_REGION、CLOUD_RUN_SERVICE、
#   GITHUB_REPOSITORY（預設 pcedison/salary-count-barcode-scan-public）、
#   WIF_POOL_ID、WIF_PROVIDER_ID、BUDGET_AMOUNT（例如 30TWD；帳單幣別不是 USD 時使用）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib/cloudrun-common.sh
source "${SCRIPT_DIR}/lib/cloudrun-common.sh"

GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-pcedison/salary-count-barcode-scan-public}"
readonly DEPLOY_WORKFLOW=".github/workflows/deploy.yml"
readonly ALLOWED_REF="refs/heads/main"
WIF_POOL_ID="${WIF_POOL_ID:-github-actions}"
WIF_PROVIDER_ID="${WIF_PROVIDER_ID:-salary-deploy-main}"
readonly SOURCE_DEPLOY_REPO="cloud-run-source-deploy"
readonly BUDGET_DISPLAY_NAME="salary-standby-budget"

# --source 部署（Cloud Run SubmitBuild → Cloud Build → Artifact Registry，原始碼先上傳到
# Cloud Storage）與 GitHub OIDC → STS → 服務帳號扮演（IAM Credentials）需要的 API。
readonly REQUIRED_APIS=(
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  storage.googleapis.com
  logging.googleapis.com
  iam.googleapis.com
  iamcredentials.googleapis.com
  sts.googleapis.com
  cloudresourcemanager.googleapis.com
  serviceusage.googleapis.com
  cloudbilling.googleapis.com
  billingbudgets.googleapis.com
)

log() { printf '[gcp-setup] %s\n' "$*"; }
warn() { printf '[gcp-setup] 注意：%s\n' "$*" >&2; }
fail() {
  printf '[gcp-setup] 錯誤：%s\n' "$*" >&2
  exit 1
}

WORK_DIR=""
cleanup() { [[ -z "$WORK_DIR" ]] || rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# IAM 在帳號剛建立時有傳播延遲，綁定失敗就稍候重試。
retry() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if "$@"; then
      return 0
    fi
    warn "第 ${attempt} 次失敗，10 秒後重試"
    sleep 10
  done
  return 1
}

quietly() { "$@" >/dev/null; }

# ---------------------------------------------------------------------------
check_project() {
  command -v gcloud >/dev/null 2>&1 || fail "找不到 gcloud（請在 GCP Cloud Shell 執行）"
  GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
  [[ -n "$GCP_PROJECT_ID" ]] || fail "請先 gcloud config set project <專案 ID> 或設定 GCP_PROJECT_ID"
  CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-$DEFAULT_CLOUD_RUN_REGION}"
  CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-$DEFAULT_CLOUD_RUN_SERVICE}"

  PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
  [[ -n "$PROJECT_NUMBER" ]] || fail "讀不到專案編號"

  # 先啟用 Cloud Billing API，才能確認專案已連結帳單帳戶（Cloud Build／Cloud Run 必要）。
  gcloud services enable cloudbilling.googleapis.com --project "$GCP_PROJECT_ID"
  local billing_enabled
  billing_enabled="$(gcloud billing projects describe "$GCP_PROJECT_ID" --format='value(billingEnabled)')" \
    || fail "無法讀取專案的帳單設定"
  [[ "${billing_enabled,,}" == "true" ]] \
    || fail "專案沒有連結帳單帳戶。Cloud Build／Cloud Run 需要啟用帳單（在免費額度內不會收費）。"

  RUNTIME_SA="${RUNTIME_SA_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  BUILD_SA="${BUILD_SA_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  DEPLOY_SA="${DEPLOY_SA_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  log "專案 ${GCP_PROJECT_ID}（編號 ${PROJECT_NUMBER}），區域 ${CLOUD_RUN_REGION}"
}

enable_apis() {
  log "啟用 API：${REQUIRED_APIS[*]}"
  gcloud services enable "${REQUIRED_APIS[@]}" --project "$GCP_PROJECT_ID"
}

ensure_service_account() {
  local id="$1" display_name="$2" email="${1}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$email" --project "$GCP_PROJECT_ID" >/dev/null 2>&1; then
    log "服務帳號已存在：${email}"
  else
    log "建立服務帳號：${email}"
    gcloud iam service-accounts create "$id" --project "$GCP_PROJECT_ID" --display-name "$display_name"
  fi
}

grant_project_role() {
  local member="$1" role="$2"
  log "專案角色 ${role} → ${member}"
  retry quietly gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member "$member" --role "$role" --condition=None --quiet
}

grant_sa_role() {
  local target_sa="$1" member="$2" role="$3"
  log "服務帳號 ${target_sa} 上的 ${role} → ${member}"
  retry quietly gcloud iam service-accounts add-iam-policy-binding "$target_sa" \
    --project "$GCP_PROJECT_ID" --member "$member" --role "$role" --condition=None --quiet
}

setup_service_accounts() {
  ensure_service_account "$RUNTIME_SA_ID" "Salary standby runtime (Cloud Run)"
  ensure_service_account "$BUILD_SA_ID" "Salary standby source build"
  ensure_service_account "$DEPLOY_SA_ID" "Salary GitHub Actions deployer"

  # 執行期帳號刻意不給任何專案角色：程式只連外部 PostgreSQL，日誌由 Cloud Run 平台收集。
  # 建置用帳號：Cloud Run 文件指定的 Cloud Run Builder（讀原始碼、寫映像與建置日誌）。
  grant_project_role "serviceAccount:${BUILD_SA}" roles/run.builder
  # 部署用帳號：Cloud Run 文件「從原始碼部署」列出的部署者角色。
  grant_project_role "serviceAccount:${DEPLOY_SA}" roles/run.sourceDeveloper
  grant_project_role "serviceAccount:${DEPLOY_SA}" roles/serviceusage.serviceUsageConsumer
  # 只在這兩個帳號上授予 actAs，而不是整個專案。
  grant_sa_role "$RUNTIME_SA" "serviceAccount:${DEPLOY_SA}" roles/iam.serviceAccountUser
  grant_sa_role "$BUILD_SA" "serviceAccount:${DEPLOY_SA}" roles/iam.serviceAccountUser
}

setup_workload_identity() {
  local state
  state="$(gcloud iam workload-identity-pools describe "$WIF_POOL_ID" --project "$GCP_PROJECT_ID" \
    --location global --format='value(state)' 2>/dev/null || true)"
  case "$state" in
    "")
      log "建立 Workload Identity Pool：${WIF_POOL_ID}"
      gcloud iam workload-identity-pools create "$WIF_POOL_ID" --project "$GCP_PROJECT_ID" \
        --location global --display-name "GitHub Actions"
      ;;
    DELETED)
      log "復原先前刪除的 Workload Identity Pool：${WIF_POOL_ID}"
      gcloud iam workload-identity-pools undelete "$WIF_POOL_ID" --project "$GCP_PROJECT_ID" --location global
      ;;
    *) log "Workload Identity Pool 已存在：${WIF_POOL_ID}" ;;
  esac

  # 只有「本 repo、main 分支、deploy.yml」發出的 GitHub OIDC token 能進入。
  local mapping condition
  mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref"
  condition="assertion.repository == '${GITHUB_REPOSITORY}' && assertion.ref == '${ALLOWED_REF}' && assertion.workflow_ref == '${GITHUB_REPOSITORY}/${DEPLOY_WORKFLOW}@${ALLOWED_REF}'"

  state="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" --project "$GCP_PROJECT_ID" \
    --location global --workload-identity-pool "$WIF_POOL_ID" --format='value(state)' 2>/dev/null || true)"
  if [[ "$state" == "DELETED" ]]; then
    log "復原先前刪除的 Provider：${WIF_PROVIDER_ID}"
    gcloud iam workload-identity-pools providers undelete "$WIF_PROVIDER_ID" --project "$GCP_PROJECT_ID" \
      --location global --workload-identity-pool "$WIF_POOL_ID"
    state="ACTIVE"
  fi
  if [[ -z "$state" ]]; then
    log "建立 OIDC Provider：${WIF_PROVIDER_ID}"
    gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" --project "$GCP_PROJECT_ID" \
      --location global --workload-identity-pool "$WIF_POOL_ID" \
      --display-name "salary-count main deploy" \
      --issuer-uri "https://token.actions.githubusercontent.com" \
      --attribute-mapping "$mapping" \
      --attribute-condition "$condition"
  else
    log "更新 OIDC Provider 的對應與條件：${WIF_PROVIDER_ID}"
    gcloud iam workload-identity-pools providers update-oidc "$WIF_PROVIDER_ID" --project "$GCP_PROJECT_ID" \
      --location global --workload-identity-pool "$WIF_POOL_ID" \
      --issuer-uri "https://token.actions.githubusercontent.com" \
      --attribute-mapping "$mapping" \
      --attribute-condition "$condition"
  fi

  WIF_PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"
  grant_sa_role "$DEPLOY_SA" \
    "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPOSITORY}" \
    roles/iam.workloadIdentityUser
}

setup_artifact_cleanup() {
  if ! gcloud artifacts repositories describe "$SOURCE_DEPLOY_REPO" --project "$GCP_PROJECT_ID" \
    --location "$CLOUD_RUN_REGION" >/dev/null 2>&1; then
    warn "Artifact Registry repo ${SOURCE_DEPLOY_REPO} 還不存在（第一次 --source 部署時才會自動建立）。"
    warn "執行 deploy/cloudrun-env.sh bootstrap 之後，請再跑一次：bash deploy/gcp-setup.sh"
    return 0
  fi

  WORK_DIR="$(mktemp -d)"
  cat >"${WORK_DIR}/cleanup-policy.json" <<'JSON'
[
  {
    "name": "keep-latest-2",
    "action": { "type": "Keep" },
    "mostRecentVersions": { "keepCount": 2 }
  },
  {
    "name": "delete-older-than-1d",
    "action": { "type": "Delete" },
    "condition": { "tagState": "any", "olderThan": "1d" }
  }
]
JSON
  log "設定 ${SOURCE_DEPLOY_REPO} 清理規則：每個映像只保留最近 2 版（約一天內生效）"
  gcloud artifacts repositories set-cleanup-policies "$SOURCE_DEPLOY_REPO" --project "$GCP_PROJECT_ID" \
    --location "$CLOUD_RUN_REGION" --policy "${WORK_DIR}/cleanup-policy.json" --no-dry-run --quiet >/dev/null
}

print_budget_manual_steps() {
  cat >&2 <<EOF
[gcp-setup] 請改在主控台手動設定預算警示：
  Billing → Budgets & alerts → Create budget
    範圍：只選專案 ${GCP_PROJECT_ID}
    金額：US\$1（或等值台幣）
    門檻：50%、90%、100%（Actual），保留「Email alerts to billing admins and users」
EOF
}

setup_budget() {
  local billing_account account_id currency amount
  billing_account="$(gcloud billing projects describe "$GCP_PROJECT_ID" --format='value(billingAccountName)')"
  account_id="${billing_account#billingAccounts/}"
  currency="$(gcloud billing accounts describe "$account_id" --format='value(currencyCode)' 2>/dev/null || true)"

  amount="${BUDGET_AMOUNT:-}"
  if [[ -z "$amount" ]]; then
    if [[ -z "$currency" || "$currency" == "USD" ]]; then
      amount="1USD"
    else
      warn "帳單帳戶幣別是 ${currency}，不能用 USD 金額建立預算。可用 BUDGET_AMOUNT=30${currency} 重跑，或："
      print_budget_manual_steps
      return 0
    fi
  fi

  local existing
  existing="$(gcloud billing budgets list --billing-account "$account_id" --billing-project "$GCP_PROJECT_ID" \
    --format='value(displayName)' 2>/dev/null || true)"
  if grep -Fxq "$BUDGET_DISPLAY_NAME" <<<"$existing"; then
    log "預算 ${BUDGET_DISPLAY_NAME} 已存在，略過"
    return 0
  fi

  log "建立預算 ${BUDGET_DISPLAY_NAME}：${amount}，50%／90%／100% 寄信給帳單帳戶管理員與使用者"
  if ! gcloud billing budgets create --billing-account "$account_id" --billing-project "$GCP_PROJECT_ID" \
    --display-name "$BUDGET_DISPLAY_NAME" \
    --budget-amount "$amount" \
    --filter-projects "projects/${GCP_PROJECT_ID}" \
    --threshold-rule percent=0.5 \
    --threshold-rule percent=0.9 \
    --threshold-rule percent=1.0 >/dev/null; then
    warn "建立預算失敗（需要帳單帳戶的 Billing Account Administrator／Costs Manager 權限）"
    print_budget_manual_steps
  fi
}

print_github_settings() {
  cat <<EOF

================ GitHub repo 設定（Settings → Secrets and variables → Actions）================
Variables（都不是祕密）：
  GCP_PROJECT_ID        = ${GCP_PROJECT_ID}
  GCP_WIF_PROVIDER      = ${WIF_PROVIDER_NAME}
  GCP_DEPLOY_SA         = ${DEPLOY_SA}
  CLOUD_RUN_SERVICE     = ${CLOUD_RUN_SERVICE}
  CLOUD_RUN_REGION      = ${CLOUD_RUN_REGION}
  CLOUD_RUN_RUNTIME_SA  = ${RUNTIME_SA}
  CLOUD_RUN_BUILD_SA    = ${BUILD_SA}
  RAILWAY_SERVICE       = （Railway 服務名稱或 ID）
  PRIMARY_URL           = （主機網址，https://...）
  STANDBY_URL           = （bootstrap 完成後印出的 Cloud Run 網址）
Secret：
  RAILWAY_TOKEN         = （Railway project token，只放在 GitHub secret）

或用 gh CLI：
  gh variable set GCP_PROJECT_ID --body '${GCP_PROJECT_ID}'
  gh variable set GCP_WIF_PROVIDER --body '${WIF_PROVIDER_NAME}'
  gh variable set GCP_DEPLOY_SA --body '${DEPLOY_SA}'
  gh variable set CLOUD_RUN_SERVICE --body '${CLOUD_RUN_SERVICE}'
  gh variable set CLOUD_RUN_REGION --body '${CLOUD_RUN_REGION}'
  gh variable set CLOUD_RUN_RUNTIME_SA --body '${RUNTIME_SA}'
  gh variable set CLOUD_RUN_BUILD_SA --body '${BUILD_SA}'
  gh secret set RAILWAY_TOKEN      # 互動輸入，不要放在命令列
================================================================================================
EOF
}

main() {
  check_project
  enable_apis
  setup_service_accounts
  setup_workload_identity
  setup_artifact_cleanup
  setup_budget
  print_github_settings
}

main "$@"
