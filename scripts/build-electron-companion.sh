#!/bin/sh
set -eu

# Compatibility entrypoint retained for existing automation. The Electron
# companion is now the full Control Center: one packaged process owns both the
# native tray and the normal application window.

# Empty CDPATH keeps `cd` silent across user shell configurations.
# shellcheck disable=SC1007
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app_dir="$repo_dir/apps/control-center"
build_mode=install
stage_destination=
case ${1:-} in
  "") ;;
  --stage-only)
    if [ "$#" -ne 2 ] || [ -z "$2" ]; then
      printf 'Usage: %s [--stage-only DESTINATION]\n' "$0" >&2
      exit 2
    fi
    build_mode=stage-only
    stage_destination=$2
    ;;
  *)
    printf 'Usage: %s [--stage-only DESTINATION]\n' "$0" >&2
    exit 2
    ;;
esac
staging_root=$(mktemp -d "$app_dir/.control-center-build.XXXXXX")
target_dir="$app_dir/release/linux-unpacked"
backup_dir="$app_dir/release/.linux-unpacked.previous.$$"
previous_moved=0

cleanup() {
  # The backup directory is the durable transaction marker. Shell signals can
  # arrive after mv succeeds but before the following assignment, so rollback
  # must not depend only on an in-memory flag.
  if [ -d "$backup_dir" ]; then
    staged_dir="$staging_root/linux-unpacked"
    if [ -d "$target_dir" ] && [ ! -e "$staged_dir" ]; then
      mv "$target_dir" "$staged_dir" >/dev/null 2>&1 || true
    fi
    if [ ! -e "$target_dir" ]; then
      mv "$backup_dir" "$target_dir" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$staging_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command_name in node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required to build the Control Center.\n' "$command_name" >&2
    exit 1
  fi
done

case $(uname -s) in
  Linux)
    binary="$target_dir/codex-router-control-center"
    ;;
  *)
    printf 'This build entrypoint supports Linux; use build-electron-companion.ps1 on Windows.\n' >&2
    exit 1
    ;;
esac

npm ci --prefix "$app_dir" >&2
npm run check --prefix "$app_dir" >&2
npm test --prefix "$app_dir" >&2
npm run build --prefix "$app_dir" >&2
CSC_IDENTITY_AUTO_DISCOVERY=false \
  "$app_dir/node_modules/.bin/electron-builder" --linux dir --publish never \
    "--config.directories.output=$staging_root" >&2

staged_dir="$staging_root/linux-unpacked"
staged_binary="$staged_dir/codex-router-control-center"
if [ ! -x "$staged_binary" ]; then
  printf 'The packaged Control Center is missing at %s.\n' "$staged_binary" >&2
  exit 1
fi

# Local unpacked packages resolve the owning router checkout through this
# marker. Public signed packages are produced elsewhere and are never mutated
# after packaging.
printf '%s\n' "$repo_dir" >"$staged_dir/resources/router-root"

# The Linux updater owns the live-package transaction because only it knows
# whether a prior GUI was running and visible. Stage-only mode returns a fully
# verified package without touching the current binary or its build stamp.
if [ "$build_mode" = stage-only ]; then
  if [ -e "$stage_destination" ]; then
    printf 'Refusing to overwrite staged Control Center destination: %s\n' "$stage_destination" >&2
    exit 1
  fi
  mkdir -p "$(dirname -- "$stage_destination")"
  if ! mv "$staged_dir" "$stage_destination"; then
    printf 'Could not stage the newly packaged Control Center at %s.\n' "$stage_destination" >&2
    exit 1
  fi
  printf '%s\n' "$stage_destination/codex-router-control-center"
  exit 0
fi

# Package away from the live app, then replace only after every build and
# verification step succeeds. A failed npm/electron-builder run therefore
# leaves the previous tray executable untouched and restartable.
mkdir -p "$app_dir/release"
if [ -e "$backup_dir" ]; then
  printf 'Refusing to overwrite stale Control Center backup: %s\n' "$backup_dir" >&2
  exit 1
fi
if [ -d "$target_dir" ]; then
  mv "$target_dir" "$backup_dir"
  previous_moved=1
fi
if ! mv "$staged_dir" "$target_dir"; then
  if [ "$previous_moved" -eq 1 ]; then
    mv "$backup_dir" "$target_dir" || true
    previous_moved=0
  fi
  printf 'Could not install the newly packaged Control Center.\n' >&2
  exit 1
fi
if [ "$previous_moved" -eq 1 ]; then
  rm -rf "$backup_dir"
  previous_moved=0
fi

printf '%s\n' "$binary"
