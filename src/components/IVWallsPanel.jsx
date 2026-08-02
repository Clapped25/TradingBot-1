import { useState, useEffect } from 'react'
import { sbGet } from '../supabase'
import { calcVolatilityWalls } from '../volatility'
import { fetchMonthRange } from '../massiveFinance'

// ── IV Walls Panel ────────────────────────────────────────────────
// Shows Historical Volatility and tomorrow's probable price range.
// Data comes from Railway bot (via Supabase) or calculated locally.

export default function IVWallsPanel({ livePrice }) {
  const [walls,   setWalls]   = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadWalls()
    const t = setInterval(loadWalls, 60_000)
    return () => clearInterval(t)
  }, [livePrice])

  async function loadWalls() {
    try {
      // Try Railway's pre-calculated walls first
      const cached = await sbGet('bot_log', 'iv_walls')
      if (cached?.hv) {
        setWalls(cached)
        setLoading(false)
        return
      }

      // Fallback: calculate locally from Massive bars
      const now   = new Date()
      const year  = now.getFullYear()
      const month = now.getMonth() + 1
      const prevY = month === 1 ? year - 1 : year
      const prevM = month === 1 ? 12 : month - 1

      const [curr, prev] = await Promise.all([
        fetchMonthRange('NQ', '5m', year, month),
        fetchMonthRange('NQ', '5m', prevY, prevM),
      ])
      const allBars = [...prev, ...curr]
      if (allBars.length > 0) {
        const result = calcVolatilityWalls(allBars, livePrice)
        if (result) setWalls(result)
      }
    } catch (e) {
      console.error('IV walls error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return (
    <div className="card" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
      Loading IV walls...
    </div>
  )

  if (!walls) return null

  const price = livePrice || walls.currentPrice
  const pctInRange = price
    ? +(((price - walls.lower1sigma) / (walls.upper1sigma - walls.lower1sigma)) * 100).toFixed(1)
    : 50

  const wallColor = walls.wallBias === 'nearUpper' ? 'var(--red)'
    : walls.wallBias === 'nearLower' ? 'var(--green)'
    : 'var(--text)'

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ margin: 0 }}>📊 IV Walls — Expected Daily Range</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto' }}>
          HV {walls.hv20 || walls.hv}% · ±{walls.dailyMove}pts
        </div>
      </div>

      {/* Visual range bar */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: 'var(--green)' }}>Lower 1σ {walls.lower1sigma}</span>
          <span style={{ color: 'var(--text-dim)' }}>68% range</span>
          <span style={{ color: 'var(--red)' }}>Upper 1σ {walls.upper1sigma}</span>
        </div>
        <div style={{
          height: 20, background: 'var(--surface)', borderRadius: 10,
          border: '1px solid var(--border)', position: 'relative', overflow: 'hidden',
        }}>
          {/* Range fill */}
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: '10%', right: '10%',
            background: 'rgba(59,130,246,0.15)',
          }} />
          {/* Current price marker */}
          {price && (
            <div style={{
              position: 'absolute', top: 0, bottom: 0, width: 2,
              left: `${Math.max(2, Math.min(98, pctInRange))}%`,
              background: '#60a5fa',
              transform: 'translateX(-50%)',
            }} />
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4, color: 'var(--text-dim)' }}>
          <span>Lower 2σ {walls.lower2sigma}</span>
          <span>95% range</span>
          <span>Upper 2σ {walls.upper2sigma}</span>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 12 }}>
        {[
          ['HV (20d)', `${walls.hv20 || walls.hv}%`],
          ['Daily Move', `±${walls.dailyMove}pts`],
          ['Position', `${pctInRange}% in range`],
        ].map(([label, val]) => (
          <div key={label} style={{
            padding: '8px', background: 'var(--surface)',
            borderRadius: 6, textAlign: 'center',
          }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Wall bias */}
      <div style={{
        padding: '8px 12px', borderRadius: 6,
        background: walls.wallBias === 'neutral'
          ? 'rgba(255,255,255,0.03)'
          : walls.wallBias === 'nearUpper'
            ? 'rgba(239,68,68,0.08)'
            : 'rgba(16,185,129,0.08)',
        border: `1px solid ${wallColor}30`,
        fontSize: 12, color: wallColor,
      }}>
        {walls.wallBias === 'neutral' && `Price in middle of range — both directions valid`}
        {walls.wallBias === 'nearUpper' && `⚠ Price near UPPER wall — LONG trades blocked, favor SHORTS`}
        {walls.wallBias === 'nearLower' && `⚠ Price near LOWER wall — SHORT trades blocked, favor LONGS`}
      </div>

      {walls.pctToUpper !== undefined && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
          {walls.pctToUpper}% to upper wall · {walls.pctToLower}% to lower wall · {walls.dailyBarsUsed || walls.days} days of data
        </div>
      )}
    </div>
  )
}
