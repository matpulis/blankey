#!/bin/sh
# blankey installer. Works on any Linux distribution.
#
#   curl -fsSL .../install.sh | sh
#   sh install.sh --autostart
#   sh install.sh --from https://github.com/matpulis/blankey.git
#
# Deliberately POSIX sh with no bashisms, because the shell on a fresh server
# is as likely to be dash or busybox ash as it is to be bash.
set -eu

# ------------------------------------------------------------------ settings

PREFIX="${PREFIX:-/usr/local}"
NODE_MAJOR="${NODE_MAJOR:-22}"
# Only used when nodejs.org cannot be asked what the current release is.
NODE_FALLBACK="${NODE_FALLBACK:-22.11.0}"

# Where the source comes from when this is not run from inside a checkout,
# which is exactly the case for `curl ... | sh`. Forked it? Change this, or
# pass --from, or set BLANKEY_REPO.
REPO="${BLANKEY_REPO:-https://github.com/matpulis/blankey.git}"
REF="${BLANKEY_REF:-}"

SOURCE="${BLANKEY_SOURCE:-}"
DO_AUTOSTART=0
AUTOSTART_ARGS=""
SKIP_NODE=0
DRY_RUN=0

# ------------------------------------------------------------------- output

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); OFF=$(printf '\033[0m')
else
  BOLD=''; DIM=''; RED=''; GRN=''; YEL=''; OFF=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%s  !!%s %s\n' "$YEL" "$OFF" "$*" >&2; }
die()  { printf '%s error:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
note() { printf '%s     %s%s\n' "$DIM" "$*" "$OFF"; }

have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
blankey installer

  curl -fsSL <url>/install.sh | sh
  curl -fsSL <url>/install.sh | sh -s -- --autostart      # note the `-s --`
  sh install.sh --from ./blankey

  --from <src>     install from a git URL, a .tar.gz URL, or a local checkout
                   (default: the checkout this script sits in, else BLANKEY_REPO)
  --ref <name>     branch or tag to install, when fetching the source
  --autostart      open blankey automatically on login once installed
  --kiosk          with --autostart, end the session when blankey exits
  --prefix <dir>   where to put Node when it has to be installed (default /usr/local)
  --skip-node      assume a suitable Node is already installed
  --dry-run        say what would happen, change nothing
  --help, -h       this

Environment: PREFIX, NODE_MAJOR, BLANKEY_REPO, BLANKEY_REF, BLANKEY_SOURCE, NO_COLOR
EOF
}

# --------------------------------------------------------------------- args

while [ $# -gt 0 ]; do
  case "$1" in
    --from)      SOURCE="${2:-}"; shift 2 ;;
    --ref)       REF="${2:-}"; shift 2 ;;
    --prefix)    PREFIX="${2:-}"; shift 2 ;;
    --autostart) DO_AUTOSTART=1; shift ;;
    --kiosk)     AUTOSTART_ARGS="$AUTOSTART_ARGS --kiosk"; shift ;;
    --skip-node) SKIP_NODE=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1  (--help for the list)" ;;
  esac
done

# --------------------------------------------------------------- privileges

IS_ROOT=0
[ "$(id -u)" = "0" ] && IS_ROOT=1

as_root() {
  if [ "$IS_ROOT" = "1" ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  elif have doas; then
    doas "$@"
  else
    die "need root to run: $*
    Re-run this as root, or install sudo."
  fi
}

# ---------------------------------------------------------------- detection

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   echo x64 ;;
    aarch64|arm64)  echo arm64 ;;
    armv7l)         echo armv7l ;;
    ppc64le)        echo ppc64le ;;
    s390x)          echo s390x ;;
    *)              echo unsupported ;;
  esac
}

# musl needs its distro's own build; the nodejs.org tarballs are glibc-only.
is_musl() {
  [ -f /etc/alpine-release ] && return 0
  if have ldd; then ldd --version 2>&1 | grep -qi musl && return 0; fi
  return 1
}

distro_name() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${PRETTY_NAME:-${NAME:-linux}}"
  else
    echo "$(uname -s) $(uname -r)"
  fi
}

pkg_install() {
  if   have apt-get; then as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq \
                       && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif have dnf;     then as_root dnf install -y -q "$@"
  elif have yum;     then as_root yum install -y -q "$@"
  elif have apk;     then as_root apk add --no-cache "$@"
  elif have pacman;  then as_root pacman -Sy --noconfirm --needed "$@"
  elif have zypper;  then as_root zypper --non-interactive install "$@"
  elif have xbps-install; then as_root xbps-install -Sy "$@"
  elif have emerge;  then as_root emerge --quiet "$@"
  else
    return 1
  fi
}

fetch() {
  # $1 url, $2 destination ('-' for stdout)
  if have curl; then
    if [ "$2" = "-" ]; then curl -fsSL "$1"; else curl -fsSL "$1" -o "$2"; fi
  elif have wget; then
    if [ "$2" = "-" ]; then wget -qO- "$1"; else wget -qO "$2" "$1"; fi
  else
    die "neither curl nor wget is installed, so nothing can be downloaded"
  fi
}

