import { getContractSpec } from './account'
import { shouldTakeTrade } from './tradeMemory'
import { detectRegime } from './marketRegime'
import { calcDynamicRisk } from './riskEngine'

// ── Strong structure detection (matches server/bot.js) ────────────
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
    if (isL) swings.push({ type: 'low',  price: candles[i].low  })
  }
  if (swings.length < 6) return 'neutral'
  const highs = swings.filter(s => s.type === 'high').slice(-3)
  const lows  = swings.filter(s => s.type === 'low').slice(-3)
  if (highs.length < 3 || lows.length < 3) return 'neutral'
  const hhh  = highs[2].price > highs[1].price && highs[1].price > highs[0].price
  const hlhl = lows[2].price  > lows[1].price  && lows[1].price  > lows[0].price
  const lll  = highs[2].price < highs[1].price && highs[1].price < highs[0].price
  const lhlh = lows[2].price  < lows[1].price  && lows[1].price  < lows[0].price
  if (hhh && hlhl) return 'bullish'
  if (lll && lhlh) return 'bearish'
  return 'neutral'
}

// ── Bias with lock (matches server/bot.js) ────────────────────────
function calcBias(candles, i, prevBias, prevBiasBarIdx) {
  // Group 5-min candles into proper 1H and 4H timeframes
  const slice      = candles.slice(0, i + 1)
  const oneHourMs  = 60 * 60 * 1000
  const fourHourMs = 4 * 60 * 60 * 1000
  const grouped1H  = {}, grouped4H = {}
  for (const bar of slice) {
    const b1 = Math.floor(bar.time / oneHourMs) * oneHourMs
    if (!grouped1H[b1]) grouped1H[b1] = { time: b1, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
    else { grouped1H[b1].high = Math.max(grouped1H[b1].high, bar.high); grouped1H[b1].low = Math.min(grouped1H[b1].low, bar.low); grouped1H[b1].close = bar.close }
    const b4 = Math.floor(bar.time / fourHourMs) * fourHourMs
    if (!grouped4H[b4]) grouped4H[b4] = { time: b4, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
    else { grouped4H[b4].high = Math.max(grouped4H[b4].high, bar.high); grouped4H[b4].low = Math.min(grouped4H[b4].low, bar.low); grouped4H[b4].close = bar.close }
  }
  const bars1H = Object.values(grouped1H).sort((a,b) => a.time - b.time)
  const bars4H = Object.values(grouped4H).sort((a,b) => a.time - b.time)
  const bias1H = detectStructure(bars1H)
  const bias4H = detectStructure(bars4H)
  let direction = 'both', threshold = 5
  if      (bias1H === 'bullish' && bias4H === 'bullish') { direction = 'long';  threshold = 4 }
  else if (bias1H === 'bearish' && bias4H === 'bearish') { direction = 'short'; threshold = 4 }
  else if (bias1H !== 'neutral' && bias4H !== 'neutral' && bias1H !== bias4H) { direction = 'both'; threshold = 7 }

  // Bias lock — 3 bars minimum before direction change
  const lockBars = 3
  if (prevBias && prevBias !== 'both' && direction !== prevBias) {
    const barsSinceLock = i - (prevBiasBarIdx || 0)
    if (barsSinceLock < lockBars) {
      direction = prevBias
      threshold = prevBias !== 'both' ? 4 : 5
    } else {
      const clearBreak = bias1H !== 'neutral' && bias4H !== 'neutral' && bias1H === bias4H
      if (!clearBreak) { direction = 'both'; threshold = 5 }
    }
  }
  return { direction, threshold, bias1H, bias4H }
}

// ── Session detection ─────────────────────────────────────────────
function getSession(timeMs) {
  const d    = new Date(timeMs)
  const utcH = d.getUTCHours()
  if (utcH >= 7  && utcH < 12) return 'london'
  if (utcH >= 13 && utcH < 21) return 'newyork'
  if (utcH >= 23 || utcH < 4 ) return 'asian'
  return 'offhours'
}

function getSessionThreshold(baseThreshold, session) {
  if (session === 'london')   return Math.max(3, baseThreshold - 1)
  if (session === 'offhours') return baseThreshold + 1
  return baseThreshold
}

  


// ── IV walls (simplified) ─────────────────────────────────────────
function calcIVWalls(candles, i, currentPrice) {
  const todayStart = new Date(candles[i].time)
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayMs = todayStart.getTime()

  let todayOpen = null, pdh = null, pdl = null
  let yestHigh = -Infinity, yestLow = Infinity
  const yestStart = todayMs - 24*60*60*1000
  const yestEnd   = todayMs

  for (let j = 0; j <= i; j++) {
    const b = candles[j]
    if (b.time >= todayMs && todayOpen === null) todayOpen = b.open
    if (b.time >= yestStart && b.time < yestEnd) {
      yestHigh = Math.max(yestHigh, b.high)
      yestLow  = Math.min(yestLow,  b.low)
    }
  }
  if (yestHigh > -Infinity) pdh = yestHigh
  if (yestLow  < Infinity)  pdl = yestLow

  const resistanceLevels = [pdh, todayOpen].filter(Boolean)
  const supportLevels    = [pdl, todayOpen].filter(Boolean)

  const nearResistance = resistanceLevels.find(l => l > currentPrice && l - currentPrice < 30)
  const nearSupport    = supportLevels.find(l => l < currentPrice && currentPrice - l < 30)

  return {
    nearResistance,
    nearSupport,
    pdh, pdl, todayOpen,
    hasPDH: pdh !== null,
    hasPDL: pdl !== null,
  }
}

// ── Market close check ────────────────────────────────────────────
function isMarketClose(timeMs) {
  const d      = new Date(timeMs)
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes()
  return utcMin >= 1255 && utcMin < 1260  // 4:55-5:00 PM EST
}

// ── ATR ───────────────────────────────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < 2) return 50
  const slice = candles.slice(-period - 1)
  let sum = 0, count = 0
  for (let i = 1; i < slice.length; i++) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low  - slice[i-1].close)
    )
    count++
  }
  return count > 0 ? sum / count : 50
}

