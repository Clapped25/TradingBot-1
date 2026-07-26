import fetch from 'node-fetch'
import http from 'http'

// Health check server
const PORT = process.env.PORT || 3000
http.createServer((req, res) => { res.writeHead(200); res.end('TradingBot running') })
  .listen(PORT, () => console.log(`Health check on port ${PORT}`))

const MASSIVE_API_KEY = (process.env.MASSIVE_API_KEY || '').trim()
const SUPABASE_URL    = 'https://dxnxtthvupbfydttqcpk.supabase.co'
const SUPABASE_ANON   = (process.env.SUPABASE_ANON || '').trim().replace(/[\r\n\t]/g, '')
const PRIMARY         = 'NQ'
const SYMBOL          = 'MNQ'
const MULTIPLIER      = 2
const POLL_MS         = 5 * 60 * 1000

// ── Supabase ──────────────────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type':  'application/json',
  'apikey':        SUPABASE_ANON,
  'Authorization': `Bearer ${SUPABASE_ANON}`,
  'Prefer':        'resolution=merge-duplicates',
}
async function sbGet(table, id = 'main') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=data`, { headers: SB_HEADERS })
  if (!res.ok) return null
  return (await res.json())?.[0]?.data ?? null
}
async function sbSet(table, data, id = 'main') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: SB_HEADERS,
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() }),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error(`sbSet FAILED ${table}: ${res.status} ${err}`)
    throw new Error(`sbSet ${table} failed: ${res.status}`)
  }
}

// ── Massive ───────────────────────────────────────────────────────
const MONTH_CODES = ['F','G','H','J','K','M','N','Q','U','V','X','Z']
function getFrontMonthTicker(code) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1
  const qm = [3,6,9,12].find(q => q >= m) || 3
  const yr = qm >= m ? y : y + 1
  return `${code}${MONTH_CODES[qm-1]}${String(yr).slice(-1)}`
}

async function fetchBars(resolution, limit) {
  const ticker = getFrontMonthTicker(PRIMARY)
  const now    = new Date()
  const from   = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
  const gte    = from.toISOString().slice(0, 10)
  const url    = `https://api.massive.com/futures/v1/aggs/${ticker}` +
    `?resolution=${resolution}&window_start.gte=${gte}&window_start.lte=${now.toISOString()}` +
    `&limit=${limit}&sort=window_start.desc&apiKey=${MASSIVE_API_KEY}&_t=${Date.now()}`
  const res  = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
  if (!res.ok) throw new Error(`Massive ${res.status}`)
  const data = await res.json()
  return (data.results || []).reverse().map(b => ({
    time: b.window_start / 1e6, open: b.open, high: b.high, low: b.low, close: b.close,
  }))
}

// ── Market structure bias ─────────────────────────────────────────
// Detects HH/HL (bullish) or LH/LL (bearish) or mixed (neutral)
function detectStructure(candles) {
  if (candles.length < 10) return 'neutral'

  // Find last 4 significant swing points
  const swings = []
  for (let i = 2; i < candles.length - 2; i++) {
    const isHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                   candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high
    const isLow  = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                   candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low
    if (isHigh) swings.push({ type: 'high', price: candles[i].high, idx: i })
    if (isLow)  swings.push({ type: 'low',  price: candles[i].low,  idx: i })
  }

  if (swings.length < 4) return 'neutral'

  // Get last 2 highs and 2 lows
  const highs = swings.filter(s => s.type === 'high').slice(-2)
  const lows  = swings.filter(s => s.type === 'low').slice(-2)

  if (highs.length < 2 || lows.length < 2) return 'neutral'

  const hhPattern = highs[1].price > highs[0].price  // higher high
  const hlPattern = lows[1].price  > lows[0].price   // higher low
  const lhPattern = highs[1].price < highs[0].price  // lower high
  const llPattern = lows[1].price  < lows[0].price   // lower low

  if (hhPattern && hlPattern) return 'bullish'
  if (lhPattern && llPattern) return 'bearish'
  return 'neutral'
}

