#!/usr/bin/env bash
# Runs Trisha against RAREAURA's live server for a bounded window, then exits.
# Autonomy ON — this is the grinding mode, the one that has been under test.
# Usage: bash live-run.sh [seconds]
cd /projects/sandbox/TrishaPlayer
WINDOW="${1:-600}"
LOG=/projects/sandbox/live-trisha.log
: > "$LOG"
echo "window: ${WINDOW}s  (autonomy on, planner claude-opus-4.8)"
AUTONOMY=true LADDER_ON_SPAWN=true MODEL_PLANNER=claude-opus-4.8 \
  timeout "$WINDOW" node src/index.js > "$LOG" 2>&1
echo "--- window closed ---"
