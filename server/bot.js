import fetch from 'node-fetch'
import http from 'http'

// Health check server so Railway keeps the process alive
const PORT = process.env.PORT || 3000
http.createServer((req, res) => { res.writeHead(200); res.end('TradingBot running') })
  .listen(PORT, () => console.log(`Health check on port ${PORT}`))

const SUPABASE_URL    = 'https://dxnxtthvupbfydttqcpk.supabase.co'
const SUPABASE_ANON   = (process.env.SUPABASE_ANON || '').trim().replace(/[\r\n\t]/g, '')
const PRIMARY         = 'NQ'
const SYMBOL          = 'MNQ'
const MULTIPLIER      = 2
const POLL_MS         = 5 * 60 * 1000

// ── Eval Mode Config ──────────────────────────────────────────────
const EVAL_MODE          = true
const EVAL_ACCOUNT_SIZE  = 25000
const EVAL_PROFIT_TARGET = 1250
const EVAL_MAX_DRAWDOWN  = 1000
const EVAL_DAILY_LIMIT   = 600
const EVAL_MAX_CONTRACTS = 2

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


async function fetchBars(limit = 500) {
  const res  = await fetch('https://tv-price-feed-production.up.railway.app/bars')
  const data = await res.json()

 // Get 1-minute bars
  const bars1m = (data.bars || []).slice(-limit * 5)
  if (bars1m.length === 0) { console.log('No bars from TV feed'); return [] }

  // Group by actual 5-minute time boundaries (matches TradingView exactly)
  const fiveMinMs = 5 * 60 * 1000
  const grouped   = {}
  for (const bar of bars1m) {
    const boundary = Math.floor(bar.time / fiveMinMs) * fiveMinMs
    if (!grouped[boundary]) {
      grouped[boundary] = { time: boundary, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
    } else {
      grouped[boundary].high  = Math.max(grouped[boundary].high, bar.high)
      grouped[boundary].low   = Math.min(grouped[boundary].low,  bar.low)
      grouped[boundary].close = bar.close
    }
  }
  const bars5m = Object.values(grouped).sort((a, b) => a.time - b.time)
  
  const last = bars5m[bars5m.length - 1]
  console.log(`Got ${bars5m.length} 5min bars from TradingView. Latest: ${new Date(last.time).toISOString()} close:${last.close}`)
  return bars5m.slice(-limit)
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


// ── HTF Candle Grouping ──────────────────────────────────────────
function groupToHTF(bars1m, intervalMs) {
  const grouped = {}
  for (const bar of bars1m) {
    const boundary = Math.floor(bar.time / intervalMs) * intervalMs
    if (!grouped[boundary]) {
      grouped[boundary] = { time: boundary, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
    } else {
      grouped[boundary].high  = Math.max(grouped[boundary].high, bar.high)
      grouped[boundary].low   = Math.min(grouped[boundary].low,  bar.low)
      grouped[boundary].close = bar.close
    }
  }
  return Object.values(grouped).sort((a, b) => a.time - b.time)
}

function findSwingHighsLows(candles, lookback = 2) {
  const n   = candles.length
  const swH = new Array(n).fill(false)
  const swL = new Array(n).fill(false)
  for (let i = lookback; i < n - lookback; i++) {
    let isH = true, isL = true
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i-j].high || candles[i].high <= candles[i+j].high) isH = false
      if (candles[i].low  >= candles[i-j].low  || candles[i].low  >= candles[i+j].low)  isL = false
    }
    swH[i] = isH
    swL[i] = isL
  }
  return { swH, swL }
}

function detectHTFSweeps(bars1m, candles5m) {
  const oneHourMs  = 60 * 60 * 1000
  const fourHourMs = 4 * 60 * 60 * 1000
  const bars1H = groupToHTF(bars1m, oneHourMs)
  const bars4H = groupToHTF(bars1m, fourHourMs)
  const { swH: swH1H, swL: swL1H } = findSwingHighsLows(bars1H, 2)
  const { swH: swH4H, swL: swL4H } = findSwingHighsLows(bars4H, 2)

  const swing1HHighs = bars1H.filter((b, i) => swH1H[i]).map(b => b.high)
  const swing1HLows  = bars1H.filter((b, i) => swL1H[i]).map(b => b.low)
  const swing4HHighs = bars4H.filter((b, i) => swH4H[i]).map(b => b.high)
  const swing4HLows  = bars4H.filter((b, i) => swL4H[i]).map(b => b.low)

  const n = candles5m.length
  const results = { sweep1HLow: false, sweep1HHigh: false, sweep4HLow: false, sweep4HHigh: false, sweepStrength: 0 }

  for (let i = Math.max(0, n - 3); i < n; i++) {
    const c = candles5m[i]
    for (const lvl of swing1HLows.slice(-10)) {
      if (c.low < lvl && c.close > lvl) { results.sweep1HLow = true; results.sweepStrength = Math.max(results.sweepStrength, 2) }
    }
    for (const lvl of swing1HHighs.slice(-10)) {
      if (c.high > lvl && c.close < lvl) { results.sweep1HHigh = true; results.sweepStrength = Math.max(results.sweepStrength, 2) }
    }
    for (const lvl of swing4HLows.slice(-10)) {
      if (c.low < lvl && c.close > lvl) { results.sweep4HLow = true; results.sweepStrength = Math.max(results.sweepStrength, 3) }
    }
    for (const lvl of swing4HHighs.slice(-10)) {
      if (c.high > lvl && c.close < lvl) { results.sweep4HHigh = true; results.sweepStrength = Math.max(results.sweepStrength, 3) }
    }
  }
  return results
}

// ── Persistent Key Levels ────────────────────────────────────────
async function loadKeyLevels() {
  try {
    const data = await sbGet('bot_log', 'key_levels')
    return data?.levels || []
  } catch { return [] }
}

async function saveKeyLevels(levels) {
  try {
    await sbSet('bot_log', { levels, updatedAt: Date.now() }, 'key_levels')
  } catch (e) { console.error('Key levels save error:', e.message) }
}

