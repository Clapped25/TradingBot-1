// Use proxy on Vercel, direct on localhost
const IS_LOCAL      = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
const ANTHROPIC_URL = IS_LOCAL ? 'https://api.anthropic.com/v1/messages' : '/api/anthropic'
const TRANSCRIPT_URL = (videoId) => IS_LOCAL
  ? `https://youtubetranscript.com/?server_vid=${videoId}`
  : `/api/transcript?videoId=${videoId}`

// ── Parse a strategy JSON response, with a precise diagnosis if it
// got cut off mid-response (the actual cause of "Unterminated string"
// errors) rather than just surfacing the raw parse error ───────────
function parseStrategyResponse(data, text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude\'s response was cut off before it finished (hit the response length limit) — this is why the JSON looked broken. Try again; if it keeps happening on the same strategy, it may be too complex to merge in one pass.')
  }
  if (!match) throw new Error('Claude did not return a valid strategy. Try adding a description.')
  try {
    const parsed = JSON.parse(match[0])
    // Always keep indicators and indicatorDefs in sync
    // so both BacktestResults and LiveMode work correctly
    if (parsed.indicators && !parsed.indicatorDefs) {
      parsed.indicatorDefs = parsed.indicators
    }
    if (parsed.indicatorDefs && !parsed.indicators) {
      parsed.indicators = parsed.indicatorDefs
    }
    return parsed
  } catch (e) {
    throw new Error(`Claude returned malformed JSON (${e.message}). Try again.`)
  }
}

// ── Shared transcript fetcher ──────────────────────────────────
async function fetchYouTubeTranscript(url) {
  if (!url) return ''
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  if (!match) return ''
  try {
    const res = await fetch(TRANSCRIPT_URL(match[1]))
    const text = await res.text()
    const parts = (text.match(/<text[^>]*>([^<]+)<\/text>/g) || [])
      .map(x => x.replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"'))
    return parts.join(' ').substring(0, 3000)
  } catch {
    return '' // transcript unavailable — caller continues without it
  }
}

const INDICATOR_REFERENCE = `Available indicator/detector ids you can reference in the signal function (via ind.<id>?.[i], each is a boolean array unless noted):
- swingHigh, swingLow — confirmed swing points
- bullishFVG, bearishFVG — true the bar price first taps back into a fair value gap
- bullishIFVG, bearishIFVG — true when an FVG gets fully violated and flips bias
- liquiditySweepLow, liquiditySweepHigh — true when price wicks beyond a swing point and reverses (stop hunt)
- rejectionBlockBullish, rejectionBlockBearish — true on a candle with a long rejecting wick
- bosBullish, bosBearish — true when price closes beyond a confirmed swing point (break of structure)
- cisdBullish, cisdBearish — true when a candle closes back through the open of the most recent opposing candle
- smtBullish, smtBearish — true on SMT divergence between two correlated symbols (only usable if the strategy explicitly needs a correlated pair like ES/NQ)
- You may also include ema/sma/rsi indicators if the source material calls for them`

const STRATEGY_JSON_SHAPE = `{
  "name": "Strategy name",
  "description": "2-3 sentence overview of the strategy",
  "timeframe": "15m",
  "market": "futures",
  "indicators": [
    {"id": "liquiditySweepLow", "type": "smc", "lookback": 5, "label": "Liquidity Sweep (Low)"},
    {"id": "bullishFVG", "type": "smc", "label": "Bullish FVG Touch"},
    {"id": "bosBullish", "type": "smc", "lookback": 5, "label": "Bullish BOS"}
  ],
  "signalBody": "if(i<10)return{action:'none'};\\nconst sweep=ind.liquiditySweepLow?.[i],fvg=ind.bullishFVG?.[i],bos=ind.bosBullish?.[i];\\nif(!pos&&sweep&&ind.bullishFVG?.[i-1])return{action:'buy',reason:'Liquidity sweep of prior low followed by FVG fill',factors:{liquiditySweep:true,fvg:true,bos:Boolean(bos)}};\\nif(pos==='long'&&ind.bosBearish?.[i])return{action:'sell',reason:'Bearish break of structure trend invalidated'};\\nreturn{action:'none'};",
  "entryRules": ["Condition 1", "Condition 2"],
  "exitRules": ["Exit condition"],
  "notes": "Extra tips from the video, including which indicator lookback periods make sense for this timeframe"
}`

const SIGNAL_BODY_SPEC = `The signalBody is a JavaScript function body with params (i, candles, ind, pos):
- Reference detectors as ind.<id>?.[i] using the exact ids from the indicators array
- Return {action:'buy', reason:'...', factors:{...}} for long entry
- The factors object is CRITICAL for the learning system — WITHOUT it the filter cannot work
- ALWAYS include factors on every entry signal, no exceptions
- Use these exact keys when relevant: fvg, ifvg, liquiditySweep, rejectionBlock, bos, cisd, smt, htfBias, session, inducement (boolean values, true only if that condition is actually met)
- Example: factors:{fvg:true, bos:true, liquiditySweep:false, smt:false}
- If you skip factors the learning filter is completely blind — include them always
- Return {action:'sell', reason:'...'} for long exit — factors not required on exit
- Return {action:'none'} when no signal
- Always guard against null/undefined indicator values with ?. and Boolean()`

// ── Extract strategy from YouTube URL using Claude ────────────
export async function extractStrategy(url, notes) {
  const transcript = await fetchYouTubeTranscript(url)

  const prompt = `You are a professional futures trading strategy analyst specializing in price action / smart money concepts (SMC, ICT methodology).
${url ? 'YouTube URL: ' + url : ''}
${transcript ? '\nVideo transcript:\n' + transcript : ''}
${notes ? '\nUser description:\n' + notes : ''}

Extract a complete trading strategy from the above using SMART MONEY / ICT CONCEPTS — fair value gaps, liquidity sweeps, break of structure, rejection blocks, change in state of delivery — NOT simple moving average crossovers, unless the source material specifically describes an indicator-based strategy.

${INDICATOR_REFERENCE}

Return ONLY a raw JSON object (no markdown, no backticks, no explanation):
${STRATEGY_JSON_SHAPE}

${SIGNAL_BODY_SPEC}`

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'No API key found. Create a .env file with VITE_ANTHROPIC_API_KEY=your-key-here'
    )
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: IS_LOCAL
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const data = await res.json()
  if (data.error) throw new Error(data.error.message)

  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  return { strategy: parseStrategyResponse(data, text), transcript }
}

