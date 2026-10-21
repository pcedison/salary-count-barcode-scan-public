#!/usr/bin/env bash
# 在 GCP Cloud Shell 管理 Cloud Run 冷備援（環境變數與接手模式）。
# 詳細流程見 docs/RAILWAY_CLOUDRUN_DEPLOYMENT.md。
#
#   bootstrap <dotenv 檔>  讀 Zeabur 匯出的 .env，第一次建立（或整批重設）Cloud Run 服務
#   update <dotenv 檔>     只更新檔案裡列出的變數（例如換金鑰），其餘保留
#   status                 顯示網址、模式、commit 與變數「名稱」（不顯示值）
#   activate               主機故障時：讓 Cloud Run 接手（min-instances 1、CPU 常駐）
#   standby                主機恢復後：回到冷備援（min-instances 0、CPU 節流、關閉薪資自動化）
#
# 環境變數（皆選填）：GCP_PROJECT_ID（預設 gcloud 目前專案）、CLOUD_RUN_SERVICE、
#   CLOUD_RUN_REGION、CLOUD_RUN_RUNTIME_SA、CLOUD_RUN_BUILD_SA、PRIMARY_URL
#   （bootstrap 必填，例如主機網址）、STANDBY_URL（覆寫預測的 run.app 網址）、
#   BOOTSTRAP_ASSUME_YES=1（服務已存在時不再詢問）
#
# 祕密值永遠不印出；暫存檔放在 umask 077 的 mktemp 目錄，結束時刪除。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=deploy/lib/cloudrun-common.sh
source "${SCRIPT_DIR}/lib/cloudrun-common.sh"
ENVTOOL="${SCRIPT_DIR}/lib/envtool.py"

log() { printf '[cloudrun-env] %s\n' "$*"; }
fail() {
  printf '[cloudrun-env] 錯誤：%s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

WORK_DIR=""
cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    if command -v shred >/dev/null 2>&1; then
      find "$WORK_DIR" -type f -exec shred -u {} + 2>/dev/null || true
    fi
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

make_work_dir() {
  umask 077
  WORK_DIR="$(mktemp -d)"
  chmod 700 "$WORK_DIR"
}

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------
load_config() {
  local tool
  for tool in gcloud jq python3 git; do
    command -v "$tool" >/dev/null 2>&1 || fail "缺少指令：${tool}"
  done

  GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
  [[ -n "$GCP_PROJECT_ID" ]] || fail "請設定 GCP_PROJECT_ID 或執行 gcloud config set project <專案 ID>"
  CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-$DEFAULT_CLOUD_RUN_SERVICE}"
  CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-$DEFAULT_CLOUD_RUN_REGION}"
  CLOUD_RUN_RUNTIME_SA="${CLOUD_RUN_RUNTIME_SA:-${RUNTIME_SA_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
  CLOUD_RUN_BUILD_SA="${CLOUD_RUN_BUILD_SA:-${BUILD_SA_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
  GCLOUD_TARGET=(--project "$GCP_PROJECT_ID" --region "$CLOUD_RUN_REGION")
  log "專案 ${GCP_PROJECT_ID}，服務 ${CLOUD_RUN_SERVICE}（${CLOUD_RUN_REGION}）"
}

service_exists() {
  gcloud run services describe "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" --format='value(metadata.name)' >/dev/null 2>&1
}

# 完整描述含環境變數值，只寫進暫存檔，不輸出到終端。
describe_to_file() {
  gcloud run services describe "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" --format=json >"$1"
}

