#!/usr/bin/env python3
"""Cloud Run 備援環境變數工具（由 deploy/cloudrun-env.sh 呼叫）。

把 Zeabur 匯出的 .env 格式檔轉成 `gcloud run ... --env-vars-file` 吃的 YAML，
或把 .env 裡列出的變數合併進服務目前的環境變數。

安全規則：
- 永遠不印出任何變數的值，報告只列變數名稱。
- 輸出檔由呼叫端放在 umask 077 的暫存目錄，用完即刪。

用法：
  envtool.py build --mode bootstrap --dotenv F --repo-root R --out Y \
      --primary-url U --standby-url U
  envtool.py build --mode update --dotenv F --repo-root R --out Y --current J
  envtool.py build --mode retarget --repo-root R --out Y --current J \
      --primary-url U --standby-url U

結束碼：0＝有變更（已寫出 YAML）；3＝與目前完全相同（未寫出）；其他＝錯誤。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

EXIT_NO_CHANGE = 3

KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# 備援專屬、由本工具決定的變數。update 模式不接受 .env 覆寫它們。
STANDBY_MANAGED = (
    "SALARY_AUTOMATION_ENABLED",
    "ALLOWED_ORIGINS",
    "LINE_LOGIN_CALLBACK_URL",
    "SALARY_AUTOMATION_PUBLIC_BASE_URL",
)

# 只在建置期使用、或 Cloud Run 保留／平台自帶的名稱：一律不設定到 Cloud Run。
DROP_EXACT = {
    "VITE_LIFF_ID": "只在前端打包時使用，已寫在 client/.env.production",
    "PORT": "Cloud Run 保留變數（容器埠由 --port 8080 指定）",
    "K_SERVICE": "Cloud Run 保留變數",
    "K_REVISION": "Cloud Run 保留變數",
    "K_CONFIGURATION": "Cloud Run 保留變數",
}
DROP_PREFIXES = {
    "ZEABUR_": "Zeabur 平台自帶變數",
}

LINE_SET = (
    "LINE_LOGIN_CHANNEL_ID",
    "LINE_LOGIN_CHANNEL_SECRET",
    "LINE_MESSAGING_CHANNEL_ACCESS_TOKEN",
    "LINE_MESSAGING_CHANNEL_SECRET",
)

LINE_CALLBACK_PATH = "/api/line/callback"  # server/routes/line/auth.routes.ts


class EnvToolError(Exception):
    pass


def report(message: str) -> None:
    print(f"[cloudrun-env] {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# dotenv 解析
# ---------------------------------------------------------------------------
def _unescape_double_quoted(raw: str) -> str:
    out: List[str] = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            mapping = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}
            if nxt in mapping:
                out.append(mapping[nxt])
                i += 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def parse_dotenv(path: str) -> Tuple["OrderedDict[str, str]", List[str]]:
    """回傳 (變數, 警告訊息)。警告只含變數名稱與行號，不含值。"""
    with open(path, "r", encoding="utf-8-sig") as handle:
        lines = handle.read().splitlines()

    values: "OrderedDict[str, str]" = OrderedDict()
    warnings: List[str] = []
    index = 0
    while index < len(lines):
        line_no = index + 1
        line = lines[index]
        index += 1
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export "):].lstrip()
        if "=" not in stripped:
            raise EnvToolError(f"第 {line_no} 行不是 KEY=VALUE 格式")
        key, rest = stripped.split("=", 1)
        key = key.strip()
        if not KEY_RE.match(key):
            raise EnvToolError(f"第 {line_no} 行的變數名稱不合法")
        rest = rest.lstrip()

        if rest[:1] in ('"', "'", "`"):
            quote = rest[0]
            body = rest[1:]
            collected: List[str] = []
            while True:
                end = _find_closing_quote(body, quote)
                if end is not None:
                    collected.append(body[:end])
                    trailing = body[end + 1:].strip()
                    if trailing and not trailing.startswith("#"):
                        raise EnvToolError(f"{key}（第 {line_no} 行）結尾引號後還有其他字元")
                    break
                collected.append(body)
                if index >= len(lines):
                    raise EnvToolError(f"{key}（第 {line_no} 行）的引號沒有結束")
                body = lines[index]
                index += 1
            value = "\n".join(collected)
            if quote == '"':
                value = _unescape_double_quoted(value)
        else:
            # 不處理行內註解：密碼可能含 #，寧可原樣保留也不要默默截斷。
            value = rest.strip()
            if "#" in value:
                warnings.append(f"{key} 的值含有 #，已原樣保留；若後半段其實是註解，請在檔案中刪除")

        if key in values:
            warnings.append(f"{key} 重複出現，採用最後一次的值")
        values[key] = value
    return values, warnings


def _find_closing_quote(text: str, quote: str) -> Optional[int]:
    i = 0
    while i < len(text):
        ch = text[i]
        if quote == '"' and ch == "\\":
            i += 2
            continue
        if ch == quote:
            return i
        i += 1
    return None


# ---------------------------------------------------------------------------
# 白名單（以 .env.example 與 server/config/envValidator.ts 為準）
# ---------------------------------------------------------------------------
def load_known_names(repo_root: str) -> set:
    names: set = set()
    example = os.path.join(repo_root, ".env.example")
    validator = os.path.join(repo_root, "server", "config", "envValidator.ts")
    for path in (example, validator):
        if not os.path.isfile(path):
            raise EnvToolError(f"找不到白名單來源 {os.path.relpath(path, repo_root)}")

    with open(example, "r", encoding="utf-8") as handle:
        for line in handle:
            match = re.match(r"^\s*#?\s*([A-Z][A-Z0-9_]*)=", line)
            if match:
                names.add(match.group(1))

    with open(validator, "r", encoding="utf-8") as handle:
        source = handle.read()
    names.update(re.findall(r"^\s+([A-Z][A-Z0-9_]*)\s*:", source, flags=re.MULTILINE))
    names.update(re.findall(r"process\.env\.([A-Z][A-Z0-9_]*)", source))
    return names


# ---------------------------------------------------------------------------
# 合併與檢查
# ---------------------------------------------------------------------------
def drop_reason(name: str) -> Optional[str]:
    if name in DROP_EXACT:
        return DROP_EXACT[name]
    for prefix, reason in DROP_PREFIXES.items():
        if name.startswith(prefix):
            return reason
    return None


def filter_incoming(incoming: "OrderedDict[str, str]", known: set, skip_managed: bool) -> "OrderedDict[str, str]":
    kept: "OrderedDict[str, str]" = OrderedDict()
    for name, value in incoming.items():
        reason = drop_reason(name)
        if reason:
            report(f"略過 {name}：{reason}")
            continue
        if skip_managed and name in STANDBY_MANAGED:
            report(f"略過 {name}：備援專屬變數，update 不覆寫（要改請用 gcloud run services update --update-env-vars，見文件）")
            continue
        if name not in known:
            report(f"警告：{name} 不在 .env.example／envValidator.ts 白名單中（仍會設定，請確認不是打錯字或平台殘留）")
        if name == "APP_VERSION":
            report("警告：APP_VERSION 會覆寫 /api/health 回報的 version，deploy-all.sh 的版本比對會因此失敗，建議移除")
        if "${" in value:
            report(f"警告：{name} 的值含有 ${{...}}，可能是 Zeabur 的變數參照沒有展開，請確認")
        if name in ("APP_RUNTIME_DIR", "APP_BACKUP_DIR", "APP_LOG_DIR") and (value == "/app" or value.startswith("/app/")):
            report(f"警告：{name} 指向 /app 底下（容器工作目錄），正式環境會拒絕啟動；建議移除改用預設路徑")
        kept[name] = value
    return kept


def apply_standby_urls(env: "OrderedDict[str, str]", primary_url: str, standby_url: str) -> None:
    origins: List[str] = []
    for url in (primary_url, standby_url):
        if url and url not in origins:
            origins.append(url)
    env["ALLOWED_ORIGINS"] = ",".join(origins)
    env["SALARY_AUTOMATION_PUBLIC_BASE_URL"] = standby_url

    line_configured = any(env.get(name) for name in LINE_SET)
    if line_configured:
        env["LINE_LOGIN_CALLBACK_URL"] = standby_url + LINE_CALLBACK_PATH
    elif "LINE_LOGIN_CALLBACK_URL" in env:
        # 只設 callback、缺其他四個 LINE 變數時，envValidator 會拒絕啟動。
        del env["LINE_LOGIN_CALLBACK_URL"]
        report("略過 LINE_LOGIN_CALLBACK_URL：其他 LINE 變數都沒有設定")


def read_current_env(path: str) -> "OrderedDict[str, str]":
    with open(path, "r", encoding="utf-8") as handle:
        service = json.load(handle)
    try:
        containers = service["spec"]["template"]["spec"]["containers"]
    except (KeyError, TypeError) as exc:
        raise EnvToolError("服務描述缺少 spec.template.spec.containers") from exc
    if len(containers) != 1:
        raise EnvToolError("只支援單一容器的服務")
    env: "OrderedDict[str, str]" = OrderedDict()
    for item in containers[0].get("env") or []:
        name = item.get("name")
        if "valueFrom" in item:
            raise EnvToolError(f"{name} 使用 Secret Manager 參照，本工具不處理；請改用主控台管理")
        env[name] = item.get("value", "")
    return env


def normalize_url(url: str, label: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not re.match(r"^https://[^/\s]+$", url):
        raise EnvToolError(f"{label} 必須是 https://主機名稱（不含路徑）")
    return url


def write_yaml(env: "OrderedDict[str, str]", path: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for name, value in env.items():
            # JSON 字串是合法的 YAML 雙引號字串，可避免值被解讀成數字或布林。
            handle.write(f"{name}: {json.dumps(value, ensure_ascii=False)}\n")


def summarize(before: "OrderedDict[str, str]", after: "OrderedDict[str, str]") -> bool:
    added = [name for name in after if name not in before]
    updated = [name for name in after if name in before and before[name] != after[name]]
    removed = [name for name in before if name not in after]
    unchanged = len([name for name in after if name in before and before[name] == after[name]])
    if added:
        report("新增：" + ", ".join(added))
    if updated:
        report("更新：" + ", ".join(updated))
    if removed:
        report("移除：" + ", ".join(removed))
    report(f"未變更：{unchanged} 個")
    return bool(added or updated or removed)


def cmd_build(args: argparse.Namespace) -> int:
    known = load_known_names(args.repo_root)

    if args.mode == "bootstrap":
        primary = normalize_url(args.primary_url, "PRIMARY_URL")
        standby = normalize_url(args.standby_url, "備援網址")
        incoming, warnings = parse_dotenv(args.dotenv)
        for warning in warnings:
            report("警告：" + warning)
        env = filter_incoming(incoming, known, skip_managed=False)
        env["SALARY_AUTOMATION_ENABLED"] = "false"
        apply_standby_urls(env, primary, standby)
        before: "OrderedDict[str, str]" = OrderedDict()
        if args.current:
            before = read_current_env(args.current)
        summarize(before, env)
        write_yaml(env, args.out)
        return 0

    before = read_current_env(args.current)
    env = OrderedDict(before)
    if args.mode == "update":
        incoming, warnings = parse_dotenv(args.dotenv)
        for warning in warnings:
            report("警告：" + warning)
        for name, value in filter_incoming(incoming, known, skip_managed=True).items():
            env[name] = value
    elif args.mode == "retarget":
        apply_standby_urls(
            env,
            normalize_url(args.primary_url, "PRIMARY_URL"),
            normalize_url(args.standby_url, "備援網址"),
        )

    if not summarize(before, env):
        return EXIT_NO_CHANGE
    write_yaml(env, args.out)
    return 0


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--mode", choices=("bootstrap", "update", "retarget"), required=True)
    build.add_argument("--dotenv")
    build.add_argument("--repo-root", required=True)
    build.add_argument("--out", required=True)
    build.add_argument("--current")
    build.add_argument("--primary-url")
    build.add_argument("--standby-url")
    args = parser.parse_args(argv)

    if args.mode in ("bootstrap", "update") and not args.dotenv:
        parser.error("--dotenv is required")
    if args.mode in ("update", "retarget") and not args.current:
        parser.error("--current is required")

    try:
        return cmd_build(args)
    except EnvToolError as exc:
        report(f"錯誤：{exc}")
        return 2
    except (OSError, ValueError) as exc:
        # 不把例外內容原樣印出，避免夾帶檔案內容。
        report(f"錯誤：無法處理輸入檔（{type(exc).__name__}）")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
