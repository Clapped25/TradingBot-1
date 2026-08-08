// Massive.com — real CME NQ futures data for backtesting
// Free tier: 5 API calls/minute — we add delays to stay under limit
// API key in Vercel env as VITE_MASSIVE_API_KEY

const BASE_URL    = 'https://api.massive.com'
const CACHE_PREFIX = 'massive_bars_'
const RATE_LIMIT_MS = 13000  // 13 seconds between calls = max 4.6 calls/min (safe under 5/min limit)

let lastCallTime = 0

async function rateLimitedFetch(url) {
  const now     = Date.now()
  const elapsed = now - lastCallTime
  if (elapsed < RATE_LIMIT_MS) {
    const wait = RATE_LIMIT_MS - elapsed
    console.log(`[Massive] Rate limiting — waiting ${(wait/1000).toFixed(1)}s...`)
    await new Promise(r => setTimeout(r, wait))
  }
  lastCallTime = Date.now()
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Massive API error ${res.status}: ${err.message || res.statusText}`)
  }
  const data = await res.json()
  if (data.status === 'ERROR') throw new Error(`Massive: ${data.error}`)
  return data
}

// ── Cache helpers ─────────────────────────────────────────────────
function cacheKey(ticker, resolution, year, month) {
  return `${CACHE_PREFIX}${ticker}_${resolution}_${year}_${String(month).padStart(2,'0')}`
}

function getCached(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const { bars, ts } = JSON.parse(raw)
    // Cache past months forever, current month for 1 hour
    const now = Date.now()
    const age = now - ts
    const oneHour = 60 * 60 * 1000
    if (age > oneHour && key.includes(new Date().toISOString().slice(0,7).replace('-','_'))) {
      localStorage.removeItem(key); return null
    }
    return bars
  } catch { return null }
}

function setCache(key, bars) {
  try {
    localStorage.setItem(key, JSON.stringify({ bars, ts: Date.now() }))
  } catch {
    // localStorage full — clear oldest cache entries
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .slice(0, 5)
      .forEach(k => localStorage.removeItem(k))
    try { localStorage.setItem(key, JSON.stringify({ bars, ts: Date.now() })) } catch {}
  }
}

// ── Symbols ───────────────────────────────────────────────────────
export const FUTURES_SYMBOLS = {
  ES: { code: 'ES', label: 'E-mini S&P 500 (ES)' },
  NQ: { code: 'NQ', label: 'E-mini Nasdaq-100 (NQ)' },
}

export const TIMEFRAMES = [
  { value: '1m',  label: '1 minute',   massive: { resolution: '1min'  } },
  { value: '5m',  label: '5 minutes',  massive: { resolution: '5min'  } },
  { value: '15m', label: '15 minutes', massive: { resolution: '15min' } },
  { value: '30m', label: '30 minutes', massive: { resolution: '30min' } },
  { value: '1h',  label: '1 hour',     massive: { resolution: '1hour' } },
  { value: '4h',  label: '4 hours',    massive: { resolution: '4hour' } },
  { value: '1d',  label: '1 day',      massive: { resolution: '1session' } },
]

// ── Front month ticker ────────────────────────────────────────────
const EXPIRY_MONTHS = [3, 6, 9, 12]
const MONTH_CODES   = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' }

function getFrontMonthTicker(code, date) {
  const d     = new Date(date)
  const year  = d.getFullYear()
  const month = d.getMonth() + 1
  let expiryMonth = EXPIRY_MONTHS.find(m => m >= month)
  let expiryYear  = year
  if (!expiryMonth) { expiryMonth = EXPIRY_MONTHS[0]; expiryYear = year + 1 }
  return `${code}${MONTH_CODES[expiryMonth]}${String(expiryYear).slice(-1)}`
}

function getContractTickers(code, fromDate, toDate) {
  const tickers = new Set()
  const cursor  = new Date(fromDate)
  cursor.setDate(1)
  const end = new Date(toDate)
  while (cursor <= end) {
    tickers.add(getFrontMonthTicker(code, cursor))
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return [...tickers]
}

// ── Core fetch ────────────────────────────────────────────────────
async function fetchContractBars(ticker, resolution, fromDate, toDate) {
  const apiKey = import.meta.env.VITE_MASSIVE_API_KEY
  if (!apiKey) throw new Error('Missing VITE_MASSIVE_API_KEY in Vercel environment variables')

  const url = `${BASE_URL}/futures/v1/aggs/${encodeURIComponent(ticker)}` +
    `?resolution=${resolution}` +
    `&window_start.gte=${fromDate}` +
    `&window_start.lte=${toDate}` +
    `&limit=50000` +
    `&sort=window_start.asc` +
    `&apiKey=${apiKey}`

  const data = await rateLimitedFetch(url)
  return (data.results || []).map(bar => ({
    time:   bar.window_start / 1e6,
    open:   bar.open,
    high:   bar.high,
    low:    bar.low,
    close:  bar.close,
    volume: bar.volume || 0,
  }))
}

// ── Public API ────────────────────────────────────────────────────
export async function fetchMonthRange(symbolKey, timeframe, year, month) {
  const { code } = FUTURES_SYMBOLS[symbolKey] || FUTURES_SYMBOLS.NQ
  const tf         = TIMEFRAMES.find(t => t.value === timeframe) || TIMEFRAMES[1]
  const resolution = tf.massive.resolution

  const start    = new Date(year, month - 1, 1)
  const end      = new Date(year, month, 0)
  const fromDate = start.toISOString().slice(0, 10)
  const toDate   = end.toISOString().slice(0, 10)
  const tickers  = getContractTickers(code, fromDate, toDate)

  let allBars = []
  for (const ticker of tickers) {
    const key    = cacheKey(ticker, resolution, year, month)
    const cached = getCached(key)
    if (cached) {
      console.log(`[Massive] Cache hit: ${ticker} ${year}-${month} (${cached.length} bars)`)
      allBars = allBars.concat(cached)
      continue
    }
    console.log(`[Massive] Fetching ${ticker} ${resolution} ${fromDate} → ${toDate}...`)
    const bars = await fetchContractBars(ticker, resolution, fromDate, toDate)
    setCache(key, bars)
    console.log(`[Massive] Got ${bars.length} bars — cached`)
    allBars = allBars.concat(bars)
  }

  return dedupeAndSort(allBars)
}

export async function fetchSelectedMonths(symbolKey, timeframe, monthList) {
  const sorted = [...monthList].sort((a, b) => a.key.localeCompare(b.key))
  let allBars  = []
  for (const { year, month } of sorted) {
    const bars = await fetchMonthRange(symbolKey, timeframe, year, month)
    allBars    = allBars.concat(bars)
  }
  return dedupeAndSort(allBars)
}

export async function fetchCorrelatedPair(timeframe, monthList) {
  const [es, nq] = await Promise.all([
    fetchSelectedMonths('ES', timeframe, monthList),
    fetchSelectedMonths('NQ', timeframe, monthList),
  ])
  return { es, nq }
}

export function getAvailableMonths(lookbackMonths = 24) {
  const months = []
  const now    = new Date()
  for (let i = 1; i <= lookbackMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      year:  d.getFullYear(),
      month: d.getMonth() + 1,
      label: d.toLocaleString('default', { month: 'long', year: 'numeric' }),
      key:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    })
  }
  return months
}

// fetchLatestPrice reads from TV feed for live price
export async function fetchLatestPrice(symbolKey) {
  try {
    const res  = await fetch('https://tv-price-feed-production.up.railway.app/bars')
    const data = await res.json()
    const bars = data.bars || []
    if (!bars.length) return null
    const bar  = bars[bars.length - 1]
    return { price: bar.close, open: bar.open, high: bar.high, low: bar.low, close: bar.close, time: bar.time }
  } catch { return null }
}

// ── Utilities ─────────────────────────────────────────────────────
function dedupeAndSort(bars) {
  const seen = new Set()
  return bars
    .filter(b => { if (seen.has(b.time)) return false; seen.add(b.time); return true })
    .sort((a, b) => a.time - b.time)
}
