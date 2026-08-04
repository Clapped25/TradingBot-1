import { useState, useEffect } from 'react'
import { sbGet } from '../supabase'

const EVAL_TARGET    = 1250
const EVAL_DRAWDOWN  = 1000
const EVAL_DAILY_LIMIT = 600
const ACCOUNT_SIZE   = 25000

export default function EvalDashboard() {
  const [stats, setStats]   = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadStats()
    const t = setInterval(loadStats, 30_000)
    return () => clearInterval(t)
  }, [])

  async function loadStats() {
    try {
      const botStats = await sbGet('bot_stats', 'main')
      const evalData = botStats?.eval

      if (evalData) {
        setStats(evalData)
      } else {
        // Calculate from paper trades directly
        const trades  = await sbGet('paper_trades',  'main') || []
        const account = await sbGet('paper_account', 'main') || { balance: ACCOUNT_SIZE }
        const closed  = trades.filter(t => t.exitTime && t.pnlDollars !== null)
        const totalProfit = account.balance - ACCOUNT_SIZE

        const todayStart = new Date()
        todayStart.setHours(0, 0, 0, 0)
        const todayPnl = closed
          .filter(t => t.exitTime >= todayStart.getTime())
          .reduce((s, t) => s + (t.pnlDollars || 0), 0)

        setStats({
          totalProfit,
          totalDrawdown: Math.min(0, totalProfit),
          todayPnl,
          drawdownLeft: EVAL_DRAWDOWN + Math.min(0, totalProfit),
          progressPct: +((totalProfit / EVAL_TARGET) * 100).toFixed(1),
          drawdownPct: +((Math.abs(Math.min(0, totalProfit)) / EVAL_DRAWDOWN) * 100).toFixed(1),
          balance: account.balance,
          passed: totalProfit >= EVAL_TARGET,
          blown:  totalProfit <= -EVAL_DRAWDOWN,
        })
      }
    } catch (e) {
      console.error('Eval stats error:', e.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div className="card" style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading eval stats...</div>
  if (!stats)  return null

  const profitPct  = Math.max(0, Math.min(100, stats.progressPct))
  const drawPct    = Math.max(0, Math.min(100, stats.drawdownPct))
  const todayPct   = Math.max(0, Math.min(100, (Math.abs(Math.min(0, stats.todayPnl)) / EVAL_DAILY_LIMIT) * 100))

  const statusColor = stats.passed ? 'var(--green)'
    : stats.blown  ? 'var(--red)'
    : 'var(--blue)'

  const statusText = stats.passed ? '🎉 EVAL PASSED'
    : stats.blown  ? '💀 ACCOUNT BLOWN'
    : '⏳ IN PROGRESS'

  return (
    <div className="card" style={{ borderColor: statusColor }}>
      {/* Header */}
      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>📋 Lucid Eval Tracker</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            $25k account · Target +$1,250 · Max loss -$1,000
          </div>
        </div>
        <div style={{
          marginLeft: 'auto', fontSize: 13, fontWeight: 700,
          color: statusColor, padding: '4px 12px',
          background: `${statusColor}15`, borderRadius: 20,
          border: `1px solid ${statusColor}40`,
        }}>
          {statusText}
        </div>
      </div>

      {/* Profit target progress */}
      <div style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Profit Target</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: stats.totalProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
            {stats.totalProfit >= 0 ? '+' : ''}${stats.totalProfit.toFixed(0)} / $1,250
          </span>
        </div>
        <div style={{ height: 12, background: 'var(--surface)', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <div style={{
            height: '100%', borderRadius: 6,
            width: `${profitPct}%`,
            background: 'linear-gradient(90deg, var(--green), #10b981)',
            transition: 'width 0.5s ease',
          }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
          {profitPct.toFixed(1)}% complete · Need ${Math.max(0, EVAL_TARGET - stats.totalProfit).toFixed(0)} more
        </div>
      </div>

      {/* Drawdown meter */}
      <div style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Drawdown Used</span>
          <span style={{ marginLeft: 'auto', fontSize: 12,
            color: drawPct > 70 ? 'var(--red)' : drawPct > 40 ? 'var(--amber)' : 'var(--green)',
            fontWeight: 700
          }}>
            ${stats.drawdownUsed?.toFixed(0) || Math.abs(stats.totalDrawdown).toFixed(0)} / $1,000
          </span>
        </div>
        <div style={{ height: 12, background: 'var(--surface)', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <div style={{
            height: '100%', borderRadius: 6,
            width: `${drawPct}%`,
            background: drawPct > 70 ? 'var(--red)' : drawPct > 40 ? 'var(--amber)' : 'var(--green)',
            transition: 'width 0.5s ease',
          }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
          ${stats.drawdownLeft.toFixed(0)} remaining · Floor: $${stats.currentFloor?.toFixed(0) || '24,000'} · Peak EOD: $${stats.peakEodBalance?.toFixed(0) || '25,000'}
        </div>
      </div>

      {/* Daily P&L */}
      <div style={{ marginBottom: 12 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Today's P&L</span>
          <span style={{ marginLeft: 'auto', fontSize: 12,
            color: stats.todayPnl >= 0 ? 'var(--green)' : 'var(--red)',
            fontWeight: 700
          }}>
            {stats.todayPnl >= 0 ? '+' : ''}${stats.todayPnl.toFixed(0)} / -$600 limit
          </span>
        </div>
        {stats.todayPnl < 0 && (
          <div style={{ height: 8, background: 'var(--surface)', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <div style={{
              height: '100%', borderRadius: 4,
              width: `${todayPct}%`,
              background: todayPct > 70 ? 'var(--red)' : 'var(--amber)',
              transition: 'width 0.5s ease',
            }} />
          </div>
        )}
        {stats.todayPnl < 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            ${(EVAL_DAILY_LIMIT - Math.abs(stats.todayPnl)).toFixed(0)} before daily trading stops
          </div>
        )}
      </div>

      {/* Account balance */}
      <div style={{
        padding: '10px 12px', background: 'var(--surface)',
        borderRadius: 8, border: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Account Balance</span>
        <span style={{ fontSize: 18, fontWeight: 800,
          color: stats.balance >= ACCOUNT_SIZE ? 'var(--green)' : 'var(--red)'
        }}>
          ${stats.balance?.toLocaleString(undefined, { minimumFractionDigits: 0 })}
        </span>
      </div>
    </div>
  )
}
