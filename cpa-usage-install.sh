#!/usr/bin/env bash
set -euo pipefail

# ==========
# Defaults
# ==========
APP_USER="cpausage"
APP_GROUP="cpausage"
HOME_DIR="/home/${APP_USER}"
BASE_DIR="${HOME_DIR}/cpa-usage"
RELEASES_DIR="${BASE_DIR}/releases"
CURRENT_LINK="${BASE_DIR}/current"
DATA_DIR="${BASE_DIR}/data"
LOGS_DIR="${BASE_DIR}/logs"
ENV_FILE="${BASE_DIR}/.env"
BIN_LINK="/usr/local/bin/cpa-usage"
SERVICE_NAME="cpa-usage"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ==========
# Configurable
# ==========
APP_PORT_DEFAULT="8080"
APP_BASE_PATH_DEFAULT="/usage"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-60}"
DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://github.com/k0ngk0ng/cpa-usage/releases/download}"

VERSION=""

usage() {
  cat <<EOF
Usage:
  sudo ./cpa-usage-install.sh --version <x.y.z-n>

Example:
  sudo ./cpa-usage-install.sh --version 0.0.1-0

Environment Variables:
  HEALTH_CHECK_TIMEOUT   (optional) seconds to wait for /healthz, default: 60
  DOWNLOAD_BASE          (optional) GitHub release base URL

Notes:
  - First-run creates ${ENV_FILE} from .env.example. You must populate
    CPA_BASE_URL and CPA_MANAGEMENT_KEY before the service starts.
  - SQLite DB lives under ${DATA_DIR}; logs under ${LOGS_DIR}.
  - Service URL: http://127.0.0.1:\${APP_PORT}\${APP_BASE_PATH}/healthz
EOF
}

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: please run as root (use sudo)" >&2
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) VERSION="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
    esac
  done
  if [[ -z "${VERSION}" ]]; then
    echo "ERROR: --version is required" >&2
    usage
    exit 1
  fi
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "aarch64" ;;
    *) echo "ERROR: unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
}

ensure_user() {
  if id "${APP_USER}" >/dev/null 2>&1; then
    return 0
  fi
  useradd -r -m -d "${HOME_DIR}" -s /bin/bash "${APP_USER}"
}

ensure_dirs() {
  mkdir -p "${RELEASES_DIR}" "${DATA_DIR}" "${LOGS_DIR}"
  chown -R "${APP_USER}:${APP_GROUP}" "${HOME_DIR}"
  chmod 750 "${BASE_DIR}" || true
}

download_and_extract() {
  local arch
  arch="$(detect_arch)"
  local tarball="cpa-usage_${VERSION}_linux_${arch}.tar.gz"
  local url="${DOWNLOAD_BASE}/v${VERSION}/${tarball}"
  local tmp="/tmp/${tarball}"
  local release_dir="${RELEASES_DIR}/${VERSION}"

  mkdir -p "${release_dir}"

  echo "==> Download: ${url}"
  if command -v wget >/dev/null 2>&1; then
    wget -O "${tmp}" "${url}"
  elif command -v curl >/dev/null 2>&1; then
    curl -L -o "${tmp}" "${url}"
  else
    echo "ERROR: need wget or curl" >&2
    exit 1
  fi

  echo "==> Extract to: ${release_dir}"
  tar -xzf "${tmp}" -C "${release_dir}"
  chown -R "${APP_USER}:${APP_GROUP}" "${release_dir}"

  if [[ ! -f "${release_dir}/cpa-usage" ]]; then
    echo "ERROR: ${release_dir}/cpa-usage not found after extract" >&2
    ls -la "${release_dir}" >&2 || true
    exit 1
  fi
  chmod +x "${release_dir}/cpa-usage"
}

switch_current() {
  local release_dir="${RELEASES_DIR}/${VERSION}"
  echo "==> Switch current -> ${release_dir}"
  ln -sfn "${release_dir}" "${CURRENT_LINK}"
  chown -h "${APP_USER}:${APP_GROUP}" "${CURRENT_LINK}" || true
}

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    chown "${APP_USER}:${APP_GROUP}" "${ENV_FILE}"
    chmod 640 "${ENV_FILE}"
    return 0
  fi
  local example="${CURRENT_LINK}/.env.example"
  if [[ ! -f "${example}" ]]; then
    echo "WARN: ${example} not found; writing minimal .env" >&2
    cat > "${ENV_FILE}" <<EOF