// ── Main backtest engine ──────────────────────────────────────────
export function createBacktestEngine(config = {}) {
  const {
    symbolKey            = 'ES',
    accountBalance       = 25000,
    riskPct              = 1,
    rMultiple            = 2,
    useMicro             = true,
    cooldownBars         = 3,
    stopLookback         = 30,
    useLearning          = true,
    learningMinSample    = 8,
    learningExpectancyFloor = 0,
  } = config

  const spec = getContractSpec(symbolKey, useMicro)
  let balance      = accountBalance
  let pos          = null   // 'long' | 'short' | null
  let entryIdx     = null
  let lastExitIdx  = -Infinity
  let openHigh     = -Infinity
  let openLow      = Infinity
  let currentBias  = 'both'
  let biasLockedAt = 0
  const trades     = []

  function closeTrade(i, candles, exitPrice, reason) {
    const entry     = trades[trades.length - 1]
    const direction = pos === 'long' ? 1 : -1
    const pnlPct    = direction * (exitPrice - entry.price) / entry.price * 100
    const dollarPnl = direction * (exitPrice - entry.price) * spec.pointValue * entry.contracts
    balance += dollarPnl

    const stopDist = Math.abs(entry.price - entry.stopPrice)
    const mfePts   = pos === 'long'
      ? Math.max(0, openHigh - entry.price)
      : Math.max(0, entry.price - openLow)
    const maePts   = pos === 'long'
      ? Math.max(0, entry.price - openLow)
      : Math.max(0, openHigh - entry.price)
    const mfeR     = stopDist > 0 ? +(mfePts / stopDist).toFixed(2) : null
    const maeR     = stopDist > 0 ? +(maePts / stopDist).toFixed(2) : null
    const rMultipleAchieved = stopDist > 0 ? direction * (exitPrice - entry.price) / stopDist : 0
    const captureRatio      = mfeR > 0 ? Math.min(1, rMultipleAchieved / mfeR) : 0
    const adversityPenalty  = maeR != null ? Math.min(1, maeR) * 0.5 : 0
    const qualityScore      = pnlPct > 0 ? +(Math.max(0, captureRatio - adversityPenalty)).toFixed(2) : 0

    const exitTrade = {
      type: 'exit', barIndex: i, price: exitPrice, time: candles[i].time,
      reason, pnlPct, dollarPnl,
      entryBarIdx: entryIdx, entryPrice: entry.price, entryReason: entry.reason,
      entryTime: entry.time, contracts: entry.contracts, riskDollars: entry.riskDollars,
      factors: entry.factors, regime: entry.regime, side: entry.side,
      stopPrice: entry.stopPrice, takeProfitPrice: entry.takeProfitPrice,
      mfePts, maePts, mfeR, maeR, qualityScore, balanceAfter: balance,
    }
    trades.push(exitTrade)
    pos = null; lastExitIdx = i; entryIdx = null
    openHigh = -Infinity; openLow = Infinity
    return exitTrade
  }

  function evaluateBar(i, candles, indicators, signalFn) {
    if (i < 10) return null
    const c = candles[i]

    // ── In position ───────────────────────────────────────────────
    if (pos === 'long' || pos === 'short') {
      openHigh = Math.max(openHigh, c.high)
      openLow  = Math.min(openLow,  c.low)
      const entry    = trades[trades.length - 1]
      const barsOpen = i - entryIdx

      // Stop loss check
      if (pos === 'long'  && c.low  <= entry.stopPrice)
        return closeTrade(i, candles, entry.stopPrice, 'Stop loss hit')
      if (pos === 'short' && c.high >= entry.stopPrice)
        return closeTrade(i, candles, entry.stopPrice, 'Stop loss hit')

      // Take profit check
      if (pos === 'long'  && c.high >= entry.takeProfitPrice)
        return closeTrade(i, candles, entry.takeProfitPrice, `Take profit hit (${rMultiple}R)`)
      if (pos === 'short' && c.low  <= entry.takeProfitPrice)
        return closeTrade(i, candles, entry.takeProfitPrice, `Take profit hit (${rMultiple}R)`)

      // Time exits (matches server/bot.js)
      const stopDist = Math.abs(entry.price - entry.stopPrice)
      const currentR = stopDist > 0
        ? (pos === 'long' ? c.close - entry.price : entry.price - c.close) / stopDist
        : 0
      if (barsOpen > 30 && currentR < 0.25)
        return closeTrade(i, candles, c.close, 'Time exit: 30 bars no progress')
      if (barsOpen > 75)
        return closeTrade(i, candles, c.close, 'Time exit: 75 bars max')

      // Exit signal
      let result
      try { result = signalFn(i, candles, indicators, pos) } catch { result = { action: 'none' } }
      if (result.action === 'exit' || result.action === 'EXIT')
        return closeTrade(i, candles, c.close, result.reason || 'Exit signal')
      return null
    }

    // ── Flat — look for entry ─────────────────────────────────────
    if (i - lastExitIdx < cooldownBars) return null

    // Market close filter
    if (isMarketClose(c.time)) return null

    // Get signal
    let result
    try { result = signalFn(i, candles, indicators, { isOpen: false, side: 'FLAT' }) } catch { result = { action: 'none' } }
    const isBuy  = result.action === 'buy'  || result.action === 'LONG'
    const isSell = false  // longs only mode
    if (!isBuy) return null

    // ── Bias filter with lock ─────────────────────────────────────
    const biasResult = calcBias(candles, i, currentBias, biasLockedAt)
    if (biasResult.direction !== currentBias) {
      currentBias  = biasResult.direction
      biasLockedAt = i
    }
    if (isBuy  && biasResult.direction === 'short') return null
    if (isSell && biasResult.direction === 'long')  return null

    const session = getSession(c.time)  // keep for stats tracking

    // ── Sweep direction conflict ───────────────────────────────────────────────────────────────────────
    if (isBuy  && (indicators.liquiditySweepHigh?.[i] || indicators.liquiditySweepHigh?.[i-1])) return null
    if (isSell && (indicators.liquiditySweepLow?.[i]  || indicators.liquiditySweepLow?.[i-1]))  return null

    // ── IV walls filter ───────────────────────────────────────────
    const walls = calcIVWalls(candles, i, c.close)
    if (walls.hasPDH && walls.hasPDL) {
      const atr = calcATR(candles.slice(0, i + 1))
      if (isBuy  && walls.nearResistance && (walls.nearResistance - c.close) < atr * 1.5) return null
      if (isSell && walls.nearSupport    && (c.close - walls.nearSupport)    < atr * 1.5) return null
    }

    // ── Learning filter ───────────────────────────────────────────
    let decision = { take: true, sizeFactor: 1, sampleSize: 0, winRate: null, expectancyR: null }
    if (useLearning) {
      decision = shouldTakeTrade(result.factors || {}, {
        minSampleSize: learningMinSample,
        expectancyFloor: learningExpectancyFloor,
      })
      if (!decision.take) {
        return {
          type: 'blocked', barIndex: i, time: c.time, factors: result.factors || {},
          reason: `Blocked by learning — expectancy ${decision.expectancyR >= 0 ? '+' : ''}${decision.expectancyR}R over ${decision.sampleSize} trades`,
        }
      }
    }

    // ── Dynamic risk ──────────────────────────────────────────────
    const side        = isBuy ? 'LONG' : 'SHORT'
    const entryPrice  = c.close
    const atr         = calcATR(candles.slice(0, i + 1))

    let stopPrice = result.stopPrice
    if (stopPrice == null) {
      if (isBuy) {
        for (let j = i; j >= Math.max(0, i - stopLookback); j--) {
          if (indicators.swingLow?.[j]) { stopPrice = candles[j].low; break }
        }
      } else {
        for (let j = i; j >= Math.max(0, i - stopLookback); j--) {
          if (indicators.swingHigh?.[j]) { stopPrice = candles[j].high; break }
        }
      }
    }

    if (isBuy  && (stopPrice == null || stopPrice >= entryPrice)) return null
    if (isSell && (stopPrice == null || stopPrice <= entryPrice)) return null

    const dynamicRisk = calcDynamicRisk({
      candles:     candles.slice(0, i + 1),
      side,
      entryPrice,
      symbol:      useMicro ? (symbolKey === 'ES' ? 'MES' : 'MNQ') : symbolKey,
      accountSize: balance,
      decision,
      baseRiskPct: riskPct,
      signalScore: score,
    })

    stopPrice = isBuy
      ? Math.min(stopPrice || dynamicRisk.stopPrice, dynamicRisk.stopPrice)
      : Math.max(stopPrice || dynamicRisk.stopPrice, dynamicRisk.stopPrice)

    const contracts       = dynamicRisk.contracts
    const riskDollars     = dynamicRisk.riskDollars
    const takeProfitPrice = isBuy
      ? entryPrice + (entryPrice - stopPrice) * rMultiple
      : entryPrice - (stopPrice - entryPrice) * rMultiple

    // $500 hard cap — never risk more than $500 per trade
    const maxLossDollars = 500
    const stopDistPts    = Math.abs(entryPrice - stopPrice)
    const maxContracts   = stopDistPts > 0 ? Math.floor(maxLossDollars / (stopDistPts * spec.pointValue)) : 1
    const cappedContracts = Math.min(contracts, Math.max(1, maxContracts))

    if (cappedContracts < 1) return null

    pos      = isBuy ? 'long' : 'short'
    entryIdx = i
    openHigh = c.high
    openLow  = c.low

    const entryTrade = {
      type: 'entry', barIndex: i, price: entryPrice, time: c.time,
      reason: result.reason || 'Entry signal triggered',
      factors: result.factors || {}, regime: detectRegime(candles, i),
      side, stopPrice, takeProfitPrice, contracts: cappedContracts, riskDollars: Math.min(riskDollars, maxLossDollars),
      balanceAtEntry: balance, atr,
      rrRatio: dynamicRisk.rrRatio, winRate: dynamicRisk.winRate,
      riskMultiplier: dynamicRisk.riskMultiplier, riskPct: dynamicRisk.riskPct,
      signalScore: score, session, bias: biasResult.direction,
    }
    trades.push(entryTrade)
    return entryTrade
  }

  return {
    evaluateBar,
    getTrades:    () => [...trades],
    getBalance:   () => balance,
    isInPosition: () => pos !== null,
  }
}

