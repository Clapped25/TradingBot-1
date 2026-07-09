import { sbGet, sbSet } from './supabase'

// Unified Trade Memory v3 — ONE shared, permanent knowledge base.
// Four upgrades over the basic win-rate filter:
//
// 1. EXPECTANCY, not win rate. A combo with a 35% win rate can still be
//    profitable if winners are big enough — win rate alone is a
//    misleading filter. Everything here scores on R-multiple expectancy
//    (average $ result per $ risked), the actual industry-standard
//    measure of whether a setup is worth taking.
//
// 2. SESSION AWARENESS. The exact same factor combo can perform very
//    differently in the NY killzone vs low-volume Asian hours. Stats
//    are computed per-session first, falling back to the all-session
//    combo stats when there isn't enough session-specific data yet.
//
// 3. RECENCY WEIGHTING. Markets drift. A trade from 4 months ago counts
//    less than one from last week — exponential decay, not a flat
//    average over all of history.
//
// 4. CONFIDENCE-SCALED SIZING. Instead of a binary block/allow gate,
//    proven setups can size up (up to 1.5x) and shaky ones size down
//    (down to 0.5x), still capped within the account's risk budget.
//    Combos with a clearly negative expectancy are still hard-blocked.
//
// `sourceStrategy` is kept on each trade only as a label for
// transparency — it's never used to partition or filter the learning.

const STORAGE_KEY = 'tradingbot_unified_memory_v3'
const RECENCY_HALF_LIFE_DAYS = 45 // a trade this many days old counts half as much as a fresh one

function loadMemory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { trades: [] }
  } catch {
    return { trades: [] }
  }
}

function saveMemory(memory) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)) } catch {}
  // Async sync to Supabase — fire and forget
  sbSet('learning_memory', memory, 'main').catch(() => {})
}

// ── Pull latest learning memory from Supabase on app load ────────
export async function syncMemoryFromSupabase() {
  try {
    const data = await sbGet('learning_memory', 'main')
    if (data?.trades?.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      return true
    }
  } catch {}
  return false
}

