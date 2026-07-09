import { useState } from 'react'
import { getStrategyFeedback, getLoosenedStrategy } from '../claude'
import { autoTunableRanges, optimizeParameters } from '../optimizer'

export default function LearningPanel({
  strategy, candles, indicatorDefs, signalBody, trades, stats, onApply,
}) {
  const [mode, setMode] = useState(null) // 'feedback' | 'optimize' | 'loosen' | null
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [optResults, setOptResults] = useState(null)
  const [loosened, setLoosened] = useState(null)

  // ── Claude feedback loop ──────────────────────────────────────
  async function runFeedback() {
    setMode('feedback'); setError(''); setFeedback(null); setLoading(true)
    try {
      const result = await getStrategyFeedback(strategy, trades, stats)
      setFeedback(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function applyFeedback() {
    if (!feedback?.revisedSignalBody) return
    onApply({ indicatorDefs, signalBody: feedback.revisedSignalBody })
    setFeedback(null); setMode(null)
  }

  // ── Loosen overly-strict entry criteria ────────────────────────
  async function runLoosen() {
    setMode('loosen'); setError(''); setLoosened(null); setLoading(true)
    try {
      const exits = trades.filter(t => t.type === 'exit')
      const result = await getLoosenedStrategy(strategy, exits.length, candles.length)
      setLoosened(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function applyLoosened() {
    if (!loosened?.revisedSignalBody) return
    onApply({ indicatorDefs, signalBody: loosened.revisedSignalBody })
    setLoosened(null); setMode(null)
  }

  // ── Parameter optimizer ───────────────────────────────────────
  async function runOptimizer() {
    setMode('optimize'); setError(''); setOptResults(null); setLoading(true)
    setProgress({ done: 0, total: 0 })
    try {
      const tunable = autoTunableRanges(indicatorDefs)
      if (!tunable.length) {
        throw new Error('No tunable EMA/SMA/RSI periods found in this strategy.')
      }
      const { results, tested, totalPossible } = await optimizeParameters({
        candles, indicatorDefs, tunable, signalBody,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setOptResults({ results, tested, totalPossible, tunable })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function applyOptResult(periods) {
    const newDefs = indicatorDefs.map(d => ({
      ...d,
      period: periods[d.id] ?? d.period,
    }))
    onApply({ indicatorDefs: newDefs, signalBody })
    setOptResults(null); setMode(null)
  }

  return (
    <div className="card">
      <div className="card-title">Improve this strategy</div>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 12 }}>
        Have Claude review what went wrong in the losing trades, loosen overly-strict entry criteria if too few trades are firing, or sweep through indicator periods to find the best-performing combination on this exact data.
      </p>

      <div className="row" style={{ marginBottom: 4, flexWrap: 'wrap' }}>
        <button className="btn-sm" onClick={runFeedback} disabled={loading}>
          🧠 Get AI feedback on losses
        </button>
        <button className="btn-sm" onClick={runLoosen} disabled={loading}>
          🔓 Loosen entry criteria
        </button>
        <button className="btn-sm" onClick={runOptimizer} disabled={loading}>
          🎛️ Optimize indicator periods
        </button>
      </div>

      {/* Loading state */}
      {loading && mode === 'feedback' && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          ⏳ Claude is reviewing {trades.filter(t => t.type === 'exit').length} trades...
        </p>
      )}
      {loading && mode === 'loosen' && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          ⏳ Claude is relaxing the entry criteria...
        </p>
      )}
      {loading && mode === 'optimize' && progress && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            ⏳ Testing combination {progress.done} / {progress.total}...
          </p>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      )}

      {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}

      {/* Feedback results */}
      {feedback && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          {feedback.patterns?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="card-title" style={{ color: 'var(--amber)' }}>Patterns in losses</div>
              {feedback.patterns.map((p, i) => (
                <div key={i} className="rule" style={{ borderColor: 'var(--amber)' }}>{p}</div>
              ))}
            </div>
          )}
          {feedback.suggestedChanges?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="card-title" style={{ color: 'var(--green)' }}>Suggested changes</div>
              {feedback.suggestedChanges.map((c, i) => (
                <div key={i} className="rule entry">{c}</div>
              ))}
            </div>
          )}
          {feedback.reasoning && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12 }}>
              {feedback.reasoning}
            </p>
          )}
          <div className="row">
            <button className="btn-green" onClick={applyFeedback} style={{ flex: 1 }}>
              ✓ Apply revised strategy &amp; re-test
            </button>
            <button className="btn-sm" onClick={() => { setFeedback(null); setMode(null) }}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Loosened strategy results */}
      {loosened && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          {loosened.changesExplained?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="card-title" style={{ color: 'var(--blue)' }}>Changes made</div>
              {loosened.changesExplained.map((c, i) => (
                <div key={i} className="rule" style={{ borderColor: 'var(--blue)' }}>{c}</div>
              ))}
            </div>
          )}
          {loosened.reasoning && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12 }}>
              {loosened.reasoning}
            </p>
          )}
          <div className="row">
            <button className="btn-green" onClick={applyLoosened} style={{ flex: 1 }}>
              ✓ Apply loosened strategy &amp; re-test
            </button>
            <button className="btn-sm" onClick={() => { setLoosened(null); setMode(null) }}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Optimizer results */}
      {optResults && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
            Tested {optResults.tested} of {optResults.totalPossible} possible combinations · ranked by return-to-drawdown ratio
          </p>
          {optResults.results.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              No combination produced enough trades to evaluate reliably. Try a longer timeframe or wider ranges.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {optResults.results.map((r, i) => (
                <div
                  key={i}
                  className="trade-row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => applyOptResult(r.periods)}
                >
                  <div className="row">
                    <span className="pill" style={{ background: i === 0 ? 'rgba(0,200,120,0.12)' : undefined, borderColor: i === 0 ? 'var(--green-border)' : undefined }}>
                      {i === 0 ? '★ Best' : `#${i + 1}`}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {Object.entries(r.periods).map(([id, v]) => `${id}=${v}`).join('  ')}
                    </span>
                    <span className="spacer" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: parseFloat(r.stats.totalPnl) > 0 ? 'var(--green)' : 'var(--red)' }}>
                      {parseFloat(r.stats.totalPnl) > 0 ? '+' : ''}{r.stats.totalPnl}%
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                    {r.stats.total} trades · {r.stats.winRate}% win rate · -{r.stats.maxDD}% max drawdown
                  </div>
                </div>
              ))}
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                Tap any result to apply those periods and re-run the backtest.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