// ── Update bias (called at bar closes) ───────────────────────────
async function updateBias() {
  try {
    // Massive Starter only supports minute bars
    // Simulate 1H by grouping 5min bars, 4H by using longer lookback
    const allBars = await fetchBars('5min', 500)

    // 1H proxy: last 100 bars = ~8 hours, use recent structure
    const bars1H = allBars.slice(-100)
    // 4H proxy: full 500 bars = ~40 hours, use bigger picture
    const bars4H = allBars

    const bias1H = detectStructure(bars1H)
    const bias4H = detectStructure(bars4H)

    // Determine combined bias and threshold
    let direction = 'both'
    let threshold = 4
    let reason    = ''

    if (bias1H === 'bullish' && bias4H === 'bullish') {
      direction = 'long'; threshold = 4
      reason = '1H+4H bullish — LONG only, threshold 4'
    } else if (bias1H === 'bearish' && bias4H === 'bearish') {
      direction = 'short'; threshold = 4
      reason = '1H+4H bearish — SHORT only, threshold 4'
    } else if (bias1H === 'neutral' || bias4H === 'neutral') {
      direction = 'both'; threshold = 6
      reason = `Unclear structure (1H:${bias1H} 4H:${bias4H}) — both directions, threshold 6`
    } else {
      direction = 'both'; threshold = 7
      reason = `Conflicting bias (1H:${bias1H} 4H:${bias4H}) — both directions, threshold 7`
    }

    const bias = { bias1H, bias4H, direction, threshold, reason, updatedAt: Date.now() }
    await sbSet('bot_log', bias, 'bias')  // store separately
    console.log(`[BIAS] ${reason}`)
    return bias
  } catch (e) {
    console.error('Bias update failed:', e.message)
    return { direction: 'both', threshold: 5, bias1H: 'neutral', bias4H: 'neutral', reason: 'Default — bias fetch error' }
  }
}

// Load cached bias from Supabase
async function getBias() {
  try {
    const cached = await sbGet('bot_log', 'bias')
    if (cached?.updatedAt && Date.now() - cached.updatedAt < 6 * 60 * 60 * 1000) {
      return cached  // use cached if less than 6 hours old
    }
  } catch {}
  return null
}

// ── Session threshold ─────────────────────────────────────────────
function getSessionThreshold(baseThreshold) {
  const hour = new Date().getUTCHours()
  const isActive = (hour >= 13 && hour < 21) ||  // NY
                   (hour >= 7  && hour < 12) ||   // London
                   (hour >= 23 || hour < 4)        // Asian
  return isActive ? baseThreshold : Math.max(baseThreshold, 6)
}

// ── Paper broker ──────────────────────────────────────────────────
async function getTrades()  { return await sbGet('paper_trades')  || [] }
async function getAccount() { return await sbGet('paper_account') || { startingBalance:25000, balance:25000, realizedPnl:0, totalTrades:0, wins:0, losses:0 } }
function getOpenPos(trades) { return trades.find(t => !t.exitTime) || null }

async function openTrade(trades, side, price, contracts = 1, sl, tp) {
  trades.push({ id: Date.now(), symbol: SYMBOL, side, entryPrice: price, quantity: contracts,
    stopLoss: sl, takeProfit: tp, entryTime: Date.now(),
    exitTime: null, exitPrice: null, exitReason: null, pnlDollars: null, multiplier: MULTIPLIER })
  await sbSet('paper_trades', trades)
  console.log(`📈 Opened ${side} @ ${price} SL:${sl?.toFixed(2)} TP:${tp?.toFixed(2)}`)
}

