#!/usr/bin/env bash
# 一個指令把「同一個 commit」部署到兩邊：
#   1. Google Cloud Run（冷備援，先部署，當作金絲雀：建置失敗或連不上資料庫就停在這裡）
#   2. Railway（主機）
# 然後對兩邊打 /live 與 /api/health，確認 version 都等於 package.json。
#
# 主要執行處是 GitHub Actions（.github/workflows/deploy.yml），任何裝有
# git、jq、curl、railway CLI 與已登入 gcloud 的環境也能跑。
# 詳細流程見 docs/RAILWAY_CLOUDRUN_DEPLOYMENT.md。
#
# 必要環境變數：RAILWAY_TOKEN（Railway project token）、RAILWAY_SERVICE、GCP_PROJECT_ID
# 選填：CLOUD_RUN_SERVICE、CLOUD_RUN_REGION、CLOUD_RUN_RUNTIME_SA、CLOUD_RUN_BUILD_SA
#       （兩個 SA 預設為 gcp-setup.sh 建立的帳號）、PRIMARY_URL、VERIFY_TIMEOUT_SECONDS、
#       RAILWAY_DEPLOY_TIMEOUT_SECONDS
#
# 本腳本自己的訊息只印變數名稱，不印任何環境變數的值；gcloud／railway CLI 本身會顯示
# 服務名稱、專案 ID、Cloud Run 網址與建置日誌等非機密資訊。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib/cloudrun-common.sh
source "${SCRIPT_DIR}/lib/cloudrun-common.sh"

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

log() { printf '[deploy-all] %s\n' "$*"; }
warn() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::warning::%s\n' "$*"
  else
    printf '[deploy-all] 警告：%s\n' "$*" >&2
  fi
}
fail() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error::%s\n' "$*"
  fi
  printf '[deploy-all] 錯誤：%s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 前置檢查
