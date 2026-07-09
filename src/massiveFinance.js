// Massive.com — real CME futures data via REST API.
// Replaces Yahoo Finance entirely. No 60-day limits, no unreliable
// intraday data, real ES/NQ futures bars going back 7+ years.
//
// API key goes in .env as VITE_MASSIVE_API_KEY
// Docs: https://massive.com/docs/rest/futures/aggregates
//
// Massive uses rolling front-month contract tickers (e.g. ESM5, ESU5).
// We automatically resolve the correct front-month contract for any
// date range so you never have to think about contract expiry.

const BASE_URL = 'https://api.massive.com'

// ── Contract symbols ─────────────────────────────────────────────
export const FUTURES_SYMBOLS = {
  ES: { code: 'ES', label: 'E-mini S&P 500 (ES)' },
  NQ: { code: 'NQ', label: 'E-mini Nasdaq-100 (NQ)' },
}

// ── Timeframes — Massive supports sec/min/hour/session/week/month ─
export const TIMEFRAMES = [
  { value: '1m',  label: '1 minute',   massive: { resolution: '1min'    } },
  { value: '5m',  label: '5 minutes',  massive: { resolution: '5min'    } },
  { value: '15m', label: '15 minutes', massive: { resolution: '15min'   } },
  { value: '30m', label: '30 minutes', massive: { resolution: '30min'   } },
  { value: '1h',  label: '1 hour',     massive: { resolution: '1hour'   } },
  { value: '4h',  label: '4 hours',    massive: { resolution: '4hour'   } },
  { value: '1d',  label: '1 day',      massive: { resolution: '1session'} },
]

// ── ES/NQ contract expiry months: Mar(H), Jun(M), Sep(U), Dec(Z) ─
const EXPIRY_MONTHS = [3, 6, 9, 12]
const MONTH_CODES   = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' }

// Returns the front-month contract ticker for a given date
// e.g. new Date('2024-07-15') → 'ESU4' (Sep 2024 contract)
function getFrontMonthTicker(code, date) {
  const d = new Date(date)
  const year = d.getFullYear()
  const month = d.getMonth() + 1 // 1-12

  // Find the next expiry month >= current month
  let expiryMonth = EXPIRY_MONTHS.find(m => m >= month)
  let expiryYear = year

  if (!expiryMonth) {
    expiryMonth = EXPIRY_MONTHS[0] // wrap to March of next year
    expiryYear = year + 1
  }

  const yearCode = String(expiryYear).slice(-1) // last digit of year
  return `${code}${MONTH_CODES[expiryMonth]}${yearCode}`
}

