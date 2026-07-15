import { useState, useEffect } from 'react'
import { extractStrategy, combineStrategy } from '../claude'
import { saveStrategy, addCombinedSource, listStrategies, listStrategiesAsync, deleteStrategy } from '../strategyStorage'
import { sbSet } from '../supabase'
import { getAllTrades } from '../tradeMemory'

export default function StrategyInput({ onStrategyExtracted, onGoLive }) {
  const [url, setUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [combineTarget, setCombineTarget] = useState('') // '' = new strategy, else an existing strategy id
  const [loading, setLoading] = useState(false)
  const [loadMsg, setLoadMsg] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState([])
  const [tradeCounts, setTradeCounts] = useState({}) // strategyName → trade count

  useEffect(() => {
    // Load local first (instant)
    const local = listStrategies()
    if (local.length) setSaved(local)

    // Then pull from Supabase and update if newer/more data
    listStrategiesAsync().then(remote => {
      if (remote?.length) setSaved(remote)
    }).catch(() => {})

    // Count trades per strategy name from the unified journal
    const counts = {}
    for (const t of getAllTrades()) {
      counts[t.sourceStrategy] = (counts[t.sourceStrategy] || 0) + 1
    }
    setTradeCounts(counts)
  }, [])

  async function handleSubmit() {
    if (!url.trim() && !notes.trim()) {
      setError('Add a YouTube URL or describe your strategy below.')
      return
    }
    setError('')
    setLoading(true)
    try {
      if (combineTarget) {
        const target = saved.find(s => s.id === combineTarget)
        if (!target) throw new Error('Could not find that saved strategy.')
        setLoadMsg(`Combining into "${target.strategy.name}"...`)
        const { strategy, transcript } = await combineStrategy(target.strategy, url.trim(), notes.trim())
        addCombinedSource(combineTarget, strategy, { youtubeUrl: url.trim(), transcript, notes: notes.trim() })
        onStrategyExtracted(strategy, combineTarget)
      } else {
        setLoadMsg('Claude is analyzing the strategy...')
        const { strategy, transcript } = await extractStrategy(url.trim(), notes.trim())
        const id = saveStrategy(strategy, { youtubeUrl: url.trim(), transcript, notes: notes.trim() })
        onStrategyExtracted(strategy, id)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleLoad(record) {
    onStrategyExtracted(record.strategy, record.id)
  }

  function handleExport() {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      strategies: listStrategies(),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `trading-bot-strategies-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleImport(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result)
        const strategies = data.strategies || data
        if (!Array.isArray(strategies)) throw new Error('Invalid file format')
        const existing = listStrategies()
        const existingIds = new Set(existing.map(s => s.id))
        let added = 0
        for (const s of strategies) {
          if (!existingIds.has(s.id)) {
            const all = listStrategies()
            localStorage.setItem('tradingbot_saved_strategies_v2', JSON.stringify([...all, s]))
            added++
          }
        }
        setSaved(listStrategies())
        alert(`Imported ${added} strategy${added !== 1 ? "s" : ""}${added < strategies.length ? " (" + (strategies.length - added) + " already existed)" : ""}`)
      } catch (err) {
        alert("Could not read file: " + err.message)
      }
    }
    reader.readAsText(file)
    e.target.value = ""
  }

  function handleDelete(id, e) {
    e.stopPropagation()
    deleteStrategy(id)
    setSaved(listStrategies())
    if (combineTarget === id) setCombineTarget('')
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>

      {/* Export / Import — always the first thing you see */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 20,
        padding: '12px 14px', background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 8,
        alignItems: 'center',
      }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginRight: 4 }}>
          Moving from another device?
        </div>
        <button className="btn-sm" onClick={handleExport}
          disabled={saved.length === 0}
          style={{ opacity: saved.length === 0 ? 0.4 : 1 }}
          title="Download all strategies as a JSON file">
          ⬇ Export
        </button>
        <label className="btn-sm" style={{ cursor: 'pointer' }}
          title="Import strategies from another device">
          ⬆ Import
          <input type="file" onChange={handleImport}
            style={{ display: 'none' }} />
        </label>
      </div>

      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 8 }}>
          Build your trading bot
        </h1>
        <p className="desc" style={{ margin: 0 }}>
          Paste a YouTube URL for any trading strategy video. Claude reads the transcript,
          extracts the rules, and builds a fully backtestable signal function — saved here
          so you never have to re-extract the same video twice. You can also combine
          multiple videos into a single strategy below.
        </p>
      </div>



      {/* Saved strategies — reload instantly, no API cost */}
      {saved.length > 0 && (
        <div className="card">
          <div className="card-title">Saved strategies</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {saved.map(record => {
              const tradeCount = tradeCounts[record.strategy.name] || 0
              const progress = Math.min(100, (tradeCount / 100) * 100)
              const status = tradeCount >= 100 ? { label: 'Ready to trust', color: 'var(--green)' }
                : tradeCount >= 50  ? { label: 'Getting there', color: 'var(--amber)' }
                : tradeCount >= 20  ? { label: 'Building data', color: 'var(--amber)' }
                :                     { label: 'Too few trades', color: 'var(--red)' }
              return (
              <div
                key={record.id}
                className="trade-row"
                onClick={() => handleLoad(record)}
              >
                <div className="row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                      {record.strategy.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      Saved {new Date(record.createdAt).toLocaleDateString()}
                      {record.sources?.length > 0 && ` · ${record.sources.length} video${record.sources.length !== 1 ? 's' : ''}`}
                    </div>
                    {/* Trade count progress toward 100 */}
                    <div style={{ marginTop: 8 }}>
                      <div className="row" style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: status.color }}>
                          {tradeCount} trade{tradeCount !== 1 ? 's' : ''} recorded
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>
                          · {status.label}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                          {tradeCount}/100
                        </span>
                      </div>
                      <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          width: `${progress}%`, height: '100%', borderRadius: 2,
                          background: status.color,
                          transition: 'width 0.3s ease',
                        }} />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, marginLeft: 12 }}>
                    <button
                      className="btn-sm"
                      onClick={e => { e.stopPropagation(); onGoLive?.(record.strategy, record.id) }}
                      style={{
                        background: 'rgba(16,185,129,0.12)', color: 'var(--green)',
                        border: '1px solid rgba(16,185,129,0.3)', fontWeight: 700,
                      }}
                    >
                      ● Go Live
                    </button>
                    <button
                      className="btn-sm"
                      onClick={e => handleSetActive(record, e)}
                      style={{ color: 'var(--blue)', border: '1px solid rgba(59,130,246,0.3)' }}
                      title="Set as the strategy the GitHub Actions bot trades"
                    >
                      🤖 Set Active
                    </button>
<button
                      className="btn-sm"
                      onClick={e => handleDelete(record.id, e)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )})}
          </div>
        </div>
      )}

      <div className="card">
        {saved.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label className="lbl">Combine this video into</label>
            <select className="inp" value={combineTarget} onChange={e => setCombineTarget(e.target.value)}>
              <option value="">— Create a new strategy —</option>
              {saved.map(s => (
                <option key={s.id} value={s.id}>{s.strategy.name}</option>
              ))}
            </select>
            {combineTarget && (
              <p style={{ fontSize: 11, color: 'var(--blue)', marginTop: 6 }}>
                Claude will fold this video's concepts into the existing strategy's rules rather than creating a separate one.
              </p>
            )}
          </div>
        )}

        <label className="lbl">YouTube strategy video URL</label>
        <input
          className="inp"
          type="url"
          placeholder="https://youtube.com/watch?v=..."
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          autoFocus
        />

        <div style={{ marginTop: 16 }}>
          <label className="lbl">Strategy description (optional)</label>
          <textarea
            className="inp"
            rows={5}
            placeholder={
              'Describe the strategy in your own words — useful if the video has no captions.\n\n' +
              'e.g. Enter long on a liquidity sweep of the prior session low, followed by a ' +
              'fair value gap fill and a bullish break of structure...'
            }
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <button
        className="btn-primary"
        onClick={handleSubmit}
        disabled={loading}
        style={{ width: '100%', padding: '12px' }}
      >
        {loading
          ? `⏳ ${loadMsg}`
          : combineTarget ? '→ Combine into selected strategy' : '→ Analyze strategy with Claude'
        }
      </button>

      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12, textAlign: 'center' }}>
        Requires a free Anthropic API key in your <code style={{ color: 'var(--text-muted)' }}>.env</code> file.
        Market data is pulled free from Yahoo Finance — no account needed.
      </p>
    </div>
  )
}
