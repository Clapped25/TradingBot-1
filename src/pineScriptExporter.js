// ─────────────────────────────────────────────────────────────────────────────
// Pine Script Exporter
//
// Converts the paper broker trade log into a TradingView Pine Script v5
// indicator that plots every entry and exit directly on the chart.
//
// How to use the output:
//   1. Open TradingView → Pine Script editor (bottom of chart)
//   2. Click "New" → paste the generated script → "Add to chart"
//   3. Make sure your chart symbol matches (e.g. NQ1!, MNQU2025)
//   4. Green triangles = entries, X marks = exits (teal = win, maroon = loss)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array} trades   - from getTrades() in paperBroker.js
 * @param {string} symbol  - TradingView symbol hint for the comment header
 * @returns {string}       - Pine Script v5 code ready to paste
 */
export function generatePineScript(trades, symbol = 'NQ1!') {
  const closed = trades.filter(t => t.exitTime)
  if (closed.length === 0) return null

  const totalPnl  = closed.reduce((s, t) => s + (t.pnlDollars || 0), 0)
  const wins      = closed.filter(t => t.pnlDollars > 0).length
  const losses    = closed.filter(t => t.pnlDollars <= 0).length
  const winRate   = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0'

  const lines = []

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push(`//@version=5`)
  lines.push(`// ─────────────────────────────────────────────────────────────`)
  lines.push(`// TradingBot — Trade Log`)
  lines.push(`// Symbol  : ${symbol}`)
  lines.push(`// Trades  : ${closed.length}  (${wins}W / ${losses}L)`)
  lines.push(`// Win Rate: ${winRate}%`)
  lines.push(`// Net P&L : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`)
  lines.push(`// Generated: ${new Date().toUTCString()}`)
  lines.push(`// ─────────────────────────────────────────────────────────────`)
  lines.push(`//`)
  lines.push(`// HOW TO USE:`)
  lines.push(`// 1. Open Pine Script editor on TradingView`)
  lines.push(`// 2. Paste this entire script`)
  lines.push(`// 3. Click "Add to chart"`)
  lines.push(`// 4. Set chart to 5-minute timeframe for best results`)
  lines.push(`// ─────────────────────────────────────────────────────────────`)
  lines.push(``)
  lines.push(`indicator("TradingBot Trades", overlay=true, max_labels_count=500)`)
  lines.push(``)

  // ── Build timestamp arrays for entries and exits ─────────────────────────
  const longEntries  = closed.filter(t => t.side === 'LONG')
  const shortEntries = closed.filter(t => t.side === 'SHORT')
  const winExits     = closed.filter(t => t.pnlDollars > 0)
  const lossExits    = closed.filter(t => t.pnlDollars <= 0)

  // Helper: Pine Script timestamp() call from Unix ms
  function pts(ms) {
    const d = new Date(ms)
    return `timestamp("UTC", ${d.getUTCFullYear()}, ${d.getUTCMonth() + 1}, ${d.getUTCDate()}, ${d.getUTCHours()}, ${d.getUTCMinutes()}, 0)`
  }

  // ── Long entries ──────────────────────────────────────────────────────────
  if (longEntries.length > 0) {
    lines.push(`// ── LONG entries (green ▲) ────────────────────────────────`)
    lines.push(`longEntry = `)
    longEntries.forEach((t, i) => {
      const comma = i < longEntries.length - 1 ? ' or' : ''
      lines.push(`    time == ${pts(t.entryTime)}${comma}  // ${t.symbol} @ ${t.entryPrice.toFixed(2)}`)
    })
    lines.push(`plotshape(longEntry, title="Long Entry", location=location.belowbar,`)
    lines.push(`    style=shape.triangleup, color=color.new(color.green, 0),`)
    lines.push(`    size=size.small, text="L")`)
    lines.push(``)
  }

  // ── Short entries ──────────────────────────────────────────────────────────
  if (shortEntries.length > 0) {
    lines.push(`// ── SHORT entries (red ▼) ─────────────────────────────────`)
    lines.push(`shortEntry = `)
    shortEntries.forEach((t, i) => {
      const comma = i < shortEntries.length - 1 ? ' or' : ''
      lines.push(`    time == ${pts(t.entryTime)}${comma}  // ${t.symbol} @ ${t.entryPrice.toFixed(2)}`)
    })
    lines.push(`plotshape(shortEntry, title="Short Entry", location=location.abovebar,`)
    lines.push(`    style=shape.triangledown, color=color.new(color.red, 0),`)
    lines.push(`    size=size.small, text="S")`)
    lines.push(``)
  }

  // ── Winning exits ─────────────────────────────────────────────────────────
  if (winExits.length > 0) {
    lines.push(`// ── Winning exits (teal ✕) ────────────────────────────────`)
    lines.push(`winExit = `)
    winExits.forEach((t, i) => {
      const comma = i < winExits.length - 1 ? ' or' : ''
      const pnl   = `+$${t.pnlDollars.toFixed(0)}`
      lines.push(`    time == ${pts(t.exitTime)}${comma}  // ${pnl}`)
    })
    lines.push(`plotshape(winExit, title="Win Exit", location=location.abovebar,`)
    lines.push(`    style=shape.xcross, color=color.new(color.teal, 0),`)
    lines.push(`    size=size.normal)`)
    lines.push(``)
  }

  // ── Losing exits ──────────────────────────────────────────────────────────
  if (lossExits.length > 0) {
    lines.push(`// ── Losing exits (maroon ✕) ───────────────────────────────`)
    lines.push(`lossExit = `)
    lossExits.forEach((t, i) => {
      const comma = i < lossExits.length - 1 ? ' or' : ''
      const pnl   = `-$${Math.abs(t.pnlDollars).toFixed(0)}`
      lines.push(`    time == ${pts(t.exitTime)}${comma}  // ${pnl}`)
    })
    lines.push(`plotshape(lossExit, title="Loss Exit", location=location.belowbar,`)
    lines.push(`    style=shape.xcross, color=color.new(color.maroon, 0),`)
    lines.push(`    size=size.normal)`)
    lines.push(``)
  }

  // ── Per-trade labels with P&L ─────────────────────────────────────────────
  lines.push(`// ── P&L labels on exit ────────────────────────────────────`)
  closed.forEach((t, i) => {
    const pnlStr = t.pnlDollars >= 0 ? `+$${t.pnlDollars.toFixed(0)}` : `-$${Math.abs(t.pnlDollars).toFixed(0)}`
    const col    = t.pnlDollars >= 0 ? 'color.teal' : 'color.maroon'
    const loc    = t.side === 'LONG' ? 'high' : 'low'
    const style  = t.side === 'LONG' ? 'label.style_label_down' : 'label.style_label_up'
    lines.push(`if time == ${pts(t.exitTime)}`)
    lines.push(`    label.new(bar_index, ${loc},`)
    lines.push(`        text="${pnlStr}\\n${t.exitReason || 'exit'}",`)
    lines.push(`        style=${style},`)
    lines.push(`        color=${col}, textcolor=color.white, size=size.tiny)`)
    lines.push(``)
  })

  return lines.join('\n')
}
