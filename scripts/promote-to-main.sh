#!/usr/bin/env bash
#
# promote-to-main.sh — fast-forward `main` to the reviewed tip of `staging`.
#
# Why a fast-forward (not a PR merge):
#   `main` and `staging` are both long-lived branches. GitHub's PR merge buttons
#   cannot keep them identical — "Merge" adds a merge commit that lives only on
#   main, and "Rebase and merge" rewrites SHAs so the same change ends up with a
#   different hash on each branch. Either way the branches diverge a little on
#   every promotion, and the gap compounds.
#
#   A true fast-forward just advances main's pointer to staging's existing,
#   already-reviewed commit. No new commit, no rewrite — main and staging stay
#   byte-for-byte identical, so they can never drift.
#
# Safety: this refuses to run unless main is STRICTLY behind staging (i.e. main
# has zero commits that staging lacks). If they have diverged, something landed
# on main outside this flow and a human must reconcile first — we never force.
#
# Nothing reaches main that wasn't already gated: every commit on staging came
# through a feature PR (CI + CodeRabbit/Qodo + autoreview) merged into staging.
# This script only moves the production pointer to that reviewed tip.
#
# Usage:
#   pnpm promote      # (or npm run promote) fast-forward main to staging's tip
#
set -euo pipefail

REMOTE="origin"
SRC="staging"
DST="main"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "Fetching $REMOTE/$SRC and $REMOTE/$DST ..."
git fetch --quiet "$REMOTE" \
  "+refs/heads/$SRC:refs/remotes/$REMOTE/$SRC" \
  "+refs/heads/$DST:refs/remotes/$REMOTE/$DST"

SRC_TIP="$(git rev-parse "$REMOTE/$SRC")"
DST_TIP="$(git rev-parse "$REMOTE/$DST")"
MERGE_BASE="$(git merge-base "$REMOTE/$SRC" "$REMOTE/$DST")"

if [ "$SRC_TIP" = "$DST_TIP" ]; then
  ok "$DST is already at $SRC ($(git rev-parse --short "$SRC_TIP")) — nothing to promote."
  exit 0
fi

# main must be an ancestor of staging for a clean fast-forward.
if [ "$MERGE_BASE" != "$DST_TIP" ]; then
  echo
  die "$DST has commits that $SRC does not — branches have DIVERGED, refusing to fast-forward.
    Someone pushed to $DST outside the staging→main flow. Reconcile manually, e.g.:
      git checkout $SRC && git merge --no-ff $REMOTE/$DST && git push $REMOTE $SRC
    then re-run this script.
    Divergent $DST-only commits:
$(git log --oneline "$REMOTE/$SRC..$REMOTE/$DST" | sed 's/^/      /')"
fi

say "Promoting these commits $SRC → $DST:"
git log --oneline --no-decorate "$REMOTE/$DST..$REMOTE/$SRC" | sed 's/^/    /'

say "Fast-forwarding $DST to $(git rev-parse --short "$SRC_TIP") ..."
git push "$REMOTE" "$SRC_TIP:refs/heads/$DST"
ok "$DST now points at $SRC — histories are identical (0 divergence)."