CPA_BASE_URL=http://127.0.0.1:8317
CPA_MANAGEMENT_KEY=
APP_PORT=${APP_PORT_DEFAULT}
APP_BASE_PATH=${APP_BASE_PATH_DEFAULT}
TZ=Asia/Shanghai
SQLITE_PATH=${DATA_DIR}/app.db
LOG_DIR=${LOGS_DIR}
EOF
  else
    echo "==> Create ${ENV_FILE} from .env.example"
    cp "${example}" "${ENV_FILE}"
    # Override defaults to point at the systemd-managed paths.
    sed -i.bak \
      -e "s|^SQLITE_PATH=.*|SQLITE_PATH=${DATA_DIR}/app.db|" \
      -e "s|^LOG_DIR=.*|LOG_DIR=${LOGS_DIR}|" \
      "${ENV_FILE}" && rm -f "${ENV_FILE}.bak"
  fi
  chown "${APP_USER}:${APP_GROUP}" "${ENV_FILE}"
  chmod 640 "${ENV_FILE}"
  echo "    Edit ${ENV_FILE} to set CPA_BASE_URL / CPA_MANAGEMENT_KEY before first start."
}

ensure_bin_link() {
  echo "==> Link binary: ${BIN_LINK} -> ${CURRENT_LINK}/cpa-usage"
  ln -sfn "${CURRENT_LINK}/cpa-usage" "${BIN_LINK}"
}

ensure_systemd_unit() {
  echo "==> Write systemd unit: ${UNIT_FILE}"
  cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=CPA Usage
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
Environment=HOME=${HOME_DIR}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${BASE_DIR}
ExecStart=${BIN_LINK}
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reexec
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
}

restart_service() {
  echo "==> Restart service: ${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}" || systemctl start "${SERVICE_NAME}"
  systemctl --no-pager --full status "${SERVICE_NAME}" || true
}

wait_for_healthy() {
  local app_port app_base_path
  app_port="$(grep -E '^APP_PORT=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  app_base_path="$(grep -E '^APP_BASE_PATH=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  app_port="${app_port:-${APP_PORT_DEFAULT}}"
  if [[ -z "${app_base_path:-}" ]]; then
    app_base_path="${APP_BASE_PATH_DEFAULT}"
  fi
  local health_url="http://127.0.0.1:${app_port}${app_base_path}/healthz"
  echo "==> Wait for healthz: ${health_url}"
  local timeout="${HEALTH_CHECK_TIMEOUT}"
  local start_time
  start_time=$(date +%s)
  while true; do
    local now elapsed http_code
    now=$(date +%s)
    elapsed=$((now - start_time))
    if [[ ${elapsed} -ge ${timeout} ]]; then
      echo "    ERROR: health check timeout after ${timeout}s" >&2
      return 1
    fi
    http_code=$(curl -s -w "%{http_code}" -o /dev/null "${health_url}" 2>/dev/null || true)
    if [[ "${http_code}" == "200" ]]; then
      echo "    Service is healthy (took ${elapsed}s)"
      return 0
    fi
    echo "    waiting... (${elapsed}s, HTTP: ${http_code})"
    sleep 2
  done
}

main() {
  need_root
  parse_args "$@"

  ensure_user
  ensure_dirs
  download_and_extract
  switch_current
  ensure_env_file
  ensure_bin_link
  ensure_systemd_unit
  restart_service

  if ! wait_for_healthy; then
    echo "WARN: Service not healthy within ${HEALTH_CHECK_TIMEOUT}s; run 'journalctl -u ${SERVICE_NAME} -f'"
  fi

  echo
  echo "Done."
  echo "Env:     ${ENV_FILE}"
  echo "Data:    ${DATA_DIR}"
  echo "Logs:    journalctl -u ${SERVICE_NAME} -f"
  echo "Current: ${CURRENT_LINK}"
}

main "$@"
