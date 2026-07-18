import fetch from 'node-fetch'
import http from 'http'

// Health check server so Railway knows process is alive
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  res.writeHead(200)
  res.end('TradingBot running')
}).listen(PORT, () => console.log(`Health check on port ${PORT}`))

const MASSIVE_API_KEY = (process.env.MASSIVE_API_KEY || '').trim()
const SUPABASE_URL    = 'https://dxnxtthvupbfydttqcpk.supabase.co'
const SUPABASE_ANON   = (process.env.SUPABASE_ANON || '').trim().replace(/[\r\n\t]/g, '')
const PRIMARY         = 'NQ'
const SYMBOL          = 'MNQ'
const MULTIPLIER      = 2
const POLL_MS         = 5 * 60 * 1000

// ── Supabase ─────────────────────────────────────────────────────
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
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: SB_HEADERS,
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() }),
  })
}

// ── Massive ───────────────────────────────────────────────────────
const MONTH_CODES = ['F','G','H','J','K','M','N','Q','U','V','X','Z']

function getFrontMonthTicker(code) {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth() + 1
  const quarters = [3,6,9,12]
  const qm = quarters.find(q => q >= m) || quarters[0]
  const yr = qm >= m ? y : y + 1
  return `${code}${MONTH_CODES[qm-1]}${String(yr).slice(-1)}`
}

