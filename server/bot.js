import fetch from 'node-fetch'
import http from 'http'

// Health check server so Railway keeps the process alive
const PORT = process.env.PORT || 3000
http.createServer((req, res) => { res.writeHead(200); res.end('TradingBot running') })
  .listen(PORT, () => console.log(`Health check on port ${PORT}`))

const MASSIVE_API_KEY = (process.env.MASSIVE_API_KEY || '').trim()
const SUPABASE_URL    = 'https://dxnxtthvupbfydttqcpk.supabase.co'
const SUPABASE_ANON   = (process.env.SUPABASE_ANON || '').trim().replace(/[\r\n\t]/g, '')
const PRIMARY         = 'NQ'
const SYMBOL          = 'MNQ'
const MULTIPLIER      = 2   // MNQ = $2 per point
const POLL_MS         = 5 * 60 * 1000
const BASE_RISK_PCT   = 1   // risk 1% of account per trade

// ── Eval Mode Config ──────────────────────────────────────────────
const EVAL_MODE         = true    // set false when on real funded account
const EVAL_ACCOUNT_SIZE = 25000
const EVAL_PROFIT_TARGET = 1250   // +$1,250 to pass
const EVAL_MAX_DRAWDOWN  = 1000   // -$1,000 blows account
const EVAL_DAILY_LIMIT   = 600    // stop trading at -$600/day (buffer before $1k limit)
const EVAL_MAX_CONTRACTS = 2      // cap contracts during eval

// ── Supabase ──────────────────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type':  'application/json',
  'apikey':        SUPABASE_ANON,
  'Authorization': `Bearer ${SUPABASE_ANON}`,
  'Prefer':        'resolution=merge-duplicates',
}

