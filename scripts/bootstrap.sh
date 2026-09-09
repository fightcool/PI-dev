#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
if command -v systemctl >/dev/null && systemctl --user is-active --quiet pi-web-ui-dev.service; then
  echo 'Stop pi-web-ui-dev.service explicitly before changing its dependency directory.' >&2
  exit 1
fi
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || {
  echo 'Supported platform: Linux x86_64' >&2
  exit 1
}
for tool in curl tar sha256sum git; do
  command -v "$tool" >/dev/null || {
    echo "Missing prerequisite: $tool" >&2
    exit 1
  }
done
mkdir -p .tools/downloads
NODE_VERSION="$(<.node-version)"
if ! command -v node >/dev/null || [[ "$(node --version)" != "v$NODE_VERSION" ]]; then
  ARCHIVE="node-v$NODE_VERSION-linux-x64.tar.xz"
  BASE="https://nodejs.org/dist/v$NODE_VERSION"
  curl --fail --location --retry 2 "$BASE/$ARCHIVE" -o ".tools/downloads/$ARCHIVE"
  curl --fail --location --retry 2 "$BASE/SHASUMS256.txt" -o .tools/downloads/node-shasums.txt
  (cd .tools/downloads && awk -v name="$ARCHIVE" '$2 == name { print; found=1 } END { if (!found) exit 1 }' node-shasums.txt | sha256sum --check -)
  tar -xJf ".tools/downloads/$ARCHIVE" -C .tools
  export PATH="$ROOT/.tools/node-v$NODE_VERSION-linux-x64/bin:$PATH"
fi
[[ "$(npm --version)" == 10.9.3 ]] || {
  echo 'Use npm 10.9.3 from the pinned Node distribution.' >&2
  exit 1
}
UV_VERSION=0.12.10
UV_SHA256=173d95a0c32d18c896c46ba6fafbf3cf9c14ab74b033f81b76c883ef492a976b
UV="$ROOT/.tools/uv-x86_64-unknown-linux-gnu/uv"
if [[ ! -x "$UV" ]] || [[ "$("$UV" --version)" != "uv $UV_VERSION"* ]]; then
  curl --fail --location --retry 2 "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" -o .tools/downloads/uv.tar.gz
  printf '%s  %s\n' "$UV_SHA256" .tools/downloads/uv.tar.gz | sha256sum --check -
  tar -xzf .tools/downloads/uv.tar.gz -C .tools
fi
export UV_PYTHON_INSTALL_DIR="$ROOT/.tools/python"
export UV_PROJECT_ENVIRONMENT="$ROOT/.venv"
export UV_PYTHON_PREFERENCE=only-managed
"$UV" python install --no-bin "$(<.python-version)"
if [[ "${1:-}" == --update-lock ]]; then
  "$UV" lock --python "$(<.python-version)"
  npm install --package-lock-only --ignore-scripts --no-fund --no-audit
  exit 0
fi
[[ $# == 0 ]] || {
  echo 'Usage: bash scripts/bootstrap.sh [--update-lock]' >&2
  exit 1
}
# --locked refuses dependency drift; the repository must already contain uv.lock.
"$UV" sync --locked --python "$(<.python-version)"
npm ci --no-fund --no-audit
node scripts/configure.mjs
node scripts/doctor.mjs
printf '\nReady. Install the independent service: node scripts/service.mjs install\n'
