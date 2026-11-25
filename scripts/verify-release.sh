#!/usr/bin/env bash
# Verify the canonical release artifacts against the hashes published in
# release/README.md, plus the newest timestamped copy of each artifact.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/release"

expected_hash() {
  awk -v target="File: \`${1}\`" '
    $0 == target { found = 1; next }
    found && $0 == "SHA-256:" {
      getline
      gsub(/`/, "", $0)
      print $0
      exit
    }
  ' README.md
}

verify_file() {
  local file="$1"
  local expected="$2"
  if [[ -z "$expected" ]]; then
    echo "FAIL: no published SHA-256 for $file" >&2
    exit 1
  fi
  if [[ ! -f "$file" ]]; then
    echo "FAIL: missing $file" >&2
    exit 1
  fi
  local actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "OK: $file"
}

verify_latest_copy() {
  local dir="$1"
  local pattern="$2"
  local expected="$3"
  local latest
  latest="$(find "$dir" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' \
    | sort -nr | head -n 1 | cut -d' ' -f2-)"
  if [[ -n "$latest" ]]; then
    verify_file "$latest" "$expected"
  fi
}

linux_file="appimage/TalosCrest-Linux-x86_64.AppImage"
windows_file="windows/TalosCrest-Windows-x64-portable.zip"
android_file="android/TalosCrest-Android-universal.apk"

linux_hash="$(expected_hash "$linux_file")"
windows_hash="$(expected_hash "$windows_file")"
android_hash="$(expected_hash "$android_file")"

verify_file "$linux_file" "$linux_hash"
verify_file "$windows_file" "$windows_hash"
verify_file "$android_file" "$android_hash"

verify_latest_copy appimage 'TalosCrest-Linux-x86_64-*.AppImage' "$linux_hash"
verify_latest_copy windows 'TalosCrest-Windows-x64-portable-*.zip' "$windows_hash"
verify_latest_copy android 'TalosCrest-Android-universal-*.apk' "$android_hash"

echo "All published release checksums match."
