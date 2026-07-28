# Trisha — build plan

An autonomous Minecraft player. Mineflayer body, LLM brain, hardcoded reflexes.
Target: cracked (offline-mode) server. Goal is not "a chatbot that types in chat" —
it is a player that outfights and outbuilds humans and never dies stupidly.

---

## 1. Core design decision

Three layers, strictly separated by latency budget. This is the whole reason she
won't play like a noob.

| Layer | Tick rate | Powered by | Owns |
|---|---|---|---|
| **Reflex** | 20/s (every physics tick) | plain JS, zero LLM | staying alive, hit timing, dodges |
| **Skill** | seconds | plain JS routines | mining, crafting, building, pathing, fighting |
| **Brain** | every ~6s or on event | LLM | *what to do next*, talking, replanning |

The LLM never touches anything time-critical. A creeper fuse is 1.5s; a model call is
1–5s. Anything that must beat a fuse lives in the reflex layer.

**Corollary:** combat quality is engineering, not prompting. Frame-perfect crit timing
and cooldown discipline come from code. The brain only decides *whether* to fight.

---

## 2. Module map

```
src/
  index.js              boot, crash-proof reconnect w/ backoff
  config.js             env  [DONE]
  bot.js                spawn bot, load plugins, wire layers

  llm/
    client.js           ZenAPI OpenAI-compatible, tiers, backoff, JSON extract  [DONE]
    persona.js          who Trisha is (voice only)                             [DONE]
    brain.js            decision loop: state -> action, failure escalation
    schema.js           action catalogue + validation (the contract)
    chat.js             in-game conversation, short replies

  reflex/
    survival.js         auto-eat, low-HP bail, lava/fire, drown, fall, dig-safety
    threat.js           creeper fuse dodge, skeleton line-of-sight break, phantom cover
    gear.js             auto-equip best armour/weapon/tool, shield to off-hand

  combat/
    engine.js           the fight loop (cooldown, crits, strafe, sprint-reset, shield)
    targeting.js        who to hit, threat scoring, owner-attacker priority
    ranged.js           bow charge + target leading, crossbow, pearls
    duel.js             player-vs-player mode (tighter, more aggressive)

  skills/
    move.js             goto / follow / come / flee / explore / waypoints
    gather.js           mine N of X, vein-follow, chop trees, pick up drops
    craft.js            recipe resolve, auto-place crafting table, smelt
    build.js            emergency shelter, walls, house, bridge, pillar, stairs
    farm.js             plant/harvest crops, breed + butcher animals, fish
    storage.js          chests: deposit, withdraw, inventory hygiene
    misc.js             sleep, torch-light area, give items, drop, sign
  progression.js        wood -> stone -> iron -> diamond -> full kit macro

  world/
    state.js            compact LLM snapshot (token-cheap, information-dense)
    memory.js           persistent: base, bed, chests, ores, deaths, lessons  [DONE]
    scan.js             block/entity queries, cave & danger detection
  util/log.js           coloured logging  [DONE]

scripts/
  probe-llm.js          verify ZenAPI + which models return valid decision JSON
  test-server.sh        local offline-mode server for real verification
```

---

## 3. The action schema (the contract)

Brain returns **one** JSON object per decision. Strict JSON, not tool-calling — the
relay's function-call support is unverified, plain JSON works everywhere.

```json
{
  "say":    "optional short chat line, or null",
  "action": { "name": "mine", "args": { "block": "iron_ore", "count": 8 } },
  "why":    "one short clause, for logs",
  "plan":   ["optional", "next", "steps"],
  "remember": "optional durable lesson to write to memory"
}
```

Action catalogue — every name here maps to exactly one skill function:

| Group | Actions |
|---|---|
| move | `goto{x,y,z}` `follow{player,dist}` `come` `flee{from}` `explore{radius}` `waypoint{name}` `home` |
| gather | `mine{block,count}` `chopWood{count}` `collectDrops{radius}` `digDown{toY}` |
| craft | `craft{item,count}` `smelt{item,count}` `equipBest` |
| build | `shelter` `build{kind,size}` `bridge{x,y,z}` `pillarUp{height}` `placeBlock{block,x,y,z}` `lightArea` |
| combat | `attack{target}` `defend{player}` `duel{player}` `hunt{mob}` `retreat` |
| survive | `eat{food?}` `sleep` `heal` |
| farm | `farmCrops{crop}` `harvest` `butcher{animal,count}` `fish{count}` |
| storage | `deposit{items?}` `withdraw{item,count}` `give{player,item,count}` |
| meta | `progression{tier}` `idle{seconds}` `stop` `say` |

Rules:
- Unknown action name → rejected, fed back to brain as an error, never crashes.
- Args validated + coerced before execution.
- One action runs at a time; each is **cancellable** mid-flight (owner order or reflex
  interrupt kills it instantly).

---

## 3b. Spawn behaviour — the survival ladder

What she does on spawn with nobody telling her anything. Implemented in
`src/progression.js`, runs with **zero LLM calls**.