function detectNewKeyLevels(bars1m, candles5m, existingLevels) {
  const newLevels  = []
  const oneHourMs  = 60 * 60 * 1000
  const fourHourMs = 4 * 60 * 60 * 1000
  const now        = Date.now()

  const bars1H = groupToHTF(bars1m, oneHourMs)
  const bars4H = groupToHTF(bars1m, fourHourMs)
  const { swH: swH1H, swL: swL1H } = findSwingHighsLows(bars1H, 2)
  const { swH: swH4H, swL: swL4H } = findSwingHighsLows(bars4H, 2)

  const highs1H = bars1H.filter((b, i) => swH1H[i])
  const lows1H  = bars1H.filter((b, i) => swL1H[i])

  // Equal highs on 1H
  for (let i = 0; i < highs1H.length - 1; i++) {
    for (let j = i + 1; j < highs1H.length; j++) {
      if (Math.abs(highs1H[i].high - highs1H[j].high) < 30) {
        const price = (highs1H[i].high + highs1H[j].high) / 2
        if (!existingLevels.some(l => Math.abs(l.price - price) < 20)) {
          newLevels.push({ id: `kl_${now}_${Math.random().toString(36).slice(2,6)}`, price: +price.toFixed(2), type: 'equalHighs', timeframe: '1H', strength: 2, direction: 'resistance', formedAt: now, lastSeen: now, touches: 2, consumed: false })
        }
      }
    }
  }

  // Equal lows on 1H
  for (let i = 0; i < lows1H.length - 1; i++) {
    for (let j = i + 1; j < lows1H.length; j++) {
      if (Math.abs(lows1H[i].low - lows1H[j].low) < 30) {
        const price = (lows1H[i].low + lows1H[j].low) / 2
        if (!existingLevels.some(l => Math.abs(l.price - price) < 20)) {
          newLevels.push({ id: `kl_${now}_${Math.random().toString(36).slice(2,6)}`, price: +price.toFixed(2), type: 'equalLows', timeframe: '1H', strength: 2, direction: 'support', formedAt: now, lastSeen: now, touches: 2, consumed: false })
        }
      }
    }
  }

  // 4H swing highs/lows as major levels
  bars4H.forEach((b, i) => {
    if (swH4H[i] && !existingLevels.some(l => Math.abs(l.price - b.high) < 30)) {
      newLevels.push({ id: `kl_${now}_${Math.random().toString(36).slice(2,6)}`, price: b.high, type: 'swing4HHigh', timeframe: '4H', strength: 3, direction: 'resistance', formedAt: b.time, lastSeen: now, touches: 1, consumed: false })
    }
    if (swL4H[i] && !existingLevels.some(l => Math.abs(l.price - b.low) < 30)) {
      newLevels.push({ id: `kl_${now}_${Math.random().toString(36).slice(2,6)}`, price: b.low, type: 'swing4HLow', timeframe: '4H', strength: 3, direction: 'support', formedAt: b.time, lastSeen: now, touches: 1, consumed: false })
    }
  })

  // Round numbers every 250pts
  if (candles5m.length > 0) {
    const price = candles5m[candles5m.length - 1].close
    const base  = Math.round(price / 250) * 250
    for (const lvl of [base - 250, base, base + 250]) {
      if (!existingLevels.some(l => Math.abs(l.price - lvl) < 50)) {
        newLevels.push({ id: `kl_round_${lvl}`, price: lvl, type: 'roundNumber', timeframe: 'ALL', strength: 2, direction: 'both', formedAt: now, lastSeen: now, touches: 0, consumed: false })
      }
    }
  }

  return newLevels
}

function updateKeyLevels(levels, currentPrice, atr) {
  const tolerance = atr * 0.3
  const updated   = levels.map(l => {
    const distance = Math.abs(currentPrice - l.price)
    if (distance < tolerance) {
      l.touches++
      l.lastSeen = Date.now()
      console.log(`[KEY LEVEL] Price near ${l.type}@${l.price} (${l.timeframe} str:${l.strength}) touches:${l.touches}`)
    }
    return l
  }).filter(l => l.touches < 5 || Math.abs(currentPrice - l.price) < atr)
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  return updated.filter(l => l.touches > 0 || (Date.now() - l.formedAt) < thirtyDays)
}

function getNearKeyLevels(levels, currentPrice, atr) {
  return levels.filter(l => Math.abs(l.price - currentPrice) < atr * 2)
}

// ── Dynamic Risk Engine ───────────────────────────────────────────
// Quality score + fixed dollar risk + ATR volatility scaling + $500 hard cap
async function calcDynamicRisk(candles, side, currentPrice, factors, accountBalance, signalScore = 4) {
  const atrVal = calcATR(candles)

  // Get win stats from learning memory
  let winRate = 50, expectancy = 0, sampleSize = 0
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
        }
      }
    }
  } catch (e) { console.error('Risk memory error:', e.message) }

  // Step 1: Quality score adjusts base risk
  const BASE_RISK = 400
  const score = signalScore || 4
  const scoreMultiplier = score <= 3 ? 0.5
    : score === 4 ? 0.75
    : score === 5 ? 1.0
    : 1.25  // score 6+
  const adjustedRisk = Math.round(BASE_RISK * scoreMultiplier)

  // Step 2: ATR-based stop (1x ATR)
  const stopDist   = +atrVal.toFixed(2)
  const targetDist = +(atrVal * 2).toFixed(2)

  // Step 3: Contracts from adjusted risk + ATR
  const dollarPerPoint  = MULTIPLIER  // $2 MNQ
  const rawContracts    = adjustedRisk / (stopDist * dollarPerPoint)
  const baseContracts   = Math.max(1, Math.min(6, Math.round(rawContracts)))
  const baseRisk        = +(baseContracts * stopDist * dollarPerPoint).toFixed(2)

  // Hard cap — never lose more than $500 per trade
  const contracts   = baseRisk > 500
    ? Math.max(1, Math.floor(500 / (stopDist * dollarPerPoint)))
    : baseContracts

  // During eval cap at 2 max, drop to 1 after -$300 on day
  let finalContracts = contracts
  if (EVAL_MODE) {
    try {
      const evalS = await getEvalStats()
      const evalMax = evalS.todayPnl <= -300 ? 1 : EVAL_MAX_CONTRACTS
      finalContracts = Math.min(contracts, evalMax)
    } catch {}
  }

  const actualRisk  = +(finalContracts * stopDist * dollarPerPoint).toFixed(2)
  const stopPrice   = side === 'LONG'
    ? +(currentPrice - stopDist).toFixed(2)
    : +(currentPrice + stopDist).toFixed(2)
  const targetPrice = side === 'LONG'
    ? +(currentPrice + targetDist).toFixed(2)
    : +(currentPrice - targetDist).toFixed(2)

  console.log(`[RISK] Score:${score}(${scoreMultiplier}x) ATR:${atrVal.toFixed(1)} risk:$${adjustedRisk} contracts:${finalContracts} SL:${stopPrice} TP:${targetPrice}`)

  return { stopPrice, targetPrice, stopDistance: stopDist, targetDistance: targetDist, rrRatio: 2, contracts: finalContracts, riskDollars: actualRisk, winRate, expectancy, sampleSize }
}

