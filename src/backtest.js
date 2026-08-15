import { calculatePositionSize, getContractSpec } from './account'
import { shouldTakeTrade, getSession } from './tradeMemory'
import { detectRegime } from './marketRegime'
import { calcDynamicRisk } from './riskEngine'

// ── Stateful backtest engine ──────────────────────────────────────
// Evaluates ONE bar at a time and never looks ahead — at bar i, it only
// ever sees candles[0..i] and indicator values up to index i. This is
// the same evaluation model live trading will use later: the engine
// has no way to "know" what happens next, because it genuinely doesn't
// get called with future data until that bar actually arrives.
//
// runBacktest() below is just a convenience wrapper that calls this
// engine in a tight loop for bulk analysis (optimizer, AI feedback) —
// the live replay UI calls evaluateBar() one tick at a time instead.



export function createBacktestEngine(config = {}) {
  const {
    symbolKey = 'ES',
    accountBalance = 25000,
    riskPct = 1,
    rMultiple = 2,
    useMicro = true,
    cooldownBars = 3,
    stopLookback = 30,
    useLearning = true,        // use the unified memory's expectancy-based scoring to filter and size trades
    learningMinSample = 8,     // don't filter/scale on a combo until it has at least this much recency-weighted sample
    learningExpectancyFloor = 0, // block combos with expectancy at or below this many R
  } = config

  const spec = getContractSpec(symbolKey, useMicro)
  let balance = accountBalance
  let pos = null
  let entryIdx = null
  let lastExitIdx = -Infinity
  let openHigh = -Infinity  // highest high seen while in position (for MFE)
  let openLow = Infinity    // lowest low seen while in position (for MAE)
  const trades = []

  function closeTrade(i, candles, exitPrice, reason) {
    const entry = trades[trades.length - 1]
    const pnlPct = (exitPrice - entry.price) / entry.price * 100
    const dollarPnl = (exitPrice - entry.price) * spec.pointValue * entry.contracts
    balance += dollarPnl

    // MFE/MAE in R-multiples — tells you trade quality independent of outcome.
    // A trade that swept 0.9R against you before winning is very different from
    // one that went straight to target. Both win 2R but only one was a clean setup.
    const stopDist = entry.price - entry.stopPrice
    const mfePts = Math.max(0, openHigh - entry.price)
    const maePts = Math.max(0, entry.price - openLow)
    const mfeR = stopDist > 0 ? +(mfePts / stopDist).toFixed(2) : null
    const maeR = stopDist > 0 ? +(maePts / stopDist).toFixed(2) : null
    // Trade quality score: how efficiently did we capture available profit,
    // penalized by how close the trade came to stopping out.
    // Clean winner = near 1.0, lucky winner = ~0.3, clean loser = 0
    const rMultipleAchieved = stopDist > 0 ? (exitPrice - entry.price) / stopDist : 0
    const captureRatio = mfeR > 0 ? Math.min(1, rMultipleAchieved / mfeR) : 0
    const adversityPenalty = maeR != null ? Math.min(1, maeR) * 0.5 : 0
    const qualityScore = pnlPct > 0 ? +(Math.max(0, captureRatio - adversityPenalty)).toFixed(2) : 0

    const exitTrade = {
      type: 'exit',
      barIndex: i,
      price: exitPrice,
      time: candles[i].time,
      reason,
      pnlPct,
      dollarPnl,
      entryBarIdx: entryIdx,
      entryPrice: entry.price,
      entryReason: entry.reason,
      entryTime: entry.time,
      session: getSession(entry.time),
      contracts: entry.contracts,
      riskDollars: entry.riskDollars,
      factors: entry.factors,
      regime: entry.regime,
      stopPrice: entry.stopPrice,
      takeProfitPrice: entry.takeProfitPrice,
      plannedRR: entry.rrRatio,
      rMultiple: stopDist > 0 ? +rMultipleAchieved.toFixed(2) : null,
      atr: entry.atr,
      entryWinRate: entry.winRate,
      mfePts, maePts, mfeR, maeR, qualityScore,
      barsHeld: i - entryIdx,
      balanceAfter: balance,
    }
    trades.push(exitTrade)
    pos = null
    lastExitIdx = i
    entryIdx = null
    openHigh = -Infinity
    openLow = Infinity
    return exitTrade
  }

  // Evaluate bar i. Returns the trade event that happened at this bar
  // (entry, exit, or a learning-blocked entry), or null if nothing
  // happened. Must be called with bars in strictly increasing order —
  // that's what makes it causal.
  function evaluateBar(i, candles, indicators, signalFn) {
    if (i < 2) return null
    const c = candles[i]

    if (pos === 'long') {
      openHigh = Math.max(openHigh, c.high)
      openLow = Math.min(openLow, c.low)

      const entry = trades[trades.length - 1]

      // Stop loss
      if (c.low <= entry.stopPrice) {
        return closeTrade(i, candles, entry.stopPrice, 'Stop loss hit')
      }

      // Time-based exit
      const barsOpen = i - entryIdx
      const stopDist = entry.price - entry.stopPrice
      const currentR = stopDist > 0 ? (c.close - entry.price) / stopDist : 0

      if (barsOpen > 30 && currentR < 0.25) {
        return closeTrade(i, candles, c.close, 'Time exit: 30 bars, no progress')
      }
      if (barsOpen > 50) {
        const recentHigh = Math.max(...candles.slice(Math.max(0, i-20), i).map(b => b.high))
        if (recentHigh <= openHigh - (stopDist * 0.1)) {
          return closeTrade(i, candles, c.close, 'Time exit: 50 bars, stalling')
        }
      }
      if (barsOpen > 75) {
        return closeTrade(i, candles, c.close, 'Time exit: 75 bars max hold')
      }

      // Take profit
      if (c.high >= entry.takeProfitPrice) {
        return closeTrade(i, candles, entry.takeProfitPrice, `Take profit hit (${rMultiple}R)`)
      }

      let result
      try { result = signalFn(i, candles, indicators, pos) } catch { result = { action: 'none' } }
      if (result.action === 'sell' || result.action === 'exit') {
        return closeTrade(i, candles, c.close, result.reason || 'Exit signal triggered')
      }
      return null
    }
    // Flat — respect cooldown
    if (i - lastExitIdx < cooldownBars) return null

    let result
    try { result = signalFn(i, candles, indicators, pos) } catch { result = { action: 'none' } }
    if (result.action !== 'buy') return null


    const entryPrice = c.close
    let stopPrice = result.stopPrice
    if (stopPrice == null) {
      for (let j = i; j >= Math.max(0, i - stopLookback); j--) {
        if (indicators.swingLow?.[j]) { stopPrice = candles[j].low; break }
      }
    }
    if (stopPrice == null || stopPrice >= entryPrice) return null

    // ── Learning filter ───────────────────────────────────────────
    let decision = { take: true, sizeFactor: 1, confidence: 0, sampleSize: 0, winRate: null, expectancyR: null }
    if (useLearning) {
      decision = shouldTakeTrade(result.factors || {}, {
        minSampleSize: learningMinSample,
        expectancyFloor: learningExpectancyFloor,
      })
      if (!decision.take) {
        return {
          type: 'blocked',
          barIndex: i,
          time: c.time,
          factors: result.factors || {},
          reason: `Blocked by learning — expectancy ${decision.expectancyR >= 0 ? '+' : ''}${decision.expectancyR}R over ${decision.sampleSize} trades${decision.usedSession ? ` (${decision.usedSession} session)` : ''}`,
        }
      }
    }


// ── Cooldown filter ───────────────────────────────────────────
    if (config.cooldownBars > 0 && lastExitIdx > -Infinity) {
      const barsSinceExit = i - lastExitIdx
      if (barsSinceExit < config.cooldownBars) {
        return { type: 'blocked', barIndex: i, time: c.time, reason: `Cooldown — ${config.cooldownBars - barsSinceExit} bars remaining` }
      }
    }


    // ── Dynamic risk: ATR-based stop + probability-adjusted target ─
    const dynamicRisk = calcDynamicRisk({
      candles:     candles.slice(0, i + 1),
      side:        'LONG',
      entryPrice,
      symbol:      useMicro ? (symbolKey === 'ES' ? 'MES' : 'MNQ') : symbolKey,
      accountSize: balance,
      decision,
      baseRiskPct: riskPct,
      signalScore: result.score || 4,
    })
    // Use dynamic ATR stop if signal didn't specify one
    if (stopPrice == null || stopPrice >= entryPrice) {
      stopPrice = dynamicRisk.stopPrice
    }

    const stopDistance = entryPrice - stopPrice

    // HARD OVERRIDE — $500 max loss regardless of riskEngine output.
    // Must use the ACTUAL stop distance (signal/swing-low stop can differ
    // from the ATR-based dynamicRisk.stopDistance used to size the trade).
    const riskPerContract = stopDistance * spec.pointValue
    const maxContracts = Math.max(0, Math.floor(500 / riskPerContract))
    let contracts = dynamicRisk.contracts
    let riskDollars = dynamicRisk.riskDollars
    if (contracts > maxContracts) {
      contracts = maxContracts
      riskDollars = +(maxContracts * riskPerContract).toFixed(2)
    }
    const takeProfitPrice = dynamicRisk.targetPrice
    if (contracts < 1) return null

    pos = 'long'
    entryIdx = i
    openHigh = c.high  // reset trackers for this new trade
    openLow = c.low
    const entryTrade = {
      type: 'entry',
      barIndex: i,
      price: entryPrice,
      time: c.time,
      reason: result.reason || 'Entry signal triggered',
      factors: result.factors || {},
      regime: detectRegime(candles, i),
      stopPrice,
      takeProfitPrice,
      contracts,
      riskDollars,
      balanceAtEntry: balance,
      // Dynamic risk metadata
      atr:           dynamicRisk.currentATR,
      rrRatio:       dynamicRisk.rrRatio,
      winRate:       dynamicRisk.winRate,
      riskMultiplier: dynamicRisk.riskMultiplier,
      riskPct:       dynamicRisk.riskPct,
    }
    trades.push(entryTrade)
    return entryTrade
  }

  return {
    evaluateBar,
    getTrades: () => [...trades],
    getBalance: () => balance,
    isInPosition: () => pos === 'long',
  }
}

