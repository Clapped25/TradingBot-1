import { calculatePositionSize, getContractSpec } from './account'
import { shouldTakeTrade } from './tradeMemory'
import { detectRegime } from './marketRegime'
import { calcDynamicRisk } from './riskEngine'

// ── Stronger structure detection (matches server/bot.js) ──────────
function detectStructure(candles) {
  if (candles.length < 15) return 'neutral'
  const swings = []
  for (let i = 4; i < candles.length - 4; i++) {
    const isH = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                candles[i].high > candles[i-3].high && candles[i].high > candles[i-4].high &&
                candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high &&
                candles[i].high > candles[i+3].high && candles[i].high > candles[i+4].high
    const isL = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                candles[i].low < candles[i-3].low && candles[i].low < candles[i-4].low &&
                candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low &&
                candles[i].low < candles[i+3].low && candles[i].low < candles[i+4].low
    if (isH) swings.push({ type: 'high', price: candles[i].high })
    if (isL) swings.push({ type: 'low',  price: candles[i].low })
  }
  if (swings.length < 6) return 'neutral'
  const highs = swings.filter(s => s.type === 'high').slice(-3)
  const lows  = swings.filter(s => s.type === 'low').slice(-3)
  if (highs.length < 3 || lows.length < 3) return 'neutral'
  const hhh  = highs[2].price > highs[1].price && highs[1].price > highs[0].price
  const hlhl = lows[2].price > lows[1].price && lows[1].price > lows[0].price
  const lll  = highs[2].price < highs[1].price && highs[1].price < highs[0].price
  const lhlh = lows[2].price < lows[1].price && lows[1].price < lows[0].price
  if (hhh && hlhl) return 'bullish'
  if (lll && lhlh) return 'bearish'
  return 'neutral'
}

// ── Bias with lock ────────────────────────────────────────────────
function calcBiasWithLock(candles, i, prevBias, prevBiasBarIdx) {
  const bias1H = detectStructure(candles.slice(Math.max(0, i - 100), i + 1))
  const bias4H = detectStructure(candles.slice(0, i + 1))
  let direction = 'both', threshold = 5
  if (bias1H === 'bullish' && bias4H === 'bullish')       { direction = 'long';  threshold = 4 }
  else if (bias1H === 'bearish' && bias4H === 'bearish')  { direction = 'short'; threshold = 4 }
  else if (bias1H !== 'neutral' && bias4H !== 'neutral' && bias1H !== bias4H) { direction = 'both'; threshold = 7 }

  // Bias lock — 3 bars minimum before direction change
  const lockBars = 3
  if (prevBias && prevBias !== 'both' && direction !== prevBias) {
    const barsSinceLock = i - (prevBiasBarIdx || 0)
    if (barsSinceLock < lockBars) {
      direction = prevBias
      threshold = prevBias === 'long' ? 4 : prevBias === 'short' ? 4 : 5
    } else {
      const clearBreak = (bias1H !== 'neutral' && bias4H !== 'neutral' && bias1H === bias4H)
      if (!clearBreak) { direction = 'both'; threshold = 5 }
    }
  }
  return { direction, threshold }
}

