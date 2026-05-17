import { GAME_CONFIG, PAYLINES, STARTING_STATE, SYMBOLS, THEME_PAYOUTS } from "./gameConfig.js";

const SYMBOL_BY_ID = Object.fromEntries(SYMBOLS.map((symbol) => [symbol.id, symbol]));
const REGULAR_SYMBOL_IDS = SYMBOLS.filter((symbol) => symbol.type === "regular").map(
  (symbol) => symbol.id,
);
const NON_SPECIAL_SYMBOL_IDS = SYMBOLS.filter(
  (symbol) => symbol.type === "regular" || symbol.type === "wild",
).map((symbol) => symbol.id);

const BASE_OUTCOME_TABLE = [
  { type: "lose", weight: 60 },
  { type: "smallWin", weight: 17 },
  { type: "mediumWin", weight: 11 },
  { type: "bigWin", weight: 5 },
  { type: "freeSpins", weight: 4 },
  { type: "bonusRound", weight: 3 },
];

const FEATURE_OUTCOME_TABLE = [
  { type: "lose", weight: 46 },
  { type: "smallWin", weight: 27 },
  { type: "mediumWin", weight: 15 },
  { type: "bigWin", weight: 8 },
  { type: "retrigger", weight: 4 },
];

function cloneState(state = {}) {
  return JSON.parse(JSON.stringify(state));
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function randomItem(items) {
  return items[randomInt(items.length)];
}

function weightedPick(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;

  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) {
      return entry.type;
    }
  }

  return entries[0].type;
}

function getWinTier(amount) {
  if (amount >= GAME_CONFIG.economics.spinCost * 4) {
    return "epic";
  }

  if (amount >= GAME_CONFIG.economics.spinCost * 2) {
    return "big";
  }

  if (amount > 0) {
    return "small";
  }

  return "none";
}

function createEvent(type, summary, payload = {}) {
  return { type, summary, payload };
}

function createEmptyBoard() {
  return Array.from({ length: GAME_CONFIG.layout.reels }, () =>
    Array.from({ length: GAME_CONFIG.layout.rows }, () => randomItem(NON_SPECIAL_SYMBOL_IDS)),
  );
}

function createRandomBoard({ allowScatter = true, allowBonus = true } = {}) {
  const board = createEmptyBoard();
  const symbolPool = [...REGULAR_SYMBOL_IDS, "WILD"];

  if (allowScatter) {
    symbolPool.push("SCATTER");
  }

  if (allowBonus) {
    symbolPool.push("BONUS");
  }

  for (let reel = 0; reel < GAME_CONFIG.layout.reels; reel += 1) {
    for (let row = 0; row < GAME_CONFIG.layout.rows; row += 1) {
      board[reel][row] = randomItem(symbolPool);
    }
  }

  return board;
}

function countSymbols(board, symbolId) {
  return board.flat().filter((entry) => entry === symbolId).length;
}

function evaluateLine(board, payline, multiplier) {
  const lineSymbols = payline.map((rowIndex, reelIndex) => board[reelIndex][rowIndex]);
  let baseTheme = null;
  let consecutive = 0;

  for (const symbolId of lineSymbols) {
    const symbol = SYMBOL_BY_ID[symbolId];

    if (consecutive === 0) {
      if (symbol.type === "scatter" || symbol.type === "bonus") {
        break;
      }

      consecutive += 1;
      baseTheme = symbol.type === "wild" ? "WILD_PENDING" : symbol.themeGroup ?? symbol.id;
      continue;
    }

    if (symbol.type === "scatter" || symbol.type === "bonus") {
      break;
    }

    if (symbol.type === "wild") {
      consecutive += 1;
      continue;
    }

    if (baseTheme === "WILD_PENDING") {
      baseTheme = symbol.themeGroup ?? symbol.id;
      consecutive += 1;
      continue;
    }

    if ((symbol.themeGroup ?? symbol.id) === baseTheme) {
      consecutive += 1;
      continue;
    }

    break;
  }

  const resolvedTheme = baseTheme === "WILD_PENDING" ? "WILD" : baseTheme;
  if (!resolvedTheme || consecutive < 3) {
    return null;
  }

  const payout =
    resolvedTheme === "WILD"
      ? SYMBOL_BY_ID.WILD.payouts?.[consecutive]
      : THEME_PAYOUTS[resolvedTheme]?.payouts?.[consecutive];
  if (!payout) {
    return null;
  }

  return {
    lineSymbolId: resolvedTheme,
    displayName:
      resolvedTheme === "WILD" ? SYMBOL_BY_ID.WILD.label : THEME_PAYOUTS[resolvedTheme]?.label,
    count: consecutive,
    amount: payout * multiplier,
  };
}

