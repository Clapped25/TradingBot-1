// ─────────────────────────────────────────────────────────────────────────────
// Historical Volatility & Expected Range (IV Walls)
//
// Uses daily price returns to estimate tomorrow's probable trading range.
// Based on the same math options market makers use for expected move.
//
// 1σ wall = 68% probability price stays inside this range
// 2σ wall = 95% probability price stays inside this range
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group 5-minute bars into daily OHLC
 */
export function groupIntoDailyBars(bars5m) {
  const days = {}
  for (const bar of bars5m) {
    const date = new Date(bar.time).toISOString().slice(0, 10)
    if (!days[date]) {
      days[date] = { date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, time: bar.time }
    } else {
      days[date].high  = Math.max(days[date].high, bar.high)
      days[date].low   = Math.min(days[date].low,  bar.low)
      days[date].close = bar.close  // last bar of day
    }
  }
  return Object.values(days).sort((a, b) => a.time - b.time)
}

/**
 * Calculate Historical Volatility from daily bars
 * @param {Array} dailyBars - array of daily OHLC bars
 * @param {number} period - lookback period in days (default 20)
 * @returns {number} HV as decimal (e.g. 0.25 = 25% annualized)
 */
export function calcHV(dailyBars, period = 20) {
  if (dailyBars.length < period + 1) return null

  const recent = dailyBars.slice(-period - 1)

  // Log returns: ln(close / prev_close)
  const returns = []
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent[i].close / recent[i-1].close))
  }

  // Standard deviation of returns
  const mean    = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (returns.length - 1)
  const stdDev  = Math.sqrt(variance)

  // Annualize (252 trading days)
  return stdDev * Math.sqrt(252)
}

/**
 * Calculate expected daily range (IV walls) for tomorrow
 * @param {number} currentPrice - current NQ price
 * @param {number} hv - historical volatility as decimal
 * @returns {object} wall levels
 */
export function calcExpectedRange(currentPrice, hv) {
  if (!hv || !currentPrice) return null

  // Daily expected move = price × (HV / √252)
  const dailyMove = currentPrice * (hv / Math.sqrt(252))

  return {
    hv:            +(hv * 100).toFixed(2),         // as percentage
    dailyMove:     +dailyMove.toFixed(2),           // in points

    // 1σ walls — 68% probability
    upper1sigma:   +(currentPrice + dailyMove).toFixed(2),
    lower1sigma:   +(currentPrice - dailyMove).toFixed(2),

    // 2σ walls — 95% probability
    upper2sigma:   +(currentPrice + dailyMove * 2).toFixed(2),
    lower2sigma:   +(currentPrice - dailyMove * 2).toFixed(2),

    // Distance from current price to each wall (in points)
    distToUpper1:  +dailyMove.toFixed(2),
    distToLower1:  +dailyMove.toFixed(2),

    currentPrice,
  }
}

/**
 * Full calculation from 5-minute bars
 * @param {Array} bars5m - recent 5-minute bars
 * @param {number} currentPrice - current price (optional, uses last bar if not provided)
 * @returns {object} full volatility analysis
 */
export function calcVolatilityWalls(bars5m, currentPrice = null) {
  const dailyBars  = groupIntoDailyBars(bars5m)
  const price      = currentPrice || bars5m[bars5m.length - 1]?.close
  if (!price || dailyBars.length < 5) return null

  const hv20  = calcHV(dailyBars, 20)   // 20-day HV (standard)
  const hv10  = calcHV(dailyBars, 10)   // 10-day HV (more reactive)

  if (!hv20) return null

  const walls20 = calcExpectedRange(price, hv20)
  const walls10 = hv10 ? calcExpectedRange(price, hv10) : null

  // Where is price relative to the walls?
  const pctFromUpper = +((walls20.upper1sigma - price) / walls20.dailyMove * 100).toFixed(1)
  const pctFromLower = +((price - walls20.lower1sigma) / walls20.dailyMove * 100).toFixed(1)

  let wallBias = 'neutral'
  if (pctFromUpper < 25)  wallBias = 'nearUpperWall'   // price near top → short bias
  if (pctFromLower < 25)  wallBias = 'nearLowerWall'   // price near bottom → long bias

  return {
    hv20:       walls20.hv,
    hv10:       walls10?.hv || null,
    dailyMove:  walls20.dailyMove,
    currentPrice: price,

    // 1σ walls (most important)
    upper1sigma: walls20.upper1sigma,
    lower1sigma: walls20.lower1sigma,

    // 2σ walls (extreme moves)
    upper2sigma: walls20.upper2sigma,
    lower2sigma: walls20.lower2sigma,

    // Context
    pctFromUpper,
    pctFromLower,
    wallBias,
    dailyBarsUsed: dailyBars.length,
  }
}