# ---------------------------------------------------------------------------
require_tools() {
  local missing=()
  local tool
  for tool in git jq curl gcloud railway timeout; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if ((${#missing[@]} > 0)); then
    fail "缺少指令：${missing[*]}"
  fi
}

require_env() {
  local missing=()
  local name
  for name in RAILWAY_TOKEN RAILWAY_SERVICE GCP_PROJECT_ID; do
    [[ -n "${!name:-}" ]] || missing+=("$name")
  done
  if ((${#missing[@]} > 0)); then
    fail "缺少必要環境變數：${missing[*]}（GitHub Actions 請設定 repo variables 與 secret RAILWAY_TOKEN）"
  fi

  if [[ -n "${PRIMARY_URL:-}" && ! "${PRIMARY_URL}" =~ ^https:// ]]; then
    fail "PRIMARY_URL 必須以 https:// 開頭"
  fi
}

require_clean_main() {
  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "必須在 git repo 內執行"
  cd "$repo_root"

  local dirty
  dirty="$(git status --porcelain --untracked-files=normal)"
  if [[ -n "$dirty" ]]; then
    printf '%s\n' "$dirty" | sed 's/^/  /' >&2
    fail "工作樹不乾淨（上面列出未 commit 或未追蹤的檔案）。部署只接受乾淨的 origin/main。"
  fi

  log "取得 origin/main ..."
  git fetch --quiet --no-tags origin "+refs/heads/main:refs/remotes/origin/main" \
    || fail "git fetch origin main 失敗"

  COMMIT_SHA="$(git rev-parse HEAD)"
  local remote_sha
  remote_sha="$(git rev-parse refs/remotes/origin/main)"
  if [[ "$COMMIT_SHA" != "$remote_sha" ]]; then
    fail "HEAD（${COMMIT_SHA}）不等於 origin/main（${remote_sha}）。請 checkout 最新的 main 後再部署。"
  fi

  APP_VERSION="$(jq -r '.version // empty' package.json)"
  [[ -n "$APP_VERSION" ]] || fail "無法從 package.json 讀到 version"

  log "commit：${COMMIT_SHA}"
  log "package.json version：${APP_VERSION}"
}

# ---------------------------------------------------------------------------
# HTTP 驗證
# ---------------------------------------------------------------------------
# probe_service <顯示名稱> <base_url> <timeout 秒>
# 反覆打 /live 與 /api/health，直到兩者都 200、status=healthy 且 version 等於 package.json。
probe_service() {
  local label="$1" base_url="${2%/}" timeout_s="$3"
  local deadline=$((SECONDS + timeout_s))
  local delay=2 attempt=0
  local live_code health_code health_body status version

  while :; do
    attempt=$((attempt + 1))
    live_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "${base_url}/live" 2>/dev/null || true)"
    health_body="$(curl -sS --max-time 30 -w '\n%{http_code}' "${base_url}/api/health" 2>/dev/null || true)"
    health_code="${health_body##*$'\n'}"
    health_body="${health_body%$'\n'*}"
    status="$(jq -r '.status // empty' <<<"$health_body" 2>/dev/null || true)"
    version="$(jq -r '.version // empty' <<<"$health_body" 2>/dev/null || true)"

    if [[ "$live_code" == "200" && "$health_code" == "200" && "$status" == "healthy" && "$version" == "$APP_VERSION" ]]; then
      log "${label}：/live 200、/api/health 200（healthy，version ${version}），第 ${attempt} 次嘗試通過"
      return 0
    fi

    if ((SECONDS >= deadline)); then
      warn "${label}：驗證逾時（${timeout_s} 秒）。最後一次結果：/live=${live_code:-無回應} /api/health=${health_code:-無回應} status=${status:-?} version=${version:-?}（預期 ${APP_VERSION}）"
      if [[ "$live_code" == "403" || "$health_code" == "403" ]]; then
        warn "${label}：收到 403。Cloud Run 可能沒有開放未驗證存取（allUsers 的 roles/run.invoker），LINE webhook 會打不進來。請在 Cloud Shell 執行 docs/RAILWAY_CLOUDRUN_DEPLOYMENT.md 裡的 add-iam-policy-binding 指令。"
      fi
      return 1
    fi

    log "${label}：尚未就緒（/live=${live_code:-無回應} /api/health=${health_code:-無回應} version=${version:-?}），${delay} 秒後重試"
    sleep "$delay"
    delay=$((delay * 2))
    if ((delay > 15)); then
      delay=15
    fi
  done
}

# ---------------------------------------------------------------------------
# Cloud Run
# ---------------------------------------------------------------------------
cloud_run_describe() {
  # 只投影需要的欄位，避免把 spec.template 裡的環境變數值讀進來。
  gcloud run services describe "$CLOUD_RUN_SERVICE" \
    --project "$GCP_PROJECT_ID" --region "$CLOUD_RUN_REGION" \
    --format='json(metadata.labels,metadata.annotations,status.url,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic)'
}

cloud_run_is_public() {
  local annotations_json="$1"
  if [[ "$(jq -r '.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] // ""' <<<"$annotations_json")" == "true" ]]; then
    return 0
  fi
  gcloud run services get-iam-policy "$CLOUD_RUN_SERVICE" \
    --project "$GCP_PROJECT_ID" --region "$CLOUD_RUN_REGION" --format=json \
    | jq -e 'any(.bindings[]? | select(.role == "roles/run.invoker") | .members[]?; . == "allUsers")' >/dev/null
}

deploy_cloud_run() {
  assert_legacy_cloud_run_target || fail "歷史雙平台部署不得修改新的考勤主機"
  log "=== Cloud Run（備援）==="

  local before
  if ! before="$(cloud_run_describe)"; then
    fail "找不到或無法讀取 Cloud Run 服務（CLOUD_RUN_SERVICE／CLOUD_RUN_REGION）。第一次請先在 Cloud Shell 執行 deploy/cloudrun-env.sh bootstrap。"
  fi

  local mode
  mode="$(jq -r --arg k "$STANDBY_MODE_LABEL" '.metadata.labels[$k] // "standby"' <<<"$before")"

  local scaling_args=()
  if [[ "$mode" == "active" ]]; then
    warn "Cloud Run 目前是接手模式（label ${STANDBY_MODE_LABEL}=active），本次部署保留 min-instances 1 與 --no-cpu-throttling。"
    scaling_args=("${CLOUD_RUN_ACTIVE_SCALING_ARGS[@]}")
  else
    scaling_args=("${CLOUD_RUN_STANDBY_SCALING_ARGS[@]}")
  fi

  local access_args=()
  if cloud_run_is_public "$before"; then
    log "Cloud Run 已開放未驗證存取，部署時保留現有 IAM 設定"
  else
    warn "Cloud Run 尚未開放未驗證存取，本次部署加上 --allow-unauthenticated（部署用服務帳號沒有 setIamPolicy 權限時，gcloud 只會警告，之後的 HTTP 驗證會失敗）"
    access_args=(--allow-unauthenticated)
  fi

  # 與 cloudrun-env.sh 相同的預設值（deploy/gcp-setup.sh 建立的帳號），每次部署都明確指定，
  # 不依賴服務上前一次部署留下的設定。
  local identity_args=(
    --service-account "$CLOUD_RUN_RUNTIME_SA"
    --build-service-account "$(cloudrun_build_sa_resource "$GCP_PROJECT_ID" "$CLOUD_RUN_BUILD_SA")"
  )

  # 不帶 --set-env-vars／--env-vars-file：保留服務上既有的環境變數，只換映像。
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --source . \
    --project "$GCP_PROJECT_ID" \
    --region "$CLOUD_RUN_REGION" \
    "${CLOUD_RUN_REVISION_ARGS[@]}" \
    "${scaling_args[@]}" \
    ${access_args[@]+"${access_args[@]}"} \
    "${identity_args[@]}" \
    --update-labels "commit-sha=${COMMIT_SHA}" \
    --quiet \
    || fail "Cloud Run 部署失敗（見上方 gcloud 訊息），Railway 尚未變動。若卡在啟動檢查（/ready），多半是資料庫連不上或環境變數驗證失敗。"

  local after
  after="$(cloud_run_describe)"
  CLOUD_RUN_URL="$(jq -r '.status.url // empty' <<<"$after")"
  [[ -n "$CLOUD_RUN_URL" ]] || fail "部署後讀不到 Cloud Run 服務網址"

  local latest_ready latest_created serving_latest deployed_sha
  latest_ready="$(jq -r '.status.latestReadyRevisionName // empty' <<<"$after")"
  latest_created="$(jq -r '.status.latestCreatedRevisionName // empty' <<<"$after")"
  serving_latest="$(jq -r '[.status.traffic[]? | select(.latestRevision == true) | .percent // 0] | add // 0' <<<"$after")"
  deployed_sha="$(jq -r '.metadata.labels["commit-sha"] // empty' <<<"$after")"

  [[ -n "$latest_ready" && "$latest_ready" == "$latest_created" ]] \
    || fail "Cloud Run 最新 revision 尚未就緒（ready=${latest_ready:-無}，created=${latest_created:-無}）"
  [[ "$serving_latest" == "100" ]] \
    || fail "Cloud Run 流量沒有 100% 指向最新 revision（目前 ${serving_latest}%）。請在主控台或用 gcloud run services update-traffic --to-latest 修正。"
  [[ "$deployed_sha" == "$COMMIT_SHA" ]] \
    || fail "Cloud Run 的 commit-sha label 與本次 commit 不符"

  CLOUD_RUN_REVISION="$latest_ready"
  log "Cloud Run 部署完成：revision ${CLOUD_RUN_REVISION}，網址 ${CLOUD_RUN_URL}"
}

# ---------------------------------------------------------------------------
# Railway
# ---------------------------------------------------------------------------
deploy_railway() {
  log "=== Railway（主機）==="
  # --ci：只串流建置日誌，並等到部署進入 SUCCESS（健康檢查通過、切換流量）才回 0；
  #       FAILED／CRASHED 回 1。project token 已綁定專案與環境，只需指定 service。
  local rc=0
  timeout "${RAILWAY_DEPLOY_TIMEOUT_SECONDS:-1800}" \
    railway up --ci --service "$RAILWAY_SERVICE" \
    --message "deploy-all ${COMMIT_SHA:0:12} v${APP_VERSION}" || rc=$?

  if ((rc == 124)); then
    fail "Railway 部署等待逾時。Cloud Run 已是新版本，兩邊可能不一致；請到 Railway 主控台確認。"
  elif ((rc != 0)); then
    fail "Railway 部署失敗（exit ${rc}）。Cloud Run 已是新版本，兩邊可能不一致；修正後請重新執行部署。"
  fi
  log "Railway 部署完成（狀態 SUCCESS）"
}

main() {
  require_tools
  require_env
  require_clean_main

  CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-$DEFAULT_CLOUD_RUN_SERVICE}"
  CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-$DEFAULT_CLOUD_RUN_REGION}"
  CLOUD_RUN_RUNTIME_SA="${CLOUD_RUN_RUNTIME_SA:-${RUNTIME_SA_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
  CLOUD_RUN_BUILD_SA="${CLOUD_RUN_BUILD_SA:-${BUILD_SA_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
  local verify_timeout="${VERIFY_TIMEOUT_SECONDS:-120}"

  deploy_cloud_run
  deploy_railway

  log "=== 部署後驗證 ==="
  local failed=0
  probe_service "Cloud Run 備援" "$CLOUD_RUN_URL" "$verify_timeout" || failed=1
  if [[ -n "${PRIMARY_URL:-}" ]]; then
    probe_service "Railway 主機（PRIMARY_URL）" "$PRIMARY_URL" "$verify_timeout" || failed=1
  else
    warn "未設定 PRIMARY_URL，略過主機的 HTTP 驗證"
  fi

  ((failed == 0)) || fail "部署後驗證失敗：至少一邊沒有回報 version ${APP_VERSION}"

  log "完成：commit ${COMMIT_SHA}（v${APP_VERSION}）已部署到 Railway 與 Cloud Run（${CLOUD_RUN_REVISION}）"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    local primary_note="（未設定 PRIMARY_URL，未做 HTTP 驗證）"
    if [[ -n "${PRIMARY_URL:-}" ]]; then
      primary_note="，HTTP 驗證通過"
    fi
    {
      echo "### 部署完成"
      echo ""
      echo "- commit：\`${COMMIT_SHA}\`"
      echo "- version：\`${APP_VERSION}\`"
      echo "- Railway：SUCCESS${primary_note}"
      echo "- Cloud Run：\`${CLOUD_RUN_REVISION}\`，HTTP 驗證通過"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

main "$@"