export function evaluateBoard(board, multiplier) {
  const lineWins = PAYLINES.map((payline, index) => {
    const lineResult = evaluateLine(board, payline, multiplier);
    return lineResult ? { ...lineResult, line: index + 1 } : null;
  }).filter(Boolean);

  const scatterCount = countSymbols(board, "SCATTER");
  const bonusCount = countSymbols(board, "BONUS");
  const lineTotal = lineWins.reduce((sum, entry) => sum + entry.amount, 0);
  const scatterTotal =
    scatterCount >= 3 ? (SYMBOL_BY_ID.SCATTER.payouts?.[scatterCount] ?? 0) * multiplier : 0;
  const freeSpinsAward =
    scatterCount >= 3 ? GAME_CONFIG.features.baseFreeSpins + (scatterCount - 3) * 2 : 0;

  return {
    lineWins,
    scatterCount,
    bonusCount,
    freeSpinsAward,
    bonusTriggered: bonusCount >= 3,
    totalWin: lineTotal + scatterTotal,
  };
}

function createNonWinningBoard({ allowScatter = false, allowBonus = false } = {}) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const board = createRandomBoard({ allowScatter, allowBonus });
    const evaluation = evaluateBoard(board, 1);

    if (evaluation.totalWin === 0 && evaluation.scatterCount < 3 && evaluation.bonusCount < 3) {
      return board;
    }
  }

  return [
    ["TEMPLE_MEDAL", "MYSTERY_VAN", "ZANY_ROCKET"],
    ["GHOST_LANTERN", "PEGASUS_POP", "TEMPLE_MEDAL"],
    ["MYSTERY_VAN", "CARROT_CANNON", "TEMPLE_MEDAL"],
    ["PEGASUS_POP", "ZANY_ROCKET", "GHOST_LANTERN"],
    ["CARROT_CANNON", "TEMPLE_MEDAL", "MYSTERY_VAN"],
  ];
}

function fillBreakers(board, payline, fromReel) {
  for (let reel = fromReel; reel < GAME_CONFIG.layout.reels; reel += 1) {
    const row = payline[reel];
    let nextId = randomItem(REGULAR_SYMBOL_IDS);

    while (
      nextId === board[Math.max(reel - 1, 0)][payline[Math.max(reel - 1, 0)]] ||
      nextId === board[Math.max(reel - 2, 0)][payline[Math.max(reel - 2, 0)]]
    ) {
      nextId = randomItem(REGULAR_SYMBOL_IDS);
    }

    board[reel][row] = nextId;
  }
}

function buildLineWinBoard(tier, multiplier) {
  const targetRanges = {
    smallWin: [40 * multiplier, 130 * multiplier],
    mediumWin: [80 * multiplier, 260 * multiplier],
    bigWin: [180 * multiplier, 720 * multiplier],
  };

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const board = createNonWinningBoard();
    const payline = randomItem(PAYLINES);
    const symbolId =
      tier === "bigWin" && Math.random() < 0.18 ? "WILD" : randomItem(REGULAR_SYMBOL_IDS);
    const count =
      tier === "smallWin"
        ? randomItem([3, 3, 4])
        : tier === "mediumWin"
          ? randomItem([3, 4, 4, 5])
          : randomItem([4, 5, 5]);

    for (let reel = 0; reel < count; reel += 1) {
      board[reel][payline[reel]] = symbolId;
    }

    if (count < GAME_CONFIG.layout.reels) {
      fillBreakers(board, payline, count);
    }

    if (Math.random() < 0.25 && count >= 3 && symbolId !== "WILD") {
      board[randomInt(count)][payline[randomInt(count)]] = "WILD";
    }

    const evaluation = evaluateBoard(board, multiplier);
    const [min, max] = targetRanges[tier];
    if (
      evaluation.scatterCount < 3 &&
      evaluation.bonusCount < 3 &&
      evaluation.totalWin >= min &&
      evaluation.totalWin <= max
    ) {
      return board;
    }
  }

  return createNonWinningBoard();
}