// ── Bulk convenience wrapper — runs the engine across every bar ───
// Used by the optimizer and AI feedback loop, which need a complete
// result set to analyze rather than a live, watchable replay.
export function runBacktest(candles, indicators, signalFn, config = {}) {
  const engine = createBacktestEngine(config)
  for (let i = 2; i < candles.length; i++) {
    engine.evaluateBar(i, candles, indicators, signalFn)
  }
  return engine.getTrades()
}

// ── Calculate performance stats — both % and real dollar terms ───
export function calcStats(exits, startingBalance = 25000) {
  if (!exits.length) return null

  const wins = exits.filter(t => t.pnlPct > 0)
  const losses = exits.filter(t => t.pnlPct <= 0)
  const totalDollarPnl = exits.reduce((s, t) => s + (t.dollarPnl || 0), 0)
  const finalBalance = startingBalance + totalDollarPnl

  let equity = startingBalance, peak = startingBalance, maxDDDollar = 0, maxDDPct = 0
  exits.forEach(t => {
    equity += (t.dollarPnl || 0)
    if (equity > peak) peak = equity
    const dd = peak - equity
    const ddPct = peak > 0 ? (dd / peak * 100) : 0
    if (dd > maxDDDollar) maxDDDollar = dd
    if (ddPct > maxDDPct) maxDDPct = ddPct
  })

  return {
    total: exits.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / exits.length * 100).toFixed(1),
    totalPnl: exits.reduce((s, t) => s + t.pnlPct, 0).toFixed(2),
    totalDollarPnl: totalDollarPnl.toFixed(2),
    startingBalance,
    finalBalance: finalBalance.toFixed(2),
    avgWin: wins.length
      ? (wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(2)
      : '0.00',
    avgLoss: losses.length
      ? (losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(2)
      : '0.00',
    avgWinDollar: wins.length
      ? (wins.reduce((s, t) => s + t.dollarPnl, 0) / wins.length).toFixed(2)
      : '0.00',
    avgLossDollar: losses.length
      ? (losses.reduce((s, t) => s + t.dollarPnl, 0) / losses.length).toFixed(2)
      : '0.00',
    maxDD: maxDDPct.toFixed(2),
    maxDDDollar: maxDDDollar.toFixed(2),
  }
}

// ── Walk-forward validation ───────────────────────────────────────
// Splits candles into 3 consecutive windows and runs the strategy on
// each independently. The ONLY honest test that a strategy improvement
// is real vs overfitted: it must perform positively across ALL three
// windows, including data it has never been optimized on.
//
// Period 1 (oldest): "training" — what you've been optimizing against
// Period 2 (middle): "validation" — unseen during optimization  
// Period 3 (newest): "out-of-sample test" — the real verdict
//
// A strategy PASSES if expectancy is positive in at least 2 of 3 periods.
// It truly passes only if period 3 (the unseen test) is also positive.
export function walkForwardValidate(candles, indicators, signalFn, config = {}) {
  const windowSize = Math.floor(candles.length / 3)
  const windows = [
    { label: 'Period 1 (train)',     start: 0,             end: windowSize },
    { label: 'Period 2 (validate)',  start: windowSize,    end: windowSize * 2 },
    { label: 'Period 3 (out-of-sample)', start: windowSize * 2, end: candles.length },
  ]

  const results = windows.map(w => {
    const slicedCandles = candles.slice(w.start, w.end)
    // Slice indicator arrays to the same window
    const slicedIndicators = Object.fromEntries(
      Object.entries(indicators).map(([k, arr]) =>
        [k, Array.isArray(arr) ? arr.slice(w.start, w.end) : arr]
      )
    )
    const engine = createBacktestEngine(config)
    for (let i = 2; i < slicedCandles.length; i++) {
      engine.evaluateBar(i, slicedCandles, slicedIndicators, signalFn)
    }
    const trades = engine.getTrades()
    const exits = trades.filter(t => t.type === 'exit')
    const stats = calcStats(exits, config.accountBalance || 25000)
    const dateStart = new Date(slicedCandles[0]?.time).toLocaleDateString()
    const dateEnd = new Date(slicedCandles[slicedCandles.length - 1]?.time).toLocaleDateString()
    return { ...w, stats, tradeCount: exits.length, dateStart, dateEnd }
  })

  const positiveCount = results.filter(r => r.stats && parseFloat(r.stats.totalDollarPnl) > 0).length
  const outOfSamplePass = results[2].stats && parseFloat(results[2].stats.totalDollarPnl) > 0

  return {
    results,
    verdict: outOfSamplePass && positiveCount >= 2 ? 'pass' : positiveCount >= 2 ? 'marginal' : 'fail',
    positiveCount,
    outOfSamplePass,
  }
}
