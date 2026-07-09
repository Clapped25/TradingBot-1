// Market regime detection — classifies each bar into one of four states
// using pure price action. No external library needed.
//
// trending_up   — price consistently moving higher over the lookback window
// trending_down — price consistently moving lower
// ranging       — low ATR, no directional bias (choppy)
// volatile      — high ATR relative to price (spike/news/open)
//
// Uses two signals:
//   1. ATR as % of price → detects volatility
//   2. First-half vs second-half average close → detects trend direction/strength

const LOOKBACK = 20

export function detectRegime(candles, i) {
  if (i < LOOKBACK) return 'unknown'
  const slice = candles.slice(i - LOOKBACK, i + 1)

  // Average True Range
  let atrSum = 0
  for (let j = 1; j < slice.length; j++) {
    const c = slice[j], p = slice[j - 1]
    atrSum += Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    )
  }
  const atr = atrSum / (slice.length - 1)
  const avgPrice = slice.reduce((s, c) => s + c.close, 0) / slice.length

  // High ATR relative to price = volatile (news event, open, etc.)
  if (atr / avgPrice > 0.012) return 'volatile'

  // Trend: compare price level of first half vs second half of window
  const half = Math.floor(slice.length / 2)
  const firstAvg = slice.slice(0, half).reduce((s, c) => s + c.close, 0) / half
  const secondAvg = slice.slice(half).reduce((s, c) => s + c.close, 0) / (slice.length - half)
  const trendStrength = Math.abs(secondAvg - firstAvg) / atr

  if (trendStrength > 1.2) {
    return secondAvg > firstAvg ? 'trending_up' : 'trending_down'
  }
  return 'ranging'
}

export const REGIME_LABELS = {
  trending_up:   'Trending Up',
  trending_down: 'Trending Down',
  ranging:       'Ranging',
  volatile:      'Volatile',
  unknown:       'Unknown',
}

export const REGIME_COLORS = {
  trending_up:   'var(--green)',
  trending_down: 'var(--red)',
  ranging:       'var(--blue)',
  volatile:      'var(--amber)',
  unknown:       'var(--text-dim)',
}