async function closeTrade(trades, price, reason) {
  const idx = trades.findIndex(t => !t.exitTime)
  if (idx === -1) return
  const t   = trades[idx]
  const pnl = (t.side === 'LONG' ? price - t.entryPrice : t.entryPrice - price) * MULTIPLIER * (t.quantity || 1)
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

// ── Signal ────────────────────────────────────────────────────────
function evalSignal(candles, ind, signalBody, openPos) {
  try {
    const fn  = new Function('i', 'candles', 'ind', 'pos', signalBody)
    const pos = openPos ? { isOpen: true, side: openPos.side } : { isOpen: false, side: 'FLAT' }
    return fn(candles.length - 1, candles, ind, pos)
  } catch (e) { console.error('Signal error:', e.message); return null }
}

// ── Learning filter ───────────────────────────────────────────────
async function canTrade(factors) {
  try {
    const mem = await sbGet('learning_memory') || { trades: [] }
    if (!mem.trades?.length) return true
    const key = Object.entries(factors || {}).filter(([,v]) => v).map(([k]) => k).sort().join('+')
    if (!key) return true
    const matching = mem.trades.filter(t => {
      const tk = Object.entries(t.factors || {}).filter(([,v]) => v).map(([k]) => k).sort().join('+')
      return tk === key
    })
    if (matching.length < 8) return true
    const exp = matching.reduce((s,t) => s + (t.rMultiple || 0), 0) / matching.length
    console.log(`Filter: ${key} exp:${exp.toFixed(3)} n:${matching.length} allow:${exp > 0}`)
    return exp > 0
  } catch { return true }
}

// ── Log ───────────────────────────────────────────────────────────
async function log(type, msg, detail = null) {
  console.log(`[${type.toUpperCase()}] ${msg}${detail ? ' — ' + detail : ''}`)
  try {
    const existing = await sbGet('bot_log') || []
    if (Array.isArray(existing)) {
      existing.unshift({ type, message: msg, detail, time: new Date().toISOString() })
      await sbSet('bot_log', existing.slice(0, 200))
    }
  } catch {}
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


// ── Dynamic Risk Engine ───────────────────────────────────────────
// Combines ATR-based stops with win probability to size each trade
async function calcDynamicRisk({ candles, side, currentPrice, factors, accountBalance = 25000 }) {
  const atrVal = calcATR(candles)

  // Get win probability from learning memory
  let winRate    = 50
  let expectancy = 0
  let sampleSize = 0
  let confidence = 0

  try {
    const mem = await sbGet('learning_memory') || { trades: [] }
    if (mem.trades?.length) {
      const key = Object.entries(factors || {}).filter(([,v]) => v).map(([k]) => k).sort().join('+')
      if (key) {
        const matching = mem.trades.filter(t => {
          const tk = Object.entries(t.factors || {}).filter(([,v]) => v).map(([k]) => k).sort().join('+')
          return tk === key
        })
        if (matching.length >= 4) {
          sampleSize = matching.length
          const wins = matching.filter(t => t.win).length
          winRate    = +((wins / sampleSize) * 100).toFixed(1)
          expectancy = +(matching.reduce((s,t) => s + (t.rMultiple || 0), 0) / sampleSize).toFixed(3)
          confidence = Math.min(1, sampleSize / 30)
        }
      }
    }
  } catch {}

  // ATR-based stop distance
  const stopDistance = +(atrVal * 1.5).toFixed(2)

  // Win-rate adjusted RR target
  // Min RR = (1 - winRate) / winRate to be profitable
  const winFrac = winRate / 100
  const minRR   = winFrac > 0 ? +((1 - winFrac) / winFrac).toFixed(2) : 2
  const edgeBonus = confidence * 1.5
  const rrRatio = +Math.max(1.5, minRR + edgeBonus).toFixed(2)

  const targetDistance = +(stopDistance * rrRatio).toFixed(2)

  const stopPrice   = side === 'LONG' ? +(currentPrice - stopDistance).toFixed(2) : +(currentPrice + stopDistance).toFixed(2)
  const targetPrice = side === 'LONG' ? +(currentPrice + targetDistance).toFixed(2) : +(currentPrice - targetDistance).toFixed(2)

  // Position sizing — risk 1% of account, adjusted by expectancy confidence
  const baseRiskPct  = 1
  const riskMult     = sampleSize >= 8 ? Math.max(0.5, Math.min(1.5, 1 + expectancy * 0.5)) : 1
  const riskDollars  = accountBalance * (baseRiskPct / 100) * riskMult
  const dollarPerPt  = 2  // MNQ
  const rawContracts = riskDollars / (stopDistance * dollarPerPt)
  const contracts    = Math.max(1, Math.round(rawContracts))

  console.log(`[RISK] ATR:${atrVal.toFixed(2)} stop:${stopDistance} RR:${rrRatio} contracts:${contracts} winRate:${winRate}% (n:${sampleSize})`)

  return { stopPrice, targetPrice, contracts, rrRatio, winRate, expectancy, sampleSize, stopDistance }
}

// ── Main cycle ────────────────────────────────────────────────────
async function runCycle() {
  const now = new Date()
  console.log(`\n⏰ ${now.toISOString()}`)

  const strategy = await sbGet('active_strategy')
  if (!strategy?.signalBody) {
    console.log('⏳ No active strategy — click 🤖 Set Active in app')
    return  // just skip this cycle, process stays alive
  }

  // ── Update bias at bar closes ────────────────────────────────────
  const min = now.getUTCMinutes()
  const hr  = now.getUTCHours()
  let bias  = await getBias()

  // Recalculate at top of each hour (or if no cached bias)
  if (!bias || (min < 6)) {
    console.log('Recalculating HTF bias...')
    bias = await updateBias()
  }

  console.log(`[BIAS] 1H:${bias.bias1H} 4H:${bias.bias4H} → ${bias.direction.toUpperCase()} threshold:${bias.threshold}`)

  // Fetch 5min bars for signal
  let candles
  try {
    const bars5m = await fetchBars('5min', 300)  // Massive uses 5min not 5m
    candles = bars5m
    if (candles.length < 20) { console.log('Not enough bars'); return }
    const last = candles[candles.length - 1]
    console.log(`Got ${candles.length} bars. Most recent: ${new Date(last.time).toISOString()} close:${last.close}`)
  } catch (e) {
    await log('error', 'Bar fetch failed', e.message); return
  }

  const currentPrice = candles[candles.length - 1].close
  await log('price', `${PRIMARY}: ${currentPrice}`)

  const ind = buildIndicators(candles)
  const li  = candles.length - 1
  console.log(`[INDICATORS] sweepLow:${ind.liquiditySweepLow[li]} | sweepHigh:${ind.liquiditySweepHigh[li]} | fvgBull:${ind.bullishFVG[li]} | fvgBear:${ind.bearishFVG[li]} | bosBull:${ind.bosBullish[li]} | bosBear:${ind.bosBearish[li]} | obBull:${ind.rejectionBlockBullish[li]} | obBear:${ind.rejectionBlockBearish[li]}`)

  // Check open position SL/TP
  const trades  = await getTrades()
  const openPos = getOpenPos(trades)
  if (openPos) {
    if (openPos.stopLoss && (openPos.side === 'LONG' ? currentPrice <= openPos.stopLoss : currentPrice >= openPos.stopLoss)) {
      await closeTrade(trades, currentPrice, 'stopLoss'); return
    }
    if (openPos.takeProfit && (openPos.side === 'LONG' ? currentPrice >= openPos.takeProfit : currentPrice <= openPos.takeProfit)) {
      await closeTrade(trades, currentPrice, 'takeProfit'); return
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

    // ── Bias filter ────────────────────────────────────────────────
    if (bias.direction === 'long'  && isSell) {
      await log('filter', `⛔ BLOCKED SHORT — bias is BULLISH (1H:${bias.bias1H} 4H:${bias.bias4H})`); return
    }
    if (bias.direction === 'short' && isBuy) {
      await log('filter', `⛔ BLOCKED LONG — bias is BEARISH (1H:${bias.bias1H} 4H:${bias.bias4H})`); return
    }

    // ── Session-aware threshold ────────────────────────────────────
    const sessionThreshold = getSessionThreshold(bias.threshold)
    if (sessionThreshold !== bias.threshold) {
      console.log(`[THRESHOLD] Offhours — raised from ${bias.threshold} to ${sessionThreshold}`)
    }

    // ── Learning filter ────────────────────────────────────────────
    const allowed = await canTrade(signal.factors || {})
    if (!allowed) { await log('filter', `⛔ BLOCKED — negative expectancy`); return }

    const side = isBuy ? 'LONG' : 'SHORT'

    // ── Dynamic risk: probability-adjusted RR + ATR stops ─────────
    const risk = calcDynamicRisk({
      candles,
      side,
      currentPrice,
      factors: signal.factors || {},
      accountBalance: (await getAccount()).balance,
    })

    await openTrade(trades, side, currentPrice, risk.contracts, risk.stopPrice, risk.targetPrice)
    await log('trade', `Opened ${side} @ ${currentPrice}`,
      `${risk.contracts}x MNQ | SL:${risk.stopPrice.toFixed(2)} TP:${risk.targetPrice.toFixed(2)} | RR:${risk.rrRatio} | winRate:${risk.winRate}% | bias:${bias.direction}`)
  }
}

// ── Start ─────────────────────────────────────────────────────────
console.log('🤖 TradingBot — Railway 24/7 with HTF Bias')
console.log(`   Polling every ${POLL_MS/60000} minutes`)
console.log(`   HTF bias updates every hour`)

process.on('SIGTERM', () => console.log('SIGTERM ignored'))
process.on('SIGINT',  () => console.log('SIGINT ignored'))
process.on('uncaughtException',  e => console.error('Uncaught:', e.message))
process.on('unhandledRejection', e => console.error('Unhandled:', e?.message || e))

runCycle()
setInterval(runCycle, POLL_MS)
setInterval(() => console.log('💓 heartbeat'), 30_000)
