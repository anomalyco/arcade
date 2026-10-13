/** Metres, width × height × depth, including lids, feet and handles. Shared by art and collision. */
export const PROP_SIZE = {
  cone: [.4, .7, .4],
  barrier: [2, 1.1, .7],
  sawhorse: [1.2, .8, .6],
  bin: [.6, 1, .65],
  dumpster: [1.8, 1.2, 1.2],
  newspaper: [.5, 1, .45],
  bench: [1.8, .85, .55],
  planter: [.6, .6, .6],
  crate: [.8, .8, .8],
  pallet: [1.2, .15, 1],
  sign: [.6, 1.2, .6],
  hydrant: [.3, .75, .3],
  meter: [.24, 1.3, .2],
  mailbox: [.5, 1.1, .45],
  propane: [.32, .5, .32],
  canister: [.35, .47, .18],
  fuel: [.6, .9, .6],
} as const

export const BENCH_SEAT_HEIGHT = .45