function comboKeyFor(factors) {
  return Object.entries(factors || {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
    .join(' + ')
}

// ── Trading session from a UTC timestamp ─────────────────────────
// Broad buckets aligned to standard ICT killzones. Doesn't account for
// daylight saving shifts, but is a useful directional signal regardless
// since futures volume clusters around these windows either way.
export function getSession(timestamp) {
  const hour = new Date(timestamp).getUTCHours()
  if (hour >= 0 && hour < 7) return 'asian'
  if (hour >= 7 && hour < 12) return 'london'
  if (hour >= 12 && hour < 17) return 'newyork'
  return 'offhours'
}

export const SESSION_LABELS = {
  asian: 'Asian session', london: 'London session',
  newyork: 'New York session', offhours: 'Off-hours',
}

function recencyWeight(recordedAt, now) {
  const ageDays = Math.max(0, (now - recordedAt) / (1000 * 60 * 60 * 24))
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

// ── Bulk-seed memory from a backtest run — full detail, permanent ──
// Re-running the SAME strategy replaces only that strategy's prior
// contribution (so re-testing doesn't double-count), but trades from
// every OTHER strategy stay untouched — the shared pool keeps growing,
// forever, across sessions.
export function recordBacktestTrades(exits, sourceStrategy = 'unknown') {
  const memory = loadMemory()
  memory.trades = memory.trades.filter(t => t.sourceStrategy !== sourceStrategy)
  for (const t of exits) {
    memory.trades.push({
      factors: t.factors || {},
      entryPrice: t.entryPrice,
      exitPrice: t.price,
      entryTime: t.entryTime,
      exitTime: t.time,
      entryReason: t.entryReason || '',
      exitReason: t.reason || '',
      stopPrice: t.stopPrice,
      takeProfitPrice: t.takeProfitPrice,
      contracts: t.contracts,
      riskDollars: t.riskDollars || null,
      dollarPnl: t.dollarPnl,
      pnlPct: t.pnlPct,
      // R-multiple actually achieved — the real edge measure. Falls back
      // to null if riskDollars wasn't captured (shouldn't normally happen).
      rMultiple: t.riskDollars ? +(t.dollarPnl / t.riskDollars).toFixed(3) : null,
      // Path A additions — trade quality context
      mfeR: t.mfeR ?? null,
      maeR: t.maeR ?? null,
      qualityScore: t.qualityScore ?? null,
      regime: t.regime || 'unknown',
      win: t.pnlPct > 0,
      session: getSession(t.time),
      sourceStrategy,
      time: t.time,
      recordedAt: Date.now(),
    })
  }
  saveMemory(memory)
}

// ── Weighted expectancy + win rate over a set of trades ──────────
function summarize(tradeSet, now = Date.now()) {
  if (!tradeSet.length) return null
  let weightSum = 0, weightedWins = 0, weightedR = 0
  for (const t of tradeSet) {
    const w = recencyWeight(t.recordedAt, now)
    weightSum += w
    if (t.win) weightedWins += w
    if (t.rMultiple != null) weightedR += w * t.rMultiple
  }
  if (weightSum === 0) return null
  return {
    count: tradeSet.length,
    effectiveSampleSize: +weightSum.toFixed(1), // recency-discounted — old trades count for less than 1
    winRate: +(weightedWins / weightSum * 100).toFixed(1),
    expectancyR: +(weightedR / weightSum).toFixed(3),
  }
}

// ── Win-rate table for every individual factor ever seen ───────
// Pooled across ALL strategies and sessions — the broad-strokes view.
export function getFactorStats() {
  const memory = loadMemory()
  const table = {}

  for (const t of memory.trades) {
    for (const [key, val] of Object.entries(t.factors)) {
      if (val !== true) continue
      if (!table[key]) table[key] = []
      table[key].push(t)
    }
  }

  return Object.fromEntries(
    Object.entries(table)
      .map(([key, ts]) => {
        const s = summarize(ts)
        return [key, { total: ts.length, winRate: s.winRate, expectancyR: s.expectancyR }]
      })
      .sort((a, b) => b[1].total - a[1].total)
  )
}

// ── Win-rate + expectancy for specific factor COMBINATIONS ──────
export function getCombinationStats(minSampleSize = 2) {
  const memory = loadMemory()
  const table = {}

  for (const t of memory.trades) {
    const comboKey = comboKeyFor(t.factors)
    if (!comboKey) continue
    if (!table[comboKey]) table[comboKey] = []
    table[comboKey].push(t)
  }

  return Object.entries(table)
    .filter(([, ts]) => ts.length >= minSampleSize)
    .map(([combo, ts]) => {
      const s = summarize(ts)
      return {
        combo,
        factors: combo.split(' + '),
        total: ts.length,
        winRate: s.winRate,
        expectancyR: s.expectancyR,
      }
    })
    .sort((a, b) => b.expectancyR - a.expectancyR)
}

// ── Session breakdown for one specific combo — where does it work? ──
export function getSessionBreakdown(factors) {
  const comboKey = comboKeyFor(factors)
  if (!comboKey) return []
  const memory = loadMemory()
  const bySession = { asian: [], london: [], newyork: [], offhours: [] }
  for (const t of memory.trades) {
    if (comboKeyFor(t.factors) !== comboKey) continue
    bySession[t.session]?.push(t)
  }
  return Object.entries(bySession)
    .filter(([, ts]) => ts.length > 0)
    .map(([session, ts]) => {
      const s = summarize(ts)
      return { session, label: SESSION_LABELS[session], total: ts.length, winRate: s.winRate, expectancyR: s.expectancyR }
    })
    .sort((a, b) => b.expectancyR - a.expectancyR)
}

// ── The core decision: take this trade, and at what size? ───────
// Tries session-specific stats first (more precise), falls back to the
// all-session combo stats when there isn't enough session data yet,
// falls back to "allow at full size" when there's no data at all.
export function shouldTakeTrade(factors, opts = {}) {
  const {
    minSampleSize = 8,
    expectancyFloor = 0, // block combos with expectancy at or below this many R
  } = opts

  const comboKey = comboKeyFor(factors)
  if (!comboKey) {
    return { take: true, sizeFactor: 1, confidence: 0, sampleSize: 0, winRate: null, expectancyR: null, usedSession: null }
  }

  const memory = loadMemory()
  const now = Date.now()
  const session = getSession(now)

  const allForCombo = memory.trades.filter(t => comboKeyFor(t.factors) === comboKey)
  const sessionForCombo = allForCombo.filter(t => t.session === session)

  const sessionSummary = sessionForCombo.length ? summarize(sessionForCombo, now) : null
  const useSession = sessionSummary && sessionSummary.effectiveSampleSize >= minSampleSize

  const summary = useSession ? sessionSummary : (allForCombo.length ? summarize(allForCombo, now) : null)

  if (!summary || summary.effectiveSampleSize < minSampleSize) {
    return {
      take: true, sizeFactor: 1, confidence: 0,
      sampleSize: summary?.count || 0, winRate: summary?.winRate ?? null, expectancyR: summary?.expectancyR ?? null,
      usedSession: useSession ? session : null,
    }
  }

  // Confidence grows with effective sample size and with how far the
  // expectancy is from zero (a clear edge either way, not a coin flip).
  const sampleConfidence = Math.min(1, summary.effectiveSampleSize / 20)
  const edgeConfidence = Math.min(1, Math.abs(summary.expectancyR) / 0.5)
  const confidence = +(sampleConfidence * edgeConfidence).toFixed(2)

  const take = summary.expectancyR > expectancyFloor

  // Size scales with confidence and the sign/magnitude of the edge —
  // clamped so a single combo can never push size below 0.5x or above 1.5x.
  const clampedR = Math.max(-1, Math.min(1, summary.expectancyR))
  const sizeFactor = take ? +(1 + clampedR * confidence * 0.5).toFixed(2) : 0

  return {
    take,
    sizeFactor: Math.max(0.5, Math.min(1.5, sizeFactor || 1)),
    confidence,
    sampleSize: summary.count,
    winRate: summary.winRate,
    expectancyR: summary.expectancyR,
    usedSession: useSession ? session : null,
  }
}

// ── Record a single live paper trade into the shared memory ────
// This is what connects live trading to the learning system.
// Same memory pool as backtests — live trades influence future filters.
export function recordLiveTrade(trade, sourceStrategy = 'live') {
  if (!trade.exitTime || trade.pnlDollars == null) return  // only closed trades

  const memory = loadMemory()
  const pnlPct = trade.entryPrice
    ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice * 100) * (trade.side === 'LONG' ? 1 : -1)
    : 0

  memory.trades.push({
    factors:        trade.factors    || {},
    entryPrice:     trade.entryPrice,
    exitPrice:      trade.exitPrice,
    entryTime:      trade.entryTime,
    exitTime:       trade.exitTime,
    entryReason:    trade.signal     || 'live',
    exitReason:     trade.exitReason || 'manual',
    stopPrice:      trade.stopLoss   || null,
    takeProfitPrice:trade.takeProfit || null,
    contracts:      trade.quantity   || 1,
    riskDollars:    trade.stopLoss
      ? Math.abs(trade.entryPrice - trade.stopLoss) * (trade.multiplier || 2) * (trade.quantity || 1)
      : null,
    dollarPnl:      trade.pnlDollars,
    pnlPct:         +pnlPct.toFixed(4),
    rMultiple:      trade.stopLoss
      ? +(trade.pnlDollars / (Math.abs(trade.entryPrice - trade.stopLoss) * (trade.multiplier || 2) * (trade.quantity || 1))).toFixed(3)
      : null,
    mfeR:           null,
    maeR:           null,
    qualityScore:   null,
    regime:         trade.regime     || 'unknown',
    win:            trade.pnlDollars > 0,
    session:        getSession(trade.exitTime),
    sourceStrategy,
    time:           trade.exitTime,
    recordedAt:     Date.now(),
  })

  saveMemory(memory)
}

// ── Recent losses feed — "what went wrong", across everything ───
export function getRecentLosses(limit = 15) {
  const memory = loadMemory()
  return memory.trades
    .filter(t => !t.win)
    .slice(-limit)
    .reverse()
}

export function getAllTrades() {
  return loadMemory().trades
}

// ── Full permanent trade journal — every trade ever recorded ────
export function getJournal({ outcome = 'all', sourceStrategy = null, limit = null } = {}) {
  let trades = [...loadMemory().trades].sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0))
  if (outcome === 'wins') trades = trades.filter(t => t.win)
  if (outcome === 'losses') trades = trades.filter(t => !t.win)
  if (sourceStrategy) trades = trades.filter(t => t.sourceStrategy === sourceStrategy)
  if (limit) trades = trades.slice(0, limit)
  return trades
}

