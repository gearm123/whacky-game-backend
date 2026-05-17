export const PAYLINES = [
  [0, 0, 0, 0, 0],
  [1, 1, 1, 1, 1],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 0, 0],
  [2, 2, 1, 2, 2],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 1, 1, 1, 0],
];

export const SYMBOLS = [
  {
    id: "TEMPLE_MEDAL",
    label: "Temple Medal",
    tag: "Greek",
    type: "regular",
    themeGroup: "GREEK",
    themeLabel: "Greek",
    accent: "symbol-violet",
  },
  {
    id: "PEGASUS_POP",
    label: "Pegasus Pop",
    tag: "Greek",
    type: "regular",
    themeGroup: "GREEK",
    themeLabel: "Greek",
    accent: "symbol-coral",
  },
  {
    id: "MYSTERY_VAN",
    label: "Mystery Van",
    tag: "Network",
    type: "regular",
    themeGroup: "MYSTERY",
    themeLabel: "Network",
    accent: "symbol-green",
  },
  {
    id: "GHOST_LANTERN",
    label: "Ghost Lantern",
    tag: "Network",
    type: "regular",
    themeGroup: "MYSTERY",
    themeLabel: "Network",
    accent: "symbol-sky",
  },
  {
    id: "ZANY_ROCKET",
    label: "Zany Rocket",
    tag: "Loony",
    type: "regular",
    themeGroup: "SLAPSTICK",
    themeLabel: "Loony",
    accent: "symbol-gold",
  },
  {
    id: "CARROT_CANNON",
    label: "Carrot Cannon",
    tag: "Loony",
    type: "regular",
    themeGroup: "SLAPSTICK",
    themeLabel: "Loony",
    accent: "symbol-amber",
  },
  {
    id: "WILD",
    label: "Mash-Up Mask",
    tag: "Wild",
    type: "wild",
    accent: "symbol-wild",
    payouts: { 3: 90, 4: 240, 5: 600 },
  },
  {
    id: "SCATTER",
    label: "Toon Theater",
    tag: "Free spins",
    type: "scatter",
    accent: "symbol-scatter",
    payouts: { 3: 80, 4: 180, 5: 320 },
  },
  {
    id: "BONUS",
    label: "Mystery Manor",
    tag: "Bonus round",
    type: "bonus",
    accent: "symbol-bonus",
  },
];

export const THEME_PAYOUTS = {
  GREEK: { label: "Greek", payouts: { 3: 38, 4: 92, 5: 200 } },
  MYSTERY: { label: "Network", payouts: { 3: 42, 4: 98, 5: 215 } },
  SLAPSTICK: { label: "Loony", payouts: { 3: 34, 4: 86, 5: 185 } },
};

export const GAME_CONFIG = {
  gameId: "olympus-giggle-reels",
  title: "Whacky Slot",
  subtitle: "Greek empire chaos with a zany cartoon style",
  layout: {
    reels: 5,
    rows: 3,
    paylines: PAYLINES,
  },
  economics: {
    spinCost: 100,
    targetRtp: 0.935,
    houseEdge: 0.065,
    hitFrequencyRange: [0.3, 0.45],
    configuredHitFrequency: 0.4,
    volatility: "medium",
  },
  features: {
    baseFreeSpins: 8,
    freeSpinMultiplier: 2,
    bonusPicks: 3,
  },
  presentation: {
    themeName: "Greek empire cartoon",
    styleNotes: [
      "No branded characters",
      "Greek overworld background",
      "Mystery-caper overlay for bonus round",
      "Slapstick cartoon overlay for free spins",
      "Candy-like puzzle pieces in slot columns",
    ],
    overlayThemes: {
      base: "greek",
      freeSpins: "slapstick",
      bonusRound: "mystery",
    },
  },
  eventDefinitions: [
    {
      type: "session_started",
      label: "Session Started",
      description: "A new backend-owned game session was created.",
    },
    {
      type: "free_spins_started",
      label: "Free Spins Started",
      description: "A special configuration entered the automatic free-spin state.",
    },
    {
      type: "free_spins_retriggered",
      label: "Free Spins Retriggered",
      description: "Additional free spins were generated during the feature.",
    },
    {
      type: "free_spins_completed",
      label: "Free Spins Completed",
      description: "The automatic free-spin feature ended.",
    },
    {
      type: "bonus_round_started",
      label: "Bonus Round Started",
      description: "A special configuration entered the automatic bonus state.",
    },
    {
      type: "bonus_round_progress",
      label: "Bonus Round Progress",
      description: "The backend automatically resolved one bonus reveal step.",
    },
    {
      type: "bonus_round_completed",
      label: "Bonus Round Completed",
      description: "The automatic bonus round finished and control returned to base play.",
    },
  ],
  themePayouts: THEME_PAYOUTS,
  symbols: SYMBOLS,
};

export const STARTING_STATE = {
  balance: 5000,
  activeFeature: null,
  totalSpins: 0,
  totalPaid: 0,
  totalWon: 0,
};
