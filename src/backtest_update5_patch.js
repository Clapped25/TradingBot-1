// UPDATE 5 PATCH — add these functions to backtest.js
// Place them BEFORE the createBacktestEngine function

// ── Update 5: ATR calculation ─────────────────────────────────────
function calcATRBacktest(candles, i, period = 14) {
  const start = Math.max(0, i - period)
  let sum = 0, count = 0
  for (let k = start + 1; k <= i; k++) {
    sum += Math.max(
      candles[k].high - candles[k].low,
      Math.abs(candles[k].high - candles[k-1].close),
      Math.abs(candles[k].low  - candles[k-1].close)
    )
    count++
  }
  return count > 0 ? sum / count : 50
}

// ── Update 5: Minimum sweep distance (ATR-based, capped 20pts) ────
function hasMeaningfulSweep(candles, i, indicators) {
  const atr = calcATRBacktest(candles, i)
  const minSweep = Math.min(20, atr * 0.15)

  // Find the most recent liquidity sweep in lookback
  for (let k = i; k >= Math.max(0, i - 8); k--) {
    if (indicators.liquiditySweepLow?.[k]) {
      // Find the swing low that was swept
      for (let j = k - 1; j >= Math.max(0, k - 15); j--) {
        if (indicators.swingLow?.[j]) {
          const sweepDist = candles[j].low - candles[k].low
          return sweepDist >= minSweep
        }
      }
    }
    if (indicators.liquiditySweepHigh?.[k]) {
      for (let j = k - 1; j >= Math.max(0, k - 15); j--) {
        if (indicators.swingHigh?.[j]) {
          const sweepDist = candles[k].high - candles[j].high
          return sweepDist >= minSweep
        }
      }
    }
  }
  return true  // no sweep found, don't block
}

// ── Update 5: Displacement after sweep (3 bars, meaningful move) ──
function hasDisplacementBacktest(candles, i, indicators) {
  const atr     = calcATRBacktest(candles, i)
  const minMove = Math.max(5, atr * 0.1)
  const maxBars = 3

  // Find the sweep bar
  for (let k = i; k >= Math.max(0, i - 8); k--) {
    if (indicators.liquiditySweepLow?.[k] || indicators.liquiditySweepHigh?.[k]) {
      // Check if price moved meaningfully within 3 bars after sweep
      let maxMove = 0
      for (let b = k + 1; b <= Math.min(k + maxBars, i); b++) {
        const move = Math.abs(candles[b].close - candles[k].close)
        maxMove = Math.max(maxMove, move)
      }
      return maxMove >= minMove
    }
  }
  return true  // no sweep, don't block
}

// ── Update 5: 15-min FVG alignment bonus ─────────────────────────
function get15mFVGBonus(candles, i, side) {
  if (i < 14) return 0
  // Group last 15 x 5min bars into 5 x 15min bars
  const bars15m = []
  for (let start = i - 14; start <= i - 2; start += 3) {
    const slice = candles.slice(start, start + 3)
    if (slice.length < 3) continue
    bars15m.push({
      high:  Math.max(...slice.map(b => b.high)),
      low:   Math.min(...slice.map(b => b.low)),
      close: slice[slice.length - 1].close,
    })
  }
  for (let k = 2; k < bars15m.length; k++) {
    if (side === 'bull' && bars15m[k].low  > bars15m[k-2].high) return 2
    if (side === 'bear' && bars15m[k].high < bars15m[k-2].low)  return 2
  }
  return 0
}
