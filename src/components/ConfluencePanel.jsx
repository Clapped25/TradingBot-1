import { useState, useEffect } from 'react'
import {
  getFactorStats, getCombinationStats, getRecentLosses,
  getMemorySummary, getSessionBreakdown, getRegimeBreakdown, clearMemory,
} from '../tradeMemory'

function factorLabel(key) {
  const labels = {
    fvg: 'Fair Value Gap', ifvg: 'Inverse FVG', liquiditySweep: 'Liquidity Sweep',
    rejectionBlock: 'Rejection Block', bos: 'Break of Structure', cisd: 'CISD',
    smt: 'SMT Divergence', orderBlock: 'Order Block',
  }
  return labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())
}

function expectancyColor(r) {
  if (r > 0.15) return 'var(--green)'
  if (r > 0) return 'var(--amber)'
  return 'var(--red)'
}

export default function ConfluencePanel({ refreshKey }) {
  const [factorStats, setFactorStats] = useState({})
  const [comboStats, setComboStats] = useState([])
  const [recentLosses, setRecentLosses] = useState([])
  const [summary, setSummary] = useState(null)
  const [expandedLoss, setExpandedLoss] = useState(null)
  const [expandedCombo, setExpandedCombo] = useState(null)

  useEffect(() => {
    setFactorStats(getFactorStats())
    setComboStats(getCombinationStats())
    setRecentLosses(getRecentLosses(8))
    setSummary(getMemorySummary())
  }, [refreshKey])

  const factorEntries = Object.entries(factorStats)

  if (!summary || summary.totalTrades === 0) {
    return (
      <div className="card">
        <div className="card-title">What the bot has learned</div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', padding: '12px 0' }}>
          No trades recorded yet. Run a backtest to start building the bot's shared knowledge base.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 4 }}>
        <div className="card-title" style={{ margin: 0 }}>What the bot has learned</div>
        <span className="spacer" />
        <button
          className="btn-sm"
          onClick={() => { clearMemory(); setFactorStats({}); setComboStats([]); setRecentLosses([]); setSummary(getMemorySummary()) }}
        >
          Clear all memory
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14 }}>
        {summary.totalTrades} trades · {summary.winRate}% win rate · {summary.expectancyR != null ? `${summary.expectancyR >= 0 ? '+' : ''}${summary.expectancyR}R expectancy` : ''} · pooled from {summary.strategiesContributing} strateg{summary.strategiesContributing !== 1 ? 'ies' : 'y'}
      </p>

      {/* Individual factor performance */}
      {factorEntries.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="lbl" style={{ marginBottom: 8 }}>Factor performance (shared across every strategy)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {factorEntries.map(([key, s]) => (
              <div key={key} className="row" style={{ fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)', minWidth: 150 }}>{factorLabel(key)}</span>
                <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    width: `${s.winRate}%`, height: '100%',
                    background: s.winRate >= 55 ? 'var(--green)' : s.winRate >= 40 ? 'var(--amber)' : 'var(--red)',
                  }} />
                </div>
                <span style={{ minWidth: 50, textAlign: 'right', fontWeight: 600, color: expectancyColor(s.expectancyR) }}>
                  {s.expectancyR >= 0 ? '+' : ''}{s.expectancyR}R
                </span>
                <span style={{ minWidth: 36, textAlign: 'right', color: 'var(--text-dim)', fontSize: 11 }}>
                  n={s.total}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Best/worst combinations, with session breakdown on expand */}
      {comboStats.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="lbl" style={{ marginBottom: 8 }}>Confluence combinations — ranked by expectancy</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {comboStats.slice(0, 8).map((c, i) => {
              const isExpanded = expandedCombo === i
              const sessionData = isExpanded ? getSessionBreakdown(
                Object.fromEntries(c.factors.map(f => [f, true]))
              ) : []
              const regimeData = isExpanded ? getRegimeBreakdown(
                Object.fromEntries(c.factors.map(f => [f, true]))
              ) : []
              return (
                <div
                  key={i}
                  className="trade-row"
                  onClick={() => setExpandedCombo(isExpanded ? null : i)}
                >
                  <div className="row">
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {c.factors.map(factorLabel).join(' + ')}
                    </span>
                    <span className="spacer" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: expectancyColor(c.expectancyR) }}>
                      {c.expectancyR >= 0 ? '+' : ''}{c.expectancyR}R
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>
                      ({c.total} trades, {c.winRate}% win)
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="trade-detail" onClick={e => e.stopPropagation()}>
                      {sessionData.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>By session:</div>
                          {sessionData.map(s => (
                            <div key={s.session} className="row" style={{ fontSize: 12, marginBottom: 3 }}>
                              <span style={{ color: 'var(--text-muted)', minWidth: 120 }}>{s.label}</span>
                              <span style={{ color: expectancyColor(s.expectancyR), fontWeight: 600 }}>
                                {s.expectancyR >= 0 ? '+' : ''}{s.expectancyR}R
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>n={s.total}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {regimeData.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, marginBottom: 4 }}>By market regime:</div>
                          {regimeData.map(r => (
                            <div key={r.regime} className="row" style={{ fontSize: 12, marginBottom: 3 }}>
                              <span style={{ color: 'var(--text-muted)', minWidth: 120 }}>{r.regime.replace('_', ' ')}</span>
                              <span style={{ color: expectancyColor(r.expectancyR), fontWeight: 600 }}>
                                {r.expectancyR >= 0 ? '+' : ''}{r.expectancyR}R
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>n={r.total}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {!sessionData.length && !regimeData.length && (
                        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Not enough data for breakdown yet.</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
            Tap a combo to see how it performs by trading session. Every strategy gets scored against this same shared table before sizing or taking a trade.
          </p>
        </div>
      )}

      {/* Recent losses feed */}
      {recentLosses.length > 0 && (
        <div>
          <div className="lbl" style={{ marginBottom: 8, color: 'var(--red)' }}>Recent losses — what was present</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentLosses.map((t, i) => {
              const activeFactors = Object.entries(t.factors).filter(([, v]) => v === true).map(([k]) => k)
              const isExpanded = expandedLoss === i
              return (
                <div
                  key={i}
                  className="trade-row loss"
                  onClick={() => setExpandedLoss(isExpanded ? null : i)}
                >
                  <div className="row">
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {activeFactors.length ? activeFactors.map(factorLabel).join(' + ') : 'No factors tagged'}
                    </span>
                    <span className="spacer" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--red)' }}>
                      {t.pnlPct.toFixed(2)}%
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="trade-detail" onClick={e => e.stopPropagation()}>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        From: {t.sourceStrategy} · {t.session ? t.session + ' session' : ''} · {new Date(t.time).toLocaleString()}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
