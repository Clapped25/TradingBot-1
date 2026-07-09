import { buildIndicators } from './indicators'
import { runBacktest, calcStats } from './backtest'

// ── Score a result — balances return against drawdown and win rate ──
// Requires a minimum sample size so a single lucky trade can't "win"
function scoreStats(stats) {
  if (!stats || stats.total < 4) return -Infinity
  const pnl = parseFloat(stats.totalPnl)
  const dd = Math.max(parseFloat(stats.maxDD), 0.5) // floor to avoid divide-by-zero blowups
  const winRate = parseFloat(stats.winRate) / 100
  return (pnl / dd) * winRate
}

// ── Build every combination within the given ranges ────────────
function buildCombinations(tunable) {
  const ranges = tunable.map(t => {
    const vals = []
    for (let v = t.min; v <= t.max; v += t.step) vals.push(v)
    return vals
  })
  let combos = [[]]
  for (const range of ranges) {
    const next = []
    for (const combo of combos) {
      for (const v of range) next.push([...combo, v])
    }
    combos = next
  }
  return combos.map(combo => {
    const obj = {}
    combo.forEach((v, i) => { obj[tunable[i].indicatorId] = v })
    return obj
  })
}

// ── Auto-generate sensible tuning ranges from current indicator periods ──
export function autoTunableRanges(indicatorDefs) {
  return indicatorDefs
    .filter(d => d.type === 'ema' || d.type === 'sma' || d.type === 'rsi')
    .map(d => {
      const base = d.period
      const min = Math.max(2, Math.round(base * 0.5))
      const max = Math.round(base * 1.8)
      const span = max - min
      const step = Math.max(1, Math.round(span / 6))
      return { indicatorId: d.id, label: d.label || d.id, min, max, step, current: base }
    })
}

// ── Run the optimization ────────────────────────────────────────
// Tests every combination of indicator periods within the given ranges,
// re-running the (unchanged) signal logic against each, and ranks results.
export async function optimizeParameters({
  candles, indicatorDefs, tunable, signalBody, onProgress, maxCombos = 150,
}) {
  let combos = buildCombinations(tunable)
  const totalPossible = combos.length

  if (combos.length > maxCombos) {
    combos = [...combos].sort(() => Math.random() - 0.5).slice(0, maxCombos)
  }

  const signalFn = new Function('i', 'candles', 'ind', 'pos', signalBody)
  const results = []

  for (let idx = 0; idx < combos.length; idx++) {
    const periods = combos[idx]
    const testDefs = indicatorDefs.map(d => ({
      ...d,
      period: periods[d.id] ?? d.period,
    }))
    const indicators = buildIndicators(candles, testDefs)
    const trades = runBacktest(candles, indicators, signalFn)
    const stats = calcStats(trades.filter(t => t.type === 'exit'))
    const score = scoreStats(stats)

    if (score > -Infinity) {
      results.push({ periods, stats, score })
    }

    if (onProgress) onProgress(idx + 1, combos.length)
    if (idx % 8 === 0) await new Promise(r => setTimeout(r, 0)) // keep UI responsive
  }

  results.sort((a, b) => b.score - a.score)
  return { results: results.slice(0, 8), tested: combos.length, totalPossible }
}
