import { useState } from 'react'
import { fetchSelectedMonths, fetchCorrelatedPair, FUTURES_SYMBOLS, TIMEFRAMES, getAvailableMonths } from '../massiveFinance'
import { buildIndicators } from '../indicators'
import { addTestedMonths } from '../strategyVersioning'

const SYMBOLS = ['ES', 'NQ']
const AVAILABLE_MONTHS = getAvailableMonths(30)

export default function StrategyReview({ strategy, onStrategyChange, onBack, onBacktestComplete }) {
  const [symbol, setSymbol] = useState('ES')
  const [tf, setTf] = useState('1h')
  const [selectedMonths, setSelectedMonths] = useState([])
  const [signalBody, setSignalBody] = useState(strategy.signalBody || '')
  const [loading, setLoading] = useState(false)
  const [loadMsg, setLoadMsg] = useState('')
  const [error, setError] = useState('')

  const [accountBalance] = useState(25000)
  const [riskPct, setRiskPct] = useState(1)
  const [rMultiple, setRMultiple] = useState(2)
  const [useMicro, setUseMicro] = useState(true)
  const [useLearning, setUseLearning] = useState(true)

  const needsSMT = (strategy.indicators || []).some(d => d.id === 'smtBullish' || d.id === 'smtBearish')

  function toggleMonth(m) {
    setSelectedMonths(prev => {
      const exists = prev.find(s => s.key === m.key)
      return exists ? prev.filter(s => s.key !== m.key) : [...prev, m]
    })
  }

  async function handleRunBacktest() {
    if (!selectedMonths.length) {
      setError('Select at least one month to backtest.')
      return
    }
    setError('')
    setLoading(true)

    // Sort months chronologically
    const sorted = [...selectedMonths].sort((a, b) => a.key.localeCompare(b.key))

    try {
      let candles, candlesB = null

      if (needsSMT) {
        setLoadMsg(`Fetching ES + NQ for ${sorted.length} month(s)...`)
        const [esAll, nqAll] = await Promise.all([
          fetchSelectedMonths('ES', tf, sorted),
          fetchSelectedMonths('NQ', tf, sorted),
        ])
        candles  = symbol === 'ES' ? esAll : nqAll
        candlesB = symbol === 'ES' ? nqAll : esAll
      } else {
        setLoadMsg(`Fetching ${symbol} — ${sorted.map(m => m.label).join(', ')}...`)
        candles = await fetchSelectedMonths(symbol, tf, sorted)
      }

      if (!candles.length) {
        throw new Error('No candle data returned. Yahoo Finance may not have data for this period and timeframe.')
      }

      setLoadMsg('Computing indicators...')
      const indicators = buildIndicators(candles, strategy.indicators || [], candlesB)

      const updatedStrategy = { ...strategy, signalBody }
      const signalFn = new Function('i', 'candles', 'ind', 'pos', signalBody || 'return{action:"none"}')
      try {
        signalFn(Math.min(5, candles.length - 1), candles, indicators, null)
      } catch (e) {
        throw new Error(`Signal function error: ${e.message}`)
      }

   const riskConfig = { symbolKey: symbol, accountBalance, riskPct, rMultiple, useMicro, useLearning, cooldownBars: 3, minScore: 6 }

      const periodLabel = sorted.length === 1
        ? sorted[0].label
        : `${sorted[0].label} – ${sorted[sorted.length - 1].label} (${sorted.length} months)`

      // Record which months were tested so validation always picks unseen data
      addTestedMonths(strategy.name, sorted.map(m => m.key))

      onStrategyChange(updatedStrategy)
      onBacktestComplete({
        candles, indicators,
        symbol: `${FUTURES_SYMBOLS[symbol].label} · ${periodLabel}`,
        tf, riskConfig,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Strategy overview */}
      <div className="card">
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 8 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em' }}>
            {strategy.name}
          </h2>
          <span className="pill">{strategy.market} · {strategy.timeframe}</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          {strategy.description}
        </p>
      </div>

      {/* Indicators */}
      <div className="card">
        <div className="card-title">Indicators</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(strategy.indicators || []).map(ind => (
            <span key={ind.id} className="pill">
              {ind.label || `${ind.type.toUpperCase()}(${ind.period})`}
            </span>
          ))}
        </div>
      </div>

      {/* Entry & exit rules */}
      <div className="grid2" style={{ marginBottom: 12 }}>
        <div className="card">
          <div className="card-title" style={{ color: 'var(--green)' }}>Entry rules</div>
          {(strategy.entryRules || []).map((r, i) => (
            <div key={i} className="rule entry">{r}</div>
          ))}
        </div>
        <div className="card">
          <div className="card-title" style={{ color: 'var(--red)' }}>Exit rules</div>
          {(strategy.exitRules || []).map((r, i) => (
            <div key={i} className="rule exit">{r}</div>
          ))}
        </div>
      </div>

      {/* Signal function — editable */}
      <div className="card">
        <div className="card-title">
          Signal function
          <span style={{ fontWeight: 400, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0 }}>
            {' '}— edit this to tweak the logic
          </span>
        </div>
        <textarea
          className="inp mono"
          rows={8}
          value={signalBody}
          onChange={e => setSignalBody(e.target.value)}
          spellCheck={false}
        />
        <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.6 }}>
          Parameters: <code>i</code> (current bar index) · <code>candles[]</code> · <code>ind</code> (indicator arrays, e.g. <code>ind.ema9?.[i]</code>) · <code>pos</code> (<code>'long'</code> or <code>null</code>)<br />
          Return <code>{'{ action: "buy"|"sell"|"none", reason: "..." }'}</code>
        </p>
      </div>

      {/* Backtest config */}
      <div className="card">
        <div className="card-title">Backtest configuration</div>
        <div className="grid2" style={{ marginBottom: 12 }}>
          <div>
            <label className="lbl">Symbol (CME Futures, via Yahoo Finance)</label>
            <select className="inp" value={symbol} onChange={e => setSymbol(e.target.value)}>
              {SYMBOLS.map(s => (
                <option key={s} value={s}>{FUTURES_SYMBOLS[s].label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="lbl">Timeframe</label>
            <select className="inp" value={tf} onChange={e => setTf(e.target.value)}>
              {TIMEFRAMES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Month picker — the key upgrade */}
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <label className="lbl" style={{ margin: 0 }}>
              Select months to backtest
            </label>
            <span className="spacer" />
            {selectedMonths.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--blue)' }}>
                {selectedMonths.length} month{selectedMonths.length !== 1 ? 's' : ''} selected
              </span>
            )}
            {selectedMonths.length > 0 && (
              <button
                className="btn-sm"
                onClick={() => setSelectedMonths([])}
                style={{ marginLeft: 8 }}
              >
                Clear
              </button>
            )}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
            gap: 6,
            maxHeight: 220,
            overflowY: 'auto',
            padding: '2px 0',
          }}>
            {AVAILABLE_MONTHS.map(m => {
              const isSelected = !!selectedMonths.find(s => s.key === m.key)
              return (
                <button
                  key={m.key}
                  onClick={() => toggleMonth(m)}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 6,
                    border: `1px solid ${isSelected ? 'var(--blue)' : 'var(--border)'}`,
                    background: isSelected ? 'rgba(45,108,223,0.15)' : 'var(--surface)',
                    color: isSelected ? 'var(--blue)' : 'var(--text-muted)',
                    fontSize: 12,
                    fontWeight: isSelected ? 600 : 400,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s',
                  }}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
            Pick any specific months — one for a focused test, several for diverse market conditions. Each month is fetched as a separate clean window so you always get exactly the data you asked for. Free data via Yahoo Finance (~15-20 min delayed).
          </p>
        </div>

        {needsSMT && (
          <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 10 }}>
            ⚡ SMT divergence — both ES and NQ will be fetched automatically.
          </p>
        )}
      </div>

      {/* Risk management config */}
      <div className="card">
        <div className="card-title">Risk management</div>
        <div className="grid2" style={{ marginBottom: 10 }}>
          <div>
            <label className="lbl">Starting balance</label>
            <input className="inp" value="$25,000" disabled style={{ opacity: 0.7 }} />
          </div>
          <div>
            <label className="lbl">Contract size</label>
            <select className="inp" value={useMicro ? 'micro' : 'full'} onChange={e => setUseMicro(e.target.value === 'micro')}>
              <option value="micro">Micro ({symbol === 'ES' ? 'MES' : 'MNQ'})</option>
              <option value="full">Full size ({symbol})</option>
            </select>
          </div>
        </div>
        <div className="grid2">
          <div>
            <label className="lbl">Risk per trade</label>
            <select className="inp" value={riskPct} onChange={e => setRiskPct(Number(e.target.value))}>
              <option value={0.5}>0.5% — conservative</option>
              <option value={1}>1% — standard</option>
              <option value={2}>2% — aggressive</option>
            </select>
          </div>
          <div>
            <label className="lbl">Reward : Risk (R-multiple)</label>
            <select className="inp" value={rMultiple} onChange={e => setRMultiple(Number(e.target.value))}>
              <option value={1.5}>1.5R</option>
              <option value={2}>2R</option>
              <option value={2.5}>2.5R</option>
              <option value={3}>3R</option>
            </select>
          </div>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10, lineHeight: 1.6 }}>
          Stop loss is placed beyond the swept structure point (or the signal's own <code>stopPrice</code> if provided). Take profit is automatically set at {rMultiple}× the stop distance. Trades that can't be sized within {riskPct}% risk are skipped — this is what keeps the bot from overtrading.
        </p>

        <label className="row" style={{ marginTop: 12, gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={useLearning} onChange={e => setUseLearning(e.target.checked)} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Use learned filters — blocks combos with negative expectancy (8+ trades), scores by session and recency-weighted history, and sizes proven setups up to 1.5× while sizing unproven ones down to 0.5×, pooled across every strategy you've tested
          </span>
        </label>
      </div>

      {strategy.notes && (
        <div className="card" style={{ borderColor: 'rgba(240,160,32,0.2)', background: 'rgba(240,160,32,0.04)' }}>
          <div className="card-title" style={{ color: 'var(--amber)' }}>Notes from video</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65 }}>{strategy.notes}</p>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn-sm" onClick={onBack}>← Back</button>
        <button
          className="btn-green"
          onClick={handleRunBacktest}
          disabled={loading || !selectedMonths.length}
          style={{ flex: 1, padding: '11px' }}
        >
          {loading
            ? `⏳ ${loadMsg}`
            : selectedMonths.length === 0
            ? 'Select months above to backtest'
            : `▶ Run Backtest — ${selectedMonths.length} month${selectedMonths.length !== 1 ? 's' : ''}`
          }
        </button>
      </div>
    </div>
  )
}
