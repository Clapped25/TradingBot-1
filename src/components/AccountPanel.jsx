import { getOpenPositionAt, calcOpenPnl, calcRealizedPnl } from '../account'

export default function AccountPanel({ candles, trades, stats, startingBalance, replayIdx, symbolKey, useMicro }) {
  if (!candles?.length) return null
  const baseBalance = startingBalance ?? stats?.startingBalance ?? 25000

  // When replaying, only count what's happened up to the current bar.
  // When showing the full backtest, use the complete trade history.
  const atBar = Math.min(replayIdx != null ? replayIdx : candles.length - 1, candles.length - 1)

  const openPosition = getOpenPositionAt(trades.filter(t => t.barIndex <= atBar), atBar)
  const currentPrice = candles[atBar]?.close ?? candles[candles.length - 1]?.close ?? 0
  const openPnl = calcOpenPnl(openPosition, currentPrice, symbolKey, useMicro)
  const realizedPnl = calcRealizedPnl(trades, atBar)

  const currentBalance = baseBalance + realizedPnl + openPnl

  const cards = [
    {
      label: 'Account balance',
      value: `$${currentBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      color: currentBalance >= baseBalance ? 'var(--green)' : 'var(--red)',
    },
    {
      label: 'Open PnL',
      value: openPosition
        ? `${openPnl >= 0 ? '+' : ''}$${openPnl.toFixed(2)}`
        : '—',
      color: !openPosition ? 'var(--text-dim)' : openPnl >= 0 ? 'var(--green)' : 'var(--red)',
    },
    {
      label: 'Realized PnL',
      value: `${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`,
      color: realizedPnl >= 0 ? 'var(--green)' : 'var(--red)',
    },
    {
      label: 'Win rate',
      value: stats ? `${stats.winRate}%` : '—',
      color: !stats ? 'var(--text-dim)' : parseFloat(stats.winRate) >= 50 ? 'var(--green)' : 'var(--red)',
    },
  ]

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="card-title" style={{ margin: 0 }}>Account</div>
        <span className="spacer" />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Started at ${baseBalance.toLocaleString()}
        </span>
      </div>
      <div className="grid4">
        {cards.map(c => (
          <div key={c.label} className="stat-card">
            <div className="stat-val" style={{ color: c.color, fontSize: 17 }}>{c.value}</div>
            <div className="stat-lbl">{c.label}</div>
          </div>
        ))}
      </div>
      {openPosition && (
        <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10 }}>
          Open: {openPosition.contracts} contract{openPosition.contracts !== 1 ? 's' : ''} @ {openPosition.price.toFixed(2)}
          {' '}· Stop {openPosition.stopPrice.toFixed(2)} · Target {openPosition.takeProfitPrice.toFixed(2)}
        </p>
      )}
    </div>
  )
}