// ── Stateful backtest engine ──────────────────────────────────────
export function createBacktestEngine(config = {}) {
  const {
    symbolKey = 'ES', accountBalance = 25000, riskPct = 1, rMultiple = 2,
    useMicro = true, cooldownBars = 3, stopLookback = 30,
    useLearning = true, useSweepFilter = false,
    learningMinSample = 8, learningExpectancyFloor = 0,
  } = config

  const spec = getContractSpec(symbolKey, useMicro)
  let balance = accountBalance, pos = null, entryIdx = null
  let lastExitIdx = -Infinity, openHigh = -Infinity, openLow = Infinity
  let currentBias = 'both', biasLockedAt = 0
  const trades = []

  function closeTrade(i, candles, exitPrice, reason) {
    const entry     = trades[trades.length - 1]
    const pnlPct    = (exitPrice - entry.price) / entry.price * 100
    const dollarPnl = (exitPrice - entry.price) * spec.pointValue * entry.contracts
    balance += dollarPnl
    const stopDist  = entry.price - entry.stopPrice
    const mfePts    = Math.max(0, openHigh - entry.price)
    const maePts    = Math.max(0, entry.price - openLow)
    const mfeR      = stopDist > 0 ? +(mfePts / stopDist).toFixed(2) : null
    const maeR      = stopDist > 0 ? +(maePts / stopDist).toFixed(2) : null
    const rMultipleAchieved = stopDist > 0 ? (exitPrice - entry.price) / stopDist : 0
    const captureRatio      = mfeR > 0 ? Math.min(1, rMultipleAchieved / mfeR) : 0
    const adversityPenalty  = maeR != null ? Math.min(1, maeR) * 0.5 : 0
    const qualityScore      = pnlPct > 0 ? +(Math.max(0, captureRatio - adversityPenalty)).toFixed(2) : 0
    const exitTrade = {
      type: 'exit', barIndex: i, price: exitPrice, time: candles[i].time, reason,
      pnlPct, dollarPnl, entryBarIdx: entryIdx, entryPrice: entry.price,
      entryReason: entry.reason, entryTime: entry.time, contracts: entry.contracts,
      riskDollars: entry.riskDollars, factors: entry.factors, regime: entry.regime,
      stopPrice: entry.stopPrice, takeProfitPrice: entry.takeProfitPrice,
      mfePts, maePts, mfeR, maeR, qualityScore, balanceAfter: balance,
    }
    trades.push(exitTrade)
    pos = null; lastExitIdx = i; entryIdx = null; openHigh = -Infinity; openLow = Infinity
    return exitTrade
  }

  function evaluateBar(i, candles, indicators, signalFn) {
    if (i < 2) return null
    const c = candles[i]

    if (pos === 'long') {
      openHigh = Math.max(openHigh, c.high)
      openLow  = Math.min(openLow,  c.low)
      const entry = trades[trades.length - 1]
      if (c.low  <= entry.stopPrice)     return closeTrade(i, candles, entry.stopPrice,     'Stop loss hit')
      if (c.high >= entry.takeProfitPrice) return closeTrade(i, candles, entry.takeProfitPrice, `Take profit hit (${rMultiple}R)`)
      const barsOpen = i - entryIdx
      if (barsOpen > 30 && (c.close - entry.price) / (entry.price - entry.stopPrice) < 0.25)
        return closeTrade(i, candles, c.close, 'Time exit: 30 bars no progress')
      if (barsOpen > 75) return closeTrade(i, candles, c.close, 'Time exit: 75 bars max')
      let result
      try { result = signalFn(i, candles, indicators, pos) } catch { result = { action: 'none' } }
      if (result.action === 'sell' || result.action === 'exit')
        return closeTrade(i, candles, c.close, result.reason || 'Exit signal triggered')
      return null
    }

    if (i - lastExitIdx < cooldownBars) return null

    let result
    try { result = signalFn(i, candles, indicators, pos) } catch { result = { action: 'none' } }
    if (result.action !== 'buy') return null

    // ── Bias filter with lock ─────────────────────────────────────
    const { direction } = calcBiasWithLock(candles, i, currentBias, biasLockedAt)
    if (direction !== currentBias) { currentBias = direction; biasLockedAt = i }
    if (direction === 'short') return null

    // ── Sweep direction conflict ──────────────────────────────────
    if (indicators.liquiditySweepHigh?.[i] || indicators.liquiditySweepHigh?.[i-1]) return null

    // ── Sweep filter (optional) ───────────────────────────────────
    if (useSweepFilter) {
      const lastExit = trades.filter(t => t.type === 'exit').slice(-1)[0]
      if (lastExit) {
        const freshSweep = indicators.liquiditySweepLow?.[i] || indicators.liquiditySweepLow?.[i-1]
        if (!freshSweep) return null
      }
    }

    const entryPrice = c.close
    let stopPrice    = result.stopPrice
    if (stopPrice == null) {
      for (let j = i; j >= Math.max(0, i - stopLookback); j--) {
        if (indicators.swingLow?.[j]) { stopPrice = candles[j].low; break }
      }
    }
    if (stopPrice == null || stopPrice >= entryPrice) return null

    // ── Learning filter ───────────────────────────────────────────
    let decision = { take: true, sizeFactor: 1, confidence: 0, sampleSize: 0, winRate: null, expectancyR: null }
    if (useLearning) {
      decision = shouldTakeTrade(result.factors || {}, { minSampleSize: learningMinSample, expectancyFloor: learningExpectancyFloor })
      if (!decision.take) {
        return {
          type: 'blocked', barIndex: i, time: c.time, factors: result.factors || {},
          reason: `Blocked by learning — expectancy ${decision.expectancyR >= 0 ? '+' : ''}${decision.expectancyR}R over ${decision.sampleSize} trades${decision.usedSession ? ` (${decision.usedSession} session)` : ''}`,
        }
      }
    }

    // ── Dynamic risk ──────────────────────────────────────────────
    const dynamicRisk = calcDynamicRisk({
      candles: candles.slice(0, i + 1), side: 'LONG', entryPrice,
      symbol: useMicro ? (symbolKey === 'ES' ? 'MES' : 'MNQ') : symbolKey,
      accountSize: balance, decision, baseRiskPct: riskPct, signalScore: result.score || 4,
    })
    if (stopPrice == null || stopPrice >= entryPrice) stopPrice = dynamicRisk.stopPrice
    const contracts = dynamicRisk.contracts, riskDollars = dynamicRisk.riskDollars
    const takeProfitPrice = dynamicRisk.targetPrice
    if (contracts < 1) return null

    pos = 'long'; entryIdx = i; openHigh = c.high; openLow = c.low
    const entryTrade = {
      type: 'entry', barIndex: i, price: entryPrice, time: c.time,
      reason: result.reason || 'Entry signal triggered', factors: result.factors || {},
      regime: detectRegime(candles, i), stopPrice, takeProfitPrice, contracts, riskDollars,
      balanceAtEntry: balance, atr: dynamicRisk.currentATR, rrRatio: dynamicRisk.rrRatio,
      winRate: dynamicRisk.winRate, riskMultiplier: dynamicRisk.riskMultiplier,
      riskPct: dynamicRisk.riskPct, signalScore: result.score || 4,
    }
    trades.push(entryTrade)
    return entryTrade
  }

  return { evaluateBar, getTrades: () => [...trades], getBalance: () => balance, isInPosition: () => pos === 'long' }
}