function placeSpecialSymbols(board, symbolId, count) {
  const used = new Set();

  while (used.size < count) {
    const reel = randomInt(GAME_CONFIG.layout.reels);
    const row = randomInt(GAME_CONFIG.layout.rows);
    const key = `${reel}-${row}`;

    if (used.has(key)) {
      continue;
    }

    used.add(key);
    board[reel][row] = symbolId;
  }
}

function buildFreeSpinTriggerBoard(multiplier) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const board = createNonWinningBoard();
    placeSpecialSymbols(board, "SCATTER", randomItem([3, 3, 3, 4, 5]));
    const evaluation = evaluateBoard(board, multiplier);

    if (evaluation.scatterCount >= 3 && evaluation.bonusCount < 3) {
      return board;
    }
  }

  return createNonWinningBoard();
}

function buildBonusTriggerBoard(multiplier) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const board = createNonWinningBoard();
    placeSpecialSymbols(board, "BONUS", 3);
    const evaluation = evaluateBoard(board, multiplier);

    if (evaluation.bonusTriggered && evaluation.scatterCount < 3) {
      return board;
    }
  }

  return createNonWinningBoard();
}

function normalizeState(input) {
  const state = cloneState(input ?? {});

  return {
    ...cloneState(STARTING_STATE),
    ...state,
    activeFeature: state.activeFeature ?? null,
  };
}

function createInitialBoard() {
  return createRandomBoard();
}

function createAutoBonusFeature() {
  const rewards = [120, 160, 220, 320, 450]
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, GAME_CONFIG.features.bonusPicks);

  return {
    type: "bonus_round",
    totalSteps: rewards.length,
    remainingSteps: rewards.length,
    rewards,
    revealedRewards: [],
    totalBonusWin: 0,
  };
}

function createBaseSpinMessage(result) {
  if (result.bonusTriggered) {
    return "Special config generated: mystery-caper bonus round started.";
  }

  if (result.freeSpinsAward > 0) {
    return `Special config generated: ${result.freeSpinsAward} slapstick free spins started.`;
  }

  if (result.totalWin > 0) {
    const topTheme = result.lineWins[0]?.displayName ?? "theme";
    return `Regular ${topTheme} win: ${result.totalWin} coins added to balance.`;
  }

  return "No event generated. Balance reduced for the spin and UI updated.";
}

function createFeatureMessage(state, result = null, reward = null) {
  if (state.activeFeature?.type === "free_spins") {
    if (result?.freeSpinsAward > 0) {
      return `Free-spin retrigger: +${result.freeSpinsAward} additional free spins.`;
    }

    if (result?.totalWin > 0) {
      return `Free spin resolved: ${result.totalWin} coins added.`;
    }

    return "Free spin resolved with no payout.";
  }

  if (reward) {
    return `Automatic mystery bonus reveal paid ${reward.amount} coins.`;
  }

  return "Special feature resolved.";
}

function createFeatureCards(state, uiState) {
  return [
    {
      title: "Slapstick Spins",
      value:
        state.activeFeature?.type === "free_spins"
          ? state.activeFeature.remaining
          : 0,
      note: "Triggered by 3+ Toon Theater symbols",
    },
    {
      title: "Mystery Round",
      value:
        state.activeFeature?.type === "bonus_round"
          ? `${state.activeFeature.remainingSteps}/${state.activeFeature.totalSteps}`
          : "READY",
      note: "Automatic mystery-caper bonus sequence",
    },
    {
      title: "Excitement",
      value: uiState.flashTier === "none" ? "WARMING" : uiState.flashTier.toUpperCase(),
      note: "Special events intensify the front-end display",
    },
  ];
}

