import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { getLearningHistory, computeHealthScore, clearLearningHistory } from '../learningHistory'
import { getCombinationStats, getMemorySummary } from '../tradeMemory'
import { REGIME_LABELS, REGIME_COLORS } from '../marketRegime'

const FACTOR_LABELS = {
  fvg: 'Fair Value Gap', ifvg: 'Inverse FVG',
  liquiditySweep: 'Liquidity Sweep', rejectionBlock: 'Rejection Block',
  bos: 'Break of Structure', cisd: 'CISD',
  smt: 'SMT Divergence', orderBlock: 'Order Block',
}

function fLabel(k) {
  return FACTOR_LABELS[k] || k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())
}

function expColor(r) {
  if (r == null) return 'var(--text-dim)'
  if (r > 0.15) return 'var(--green)'
  if (r > 0) return 'var(--amber)'
  return 'var(--red)'
}

export default function LearningDashboard({ onBack }) {
  const [snapshots, setSnapshots] = useState([])
  const [combos, setCombos] = useState([])
  const [summary, setSummary] = useState(null)
  const [filter, setFilter] = useState('all') // 'all' | strategyName

  useEffect(() => {
    setSnapshots(getLearningHistory())
    setCombos(getCombinationStats(1))
    setSummary(getMemorySummary())
  }, [])

  const strategyNames = [...new Set(snapshots.map(s => s.strategyName))]
  const filteredSnaps = filter === 'all' ? snapshots : snapshots.filter(s => s.strategyName === filter)
  const { score, label, components } = computeHealthScore(filteredSnaps)

  // Chart data — expectancy over runs
  const chartData = filteredSnaps.map((s, i) => ({
    run: i + 1,
    expectancy: s.expectancyR,
    winRate: s.winRate,
    trades: s.cumulativeTradeCount,
    date: new Date(s.runDate).toLocaleDateString(),
  }))

  // Combos status
  const activeFilters = combos.filter(c => c.total >= 8 && c.expectancyR <= 0)
  const promoted = combos.filter(c => c.total >= 8 && c.expectancyR > 0.15)
  const learning = combos.filter(c => c.total < 8)

  // Regime performance from latest snapshot per strategy
  const latest = filteredSnaps[filteredSnaps.length - 1]
  const regimeData = latest?.regimeStats || []

  const scoreColor = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--amber)' : 'var(--red)'

  if (!snapshots.length) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <button className="btn-sm" onClick={onBack} style={{ marginBottom: 20 }}>← Back</button>
        <div className="card" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
          <div className="card-title">No learning data yet</div>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Run a backtest and let it play through to completion — the learning dashboard will populate automatically after your first finished run.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      {/* Header */}
      <div className="row" style={{ marginBottom: 20, alignItems: 'flex-start' }}>
        <div>
          <button className="btn-sm" onClick={onBack} style={{ marginBottom: 8 }}>← Back</button>
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
            Learning Dashboard
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            {filteredSnaps.length} run{filteredSnaps.length !== 1 ? 's' : ''} recorded
            {summary ? ` · ${summary.totalTrades} total trades across ${summary.strategiesContributing} strateg${summary.strategiesContributing !== 1 ? 'ies' : 'y'}` : ''}
          </p>
        </div>
        <span className="spacer" />
        <div className="row" style={{ gap: 8 }}>
          {strategyNames.length > 1 && (
            <select className="inp" style={{ width: 'auto', fontSize: 12 }} value={filter} onChange={e => setFilter(e.target.value)}>
              <option value="all">All strategies</option>
              {strategyNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <button className="btn-sm" onClick={() => { clearLearningHistory(); setSnapshots([]) }}>
            Clear history
          </button>
        </div>
      </div>

      {/* Health score */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="card-title">Learning health score</div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 0 }}>
              Combines sample size, current edge, and trend direction into one number.
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 42, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: scoreColor }}>{label}</div>
          </div>
        </div>
        {components && (
          <div className="grid4" style={{ marginTop: 12 }}>
            {[
              { label: 'Sample size', value: `${components.sampleScore}/40` },
              { label: 'Edge strength', value: `${components.expScore}/40` },
              { label: 'Trend direction', value: `${components.trendScore}/20` },
              { label: 'Runs recorded', value: filteredSnaps.length },
            ].map(c => (
              <div key={c.label} className="stat-card">
                <div className="stat-val" style={{ fontSize: 16 }}>{c.value}</div>
                <div className="stat-lbl">{c.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Expectancy trend chart */}
      {chartData.length >= 2 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-title">Expectancy over time</div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 12 }}>
            Each point is one completed backtest run. A rising line means the bot is genuinely improving.
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <XAxis dataKey="run" tick={{ fontSize: 11, fill: 'var(--text-dim)' }} label={{ value: 'Run #', position: 'insideBottomRight', offset: -5, fontSize: 11, fill: 'var(--text-dim)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-dim)' }} />
              <Tooltip
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                formatter={(val, name) => [
                  name === 'expectancy' ? `${val >= 0 ? '+' : ''}${val}R` : `${val}%`,
                  name === 'expectancy' ? 'Expectancy' : 'Win rate',
                ]}
                labelFormatter={i => `Run ${i} · ${chartData[i - 1]?.date || ''} · ${chartData[i - 1]?.trades || 0} trades`}
              />
              <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 2" />
              <Line type="monotone" dataKey="expectancy" stroke="var(--blue)" strokeWidth={2} dot={{ r: 3, fill: 'var(--blue)' }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* What's been blocked vs promoted */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">Factor combo status</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {promoted.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)', marginBottom: 5 }}>
                ✓ Promoted — consistently positive edge ({promoted.length})
              </div>
              {promoted.map((c, i) => (
                <div key={i} className="row" style={{ fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>{c.factors.map(fLabel).join(' + ')}</span>
                  <span style={{ color: 'var(--green)', fontWeight: 600, marginLeft: 8 }}>+{c.expectancyR}R</span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>n={c.total}</span>
                </div>
              ))}
            </div>
          )}

          {activeFilters.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', marginBottom: 5 }}>
                ✗ Blocked — negative expectancy, actively filtered ({activeFilters.length})
              </div>
              {activeFilters.map((c, i) => (
                <div key={i} className="row" style={{ fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>{c.factors.map(fLabel).join(' + ')}</span>
                  <span style={{ color: 'var(--red)', fontWeight: 600, marginLeft: 8 }}>{c.expectancyR}R</span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>n={c.total}</span>
                </div>
              ))}
            </div>
          )}

          {learning.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--amber)', marginBottom: 5 }}>
                ◌ Still learning — not enough data yet ({learning.length})
              </div>
              {learning.map((c, i) => (
                <div key={i} className="row" style={{ fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>{c.factors.map(fLabel).join(' + ')}</span>
                  <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>{c.total}/8 trades</span>
                  {c.expectancyR != null && <span style={{ color: expColor(c.expectancyR), marginLeft: 6, fontSize: 11 }}>({c.expectancyR >= 0 ? '+' : ''}{c.expectancyR}R so far)</span>}
                </div>
              ))}
            </div>
          )}

          {!promoted.length && !activeFilters.length && !learning.length && (
            <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>No factor combos recorded yet. Run a backtest where trades fire to populate this.</p>
          )}
        </div>
      </div>

      {/* Regime mastery grid */}
      {regimeData.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-title">Market regime mastery</div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 12 }}>
            How the strategy performs in each market condition. Tap a regime to focus testing on its weakest ones.
          </p>
          <div className="grid2">
            {['trending_up', 'trending_down', 'ranging', 'volatile'].map(regime => {
              const data = regimeData.find(r => r.regime === regime)
              const color = data ? (data.avgPnl > 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)'
              return (
                <div key={regime} className="stat-card" style={{ borderColor: data ? (data.avgPnl > 0 ? 'var(--green-border)' : 'var(--red-border)') : 'var(--border)' }}>
                  <div style={{ fontSize: 11, color: REGIME_COLORS[regime], fontWeight: 600, marginBottom: 4 }}>
                    {REGIME_LABELS[regime]}
                  </div>
                  {data ? (
                    <>
                      <div style={{ fontSize: 17, fontWeight: 700, color }}>{data.avgPnl >= 0 ? '+' : ''}{data.avgPnl}%</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{data.total} trades · {data.winRate}% win</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No trades yet</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Run history log */}
      <div className="card">
        <div className="card-title">Run history</div>
        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[...filteredSnaps].reverse().map((s, i) => (
            <div key={s.id} className="trade-row" style={{ cursor: 'default' }}>
              <div className="row">
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {new Date(s.runDate).toLocaleString()} · {s.strategyName}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                    +{s.newTradesThisRun} trades → {s.cumulativeTradeCount} total
                    {s.blockedThisRun > 0 && ` · ${s.blockedThisRun} blocked`}
                    {s.activeFilterCount > 0 && ` · ${s.activeFilterCount} active filter${s.activeFilterCount !== 1 ? 's' : ''}`}
                  </div>
                </div>
                <span className="spacer" />
                {s.expectancyR != null && (
                  <span style={{ fontSize: 13, fontWeight: 600, color: expColor(s.expectancyR) }}>
                    {s.expectancyR >= 0 ? '+' : ''}{s.expectancyR}R
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