export function runBacktest(candles, indicators, signalFn, config = {}) {
  const engine = createBacktestEngine(config)
  for (let i = 2; i < candles.length; i++) engine.evaluateBar(i, candles, indicators, signalFn)
  return engine.getTrades()
}

export function calcStats(exits, startingBalance = 25000) {
  if (!exits.length) return null
  const wins = exits.filter(t => t.pnlPct > 0), losses = exits.filter(t => t.pnlPct <= 0)
  const totalDollarPnl = exits.reduce((s, t) => s + (t.dollarPnl || 0), 0)
  const finalBalance   = startingBalance + totalDollarPnl
  let equity = startingBalance, peak = startingBalance, maxDDDollar = 0, maxDDPct = 0
  exits.forEach(t => {
    equity += (t.dollarPnl || 0)
    if (equity > peak) peak = equity
    const dd = peak - equity, ddPct = peak > 0 ? (dd / peak * 100) : 0
    if (dd > maxDDDollar) maxDDDollar = dd
    if (ddPct > maxDDPct) maxDDPct = ddPct
  })
  return {
    total: exits.length, wins: wins.length, losses: losses.length,
    winRate: (wins.length / exits.length * 100).toFixed(1),
    totalPnl: exits.reduce((s, t) => s + t.pnlPct, 0).toFixed(2),
    totalDollarPnl: totalDollarPnl.toFixed(2), startingBalance,
    finalBalance: finalBalance.toFixed(2),
    avgWin:        wins.length   ? (wins.reduce((s,t) => s+t.pnlPct,0)/wins.length).toFixed(2)       : '0.00',
    avgLoss:       losses.length ? (losses.reduce((s,t) => s+t.pnlPct,0)/losses.length).toFixed(2)   : '0.00',
    avgWinDollar:  wins.length   ? (wins.reduce((s,t) => s+t.dollarPnl,0)/wins.length).toFixed(2)    : '0.00',
    avgLossDollar: losses.length ? (losses.reduce((s,t) => s+t.dollarPnl,0)/losses.length).toFixed(2): '0.00',
    maxDD: maxDDPct.toFixed(2), maxDDDollar: maxDDDollar.toFixed(2),
  }
}

export function walkForwardValidate(candles, indicators, signalFn, config = {}) {
  const windowSize = Math.floor(candles.length / 3)
  const windows = [
    { label: 'Period 1 (train)',          start: 0,            end: windowSize      },
    { label: 'Period 2 (validate)',       start: windowSize,   end: windowSize * 2  },
    { label: 'Period 3 (out-of-sample)', start: windowSize*2, end: candles.length  },
  ]
  const results = windows.map(w => {
    const slicedCandles    = candles.slice(w.start, w.end)
    const slicedIndicators = Object.fromEntries(
      Object.entries(indicators).map(([k, arr]) => [k, Array.isArray(arr) ? arr.slice(w.start, w.end) : arr])
    )
    const engine = createBacktestEngine(config)
    for (let i = 2; i < slicedCandles.length; i++) engine.evaluateBar(i, slicedCandles, slicedIndicators, signalFn)
    const trades = engine.getTrades(), exits = trades.filter(t => t.type === 'exit')
    const stats  = calcStats(exits, config.accountBalance || 25000)
    return { ...w, stats, tradeCount: exits.length,
      dateStart: new Date(slicedCandles[0]?.time).toLocaleDateString(),
      dateEnd:   new Date(slicedCandles[slicedCandles.length-1]?.time).toLocaleDateString() }
  })
  const positiveCount   = results.filter(r => r.stats && parseFloat(r.stats.totalDollarPnl) > 0).length
  const outOfSamplePass = results[2].stats && parseFloat(results[2].stats.totalDollarPnl) > 0
  return {
    results,
    verdict: outOfSamplePass && positiveCount >= 2 ? 'pass' : positiveCount >= 2 ? 'marginal' : 'fail',
    positiveCount, outOfSamplePass,
  }
}

