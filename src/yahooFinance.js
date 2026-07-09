// Yahoo Finance — free, unofficial historical data for ES/NQ futures.
// No API key, no signup. Routed through Vite's dev server proxy
// (see vite.config.js) to avoid browser CORS restrictions.
//
// Honest caveats: this is delayed data (~15-20 min) and not an official
// licensed feed. Great for backtesting, not for live trading.
//
// Yahoo's intraday hard limit per request: 60 days for anything under 1h.
// We work around this by making multiple consecutive 60-day window
// requests and stitching them together — so 3 months of 5m data becomes
// two back-to-back fetches of 60 days each, then merged and deduplicated.

export const FUTURES_SYMBOLS = {
  ES: { symbol: 'ES=F', label: 'E-mini S&P 500 (ES)' },
  NQ: { symbol: 'NQ=F', label: 'E-mini Nasdaq-100 (NQ)' },
}

export const TIMEFRAMES = [
  { value: '1m',  label: '1 minute' },
  { value: '2m',  label: '2 minutes' },
  { value: '5m',  label: '5 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h',  label: '1 hour' },
  { value: '2h',  label: '2 hours' },
  { value: '4h',  label: '4 hours' },
  { value: '1d',  label: '1 day' },
]

export const RANGE_OPTIONS = {
  '1m': [
    { value: 7,    label: '7 days (max per request)' },
  ],
  '2m': [
    { value: 30,   label: '1 month' },
    { value: 60,   label: '2 months' },
    { value: 120,  label: '4 months' },
  ],
  '5m': [
    { value: 30,   label: '1 month' },
    { value: 60,   label: '2 months' },
    { value: 90,   label: '3 months' },
    { value: 120,  label: '4 months' },
  ],
  '15m': [
    { value: 30,   label: '1 month' },
    { value: 60,   label: '2 months' },
    { value: 90,   label: '3 months' },
    { value: 120,  label: '4 months' },
  ],
  '30m': [
    { value: 30,   label: '1 month' },
    { value: 60,   label: '2 months' },
    { value: 90,   label: '3 months' },
    { value: 120,  label: '4 months' },
  ],
  '1h': [
    { value: 90,   label: '3 months' },
    { value: 180,  label: '6 months' },
    { value: 365,  label: '1 year' },
    { value: 730,  label: '2 years (max for 1h)' },
  ],
  '2h': [
    { value: 180,  label: '6 months' },
    { value: 365,  label: '1 year' },
    { value: 730,  label: '2 years' },
  ],
  '4h': [
    { value: 180,  label: '6 months' },
    { value: 365,  label: '1 year' },
    { value: 730,  label: '2 years' },
  ],
  '1d': [
    { value: 365,  label: '1 year' },
    { value: 730,  label: '2 years' },
    { value: 1825, label: '5 years' },
  ],
}

export const DEFAULT_RANGE = {
  '1m':  7,
  '2m':  60,
  '5m':  90,
  '15m': 90,
  '30m': 90,
  '1h':  365,
  '2h':  365,
  '4h':  365,
  '1d':  730,
}

// Per-request window size in days — Yahoo enforces this per fetch for intraday
const WINDOW_DAYS = {
  '1m': 7, '2m': 60, '5m': 60, '15m': 60, '30m': 60,
  '1h': 730, '2h': 730, '4h': 730, '1d': 3650,
}

const TF_CONFIG = {
  '1m':  { interval: '1m',  aggregate: 1 },
  '2m':  { interval: '2m',  aggregate: 1 },
  '5m':  { interval: '5m',  aggregate: 1 },
  '15m': { interval: '15m', aggregate: 1 },
  '30m': { interval: '30m', aggregate: 1 },
  '1h':  { interval: '60m', aggregate: 1 },
  '2h':  { interval: '60m', aggregate: 2 },
  '4h':  { interval: '60m', aggregate: 4 },
  '1d':  { interval: '1d',  aggregate: 1 },
}

const DAY_MS = 86400 * 1000

