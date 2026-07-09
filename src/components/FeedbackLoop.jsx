// FeedbackLoop — the semi-automated strategy improvement cycle.
//
// State machine:
//   'loading'    → AI is analyzing trades
//   'proposed'   → Changes shown, waiting for user decision
//   'rejected'   → User said no, nothing changed
//   'validating' → User approved, running on unseen month
//   'kept'       → Validation passed, strategy updated
//   'reverted'   → Validation failed, strategy rolled back

const CONFIDENCE_COLORS = {
  high:   'var(--green)',
  medium: 'var(--amber)',
  low:    'var(--red)',
}

export default function FeedbackLoop({
  status,          // 'loading' | 'proposed' | 'rejected' | 'validating' | 'kept' | 'reverted'
  feedback,        // { changes, newSignalBody, reasoning, confidence }
  validationResult,// { unseenMonth, before, after, improved }
  onApprove,
  onReject,
}) {
  if (!status) return null

  // ── Loading ────────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div className="card" style={{ borderColor: 'var(--blue)' }}>
        <div className="row" style={{ gap: 10 }}>
          <div style={{ fontSize: 20 }}>🤖</div>
          <div>
            <div className="card-title" style={{ margin: 0, color: 'var(--blue)' }}>
              Analyzing your trades...
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              Looking for patterns in wins vs losses to propose specific improvements.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ── Proposed changes ───────────────────────────────────────────
  if (status === 'proposed' && feedback) {
    const confidenceColor = CONFIDENCE_COLORS[feedback.confidence] || 'var(--text-dim)'
    return (
      <div className="card" style={{ borderColor: 'var(--blue)' }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <div>
            <div className="card-title" style={{ margin: 0, color: 'var(--blue)' }}>
              🤖 AI proposes {feedback.changes?.length || 0} change{feedback.changes?.length !== 1 ? 's' : ''}
            </div>
            <span style={{ fontSize: 11, color: confidenceColor, fontWeight: 600 }}>
              {feedback.confidence?.toUpperCase()} confidence
            </span>
          </div>
        </div>

        {/* Reasoning */}
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
          {feedback.reasoning}
        </p>

        {/* Proposed changes list */}
        {feedback.changes?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, marginBottom: 6 }}>
              WHAT CHANGES AND WHY:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {feedback.changes.map((c, i) => (
                <div key={i} style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '8px 10px',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>
                    {i + 1}. {c.what}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                    Evidence: {c.why}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Warning if low confidence */}
        {feedback.confidence === 'low' && (
          <div style={{
            background: 'rgba(255,71,87,0.08)', border: '1px solid var(--red-border)',
            borderRadius: 6, padding: '8px 10px', marginBottom: 12, fontSize: 12, color: 'var(--red)',
          }}>
            ⚠ Sample size is small — these changes are hypotheses, not proven improvements. Approving will still run a validation test on unseen data before applying permanently.
          </div>
        )}

        {/* Validation explanation */}
        <div style={{
          background: 'rgba(45,108,223,0.06)', border: '1px solid rgba(45,108,223,0.2)',
          borderRadius: 6, padding: '8px 10px', marginBottom: 14, fontSize: 12, color: 'var(--text-dim)',
        }}>
          If you approve → the new strategy will be tested on a month you have never backtested before. It only gets applied permanently if performance improves on that unseen data.
        </div>

        {/* Approve / Reject */}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn-sm" onClick={onReject} style={{ flex: 1 }}>
            ✕ Reject — keep current strategy
          </button>
          <button
            className="btn-green"
            onClick={onApprove}
            style={{ flex: 2, padding: '10px' }}
          >
            ✓ Approve — run validation on unseen data
          </button>
        </div>
      </div>
    )
  }

  // ── Rejected ───────────────────────────────────────────────────
  if (status === 'rejected') {
    return (
      <div className="card" style={{ borderColor: 'var(--border)' }}>
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Change rejected — current strategy kept unchanged.
        </div>
      </div>
    )
  }

  // ── Validating ─────────────────────────────────────────────────
  if (status === 'validating') {
    return (
      <div className="card" style={{ borderColor: 'var(--amber)' }}>
        <div className="row" style={{ gap: 10 }}>
          <div style={{ fontSize: 20 }}>⏳</div>
          <div>
            <div className="card-title" style={{ margin: 0, color: 'var(--amber)' }}>
              Testing on unseen data...
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              Running the proposed strategy on {validationResult?.unseenMonth?.label || 'a month you have never tested'}.
              If it performs better, the change will be kept permanently.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ── Kept (validation passed) ───────────────────────────────────
  if (status === 'kept' && validationResult) {
    const { unseenMonth, before, after } = validationResult
    return (
      <div className="card" style={{ borderColor: 'var(--green)' }}>
        <div className="card-title" style={{ color: 'var(--green)' }}>
          ✓ Strategy improved — change kept permanently
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
          Validated on {unseenMonth?.label} (data you had never tested on before).
        </p>
        <div className="grid2" style={{ gap: 8 }}>
          <div className="stat-card" style={{ borderColor: 'var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>Before (original)</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{before.winRate}% win</div>
            <div style={{ fontSize: 12, color: before.expectancyR >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {before.expectancyR >= 0 ? '+' : ''}{before.expectancyR}R expectancy
            </div>
          </div>
          <div className="stat-card" style={{ borderColor: 'var(--green-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>After (on unseen data)</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>{after.winRate}% win</div>
            <div style={{ fontSize: 12, color: after.expectancyR >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {after.expectancyR >= 0 ? '+' : ''}{after.expectancyR}R expectancy
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Reverted (validation failed) ──────────────────────────────
  if (status === 'reverted' && validationResult) {
    const { unseenMonth, before, after } = validationResult
    return (
      <div className="card" style={{ borderColor: 'var(--red)' }}>
        <div className="card-title" style={{ color: 'var(--red)' }}>
          ✗ Change reverted — didn't improve on unseen data
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
          Tested on {unseenMonth?.label}. Performance didn't improve, so the original strategy was restored. This is the system working correctly — it protected you from an overfit change.
        </p>
        <div className="grid2" style={{ gap: 8 }}>
          <div className="stat-card">
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>Original (restored)</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{before.winRate}% win</div>
            <div style={{ fontSize: 12, color: before.expectancyR >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {before.expectancyR >= 0 ? '+' : ''}{before.expectancyR}R expectancy
            </div>
          </div>
          <div className="stat-card" style={{ borderColor: 'var(--red-border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>Proposed (on unseen data)</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>{after.winRate}% win</div>
            <div style={{ fontSize: 12, color: after.expectancyR >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {after.expectancyR >= 0 ? '+' : ''}{after.expectancyR}R expectancy
            </div>
          </div>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10 }}>
          Try running on more diverse months to collect more data, then let the AI try again with a larger sample.
        </p>
      </div>
    )
  }

  return null
}
