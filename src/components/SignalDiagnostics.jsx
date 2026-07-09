const IND_COLORS = {
  ema9: '#f0a020', ema21: '#2d6cdf', ema50: '#9c7aff',
  sma20: '#00a8b5', sma50: '#f0a020', sma200: '#9c7aff',
}

function factorLabel(key) {
  const labels = {
    swingHigh: 'Swing High', swingLow: 'Swing Low',
    bullishFVG: 'Bullish FVG Touch', bearishFVG: 'Bearish FVG Touch',
    bullishIFVG: 'Bullish IFVG', bearishIFVG: 'Bearish IFVG',
    liquiditySweepLow: 'Liquidity Sweep (Low)', liquiditySweepHigh: 'Liquidity Sweep (High)',
    rejectionBlockBullish: 'Rejection Block (Bull)', rejectionBlockBearish: 'Rejection Block (Bear)',
    bosBullish: 'Bullish BOS', bosBearish: 'Bearish BOS',
    cisdBullish: 'Bullish CISD', cisdBearish: 'Bearish CISD',
    smtBullish: 'SMT Divergence (Bull)', smtBearish: 'SMT Divergence (Bear)',
  }
  return labels[key] || key
}

export default function SignalDiagnostics({ indicators, candles }) {
  const booleanIndicators = Object.entries(indicators).filter(([k]) => IND_COLORS[k] === undefined)

  if (!booleanIndicators.length) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '20px' }}>
        No trades were taken, and no SMC detectors are active to diagnose — check that your signal function references the indicators correctly.
      </div>
    )
  }

  const counts = booleanIndicators.map(([key, arr]) => ({
    key,
    label: factorLabel(key),
    count: arr.filter(v => v === true).length,
  })).sort((a, b) => b.count - a.count)

  const allZero = counts.every(c => c.count === 0)
  const totalBars = candles.length

  return (
    <div className="card">
      <div className="card-title" style={{ color: 'var(--amber)' }}>No trades — here's why</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
        {allZero
          ? "None of the strategy's detectors fired even once across " + totalBars + ' bars. That usually means a bug in the signal function or indicator ids — check that the names in your signal function exactly match the indicator list below.'
          : 'Each factor below fired individually, but they never lined up together at the same bar in the way your signal function requires. This is common with strict multi-factor confluence — try loosening the requirement (e.g. allow the conditions within a few bars of each other instead of the exact same bar), or pull more history so rarer setups have more chances to occur.'}
      </p>
      <div className="lbl" style={{ marginBottom: 8 }}>How often each factor fired (out of {totalBars} bars)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {counts.map(c => (
          <div key={c.key} className="row" style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 160 }}>{c.label}</span>
            <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.min(100, (c.count / totalBars) * 100 * 8)}%`, height: '100%',
                background: c.count === 0 ? 'var(--red)' : 'var(--blue)',
              }} />
            </div>
            <span style={{ minWidth: 36, textAlign: 'right', color: c.count === 0 ? 'var(--red)' : 'var(--text)', fontWeight: 600 }}>
              {c.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