async function fetchRecentBars(limit = 120) {
  const ticker = getFrontMonthTicker(PRIMARY)
  const now    = new Date()
  const from   = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
  const gte    = from.toISOString().slice(0, 10)
  const lte    = now.toISOString().slice(0, 10)
  console.log(`Fetching ${ticker} bars ${gte} → ${lte}`)

  const url = `https://api.massive.com/futures/v1/aggs/${ticker}` +
    `?resolution=5min&window_start.gte=${gte}&window_start.lte=${lte}` +
    `&limit=${limit}&sort=window_start.asc&apiKey=${MASSIVE_API_KEY}` +
    `&_t=${Date.now()}`  // cache bust

  const res = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
  })
  if (!res.ok) throw new Error(`Massive ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const bars = (data.results || []).map(b => ({
    time: b.window_start / 1e6, open: b.open, high: b.high, low: b.low, close: b.close,
  }))
  if (bars.length > 0) {
    const last = bars[bars.length - 1]
    console.log(`Got ${bars.length} bars. Last: ${new Date(last.time).toISOString()} close:${last.close}`)
  }
  return bars
}

// ── Paper broker ──────────────────────────────────────────────────
async function getTrades()     { return await sbGet('paper_trades')  || [] }
async function getAccount()    { return await sbGet('paper_account') || { startingBalance:25000, balance:25000, realizedPnl:0, totalTrades:0, wins:0, losses:0 } }
function getOpenPos(trades)    { return trades.find(t => !t.exitTime) || null }

async function openTrade(trades, side, price, sl, tp) {
  trades.push({ id: Date.now(), symbol: SYMBOL, side, entryPrice: price, quantity: 1,
    stopLoss: sl, takeProfit: tp, entryTime: Date.now(), exitTime: null,
    exitPrice: null, exitReason: null, pnlDollars: null, multiplier: MULTIPLIER })
  await sbSet('paper_trades', trades)
  console.log(`📈 Opened ${side} @ ${price} SL:${sl?.toFixed(2)} TP:${tp?.toFixed(2)}`)
}

async function closeTrade(trades, price, reason) {
  const idx = trades.findIndex(t => !t.exitTime)
  if (idx === -1) return
  const t = trades[idx]
  const pnl = ((t.side === 'LONG' ? price - t.entryPrice : t.entryPrice - price) * MULTIPLIER)
  trades[idx] = { ...t, exitTime: Date.now(), exitPrice: price, exitReason: reason, pnlDollars: pnl }
  await sbSet('paper_trades', trades)
  const acc = await getAccount()
  acc.balance += pnl; acc.realizedPnl += pnl; acc.totalTrades++
  if (pnl > 0) acc.wins++; else acc.losses++
  await sbSet('paper_account', acc)
  console.log(`📉 Closed ${t.side} @ ${price} P&L:${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (${reason})`)
}

// ── Indicators ────────────────────────────────────────────────────
function buildIndicators(candles) {
  const n = candles.length
  const swH = new Array(n).fill(false)
  const swL = new Array(n).fill(false)

  for (let i = 3; i < n - 3; i++) {
    if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
        candles[i].high > candles[i-3].high && candles[i].high > candles[i+1].high &&
        candles[i].high > candles[i+2].high && candles[i].high > candles[i+3].high)
      swH[i] = true
    if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
        candles[i].low < candles[i-3].low && candles[i].low < candles[i+1].low &&
        candles[i].low < candles[i+2].low && candles[i].low < candles[i+3].low)
      swL[i] = true
  }

  const sweepLow  = new Array(n).fill(false)
  const sweepHigh = new Array(n).fill(false)
  for (let i = 6; i < n; i++) {
    for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
      if (swL[j] && candles[i].low < candles[j].low && candles[i].close > candles[j].low)
        sweepLow[i] = true
      if (swH[j] && candles[i].high > candles[j].high && candles[i].close < candles[j].high)
        sweepHigh[i] = true
    }
  }

  const bosBull = new Array(n).fill(false)
  const bosBear = new Array(n).fill(false)
  let lastSH = null, lastSL = null
  for (let i = 0; i < n; i++) {
    if (swH[i]) lastSH = candles[i].high
    if (swL[i]) lastSL = candles[i].low
    if (lastSH && candles[i].close > lastSH) { bosBull[i] = true; lastSH = null }
    if (lastSL && candles[i].close < lastSL) { bosBear[i] = true; lastSL = null }
  }

  const fvgBull = new Array(n).fill(false)
  const fvgBear = new Array(n).fill(false)
  for (let i = 2; i < n; i++) {
    if (candles[i].low  > candles[i-2].high) fvgBull[i] = true
    if (candles[i].high < candles[i-2].low)  fvgBear[i] = true
  }

  const obBull = new Array(n).fill(false)
  const obBear = new Array(n).fill(false)
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i-1]
    if (p.close < p.open && c.close > p.open) obBull[i] = true
    if (p.close > p.open && c.close < p.open) obBear[i] = true
  }

  return {
    liquiditySweepLow:        sweepLow,
    liquiditySweepHigh:       sweepHigh,
    bosBullish:               bosBull,
    bosBearish:               bosBear,
    bullishFVG:               fvgBull,
    bearishFVG:               fvgBear,
    bullishIFVG:              fvgBear,  // inverse
    bearishIFVG:              fvgBull,
    rejectionBlockBullish:    obBull,
    rejectionBlockBearish:    obBear,
    cisdBullish:              bosBull,
    cisdBearish:              bosBear,
    smtBullish:               new Array(n).fill(false),
    smtBearish:               new Array(n).fill(false),
    swingHigh:                swH,
    swingLow:                 swL,
  }
}

// ── Signal ────────────────────────────────────────────────────────
function evalSignal(candles, ind, signalBody, openPos) {
  try {
    const fn  = new Function('i', 'candles', 'ind', 'pos', signalBody)
    const pos = openPos ? { isOpen: true, side: openPos.side } : { isOpen: false, side: 'FLAT' }
    return fn(candles.length - 1, candles, ind, pos)
  } catch (e) {
    console.error('Signal error:', e.message)
    return null
  }
}

// ── Learning filter ───────────────────────────────────────────────
async function canTrade(factors) {
  try {
    const mem = await sbGet('learning_memory') || { trades: [] }
    if (!mem.trades?.length) return true
    const key = Object.entries(factors || {}).filter(([,v]) => v === true).map(([k]) => k).sort().join('+')
    if (!key) return true
    const matching = mem.trades.filter(t => {
      const tk = Object.entries(t.factors || {}).filter(([,v]) => v === true).map(([k]) => k).sort().join('+')
      return tk === key
    })
    if (matching.length < 8) return true
    const exp = matching.reduce((s,t) => s + (t.rMultiple || 0), 0) / matching.length
    console.log(`Filter: ${key} exp:${exp.toFixed(3)} n:${matching.length}`)
    return exp > 0
  } catch { return true }
}

// ── Log ───────────────────────────────────────────────────────────
async function log(type, msg, detail = null) {
  console.log(`[${type.toUpperCase()}] ${msg}${detail ? ' — ' + detail : ''}`)
  try {
    const existing = await sbGet('bot_log') || []
    existing.unshift({ type, message: msg, detail, time: new Date().toISOString() })
    await sbSet('bot_log', existing.slice(0, 200))
  } catch {}
}

// ── ATR helper ────────────────────────────────────────────────────
function atr(candles, period = 14) {
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

// ── Main cycle ────────────────────────────────────────────────────
async function runCycle() {
  console.log(`\n⏰ ${new Date().toISOString()}`)

  const strategy = await sbGet('active_strategy')
  if (!strategy?.signalBody) {
    console.log('⏳ No active strategy — click 🤖 Set Active in app')
    return
  }

  // Fetch bars
  let candles
  try {
    candles = await fetchRecentBars(120)
    if (candles.length < 20) { console.log('Not enough bars'); return }
  } catch (e) {
    await log('error', 'Bar fetch failed', e.message)
    return
  }

  const currentPrice = candles[candles.length - 1].close
  await log('price', `${PRIMARY}: ${currentPrice}`)

  // Build indicators and log what we see
  const ind = buildIndicators(candles)
  const li  = candles.length - 1
  const indLog = [
    `sweepLow:${ind.liquiditySweepLow[li]}`,
    `sweepHigh:${ind.liquiditySweepHigh[li]}`,
    `fvgBull:${ind.bullishFVG[li]}`,
    `fvgBear:${ind.bearishFVG[li]}`,
    `bosBull:${ind.bosBullish[li]}`,
    `bosBear:${ind.bosBearish[li]}`,
    `obBull:${ind.rejectionBlockBullish[li]}`,
    `obBear:${ind.rejectionBlockBearish[li]}`,
  ].join(' | ')
  console.log(`[INDICATORS] ${indLog}`)

  // Check trades and SL/TP
  const trades = await getTrades()
  const openPos = getOpenPos(trades)

  if (openPos) {
    if (openPos.stopLoss) {
      const hit = openPos.side === 'LONG' ? currentPrice <= openPos.stopLoss : currentPrice >= openPos.stopLoss
      if (hit) { await closeTrade(trades, currentPrice, 'stopLoss'); return }
    }
    if (openPos.takeProfit) {
      const hit = openPos.side === 'LONG' ? currentPrice >= openPos.takeProfit : currentPrice <= openPos.takeProfit
      if (hit) { await closeTrade(trades, currentPrice, 'takeProfit'); return }
    }
  }

  // Evaluate signal
  const signal = evalSignal(candles, ind, strategy.signalBody, openPos)
  await log('signal', `Signal: ${signal?.action || 'NONE'}`, signal?.reason || null)

  if (!signal?.action || signal.action === 'none' || signal.action === 'NONE') return

  if ((signal.action === 'exit' || signal.action === 'EXIT') && openPos) {
    await closeTrade(trades, currentPrice, 'signal'); return
  }

  const isBuy  = signal.action === 'buy'  || signal.action === 'LONG'
  const isSell = signal.action === 'sell' || signal.action === 'SHORT'

  if ((isBuy || isSell) && !openPos) {
    const allowed = await canTrade(signal.factors || {})
    if (!allowed) { await log('filter', `⛔ BLOCKED ${signal.action}`); return }

    const a    = atr(candles)
    const sl   = isBuy  ? currentPrice - a * 1.5 : currentPrice + a * 1.5
    const tp   = isBuy  ? currentPrice + a * 3.0 : currentPrice - a * 3.0
    const side = isBuy  ? 'LONG' : 'SHORT'
    await openTrade(trades, side, currentPrice, sl, tp)
    await log('trade', `Opened ${side} @ ${currentPrice}`, `SL:${sl.toFixed(2)} TP:${tp.toFixed(2)}`)
  }
}

// ── Start ─────────────────────────────────────────────────────────
console.log('🤖 TradingBot — Railway persistent mode')
console.log(`   Polling every ${POLL_MS/60000} minutes | 24/7 no session filter`)

process.on('SIGTERM', () => console.log('SIGTERM ignored'))
process.on('SIGINT',  () => console.log('SIGINT ignored'))
process.on('uncaughtException',  e => console.error('Uncaught:', e.message))
process.on('unhandledRejection', e => console.error('Unhandled:', e?.message || e))

runCycle()
setInterval(runCycle, POLL_MS)
setInterval(() => console.log('💓 heartbeat'), 30_000)