// ── Bulk runner ───────────────────────────────────────────────────
export function runBacktest(candles, indicators, signalFn, config = {}) {
  const engine = createBacktestEngine(config)
  for (let i = 2; i < candles.length; i++) {
    engine.evaluateBar(i, candles, indicators, signalFn)
  }
  return engine.getTrades()
}

// ── Stats ─────────────────────────────────────────────────────────
export function calcStats(exits, startingBalance = 25000) {
  if (!exits.length) return null
  const wins   = exits.filter(t => t.pnlPct > 0)
  const losses = exits.filter(t => t.pnlPct <= 0)
  const totalDollarPnl = exits.reduce((s, t) => s + (t.dollarPnl || 0), 0)
  const finalBalance   = startingBalance + totalDollarPnl
  let equity = startingBalance, peak = startingBalance, maxDDDollar = 0, maxDDPct = 0
  exits.forEach(t => {
    equity += (t.dollarPnl || 0)
    if (equity > peak) peak = equity
    const dd = peak - equity, ddPct = peak > 0 ? dd / peak * 100 : 0
    if (dd > maxDDDollar) maxDDDollar = dd
    if (ddPct > maxDDPct) maxDDPct = ddPct
  })

  // Session breakdown
  const sessions = {}
  exits.forEach(t => {
    const s = t.session || getSession(t.entryTime || t.time)
    if (!sessions[s]) sessions[s] = { wins: 0, total: 0, pnl: 0 }
    sessions[s].total++
    if (t.pnlPct > 0) sessions[s].wins++
    sessions[s].pnl += t.dollarPnl || 0
  })

  // Long/short breakdown
  const longs  = exits.filter(t => t.side === 'LONG')
  const shorts = exits.filter(t => t.side === 'SHORT')

  return {
    total: exits.length, wins: wins.length, losses: losses.length,
    winRate: (wins.length / exits.length * 100).toFixed(1),
    totalPnl: exits.reduce((s, t) => s + t.pnlPct, 0).toFixed(2),
    totalDollarPnl: totalDollarPnl.toFixed(2),
    startingBalance, finalBalance: finalBalance.toFixed(2),
    avgWin:        wins.length   ? (wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length).toFixed(2)       : '0.00',
    avgLoss:       losses.length ? (losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length).toFixed(2)   : '0.00',
    avgWinDollar:  wins.length   ? (wins.reduce((s,t)=>s+t.dollarPnl,0)/wins.length).toFixed(2)    : '0.00',
    avgLossDollar: losses.length ? (losses.reduce((s,t)=>s+t.dollarPnl,0)/losses.length).toFixed(2): '0.00',
    maxDD: maxDDPct.toFixed(2), maxDDDollar: maxDDDollar.toFixed(2),
    sessions,
    longs:  { total: longs.length,  wins: longs.filter(t=>t.pnlPct>0).length },
    shorts: { total: shorts.length, wins: shorts.filter(t=>t.pnlPct>0).length },
  }
}

// ── Walk-forward validation ───────────────────────────────────────
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
    results, positiveCount, outOfSamplePass,
    verdict: outOfSamplePass && positiveCount >= 2 ? 'pass' : positiveCount >= 2 ? 'marginal' : 'fail',
  }
}