// ── Market structure detection ────────────────────────────────────
function detectStructure(candles) {
  if (candles.length < 15) return 'neutral'
  const swings = []
  for (let i = 4; i < candles.length - 4; i++) {
    const isH = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                candles[i].high > candles[i-3].high && candles[i].high > candles[i-4].high &&
                candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high &&
                candles[i].high > candles[i+3].high && candles[i].high > candles[i+4].high
    const isL = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                candles[i].low < candles[i-3].low && candles[i].low < candles[i-4].low &&
                candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low &&
                candles[i].low < candles[i+3].low && candles[i].low < candles[i+4].low
    if (isH) swings.push({ type: 'high', price: candles[i].high, idx: i })
    if (isL) swings.push({ type: 'low',  price: candles[i].low,  idx: i })
  }
  if (swings.length < 6) return 'neutral'
  const highs = swings.filter(s => s.type === 'high').slice(-3)
  const lows  = swings.filter(s => s.type === 'low').slice(-3)
  if (highs.length < 3 || lows.length < 3) return 'neutral'
  const hhh  = highs[2].price > highs[1].price && highs[1].price > highs[0].price
  const hlhl = lows[2].price > lows[1].price && lows[1].price > lows[0].price
  const lll  = highs[2].price < highs[1].price && highs[1].price < highs[0].price
  const lhlh = lows[2].price < lows[1].price && lows[1].price < lows[0].price
  if (hhh && hlhl) return 'bullish'
  if (lll && lhlh) return 'bearish'
  return 'neutral'
}

