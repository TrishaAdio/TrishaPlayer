#!/usr/bin/env bash
# Runs Trisha against RAREAURA's live server for a bounded window, then exits.
# Usage: bash live-run.sh [seconds]
cd /projects/sandbox/TrishaPlayer
WINDOW="${1:-480}"
LOG=/projects/sandbox/live-trisha.log
: > "$LOG"
echo "window: ${WINDOW}s"
timeout "$WINDOW" node src/index.js > "$LOG" 2>&1
echo "--- window closed ---"