function createUiState({
  state,
  result = null,
  events = [],
  message = "Spin to request the next backend-computed result.",
}) {
  const lastWin = result?.totalWin ?? 0;
  const flashTier = getWinTier(lastWin);
  const activeFeature = state.activeFeature;
  const featureBadge =
    activeFeature?.type === "bonus_round"
      ? "Bonus round live"
      : activeFeature?.type === "free_spins"
        ? `${activeFeature.remaining} free spins active`
        : "Base reels hot";
  const celebrationLabel =
    events.find((event) => event.type === "bonus_round_started")
      ? "BONUS ROUND"
      : events.find((event) => event.type === "free_spins_started")
        ? "FREE SPINS"
        : flashTier === "epic"
          ? "EPIC WIN"
          : flashTier === "big"
            ? "BIG WIN"
            : lastWin > 0
              ? "NICE HIT"
              : "";

  const specialState =
    activeFeature?.type === "free_spins"
      ? {
          active: true,
          type: "free_spins",
          title: `Slapstick Spins ${activeFeature.played}/${activeFeature.totalAwarded}`,
          subtitle: `${activeFeature.remaining} auto-played cartoon free spins remain.`,
          autoAdvanceMs: 1400,
        }
      : activeFeature?.type === "bonus_round"
        ? {
            active: true,
            type: "bonus_round",
            title: "Mystery Manor Bonus",
            subtitle: `${activeFeature.remainingSteps} haunted clue reveals remain.`,
            autoAdvanceMs: 1400,
            revealedRewards: activeFeature.revealedRewards,
          }
        : null;

  const uiState = {
    modeLabel: specialState ? "Special Feature" : "Base Game",
    multiplierValue:
      activeFeature?.type === "free_spins" ? GAME_CONFIG.features.freeSpinMultiplier : 1,
    featureBadge,
    flashTier,
    celebrationLabel,
    stageTitle: celebrationLabel || (specialState ? "Feature active" : "Align the reels"),
    stageSubcopy: specialState
      ? "Backend controls the feature lifecycle and advances the state automatically with themed overlay states."
      : "Candy-like tiles align in slot-machine columns while the backend computes the next Greek-cartoon configuration.",
    resultMessage: message,
    lastWin,
    winBannerLabel: celebrationLabel || (lastWin > 0 ? "WIN CONFIRMED" : "SPIN READY"),
    lineWins: result?.lineWins ?? [],
    featureCards: [],
    overlayTheme:
      activeFeature?.type === "bonus_round"
        ? GAME_CONFIG.presentation.overlayThemes.bonusRound
        : activeFeature?.type === "free_spins"
          ? GAME_CONFIG.presentation.overlayThemes.freeSpins
          : GAME_CONFIG.presentation.overlayThemes.base,
    specialState,
    sessionSummary: {
      totalSpins: state.totalSpins,
      totalPaid: state.totalPaid,
      totalWon: state.totalWon,
      liveRtp: state.totalPaid > 0 ? ((state.totalWon / state.totalPaid) * 100).toFixed(1) : "--",
      sessionNet: state.totalWon - state.totalPaid,
    },
  };

  uiState.featureCards = createFeatureCards(state, uiState);
  return uiState;
}

function resolveOutcomeBoard(outcomeType, multiplier) {
  if (outcomeType === "lose") {
    return createNonWinningBoard();
  }

  if (outcomeType === "smallWin" || outcomeType === "mediumWin" || outcomeType === "bigWin") {
    return buildLineWinBoard(outcomeType, multiplier);
  }

  if (outcomeType === "freeSpins" || outcomeType === "retrigger") {
    return buildFreeSpinTriggerBoard(multiplier);
  }

  if (outcomeType === "bonusRound") {
    return buildBonusTriggerBoard(multiplier);
  }

  return createNonWinningBoard();
}

export function getPublicConfig() {
  return { ...GAME_CONFIG };
}

export function createInitialSession() {
  const state = normalizeState(STARTING_STATE);
  const board = createInitialBoard();
  const events = [
    createEvent(
      "session_started",
      "A new backend-owned session was created with the starting balance.",
      { balance: state.balance },
    ),
  ];

  return {
    board,
    state,
    events,
    uiState: createUiState({
      state,
      events,
      message: "Base slot grid ready. Click once to send the next config change to the backend.",
    }),
  };
}