// ── Merge a new video's concepts INTO an existing saved strategy ──
// Different from extractStrategy: this doesn't start fresh, it reads
// the current strategy's full rule set and asks Claude to fold the new
// video's ideas into it — adding compatible confluence factors,
// alternative entries, or sharpening existing rules — while keeping
// it as ONE coherent strategy rather than creating a separate one.
export async function combineStrategy(existingStrategy, url, notes) {
  const transcript = await fetchYouTubeTranscript(url)

  const prompt = `You are merging a new trading video's concepts into an EXISTING strategy. The goal is ONE coherent, combined strategy — not two separate ones.

EXISTING STRATEGY:
Name: ${existingStrategy.name}
Description: ${existingStrategy.description}
Current indicators: ${JSON.stringify(existingStrategy.indicators || [])}
Current entry rules: ${(existingStrategy.entryRules || []).join('; ')}
Current exit rules: ${(existingStrategy.exitRules || []).join('; ')}
Current signal function:
${existingStrategy.signalBody}

NEW MATERIAL TO INCORPORATE:
${url ? 'YouTube URL: ' + url : ''}
${transcript ? '\nVideo transcript:\n' + transcript : ''}
${notes ? '\nUser description:\n' + notes : ''}

Combine the new video's trading concepts into the existing strategy. Use your judgment on the best way to merge them — this could mean:
- Adding new confluence factors that strengthen the existing setup (e.g. the new video adds CISD confirmation to an existing sweep+FVG entry)
- Adding a genuinely alternative, compatible entry path inside the SAME signal function (e.g. "buy on sweep+FVG OR on rejection block+BOS")
- Sharpening or correcting an existing rule if the new video describes a more precise version of the same concept
- If the new video's concept is fundamentally incompatible or redundant, keep the existing strategy mostly as-is and explain why in the notes

IMPORTANT — keep the output compact, since this strategy may get combined with more videos later and needs room to keep growing:
- Write the signalBody as dense, minimal JS — no extra whitespace/blank lines, no redundant comments, short but clear variable names
- Keep "description" to 1 sentence and "notes" to 2-3 short bullet points max
- Don't repeat logic that's already implied — e.g. don't re-explain what an indicator does if it's just being referenced

${INDICATOR_REFERENCE}

Return ONLY a raw JSON object (no markdown, no backticks) for the FULL combined strategy, same shape as a fresh extraction:
${STRATEGY_JSON_SHAPE}

${SIGNAL_BODY_SPEC}

Keep the original strategy "name" unless the combined strategy meaningfully outgrows it.`

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('No API key found. Add VITE_ANTHROPIC_API_KEY to your .env file.')
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: IS_LOCAL
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const data = await res.json()
  if (data.error) throw new Error(data.error.message)

  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  return { strategy: parseStrategyResponse(data, text), transcript }
}

