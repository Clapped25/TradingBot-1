// SMC / ICT structural detectors.
// Each function scans the candle array and returns boolean arrays aligned
// to candle indices — same shape as the EMA/RSI indicators, so they can
// be merged into the same `ind` object the signal function already uses.
//
// IMPORTANT: swing points require `lookback` bars on both sides to confirm,
// meaning a swing at index j is only "known" once bar j+lookback has printed.
// Every detector below respects this — it never looks ahead of the bar
// currently being evaluated, so results are safe to use in a live bot.

// ── Swing highs / lows ──────────────────────────────────────────
export function findSwingHighs(candles, lookback = 5) {
  const out = Array(candles.length).fill(false)
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high
    let isSwing = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].high >= h) { isSwing = false; break }
    }
    out[i] = isSwing
  }
  return out
}

export function findSwingLows(candles, lookback = 5) {
  const out = Array(candles.length).fill(false)
  for (let i = lookback; i < candles.length - lookback; i++) {
    const l = candles[i].low
    let isSwing = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].low <= l) { isSwing = false; break }
    }
    out[i] = isSwing
  }
  return out
}

// ── Fair Value Gaps ──────────────────────────────────────────────
// 3-candle imbalance: candle[i-2] and candle[i] don't overlap, leaving a gap.
export function findFVGs(candles) {
  const fvgs = []
  for (let i = 2; i < candles.length; i++) {
    const left = candles[i - 2], right = candles[i]
    if (left.high < right.low) {
      fvgs.push({ type: 'bullish', formedIdx: i, top: right.low, bottom: left.high, filled: false, filledIdx: null })
    }
    if (left.low > right.high) {
      fvgs.push({ type: 'bearish', formedIdx: i, top: left.low, bottom: right.high, filled: false, filledIdx: null })
    }
  }
  // Mark when price first trades back into each gap
  for (const fvg of fvgs) {
    for (let k = fvg.formedIdx + 1; k < candles.length; k++) {
      const c = candles[k]
      if (fvg.type === 'bullish' && c.low <= fvg.top) { fvg.filled = true; fvg.filledIdx = k; break }
      if (fvg.type === 'bearish' && c.high >= fvg.bottom) { fvg.filled = true; fvg.filledIdx = k; break }
    }
  }
  return fvgs
}

// Boolean array: true on the bar price FIRST taps back into an FVG —
// this is the typical ICT entry trigger, not just "a gap exists".
export function fvgTouchSignal(candles, fvgs) {
  const bullishTouch = Array(candles.length).fill(false)
  const bearishTouch = Array(candles.length).fill(false)
  for (const fvg of fvgs) {
    if (fvg.filledIdx == null) continue
    if (fvg.type === 'bullish') bullishTouch[fvg.filledIdx] = true
    else bearishTouch[fvg.filledIdx] = true
  }
  return { bullishTouch, bearishTouch }
}

// ── Inverse FVG ───────────────────────────────────────────────────
// An FVG that gets fully closed through (not just touched) flips bias —
// former support becomes resistance, or vice versa.
export function findIFVGs(candles, fvgs) {
  const bullish = Array(candles.length).fill(false) // flipped TO bullish (was a bearish FVG)
  const bearish = Array(candles.length).fill(false) // flipped TO bearish (was a bullish FVG)
  for (const fvg of fvgs) {
    for (let k = fvg.formedIdx + 1; k < candles.length; k++) {
      const c = candles[k]
      if (fvg.type === 'bullish' && c.close < fvg.bottom) { bearish[k] = true; break }
      if (fvg.type === 'bearish' && c.close > fvg.top) { bullish[k] = true; break }
    }
  }
  return { bullish, bearish }
}

// ── Liquidity sweeps ──────────────────────────────────────────────
// Price wicks beyond a confirmed swing high/low (where stops sit), then
// closes back on the other side — a classic stop-hunt/reversal signature.
export function findLiquiditySweeps(candles, swingHighs, swingLows, lookback = 5) {
  const sweepHigh = Array(candles.length).fill(false)
  const sweepLow = Array(candles.length).fill(false)

  for (let i = lookback; i < candles.length; i++) {
    const c = candles[i]
    for (let j = i - lookback; j >= 0; j--) {
      if (swingHighs[j]) {
        if (c.high > candles[j].high && c.close < candles[j].high) sweepHigh[i] = true
        break
      }
    }
    for (let j = i - lookback; j >= 0; j--) {
      if (swingLows[j]) {
        if (c.low < candles[j].low && c.close > candles[j].low) sweepLow[i] = true
        break
      }
    }
  }
  return { sweepHigh, sweepLow }
}

// ── Rejection blocks ────────────────────────────────────────────
// A candle with a long wick relative to its body, rejecting from a level.
export function findRejectionBlocks(candles, wickToBodyRatio = 2) {
  const bullish = Array(candles.length).fill(false)
  const bearish = Array(candles.length).fill(false)
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const body = Math.abs(c.close - c.open) || 0.0001
    const upperWick = c.high - Math.max(c.open, c.close)
    const lowerWick = Math.min(c.open, c.close) - c.low
    if (lowerWick > body * wickToBodyRatio && lowerWick > upperWick) bullish[i] = true
    if (upperWick > body * wickToBodyRatio && upperWick > lowerWick) bearish[i] = true
  }
  return { bullish, bearish }
}

