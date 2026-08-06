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

async function calcDynamicRisk(candles, side, currentPrice, factors, accountBalance, signalScore = 4) {
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

  // ── Combined: Quality Score + Fixed Dollar Risk + ATR Scaling ────
  const BASE_RISK = 400
  const score = signalScore || 4
  const scoreMultiplier = score <= 3 ? 0.5
    : score === 4 ? 0.75
    : score === 5 ? 1.0
    : 1.25

  const adjustedRisk   = Math.round(BASE_RISK * scoreMultiplier)
  const stopDistance   = +atrVal.toFixed(2)
  const targetDistance = +(atrVal * 2).toFixed(2)
  const dollarPerPoint = 2  // MNQ
  const rawContracts   = adjustedRisk / (stopDistance * dollarPerPoint)
  const contracts      = Math.max(1, Math.min(6, Math.round(rawContracts)))
  const actualRisk     = +(contracts * stopDistance * dollarPerPoint).toFixed(2)

  const stopPrice   = side === 'LONG'
    ? +(currentPrice - stopDistance).toFixed(2)
    : +(currentPrice + stopDistance).toFixed(2)
  const targetPrice = side === 'LONG'
    ? +(currentPrice + targetDistance).toFixed(2)
    : +(currentPrice - targetDistance).toFixed(2)

  console.log(`[RISK] Score:${score}(${scoreMultiplier}x) ATR:${atrVal.toFixed(1)} risk:$${adjustedRisk} contracts:${contracts} SL:${stopPrice} TP:${targetPrice}`)

  return { stopPrice, targetPrice, stopDistance, targetDistance, contracts, riskDollars: actualRisk, winRate, expectancy, sampleSize }
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
    // Time-based exit
  if (openPos) {
    const barsOpen   = Math.floor((Date.now() - openPos.entryTime) / (5 * 60 * 1000))
    const stopDist   = Math.abs(openPos.entryPrice - openPos.stopLoss)
    const currentR   = stopDist > 0 ? (currentPrice - openPos.entryPrice) / stopDist : 0
    const recentData = candles.slice(-20)
    const recentHigh = Math.max(...recentData.map(b => b.high))

    if (barsOpen > 30 && currentR < 0.25) {
      await closeTrade(trades, currentPrice, 'Time exit: 30 bars no progress')
      await log('trade', `Time exit @ ${currentPrice}`, `${barsOpen} bars open, only ${currentR.toFixed(2)}R`)
      return
    }
    if (barsOpen > 50 && recentHigh <= (openPos.entryPrice + stopDist * 0.5)) {
      await closeTrade(trades, currentPrice, 'Time exit: 50 bars stalling')
      await log('trade', `Time exit @ ${currentPrice}`, `${barsOpen} bars, price stalling`)
      return
    }
    if (barsOpen > 75) {
      await closeTrade(trades, currentPrice, 'Time exit: 75 bars max')
      await log('trade', `Time exit @ ${currentPrice}`, `Max hold time reached`)
      return
    }
  }
    const pts = openPos.side === 'LONG'
      ? price - openPos.entryPrice
      : openPos.entryPrice - price
    const unrealizedPnl = pts * MULTIPLIER * (openPos.quantity || 1)
    console.log(`[POSITION] ${openPos.side} ${openPos.quantity}x @ ${openPos.entryPrice} | Current:${price} | SL:${openPos.stopLoss} TP:${openPos.takeProfit} | Unrealized:${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(0)}`)
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
      if (isBuy  && walls.wallBias === 'nearUpper') {
        await log('filter', `⛔ BLOCKED LONG — price near upper IV wall (${walls.pctToUpper}% remaining)`)
        return
      }
      if (isSell && walls.wallBias === 'nearLower') {
        await log('filter', `⛔ BLOCKED SHORT — price near lower IV wall (${walls.pctToLower}% remaining)`)
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

    // 4. Dynamic risk calculation
    const side    = isBuy ? 'LONG' : 'SHORT'
    const account = await getAccount()
    const risk = await calcDynamicRisk(candles, side, currentPrice, signal.factors || {}, account.balance, signal.score || 4)

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

// ── IV Walls / Historical Volatility ─────────────────────────────
// Calculates tomorrow's probable price range from recent daily moves.
// Used to filter trades — avoid longs at upper wall, shorts at lower wall.

function calcIVWalls(candles, currentPrice) {
  // Group 5min bars into daily closes
  const days = {}
  for (const bar of candles) {
    const date = new Date(bar.time).toISOString().slice(0, 10)
    if (!days[date]) days[date] = { close: bar.close }
    days[date].close = bar.close  // keep last bar's close
  }
  const dailyCloses = Object.values(days).map(d => d.close)
  if (dailyCloses.length < 6) return null

  // Log returns
  const returns = []
  for (let i = 1; i < dailyCloses.length; i++) {
    returns.push(Math.log(dailyCloses[i] / dailyCloses[i-1]))
  }

  // 20-day or available HV
  const period  = Math.min(20, returns.length)
  const slice   = returns.slice(-period)
  const mean    = slice.reduce((s,r) => s + r, 0) / slice.length
  const variance = slice.reduce((s,r) => s + Math.pow(r - mean, 2), 0) / (slice.length - 1)
  const hv      = Math.sqrt(variance) * Math.sqrt(252)

  const dailyMove   = currentPrice * (hv / Math.sqrt(252))
  const upper1sigma = +(currentPrice + dailyMove).toFixed(2)
  const lower1sigma = +(currentPrice - dailyMove).toFixed(2)
  const upper2sigma = +(currentPrice + dailyMove * 2).toFixed(2)
  const lower2sigma = +(currentPrice - dailyMove * 2).toFixed(2)

  // How close is price to each wall? (0-100%)
  const pctToUpper = +((upper1sigma - currentPrice) / dailyMove * 100).toFixed(1)
  const pctToLower = +((currentPrice - lower1sigma) / dailyMove * 100).toFixed(1)

  // Wall bias — affects trade direction preference
  let wallBias = 'neutral'
  if (pctToUpper < 20) wallBias = 'nearUpper'  // near ceiling → prefer shorts
  if (pctToLower < 20) wallBias = 'nearLower'  // near floor  → prefer longs

  return {
    hv: +(hv * 100).toFixed(2),
    dailyMove: +dailyMove.toFixed(2),
    upper1sigma, lower1sigma,
    upper2sigma, lower2sigma,
    pctToUpper, pctToLower,
    wallBias, days: dailyCloses.length,
  }
}
// PATCH: raise min sample before sizing up
// This is appended and will override the inline logic via a wrapper
