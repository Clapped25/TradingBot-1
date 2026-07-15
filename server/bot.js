// ─────────────────────────────────────────────────────────────────────────────
// TradingBot Server Engine
//
// Runs 24/7 on Railway as a persistent process.
// Evaluates signal every 5 minutes, manages paper trades, saves to Supabase.
// ─────────────────────────────────────────────────────────────────────────────

import fetch from 'node-fetch'

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY
const SUPABASE_URL    = process.env.SUPABASE_URL
const SUPABASE_ANON   = process.env.SUPABASE_ANON
const PRIMARY         = 'NQ'
const SYMBOL          = 'MNQ'
const MULTIPLIER      = 2
const POLL_MS         = 5 * 60 * 1000  // 5 minutes

// ── Supabase helpers ─────────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type':  'application/json',
  'apikey':        SUPABASE_ANON,
  'Authorization': `Bearer ${SUPABASE_ANON}`,
  'Prefer':        'resolution=merge-duplicates',
}

async function sbGet(table, id = 'main') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=data`, { headers: SB_HEADERS })
  if (!res.ok) return null
  const rows = await res.json()
  return rows?.[0]?.data ?? null
}

async function sbSet(table, data, id = 'main') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: SB_HEADERS,
    body:    JSON.stringify({ id, data, updated_at: new Date().toISOString() }),
  })
  return res.ok
}

// ── Session check ─────────────────────────────────────────────────
function isMarketSession() {
  const hour = new Date().getUTCHours()
  const isNY     = hour >= 13 && hour < 21   // 9am-5pm ET
  const isLondon = hour >= 7  && hour < 12   // 3am-8am ET
  const isAsian  = hour >= 23 || hour < 4    // 7pm-12am ET
  return { isNY, isLondon, isAsian, trading: isNY || isLondon || isAsian }
}

// ── Massive API ───────────────────────────────────────────────────
const QUARTERLY = [{ month: 3 }, { month: 6 }, { month: 9 }, { month: 12 }]
const MONTH_CODES = ['F','G','H','J','K','M','N','Q','U','V','X','Z']

function getFrontMonthTicker(code) {
  const now    = new Date()
  const year   = now.getFullYear()
  const month  = now.getMonth() + 1
  const expiry = QUARTERLY.find(e => e.month >= month) || QUARTERLY[0]
  const yr     = expiry.month >= month ? year : year + 1
  const mc     = MONTH_CODES[expiry.month - 1]
  return `${code}${mc}${String(yr).slice(-1)}`
}

async function fetchRecentBars(bars = 120) {
  const ticker = getFrontMonthTicker(PRIMARY)
  const now    = new Date()
  const from   = new Date(now.getTime() - 12 * 60 * 60 * 1000)
  const url    = `https://api.massive.com/futures/v1/aggs/${ticker}` +
    `?resolution=5min` +
    `&window_start.gte=${from.toISOString().slice(0,10)}` +
    `&window_start.lte=${now.toISOString().slice(0,10)}` +
    `&limit=${bars}&sort=window_start.asc&apiKey=${MASSIVE_API_KEY}`

  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Massive bars ${res.status}`)
  const data = await res.json()
  return (data.results || []).map(b => ({
    time:  b.window_start / 1e6,
    open:  b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }))
}

async function fetchLatestPrice() {
  const bars = await fetchRecentBars(5)
  if (!bars.length) return null
  const bar = bars[bars.length - 1]
  return { price: bar.close, time: bar.time, ticker: getFrontMonthTicker(PRIMARY) }
}

// ── Paper broker ──────────────────────────────────────────────────
async function getAccount() {
  return await sbGet('paper_account') || {
    startingBalance: 25000, balance: 25000,
    realizedPnl: 0, totalTrades: 0, wins: 0, losses: 0,
  }
}

async function getTrades() {
  return await sbGet('paper_trades') || []
}

function getOpenPosition(trades) {
  return trades.find(t => !t.exitTime) || null
}

async function openTrade(trades, { side, entryPrice, stopLoss, takeProfit, signal }) {
  const trade = {
    id: Date.now(), symbol: SYMBOL, side, entryPrice,
    quantity: 1, stopLoss: stopLoss || null, takeProfit: takeProfit || null,
    signal: signal || null, entryTime: Date.now(),
    exitTime: null, exitPrice: null, exitReason: null,
    pnlDollars: null, multiplier: MULTIPLIER,
  }
  trades.push(trade)
  await sbSet('paper_trades', trades)
  console.log(`📈 Opened ${side} @ ${entryPrice}`)
  return trade
}

async function closeTrade(trades, exitPrice, exitReason = 'signal') {
  const idx = trades.findIndex(t => !t.exitTime)
  if (idx === -1) return null
  const trade      = trades[idx]
  const pnlPoints  = trade.side === 'LONG' ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice
  const pnlDollars = pnlPoints * MULTIPLIER * trade.quantity
  trades[idx]      = { ...trade, exitTime: Date.now(), exitPrice, exitReason, pnlDollars }
  await sbSet('paper_trades', trades)
  const account        = await getAccount()
  account.balance     += pnlDollars
  account.realizedPnl += pnlDollars
  account.totalTrades++
  if (pnlDollars > 0) account.wins++
  else account.losses++
  await sbSet('paper_account', account)
  console.log(`📉 Closed ${trade.side} @ ${exitPrice} — P&L: ${pnlDollars >= 0 ? '+' : ''}$${pnlDollars.toFixed(0)}`)
  return trades[idx]
}

// ── Indicators ────────────────────────────────────────────────────
function buildSimpleIndicators(candles) {
  const closes = candles.map(c => c.close)

  function ema(arr, period) {
    const result = new Array(arr.length).fill(null)
    const k = 2 / (period + 1)
    let val = arr[period - 1]
    result[period - 1] = val
    for (let i = period; i < arr.length; i++) {
      val = arr[i] * k + val * (1 - k)
      result[i] = val
    }
    return result
  }

  function rsi(arr, period = 14) {
    const result = new Array(arr.length).fill(null)
    let gains = 0, losses = 0
    for (let i = 1; i <= period; i++) {
      const diff = arr[i] - arr[i - 1]
      if (diff > 0) gains += diff; else losses -= diff
    }
    let avgGain = gains / period, avgLoss = losses / period
    result[period] = 100 - (100 / (1 + avgGain / (avgLoss || 0.001)))
    for (let i = period + 1; i < arr.length; i++) {
      const diff = arr[i] - arr[i - 1]
      avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
      result[i] = 100 - (100 / (1 + avgGain / (avgLoss || 0.001)))
    }
    return result
  }

  // SMC indicators
  const n = candles.length
  const swingHigh = new Array(n).fill(false)
  const swingLow  = new Array(n).fill(false)
  for (let i = 2; i < n - 2; i++) {
    if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high)
      swingHigh[i] = true
    if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
        candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low)
      swingLow[i] = true
  }

  const liquiditySweepLow  = new Array(n).fill(false)
  const liquiditySweepHigh = new Array(n).fill(false)
  for (let i = 5; i < n; i++) {
    for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
      if (swingLow[j]  && candles[i].low  < candles[j].low  && candles[i].close > candles[j].low)
        liquiditySweepLow[i]  = true
      if (swingHigh[j] && candles[i].high > candles[j].high && candles[i].close < candles[j].high)
        liquiditySweepHigh[i] = true
    }
  }

  const bosBullish = new Array(n).fill(false)
  const bosBearish = new Array(n).fill(false)
  let lastSwingHigh = null, lastSwingLow = null
  for (let i = 0; i < n; i++) {
    if (swingHigh[i]) lastSwingHigh = candles[i].high
    if (swingLow[i])  lastSwingLow  = candles[i].low
    if (lastSwingHigh && candles[i].close > lastSwingHigh) { bosBullish[i] = true; lastSwingHigh = null }
    if (lastSwingLow  && candles[i].close < lastSwingLow)  { bosBearish[i] = true; lastSwingLow  = null }
  }

  const bullishFVG = new Array(n).fill(false)
  const bearishFVG = new Array(n).fill(false)
  for (let i = 2; i < n; i++) {
    if (candles[i].low > candles[i-2].high) bullishFVG[i] = true
    if (candles[i].high < candles[i-2].low) bearishFVG[i] = true
  }

  const rejectionBlockBullish = new Array(n).fill(false)
  const rejectionBlockBearish = new Array(n).fill(false)
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i-1]
    if (p.close < p.open && c.close > p.open) rejectionBlockBullish[i] = true
    if (p.close > p.open && c.close < p.open) rejectionBlockBearish[i] = true
  }

  return {
    ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    swingHigh, swingLow,
    liquiditySweepLow, liquiditySweepHigh,
    bosBullish, bosBearish,
    bullishFVG, bearishFVG,
    bullishIFVG: bearishFVG, bearishIFVG: bullishFVG,
    rejectionBlockBullish, rejectionBlockBearish,
    cisdBullish: bosBullish, cisdBearish: bosBearish,
    smtBullish: new Array(n).fill(false), smtBearish: new Array(n).fill(false),
  }
}

// ── Signal evaluation ─────────────────────────────────────────────
function evaluateSignal(candles, indicators, signalBody, openPos) {
  try {
    const fn  = new Function('i', 'candles', 'ind', 'pos', signalBody)
    const i   = candles.length - 1
    const pos = openPos
      ? { isOpen: true, side: openPos.side }
      : { isOpen: false, side: 'FLAT' }
    return fn(i, candles, indicators, pos)
  } catch (e) {
    console.error('Signal error:', e.message)
    return null
  }
}

// ── Learning filter ───────────────────────────────────────────────
async function shouldTakeTrade(factors) {
  try {
    const memory = await sbGet('learning_memory') || { trades: [] }
    if (!memory.trades?.length) return { take: true, sizeFactor: 1 }
    const comboKey = Object.entries(factors || {})
      .filter(([, v]) => v === true).map(([k]) => k).sort().join(' + ')
    if (!comboKey) return { take: true, sizeFactor: 1 }
    const matching = memory.trades.filter(t => {
      const key = Object.entries(t.factors || {})
        .filter(([, v]) => v === true).map(([k]) => k).sort().join(' + ')
      return key === comboKey
    })
    if (matching.length < 8) return { take: true, sizeFactor: 1, sampleSize: matching.length }
    const expectancy = matching.reduce((s, t) => s + (t.rMultiple || 0), 0) / matching.length
    return {
      take:       expectancy > 0,
      sizeFactor: Math.max(0.5, Math.min(1.5, 1 + expectancy * 0.5)),
      expectancy: +expectancy.toFixed(3),
      sampleSize: matching.length,
    }
  } catch {
    return { take: true, sizeFactor: 1 }
  }
}

// ── Activity log ──────────────────────────────────────────────────
async function logActivity(type, message, detail = null) {
  const entry = { type, message, detail, time: new Date().toISOString() }
  console.log(`[${type.toUpperCase()}] ${message}${detail ? ` — ${detail}` : ''}`)
  try {
    const log = await sbGet('bot_log') || []
    log.unshift(entry)
    await sbSet('bot_log', log.slice(0, 200))
  } catch {}
}

// ── Main run cycle ────────────────────────────────────────────────
async function runCycle() {
  console.log(`\n⏰ ${new Date().toISOString()}`)

  // Session filter disabled — running 24/7 for testing
  const session = isMarketSession()
  const sessionName = session.isNY ? 'newyork' : session.isLondon ? 'london' : session.isAsian ? 'asian' : 'offhours'
  console.log(`✓ Running 24/7 mode — session: ${sessionName}`)

  // Load strategy
  const strategy = await sbGet('active_strategy')
  if (!strategy?.signalBody) {
    console.log('No active strategy — click 🤖 Set Active in the app')
    return
  }

  // Fetch price
  let priceData
  try {
    priceData = await fetchLatestPrice()
    if (!priceData) { console.log('No price data'); return }
    await logActivity('price', `${PRIMARY}: ${priceData.price.toFixed(2)}`, priceData.ticker)
  } catch (e) {
    await logActivity('error', 'Price fetch failed', e.message)
    return
  }

  const currentPrice = priceData.price
  const trades       = await getTrades()
  const openPos      = getOpenPosition(trades)

  // Check SL/TP
  if (openPos) {
    if (openPos.stopLoss) {
      const hit = openPos.side === 'LONG' ? currentPrice <= openPos.stopLoss : currentPrice >= openPos.stopLoss
      if (hit) {
        await closeTrade(trades, currentPrice, 'stopLoss')
        await logActivity('trade', `Stop loss hit @ ${currentPrice}`)
        return
      }
    }
    if (openPos.takeProfit) {
      const hit = openPos.side === 'LONG' ? currentPrice >= openPos.takeProfit : currentPrice <= openPos.takeProfit
      if (hit) {
        await closeTrade(trades, currentPrice, 'takeProfit')
        await logActivity('trade', `Take profit hit @ ${currentPrice}`)
        return
      }
    }
  }

  // Fetch bars and evaluate signal
  let candles
  try {
    candles = await fetchRecentBars(120)
    if (candles.length < 20) { console.log('Not enough bars'); return }
  } catch (e) {
    await logActivity('error', 'Bar fetch failed', e.message)
    return
  }

  const indicators = buildSimpleIndicators(candles)
  const signal     = evaluateSignal(candles, indicators, strategy.signalBody, openPos)

  await logActivity('signal', `Signal: ${signal?.action || 'NONE'}`, signal?.reason || null)

  if (!signal?.action || signal.action === 'none' || signal.action === 'NONE') return

  // Exit signal
  if ((signal.action === 'exit' || signal.action === 'EXIT') && openPos) {
    await closeTrade(trades, currentPrice, 'signal')
    await logActivity('trade', `Closed ${openPos.side} on EXIT signal @ ${currentPrice}`)
    return
  }

  // Entry signal
  if (!openPos && (signal.action === 'buy' || signal.action === 'LONG')) {
    const decision = await shouldTakeTrade(signal.factors || {})
    if (!decision.take && decision.sampleSize >= 8) {
      await logActivity('filter', `⛔ BLOCKED LONG`, `Expectancy ${decision.expectancy}R`)
      return
    }
    const atr        = candles.slice(-14).reduce((s, c, i, a) => {
      if (i === 0) return s
      return s + Math.max(c.high - c.low, Math.abs(c.high - a[i-1].close), Math.abs(c.low - a[i-1].close))
    }, 0) / 13
    const stopLoss   = currentPrice - atr * 1.5
    const takeProfit = currentPrice + atr * 1.5 * 2
    await openTrade(trades, { side: 'LONG', entryPrice: currentPrice, stopLoss, takeProfit, signal: 'LONG' })
    await logActivity('trade', `Opened LONG @ ${currentPrice}`, `SL: ${stopLoss.toFixed(2)} TP: ${takeProfit.toFixed(2)}`)
  }

  if (!openPos && (signal.action === 'sell' || signal.action === 'SHORT')) {
    const decision = await shouldTakeTrade(signal.factors || {})
    if (!decision.take && decision.sampleSize >= 8) {
      await logActivity('filter', `⛔ BLOCKED SHORT`, `Expectancy ${decision.expectancy}R`)
      return
    }
    const atr        = candles.slice(-14).reduce((s, c, i, a) => {
      if (i === 0) return s
      return s + Math.max(c.high - c.low, Math.abs(c.high - a[i-1].close), Math.abs(c.low - a[i-1].close))
    }, 0) / 13
    const stopLoss   = currentPrice + atr * 1.5
    const takeProfit = currentPrice - atr * 1.5 * 2
    await openTrade(trades, { side: 'SHORT', entryPrice: currentPrice, stopLoss, takeProfit, signal: 'SHORT' })
    await logActivity('trade', `Opened SHORT @ ${currentPrice}`, `SL: ${stopLoss.toFixed(2)} TP: ${takeProfit.toFixed(2)}`)
  }
}

// ── Persistent loop ───────────────────────────────────────────────
console.log('🤖 TradingBot starting — persistent mode (Railway)')
console.log(`   Polling every ${POLL_MS / 60000} minutes`)
console.log(`   Sessions: NY (9am-5pm ET), London (3am-8am ET), Asian (7pm-12am ET)\n`)

// Run immediately then every 5 minutes
runCycle()
setInterval(runCycle, POLL_MS)

// Keep process alive
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...')
  process.exit(0)
})
