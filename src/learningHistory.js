// Learning History — stores a snapshot of the learning system's state
// after every backtest run. This is what powers the Learning Dashboard:
// instead of just seeing where the bot is NOW, you can see whether it
// has been getting better or worse run by run.
//
// Each snapshot captures: trade count, expectancy, win rate, blocked
// trades, which combos are actively filtering, regime performance,
// and trade quality metrics — all timestamped so they can be charted.

const STORAGE_KEY = 'tradingbot_learning_history_v1'
const MAX_SNAPSHOTS = 100

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { snapshots: [] }
  } catch {
    return { snapshots: [] }
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch {}
}

// ── Save a snapshot after a backtest run completes ────────────────
export function saveLearningSnapshot({
  strategyName,
  newTradesThisRun,
  cumulativeTradeCount,
  expectancyR,
  winRate,
  blockedThisRun,
  activeFilterCount,
  avgMfeR,
  avgMaeR,
  avgQuality,
  comboStats,         // top combos by expectancy
  regimeStats,        // per-regime performance
}) {
  const history = loadHistory()
  history.snapshots.push({
    id: Date.now(),
    runDate: Date.now(),
    strategyName,
    newTradesThisRun,
    cumulativeTradeCount,
    expectancyR,
    winRate,
    blockedThisRun,
    activeFilterCount,
    avgMfeR,
    avgMaeR,
    avgQuality,
    // Store just what we need for the dashboard — not the full combo objects
    topCombos: (comboStats || [])
      .slice(0, 5)
      .map(c => ({ combo: c.combo, expectancyR: c.expectancyR, total: c.total })),
    regimeStats: regimeStats || [],
  })

  // Keep only the most recent MAX_SNAPSHOTS
  if (history.snapshots.length > MAX_SNAPSHOTS) {
    history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS)
  }
  saveHistory(history)
}

// ── Get all snapshots, optionally filtered by strategy ───────────
export function getLearningHistory(strategyName = null) {
  const history = loadHistory()
  if (strategyName) {
    return history.snapshots.filter(s => s.strategyName === strategyName)
  }
  return history.snapshots
}

export function clearLearningHistory() {
  saveHistory({ snapshots: [] })
}

// ── Compute an overall learning health score (0-100) ─────────────
// Three components:
//   Sample size  — how much data the bot has learned from (0-40 pts)
//   Expectancy   — how positive the current edge is (0-40 pts)
//   Trend        — is the expectancy improving run over run? (0-20 pts)
export function computeHealthScore(snapshots) {
  if (!snapshots.length) return { score: 0, label: 'No data yet', components: null }

  const latest = snapshots[snapshots.length - 1]

  // Sample size component
  const sampleScore = Math.min(40, (latest.cumulativeTradeCount / 100) * 40)

  // Expectancy component: 20 baseline + up to 20 for positive edge
  const exp = latest.expectancyR ?? 0
  const expScore = 20 + Math.min(20, Math.max(-20, exp * 20))

  // Trend component: compare last 3 runs' expectancy
  let trendScore = 10 // neutral baseline
  if (snapshots.length >= 3) {
    const recent = snapshots.slice(-3).map(s => s.expectancyR ?? 0)
    const improving = recent[2] > recent[1] && recent[1] > recent[0]
    const declining  = recent[2] < recent[1] && recent[1] < recent[0]
    trendScore = improving ? 20 : declining ? 0 : 10
  }

  const score = Math.round(Math.min(100, Math.max(0, sampleScore + expScore + trendScore)))

  const label =
    score >= 85 ? 'Battle-tested' :
    score >= 70 ? 'Maturing' :
    score >= 50 ? 'Learning' :
    score >= 30 ? 'Building' :
    'Just starting'

  return {
    score,
    label,
    components: { sampleScore: Math.round(sampleScore), expScore: Math.round(expScore), trendScore },
  }
}
