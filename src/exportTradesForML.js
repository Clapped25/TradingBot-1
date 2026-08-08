// ─────────────────────────────────────────────────────────────────────────────
// Export backtest trades as ML training data for XGBoost
// Enhanced with better features for higher AUC
// ─────────────────────────────────────────────────────────────────────────────

export function exportTradesForML(trades, candles = []) {
  const exits = trades.filter(t => t.type === 'exit' && t.entryPrice && t.price)

  return exits.map((trade, tradeIdx) => {
    const i        = trade.entryBarIdx || 0
    const entryBar = candles[i] || {}

    // Bars before entry for calculations
    const prevBars   = candles.slice(Math.max(0, i - 100), i)
    const prev20     = candles.slice(Math.max(0, i - 20), i)
    const prev5      = candles.slice(Math.max(0, i - 5), i)

    // ── Time features ─────────────────────────────────────────────
    const entryDate = new Date(trade.entryTime || trade.time)
    const hourUTC   = entryDate.getUTCHours()
    const dayOfWeek = entryDate.getUTCDay()
    const isNY      = hourUTC >= 13 && hourUTC < 21
    const isLondon  = hourUTC >= 7  && hourUTC < 12
    const isAsian   = hourUTC >= 23 || hourUTC < 4
    const session   = isNY ? 'ny' : isLondon ? 'london' : isAsian ? 'asian' : 'offhours'

    // ── ATR features ──────────────────────────────────────────────
    const atr    = calcATR(prev20)
    const atr5   = calcATR(prev5)
    const atrLong = calcATR(prevBars)  // 100-bar ATR for long term avg

    // ATR ratio — is current volatility higher or lower than normal?
    const atrRatio = atrLong > 0 ? +(atr / atrLong).toFixed(3) : 1.0
    const isHighVol = atrRatio > 1.2 ? 1 : 0
    const isLowVol  = atrRatio < 0.8 ? 1 : 0

    // ── Price position in daily range (Option B feature) ──────────
    // Find today's high and low from bars
    const todayStr = entryDate.toISOString().slice(0, 10)
    const todayBars = candles.filter(b => new Date(b.time).toISOString().slice(0, 10) === todayStr)
    const dayHigh   = todayBars.length > 0 ? Math.max(...todayBars.map(b => b.high)) : entryBar.high || 0
    const dayLow    = todayBars.length > 0 ? Math.min(...todayBars.map(b => b.low))  : entryBar.low  || 0
    const dayRange  = dayHigh - dayLow
    const pricePositionInDay = dayRange > 0
      ? +((entryBar.close - dayLow) / dayRange * 100).toFixed(1)
      : 50  // 0=bottom, 100=top of day

    // ── VWAP distance (Option B feature) ─────────────────────────
    // Approximate VWAP from today's bars using range as volume proxy
    let vwap = 0
    if (todayBars.length > 0) {
      let cumTP  = 0, cumVol = 0
      for (const b of todayBars) {
        const tp  = (b.high + b.low + b.close) / 3
        const vol = b.high - b.low  // range as volume proxy
        cumTP  += tp * vol
        cumVol += vol
      }
      vwap = cumVol > 0 ? cumTP / cumVol : entryBar.close
    }
    const vwapDistance    = entryBar.close && vwap ? +(entryBar.close - vwap).toFixed(2) : 0
    const aboveVwap       = vwapDistance > 0 ? 1 : 0
    const vwapDistanceAbs = Math.abs(vwapDistance)
    const nearVwap        = vwapDistanceAbs < atr * 0.3 ? 1 : 0

    // ── PDH/PDL distance (Option B feature) ──────────────────────
    // Find yesterday's high and low
    const yesterday    = new Date(entryDate)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().slice(0, 10)
    const yesterdayBars = candles.filter(b => new Date(b.time).toISOString().slice(0, 10) === yesterdayStr)
    const pdh = yesterdayBars.length > 0 ? Math.max(...yesterdayBars.map(b => b.high)) : 0
    const pdl = yesterdayBars.length > 0 ? Math.min(...yesterdayBars.map(b => b.low))  : 0
    const pdhDistance = pdh && entryBar.close ? +(Math.abs(entryBar.close - pdh)).toFixed(2) : 0
    const pdlDistance = pdl && entryBar.close ? +(Math.abs(entryBar.close - pdl)).toFixed(2) : 0
    const nearPDH     = pdhDistance < atr * 0.5 ? 1 : 0
    const nearPDL     = pdlDistance < atr * 0.5 ? 1 : 0
    const abovePDH    = entryBar.close > pdh ? 1 : 0
    const belowPDL    = entryBar.close < pdl ? 1 : 0

    // ── HTF bias (Option B feature) ───────────────────────────────
    // Use 100-bar structure to detect bias
    const bias1H = detectStructure(prevBars.slice(-100))
    const bias4H = detectStructure(prevBars)
    const htfBias = bias1H === 'bullish' && bias4H === 'bullish' ? 'bullish'
      : bias1H === 'bearish' && bias4H === 'bearish' ? 'bearish'
      : 'neutral'
    const htfBullish = htfBias === 'bullish' ? 1 : 0
    const htfBearish = htfBias === 'bearish' ? 1 : 0
    const htfNeutral = htfBias === 'neutral' ? 1 : 0

    // Is trade aligned with HTF bias?
    const side         = trade.side || (trade.entryReason?.includes('bull') ? 'LONG' : 'SHORT')
    const biasAligned  = (side === 'LONG' && htfBullish) || (side === 'SHORT' && htfBearish) ? 1 : 0
    const biasConflict = (side === 'LONG' && htfBearish) || (side === 'SHORT' && htfBullish) ? 1 : 0

    // ── Previous trade streak (Option B feature) ──────────────────
    const prevExits       = exits.slice(0, tradeIdx)
    const lastTrade       = prevExits[prevExits.length - 1]
    const prevTradeWin    = lastTrade ? (lastTrade.dollarPnl > 0 ? 1 : 0) : 0

    // Win/loss streak
    let streak = 0
    for (let j = prevExits.length - 1; j >= 0; j--) {
      const isWin = prevExits[j].dollarPnl > 0
      if (j === prevExits.length - 1) {
        streak = isWin ? 1 : -1
      } else {
        const prevWin = prevExits[j].dollarPnl > 0
        if ((streak > 0 && prevWin) || (streak < 0 && !prevWin)) {
          streak += streak > 0 ? 1 : -1
        } else break
      }
    }
    const winStreak  = Math.max(0, streak)
    const lossStreak = Math.max(0, -streak)

    // ── Time since last trade (Option B feature) ──────────────────
    const timeSinceLastTrade = lastTrade
      ? Math.floor((trade.entryTime - lastTrade.exitTime) / (5 * 60 * 1000))  // in bars
      : 999
    const freshEntry   = timeSinceLastTrade <= 3 ? 1 : 0   // entered right after last trade
    const restedEntry  = timeSinceLastTrade >= 12 ? 1 : 0  // waited 1 hour+

    // ── Bar momentum features ─────────────────────────────────────
    const entryBarRange  = entryBar.high && entryBar.low ? entryBar.high - entryBar.low : atr
    const entryBarBody   = entryBar.close && entryBar.open ? Math.abs(entryBar.close - entryBar.open) : 0
    const entryBullish   = entryBar.close > entryBar.open ? 1 : 0
    const closePosition  = entryBarRange > 0
      ? +((entryBar.close - entryBar.low) / entryBarRange * 100).toFixed(1)
      : 50  // where close is in bar range (0=low, 100=high)
    const strongClose    = closePosition > 70 ? 1 : 0  // closed near top of bar
    const weakClose      = closePosition < 30 ? 1 : 0  // closed near bottom

    // ── Signal features ───────────────────────────────────────────
    const factors        = trade.factors || {}
    const factorKey      = Object.entries(factors)
      .filter(([,v]) => v === true).map(([k]) => k).sort().join('+')
    const factorCount    = Object.values(factors).filter(v => v === true).length

    const hasLiquiditySweep = !!(factors.liquiditySweep)
    const hasFVG            = !!(factors.fvg)
    const hasOB             = !!(factors.ob)
    const hasBOS            = !!(factors.bos)
    const hasCISD           = !!(factors.cisd)
    const hasIFVG           = !!(factors.ifvg)
    const hasInducement     = !!(factors.inducement)
    const hasTurtleSoup     = !!(factors.turtleSoup)
    const hasSilverBullet   = !!(factors.silverBullet)
    const hasSession        = !!(factors.session)

    // ── Risk features ─────────────────────────────────────────────
    const entryPrice  = trade.entryPrice
    const stopDist    = trade.stopPrice ? Math.abs(entryPrice - trade.stopPrice) : atr
    const targetDist  = trade.takeProfitPrice ? Math.abs(entryPrice - trade.takeProfitPrice) : atr * 2
    const rrRatio     = stopDist > 0 ? +(targetDist / stopDist).toFixed(2) : 2
    const stopInATR   = atr > 0 ? +(stopDist / atr).toFixed(2) : 1.5  // stop size relative to ATR

    // ── Outcome ───────────────────────────────────────────────────
    const pnlDollars = trade.dollarPnl || 0
    const win        = pnlDollars > 0 ? 1 : 0
    const rMultiple  = stopDist > 0
      ? +((trade.price - trade.entryPrice) / stopDist).toFixed(3)
      : 0

    return {
      // ── LABEL ─────────────────────────────────────────────────
      win,
      rMultiple,

      // ── TIME ──────────────────────────────────────────────────
      hourUTC,
      dayOfWeek,
      session,
      isNY:       isNY ? 1 : 0,
      isLondon:   isLondon ? 1 : 0,
      isAsian:    isAsian ? 1 : 0,
      isOffhours: !isNY && !isLondon && !isAsian ? 1 : 0,

      // ── VOLATILITY ────────────────────────────────────────────
      atr:        +atr.toFixed(2),
      atr5:       +atr5.toFixed(2),
      atrLong:    +atrLong.toFixed(2),
      atrRatio,
      isHighVol,
      isLowVol,
      stopInATR,

      // ── PRICE POSITION IN DAY (new) ───────────────────────────
      pricePositionInDay,
      dayHigh:    +dayHigh.toFixed(2),
      dayLow:     +dayLow.toFixed(2),
      dayRange:   +dayRange.toFixed(2),

      // ── VWAP (new) ────────────────────────────────────────────
      vwap:            +vwap.toFixed(2),
      vwapDistance,
      vwapDistanceAbs: +vwapDistanceAbs.toFixed(2),
      aboveVwap,
      nearVwap,

      // ── PDH/PDL (new) ─────────────────────────────────────────
      pdh:          +pdh.toFixed(2),
      pdl:          +pdl.toFixed(2),
      pdhDistance:  +pdhDistance.toFixed(2),
      pdlDistance:  +pdlDistance.toFixed(2),
      nearPDH,
      nearPDL,
      abovePDH,
      belowPDL,

      // ── HTF BIAS (new) ────────────────────────────────────────
      htfBias,
      htfBullish,
      htfBearish,
      htfNeutral,
      biasAligned,
      biasConflict,

      // ── PREVIOUS TRADE STREAK (new) ───────────────────────────
      prevTradeWin,
      winStreak,
      lossStreak,
      timeSinceLastTrade,
      freshEntry,
      restedEntry,

      // ── BAR MOMENTUM (new) ────────────────────────────────────
      entryBarRange:  +entryBarRange.toFixed(2),
      entryBarBody:   +entryBarBody.toFixed(2),
      entryBullish,
      closePosition,
      strongClose,
      weakClose,

      // ── SIGNAL FACTORS ────────────────────────────────────────
      factorCount,
      factorKey,
      factor_liquiditySweep: hasLiquiditySweep ? 1 : 0,
      factor_fvg:            hasFVG ? 1 : 0,
      factor_ob:             hasOB ? 1 : 0,
      factor_bos:            hasBOS ? 1 : 0,
      factor_cisd:           hasCISD ? 1 : 0,
      factor_ifvg:           hasIFVG ? 1 : 0,
      factor_inducement:     hasInducement ? 1 : 0,
      factor_turtleSoup:     hasTurtleSoup ? 1 : 0,
      factor_silverBullet:   hasSilverBullet ? 1 : 0,
      factor_session:        hasSession ? 1 : 0,

      // ── RISK ──────────────────────────────────────────────────
      entryPrice:    +entryPrice.toFixed(2),
      stopDistance:  +stopDist.toFixed(2),
      targetDistance: +targetDist.toFixed(2),
      rrRatio,
      riskDollars:   +(trade.riskDollars || 300),
      contracts:     trade.contracts || 1,
      entryWinRate:  +(trade.winRate || 50),
      highConfidence: (trade.winRate || 50) >= 65 ? 1 : 0,

      // ── TRADE INFO ────────────────────────────────────────────
      side,
      regime:      trade.regime || 'unknown',
      exitReason:  trade.reason || 'unknown',
      pnlDollars:  +pnlDollars.toFixed(2),
    }
  })
}