// ── Fetch one window of raw bars using period1/period2 timestamps ──
async function fetchWindow(symbol, interval, fromMs, toMs) {
  const p1 = Math.floor(fromMs / 1000)
  const p2 = Math.floor(toMs / 1000)
  const url = `/yahoo-api/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${p1}&period2=${p2}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`)

  const data = await res.json()
  const result = data?.chart?.result?.[0]
  if (!result) return []

  const timestamps = result.timestamp || []
  const quote = result.indicators?.quote?.[0] || {}

  return timestamps
    .map((t, i) => ({
      time:   t * 1000,
      open:   quote.open?.[i],
      high:   quote.high?.[i],
      low:    quote.low?.[i],
      close:  quote.close?.[i],
      volume: quote.volume?.[i] || 0,
    }))
    .filter(c => c.open != null && c.high != null && c.low != null && c.close != null)
}

// ── Fetch OHLCV candles — stitches multiple windows if needed ───
export async function fetchFuturesCandles(symbolKey, timeframe = '1h', totalDays = null) {
  const { symbol } = FUTURES_SYMBOLS[symbolKey] || FUTURES_SYMBOLS.ES
  const { interval, aggregate } = TF_CONFIG[timeframe] || TF_CONFIG['1h']
  const days = totalDays || DEFAULT_RANGE[timeframe] || 60
  const windowDays = WINDOW_DAYS[timeframe] || 60

  const now = Date.now()
  const windows = []

  // Build non-overlapping windows going backwards from today
  for (let end = now; end > now - days * DAY_MS; end -= windowDays * DAY_MS) {
    const start = Math.max(end - windowDays * DAY_MS, now - days * DAY_MS)
    windows.unshift({ from: start, to: end })
  }

  // Fetch all windows, with a small delay between requests to avoid rate limiting
  let allBars = []
  for (const w of windows) {
    const bars = await fetchWindow(symbol, interval, w.from, w.to)
    allBars = allBars.concat(bars)
    if (windows.length > 1) await sleep(300) // be polite to Yahoo's servers
  }

  // Deduplicate by timestamp and sort ascending
  const seen = new Set()
  allBars = allBars
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true })
    .sort((a, b) => a.time - b.time)

  if (aggregate > 1) allBars = aggregateBars(allBars, aggregate)

  return allBars
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Aggregate N raw bars into one larger bar ─────────────────────
function aggregateBars(bars, n) {
  const out = []
  for (let i = 0; i < bars.length; i += n) {
    const chunk = bars.slice(i, i + n)
    if (!chunk.length) continue
    out.push({
      time:   chunk[0].time,
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(c => c.high)),
      low:    Math.min(...chunk.map(c => c.low)),
      close:  chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    })
  }
  return out
}

// ── Fetch a specific calendar month ─────────────────────────────
export async function fetchMonthRange(symbolKey, timeframe, year, month) {
  const { symbol } = FUTURES_SYMBOLS[symbolKey] || FUTURES_SYMBOLS.ES
  const { interval, aggregate } = TF_CONFIG[timeframe] || TF_CONFIG['1h']

  const start = new Date(year, month - 1, 1)
  const end   = new Date(year, month, 1) // first day of NEXT month
  const fromMs = start.getTime()
  const toMs   = end.getTime()

  // For intraday intervals Yahoo caps at 60 days per request, but a
  // single calendar month is always ≤ 31 days so one request is enough.
  let bars = await fetchWindow(symbol, interval, fromMs, toMs)
  if (aggregate > 1) bars = aggregateBars(bars, aggregate)
  return bars
}

// ── Fetch multiple specific months and stitch them together ───────
export async function fetchSelectedMonths(symbolKey, timeframe, monthList) {
  // monthList = [{ year: 2024, month: 7 }, { year: 2024, month: 8 }, ...]
  let allBars = []
  for (const { year, month } of monthList) {
    const bars = await fetchMonthRange(symbolKey, timeframe, year, month)
    allBars = allBars.concat(bars)
    if (monthList.length > 1) await sleep(250)
  }
  // Deduplicate and sort ascending
  const seen = new Set()
  return allBars
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true })
    .sort((a, b) => a.time - b.time)
}

// ── Generate a list of available months going back N months ───────
export function getAvailableMonths(lookbackMonths = 30) {
  const months = []
  const now = new Date()
  for (let i = 1; i <= lookbackMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: d.toLocaleString('default', { month: 'long', year: 'numeric' }),
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    })
  }
  return months
}
export async function fetchCorrelatedPair(timeframe = '1h', totalDays = null) {
  const [es, nq] = await Promise.all([
    fetchFuturesCandles('ES', timeframe, totalDays),
    fetchFuturesCandles('NQ', timeframe, totalDays),
  ])
  return { es, nq }
}