// ── Break of Structure ───────────────────────────────────────────
// Price closes beyond the most recent confirmed swing high/low.
export function findBOS(candles, swingHighs, swingLows, lookback = 5) {
  const bosBullish = Array(candles.length).fill(false)
  const bosBearish = Array(candles.length).fill(false)
  let lastSwingHigh = null, lastSwingLow = null

  for (let i = 0; i < candles.length; i++) {
    const confirmIdx = i - lookback
    if (confirmIdx >= 0) {
      if (swingHighs[confirmIdx]) lastSwingHigh = candles[confirmIdx].high
      if (swingLows[confirmIdx]) lastSwingLow = candles[confirmIdx].low
    }
    if (lastSwingHigh != null && candles[i].close > lastSwingHigh) {
      bosBullish[i] = true
      lastSwingHigh = null
    }
    if (lastSwingLow != null && candles[i].close < lastSwingLow) {
      bosBearish[i] = true
      lastSwingLow = null
    }
  }
  return { bosBullish, bosBearish }
}

// ── CISD — Change in State of Delivery ───────────────────────────
// First candle to close back through the open of the most recent
// opposing candle — an early signal that order flow has shifted.
export function findCISD(candles) {
  const bullish = Array(candles.length).fill(false)
  const bearish = Array(candles.length).fill(false)
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], c = candles[i]
    if (prev.close < prev.open && c.close > prev.open) bullish[i] = true
    if (prev.close > prev.open && c.close < prev.open) bearish[i] = true
  }
  return { bullish, bearish }
}

// ── SMT Divergence ────────────────────────────────────────────────
// Compares two correlated symbols (e.g. ES & NQ) at swing points.
// Bearish SMT: symbol A makes a higher high while B fails to. Bullish SMT:
// A makes a lower low while B fails to. This is a simplified approximation —
// real SMT analysis is more discretionary, but this captures the core idea.
export function findSMTDivergence(candlesA, candlesB, lookback = 5) {
  const len = Math.min(candlesA.length, candlesB.length)
  const swingHighsA = findSwingHighs(candlesA, lookback)
  const swingLowsA  = findSwingLows(candlesA, lookback)
  const swingHighsB = findSwingHighs(candlesB, lookback)
  const swingLowsB  = findSwingLows(candlesB, lookback)

  const bullish = Array(len).fill(false)
  const bearish = Array(len).fill(false)

  function priorTwoSwings(swings, uptoIdx) {
    const pts = []
    for (let j = uptoIdx; j >= 0; j--) {
      if (swings[j]) { pts.push(j); if (pts.length === 2) break }
    }
    return pts
  }

  for (let i = lookback * 2; i < len; i++) {
    const confirmIdx = i - lookback
    if (confirmIdx < 0) continue

    if (swingHighsA[confirmIdx]) {
      const priorA = priorTwoSwings(swingHighsA, confirmIdx - 1)
      const priorB = priorTwoSwings(swingHighsB, confirmIdx)
      if (priorA.length && priorB.length >= 2) {
        const aNewHigh = candlesA[confirmIdx].high > candlesA[priorA[0]].high
        const bNewHigh = candlesB[priorB[0]].high > candlesB[priorB[1]].high
        if (aNewHigh && !bNewHigh) bearish[i] = true
      }
    }
    if (swingLowsA[confirmIdx]) {
      const priorA = priorTwoSwings(swingLowsA, confirmIdx - 1)
      const priorB = priorTwoSwings(swingLowsB, confirmIdx)
      if (priorA.length && priorB.length >= 2) {
        const aNewLow = candlesA[confirmIdx].low < candlesA[priorA[0]].low
        const bNewLow = candlesB[priorB[0]].low < candlesB[priorB[1]].low
        if (aNewLow && !bNewLow) bullish[i] = true
      }
    }
  }
  return { bullish, bearish }
}

// ── Orchestrator — computes everything once, returns a flat object ──
// matching the same shape as buildIndicators() so it merges seamlessly.
export function buildSMCIndicators(candles, defs = [], candlesB = null) {
  const lookback = defs.find(d => d.lookback)?.lookback || 5
  const swingHighs = findSwingHighs(candles, lookback)
  const swingLows = findSwingLows(candles, lookback)
  const fvgs = findFVGs(candles)
  const fvgTouch = fvgTouchSignal(candles, fvgs)
  const ifvg = findIFVGs(candles, fvgs)
  const sweeps = findLiquiditySweeps(candles, swingHighs, swingLows, lookback)
  const rejection = findRejectionBlocks(candles)
  const bos = findBOS(candles, swingHighs, swingLows, lookback)
  const cisd = findCISD(candles)
  const smt = candlesB ? findSMTDivergence(candles, candlesB, lookback) : { bullish: [], bearish: [] }

  const available = {
    swingHigh: swingHighs,
    swingLow: swingLows,
    bullishFVG: fvgTouch.bullishTouch,
    bearishFVG: fvgTouch.bearishTouch,
    bullishIFVG: ifvg.bullish,
    bearishIFVG: ifvg.bearish,
    liquiditySweepLow: sweeps.sweepLow,
    liquiditySweepHigh: sweeps.sweepHigh,
    rejectionBlockBullish: rejection.bullish,
    rejectionBlockBearish: rejection.bearish,
    bosBullish: bos.bosBullish,
    bosBearish: bos.bosBearish,
    cisdBullish: cisd.bullish,
    cisdBearish: cisd.bearish,
    smtBullish: smt.bullish,
    smtBearish: smt.bearish,
  }

  // Only return the ids the strategy actually asked for
  const ids = defs.length ? defs.map(d => d.id) : Object.keys(available)
  const result = {}
  for (const id of ids) {
    if (available[id]) result[id] = available[id]
  }
  return result
}
