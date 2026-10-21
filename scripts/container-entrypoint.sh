#!/bin/sh
# 容器進入點（Dockerfile ENTRYPOINT）。應用程式一律以 node 使用者執行。
#
# - 以 node 啟動（Dockerfile 預設 USER node；Cloud Run、Zeabur、CI 都是這樣）：直接 exec。
# - 以 root 啟動（Railway 掛 volume 時設 RAILWAY_RUN_UID=0；Railway 的 volume 以 root 擁有）：
#   只在 volume 掛載路徑（RAILWAY_VOLUME_MOUNT_PATH，未設時 /data）底下，建立
#   APP_RUNTIME_DIR／APP_BACKUP_DIR／APP_LOG_DIR 並交給 node，
#   再用 setpriv 降權成 node（含 no_new_privs）後 exec。不會以 root 執行應用程式。
# 說明見 docs/RAILWAY_CLOUDRUN_DEPLOYMENT.md「Railway volume」。
set -eu

APP_USER="node"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

command -v setpriv >/dev/null 2>&1 || {
  log "找不到 setpriv，拒絕以 root 執行應用程式"
  exit 1
}

app_home="$(getent passwd "$APP_USER" | cut -d: -f6)"
[ -n "$app_home" ] || {
  log "找不到使用者 ${APP_USER}"
  exit 1
}

volume_root="$(realpath -m -- "${RAILWAY_VOLUME_MOUNT_PATH:-/data}")"

# prepare_dir <變數名稱> <路徑>：只處理 volume 底下的路徑（解析 .. 與 symlink 後判斷）。
prepare_dir() {
  name="$1"
  dir="$2"
  [ -n "$dir" ] || return 0
  if [ "$volume_root" = "/" ]; then
    log "volume 掛載路徑是 /，不調整 ${name} 的權限"
    return 0
  fi
  resolved="$(realpath -m -- "$dir")"
  case "$resolved" in
    "$volume_root" | "$volume_root"/*) ;;
    *)
      log "${name} 不在 volume（${volume_root}）底下，不調整權限"
      return 0
      ;;
  esac
  mkdir -p "$resolved"
  chown -R "${APP_USER}:${APP_USER}" "$resolved"
  chmod 700 "$resolved"
  log "${name} 已交給 ${APP_USER}"
}

prepare_dir APP_RUNTIME_DIR "${APP_RUNTIME_DIR:-}"
prepare_dir APP_BACKUP_DIR "${APP_BACKUP_DIR:-}"
prepare_dir APP_LOG_DIR "${APP_LOG_DIR:-}"

# setpriv 不改環境變數；HOME 若留在 /root，預設執行期目錄會落在 node 無法寫入的位置。
export HOME="$app_home" USER="$APP_USER" LOGNAME="$APP_USER"
exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups --no-new-privs -- "$@"