// For a date range spanning multiple contracts, collect all needed tickers
function getContractTickers(code, fromDate, toDate) {
  const tickers = new Set()
  const start = new Date(fromDate)
  const end = new Date(toDate)

  // Walk month by month and collect all front-month tickers needed
  const cursor = new Date(start)
  cursor.setDate(1)
  while (cursor <= end) {
    tickers.add(getFrontMonthTicker(code, cursor))
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return [...tickers]
}

// ── Core fetch for one contract ticker over a date range ─────────
async function fetchContractBars(ticker, resolution, fromDate, toDate) {
  const apiKey = import.meta.env.VITE_MASSIVE_API_KEY
  if (!apiKey) throw new Error('Missing VITE_MASSIVE_API_KEY in .env file')

  const url = `${BASE_URL}/futures/v1/aggs/${encodeURIComponent(ticker)}` +
    `?resolution=${resolution}` +
    `&window_start.gte=${fromDate}` +
    `&window_start.lte=${toDate}` +
    `&limit=50000` +
    `&sort=window_start.asc` +
    `&apiKey=${apiKey}`

  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Massive API error ${res.status}: ${err.message || res.statusText}`)
  }

  const data = await res.json()
  if (data.status === 'ERROR') throw new Error(`Massive: ${data.error}`)

  return (data.results || []).map(bar => ({
    time:   bar.window_start / 1e6,  // nanoseconds → milliseconds
    open:   bar.open,
    high:   bar.high,
    low:    bar.low,
    close:  bar.close,
    volume: bar.volume || 0,
  }))
}

// ── Fetch bars for a specific calendar month ─────────────────────
export async function fetchMonthRange(symbolKey, timeframe, year, month) {
  const { code } = FUTURES_SYMBOLS[symbolKey] || FUTURES_SYMBOLS.ES
  const tf = TIMEFRAMES.find(t => t.value === timeframe) || TIMEFRAMES[1]
  const resolution = tf.massive.resolution

  const start = new Date(year, month - 1, 1)
  const end   = new Date(year, month, 0) // last day of month

  const fromDate = start.toISOString().slice(0, 10)
  const toDate   = end.toISOString().slice(0, 10)

  const tickers = getContractTickers(code, fromDate, toDate)
  let allBars = []

  for (const ticker of tickers) {
    const bars = await fetchContractBars(ticker, resolution, fromDate, toDate)
    allBars = allBars.concat(bars)
    if (tickers.length > 1) await sleep(200)
  }

  return dedupeAndSort(allBars)
}

// ── Fetch multiple specific months and stitch together ───────────
export async function fetchSelectedMonths(symbolKey, timeframe, monthList) {
  // monthList = [{ year, month, key, label }, ...]
  const sorted = [...monthList].sort((a, b) => a.key.localeCompare(b.key))
  let allBars = []

  for (const { year, month } of sorted) {
    const bars = await fetchMonthRange(symbolKey, timeframe, year, month)
    allBars = allBars.concat(bars)
    if (sorted.length > 1) await sleep(200)
  }

  return dedupeAndSort(allBars)
}

// ── Fetch both ES and NQ for SMT divergence ──────────────────────
export async function fetchCorrelatedPair(timeframe, monthList) {
  const [es, nq] = await Promise.all([
    fetchSelectedMonths('ES', timeframe, monthList),
    fetchSelectedMonths('NQ', timeframe, monthList),
  ])
  return { es, nq }
}

// ── Available months picker — last 30 months ─────────────────────
export function getAvailableMonths(lookbackMonths = 30) {
  const months = []
  const now = new Date()
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

// ── Utilities ────────────────────────────────────────────────────
function dedupeAndSort(bars) {
  const seen = new Set()
  return bars
    .filter(c => {
      if (seen.has(c.time)) return false
      seen.add(c.time)
      return true
    })
    .sort((a, b) => a.time - b.time)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Fetch the single most recent bar for live price polling ──────
// Used by LiveMode to poll current price every 60 seconds.
// Uses 1-minute bars with sort=desc + limit=1 for lowest latency.
export async function fetchLatestPrice(symbolKey) {
  const { code } = FUTURES_SYMBOLS[symbolKey] || FUTURES_SYMBOLS.NQ
  const apiKey   = import.meta.env.VITE_MASSIVE_API_KEY
  if (!apiKey) throw new Error('Missing VITE_MASSIVE_API_KEY in .env')

  const today  = new Date().toISOString().slice(0, 10)
  const ticker = getFrontMonthTicker(code, new Date())

  const url = `${BASE_URL}/futures/v1/aggs/${encodeURIComponent(ticker)}` +
    `?resolution=1min` +
    `&window_start.gte=${today}` +
    `&window_start.lte=${today}` +
    `&limit=1` +
    `&sort=window_start.desc` +
    `&apiKey=${apiKey}`

  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Massive ${res.status}: ${err.message || res.statusText}`)
  }

  const data = await res.json()
  if (data.status === 'ERROR') throw new Error(`Massive: ${data.error}`)

  const bar = (data.results || [])[0]
  if (!bar) return null

  return {
    price:  bar.close,
    open:   bar.open,
    high:   bar.high,
    low:    bar.low,
    close:  bar.close,
    time:   bar.window_start / 1e6,  // nanoseconds → milliseconds
    ticker,
  }
}
