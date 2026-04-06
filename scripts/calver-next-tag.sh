#!/usr/bin/env bash
# Compute next CalVer tag (YYYY.M.D, same UTC day: -2, -3, ...). Writes to GITHUB_OUTPUT.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

VERSION_BASE=$(date -u +'%Y.%-m.%-d')

git fetch --tags origin 2>/dev/null || true

while IFS= read -r t; do
  [[ -z "${t}" ]] && continue
  if [[ "${t}" == "${VERSION_BASE}" ]]; then
    echo "skip=true" >>"${GITHUB_OUTPUT}"
    echo "tag=${t}" >>"${GITHUB_OUTPUT}"
    exit 0
  fi
  if [[ "${t}" == "${VERSION_BASE}-"* ]]; then
    suffix="${t#"${VERSION_BASE}-"}"
    if [[ "${suffix}" =~ ^[0-9]+$ ]]; then
      echo "skip=true" >>"${GITHUB_OUTPUT}"
      echo "tag=${t}" >>"${GITHUB_OUTPUT}"
      exit 0
    fi
  fi
done < <(git tag --points-at HEAD)

if git rev-parse -q --verify "refs/tags/${VERSION_BASE}" >/dev/null; then
  max=1
  while IFS= read -r t; do
    [[ -z "${t}" ]] && continue
    suffix="${t#"${VERSION_BASE}-"}"
    [[ "${suffix}" =~ ^[0-9]+$ ]] || continue
    ((suffix > max)) && max=${suffix}
  done < <(git tag -l "${VERSION_BASE}-*")
  NEW_TAG="${VERSION_BASE}-$((max + 1))"
else
  NEW_TAG="${VERSION_BASE}"
fi

echo "tag=${NEW_TAG}" >>"${GITHUB_OUTPUT}"
echo "skip=false" >>"${GITHUB_OUTPUT}"