| # | Rung | Complete when |
|---|---|---|
| 1 | mark home, equip best | base coords saved |
| 2 | don't starve | food > 6 or any food held |
| 3 | gather logs | 6+ logs |
| 4 | crafting table + wooden pickaxe + axe | pick tier >= wood |
| 5 | mine cobblestone | 22+ cobble |
| 6 | stone kit (pick, sword, axe, shovel, furnace) | pick + sword tier >= stone |
| 7 | food security — hunt and cook | 8+ cooked food |
| 8 | coal + 32 torches | 24+ torches |
| 9 | shelter (and a bed if wool allows) | shelter or bed known |
| 10 | branch mine iron at Y=16 | 24 raw iron |
| 11 | full iron armour + sword + shield | 4/4 iron armour worn |
| 12 | bucket of water (lava safety + MLG saves) | water bucket held |
| 13 | branch mine diamonds at Y=-54 | 3+ diamonds |
| 14 | **return home alive**, deposit loot | home reached, chest stocked |
| 15 | diamond pickaxe + sword | tier >= diamond |
| 16 | full diamond armour | 4/4 diamond worn |

**The critical design property: every rung is a predicate on current state, never a
counter.** So if she dies at diamond level, or the process restarts, or you hand her a
stack of iron, she re-evaluates and resumes at the correct rung instead of starting from
scratch. Give her iron armour by hand and she skips rungs 10–11 entirely.

Interrupt policy: any order from RAREAURA pauses the ladder instantly and resumes it
afterwards. Reflexes (HP floor, creeper, lava) override the ladder unconditionally.
She heads home early if HP < 8, inventory > 85% full, or her pickaxe is about to break.

Y-levels chosen for 1.21: iron peaks around Y=16, diamonds are densest near Y=-59 but
lava lakes live there, so Y=-54 is the yield/safety sweet spot. Both configurable.

## 4. What "ultimate" concretely means

Not vibes — a checklist I can verify.

**PvP (1.9+ combat)**
- Attack only on cooldown reset (~12.5 ticks sword) for full damage, never spam-click
- Jump-crits: attack during downward velocity only
- Sprint-reset / w-tap for maximum knockback
- Strafe-circle the target, stay in the 3.0–3.5 block sweet spot
- Shield raise between swings, drop to attack, hard-block vs skeletons/creepers
- Bow: charge to full, lead a moving target using its velocity vector
- Anti-combo: on knockback, disengage, heal, re-enter on your terms
- Gapple / potion usage under pressure

**Survival (target: near-zero avoidable deaths)**
- Eat before food ever hits critical, never at 0
- Hard HP floor → disengage + retreat, non-negotiable, overrides any order
- Creeper: detect fuse start, sprint out of blast radius, or shield-tank
- Never dig into lava — scan the 6 neighbours of every block before breaking it
- Never dig straight down without a water/scaffold check
- Fall damage: pathfinder configured to refuse lethal drops
- Drowning: force swim-up. Fire/lava: immediate escape vector
- Night with no shelter → auto-build one, don't stand there getting sniped

**Everything else**
- Full tech-tree climb unattended: logs → stone tools → iron armour → diamonds → enchants
- Vein-following miner (finds the whole ore blob, not one block)
- Real structures, not dirt boxes
- Food security: wheat farm + animal pen so she never starves
- Remembers base, bed, chests, ore locations, and *why she died* across restarts

---

## 5. Verification — how we know it actually works

No guessing. Two gates:

1. **`npm run probe`** — hits ZenAPI, tests each candidate model with a real fake game
   state, reports latency + whether it returns schema-valid JSON. Picks the tier lineup
   from evidence instead of my opinion.
2. **Local test server** — Java 25 is available in this sandbox, so I spin up an
   offline-mode server here, connect Trisha, and verify live: she spawns, eats, mines,
   crafts, kills a mob, survives a night. Then you point her at your real server.

---

## 6. Build order

| # | Milestone | Status |
|---|---|---|
| 0 | Scaffold, deps, config, logging | done |
| 1 | LLM client + persona + memory | done |
| 2 | `probe-llm.js` → confirm relay + lock model tiers | done |
| 3 | bot.js + state.js + reflex layer + clutches | done |
| 4 | Movement + gather + craft skills | done |
| 5 | Combat engine + targeting + ranged + creeper doctrine | done |
| 6 | Build + farm + storage skills | done |
| 7 | Brain loop + chat commands + interrupts + self-defence watcher | done |
| 8 | Survival ladder | done |
| 9 | Live test on a real 1.21.4 server | done |

## Verification record

Offline (`npm run dry`): 46/46 — command parsing, ladder resolution including
resume-after-gift, registry integrity.

Model probe (`npm run probe`) against the live relay:

| model | ping | decide | verdict |
|---|---|---|---|
| claude-haiku-4.5 | 1357ms | 2198ms | good — chosen as FAST |
| gpt-5.6-terra | 1805ms | 2454ms | good — first fallback |
| claude-opus-5 | 1611ms | 7027ms | good — chosen as SMART |
| gpt-5.4-mini | 4946ms | 4891ms | good |
| gpt-5.5 | 2412ms | 5123ms | good |
| claude-haiku-4-5 (dash) | — | — | **DEAD, 503 no channel** |
| claude-sonnet-4-6 | — | — | DEAD, 503 |
| claude-opus-4-6 | — | — | DEAD, 503 |

Live (Paper 1.21.4, offline-mode, in-sandbox):
- connected, marked home, worked the ladder unattended: 8 logs → crafting table →
  sticks → wooden pickaxe → wooden axe → cobblestone
- owner obedience 5/5 via a stand-in RAREAURA bot: came from 17.2m to 1.9m on
  "come here", answered a status query, held follow through a sprint at 5.2m,
  stopped within 2.3m of being told, accepted a freeform order
- combat: killed zombies, spiders, skeletons with crits confirmed in the log
- creepers: dodge clutch fired, no melee engagement, **0 deaths**

### Bugs the live test caught that no amount of code review would have

1. **Totem/shield off-hand war.** The totem clutch and the shield reflex both wanted
   slot 45 and fought over it 20x/second, starving the event loop so she never
   engaged anything. Fixed with explicit off-hand arbitration (totem outranks shield
   below 8 HP) plus a tick mutex.
2. **No self-defence while busy.** The brain loop returns early while an action runs,
   and mining a vein occupies the executor for minutes — so she stood there being
   eaten because she was "busy". Fixed with an independent 700ms defence watcher that
   interrupts non-combat work.
3. **She brawled a creeper and died.** Melee range starts the fuse and the fuse ends
   before the attack cooldown refills. Fixed with the creeper doctrine.
4. **Drowning panic loop.** Any submersion counted as drowning and the land-finder was
   too slow and short-ranged to find a shoreline. Fixed with an indexed 40-block
   search, a lower oxygen threshold, and log rate-limiting.

---

## 6b. Phase 2 — the actual ceiling

Milestones 0–9 produce a bot that beats most humans. These five make her one that
cannot be beaten. Deliberately sequenced *after* the baseline, because each one
extends something that must already work.

| # | Capability | Why it matters | Depends on |
|---|---|---|---|
| P1 | **Self-play combat tuning** | Runs hundreds of automated duels vs a sparring bot, sweeping strafe radius / crit commit window / re-engage delay / shield rhythm. Turns hand-tuned guesses into *measured* optima. No LLM cost. | combat engine |
| P2 | **Opponent modelling** | Per-username behavioural profiles: jump-swing habits, strafe bias, panic-block, retreat pattern. Adapts in 2 fights, remembers forever. | combat engine, memory |
| P3 | **Blueprint building** | `.nbt`/`.schem` schematic support + material calculation + auto-gather missing blocks + placement/scaffold solver. The gap between "built a house" and "built *that*". | build skills |
| P4 | **Self-written skills (Voyager-style)** | LLM authors new mineflayer routines at runtime, verifies them in-world, saves what works. Her ability compounds instead of being capped by hand-coded skills. | skill library |
| P5 | **Speculative planning** | Pre-plan the next action while the current one runs; cache decisions for recurring states. Removes the last perceptible "thinking" stutter. | brain loop |

**P4 sandbox requirements (the one sharp edge in this design):** generated code gets no
`fs`, no network, no `child_process`, no `process`, no `require`/dynamic import — only a
whitelisted bot API surface, a hard wall-clock timeout, and a kill switch. Off by default,
opt-in via env flag.

Explicitly rejected: vector/semantic memory (flat JSON + lessons is sufficient at this
scale), multi-agent swarm (the point is one Trisha). Deferred indefinitely: headless
vision via prismarine-viewer into a multimodal model — real aesthetic upside, poor
latency/cost tradeoff.

## 7. Open risks

| Risk | Mitigation |
|---|---|
| ~~Server version unsupported~~ | Resolved: target is **1.21 Fabric**, natively supported by mineflayer. No ViaProxy needed. Confirm exact patch (1.21.1 / .4 / .8) to pin protocol data. |
| Fabric server-side mods adding custom packets | Vanilla-protocol Fabric servers work unchanged. If mods require a client-side counterpart, she may need packet stubs — tell me the modlist. |
| Relay rate-limits (429) under a 6s loop | Backoff, adaptive interval, event-driven thinking instead of fixed polling, cheap fast tier |
| LLM picks nonsense actions | Strict validation + failure feedback + escalate to `claude-opus-4.8` after repeated failure |
| Cost drift from constant calls | Reflexes handle most situations with no call at all; brain only fires on state change |
| Anti-cheat / server rules | Reach and speed stay within vanilla limits — she plays legit, just perfectly |

---

## 8. Needed from you

1. `sk-...` ZenAPI key → goes in `.env`, git-ignored, never committed
2. Server host + port (and version if you know it)
3. Your exact in-game name → she obeys and protects that player