// ── Regime breakdown — where does each combo actually work? ─────
export function getRegimeBreakdown(factors) {
  const comboKey = comboKeyFor(factors)
  if (!comboKey) return []
  const memory = loadMemory()
  const regimes = ['trending_up', 'trending_down', 'ranging', 'volatile', 'unknown']
  const byRegime = Object.fromEntries(regimes.map(r => [r, []]))
  for (const t of memory.trades) {
    if (comboKeyFor(t.factors) !== comboKey) continue
    const r = t.regime || 'unknown'
    byRegime[r]?.push(t)
  }
  return regimes
    .filter(r => byRegime[r].length > 0)
    .map(r => {
      const s = summarize(byRegime[r])
      return { regime: r, total: byRegime[r].length, winRate: s?.winRate ?? 0, expectancyR: s?.expectancyR ?? 0 }
    })
    .sort((a, b) => b.expectancyR - a.expectancyR)
}

// ── Average MFE/MAE stats for a combo — trade quality summary ────
export function getQualityStats() {
  const memory = loadMemory()
  const trades = memory.trades.filter(t => t.mfeR != null && t.maeR != null)
  if (!trades.length) return null
  const avgMfeR = +(trades.reduce((s, t) => s + t.mfeR, 0) / trades.length).toFixed(2)
  const avgMaeR = +(trades.reduce((s, t) => s + t.maeR, 0) / trades.length).toFixed(2)
  const avgQuality = +(trades.filter(t => t.qualityScore != null)
    .reduce((s, t) => s + t.qualityScore, 0) / trades.length).toFixed(2)
  return { avgMfeR, avgMaeR, avgQuality, count: trades.length }
}

export function getMemorySummary() {
  const trades = getAllTrades()
  const wins = trades.filter(t => t.win)
  const strategiesContributing = new Set(trades.map(t => t.sourceStrategy)).size
  const s = summarize(trades)
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    expectancyR: s?.expectancyR ?? null,
    strategiesContributing,
  }
}

export function clearMemory() {
  saveMemory({ trades: [] })
}