// ── Helper functions ──────────────────────────────────────────────

function calcATR(bars, period = 14) {
  if (!bars || bars.length < 2) return 50
  const slice = bars.slice(-period - 1)
  let sum = 0, count = 0
  for (let i = 1; i < slice.length; i++) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - (slice[i-1]?.close || slice[i].open)),
      Math.abs(slice[i].low  - (slice[i-1]?.close || slice[i].open))
    )
    count++
  }
  return count > 0 ? sum / count : 50
}

function detectStructure(bars) {
  if (!bars || bars.length < 10) return 'neutral'
  const swings = []
  for (let i = 3; i < bars.length - 3; i++) {
    const isH = bars[i].high > bars[i-1].high && bars[i].high > bars[i-2].high &&
                bars[i].high > bars[i-3].high && bars[i].high > bars[i+1].high &&
                bars[i].high > bars[i+2].high && bars[i].high > bars[i+3].high
    const isL = bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
                bars[i].low < bars[i-3].low && bars[i].low < bars[i+1].low &&
                bars[i].low < bars[i+2].low && bars[i].low < bars[i+3].low
    if (isH) swings.push({ type: 'high', price: bars[i].high })
    if (isL) swings.push({ type: 'low',  price: bars[i].low })
  }
  if (swings.length < 4) return 'neutral'
  const highs = swings.filter(s => s.type === 'high').slice(-2)
  const lows  = swings.filter(s => s.type === 'low').slice(-2)
  if (highs.length < 2 || lows.length < 2) return 'neutral'
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return 'bullish'
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return 'bearish'
  return 'neutral'
}

export function rowsToCSV(rows) {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const lines   = [
    headers.join(','),
    ...rows.map(row =>
      headers.map(h => {
        const v = row[h]
        if (typeof v === 'string' && v.includes(',')) return `"${v}"`
        return v ?? ''
      }).join(',')
    )
  ]
  return lines.join('\n')
}

export function downloadCSV(csvString, filename = 'backtest_trades.csv') {
  const blob = new Blob([csvString], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function exportAndDownload(trades, candles, filename) {
  const rows = exportTradesForML(trades, candles)
  const csv  = rowsToCSV(rows)
  const name = filename || `trades-ml-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`
  downloadCSV(csv, name)
  return { rows: rows.length, features: Object.keys(rows[0] || {}).length }
}
