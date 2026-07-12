// ─────────────────────────────────────────────────────────────────────────────
// TradingBot Server Engine
//
// Runs every 5 minutes via GitHub Actions during market hours.
// Reads strategy from Supabase, fetches live price from Massive,
// evaluates signal, manages paper trades, saves everything back to Supabase.
//
// When moving to Railway: this same file runs as a persistent process
// with a setInterval instead of being triggered by GitHub Actions.
// ─────────────────────────────────────────────────────────────────────────────

import fetch from 'node-fetch'

const MASSIVE_API_KEY   = process.env.MASSIVE_API_KEY
const SUPABASE_URL      = process.env.SUPABASE_URL
const SUPABASE_ANON     = process.env.SUPABASE_ANON
const PRIMARY           = 'NQ'
const SYMBOL            = 'MNQ'
const MULTIPLIER        = 2  // MNQ = $2 per point

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

// ── Massive API helpers ──────────────────────────────────────────
const QUARTERLY = [
  { month: 3 }, { month: 6 }, { month: 9 }, { month: 12 }
]

function getFrontMonthTicker(code) {
  const now   = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1
  const codes = ['F','G','H','J','K','M','N','Q','U','V','X','Z']
  const expiry = QUARTERLY.find(e => e.month >= month) || QUARTERLY[0]
  const yr     = expiry.month >= month ? year : year + 1
  const mc     = codes[(expiry.month - 1)]
  return `${code}${mc}${String(yr).slice(-1)}`
}