# --------------------------------------------------------------------- node

node_ok() {
  have node || return 1
  v=$(node -v 2>/dev/null | sed 's/^v//')
  [ -n "$v" ] || return 1
  maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}
  [ "$maj" -gt 18 ] 2>/dev/null && return 0
  [ "$maj" -eq 18 ] 2>/dev/null && [ "$min" -ge 17 ] 2>/dev/null && return 0
  return 1
}

latest_node() {
  # Ask nodejs.org rather than pinning a patch release that goes stale.
  got=$(fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" - 2>/dev/null \
        | grep -o "node-v${NODE_MAJOR}\.[0-9][0-9.]*-linux" \
        | head -1 | sed "s/^node-v//; s/-linux$//") || got=""
  [ -n "$got" ] && echo "$got" || echo "$NODE_FALLBACK"
}

install_node() {
  step "Installing Node.js (need >= 18.17)"

  # musl systems get Node from their own repositories: the official binaries
  # are linked against glibc and simply will not start here.
  if is_musl; then
    note "musl libc detected, using the distribution's own Node package"
    pkg_install nodejs npm || die "could not install Node from this system's package manager"
    node_ok || die "the installed Node is older than 18.17; upgrade it and re-run with --skip-node"
    ok "Node $(node -v)"
    return
  fi

  arch=$(detect_arch)
  if [ "$arch" = "unsupported" ]; then
    warn "no official Node build for $(uname -m), falling back to the package manager"
    pkg_install nodejs npm || die "could not install Node for $(uname -m)"
    node_ok || die "the installed Node is older than 18.17"
    ok "Node $(node -v)"
    return
  fi

  have tar || pkg_install tar || die "tar is required"
  version=$(latest_node)
  ext=tar.gz
  have xz && ext=tar.xz            # smaller, and xz is present nearly everywhere
  url="https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.${ext}"

  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT INT TERM

  note "$url"
  fetch "$url" "$tmp/node.$ext" || die "download failed: $url"

  as_root mkdir -p "$PREFIX"
  if [ "$ext" = "tar.xz" ]; then
    as_root tar -xJf "$tmp/node.$ext" -C "$PREFIX" --strip-components=1
  else
    as_root tar -xzf "$tmp/node.$ext" -C "$PREFIX" --strip-components=1
  fi

  PATH="$PREFIX/bin:$PATH"; export PATH
  node_ok || die "Node was unpacked into $PREFIX but $PREFIX/bin is not usable"
  ok "Node $(node -v) in $PREFIX"
}

# ------------------------------------------------------------------ blankey

# Where this script itself lives, when that is a knowable thing. Piped from
# curl there is no file: `sh` reads the script on stdin and $0 is the shell,
# so this reports failure rather than guessing at the current directory.
script_dir() {
  case "$0" in
    */install.sh|install.sh) ;;
    *) return 1 ;;
  esac
  [ -f "$0" ] || return 1
  d=$(dirname -- "$0" 2>/dev/null) || return 1
  (cd "$d" 2>/dev/null && pwd) || return 1
}