require_dotenv() {
  local dotenv="${1:-}"
  [[ -n "$dotenv" ]] || fail "請指定 .env 檔路徑"
  [[ -f "$dotenv" ]] || fail "找不到檔案：${dotenv}"
  DOTENV_PATH="$(cd "$(dirname "$dotenv")" && pwd)/$(basename "$dotenv")"
  # 放在 repo 裡又沒被 .gitignore 擋住的話，可能被 commit 或隨原始碼上傳。
  case "$DOTENV_PATH" in
    "$REPO_ROOT"/*)
      if ! git -C "$REPO_ROOT" check-ignore -q "$DOTENV_PATH"; then
        fail ".env 檔在 repo 內且未被 .gitignore 排除；請移到 repo 外（例如 ~/zeabur.env）"
      fi
      ;;
  esac
}

require_clean_main() {
  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)"
  [[ -z "$dirty" ]] || fail "工作樹不乾淨；請先 git stash 或刪除未追蹤檔案（--source 會上傳整個目錄）"
  git -C "$REPO_ROOT" fetch --quiet --no-tags origin "+refs/heads/main:refs/remotes/origin/main" \
    || fail "git fetch origin main 失敗"
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)" ]] \
    || fail "HEAD 不等於 origin/main；請 git checkout main && git pull 後再執行"
  COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
}

require_service_accounts() {
  local sa
  for sa in "$CLOUD_RUN_RUNTIME_SA" "$CLOUD_RUN_BUILD_SA"; do
    gcloud iam service-accounts describe "$sa" --project "$GCP_PROJECT_ID" --format='value(email)' >/dev/null 2>&1 \
      || fail "找不到服務帳號 ${sa}；請先執行 bash deploy/gcp-setup.sh"
  done
}

normalize_primary_url() {
  PRIMARY_URL="${PRIMARY_URL:-}"
  PRIMARY_URL="${PRIMARY_URL%/}"
  [[ "$PRIMARY_URL" =~ ^https://[^/[:space:]]+$ ]] \
    || fail "請設定 PRIMARY_URL（主機網址，例如 PRIMARY_URL=https://主機網域，不含路徑）"
}

# 依 Cloud Run「固定格式網址」預測備援網址：https://<服務>-<專案編號>.<區域>.run.app
predicted_standby_url() {
  local project_number
  project_number="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
  [[ -n "$project_number" ]] || fail "讀不到專案編號"
  printf 'https://%s-%s.%s.run.app' "$CLOUD_RUN_SERVICE" "$project_number" "$CLOUD_RUN_REGION"
}

# 列出服務實際可用的網址（status.url 與 run.googleapis.com/urls 註記）。
service_urls() {
  gcloud run services describe "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" \
    --format='json(status.url,metadata.annotations)' \
    | jq -r '[.status.url] + ((.metadata.annotations["run.googleapis.com/urls"] // "[]") | fromjson? // []) | map(select(. != null)) | unique | .[]'
}

# ---------------------------------------------------------------------------
# 子指令
# ---------------------------------------------------------------------------
cmd_bootstrap() {
  load_config
  require_dotenv "${1:-}"
  normalize_primary_url
  require_clean_main
  require_service_accounts
  make_work_dir

  local standby_url="${STANDBY_URL:-$(predicted_standby_url)}"
  standby_url="${standby_url%/}"
  local current_args=()
  if service_exists; then
    log "服務已存在。bootstrap 會用 .env 的內容「整批取代」所有環境變數，並把服務改回冷備援：min-instances 0、CPU 節流、SALARY_AUTOMATION_ENABLED=false、label ${STANDBY_MODE_LABEL}=standby。接手期間請改用 update。"
    if [[ "${BOOTSTRAP_ASSUME_YES:-}" != "1" ]]; then
      local answer=""
      read -r -p "確定要繼續嗎？輸入 yes 繼續：" answer
      [[ "$answer" == "yes" ]] || fail "已取消"
    fi
    describe_to_file "${WORK_DIR}/current.json"
    current_args=(--current "${WORK_DIR}/current.json")
  fi

  log "轉換 .env（只列變數名稱）："
  python3 -I "$ENVTOOL" build --mode bootstrap --dotenv "$DOTENV_PATH" --repo-root "$REPO_ROOT" \
    --out "${WORK_DIR}/env.yaml" --primary-url "$PRIMARY_URL" --standby-url "$standby_url" \
    ${current_args[@]+"${current_args[@]}"}

  log "從 commit ${COMMIT_SHA} 建置並部署（第一次約需 5–10 分鐘）..."
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --source "$REPO_ROOT" \
    "${GCLOUD_TARGET[@]}" \
    "${CLOUD_RUN_REVISION_ARGS[@]}" \
    "${CLOUD_RUN_STANDBY_SCALING_ARGS[@]}" \
    --env-vars-file "${WORK_DIR}/env.yaml" \
    --service-account "$CLOUD_RUN_RUNTIME_SA" \
    --build-service-account "$(cloudrun_build_sa_resource "$GCP_PROJECT_ID" "$CLOUD_RUN_BUILD_SA")" \
    --allow-unauthenticated \
    --update-labels "commit-sha=${COMMIT_SHA},${STANDBY_MODE_LABEL}=standby" \
    --quiet \
    || fail "部署失敗。若卡在啟動檢查（/ready），多半是資料庫連不上或環境變數驗證失敗，請到 Cloud Run 主控台看日誌。"

  # 預測的網址若不在服務實際網址中，改用 status.url 重設三個網址變數。
  local urls actual_url
  urls="$(service_urls)"
  actual_url="$(gcloud run services describe "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" --format='value(status.url)')"
  if ! grep -Fxq "$standby_url" <<<"$urls"; then
    log "預測的網址不可用，改用服務網址重設 ALLOWED_ORIGINS／LINE_LOGIN_CALLBACK_URL／SALARY_AUTOMATION_PUBLIC_BASE_URL"
    standby_url="${actual_url%/}"
    describe_to_file "${WORK_DIR}/current.json"
    local rc=0
    python3 -I "$ENVTOOL" build --mode retarget --repo-root "$REPO_ROOT" --current "${WORK_DIR}/current.json" \
      --out "${WORK_DIR}/retarget.yaml" --primary-url "$PRIMARY_URL" --standby-url "$standby_url" || rc=$?
    if ((rc == 0)); then
      gcloud run services update "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" \
        --env-vars-file "${WORK_DIR}/retarget.yaml" --quiet
    elif ((rc != 3)); then
      fail "重設網址變數失敗"
    fi
  fi

  log "完成。備援網址：${standby_url}"
  cat <<EOF

接下來（見 docs/RAILWAY_CLOUDRUN_DEPLOYMENT.md）：
  1. GitHub repo variables：STANDBY_URL=${standby_url}
  2. LINE Developers → LINE Login channel → Callback URL 加上：
       ${standby_url}${LINE_CALLBACK_PATH}
     （Webhook URL 與 LIFF Endpoint URL 平常維持主機，切換時才改）
  3. 驗證：curl -fsS ${standby_url}/ready
  4. 刪除 Zeabur 匯出檔：shred -u '${DOTENV_PATH}'
EOF
}

cmd_update() {
  load_config
  require_dotenv "${1:-}"
  service_exists || fail "服務不存在；第一次請用 bootstrap"
  make_work_dir
  describe_to_file "${WORK_DIR}/current.json"

  log "合併 .env（只列變數名稱）："
  local rc=0
  python3 -I "$ENVTOOL" build --mode update --dotenv "$DOTENV_PATH" --repo-root "$REPO_ROOT" \
    --current "${WORK_DIR}/current.json" --out "${WORK_DIR}/env.yaml" || rc=$?
  if ((rc == 3)); then
    log "沒有任何變更，不更新服務"
    return 0
  elif ((rc != 0)); then
    fail "合併失敗"
  fi

  log "套用到 Cloud Run（會建立新 revision，映像不變）..."
  gcloud run services update "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" \
    --env-vars-file "${WORK_DIR}/env.yaml" --quiet \
    || fail "更新失敗；舊 revision 仍在服務。請到 Cloud Run 主控台看新 revision 的日誌。"
  log "完成。別忘了 Railway 主機也要更新同樣的變數。"
}

cmd_status() {
  load_config
  service_exists || fail "服務不存在"
  gcloud run services describe "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" --format=json \
    | jq -r --arg mode "$STANDBY_MODE_LABEL" '
        "網址：" + (.status.url // "?"),
        "模式：" + (.metadata.labels[$mode] // "standby"),
        "commit：" + (.metadata.labels["commit-sha"] // "?"),
        "revision：" + (.status.latestReadyRevisionName // "?"),
        "min-instances：" + (.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"),
        "CPU 節流：" + (.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"] // "true"),
        "環境變數名稱：",
        (.spec.template.spec.containers[0].env // [] | map("  " + .name) | .[])'
}

cmd_activate() {
  load_config
  service_exists || fail "服務不存在"
  log "切換為接手模式：min-instances 1、CPU 常駐（--no-cpu-throttling，程式內排程才會跑）"
  gcloud run services update "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" \
    "${CLOUD_RUN_ACTIVE_SCALING_ARGS[@]}" \
    --update-labels "${STANDBY_MODE_LABEL}=active" --quiet
  cat <<EOF

已切換。接手期間還需要（見 docs/RAILWAY_CLOUDRUN_DEPLOYMENT.md「切換到備援」）：
  - LINE Developers：Messaging API Webhook URL 與 LIFF Endpoint URL 改成備援網址
  - 確認 Railway 主機已停止或確定不會恢復後，才考慮開薪資自動化（同一時間只能一台開）：
      gcloud run services update ${CLOUD_RUN_SERVICE} --project ${GCP_PROJECT_ID} --region ${CLOUD_RUN_REGION} \\
        --update-env-vars SALARY_AUTOMATION_ENABLED=true
EOF
}

cmd_standby() {
  load_config
  service_exists || fail "服務不存在"
  log "回到冷備援：min-instances 0、CPU 節流、SALARY_AUTOMATION_ENABLED=false"
  gcloud run services update "$CLOUD_RUN_SERVICE" "${GCLOUD_TARGET[@]}" \
    "${CLOUD_RUN_STANDBY_SCALING_ARGS[@]}" \
    --update-env-vars SALARY_AUTOMATION_ENABLED=false \
    --update-labels "${STANDBY_MODE_LABEL}=standby" --quiet
  log "完成。記得把 LINE Webhook URL 與 LIFF Endpoint URL 改回主機。"
}

main() {
  local command="${1:-}"
  shift || true
  case "$command" in
    bootstrap) cmd_bootstrap "$@" ;;
    update) cmd_update "$@" ;;
    status) cmd_status ;;
    activate) cmd_activate ;;
    standby) cmd_standby ;;
    -h | --help | help | "") usage ;;
    *)
      usage >&2
      fail "未知的子指令：${command}"
      ;;
  esac
}

main "$@"
