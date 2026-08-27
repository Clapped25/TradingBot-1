// SMC / ICT structural detectors.
// Each function scans the candle array and returns boolean arrays aligned
// to candle indices — same shape as the EMA/RSI indicators, so they can
// be merged into the same `ind` object the signal function already uses.
//
// FIXED: swing points are now marked at the CONFIRMATION bar (i + lookback)
// not at bar i. This matches live bot behavior — a swing is only "known"
// once lookback bars have printed after it.

// ── Swing highs / lows ──────────────────────────────────────────
export function findSwingHighs(candles, lookback = 5) {
  const out = Array(candles.length).fill(false)
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high
    let isSwing = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].high >= h) { isSwing = false; break }
    }
    // Mark at confirmation bar — this is when live bot would know about it
    if (isSwing && i + lookback < candles.length) out[i + lookback] = true
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
    // Mark at confirmation bar
    if (isSwing && i + lookback < candles.length) out[i + lookback] = true
  }
  return out
}

// ── Fair Value Gaps ──────────────────────────────────────────────
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
  for (const fvg of fvgs) {
    for (let k = fvg.formedIdx + 1; k < candles.length; k++) {
      const c = candles[k]
      if (fvg.type === 'bullish' && c.low <= fvg.top) { fvg.filled = true; fvg.filledIdx = k; break }
      if (fvg.type === 'bearish' && c.high >= fvg.bottom) { fvg.filled = true; fvg.filledIdx = k; break }
    }
  }
  return fvgs
}

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
export function findIFVGs(candles, fvgs) {
  const bullish = Array(candles.length).fill(false)
  const bearish = Array(candles.length).fill(false)
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
export function findLiquiditySweeps(candles, swingHighs, swingLows, lookback = 5) {
  const sweepHigh = Array(candles.length).fill(false)
  const sweepLow  = Array(candles.length).fill(false)
  for (let i = lookback; i < candles.length; i++) {
    const c = candles[i]
    for (let j = i - 1; j >= Math.max(0, i - lookback * 3); j--) {
      if (swingHighs[j]) {
        if (c.high > candles[j].high && c.close < candles[j].high) sweepHigh[i] = true
        break
      }
    }
    for (let j = i - 1; j >= Math.max(0, i - lookback * 3); j--) {
      if (swingLows[j]) {
        if (c.low < candles[j].low && c.close > candles[j].low) sweepLow[i] = true
        break
      }
    }
  }
  return { sweepHigh, sweepLow }
}

// ── Rejection blocks ─────────────────────────────────────────────
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

// ── Break of Structure ────────────────────────────────────────────
export function findBOS(candles, swingHighs, swingLows, lookback = 5) {
  const bosBullish = Array(candles.length).fill(false)
  const bosBearish = Array(candles.length).fill(false)
  let lastSwingHigh = null, lastSwingLow = null
  for (let i = 0; i < candles.length; i++) {
    if (swingHighs[i]) lastSwingHigh = candles[i].high
    if (swingLows[i])  lastSwingLow  = candles[i].low
    if (lastSwingHigh != null && candles[i].close > lastSwingHigh) {
      bosBullish[i] = true; lastSwingHigh = null
    }
    if (lastSwingLow  != null && candles[i].close < lastSwingLow) {
      bosBearish[i] = true; lastSwingLow  = null
    }
  }
  return { bosBullish, bosBearish }
}

// ── CISD ─────────────────────────────────────────────────────────
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
    if (swingHighsA[i]) {
      const priorA = priorTwoSwings(swingHighsA, i - 1)
      const priorB = priorTwoSwings(swingHighsB, i)
      if (priorA.length && priorB.length >= 2) {
        const aNewHigh = candlesA[i].high > candlesA[priorA[0]].high
        const bNewHigh = candlesB[priorB[0]].high > candlesB[priorB[1]].high
        if (aNewHigh && !bNewHigh) bearish[i] = true
      }
    }
    if (swingLowsA[i]) {
      const priorA = priorTwoSwings(swingLowsA, i - 1)
      const priorB = priorTwoSwings(swingLowsB, i)
      if (priorA.length && priorB.length >= 2) {
        const aNewLow = candlesA[i].low < candlesA[priorA[0]].low
        const bNewLow = candlesB[priorB[0]].low < candlesB[priorB[1]].low
        if (aNewLow && !bNewLow) bullish[i] = true
      }
    }
  }
  return { bullish, bearish }
}

// ── Orchestrator ──────────────────────────────────────────────────
export function buildSMCIndicators(candles, defs = [], candlesB = null) {
  const lookback   = defs.find(d => d.lookback)?.lookback || 5
  const swingHighs = findSwingHighs(candles, lookback)
  const swingLows  = findSwingLows(candles, lookback)
  const fvgs       = findFVGs(candles)
  const fvgTouch   = fvgTouchSignal(candles, fvgs)
  const ifvg       = findIFVGs(candles, fvgs)
  const sweeps     = findLiquiditySweeps(candles, swingHighs, swingLows, lookback)
  const rejection  = findRejectionBlocks(candles)
  const bos        = findBOS(candles, swingHighs, swingLows, lookback)
  const cisd       = findCISD(candles)
  const smt        = candlesB ? findSMTDivergence(candles, candlesB, lookback) : { bullish: [], bearish: [] }

  const available = {
    swingHigh:              swingHighs,
    swingLow:               swingLows,
    bullishFVG:             fvgTouch.bullishTouch,
    bearishFVG:             fvgTouch.bearishTouch,
    bullishIFVG:            ifvg.bullish,
    bearishIFVG:            ifvg.bearish,
    liquiditySweepLow:      sweeps.sweepLow,
    liquiditySweepHigh:     sweeps.sweepHigh,
    rejectionBlockBullish:  rejection.bullish,
    rejectionBlockBearish:  rejection.bearish,
    bosBullish:             bos.bosBullish,
    bosBearish:             bos.bosBearish,
    cisdBullish:            cisd.bullish,
    cisdBearish:            cisd.bearish,
    smtBullish:             smt.bullish,
    smtBearish:             smt.bearish,
  }

  const ids = defs.length ? defs.map(d => d.id) : Object.keys(available)
  const result = {}
  for (const id of ids) {
    if (available[id]) result[id] = available[id]
  }
  return result
}
