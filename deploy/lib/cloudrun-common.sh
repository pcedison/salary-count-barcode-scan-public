# shellcheck shell=bash disable=SC2034  # 這是被 source 的設定檔，變數由呼叫端使用。
# deploy-all.sh、cloudrun-env.sh、gcp-setup.sh 共用的 Cloud Run 備援設定。
# 都 source 這個檔，確保第一次建立與之後每次部署用的是同一組名稱與參數。

readonly DEFAULT_CLOUD_RUN_SERVICE="salary-scan-standby"
readonly DEFAULT_CLOUD_RUN_REGION="asia-east1"

# deploy/gcp-setup.sh 建立的服務帳號 ID（email 為 <ID>@<專案>.iam.gserviceaccount.com）。
readonly RUNTIME_SA_ID="salary-standby-runtime"   # Cloud Run 執行期身分，不給任何專案角色
readonly BUILD_SA_ID="salary-standby-build"       # --source 建置用，只有 roles/run.builder
readonly DEPLOY_SA_ID="salary-github-deployer"    # GitHub Actions 透過 WIF 扮演的部署身分

# LINE Login callback 路由（server/routes/line/auth.routes.ts）。
readonly LINE_CALLBACK_PATH="/api/line/callback"

# 服務 label：standby（平常）或 active（主機故障、由 Cloud Run 接手）。
# deploy-all.sh 依此決定要不要保留接手模式的 min-instances 1 與 --no-cpu-throttling。
readonly STANDBY_MODE_LABEL="standby-mode"

# gcloud 若被設定成記錄 HTTP 內容（core/log_http），describe／deploy 的回應會帶出
# 環境變數值；這裡強制關閉。
export CLOUDSDK_CORE_LOG_HTTP=false

# 每次部署都要套用的 revision 設定（不含擴縮與存取權，那兩項視情況決定）。
#   --cpu-boost：冷啟動時暫時多給 CPU，縮短備援第一個請求的等待。
#   --startup-probe /ready：/ready 會實際查詢資料庫（SELECT 1）。新 revision 連不上
#     資料庫或環境變數驗證失敗時，部署會失敗並保留舊 revision 繼續服務。
CLOUD_RUN_REVISION_ARGS=(
  --cpu 1
  --memory 1Gi
  --max-instances 1
  --cpu-boost
  --port 8080
  --startup-probe 'httpGet.path=/ready,httpGet.port=8080,periodSeconds=3,timeoutSeconds=3,failureThreshold=40'
)

# 平常（standby）與接手（active）時的擴縮設定。
CLOUD_RUN_STANDBY_SCALING_ARGS=(--min-instances 0 --cpu-throttling)
CLOUD_RUN_ACTIVE_SCALING_ARGS=(--min-instances 1 --no-cpu-throttling)

# 把服務帳號 email 轉成 --build-service-account 需要的資源名稱格式。
# cloudrun_build_sa_resource <project_id> <email 或 projects/.../serviceAccounts/...>
cloudrun_build_sa_resource() {
  local project_id="$1" build_sa="$2"
  if [[ "$build_sa" == */serviceAccounts/* ]]; then
    printf '%s' "$build_sa"
  else
    printf 'projects/%s/serviceAccounts/%s' "$project_id" "$build_sa"
  fi
}

# Must run before any legacy deploy/update or dotenv loading. Read only metadata;
# a failed lookup is not interpreted as an absent service.
assert_legacy_cloud_run_target() {
  local services
  services="$(gcloud run services list --project "$GCP_PROJECT_ID" --region "$CLOUD_RUN_REGION" \
    --format='json(metadata.name,metadata.labels,spec.template.metadata.labels)')" \
    || { printf 'Unable to verify legacy Cloud Run target; refusing changes\n' >&2; return 1; }
  jq -e --arg name "$CLOUD_RUN_SERVICE" '
    type == "array" and all(.[] | select(.metadata.name == $name);
      .metadata.labels["attendance-role"] != "primary" and
      .spec.template.metadata.labels["attendance-role"] != "primary")
  ' <<<"$services" >/dev/null \
    || { printf 'Legacy standby tooling cannot modify an attendance primary service\n' >&2; return 1; }
}