// ── HTF Bias ──────────────────────────────────────────────────────
async function updateBias(candles, bars1m = []) {
  // Use proper 1H/4H candles if 1-min bars available, else fall back to 5-min proxy
  let bars1H, bars4H
  if (bars1m.length > 60) {
    const oneHourMs  = 60 * 60 * 1000
    const fourHourMs = 4 * 60 * 60 * 1000
    const grouped1H  = {}, grouped4H = {}
    for (const bar of bars1m.slice(-2880)) {  // last 2 days of 1-min bars
      const b1 = Math.floor(bar.time / oneHourMs) * oneHourMs
      if (!grouped1H[b1]) grouped1H[b1] = { time: b1, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
      else { grouped1H[b1].high = Math.max(grouped1H[b1].high, bar.high); grouped1H[b1].low = Math.min(grouped1H[b1].low, bar.low); grouped1H[b1].close = bar.close }
      const b4 = Math.floor(bar.time / fourHourMs) * fourHourMs
      if (!grouped4H[b4]) grouped4H[b4] = { time: b4, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
      else { grouped4H[b4].high = Math.max(grouped4H[b4].high, bar.high); grouped4H[b4].low = Math.min(grouped4H[b4].low, bar.low); grouped4H[b4].close = bar.close }
    }
    bars1H = Object.values(grouped1H).sort((a,b) => a.time - b.time)
    bars4H = Object.values(grouped4H).sort((a,b) => a.time - b.time)
  } else {
    bars1H = candles.slice(-20)
    bars4H = candles
  }
  const bias1H = detectStructure(bars1H)
  const bias4H = detectStructure(bars4H)
  let direction = 'both', threshold = 5, reason = ''
  if (bias1H === 'bullish' && bias4H === 'bullish') {
    direction = 'long';  threshold = 4; reason = '1H+4H bullish → LONG only, threshold 4'
  } else if (bias1H === 'bearish' && bias4H === 'bearish') {
    direction = 'short'; threshold = 4; reason = '1H+4H bearish → SHORT only, threshold 4'
  } else if (bias1H !== 'neutral' && bias4H !== 'neutral' && bias1H !== bias4H) {
    direction = 'both';  threshold = 7; reason = `Conflicting (1H:${bias1H} 4H:${bias4H}) → both, threshold 7`
  } else {
    direction = 'both';  threshold = 5; reason = `Unclear (1H:${bias1H} 4H:${bias4H}) → both, threshold 5`
  }

  // ── Bias Lock — holds direction until structure clearly breaks ──
  try {
    const prev   = await sbGet('bot_log', 'bias')
    const lockMs = 15 * 60 * 1000
    if (prev?.direction && prev.direction !== 'both') {
      const lockAge    = Date.now() - (prev.lockedSince || prev.updatedAt || 0)
      const dirChanged = direction !== prev.direction
      const lockExpired = lockAge >= lockMs
      if (dirChanged && !lockExpired) {
        console.log(`[BIAS] Lock active (${Math.round(lockAge/60000)}/${Math.round(lockMs/60000)} min) — keeping ${prev.direction}`)
        direction = prev.direction; threshold = prev.threshold; reason = prev.reason + ` (locked ${Math.round((lockMs-lockAge)/60000)}min)`
      } else if (dirChanged && lockExpired) {
        const clearBreak = (bias1H !== 'neutral' && bias4H !== 'neutral' && bias1H === bias4H)
        if (!clearBreak) {
          console.log(`[BIAS] Lock expired but unclear (1H:${bias1H} 4H:${bias4H}) — holding neutral`)
          direction = 'both'; threshold = 5; reason = `Unclear after lock → both, threshold 5`
        } else {
          console.log(`[BIAS] Direction confirmed: ${prev.direction} → ${direction} (both TFs agree)`)
        }
      } else {
        console.log(`[BIAS] Confirmed: ${direction} (${Math.round(lockAge/60000)} min)`)
      }
    }
  } catch {}
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
  return baseThreshold  // matches backtest — no session adjustment
}


// ── IV Walls ──────────────────────────────────────────────────────
function calcIVWalls(candles, currentPrice) {
  if (!candles.length) return null
  const now       = new Date()
  const todayDate = now.toISOString().slice(0, 10)
  const days = {}
  for (const bar of candles) {
    const date = new Date(bar.time).toISOString().slice(0, 10)
    if (!days[date]) days[date] = { open: bar.open, high: bar.high, low: bar.low, close: bar.close }
    days[date].high  = Math.max(days[date].high, bar.high)
    days[date].low   = Math.min(days[date].low,  bar.low)
    days[date].close = bar.close
  }
  const sortedDays = Object.entries(days).sort((a,b) => a[0].localeCompare(b[0]))
  const today      = days[todayDate]
  const yesterday  = sortedDays.length >= 2 ? sortedDays[sortedDays.length - 2][1] : null

  let intradayBias = 'neutral'
  if (today) {
    const recentDays = sortedDays.slice(-6, -1)
    const avgRange   = recentDays.length > 0
      ? recentDays.reduce((s, [,d]) => s + (d.high - d.low), 0) / recentDays.length : 200
    const upper = today.open + avgRange, lower = today.open - avgRange
    const range = upper - lower
    if ((upper - currentPrice) / range < 0.15) intradayBias = 'nearUpper'
    if ((currentPrice - lower) / range < 0.15) intradayBias = 'nearLower'
  }

  const keyLevels = []
  if (yesterday) {
    keyLevels.push({ price: yesterday.high, label: 'PDH', type: 'resistance' })
    keyLevels.push({ price: yesterday.low,  label: 'PDL', type: 'support' })
  }
  const weekDays = sortedDays.slice(-5)
  if (weekDays.length >= 3) {
    keyLevels.push({ price: Math.max(...weekDays.map(([,d]) => d.high)), label: 'PWH', type: 'resistance' })
    keyLevels.push({ price: Math.min(...weekDays.map(([,d]) => d.low)),  label: 'PWL', type: 'support' })
  }
  if (today) keyLevels.push({ price: today.open, label: "Today's Open", type: 'pivot' })

  const nearestResistance = keyLevels.filter(l => l.price > currentPrice).sort((a,b) => a.price - b.price)[0]
  const nearestSupport    = keyLevels.filter(l => l.price < currentPrice).sort((a,b) => b.price - a.price)[0]

  let wallBias = intradayBias
  if (nearestResistance && (nearestResistance.price - currentPrice) < 30) wallBias = 'nearUpper'
  if (nearestSupport    && (currentPrice - nearestSupport.price)    < 30) wallBias = 'nearLower'

  console.log(`[WALLS] PDH:${yesterday?.high} PDL:${yesterday?.low} | Resistance:${nearestResistance?.label}@${nearestResistance?.price} | Support:${nearestSupport?.label}@${nearestSupport?.price} | bias:${wallBias}`)

  return {
    keyLevels, nearestResistance, nearestSupport,
    pdh: yesterday?.high, pdl: yesterday?.low,
    wallBias, intradayBias,
    distToResistance: nearestResistance ? +(nearestResistance.price - currentPrice).toFixed(2) : null,
    distToSupport:    nearestSupport    ? +(currentPrice - nearestSupport.price).toFixed(2)    : null,
  }
}

// ── Paper broker ──────────────────────────────────────────────────
async function getTrades()  { return await sbGet('paper_trades')  || [] }
async function getAccount() {
  return await sbGet('paper_account') || {
    startingBalance: 25000, balance: 25000, realizedPnl: 0, totalTrades: 0, wins: 0, losses: 0,
  }
}
function getOpenPos(trades) { return trades.find(t => !t.exitTime) || null }

async function openTrade(trades, { side, entryPrice, contracts, stopLoss, takeProfit }) {
  trades.push({
    id: Date.now(), symbol: SYMBOL, side, entryPrice, quantity: contracts,
    stopLoss, takeProfit, entryTime: Date.now(),
    exitTime: null, exitPrice: null, exitReason: null, pnlDollars: null, multiplier: MULTIPLIER,
  })
  await sbSet('paper_trades', trades)
  console.log(`📈 Opened ${side} ${contracts}x @ ${entryPrice} | SL:${stopLoss} TP:${takeProfit}`)
}

async function closeTrade(trades, exitPrice, exitReason) {
  const idx = trades.findIndex(t => !t.exitTime)
  if (idx === -1) return null
  const t   = trades[idx]
  const pts = t.side === 'LONG' ? exitPrice - t.entryPrice : t.entryPrice - exitPrice
  const pnl = pts * MULTIPLIER * (t.quantity || 1)
  trades[idx] = { ...t, exitTime: Date.now(), exitPrice, exitReason, pnlDollars: pnl }
  await sbSet('paper_trades', trades)
  const acc = await getAccount()
  acc.balance += pnl; acc.realizedPnl += pnl; acc.totalTrades++
  if (pnl > 0) acc.wins++; else acc.losses++
  await sbSet('paper_account', acc)
  console.log(`📉 Closed ${t.side} ${t.quantity}x @ ${exitPrice} P&L:${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (${exitReason})`)
  return trades[idx]
}


// ── SMT Divergence ───────────────────────────────────────────────
// SMT = Smart Money Technique — NQ makes new low/high but MES doesn't
// This divergence signals institutional activity and potential reversal
function detectSMT(candlesMNQ, candlesMES) {
  if (!candlesMES || candlesMES.length < 10 || !candlesMNQ || candlesMNQ.length < 10) {
    return { smtBullish: false, smtBearish: false }
  }

  // Group MES 1-min bars into 5-min candles
  const fiveMinMs = 5 * 60 * 1000
  const groupedMES = {}
  for (const bar of candlesMES) {
    const boundary = Math.floor(bar.time / fiveMinMs) * fiveMinMs
    if (!groupedMES[boundary]) {
      groupedMES[boundary] = { time: boundary, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
    } else {
      groupedMES[boundary].high  = Math.max(groupedMES[boundary].high, bar.high)
      groupedMES[boundary].low   = Math.min(groupedMES[boundary].low,  bar.low)
      groupedMES[boundary].close = bar.close
    }
  }
  const mes5m = Object.values(groupedMES).sort((a, b) => a.time - b.time)

  const n    = Math.min(candlesMNQ.length, mes5m.length)
  const look = 10  // look back 10 bars

  if (n < look + 2) return { smtBullish: false, smtBearish: false }

  // Get recent candles aligned by time
  const mnqRecent = candlesMNQ.slice(-look)
  const mesRecent = mes5m.slice(-look)

  // SMT Bullish: MNQ makes lower low but MES does NOT make lower low
  // → NQ swept lows but ES held → reversal signal
  const mnqLow  = Math.min(...mnqRecent.map(b => b.low))
  const mesLow  = Math.min(...mesRecent.map(b => b.low))
  const mnqPrevLow = Math.min(...candlesMNQ.slice(-look*2, -look).map(b => b.low))
  const mesPrevLow = Math.min(...mes5m.slice(-look*2, -look).map(b => b.low))

  const smtBullish = mnqLow < mnqPrevLow && mesLow >= mesPrevLow - 5

  // SMT Bearish: MNQ makes higher high but MES does NOT make higher high
  // → NQ swept highs but ES held → reversal signal
  const mnqHigh     = Math.max(...mnqRecent.map(b => b.high))
  const mesHigh     = Math.max(...mesRecent.map(b => b.high))
  const mnqPrevHigh = Math.max(...candlesMNQ.slice(-look*2, -look).map(b => b.high))
  const mesPrevHigh = Math.max(...mes5m.slice(-look*2, -look).map(b => b.high))

  const smtBearish = mnqHigh > mnqPrevHigh && mesHigh <= mesPrevHigh + 5

  return { smtBullish, smtBearish }
}

// ── Indicators ────────────────────────────────────────────────────
function buildIndicators(candles, smt = {}) {
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

// Turtle Soup
  const turtleSoupLong  = new Array(n).fill(false)
  const turtleSoupShort = new Array(n).fill(false)
  for (let i = 21; i < n; i++) {
    const low20  = Math.min(...candles.slice(i-20, i).map(b => b.low))
    const high20 = Math.max(...candles.slice(i-20, i).map(b => b.high))
    if (candles[i].low < low20 && candles[i].close > low20) turtleSoupLong[i] = true
    if (candles[i].high > high20 && candles[i].close < high20) turtleSoupShort[i] = true
  }

  return {
    liquiditySweepLow: sweepLow, liquiditySweepHigh: sweepHigh,
    bosBullish: bosBull, bosBearish: bosBear,
    bullishFVG: fvgBull, bearishFVG: fvgBear,
    bullishIFVG: fvgBear, bearishIFVG: fvgBull,
    rejectionBlockBullish: obBull, rejectionBlockBearish: obBear,
    cisdBullish: bosBull, cisdBearish: bosBear,
    smtBullish: new Array(n).fill(false).fill(smt?.smtBullish || false, n-1),
    smtBearish: new Array(n).fill(false).fill(smt?.smtBearish || false, n-1),
    swingHigh: swH, swingLow: swL,
    turtleSoupLong, turtleSoupShort,
  }
}

function evalSignal(candles, ind, signalBody, openPos, session = 'newyork', htfSweeps = {}) {
  try {
    const htfBonus = htfSweeps.sweepStrength || 0
    const wrappedBody = `const session = "${session}"; const htfSweepStrength = ${htfBonus}; const htf1HSweep = ${!!(htfSweeps.sweep1HLow || htfSweeps.sweep1HHigh)}; const htf4HSweep = ${!!(htfSweeps.sweep4HLow || htfSweeps.sweep4HHigh)}; ${signalBody}`
    const fn  = new Function('i', 'candles', 'ind', 'pos', wrappedBody)
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
  const trades  = await getTrades()
  const account = await getAccount()
  const closed  = trades.filter(t => t.exitTime && t.pnlDollars !== null)
  const botStats = await sbGet('bot_stats', 'main') || {}
  const prevEval = botStats.eval || {}
  const peakBalance  = prevEval.peakEodBalance || EVAL_ACCOUNT_SIZE
  const currentFloor = peakBalance - EVAL_MAX_DRAWDOWN
  const totalProfit  = account.balance - EVAL_ACCOUNT_SIZE
  const drawdownUsed = Math.max(0, currentFloor - account.balance)
  const todayStart   = new Date(); todayStart.setUTCHours(0, 0, 0, 0)
  const todayPnl     = closed.filter(t => t.exitTime >= todayStart.getTime())
    .reduce((s, t) => s + (t.pnlDollars || 0), 0)
  const stats = {
    totalProfit, todayPnl,
    totalDrawdown: -drawdownUsed,
    drawdownLeft:  EVAL_MAX_DRAWDOWN - drawdownUsed,
    progressPct:   +((totalProfit / EVAL_PROFIT_TARGET) * 100).toFixed(1),
    drawdownPct:   +((drawdownUsed / EVAL_MAX_DRAWDOWN) * 100).toFixed(1),
    balance:       account.balance,
    peakEodBalance: peakBalance,
    currentFloor,
    drawdownUsed,
    passed: totalProfit >= EVAL_PROFIT_TARGET,
    blown:  account.balance <= currentFloor,
    updatedAt: Date.now(),
  }
  try { await sbSet('bot_stats', { ...botStats, eval: stats }, 'main') } catch {}
  return stats
}

// ── Main cycle ────────────────────────────────────────────────────
async function runCycle() {
  const now = new Date()
  console.log(`\n⏰ ${now.toISOString()}`)

  const strategy = await sbGet('active_strategy')
  if (!strategy?.signalBody) {
    console.log('⏳ No active strategy — click 🤖 Set Active in app')
    return
  }

  let candles, bars1m
  try {
    const tvRes  = await fetch('https://tv-price-feed-production.up.railway.app/bars')
    const tvData = await tvRes.json()
    bars1m = tvData.bars || []
    const fiveMinMs = 5 * 60 * 1000
    const grouped   = {}
    for (const bar of bars1m) {
      const boundary = Math.floor(bar.time / fiveMinMs) * fiveMinMs
      if (!grouped[boundary]) {
        grouped[boundary] = { time: boundary, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
      } else {
        grouped[boundary].high  = Math.max(grouped[boundary].high, bar.high)
        grouped[boundary].low   = Math.min(grouped[boundary].low,  bar.low)
        grouped[boundary].close = bar.close
      }
    }
    candles = Object.values(grouped).sort((a, b) => a.time - b.time)
    if (candles.length < 20) { console.log('Not enough bars'); return }
    const last = candles[candles.length - 1]
    console.log(`Got ${candles.length} 5min bars from TradingView. Latest: ${new Date(last.time).toISOString()} close:${last.close}`)
  } catch (e) {
    await log('error', 'Bar fetch failed', e.message); return
  }

  const currentPrice = candles[candles.length - 1].close
  await log('price', `${PRIMARY}: ${currentPrice}`)

  if (EVAL_MODE) {
    const evalStats = await getEvalStats()
    console.log(`[EVAL] Profit: $${evalStats.totalProfit.toFixed(0)}/${EVAL_PROFIT_TARGET} (${evalStats.progressPct}%) | Drawdown left: $${evalStats.drawdownLeft.toFixed(0)} | Today: ${evalStats.todayPnl >= 0 ? '+' : ''}$${evalStats.todayPnl.toFixed(0)}`)
  }

  let bias = await getBias()
  if (!bias || (now.getUTCMinutes() < 6)) bias = await updateBias(candles, bars1m)
  console.log(`[BIAS] 1H:${bias.bias1H} 4H:${bias.bias4H} → ${bias.direction.toUpperCase()} threshold:${bias.threshold}`)

  const walls = calcIVWalls(candles, currentPrice)
  if (walls) { try { await sbSet('bot_log', walls, 'iv_walls') } catch {} }

  // Fetch MES bars for SMT detection
  let barsMES = []
  let smt = { smtBullish: false, smtBearish: false }
  try {
    const mesRes  = await fetch('https://tv-price-feed-production.up.railway.app/bars/mes')
    const mesData = await mesRes.json()
    barsMES = mesData.bars || []
    smt = detectSMT(candles, barsMES)
    if (smt.smtBullish || smt.smtBearish) {
      console.log(`[SMT] 🎯 Divergence! Bullish:${smt.smtBullish} Bearish:${smt.smtBearish}`)
    }
  } catch (e) { console.log('[SMT] Error:', e.message) }

  const ind = buildIndicators(candles, smt)
  const li  = candles.length - 1
  console.log(`[INDICATORS] sweepLow:${ind.liquiditySweepLow[li]} | sweepHigh:${ind.liquiditySweepHigh[li]} | fvgBull:${ind.bullishFVG[li]} | fvgBear:${ind.bearishFVG[li]} | bosBull:${ind.bosBullish[li]} | bosBear:${ind.bosBearish[li]} | obBull:${ind.rejectionBlockBullish[li]} | obBear:${ind.rejectionBlockBearish[li]}`)

  // HTF sweep detection
  const htfSweeps = bars1m && bars1m.length > 60
    ? detectHTFSweeps(bars1m, candles)
    : { sweep1HLow: false, sweep1HHigh: false, sweep4HLow: false, sweep4HHigh: false, sweepStrength: 0 }
  if (htfSweeps.sweepStrength > 0) {
    console.log(`[HTF] 🔥 Sweep detected! 1H:${htfSweeps.sweep1HLow||htfSweeps.sweep1HHigh} 4H:${htfSweeps.sweep4HLow||htfSweeps.sweep4HHigh} strength:${htfSweeps.sweepStrength}`)
  }

  // Persistent key levels
  const atrVal   = calcATR(candles)
  let keyLevels  = await loadKeyLevels()
  keyLevels      = updateKeyLevels(keyLevels, currentPrice, atrVal)
  const newLvls  = bars1m && bars1m.length > 120 ? detectNewKeyLevels(bars1m, candles, keyLevels) : []
  if (newLvls.length > 0) {
    keyLevels = [...keyLevels, ...newLvls]
    console.log(`[KEY LEVELS] ${newLvls.length} new levels. Total: ${keyLevels.length}`)
  }
  await saveKeyLevels(keyLevels.slice(0, 100))
  const nearLevels = getNearKeyLevels(keyLevels, currentPrice, atrVal)
  if (nearLevels.length > 0) {
    console.log(`[KEY LEVELS] Near: ${nearLevels.map(l => `${l.type}@${l.price}(str:${l.strength})`).join(' | ')}`)
  }

  const trades  = await getTrades()
  const openPos = getOpenPos(trades)

  if (openPos) {
    const price = currentPrice
    const pos   = openPos

    if (pos.stopLoss !== null && pos.stopLoss !== undefined) {
      const slHit = pos.side === 'LONG' ? price <= pos.stopLoss : price >= pos.stopLoss
      if (slHit) {
        console.log(`🛑 Stop loss hit! Price:${price} SL:${pos.stopLoss}`)
        await closeTrade(trades, price, 'stopLoss')
        await log('trade', `Stop loss hit @ ${price}`, `SL was ${pos.stopLoss}`)
        return
      }
    }

    if (pos.takeProfit !== null && pos.takeProfit !== undefined) {
      const tpHit = pos.side === 'LONG' ? price >= pos.takeProfit : price <= pos.takeProfit
     if (tpHit) {
      console.log(`🎯 Take profit hit! Price:${price} TP:${pos.takeProfit}`)
      await closeTrade(trades, price, 'takeProfit')
      await log('trade', `Take profit hit @ ${price}`, `TP was ${pos.takeProfit}`)
      return
      }
    }

    // Time-based exit
    const barsOpen   = Math.floor((Date.now() - openPos.entryTime) / (5 * 60 * 1000))
    const stopDist   = Math.abs(openPos.entryPrice - openPos.stopLoss)
    const currentR   = stopDist > 0 ? (currentPrice - openPos.entryPrice) / stopDist : 0
    const recentHigh = Math.max(...candles.slice(-20).map(b => b.high))

  if (barsOpen > 30 && currentR < 0.25) {
      await closeTrade(trades, currentPrice, 'Time exit: 30 bars no progress')
      await log('trade', `Time exit @ ${currentPrice}`, `${barsOpen} bars, ${currentR.toFixed(2)}R`)
      return
    }
    if (barsOpen > 50 && recentHigh <= (openPos.entryPrice + stopDist * 0.5)) {
      await closeTrade(trades, currentPrice, 'Time exit: 50 bars stalling')
      await log('trade', `Time exit @ ${currentPrice}`, `${barsOpen} bars stalling`)
      return
    }
    if (barsOpen > 75) {
      await closeTrade(trades, currentPrice, 'Time exit: 75 bars max')
      await log('trade', `Time exit @ ${currentPrice}`, `Max hold time reached`)
      return
    }

    const pts = pos.side === 'LONG' ? price - pos.entryPrice : pos.entryPrice - price
    const unrealizedPnl = pts * MULTIPLIER * (pos.quantity || 1)
    console.log(`[POSITION] ${pos.side} ${pos.quantity}x @ ${pos.entryPrice} | Current:${price} | SL:${pos.stopLoss} TP:${pos.takeProfit} | Unrealized:${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(0)}`)
  }

  const utcHour      = now.getUTCHours()
  const sessionName  = utcHour >= 13 && utcHour < 21 ? 'newyork'
    : utcHour >= 7  && utcHour < 12 ? 'london'
    : utcHour >= 23 || utcHour < 4  ? 'asian'
    : 'offhours'



  // ── 15-minute cooldown after any trade close ────────────────────
  const lastClosedTrade = trades.filter(t => t.exitTime).slice(-1)[0]
  if (lastClosedTrade?.exitTime) {
    const minutesSinceExit = Math.floor((Date.now() - lastClosedTrade.exitTime) / (60 * 1000))
    if (minutesSinceExit < 15) {
      await log('filter', `⛔ COOLDOWN — ${15 - minutesSinceExit} min remaining after last trade`)
      return
    }
  }

  // Block trades near market close (4:55-5:00 PM EST = 20:55-21:00 UTC)
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  if (utcMinutes >= 1255 && utcMinutes < 1260) {
    await log('filter', '⛔ BLOCKED — market closes in < 5 min (4:55-5:00 PM EST)')
    return
  }

  const signal = evalSignal(candles, ind, strategy.signalBody, openPos, sessionName, htfSweeps)
  await log('signal', `Signal: ${signal?.action || 'NONE'}`, signal?.reason || null)

  if (!signal?.action || signal.action === 'none' || signal.action === 'NONE') return

  if ((signal.action === 'exit' || signal.action === 'EXIT') && openPos) {
    await closeTrade(trades, currentPrice, 'signal')
    await log('trade', `Closed on EXIT signal @ ${currentPrice}`)
    const TP_WEBHOOK2 = process.env.TRADERSPOST_WEBHOOK_URL
    if (TP_WEBHOOK2) {
      try {
        await fetch(TP_WEBHOOK2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: 'MNQ1!', action: 'exit' })
        })
        console.log('[TRADERSPOST] Exit order sent')
      } catch (e) { console.error('[TRADERSPOST] Exit failed:', e.message) }
    }
    return
  }

  const isBuy  = signal.action === 'buy'  || signal.action === 'LONG'
  const isSell = false  // LONGS ONLY MODE
  if (signal.action === 'sell' || signal.action === 'SHORT') {
    await log('filter', '⛔ LONGS ONLY — short signal blocked')
    return
  }

  if ((isBuy || isSell) && !openPos) {
    // Eval mode risk check
    if (EVAL_MODE) {
      const evalStats = await getEvalStats()
      if (evalStats.blown || evalStats.totalDrawdown <= -EVAL_MAX_DRAWDOWN + 100) {
        await log('eval', `⛔ EVAL ACCOUNT BLOWN`); return
      }
      if (evalStats.todayPnl <= -EVAL_DAILY_LIMIT) {
        await log('eval', `⛔ DAILY LIMIT HIT — $${Math.abs(evalStats.todayPnl).toFixed(0)} lost today`); return
      }
      // Consistency rule — no single day > 50% of profit target
      const EVAL_DAILY_PROFIT_CAP = EVAL_PROFIT_TARGET * 0.50  // $625

      if (evalStats.todayPnl >= EVAL_DAILY_PROFIT_CAP) {
       await log('eval', `⛔ DAILY PROFIT CAP HIT — $${evalStats.todayPnl.toFixed(0)} today (max $${EVAL_DAILY_PROFIT_CAP})`)
        return
      }
      if (evalStats.passed) {
        await log('eval', `🎉 EVAL PASSED — $${evalStats.totalProfit.toFixed(0)} profit`); return
      }
    }

    // IV Wall filter — only apply when key levels are available
    if (walls) {
      const hasPDH = walls.nearestResistance?.price && !isNaN(walls.nearestResistance.price)
      const hasPDL = walls.nearestSupport?.price && !isNaN(walls.nearestSupport.price)
      if (!hasPDH && !hasPDL) {
        console.log('[WALLS] PDH/PDL not yet available — skipping IV walls filter')
      } else {
        const atrW = calcATR(candles)
        if (isBuy && walls.wallBias === 'nearUpper' && hasPDH) {
          const dst = walls.distToResistance || 0
          if (dst < atrW * 1.5) {
            const lbl = walls.nearestResistance?.label || 'resistance'
            const prc = walls.nearestResistance?.price || '?'
            await log('filter', `⛔ BLOCKED LONG — near ${lbl}@${prc} (${dst}pts < ${(atrW*1.5).toFixed(0)}pts ATR)`); return
          }
        }
        if (isSell && walls.wallBias === 'nearLower' && hasPDL) {
          const dst = walls.distToSupport || 0
          if (dst < atrW * 1.5) {
            const lbl = walls.nearestSupport?.label || 'support'
            const prc = walls.nearestSupport?.price || '?'
            await log('filter', `⛔ BLOCKED SHORT — near ${lbl}@${prc} (${dst}pts < ${(atrW*1.5).toFixed(0)}pts ATR)`); return
          }
        }
      }
    }

    // Bias filter
    if (bias.direction === 'long'  && isSell) { await log('filter', `⛔ BLOCKED SHORT — bias bullish`); return }
    if (bias.direction === 'short' && isBuy)  { await log('filter', `⛔ BLOCKED LONG — bias bearish`);  return }


    // Block contradicting sweep direction
    if (isBuy  && ind.liquiditySweepHigh[candles.length - 1]) {
      await log('filter', '⛔ BLOCKED LONG — sweepHigh active (bearish signal)')
      return
    }
    if (isSell && ind.liquiditySweepLow[candles.length - 1]) {
      await log('filter', '⛔ BLOCKED SHORT — sweepLow active (bullish signal)')
      return
    }

    // Neutral bias — require HTF confirmation
    if (bias.direction === 'both') {
      const hasHTFConfirmation = htfSweeps.sweepStrength > 0 ||
                                 nearLevels.some(l => l.strength >= 3)
      if (!hasHTFConfirmation) {
        await log('filter', '⛔ BLOCKED — neutral bias, no HTF confirmation')
        return
      }
      console.log(`[BIAS] Neutral override — HTF confirmation present`)
    }

const signalScore = signal.score || 4

    // Learning filter
    const allowed = await canTrade(signal.factors || {})
    if (!allowed) { await log('filter', `⛔ BLOCKED — negative expectancy`); return }

    // Dynamic risk
    const side    = isBuy ? 'LONG' : 'SHORT'
    const account = await getAccount()
    // Score bonus for HTF sweeps + key level confluence
    const htfBonus2  = htfSweeps.sweepStrength || 0
    const keyBonus   = nearLevels.some(l => l.strength >= 3) ? 1 : 0
    const boostedScore = (signal.score || 4) + htfBonus2 + keyBonus
    if (htfBonus2 > 0 || keyBonus > 0) console.log(`[SCORE] HTF:+${htfBonus2} KeyLevel:+${keyBonus} → score:${boostedScore}`)
    const risk    = await calcDynamicRisk(candles, side, currentPrice, signal.factors || {}, account.balance, boostedScore)

    await openTrade(trades, {
      side,
      entryPrice: currentPrice,
      contracts:  risk.contracts,
      stopLoss:   risk.stopPrice,
      takeProfit: risk.targetPrice,
    })

    await log('trade',
      `Opened ${side} ${risk.contracts}x @ ${currentPrice}`,
      `SL:${risk.stopPrice} TP:${risk.targetPrice} RR:${risk.rrRatio} score:${signal.score || 4} bias:${bias.direction}`
    )

    // ── TradersPost — real eval execution ────────────────────────
    const TP_WEBHOOK = process.env.TRADERSPOST_WEBHOOK_URL
    if (TP_WEBHOOK) {
      try {
        const tpRes = await fetch(TP_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
           ticker:    'MNQ1!',
            action:    side === 'LONG' ? 'buy' : 'sell',
            quantity:  risk.contracts,
            stopLoss:  { type: 'stop', stopPrice: risk.stopPrice },
            takeProfit: { type: 'limit', limitPrice: risk.targetPrice },
          })
        })
        const tpData = await tpRes.json().catch(() => ({}))
        if (tpData.success) {
          console.log(`[TRADERSPOST] ✅ ${side} ${risk.contracts}x confirmed | id:${tpData.id}`)
          await log('trade', `TradersPost order confirmed`, `${side} ${risk.contracts}x @ ${currentPrice} | id:${tpData.id}`)
        } else {
          console.log(`[TRADERSPOST] ⚠️ Order not confirmed: ${JSON.stringify(tpData)}`)
          await log('error', `TradersPost order failed`, JSON.stringify(tpData))
        }
      } catch (e) {
        console.error(`[TRADERSPOST] Failed: ${e.message}`)
        await log('error', `TradersPost failed`, e.message)
      }
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────
console.log('🤖 TradingBot — Railway 24/7')
console.log(`   Poll: every ${POLL_MS/60000}min | Bias: hourly | Risk: score+ATR+$500cap`)

process.on('SIGTERM', () => console.log('SIGTERM ignored'))
process.on('SIGINT',  () => console.log('SIGINT ignored'))
process.on('uncaughtException',  e => console.error('Uncaught:', e.message))
process.on('unhandledRejection', e => console.error('Unhandled:', e?.message || e))

// Fast loop — check SL/TP every 1 minute
async function fastCheck() {
  try {
    const trades  = await getTrades()
    const openPos = getOpenPos(trades)
    if (!openPos) return

    const res  = await fetch('https://tv-price-feed-production.up.railway.app/bars')
    const data = await res.json()
    const bars = data.bars || []
    if (bars.length === 0) return

    const bar   = bars[bars.length - 1]
    const price = bar.close
    const barLow  = bar.low  || price
    const barHigh = bar.high || price
    console.log(`[FAST] Price:${price} Low:${barLow} High:${barHigh} | ${openPos.side} SL:${openPos.stopLoss} TP:${openPos.takeProfit}`)

    if (openPos.stopLoss) {
      // Use bar low/high (wick check) to match real tick-by-tick execution
      const slHit = openPos.side === 'LONG' ? barLow <= openPos.stopLoss : barHigh >= openPos.stopLoss
      if (slHit) {
        console.log(`🛑 SL HIT (wick) @ ${openPos.stopLoss} | Bar low:${barLow}`)
        await closeTrade(trades, openPos.stopLoss, 'stopLoss')
        await log('trade', `Stop loss hit @ ${openPos.stopLoss}`, `SL was ${openPos.stopLoss} | bar low:${barLow}`)
        return
      }
    }

    if (openPos.takeProfit) {
      // Use bar high/low (wick check) to match real tick-by-tick execution
      const tpHit = openPos.side === 'LONG' ? barHigh >= openPos.takeProfit : barLow <= openPos.takeProfit
      if (tpHit) {
        console.log(`🎯 TP HIT (wick) @ ${openPos.takeProfit} | Bar high:${barHigh}`)
        await closeTrade(trades, openPos.takeProfit, 'takeProfit')
        await log('trade', `Take profit hit @ ${openPos.takeProfit}`, `TP was ${openPos.takeProfit} | bar high:${barHigh}`)
        return
      }
    }

    const pts = openPos.side === 'LONG' ? price - openPos.entryPrice : openPos.entryPrice - price
    const pnl = pts * MULTIPLIER * (openPos.quantity || 1)
    console.log(`[POSITION] Unrealized: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`)

  } catch (e) { console.error('Fast check error:', e.message) }
}

runCycle()
setInterval(runCycle, POLL_MS)
setInterval(fastCheck, 60_000)

// EOD peak balance update at 4am UTC
setInterval(async () => {
  const now = new Date()
  if (now.getUTCHours() === 4 && now.getUTCMinutes() < 6) {
    try {
      const account = await getAccount()
      const stats   = await sbGet('bot_stats', 'main') || {}
      const evalS   = stats.eval || {}
      const peak    = evalS.peakEodBalance || EVAL_ACCOUNT_SIZE
      if (account.balance > peak) {
        evalS.peakEodBalance = account.balance
        stats.eval = evalS
        await sbSet('bot_stats', stats, 'main')
        console.log(`[EVAL] EOD peak: $${account.balance.toFixed(0)} → floor: $${(account.balance - EVAL_MAX_DRAWDOWN).toFixed(0)}`)
      }
    } catch (e) { console.error('EOD update error:', e.message) }
  }
}, 60_000)

setInterval(() => console.log('💓 heartbeat'), 30_000)