async function sbGet(table, id = 'main') {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=data`, { headers: SB_HEADERS })
    if (!res.ok) return null
    return (await res.json())?.[0]?.data ?? null
  } catch { return null }
}

async function sbSet(table, data, id = 'main') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: SB_HEADERS,
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() }),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error(`sbSet FAILED ${table}: ${res.status} ${err}`)
    throw new Error(`sbSet failed: ${res.status}`)
  }
}

// ── Massive ───────────────────────────────────────────────────────
const MONTH_CODES = ['F','G','H','J','K','M','N','Q','U','V','X','Z']

function getFrontMonthTicker() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1
  const qm = [3,6,9,12].find(q => q >= m) || 3
  const yr = qm >= m ? y : y + 1
  return `${PRIMARY}${MONTH_CODES[qm-1]}${String(yr).slice(-1)}`
}

async function fetchBars(limit = 300) {
  const ticker = getFrontMonthTicker()
  const now    = new Date()
  const from   = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
  const gte    = from.toISOString().slice(0, 10)
  const url    = `https://api.massive.com/futures/v1/aggs/${ticker}` +
    `?resolution=5min&window_start.gte=${gte}&window_start.lte=${now.toISOString()}` +
    `&limit=${limit}&sort=window_start.desc&apiKey=${MASSIVE_API_KEY}&_t=${Date.now()}`
  const res  = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
  if (!res.ok) throw new Error(`Massive ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const bars = (data.results || []).reverse().map(b => ({
    time: b.window_start / 1e6, open: b.open, high: b.high, low: b.low, close: b.close,
  }))
  if (bars.length > 0) {
    const last = bars[bars.length - 1]
    console.log(`Got ${bars.length} bars. Most recent: ${new Date(last.time).toISOString()} close:${last.close}`)
  }
  return bars
}

// ── ATR ───────────────────────────────────────────────────────────
function calcATR(candles, period = 14) {
  const slice = candles.slice(-period - 1)
  let sum = 0
  for (let i = 1; i < slice.length; i++) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low  - slice[i-1].close)
    )
  }
  return sum / period
}

// ── Dynamic risk engine ───────────────────────────────────────────
// Adjusts contracts and RR based on win probability from learning memory
async function calcDynamicRisk(candles, side, currentPrice, factors, accountBalance) {
  const atrVal = calcATR(candles)

  // Get win stats from learning memory
  let winRate = 50, expectancy = 0, sampleSize = 0, confidence = 0
  try {
    const mem = await sbGet('learning_memory') || { trades: [] }
    if (mem.trades?.length) {
      const key = Object.entries(factors || {})
        .filter(([,v]) => v).map(([k]) => k).sort().join('+')
      if (key) {
        const matching = mem.trades.filter(t => {
          const tk = Object.entries(t.factors || {})
            .filter(([,v]) => v).map(([k]) => k).sort().join('+')
          return tk === key
        })
        if (matching.length >= 4) {
          sampleSize = matching.length
          winRate    = +((matching.filter(t => t.win).length / sampleSize) * 100).toFixed(1)
          expectancy = +(matching.reduce((s,t) => s + (t.rMultiple || 0), 0) / sampleSize).toFixed(3)
          confidence = Math.min(1, sampleSize / 30)
        }
      }
    }
  } catch (e) { console.error('Risk memory error:', e.message) }

  // ATR-based stop distance (1.5x ATR gives trade room to breathe)
  const stopDistance = +(atrVal * 1.5).toFixed(2)

  // Win-rate adjusted RR target
  // If win rate is high → can aim for smaller RR (target is more achievable)
  // If win rate is low  → need bigger RR to be profitable
  const winFrac   = Math.max(0.3, Math.min(0.8, winRate / 100))
  const minRR     = +((1 - winFrac) / winFrac).toFixed(2)  // break-even RR
  const edgeBonus = confidence * 1.5  // up to +1.5R when fully confident
  const rrRatio   = +Math.max(1.5, Math.min(4.0, minRR + edgeBonus)).toFixed(2)

  const targetDistance = +(stopDistance * rrRatio).toFixed(2)

  // Exact SL and TP prices
  const stopPrice   = side === 'LONG'
    ? +(currentPrice - stopDistance).toFixed(2)
    : +(currentPrice + stopDistance).toFixed(2)
  const targetPrice = side === 'LONG'
    ? +(currentPrice + targetDistance).toFixed(2)
    : +(currentPrice - targetDistance).toFixed(2)

  // Position sizing — risk X% of account, scaled by expectancy
  const riskMult    = sampleSize >= 8
    ? Math.max(0.5, Math.min(1.5, 1 + expectancy * 0.5))
    : 1.0
  const riskDollars = accountBalance * (BASE_RISK_PCT / 100) * riskMult
  const rawContracts = Math.max(1, Math.round(riskDollars / (stopDistance * MULTIPLIER)))
  // Cap at 2 contracts until 30+ backtests, 3 until 50+, then uncapped
  // During eval cap at 2, reduce to 1 if daily loss mounting
  let maxContracts = sampleSize >= 50 ? 6 : sampleSize >= 30 ? 3 : 2
  if (EVAL_MODE) {
    const evalS = await getEvalStats()
    maxContracts = evalS.todayPnl <= -300 ? 1 : EVAL_MAX_CONTRACTS
  }
  const contracts = Math.min(rawContracts, maxContracts)

  console.log(`[RISK] ATR:${atrVal.toFixed(1)} stop:${stopDistance}pts RR:${rrRatio} contracts:${contracts} winRate:${winRate}% n:${sampleSize} riskMult:${riskMult}`)

  return { stopPrice, targetPrice, stopDistance, targetDistance, rrRatio, contracts, winRate, expectancy, sampleSize }
}

// ── Market structure detection ────────────────────────────────────
function detectStructure(candles) {
  if (candles.length < 10) return 'neutral'
  const swings = []
  for (let i = 3; i < candles.length - 3; i++) {
    const isH = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                candles[i].high > candles[i-3].high && candles[i].high > candles[i+1].high &&
                candles[i].high > candles[i+2].high && candles[i].high > candles[i+3].high
    const isL = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                candles[i].low < candles[i-3].low && candles[i].low < candles[i+1].low &&
                candles[i].low < candles[i+2].low && candles[i].low < candles[i+3].low
    if (isH) swings.push({ type: 'high', price: candles[i].high })
    if (isL) swings.push({ type: 'low',  price: candles[i].low })
  }
  if (swings.length < 4) return 'neutral'
  const highs = swings.filter(s => s.type === 'high').slice(-2)
  const lows  = swings.filter(s => s.type === 'low').slice(-2)
  if (highs.length < 2 || lows.length < 2) return 'neutral'
  const hhhl = highs[1].price > highs[0].price && lows[1].price > lows[0].price
  const lhll = highs[1].price < highs[0].price && lows[1].price < lows[0].price
  if (hhhl) return 'bullish'
  if (lhll) return 'bearish'
  return 'neutral'
}

// ── HTF Bias (updates every hour) ────────────────────────────────
async function updateBias(candles) {
  // 1H proxy: last 100 bars (~8 hours of recent structure)
  const bias1H = detectStructure(candles.slice(-100))
  // 4H proxy: full bar set (~40 hours for bigger picture)
  const bias4H = detectStructure(candles)

  let direction = 'both', threshold = 5, reason = ''

  if (bias1H === 'bullish' && bias4H === 'bullish') {
    direction = 'long';  threshold = 4
    reason = '1H+4H bullish → LONG only, threshold 4'
  } else if (bias1H === 'bearish' && bias4H === 'bearish') {
    direction = 'short'; threshold = 4
    reason = '1H+4H bearish → SHORT only, threshold 4'
  } else if (bias1H !== 'neutral' && bias4H !== 'neutral' && bias1H !== bias4H) {
    direction = 'both';  threshold = 7
    reason = `Conflicting (1H:${bias1H} 4H:${bias4H}) → both, threshold 7`
  } else {
    direction = 'both';  threshold = 5
    reason = `Unclear (1H:${bias1H} 4H:${bias4H}) → both, threshold 5`
  }

  const bias = { bias1H, bias4H, direction, threshold, reason, updatedAt: Date.now() }
  console.log(`[BIAS] ${reason}`)
  try { await sbSet('bot_log', bias, 'bias') } catch {}
  return bias
}

async function getBias() {
  try {
    const cached = await sbGet('bot_log', 'bias')
    if (cached?.updatedAt && Date.now() - cached.updatedAt < 55 * 60 * 1000) return cached
  } catch {}
  return null
}

// ── Session threshold ─────────────────────────────────────────────
function getSessionThreshold(baseThreshold) {
  const h = new Date().getUTCHours()
  const active = (h >= 13 && h < 21) || (h >= 7 && h < 12) || (h >= 23 || h < 4)
  if (!active) {
    const raised = Math.max(baseThreshold, 6)
    if (raised > baseThreshold) console.log(`[SESSION] Offhours — threshold raised to ${raised}`)
    return raised
  }
  return baseThreshold
}

// ── Paper broker ──────────────────────────────────────────────────
async function getTrades()  { return await sbGet('paper_trades')  || [] }
async function getAccount() {
  return await sbGet('paper_account') || {
    startingBalance: 25000, balance: 25000,
    realizedPnl: 0, totalTrades: 0, wins: 0, losses: 0,
  }
}
function getOpenPos(trades) { return trades.find(t => !t.exitTime) || null }

async function openTrade(trades, { side, entryPrice, contracts, stopLoss, takeProfit }) {
  const trade = {
    id: Date.now(), symbol: SYMBOL, side,
    entryPrice, quantity: contracts,
    stopLoss, takeProfit,
    entryTime: Date.now(),
    exitTime: null, exitPrice: null, exitReason: null,
    pnlDollars: null, multiplier: MULTIPLIER,
  }
  trades.push(trade)
  await sbSet('paper_trades', trades)
  console.log(`📈 Opened ${side} ${contracts}x @ ${entryPrice} | SL:${stopLoss} TP:${takeProfit}`)
  return trade
}

async function closeTrade(trades, exitPrice, exitReason) {
  const idx = trades.findIndex(t => !t.exitTime)
  if (idx === -1) return null
  const t      = trades[idx]
  const pts    = t.side === 'LONG' ? exitPrice - t.entryPrice : t.entryPrice - exitPrice
  const pnl    = pts * MULTIPLIER * (t.quantity || 1)
  trades[idx]  = { ...t, exitTime: Date.now(), exitPrice, exitReason, pnlDollars: pnl }
  await sbSet('paper_trades', trades)
  const acc    = await getAccount()
  acc.balance     += pnl
  acc.realizedPnl += pnl
  acc.totalTrades++
  if (pnl > 0) acc.wins++; else acc.losses++
  await sbSet('paper_account', acc)
  console.log(`📉 Closed ${t.side} ${t.quantity}x @ ${exitPrice} P&L:${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (${exitReason})`)
  return trades[idx]
}

// ── Indicators ────────────────────────────────────────────────────
function buildIndicators(candles) {
  const n = candles.length
  const swH = new Array(n).fill(false), swL = new Array(n).fill(false)
  for (let i = 3; i < n-3; i++) {
    if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
        candles[i].high > candles[i-3].high && candles[i].high > candles[i+1].high &&
        candles[i].high > candles[i+2].high && candles[i].high > candles[i+3].high) swH[i] = true
    if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
        candles[i].low < candles[i-3].low && candles[i].low < candles[i+1].low &&
        candles[i].low < candles[i+2].low && candles[i].low < candles[i+3].low) swL[i] = true
  }
  const sweepLow = new Array(n).fill(false), sweepHigh = new Array(n).fill(false)
  for (let i = 6; i < n; i++) {
    for (let j = i-1; j >= Math.max(0, i-15); j--) {
      if (swL[j] && candles[i].low < candles[j].low && candles[i].close > candles[j].low) sweepLow[i] = true
      if (swH[j] && candles[i].high > candles[j].high && candles[i].close < candles[j].high) sweepHigh[i] = true
    }
  }
  const bosBull = new Array(n).fill(false), bosBear = new Array(n).fill(false)
  let lsh = null, lsl = null
  for (let i = 0; i < n; i++) {
    if (swH[i]) lsh = candles[i].high
    if (swL[i]) lsl = candles[i].low
    if (lsh && candles[i].close > lsh) { bosBull[i] = true; lsh = null }
    if (lsl && candles[i].close < lsl) { bosBear[i] = true; lsl = null }
  }
  const fvgBull = new Array(n).fill(false), fvgBear = new Array(n).fill(false)
  for (let i = 2; i < n; i++) {
    if (candles[i].low  > candles[i-2].high) fvgBull[i] = true
    if (candles[i].high < candles[i-2].low)  fvgBear[i] = true
  }
  const obBull = new Array(n).fill(false), obBear = new Array(n).fill(false)
  for (let i = 1; i < n; i++) {
    if (candles[i-1].close < candles[i-1].open && candles[i].close > candles[i-1].open) obBull[i] = true
    if (candles[i-1].close > candles[i-1].open && candles[i].close < candles[i-1].open) obBear[i] = true
  }
  return {
    liquiditySweepLow: sweepLow, liquiditySweepHigh: sweepHigh,
    bosBullish: bosBull, bosBearish: bosBear,
    bullishFVG: fvgBull, bearishFVG: fvgBear,
    bullishIFVG: fvgBear, bearishIFVG: fvgBull,
    rejectionBlockBullish: obBull, rejectionBlockBearish: obBear,
    cisdBullish: bosBull, cisdBearish: bosBear,
    smtBullish: new Array(n).fill(false), smtBearish: new Array(n).fill(false),
    swingHigh: swH, swingLow: swL,
  }
}

// ── Signal evaluation ─────────────────────────────────────────────
function evalSignal(candles, ind, signalBody, openPos) {
  try {
    const fn  = new Function('i', 'candles', 'ind', 'pos', signalBody)
    const pos = openPos
      ? { isOpen: true,  side: openPos.side }
      : { isOpen: false, side: 'FLAT' }
    return fn(candles.length - 1, candles, ind, pos)
  } catch (e) { console.error('Signal error:', e.message); return null }
}

// ── Learning filter ───────────────────────────────────────────────
async function canTrade(factors) {
  try {
    const mem = await sbGet('learning_memory') || { trades: [] }
    if (!mem.trades?.length) return true
    const key = Object.entries(factors || {})
      .filter(([,v]) => v).map(([k]) => k).sort().join('+')
    if (!key) return true
    const matching = mem.trades.filter(t => {
      const tk = Object.entries(t.factors || {})
        .filter(([,v]) => v).map(([k]) => k).sort().join('+')
      return tk === key
    })
    if (matching.length < 8) return true
    const exp = matching.reduce((s,t) => s + (t.rMultiple || 0), 0) / matching.length
    console.log(`[FILTER] ${key} exp:${exp.toFixed(3)} n:${matching.length} allow:${exp > 0}`)
    return exp > 0
  } catch { return true }
}

// ── Activity log ──────────────────────────────────────────────────
async function log(type, msg, detail = null) {
  console.log(`[${type.toUpperCase()}] ${msg}${detail ? ' — ' + detail : ''}`)
  try {
    const existing = await sbGet('bot_log') || []
    if (Array.isArray(existing)) {
      existing.unshift({ type, message: msg, detail, time: new Date().toISOString() })
      await sbSet('bot_log', existing.slice(0, 200))
    }
  } catch {}
  // Track blocked trades separately
  if (type === 'filter' && msg.includes('BLOCKED')) {
    try {
      const stats = await sbGet('bot_stats') || { blockedTrades: 0, totalSignals: 0, tradesOpened: 0 }
      stats.blockedTrades = (stats.blockedTrades || 0) + 1
      stats.lastBlocked = { message: msg, detail, time: new Date().toISOString() }
      await sbSet('bot_stats', stats, 'main')
    } catch {}
  }
  if (type === 'trade' && msg.includes('Opened')) {
    try {
      const stats = await sbGet('bot_stats') || { blockedTrades: 0, totalSignals: 0, tradesOpened: 0 }
      stats.tradesOpened = (stats.tradesOpened || 0) + 1
      await sbSet('bot_stats', stats, 'main')
    } catch {}
  }
  if (type === 'signal' && !msg.includes('NONE') && !msg.includes('none')) {
    try {
      const stats = await sbGet('bot_stats') || { blockedTrades: 0, totalSignals: 0, tradesOpened: 0 }
      stats.totalSignals = (stats.totalSignals || 0) + 1
      await sbSet('bot_stats', stats, 'main')
    } catch {}
  }
}


// ── Eval Stats ────────────────────────────────────────────────────
async function getEvalStats() {
  const trades    = await getTrades()
  const account   = await getAccount()
  const closed    = trades.filter(t => t.exitTime && t.pnlDollars !== null)
  const botStats  = await sbGet('bot_stats', 'main') || {}
  const prevEval  = botStats.eval || {}

  // Trailing EOD drawdown — floor moves up as balance grows
  // Peak EOD balance = highest EOD balance recorded
  const peakBalance   = prevEval.peakEodBalance || EVAL_ACCOUNT_SIZE
  const currentFloor  = peakBalance - EVAL_MAX_DRAWDOWN
  const totalProfit   = account.balance - EVAL_ACCOUNT_SIZE
  const drawdownUsed  = Math.max(0, currentFloor - account.balance)  // how much below floor
  const totalDrawdown = -drawdownUsed

  // Today's P&L
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayTrades = closed.filter(t => t.exitTime >= todayStart.getTime())
  const todayPnl    = todayTrades.reduce((s, t) => s + (t.pnlDollars || 0), 0)

  // Progress to target
  const progressPct  = +((totalProfit / EVAL_PROFIT_TARGET) * 100).toFixed(1)
  const drawdownPct  = +((drawdownUsed / EVAL_MAX_DRAWDOWN) * 100).toFixed(1)
  const drawdownLeft = EVAL_MAX_DRAWDOWN - drawdownUsed  // how much left before blown

  // Save stats to Supabase for Vercel display
  const stats = {
    totalProfit, totalDrawdown, todayPnl,
    progressPct, drawdownPct, drawdownLeft,
    balance: account.balance,
    target: EVAL_PROFIT_TARGET,
    maxDrawdown: EVAL_MAX_DRAWDOWN,
    dailyLimit: EVAL_DAILY_LIMIT,
    passed: totalProfit >= EVAL_PROFIT_TARGET,
    blown:  totalDrawdown <= -EVAL_MAX_DRAWDOWN,
    updatedAt: Date.now(),
  }

  try { await sbSet('bot_stats', { ...await sbGet('bot_stats') || {}, eval: stats }, 'main') } catch {}

  return stats
}


// ── UPDATE 5: Signal Quality Improvements ────────────────────────

// 1. Check if sweep distance is meaningful (ATR-based, capped at 20pts)
function isMeaningfulSweep(candles, sweepBarIdx, swingPrice, side) {
  if (sweepBarIdx < 0) return true  // fallback allow
  const atr = calcATR(candles)
  const minSweep = Math.min(20, atr * 0.15)
  const bar = candles[sweepBarIdx]
  if (!bar) return true
  const sweepDistance = side === 'low'
    ? swingPrice - bar.low    // how far below swing low price went
    : bar.high - swingPrice   // how far above swing high price went
  return sweepDistance >= minSweep
}

// 2. Check displacement after sweep — BOS within 3 bars + meaningful move
function hasDisplacement(candles, sweepBarIdx) {
  if (sweepBarIdx < 0 || sweepBarIdx >= candles.length - 1) return true
  const atr = calcATR(candles)
  const minMove = Math.max(5, atr * 0.1)  // at least 10% of ATR or 5pts
  const maxBars = 3

  // Check if price moved meaningfully within 3 bars after sweep
  let maxMove = 0
  for (let b = sweepBarIdx + 1; b <= Math.min(sweepBarIdx + maxBars, candles.length - 1); b++) {
    const move = Math.abs(candles[b].close - candles[sweepBarIdx].close)
    maxMove = Math.max(maxMove, move)
  }
  return maxMove >= minMove
}

// 3. Check 15-min FVG alignment (using 5min bars grouped into 15min)
function has15minFVG(candles, side) {
  if (candles.length < 3) return false
  // Group last 15 bars into 5 x 15-min candles
  const bars15m = []
  for (let i = candles.length - 15; i < candles.length - 2; i += 3) {
    if (i < 0) continue
    const slice = candles.slice(i, i + 3)
    bars15m.push({
      open:  slice[0].open,
      high:  Math.max(...slice.map(b => b.high)),
      low:   Math.min(...slice.map(b => b.low)),
      close: slice[slice.length - 1].close,
    })
  }
  if (bars15m.length < 3) return false

  // Check for FVG on 15min bars
  for (let i = 2; i < bars15m.length; i++) {
    if (side === 'bull' && bars15m[i].low > bars15m[i-2].high) return true
    if (side === 'bear' && bars15m[i].high < bars15m[i-2].low) return true
  }
  return false
}

// 4. Handle partial take profit — close 50% at 1R, move stop to breakeven
async function checkPartialTP(trades, currentPrice) {
  const openPos = getOpenPos(trades)
  if (!openPos || openPos.partialTaken) return  // already done partial

  if (!openPos.stopLoss || !openPos.takeProfit) return

  const stopDist   = Math.abs(openPos.entryPrice - openPos.stopLoss)
  const oneR_level = openPos.side === 'LONG'
    ? openPos.entryPrice + stopDist   // 1R up for longs
    : openPos.entryPrice - stopDist   // 1R down for shorts

  const hit1R = openPos.side === 'LONG'
    ? currentPrice >= oneR_level
    : currentPrice <= oneR_level

  if (hit1R && !openPos.partialTaken) {
    console.log(`🎯 1R HIT @ ${currentPrice} — taking 50% profit, moving stop to breakeven`)

    // Mark partial as taken and move stop to breakeven
    const idx = trades.findIndex(t => !t.exitTime)
    if (idx !== -1) {
      const pnlHalf = (stopDist * openPos.multiplier * Math.floor((openPos.quantity || 1) / 2))
      trades[idx] = {
        ...trades[idx],
        partialTaken:   true,
        partialPrice:   currentPrice,
        partialPnl:     pnlHalf,
        stopLoss:       openPos.entryPrice,  // move stop to breakeven
        quantity:       Math.max(1, Math.floor((openPos.quantity || 1) / 2)),
      }
      await sbSet('paper_trades', trades)
      await log('trade', `Partial TP taken @ ${currentPrice}`, `50% closed, stop moved to breakeven ${openPos.entryPrice}`)
    }
  }
}

// ── Main cycle ────────────────────────────────────────────────────
async function runCycle() {
  const now = new Date()
  console.log(`\n⏰ ${now.toISOString()}`)

  // Load strategy
  const strategy = await sbGet('active_strategy')
  if (!strategy?.signalBody) {
    console.log('⏳ No active strategy — click 🤖 Set Active in app')
    return
  }

  // Fetch bars
  let candles
  try {
    candles = await fetchBars(500)
    if (candles.length < 20) { console.log('Not enough bars'); return }
  } catch (e) {
    await log('error', 'Bar fetch failed', e.message); return
  }

  const currentPrice = candles[candles.length - 1].close
  await log('price', `${PRIMARY}: ${currentPrice}`)

  // Log eval status every cycle
  if (EVAL_MODE) {
    const evalStats = await getEvalStats()
    console.log(`[EVAL] Profit: $${evalStats.totalProfit.toFixed(0)}/${EVAL_PROFIT_TARGET} (${evalStats.progressPct}%) | Drawdown left: $${evalStats.drawdownLeft.toFixed(0)} | Today: ${evalStats.todayPnl >= 0 ? '+' : ''}$${evalStats.todayPnl.toFixed(0)}`)
  }

  // Update bias (recompute every hour using same bars)
  let bias = await getBias()
  if (!bias || (now.getUTCMinutes() < 6)) {
    bias = await updateBias(candles)
  }
  console.log(`[BIAS] 1H:${bias.bias1H} 4H:${bias.bias4H} → ${bias.direction.toUpperCase()} threshold:${bias.threshold}`)

  // Calculate IV walls
  const walls = calcIVWalls(candles, currentPrice)
  if (walls) {
    console.log(`[IV WALLS] HV:${walls.hv}% dailyMove:${walls.dailyMove}pts | 1σ: ${walls.lower1sigma}-${walls.upper1sigma} | 2σ: ${walls.lower2sigma}-${walls.upper2sigma} | wallBias:${walls.wallBias}`)
    // Save walls to Supabase so Vercel app can display them
    try { await sbSet('bot_log', walls, 'iv_walls') } catch {}
  }

  // Build indicators
  const ind = buildIndicators(candles)
  const li  = candles.length - 1
  console.log(`[INDICATORS] sweepLow:${ind.liquiditySweepLow[li]} | sweepHigh:${ind.liquiditySweepHigh[li]} | fvgBull:${ind.bullishFVG[li]} | fvgBear:${ind.bearishFVG[li]} | bosBull:${ind.bosBullish[li]} | bosBear:${ind.bosBearish[li]} | obBull:${ind.rejectionBlockBullish[li]} | obBear:${ind.rejectionBlockBearish[li]}`)

  // Load trades and check SL/TP
  const trades  = await getTrades()
  const openPos = getOpenPos(trades)

  if (openPos) {
    const price = currentPrice
    const pos   = openPos

    // Check stop loss
    if (pos.stopLoss !== null && pos.stopLoss !== undefined) {
      const slHit = pos.side === 'LONG'
        ? price <= pos.stopLoss
        : price >= pos.stopLoss
      if (slHit) {
        console.log(`🛑 Stop loss hit! Price:${price} SL:${pos.stopLoss}`)
        await closeTrade(trades, price, 'stopLoss')
        await log('trade', `Stop loss hit @ ${price}`, `SL was ${pos.stopLoss}`)
        return
      }
    }

    // Check take profit
    if (pos.takeProfit !== null && pos.takeProfit !== undefined) {
      const tpHit = pos.side === 'LONG'
        ? price >= pos.takeProfit
        : price <= pos.takeProfit
      if (tpHit) {
        console.log(`🎯 Take profit hit! Price:${price} TP:${pos.takeProfit}`)
        await closeTrade(trades, price, 'takeProfit')
        await log('trade', `Take profit hit @ ${price}`, `TP was ${pos.takeProfit}`)
        return
      }
    }

    // Log current P&L on open position
    const pts = openPos.side === 'LONG'
      ? price - openPos.entryPrice
      : openPos.entryPrice - price
    const unrealizedPnl = pts * MULTIPLIER * (openPos.quantity || 1)
    console.log(`[POSITION] ${openPos.side} ${openPos.quantity}x @ ${openPos.entryPrice} | Current:${price} | SL:${openPos.stopLoss} TP:${openPos.takeProfit} | Unrealized:${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(0)}`)
  }

  // Update 5: Check partial take profit at 1R
  if (openPos && !openPos.partialTaken) {
    await checkPartialTP(trades, currentPrice)
  }

  // Evaluate signal
  const signal = evalSignal(candles, ind, strategy.signalBody, openPos)
  await log('signal', `Signal: ${signal?.action || 'NONE'}`, signal?.reason || null)

  if (!signal?.action || signal.action === 'none' || signal.action === 'NONE') return

  // Handle exit signal
  if ((signal.action === 'exit' || signal.action === 'EXIT') && openPos) {
    await closeTrade(trades, currentPrice, 'signal')
    await log('trade', `Closed on EXIT signal @ ${currentPrice}`)
    return
  }

  const isBuy  = signal.action === 'buy'  || signal.action === 'LONG'
  const isSell = signal.action === 'sell' || signal.action === 'SHORT'

  if ((isBuy || isSell) && !openPos) {
    // ── Eval mode risk check ──────────────────────────────────────
    if (EVAL_MODE) {
      const evalStats = await getEvalStats()

      // Check total drawdown
      if (evalStats.totalDrawdown <= -EVAL_MAX_DRAWDOWN + 100) {
        await log('eval', `⛔ EVAL ACCOUNT BLOWN — drawdown $${evalStats.totalDrawdown.toFixed(0)} hit limit`)
        return
      }

      // Check daily loss limit
      if (evalStats.todayPnl <= -EVAL_DAILY_LIMIT) {
        await log('eval', `⛔ DAILY LIMIT HIT — lost $${Math.abs(evalStats.todayPnl).toFixed(0)} today, no more trades`)
        return
      }

      // Check if already passed
      if (evalStats.totalProfit >= EVAL_PROFIT_TARGET) {
        await log('eval', `🎉 EVAL PASSED — profit $${evalStats.totalProfit.toFixed(0)} hit target $${EVAL_PROFIT_TARGET}`)
        return  // stop trading once passed
      }

      // Reduce size if daily loss is mounting
      if (evalStats.todayPnl <= -300) {
        console.log(`[EVAL] Daily loss $${evalStats.todayPnl.toFixed(0)} — dropping to 1 contract`)
      }
    }

    // 0. IV Wall filter — don't fight the walls
    if (walls) {
      if (isBuy && walls.wallBias === 'nearUpper') {
        const level = walls.nearestResistance
        await log('filter', `⛔ BLOCKED LONG — near ${level?.label || 'resistance'} @ ${level?.price} (${walls.distToResistance}pts away)`)
        return
      }
      if (isSell && walls.wallBias === 'nearLower') {
        const level = walls.nearestSupport
        await log('filter', `⛔ BLOCKED SHORT — near ${level?.label || 'support'} @ ${level?.price} (${walls.distToSupport}pts away)`)
        return
      }
    }

    // 1. Bias filter
    if (bias.direction === 'long' && isSell) {
      await log('filter', `⛔ BLOCKED SHORT — bias bullish (1H:${bias.bias1H} 4H:${bias.bias4H})`); return
    }
    if (bias.direction === 'short' && isBuy) {
      await log('filter', `⛔ BLOCKED LONG — bias bearish (1H:${bias.bias1H} 4H:${bias.bias4H})`); return
    }

    // 2. Session threshold filter
    const sessionThreshold = getSessionThreshold(bias.threshold)

    // 3. Learning filter
    const allowed = await canTrade(signal.factors || {})
    if (!allowed) {
      await log('filter', `⛔ BLOCKED — negative expectancy in learning memory`); return
    }

    // Update 5: Calculate quality bonus score
    let qualityBonus = 0
    const qualityReasons = []

    // 15-min FVG alignment bonus
    const fvgSide = isBuy ? 'bull' : 'bear'
    if (has15minFVG(candles, fvgSide)) {
      qualityBonus += 2
      qualityReasons.push('15m FVG aligned')
    }

    // Displacement check (use last bars as proxy)
    const lastSweepIdx = candles.length - 8  // approximate sweep bar
    if (hasDisplacement(candles, lastSweepIdx)) {
      qualityBonus += 1
      qualityReasons.push('displacement confirmed')
    }

    if (qualityBonus > 0) {
      console.log(`[QUALITY] +${qualityBonus} bonus: ${qualityReasons.join(', ')}`)
    }

    // 4. Dynamic risk calculation
    const side    = isBuy ? 'LONG' : 'SHORT'
    const account = await getAccount()
    const risk    = await calcDynamicRisk(candles, side, currentPrice, signal.factors || {}, account.balance)

    // 5. Open trade
    await openTrade(trades, {
      side,
      entryPrice: currentPrice,
      contracts:  risk.contracts,
      stopLoss:   risk.stopPrice,
      takeProfit: risk.targetPrice,
    })

    await log('trade',
      `Opened ${side} ${risk.contracts}x @ ${currentPrice}`,
      `SL:${risk.stopPrice} TP:${risk.targetPrice} RR:${risk.rrRatio} winRate:${risk.winRate}% bias:${bias.direction}`
    )
  }
}

// ── Start ─────────────────────────────────────────────────────────
console.log('🤖 TradingBot — Railway 24/7')
console.log(`   Poll: every ${POLL_MS/60000}min | Bias: hourly | Risk: dynamic`)

process.on('SIGTERM', () => console.log('SIGTERM ignored — staying alive'))
process.on('SIGINT',  () => console.log('SIGINT ignored'))
process.on('uncaughtException',  e => console.error('Uncaught:', e.message))
process.on('unhandledRejection', e => console.error('Unhandled:', e?.message || e))

runCycle()
setInterval(runCycle, POLL_MS)

// Record EOD balance at midnight ET (4am UTC) to update trailing floor
setInterval(async () => {
  const now = new Date()
  if (now.getUTCHours() === 4 && now.getUTCMinutes() < 6) {
    try {
      const account = await getAccount()
      const stats   = await sbGet('bot_stats', 'main') || {}
      const evalS   = stats.eval || {}
      const currentPeak = evalS.peakEodBalance || EVAL_ACCOUNT_SIZE
      if (account.balance > currentPeak) {
        evalS.peakEodBalance = account.balance
        stats.eval = evalS
        await sbSet('bot_stats', stats, 'main')
        console.log(`[EVAL] EOD peak updated to $${account.balance.toFixed(0)} — new floor: $${(account.balance - EVAL_MAX_DRAWDOWN).toFixed(0)}`)
      }
    } catch (e) { console.error('EOD update error:', e.message) }
  }
}, 60_000)
setInterval(() => console.log('💓 heartbeat'), 30_000)

// ── IV Walls — Intraday Range + Key Levels ──────────────────────
// Option B: Intraday walls from today's open (tighter, more relevant)
// Option C: Key levels from yesterday's high/low and weekly high/low

function calcIVWalls(candles, currentPrice) {
  if (!candles.length) return null

  const now = new Date()
  const todayDate = now.toISOString().slice(0, 10)

  // ── Group bars by day ─────────────────────────────────────────
  const days = {}
  for (const bar of candles) {
    const date = new Date(bar.time).toISOString().slice(0, 10)
    if (!days[date]) days[date] = { open: bar.open, high: bar.high, low: bar.low, close: bar.close, bars: [] }
    days[date].high  = Math.max(days[date].high, bar.high)
    days[date].low   = Math.min(days[date].low,  bar.low)
    days[date].close = bar.close
    days[date].bars.push(bar)
  }

  const sortedDays = Object.entries(days).sort((a,b) => a[0].localeCompare(b[0]))
  const today      = days[todayDate]
  const yesterday  = sortedDays.length >= 2 ? sortedDays[sortedDays.length - 2][1] : null

  // ── Option B: Intraday walls from today's open ────────────────
  let intradayUpper = null, intradayLower = null
  let intradayBias  = 'neutral'

  if (today) {
    // Use average daily range from last 5 days as expected move
    const recentDays = sortedDays.slice(-6, -1)  // last 5 days excluding today
    const avgRange   = recentDays.length > 0
      ? recentDays.reduce((s, [,d]) => s + (d.high - d.low), 0) / recentDays.length
      : 200

    intradayUpper = +(today.open + avgRange).toFixed(2)
    intradayLower = +(today.open - avgRange).toFixed(2)

    // How far has price moved from open today?
    const intradayRange = intradayUpper - intradayLower
    const pctToIntradayUpper = +((intradayUpper - currentPrice) / intradayRange * 100).toFixed(1)
    const pctToIntradayLower = +((currentPrice - intradayLower) / intradayRange * 100).toFixed(1)

    if (pctToIntradayUpper < 15) intradayBias = 'nearUpper'
    if (pctToIntradayLower < 15) intradayBias = 'nearLower'
  }

  // ── Option C: Key price levels ────────────────────────────────
  const keyLevels = []

  // Yesterday's high and low — major ICT reference points
  if (yesterday) {
    keyLevels.push({ price: yesterday.high, label: 'PDH', type: 'resistance' })
    keyLevels.push({ price: yesterday.low,  label: 'PDL', type: 'support' })
  }

  // Weekly high and low (last 5 trading days)
  const weekDays = sortedDays.slice(-5)
  if (weekDays.length >= 3) {
    const weekHigh = Math.max(...weekDays.map(([,d]) => d.high))
    const weekLow  = Math.min(...weekDays.map(([,d]) => d.low))
    keyLevels.push({ price: weekHigh, label: 'PWH', type: 'resistance' })
    keyLevels.push({ price: weekLow,  label: 'PWL', type: 'support' })
  }

  // Today's open — key intraday level
  if (today) {
    keyLevels.push({ price: today.open, label: "Today's Open", type: 'pivot' })
  }

  // ── Find nearest key levels to current price ──────────────────
  const nearestResistance = keyLevels
    .filter(l => l.price > currentPrice)
    .sort((a,b) => a.price - b.price)[0]

  const nearestSupport = keyLevels
    .filter(l => l.price < currentPrice)
    .sort((a,b) => b.price - a.price)[0]

  // ── Combined wall bias ────────────────────────────────────────
  // Use intraday bias as primary, key levels as confirmation
  let wallBias = intradayBias

  // Override if price is within 30pts of a key level
  if (nearestResistance && (nearestResistance.price - currentPrice) < 30) {
    wallBias = 'nearUpper'
  }
  if (nearestSupport && (currentPrice - nearestSupport.price) < 30) {
    wallBias = 'nearLower'
  }

  const result = {
    // Intraday walls
    intradayUpper, intradayLower,
    todayOpen:  today?.open || null,
    todayHigh:  today?.high || null,
    todayLow:   today?.low  || null,

    // Key levels
    keyLevels,
    nearestResistance,
    nearestSupport,

    // Yesterday's levels
    pdh: yesterday?.high || null,
    pdl: yesterday?.low  || null,

    // Bias
    wallBias,
    intradayBias,

    // Distance to nearest levels
    distToResistance: nearestResistance ? +(nearestResistance.price - currentPrice).toFixed(2) : null,
    distToSupport:    nearestSupport    ? +(currentPrice - nearestSupport.price).toFixed(2)    : null,
  }

  console.log(`[WALLS] PDH:${result.pdh} PDL:${result.pdl} | Nearest resistance:${nearestResistance?.label}@${nearestResistance?.price} (${result.distToResistance}pts away) | Support:${nearestSupport?.label}@${nearestSupport?.price} (${result.distToSupport}pts away) | bias:${wallBias}`)

  return result
}
// PATCH: raise min sample before sizing up
// This is appended and will override the inline logic via a wrapper

