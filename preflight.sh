#!/usr/bin/env bash
# One-shot pre-flight against RAREAURA's server. Exits on its own.
export MC_HOST=54.204.234.44
export MC_PORT=25565
export BOT_USERNAME=Trisha
cd /projects/sandbox/TrishaPlayer
exec timeout 100 node scripts/connect-test.js
