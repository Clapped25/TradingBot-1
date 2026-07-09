import { useState, useEffect } from 'react'
import { getJournal, getMemorySummary } from '../tradeMemory'

function factorLabel(key) {
  const labels = {
    fvg: 'Fair Value Gap', ifvg: 'Inverse FVG', liquiditySweep: 'Liquidity Sweep',
    rejectionBlock: 'Rejection Block', bos: 'Break of Structure', cisd: 'CISD',
    smt: 'SMT Divergence', orderBlock: 'Order Block',
  }
  return labels[key] || key
}

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'wins', label: 'Wins' },
  { value: 'losses', label: 'Losses' },
]

export default function TradeJournal({ refreshKey }) {
  const [filter, setFilter] = useState('all')
  const [journal, setJournal] = useState([])
  const [summary, setSummary] = useState(null)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    setJournal(getJournal({ outcome: filter }))
    setSummary(getMemorySummary())
  }, [filter, refreshKey])

  if (!summary || summary.totalTrades === 0) return null

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 4 }}>
        <div className="card-title" style={{ margin: 0 }}>Trade journal — permanent, all-time</div>
        <span className="spacer" />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{summary.totalTrades} trades saved forever</span>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 12 }}>
        Every trade ever taken, across every strategy and every backtest session — survives closing the browser.
      </p>

      <div className="row" style={{ marginBottom: 10, gap: 6 }}>
        {FILTERS.map(f => (
          <button
            key={f.value}
            className={`btn-sm ${filter === f.value ? 'active' : ''}`}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ maxHeight: 400, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {journal.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-dim)', textAlign: 'center', padding: '16px 0' }}>
            No {filter !== 'all' ? filter : 'trades'} recorded yet.
          </p>
        ) : (
          journal.map((t, i) => {
            const activeFactors = Object.entries(t.factors || {}).filter(([, v]) => v === true).map(([k]) => k)
            const isExpanded = expanded === i
            return (
              <div
                key={i}
                className={`trade-row ${t.win ? 'win' : 'loss'}`}
                onClick={() => setExpanded(isExpanded ? null : i)}
              >
                <div className="row">
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>
                    {activeFactors.length ? activeFactors.map(factorLabel).join(' + ') : 'No factors tagged'}
                    <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>
                      · {t.sourceStrategy}{t.session ? ` · ${t.session}` : ''}
                    </span>
                  </span>
                  <span className="trade-pnl">
                    {t.win ? '+' : ''}${t.dollarPnl?.toFixed(2) ?? '0.00'}
                    {t.rMultiple != null && (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 4 }}>
                        ({t.rMultiple >= 0 ? '+' : ''}{t.rMultiple}R)
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>
                    {isExpanded ? '▲' : '▼'}
                  </span>
                </div>

                {isExpanded && (
                  <div className="trade-detail" onClick={e => e.stopPropagation()}>
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontWeight: 500, color: 'var(--green)' }}>Why entered: </span>
                      <span style={{ color: 'var(--text-muted)' }}>{t.entryReason || '—'}</span>
                    </div>
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontWeight: 500, color: 'var(--red)' }}>Why exited: </span>
                      <span style={{ color: 'var(--text-muted)' }}>{t.exitReason || '—'}</span>
                    </div>
                    {/* MFE/MAE bars — trade quality at a glance */}
                    {t.mfeR != null && (
                      <div style={{ marginBottom: 8 }}>
                        <div className="row" style={{ fontSize: 11, marginBottom: 3 }}>
                          <span style={{ color: 'var(--text-dim)', minWidth: 100 }}>Max favorable</span>
                          <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(100, t.mfeR / 3 * 100)}%`, height: '100%', background: 'var(--green)', borderRadius: 3 }} />
                          </div>
                          <span style={{ color: 'var(--green)', marginLeft: 6, minWidth: 36 }}>+{t.mfeR}R</span>
                        </div>
                        <div className="row" style={{ fontSize: 11, marginBottom: 3 }}>
                          <span style={{ color: 'var(--text-dim)', minWidth: 100 }}>Max adverse</span>
                          <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(100, t.maeR / 1.5 * 100)}%`, height: '100%', background: t.maeR > 0.8 ? 'var(--red)' : 'var(--amber)', borderRadius: 3 }} />
                          </div>
                          <span style={{ color: t.maeR > 0.8 ? 'var(--red)' : 'var(--amber)', marginLeft: 6, minWidth: 36 }}>{t.maeR}R</span>
                        </div>
                        {t.regime && (
                          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                            Regime: <span style={{ color: 'var(--text-muted)' }}>{t.regime.replace('_', ' ')}</span>
                            {t.qualityScore != null && <span style={{ marginLeft: 8 }}>Quality: <span style={{ color: t.qualityScore > 0.5 ? 'var(--green)' : 'var(--amber)' }}>{(t.qualityScore * 100).toFixed(0)}%</span></span>}
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                      Entry {t.entryPrice?.toFixed(2)} → Exit {t.exitPrice?.toFixed(2)}
                      &nbsp;·&nbsp;Stop {t.stopPrice?.toFixed(2)} · Target {t.takeProfitPrice?.toFixed(2)}
                      &nbsp;·&nbsp;{t.contracts} contract{t.contracts !== 1 ? 's' : ''} · {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct?.toFixed(2)}%
                    </div>
                    <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                      {t.entryTime ? new Date(t.entryTime).toLocaleString() : '—'}
                      &nbsp;→&nbsp;
                      {t.exitTime ? new Date(t.exitTime).toLocaleString() : '—'}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
