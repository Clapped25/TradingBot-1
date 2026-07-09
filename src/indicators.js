// ── EMA ───────────────────────────────────────────────────────
export function calcEMA(arr, n) {
  const k = 2 / (n + 1)
  const out = Array(arr.length).fill(null)
  let sum = 0, cnt = 0
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i]; cnt++
    if (cnt < n) continue
    if (cnt === n) { out[i] = sum / n; continue }
    out[i] = arr[i] * k + out[i - 1] * (1 - k)
  }
  return out
}

// ── SMA ───────────────────────────────────────────────────────
export function calcSMA(arr, n) {
  return arr.map((_, i) =>
    i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b) / n
  )
}

// ── RSI ───────────────────────────────────────────────────────
export function calcRSI(arr, n) {
  const out = Array(arr.length).fill(null)
  let ag = 0, al = 0
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1]
    if (i <= n) { d > 0 ? (ag += d / n) : (al += -d / n) }
    if (i === n) { out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); continue }
    if (i > n) {
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0
      ag = (ag * (n - 1) + g) / n
      al = (al * (n - 1) + l) / n
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
    }
  }
  return out
}

import { buildSMCIndicators } from './smc'

const SMC_TYPES = new Set([
  'swingHigh', 'swingLow', 'bullishFVG', 'bearishFVG', 'bullishIFVG', 'bearishIFVG',
  'liquiditySweepLow', 'liquiditySweepHigh', 'rejectionBlockBullish', 'rejectionBlockBearish',
  'bosBullish', 'bosBearish', 'cisdBullish', 'cisdBearish', 'smtBullish', 'smtBearish',
])

// ── Build all indicators from strategy defs ───────────────────
// candlesB is optional — only needed if any def is an SMT divergence type.
export function buildIndicators(candles, defs = [], candlesB = null) {
  const closes = candles.map(c => c.close)
  const result = {}
  const smcDefs = []

  for (const d of defs) {
    if (d.type === 'ema') result[d.id] = calcEMA(closes, d.period)
    else if (d.type === 'sma') result[d.id] = calcSMA(closes, d.period)
    else if (d.type === 'rsi') result[d.id] = calcRSI(closes, d.period)
    else if (d.type === 'smc' || SMC_TYPES.has(d.id)) smcDefs.push(d)
  }

  if (smcDefs.length) {
    Object.assign(result, buildSMCIndicators(candles, smcDefs, candlesB))
  }

  return result
}