async function fetchLatestPrice() {
  const ticker = getFrontMonthTicker(PRIMARY)
  const today  = new Date().toISOString().slice(0, 10)
  const url    = `https://api.massive.com/futures/v1/aggs/${ticker}` +
    `?resolution=1min&window_start.gte=${today}&window_start.lte=${today}&limit=1&sort=window_start.desc&apiKey=${MASSIVE_API_KEY}`

  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Massive ${res.status}`)
  const data = await res.json()
  const bar  = (data.results || [])[0]
  if (!bar) return null
  return { price: bar.close, high: bar.high, low: bar.low, time: bar.window_start / 1e6 }
}

async function fetchRecentBars(bars = 120) {
  const ticker = getFrontMonthTicker(PRIMARY)
  const now    = new Date()
  const from   = new Date(now.getTime() - 12 * 60 * 60 * 1000)  // last 12 hours
  const url    = `https://api.massive.com/futures/v1/aggs/${ticker}` +
    `?resolution=5min&window_start.gte=${from.toISOString().slice(0,10)}&window_start.lte=${now.toISOString().slice(0,10)}&limit=${bars}&sort=window_start.asc&apiKey=${MASSIVE_API_KEY}`

  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Massive bars ${res.status}`)
  const data = await res.json()
  return (data.results || []).map(b => ({
    time:  b.window_start / 1e6,
    open:  b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }))
}

// ── Paper broker (server-side, reads/writes Supabase) ────────────
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
    id:         Date.now(),
    symbol:     SYMBOL,
    side,
    entryPrice,
    quantity:   1,
    stopLoss:   stopLoss   || null,
    takeProfit: takeProfit || null,
    signal:     signal     || null,
    entryTime:  Date.now(),
    exitTime:   null,
    exitPrice:  null,
    exitReason: null,
    pnlDollars: null,
    multiplier: MULTIPLIER,
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
  const pnlPoints  = trade.side === 'LONG'
    ? exitPrice - trade.entryPrice
    : trade.entryPrice - exitPrice
  const pnlDollars = pnlPoints * MULTIPLIER * trade.quantity

  trades[idx] = { ...trade, exitTime: Date.now(), exitPrice, exitReason, pnlDollars }
  await sbSet('paper_trades', trades)

  const account = await getAccount()
  account.balance     += pnlDollars
  account.realizedPnl += pnlDollars
  account.totalTrades++
  if (pnlDollars > 0) account.wins++
  else account.losses++
  await sbSet('paper_account', account)

  console.log(`📉 Closed ${trade.side} @ ${exitPrice} — P&L: ${pnlDollars >= 0 ? '+' : ''}$${pnlDollars.toFixed(0)}`)
  return trades[idx]
}

// ── Signal evaluation ────────────────────────────────────────────
function buildSimpleIndicators(candles) {
  // Basic indicators the signal function can use
  const closes = candles.map(c => c.close)
  const highs  = candles.map(c => c.high)
  const lows   = candles.map(c => c.low)

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
      if (diff > 0) gains += diff
      else losses -= diff
    }
    let avgGain = gains / period
    let avgLoss = losses / period
    result[period] = 100 - (100 / (1 + avgGain / (avgLoss || 0.001)))
    for (let i = period + 1; i < arr.length; i++) {
      const diff = arr[i] - arr[i - 1]
      avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
      result[i] = 100 - (100 / (1 + avgGain / (avgLoss || 0.001)))
    }
    return result
  }

  return {
    ema20:  ema(closes, 20),
    ema50:  ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14:  rsi(closes, 14),
    highs,
    lows,
    closes,
  }
}

function evaluateSignal(candles, indicators, signalBody) {
  try {
    const fn = new Function('i', 'candles', 'ind', 'pos', signalBody)
    const i  = candles.length - 1
    return fn(i, candles, indicators, { isOpen: false, side: 'FLAT' })
  } catch (e) {
    console.error('Signal error:', e.message)
    return null
  }
}

// ── Learning system filter ───────────────────────────────────────
async function shouldTakeTrade(factors) {
  try {
    const memory = await sbGet('learning_memory') || { trades: [] }
    if (!memory.trades?.length) return { take: true, sizeFactor: 1 }

    const comboKey = Object.entries(factors || {})
      .filter(([, v]) => v === true)
      .map(([k]) => k).sort().join(' + ')

    if (!comboKey) return { take: true, sizeFactor: 1 }

    const matching = memory.trades.filter(t => {
      const key = Object.entries(t.factors || {})
        .filter(([, v]) => v === true)
        .map(([k]) => k).sort().join(' + ')
      return key === comboKey
    })

    if (matching.length < 8) return { take: true, sizeFactor: 1, sampleSize: matching.length }

    const wins = matching.filter(t => t.win).length
    const expectancy = matching.reduce((s, t) => s + (t.rMultiple || 0), 0) / matching.length

    return {
      take:       expectancy > 0,
      sizeFactor: Math.max(0.5, Math.min(1.5, 1 + expectancy * 0.5)),
      expectancy: +expectancy.toFixed(3),
      sampleSize: matching.length,
      winRate:    +((wins / matching.length) * 100).toFixed(1),
    }
  } catch {
    return { take: true, sizeFactor: 1 }
  }
}

// ── Bot log (saved to Supabase so you can see it in the app) ─────
async function logActivity(type, message, detail = null) {
  console.log(`[${type.toUpperCase()}] ${message}${detail ? ` — ${detail}` : ''}`)
  try {
    const log = await sbGet('bot_log') || []
    log.unshift({ type, message, detail, time: new Date().toISOString() })
    await sbSet('bot_log', log.slice(0, 100))  // keep last 100 entries
  } catch {}
}

// ── Main run function ────────────────────────────────────────────
async function run() {
  console.log(`\n🤖 TradingBot starting — ${new Date().toISOString()}`)

  // Load active strategy from Supabase
  const strategies = await sbGet('active_strategy')
  if (!strategies?.signalBody) {
    console.log('No active strategy set — skipping')
    await logActivity('info', 'No active strategy configured', 'Set one from the app')
    return
  }

  const strategy = strategies

  // Fetch live price
  let priceData
  try {
    priceData = await fetchLatestPrice()
    if (!priceData) {
      console.log('No price data — market may be closed')
      await logActivity('price', 'No price data', 'Market may be closed')
      return
    }
    await logActivity('price', `${PRIMARY}: ${priceData.price.toFixed(2)}`)
  } catch (e) {
    console.error('Price fetch failed:', e.message)
    await logActivity('error', 'Price fetch failed', e.message)
    return
  }

  const currentPrice = priceData.price

  // Load trades and check SL/TP
  const trades  = await getTrades()
  const openPos = getOpenPosition(trades)

  if (openPos) {
    // Check stop loss
    if (openPos.stopLoss) {
      const hitStop = openPos.side === 'LONG'
        ? currentPrice <= openPos.stopLoss
        : currentPrice >= openPos.stopLoss
      if (hitStop) {
        await closeTrade(trades, currentPrice, 'stopLoss')
        await logActivity('trade', `Stop loss hit @ ${currentPrice}`)
        return
      }
    }
    // Check take profit
    if (openPos.takeProfit) {
      const hitTp = openPos.side === 'LONG'
        ? currentPrice >= openPos.takeProfit
        : currentPrice <= openPos.takeProfit
      if (hitTp) {
        await closeTrade(trades, currentPrice, 'takeProfit')
        await logActivity('trade', `Take profit hit @ ${currentPrice}`)
        return
      }
    }
  }

  // Fetch recent bars for signal evaluation
  let candles
  try {
    candles = await fetchRecentBars(120)
    if (candles.length < 20) {
      await logActivity('info', 'Not enough bars for signal evaluation')
      return
    }
  } catch (e) {
    await logActivity('error', 'Bar fetch failed', e.message)
    return
  }

  // Build indicators and evaluate signal
  const indicators = buildSimpleIndicators(candles)
  const signal     = evaluateSignal(candles, indicators, strategy.signalBody)

  await logActivity('signal', `Signal: ${signal?.action || 'NONE'}`, signal?.reason || null)

  if (!signal?.action || signal.action === 'NONE') return

  // Handle EXIT signal
  if (signal.action === 'EXIT' && openPos) {
    await closeTrade(trades, currentPrice, 'signal')
    await logActivity('trade', `Closed ${openPos.side} on EXIT signal @ ${currentPrice}`)
    return
  }

  // Check learning filter before opening
  if (!openPos && (signal.action === 'LONG' || signal.action === 'SHORT')) {
    const decision = await shouldTakeTrade(signal.factors || {})

    if (!decision.take && decision.sampleSize >= 8) {
      await logActivity('filter', `⛔ BLOCKED ${signal.action}`,
        `Expectancy ${decision.expectancy}R over ${decision.sampleSize} backtests`)
      return
    }

    await openTrade(trades, {
      side:       signal.action,
      entryPrice: currentPrice,
      stopLoss:   signal.stopPrice || null,
      takeProfit: signal.targetPrice || null,
      signal:     signal.action,
    })

    await logActivity('trade', `Opened ${signal.action} @ ${currentPrice}`,
      decision.sampleSize >= 8
        ? `${decision.sizeFactor}x size — ${decision.expectancy}R expectancy`
        : 'No filter data yet')
  }

  console.log('✓ Bot run complete')
}

// Run and exit
run().catch(e => {
  console.error('Bot error:', e)
  process.exit(1)
})