export function resolveSpin(currentState) {
  const state = normalizeState(currentState);

  if (state.activeFeature) {
    throw new Error("A special feature is already active.");
  }

  if (state.balance < GAME_CONFIG.economics.spinCost) {
    throw new Error("Not enough balance for the next spin.");
  }

  const nextState = normalizeState(state);
  nextState.balance -= GAME_CONFIG.economics.spinCost;
  nextState.totalPaid += GAME_CONFIG.economics.spinCost;
  nextState.totalSpins += 1;

  const outcomeType = weightedPick(BASE_OUTCOME_TABLE);
  const board = resolveOutcomeBoard(outcomeType, 1);
  const result = evaluateBoard(board, 1);

  nextState.balance += result.totalWin;
  nextState.totalWon += result.totalWin;

  let events = [];

  if (result.freeSpinsAward > 0) {
    nextState.activeFeature = {
      type: "free_spins",
      remaining: result.freeSpinsAward,
      totalAwarded: result.freeSpinsAward,
      played: 0,
    };
    events = [
      createEvent(
        "free_spins_started",
        `${result.freeSpinsAward} free spins were generated by the backend.`,
        { amount: result.freeSpinsAward },
      ),
    ];
  } else if (result.bonusTriggered) {
    nextState.activeFeature = createAutoBonusFeature();
    events = [
      createEvent(
        "bonus_round_started",
        "A backend-generated bonus round entered its automatic special state.",
      ),
    ];
  } else {
    nextState.activeFeature = null;
  }

  const message = createBaseSpinMessage(result);

  return {
    board,
    state: nextState,
    events,
    uiState: createUiState({
      state: nextState,
      result,
      events,
      message,
    }),
    result: {
      ...result,
      outcomeType,
      message,
    },
  };
}

export function continueFeature(currentState, currentBoard) {
  const state = normalizeState(currentState);
  const activeFeature = state.activeFeature;

  if (!activeFeature) {
    throw new Error("No active special feature to continue.");
  }

  if (activeFeature.type === "free_spins") {
    const nextState = normalizeState(state);
    const nextFeature = cloneState(activeFeature);
    const outcomeType = weightedPick(FEATURE_OUTCOME_TABLE);
    const board = resolveOutcomeBoard(outcomeType, GAME_CONFIG.features.freeSpinMultiplier);
    const result = evaluateBoard(board, GAME_CONFIG.features.freeSpinMultiplier);

    nextState.totalSpins += 1;
    nextState.balance += result.totalWin;
    nextState.totalWon += result.totalWin;

    nextFeature.remaining -= 1;
    nextFeature.played += 1;
    nextFeature.remaining += result.freeSpinsAward;
    nextFeature.totalAwarded += result.freeSpinsAward;

    let events = [];

    if (result.freeSpinsAward > 0) {
      events.push(
        createEvent(
          "free_spins_retriggered",
          `${result.freeSpinsAward} extra free spins were added during the feature.`,
          { amount: result.freeSpinsAward },
        ),
      );
    }

    if (nextFeature.remaining <= 0) {
      nextState.activeFeature = null;
      events.push(
        createEvent(
          "free_spins_completed",
          "The automatic free-spin feature is complete.",
        ),
      );
    } else {
      nextState.activeFeature = nextFeature;
    }

    const message = createFeatureMessage(nextState, result);

    return {
      board,
      state: nextState,
      events,
      uiState: createUiState({
        state: nextState,
        result,
        events,
        message,
      }),
      result: {
        ...result,
        outcomeType,
        message,
      },
    };
  }

  if (activeFeature.type === "bonus_round") {
    const nextState = normalizeState(state);
    const nextFeature = cloneState(activeFeature);
    const reward = nextFeature.rewards[nextFeature.totalSteps - nextFeature.remainingSteps];

    nextFeature.remainingSteps -= 1;
    nextFeature.revealedRewards.push(reward);
    nextFeature.totalBonusWin += reward;

    nextState.balance += reward;
    nextState.totalWon += reward;

    let events = [
      createEvent(
        "bonus_round_progress",
        `Automatic bonus reveal paid ${reward} coins.`,
        { amount: reward },
      ),
    ];

    if (nextFeature.remainingSteps <= 0) {
      nextState.activeFeature = null;
      events.push(
        createEvent(
          "bonus_round_completed",
          "The automatic bonus round finished and control returned to the base game.",
          { totalBonusWin: nextFeature.totalBonusWin },
        ),
      );
    } else {
      nextState.activeFeature = nextFeature;
    }

    const message = createFeatureMessage(nextState, null, { amount: reward });

    return {
      board: currentBoard,
      state: nextState,
      events,
      uiState: createUiState({
        state: nextState,
        events,
        message,
      }),
      result: {
        message,
        reward: { amount: reward, type: "coins" },
      },
    };
  }

  throw new Error("Unsupported feature type.");
}