# A directory counts as a blankey checkout when its package.json is blankey's.
is_checkout() {
  [ -f "$1/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"blankey"' "$1/package.json"
}

# Run from a checkout, install that. Otherwise fetch the source, which is what
# makes the piped one-liner work.
# Reports failure rather than calling die, because every caller reads it
# through $(...) and `exit` inside a command substitution only leaves the
# subshell: the script would print the error and carry on regardless.
resolve_source() {
  if [ -n "$SOURCE" ]; then echo "$SOURCE"; return 0; fi
  if here=$(script_dir) && is_checkout "$here"; then echo "$here"; return 0; fi
  if [ -n "$REPO" ]; then echo "$REPO"; return 0; fi
  return 1
}

no_source() {
  die "nothing to install from.
    This script is not inside a blankey checkout, and no source is set.
      sh install.sh --from /path/to/blankey
      sh install.sh --from https://github.com/OWNER/REPO.git
      BLANKEY_REPO=https://github.com/OWNER/REPO.git sh install.sh
    Publishing this? Set REPO near the top of the file instead, so the
    one-liner works with no arguments."
}

# Clone without ever asking for credentials.
#
# Redirecting stdin is not enough: git reads a username straight from the
# terminal, so an unattended install would sit on a prompt nobody is there to
# answer. GitHub also answers identically for a private repository and one
# that does not exist, so a typo in the URL arrives as a password prompt
# rather than as a 404.
clone_source() {
  if [ -n "$REF" ]; then
    # Cloning a tag lands on a detached HEAD, which git explains at length.
    # That is expected here and only noise in an installer.
    GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c advice.detachedHead=false \
      clone --depth 1 --branch "$REF" --quiet "$1" "$2" </dev/null
  else
    GIT_TERMINAL_PROMPT=0 git -c credential.helper= \
      clone --depth 1 --quiet "$1" "$2" </dev/null
  fi
}

# Build in the checkout, pack it, install the tarball. Packing runs the build
# through npm's `prepare`, and installing a tarball needs no devDependencies,
# so nothing but the compiled output ends up on the system.
build_and_install() {
  dir="$1"
  step "Building blankey"
  ( cd "$dir" && npm install --silent --no-audit --no-fund </dev/null ) \
    || die "npm install failed in $dir"

  tarball=$( cd "$dir" && npm pack --silent 2>/dev/null </dev/null | tail -1 )
  [ -n "$tarball" ] || die "npm pack produced nothing in $dir"

  step "Installing globally"
  as_root env PATH="$PATH" npm install -g --silent --no-audit --no-fund "$dir/$tarball" </dev/null \
    || die "global install failed"
  rm -f "$dir/$tarball"
}

install_blankey() {
  src=$(resolve_source) || no_source

  case "$src" in
    *.git|git@*|git+*)
      have git || pkg_install git || die "git is required to install from $src"
      tmp=$(mktemp -d)
      step "Cloning $src${REF:+ at $REF}"
      if ! clone_source "$src" "$tmp/blankey"; then
        rm -rf "$tmp"
        die "could not clone $src${REF:+ at $REF}
    GitHub answers the same way for a repository that is private and one that
    does not exist, so a wrong URL looks like an authentication problem.
    Check it resolves:  git ls-remote $src
    Point somewhere else:
      sh install.sh --from /path/to/blankey
      BLANKEY_REPO=https://github.com/OWNER/REPO.git sh install.sh${REF:+ --ref $REF}"
      fi
      build_and_install "$tmp/blankey"
      rm -rf "$tmp"
      ;;
    http://*|https://*)
      tmp=$(mktemp -d)
      step "Downloading $src"
      fetch "$src" "$tmp/blankey.tar.gz" || die "download failed: $src"
      mkdir -p "$tmp/blankey"
      tar -xzf "$tmp/blankey.tar.gz" -C "$tmp/blankey" --strip-components=1 \
        || die "could not unpack $src"
      build_and_install "$tmp/blankey"
      rm -rf "$tmp"
      ;;
    *)
      is_checkout "$src" || die "$src is not a blankey checkout (no matching package.json)"
      build_and_install "$src"
      ;;
  esac
}

# ---------------------------------------------------------------------- main

step "blankey installer"
note "$(distro_name)  $(uname -m)"

if [ "$DRY_RUN" = "1" ]; then
  step "Dry run, nothing will be changed"
  src=$(resolve_source) || no_source
  note "source     $src${REF:+  ref $REF}"
  note "arch       $(detect_arch)$(is_musl && echo '  (musl)')"
  if node_ok; then
    note "node       $(node -v) already installed"
  else
    note "node       would install v$(latest_node) into $PREFIX"
  fi
  note "install    npm install -g  (as $( [ "$IS_ROOT" = 1 ] && echo root || echo 'root via sudo'))"
  note "autostart  $( [ "$DO_AUTOSTART" = 1 ] && echo "yes$AUTOSTART_ARGS" || echo no)"
  say ""
  exit 0
fi

if [ "$SKIP_NODE" = "1" ]; then
  node_ok || die "--skip-node was given but node is missing or older than 18.17"
  ok "Node $(node -v)"
elif node_ok; then
  ok "Node $(node -v) is new enough"
else
  install_node
fi

have npm || die "npm is missing even though node is present. Install npm and re-run"

install_blankey

if ! have blankey; then
  # A global install can land somewhere that is not on this shell's PATH.
  bin=$(npm prefix -g 2>/dev/null)/bin
  if [ -x "$bin/blankey" ]; then
    PATH="$bin:$PATH"; export PATH
    warn "$bin is not on your PATH. Add it to your shell profile:"
    note "export PATH=\"$bin:\$PATH\""
  else
    die "blankey was installed but cannot be found on PATH"
  fi
fi

ok "blankey $(blankey --version 2>/dev/null || echo installed)"

if [ "$DO_AUTOSTART" = "1" ]; then
  step "Setting blankey to open on login"
  scope=""
  [ "$IS_ROOT" = "1" ] && scope="--system"
  # shellcheck disable=SC2086
  blankey autostart enable --yes $scope $AUTOSTART_ARGS || warn "could not enable autostart"
fi

say ""
say "${BOLD}Done.${OFF}"
say "  ${BOLD}blankey${OFF}              open the menu"
say "  ${BOLD}blankey status${OFF}       what is running"
say "  ${BOLD}blankey doctor${OFF}       check the host for problems"
if [ "$DO_AUTOSTART" != "1" ]; then
  say ""
  say "  ${DIM}To open it automatically when you log in:${OFF}"
  say "  ${BOLD}blankey autostart enable${OFF}"
fi
say ""
