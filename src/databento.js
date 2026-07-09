// Databento Historical API — fetches real CME futures OHLCV bars
// Docs: https://databento.com/docs/api-reference-historical

const DATABENTO_HIST_URL = 'https://hist.databento.com/v0/timeseries.get_range'

// Continuous front-month contract symbols (auto-rolls to the active contract)
export const FUTURES_SYMBOLS = {
  ES: { symbol: 'ES.c.0', label: 'E-mini S&P 500 (ES)' },
  NQ: { symbol: 'NQ.c.0', label: 'E-mini Nasdaq-100 (NQ)' },
}

const TIMEFRAME_TO_SCHEMA = {
  '1m':  'ohlcv-1m',
  '5m':  'ohlcv-1m', // aggregated client-side from 1m bars
  '15m': 'ohlcv-1m', // aggregated client-side from 1m bars
  '1h':  'ohlcv-1h',
  '1d':  'ohlcv-1d',
}

function getApiKey() {
  const key = import.meta.env.VITE_DATABENTO_API_KEY
  if (!key) {
    throw new Error(
      'No Databento API key found. Add VITE_DATABENTO_API_KEY to your .env file.'
    )
  }
  return key
}

// ── Fetch raw OHLCV bars for a single symbol ──────────────────
export async function fetchFuturesCandles(symbolKey, timeframe = '1h', daysBack = 30) {
  const apiKey = getApiKey()
  const { symbol } = FUTURES_SYMBOLS[symbolKey] || FUTURES_SYMBOLS.ES
  const schema = TIMEFRAME_TO_SCHEMA[timeframe] || 'ohlcv-1h'

  const end = new Date()
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000)

  const params = new URLSearchParams({
    dataset: 'GLBX.MDP3',
    symbols: symbol,
    schema,
    start: start.toISOString(),
    end: end.toISOString(),
    stype_in: 'continuous',
    encoding: 'json',
  })

  const res = await fetch(`${DATABENTO_HIST_URL}?${params}`, {
    headers: {
      // Databento historical API uses HTTP Basic Auth: API key as username, blank password
      Authorization: 'Basic ' + btoa(`${apiKey}:`),
    },
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Databento API error ${res.status}: ${errText.slice(0, 200)}`)
  }

  // Response is newline-delimited JSON
  const text = await res.text()
  const rows = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))

  let candles = rows.map(r => ({
    time:   Math.floor(Number(r.hd?.ts_event ?? r.ts_event) / 1e6), // ns -> ms
    open:   Number(r.open)  / 1e9, // prices are fixed-point 1e-9
    high:   Number(r.high)  / 1e9,
    low:    Number(r.low)   / 1e9,
    close:  Number(r.close) / 1e9,
    volume: Number(r.volume),
  }))

  // Client-side aggregation for 5m/15m since Databento doesn't have those schemas directly
  if (timeframe === '5m') candles = aggregateBars(candles, 5)
  if (timeframe === '15m') candles = aggregateBars(candles, 15)

  return candles
}

// ── Aggregate 1-minute bars into N-minute bars ─────────────────
function aggregateBars(oneMinBars, n) {
  const out = []
  for (let i = 0; i < oneMinBars.length; i += n) {
    const chunk = oneMinBars.slice(i, i + n)
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

// ── Fetch both ES and NQ together for SMT divergence ───────────
export async function fetchCorrelatedPair(timeframe = '1h', daysBack = 30) {
  const [es, nq] = await Promise.all([
    fetchFuturesCandles('ES', timeframe, daysBack),
    fetchFuturesCandles('NQ', timeframe, daysBack),
  ])
  return { es, nq }
}

// ── Fetch the single most recent 1-minute bar for live price ───────────────
// ONLY used in LiveMode — polled every 60s for current NQ price.
// Uses continuous front-month (NQ.c.0) so you never need to roll contracts.
// Cost: ~200 bytes/call × 60 calls/hour × 7 hours = ~84 KB/day ≈ $0.001/day
// The $125 free credits will last months at this usage rate.
export async function fetchLatestPrice(symbolKey = 'NQ') {
  const apiKey = getApiKey()
  const { symbol } = FUTURES_SYMBOLS[symbolKey] || FUTURES_SYMBOLS.NQ

  // Request last 5 minutes — guarantees at least one completed 1-min bar
  const end   = new Date()
  const start = new Date(end.getTime() - 5 * 60 * 1000)

  const params = new URLSearchParams({
    dataset:  'GLBX.MDP3',
    symbols:  symbol,
    schema:   'ohlcv-1m',
    start:    start.toISOString(),
    end:      end.toISOString(),
    stype_in: 'continuous',
    encoding: 'json',
    limit:    '5',
  })

  const res = await fetch(`${DATABENTO_HIST_URL}?${params}`, {
    headers: { Authorization: 'Basic ' + btoa(`${apiKey}:`) },
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Databento ${res.status}: ${errText.slice(0, 120)}`)
  }

  // Databento returns newline-delimited JSON (one record per line)
  const text  = await res.text()
  const lines = text.trim().split('\n').filter(Boolean)
  if (lines.length === 0) return null  // market closed or pre-market

  // Most recent bar is the last line
  const r = JSON.parse(lines[lines.length - 1])

  return {
    price:  Number(r.close)  / 1e9,  // Databento prices are fixed-point 1e-9
    open:   Number(r.open)   / 1e9,
    high:   Number(r.high)   / 1e9,
    low:    Number(r.low)    / 1e9,
    close:  Number(r.close)  / 1e9,
    volume: Number(r.volume),
    time:   Math.floor(Number(r.hd?.ts_event ?? r.ts_event) / 1e6), // ns → ms
    symbol,
  }
}
