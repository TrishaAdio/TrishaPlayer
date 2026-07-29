/**
 * SPARRING ARCHETYPES — opponents that are not just a mirror of her.
 *
 * Self-play has a blind spot: it proves she beats her own previous profile, which
 * says nothing about how she handles a person. These profiles model how people
 * actually fight, including the parts that make humans human — reaction latency of
 * 150-250ms, imperfect aim, fumbled clicks, and habits she can learn to exploit.
 *
 * `human` is the honest yardstick: a competent PvP player, not a world-class one.
 */
export const ARCHETYPES = {
  /** Straight-line aggression. Sprints in, swings constantly, never resets. */
  rusher: {
    label: 'rusher — sprints in and clicks',
    kit: ['iron_sword 1', 'iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1'],
    params: {
      engageRange: 2.6, tooClose: 1.2, requireCrit: false, shieldDuringCooldown: false,
      jumpApproachChance: 0.7, sprintApproachFrom: 3, strafeMinMs: 2000, strafeMaxMs: 3000,
      reactionDelayMs: 180, aimErrorDeg: 2.5, missChance: 0.12, useAxe: false, breakOffHp: 0,
    },
  },

  /** Hides behind a shield and pokes. The axe doctrine exists for this one. */
  shieldcamp: {
    label: 'shield camper — blocks, pokes, blocks',
    kit: ['iron_sword 1', 'shield 1', 'iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1'],
    params: {
      engageRange: 3.2, tooClose: 2.4, shieldDuringCooldown: true, shieldRange: 5,
      requireCrit: false, strafeMinMs: 1500, strafeMaxMs: 2500, jumpApproachChance: 0.05,
      reactionDelayMs: 200, aimErrorDeg: 2, missChance: 0.1, useAxe: false, breakOffHp: 0,
    },
  },

  /** Keeps distance and shoots. Tests whether she can close a gap under fire. */
  bowkite: {
    label: 'bow kiter — stays out and shoots',
    kit: ['iron_sword 1', 'bow 1', 'arrow 64', 'iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1'],
    params: {
      engageRange: 3.4, tooClose: 3.0, pursueRange: 30, requireCrit: false,
      reactionDelayMs: 220, aimErrorDeg: 3, missChance: 0.15, useAxe: false, breakOffHp: 0,
      bowDrawMs: 1100, bowLeadFactor: 0.8,
    },
    ranged: true,
  },

  /** Circles hard and looks for crits. The classic decent-player pattern. */
  strafer: {
    label: 'strafer — circles and crit-hunts',
    kit: ['iron_sword 1', 'iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1'],
    params: {
      engageRange: 3.2, tooClose: 2.0, requireCrit: true, critJumpHoldMs: 90,
      strafeMinMs: 400, strafeMaxMs: 900, jumpApproachChance: 0.4,
      reactionDelayMs: 160, aimErrorDeg: 2, missChance: 0.08, useAxe: false, breakOffHp: 0,
    },
  },

  /** A well-rounded competent player: shield, axe, resets, sensible spacing. */
  human: {
    label: 'human — competent all-rounder',
    kit: ['iron_sword 1', 'iron_axe 1', 'shield 1', 'iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1'],
    params: {
      engageRange: 3.1, tooClose: 2.0, requireCrit: true, critJumpHoldMs: 80,
      shieldDuringCooldown: true, strafeMinMs: 600, strafeMaxMs: 1400,
      jumpApproachChance: 0.35, sprintResetMs: 60,
      reactionDelayMs: 200, aimErrorDeg: 2.2, missChance: 0.1, useAxe: true, breakOffHp: 0,
    },
  },

  /** No handicaps at all — a perfect mirror. Sanity check: should sit near 50%. */
  mirror: {
    label: 'mirror — her own profile, no handicaps',
    kit: ['iron_sword 1', 'shield 1', 'iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1'],
    params: { breakOffHp: 0 },
  },
};

export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES);
