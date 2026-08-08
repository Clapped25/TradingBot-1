// Flattens backtest exit trades into a feature table suitable for training
// an XGBoost classifier/regressor on trade outcome (pnlPct / win-loss).

function flattenFactors(factors, prefix, out) {
  if (!factors || typeof factors !== 'object') return
  for (const [key, value] of Object.entries(factors)) {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      flattenFactors(value, `${prefix}${key}_`, out)
    } else if (typeof value === 'boolean') {
      out[`${prefix}${key}`] = value ? 1 : 0
    } else if (typeof value === 'number') {
      out[`${prefix}${key}`] = value
    }
  }
}

export function buildTradeFeatures(exits, candles) {
  const rows = exits.map((trade) => {
    const row = {
      entryTime: trade.entryTime,
      exitTime: trade.time,
      session: trade.session,
      regime: trade.regime,
      contracts: trade.contracts,
      riskDollars: trade.riskDollars,
      plannedRR: trade.plannedRR,
      atr: trade.atr,
      entryWinRate: trade.entryWinRate,
      barsHeld: trade.barsHeld,
      mfeR: trade.mfeR,
      maeR: trade.maeR,
      qualityScore: trade.qualityScore,
      rMultiple: trade.rMultiple,
      pnlPct: trade.pnlPct,
      dollarPnl: trade.dollarPnl,
      win: trade.pnlPct > 0 ? 1 : 0,
    }
    flattenFactors(trade.factors, 'factor_', row)
    return row
  })

  const columns = Array.from(
    rows.reduce((cols, row) => {
      Object.keys(row).forEach((k) => cols.add(k))
      return cols
    }, new Set())
  )

  return { rows, columns }
}

function toCsv(rows, columns) {
  const escape = (v) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c])).join(','))
  }
  return lines.join('\n')
}

export function exportAndDownload(exits, candles) {
  const { rows, columns } = buildTradeFeatures(exits, candles)
  const csv = toCsv(rows, columns)

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  a.href = url
  a.download = `trades-ml-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  return { rows: rows.length, features: columns.length }
}