// ── Claude reviews the trade log and suggests improvements ────
export async function getStrategyFeedback(strategy, trades, stats) {
  const exits = trades.filter(t => t.type === 'exit')
  if (!exits.length) {
    throw new Error('No completed trades to analyze yet. Run a backtest first.')
  }

  const losses = exits.filter(t => t.pnlPct < 0)
  const wins   = exits.filter(t => t.pnlPct >= 0)

  const tradeSummary = exits.map((t, i) => {
    const outcome = t.pnlPct >= 0 ? 'WIN' : 'LOSS'
    const mfe = t.mfeR != null ? ` MFE:${t.mfeR}R` : ''
    const mae = t.maeR != null ? ` MAE:${t.maeR}R` : ''
    const regime = t.regime ? ` regime:${t.regime}` : ''
    return `Trade ${i + 1}: ${outcome} ${t.pnlPct.toFixed(2)}%${mfe}${mae}${regime} | Entry: ${t.entryReason || '—'} | Exit: ${t.reason}`
  }).join('\n')

  const prompt = `You are a quantitative trading analyst reviewing a backtested ICT/SMC strategy to improve it.

Strategy: ${strategy.name}
Signal function (current):
${strategy.signalBody || '(no signal body)'}

Performance: ${stats.total} trades, ${stats.winRate}% win rate, avg R: ${stats.avgR || 'unknown'}, max DD: ${stats.maxDD}%
Wins: ${wins.length} | Losses: ${losses.length}

Trade log (includes MFE=max favorable excursion, MAE=max adverse excursion, regime):
${tradeSummary}

Analyze the patterns. Focus on:
- What do the losing trades have in common? (regime, time, MAE, entry reason)
- What do the winning trades have in common?
- Which specific rule changes would most improve expectancy?

Then rewrite the signal function with those improvements applied.

CRITICAL: Be honest about sample size. If fewer than 15 trades, say so and make conservative changes only.

Return ONLY raw JSON (no markdown, no backticks):
{
  "changes": [
    { "what": "Short description of the change", "why": "Specific evidence from the trade log that justifies this" }
  ],
  "newSignalBody": "Complete revised JS function body. Same params (i,candles,ind,pos), same return format {action,reason,stopPrice,factors}. Valid JS only.",
  "reasoning": "2-3 sentence overall summary of what changed and why, including honest caveats about sample size.",
  "confidence": "low|medium|high"
}`

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('No API key found. Add VITE_ANTHROPIC_API_KEY to your .env file.')

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: IS_LOCAL
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const data = await res.json()
  if (data.error) throw new Error(data.error.message)

  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  return parseStrategyResponse(data, text)
}

