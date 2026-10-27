#!/bin/sh
# Installs gitleaks in Claude Code cloud sessions so the pre-commit hook can run.
set -eu

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
command -v gitleaks >/dev/null 2>&1 && exit 0

version=8.30.1
case "$(uname -m)" in
  x86_64) arch=x64 sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  aarch64 | arm64) arch=arm64 sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) echo "gitleaks: unsupported architecture $(uname -m)" >&2; exit 0 ;;
esac

tarball="gitleaks_${version}_linux_${arch}.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/$tarball" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${tarball}"
echo "$sha  $tmp/$tarball" | sha256sum -c - >/dev/null
tar -xzf "$tmp/$tarball" -C "$tmp" gitleaks

if [ -w /usr/local/bin ]; then
  bin=/usr/local/bin
else
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PATH=\"$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
install -m 0755 "$tmp/gitleaks" "$bin/gitleaks"
echo "gitleaks $version installed in $bin"