// ── Claude relaxes overly-strict entry criteria ────────────────
// Different problem than getStrategyFeedback: this isn't about why
// trades lost, it's about why almost NO trades fired at all — usually
// because multiple confluence factors are required on the exact same
// bar, which is rare. This asks Claude to loosen that specifically.
export async function getLoosenedStrategy(strategy, tradeCount, totalBars) {
  const prompt = `You are refining a trading strategy that is too conservative — it only took ${tradeCount} trade(s) across ${totalBars} bars of historical data, which is too few to evaluate or learn from.

Strategy: ${strategy.name}
Current entry rules: ${(strategy.entryRules || []).join('; ')}
Current signal function body:
${strategy.signalBody}

Available indicator/detector ids (boolean flags unless noted): swingHigh, swingLow, bullishFVG, bearishFVG, bullishIFVG, bearishIFVG, liquiditySweepLow, liquiditySweepHigh, rejectionBlockBullish, rejectionBlockBearish, bosBullish, bosBearish, cisdBullish, cisdBearish, smtBullish, smtBearish (plus any ema/sma/rsi already in use).

Loosen the entry criteria so trades fire meaningfully more often, while keeping the strategy's core trading idea intact. Concrete techniques to consider, pick what's appropriate:
- Allow conditions to align within a few bars of each other instead of requiring the exact same bar — e.g. check whether ind.liquiditySweepLow was true at ANY point in the last 3-5 bars, not just bar i
- Drop one of the less essential required conditions, or make it a preference (improves factors tagging) rather than mandatory
- Widen numeric thresholds if any are used (RSI bounds, wick-to-body ratios, etc.)
- Replace strict AND logic between secondary confirmations with OR logic where it still makes sense

Return ONLY raw JSON (no markdown, no backticks):
{
  "revisedSignalBody": "Updated JS function body. Same params (i,candles,ind,pos). Same return format {action,reason,factors}. Must be valid as a single-line escaped JSON string.",
  "changesExplained": ["Specific change made 1", "Specific change made 2"],
  "reasoning": "1-2 sentences on the tradeoff between trade frequency and setup quality this introduces"
}`

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('No API key found. Add VITE_ANTHROPIC_API_KEY to your .env file.')
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: IS_LOCAL
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const data = await res.json()
  if (data.error) throw new Error(data.error.message)

  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  return parseStrategyResponse(data, text)
}

// ── Fetch OHLCV candles from Binance Futures ──────────────────

// ── Fix missing factors in an existing strategy signal body ─────
// Call this when a strategy was extracted without proper factor tagging.
// Rewrites just the return statements to include factors.
export async function fixStrategyFactors(strategy) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('No API key found')

  const prompt = `You are fixing a trading strategy signal function that is missing the required factors object.

Current signal body:
${strategy.signalBody}

Strategy name: ${strategy.name}
Strategy conditions: ${JSON.stringify(strategy.entryConditions || [])}

TASK: Rewrite the signalBody so every entry return statement includes a factors object.

Rules:
- Keep ALL existing logic exactly the same — only add/fix the factors object
- factors must be a flat object with boolean values
- Use these keys: fvg, ifvg, liquiditySweep, rejectionBlock, bos, cisd, smt, htfBias, inducement
- Only include keys that are actually checked in the logic
- Example good return: return {action:'buy', reason:'...', factors:{fvg:true, bos:true, liquiditySweep:true}}
- Exit signals don't need factors

Return ONLY a JSON object like this, no other text:
{
  "fixedSignalBody": "the complete fixed function body as a single escaped string"
}`

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: IS_LOCAL
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) throw new Error(`API error ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)

  const text = data.content[0].text
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON returned')

  const parsed = JSON.parse(match[0])
  return { ...strategy, signalBody: parsed.fixedSignalBody }
}

export async function fetchCandles(symbol, interval, limit = 300) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`)
  const raw = await res.json()
  return raw.map(k => ({
    time:   +k[0],
    open:   +k[1],
    high:   +k[2],
    low:    +k[3],
    close:  +k[4],
    volume: +k[5],
  }))
}
