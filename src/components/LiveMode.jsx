import { useState, useEffect, useRef, useCallback } from 'react'
import { buildIndicators } from '../indicators'
import { fetchLatestPrice, fetchMonthRange } from '../massiveFinance'
import {
  openTrade, closeTrade, getOpenPosition, getTrades,
  getAccount, getUnrealizedPnl, checkAutoExit, checkTimeExit, isInCooldown, getTodayPnl, getStats, resetPaperAccount,
} from '../paperBroker'
import { generatePineScript } from '../pineScriptExporter'
import { shouldTakeTrade, recordLiveTrade, getSession, SESSION_LABELS } from '../tradeMemory'
import { calcDynamicRisk } from '../riskEngine'
import TradeChart from './TradeChart'
import IVWallsPanel from './IVWallsPanel'
import EvalDashboard from './EvalDashboard'

// Primary trading symbol and reference for SMT
const PRIMARY   = 'NQ'   // using NQ for signal (strategy is NQ-based)
const SYMBOL    = 'MNQ'  // paper trading in MNQ micros
const TF        = '5m'
const PRICE_POLL_MS   = 60_000   // 60s — 1 API call per min, within free tier
const SIGNAL_POLL_MS  = 5 * 60_000  // 5min signal re-eval
const BARS_NEEDED     = 120       // last 10 hours of 5-min bars

// ── Eval mode — mirrors server/bot.js prop-firm eval rules ────────
const EVAL_DAILY_LIMIT   = 600  // trading halts for the day once realized loss hits this
const EVAL_MAX_CONTRACTS = 2    // cap contracts at 2, drop to 1 after -$300 on the day

export default function LiveMode({ strategy, onBack, onBacktest }) {
  // ── Price & data ────────────────────────────────────────────────
  const [livePrice,   setLivePrice]   = useState(null)
  const [priceAge,    setPriceAge]    = useState(null)   // ms timestamp of last update
  const [priceError,  setPriceError]  = useState(null)

  // ── Signal ──────────────────────────────────────────────────────
  const [signal,      setSignal]      = useState(null)   // { action, reason, stopPrice }
  const [signalAge,   setSignalAge]   = useState(null)
  const [signalError, setSignalError] = useState(null)
  const [isEvaluating,setIsEvaluating]= useState(false)
  const [diagnostics, setDiagnostics]  = useState(null)  // { indicators, lastBar, factors }
  const [activityLog, setActivityLog]  = useState([])      // live feed of bot activity
  const [recentBars,  setRecentBars]    = useState([])      // last fetched bars for ATR
  const [filterDecision, setFilterDecision] = useState(null)  // { take, sizeFactor, reason }
  const [riskCalc, setRiskCalc]         = useState(null)  // dynamic risk parameters

  // ── Position & account ──────────────────────────────────────────
  const [position,    setPosition]    = useState(null)
  const [trades,      setTrades]      = useState([])
  const [account,     setAccountState]= useState(getAccount())
  const [unrealizedPnl, setUnrealizedPnl] = useState(0)

  // ── UI state ────────────────────────────────────────────────────
  const [tab,         setTab]         = useState('trade')  // 'trade' | 'history' | 'pine'
  const [qty,         setQty]         = useState(1)
  const [autoTrade,   setAutoTrade]   = useState(false)
  const [lastAutoSig, setLastAutoSig] = useState(null)
  const [pineScript,  setPineScript]  = useState(null)
  const [pineCopied,  setPineCopied]  = useState(false)
  const [manualSL,    setManualSL]    = useState('')
  const [manualTP,    setManualTP]    = useState('')
  const [showReset,   setShowReset]   = useState(false)

  const priceTimer  = useRef(null)
  const signalTimer = useRef(null)

  // ── Refresh local state from paper broker ───────────────────────
  function refreshBroker(price) {
    const pos  = getOpenPosition()
    const tds  = getTrades()
    const acc  = getAccount()
    setPosition(pos)
    setTrades(tds)
    setAccountState(acc)
    if (price && pos) {
      setUnrealizedPnl(getUnrealizedPnl(price))
    } else {
      setUnrealizedPnl(0)
    }
  }

  // ── Normalize signal factors to { key: bool } format ───────────
  function normalizeFactor(factors) {
    if (!factors) return {}
    if (Array.isArray(factors)) {
      return Object.fromEntries(factors.map(f => [f.name || f.label || 'factor', f.pass === true]))
    }
    return factors
  }

  // ── Activity log — shows bot thinking in real time ─────────────
  function logActivity(type, message, detail = null) {
    const entry = { id: Date.now() + Math.random(), type, message, detail, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
    setActivityLog(prev => [entry, ...prev].slice(0, 50))
  }

  // ── Fetch latest price from Massive ────────────────────────────
  const fetchPrice = useCallback(async () => {
    try {
      const result = await fetchLatestPrice(PRIMARY)
      if (!result) return
      setLivePrice(result.price)
      setPriceAge(Date.now())
      setPriceError(null)
      logActivity('price', `Price update: ${result.price.toFixed(2)}`, `Ticker: ${result.ticker || PRIMARY}`)

      // Check SL/TP auto-exit
      const autoExit = checkAutoExit(result.price)
      if (autoExit) {
        const res = closeTrade({ exitPrice: result.price, exitReason: autoExit })
        if (res.ok) refreshBroker(result.price)
      } else {
        refreshBroker(result.price)
      }
    } catch (e) {
      setPriceError(e.message)
    }
  }, [])

  // ── Evaluate signal from strategy ───────────────────────────────
  const evaluateSignal = useCallback(async () => {
    if (!strategy?.signalBody) return
    setIsEvaluating(true)
    setSignalError(null)

    try {
      const now   = new Date()
      const year  = now.getFullYear()
      const month = now.getMonth() + 1
      const prevY = month === 1 ? year - 1 : year
      const prevM = month === 1 ? 12 : month - 1

      const [curr, prev] = await Promise.all([
        fetchMonthRange(PRIMARY, TF, year, month),
        fetchMonthRange(PRIMARY, TF, prevY, prevM),
      ])
      const allBars = [...prev, ...curr].slice(-BARS_NEEDED)

      if (allBars.length < 20) {
        setSignalError('Not enough bars yet — market may be closed or outside trading hours')
        return
      }

      const indicators = buildIndicators(allBars, strategy.indicatorDefs || strategy.indicators || [])
      const signalFn   = new Function('i', 'candles', 'ind', 'pos', strategy.signalBody)
      const i          = allBars.length - 1
      const fakePos    = {
        isOpen: !!getOpenPosition(),
        side:   getOpenPosition()?.side || 'FLAT',
      }
      const result = signalFn(i, allBars, indicators, fakePos)

      // Capture snapshot of what the bot saw when it evaluated
      const lastBar = allBars[i]
      const indSnapshot = {}
      for (const [key, arr] of Object.entries(indicators)) {
        const val = Array.isArray(arr) ? arr[i] : arr
        if (val !== null && val !== undefined) {
          indSnapshot[key] = typeof val === 'number' ? val : val
        }
      }
      setDiagnostics({
        lastBar,
        indicators: indSnapshot,
        factors:    result?.factors || [],
        barCount:   allBars.length,
        evalTime:   Date.now(),
      })

      // Log what the bot found
      const indKeys = Object.keys(indSnapshot)
      logActivity('signal', `Signal: ${result?.action || 'NONE'}`, result?.reason || null)
      if (indKeys.length > 0) {
        logActivity('indicators', `Checked ${indKeys.length} indicators`, indKeys.slice(0, 6).map(k => `${k}: ${typeof indSnapshot[k] === 'number' ? indSnapshot[k].toFixed(2) : indSnapshot[k]}`).join(' · '))
      }
      if (result?.factors?.length > 0) {
        const passed = result.factors.filter(f => f.pass).length
        logActivity('factors', `${passed}/${result.factors.length} conditions met`, result.factors.map(f => `${f.pass ? '✓' : '✗'} ${f.name || ''}`).join('  '))
      }

      setRecentBars(allBars)
      setSignal(result || { action: 'NONE' })
      setSignalAge(Date.now())

      // ── Time-based exit — mirrors backtest's 30/50/75-bar rules ────
      const openPos = getOpenPosition()
      if (openPos) {
        const exitPrice = livePrice ?? lastBar.close
        const timeExitReason = checkTimeExit(exitPrice, allBars, 5)
        if (timeExitReason) {
          const res = await closeTrade({ exitPrice, exitReason: timeExitReason })
          if (res.ok) {
            recordLiveTrade({ ...res.trade, factors: normalizeFactor(result?.factors) }, strategy?.name || 'live')
            logActivity('trade', `Closed ${openPos.side} @ ${exitPrice.toFixed(2)}`, `${timeExitReason} → $${res.pnlDollars?.toFixed(0)}`)
            refreshBroker(exitPrice)
          }
        }
      }

      // Auto-trade
      if (autoTrade && result?.action && result.action !== 'NONE') {
        const pos = getOpenPosition()
        if (result.action !== lastAutoSig) {
          setLastAutoSig(result.action)
          if (result.action === 'LONG'  && !pos) placeOrder('LONG')
          if (result.action === 'SHORT' && !pos) placeOrder('SHORT')
          if (result.action === 'EXIT'  && pos)  handleClose('signal')
        }
      }
    } catch (e) {
      setSignalError(e.message)
    } finally {
      setIsEvaluating(false)
    }
  }, [strategy, autoTrade, lastAutoSig])

  // ── Start polling on mount ──────────────────────────────────────
  useEffect(() => {
    refreshBroker(null)
    fetchPrice()
    evaluateSignal()

    priceTimer.current  = setInterval(fetchPrice,      PRICE_POLL_MS)
    signalTimer.current = setInterval(evaluateSignal,  SIGNAL_POLL_MS)

    return () => {
      clearInterval(priceTimer.current)
      clearInterval(signalTimer.current)
    }
  }, [])

  // Re-register signal timer when deps change
  useEffect(() => {
    clearInterval(signalTimer.current)
    signalTimer.current = setInterval(evaluateSignal, SIGNAL_POLL_MS)
    return () => clearInterval(signalTimer.current)
  }, [evaluateSignal])

  // ── Update unrealized P&L as price changes ──────────────────────
  useEffect(() => {
    if (livePrice && position) {
      setUnrealizedPnl(getUnrealizedPnl(livePrice))
    }
  }, [livePrice, position])

  // ── Trade actions ───────────────────────────────────────────────
  function placeOrder(side) {
    // ── Eval daily loss limit ──────────────────────────────────────
    const todayPnl = getTodayPnl()
    if (todayPnl <= -EVAL_DAILY_LIMIT) {
      logActivity('filter', `⛔ BLOCKED ${side}`, `Daily limit hit — $${Math.abs(todayPnl).toFixed(0)} lost today (max $${EVAL_DAILY_LIMIT})`)
      return
    }

    // ── Cooldown between trades ───────────────────────────────────
    if (isInCooldown(3, 5)) {
      logActivity('filter', `⛔ BLOCKED ${side}`, 'Cooldown active — waiting after last close')
      return
    }

    // ── Check learning system ────────────────────────────────────
    const factors  = normalizeFactor(signal?.factors)
    const decision = shouldTakeTrade(factors, { minSampleSize: 8, expectancyFloor: 0 })
    setFilterDecision(decision)

    if (!decision.take && decision.sampleSize >= 8) {
      logActivity('filter', `⛔ BLOCKED ${side}`, `Expectancy ${decision.expectancyR}R over ${decision.sampleSize} backtests`)
      return
    }

    // ── Dynamic risk calculation ─────────────────────────────────
    const account = getAccount()
    const risk = calcDynamicRisk({
      candles:     recentBars.length > 20 ? recentBars : null,
      side,
      entryPrice:  livePrice,
      symbol:      SYMBOL,
      accountSize: account.balance,
      decision,
      baseRiskPct: 1,
    })

    // ── Eval contract cap — 2 max, drop to 1 after -$300 on the day ─
    const evalMaxContracts = todayPnl <= -300 ? 1 : EVAL_MAX_CONTRACTS
    risk.contracts = Math.min(risk.contracts, evalMaxContracts)
    setRiskCalc(risk)

    // Use manual SL/TP if set, otherwise use dynamic calculation
    const sl = parseFloat(manualSL) || risk.stopPrice
    const tp = parseFloat(manualTP) || risk.targetPrice
    const finalQty = risk.contracts

    const res = openTrade({
      symbol:     SYMBOL,
      side,
      entryPrice: livePrice,
      quantity:   finalQty,
      stopLoss:   sl,
      takeProfit: tp,
      signal:     signal?.action || 'manual',
      factors,
      regime:     'unknown',
    })

    if (res.error) {
      alert(res.error)
      logActivity('error', res.error)
    } else {
      logActivity('trade',
        `Opened ${side} @ ${livePrice?.toFixed(2)}`,
        `${finalQty}x ${SYMBOL} · SL ${sl?.toFixed(2)} · TP ${tp?.toFixed(2)} · Risk $${risk.riskDollars} · ${risk.rrRatio}R · ${risk.reasoning}`
      )
      refreshBroker(livePrice)
    }
  }

  function handleClose(reason = 'manual') {
    if (!livePrice) return
    const res = closeTrade({ exitPrice: livePrice, exitReason: reason })
    if (res.ok) {
      // Record into shared learning memory — feeds future backtest filters
      recordLiveTrade({ ...res.trade, factors: normalizeFactor(signal?.factors) }, strategy?.name || 'live')
      logActivity('trade', `Closed ${positionSide} @ ${livePrice?.toFixed(2)}`, `P&L: ${res.pnlDollars >= 0 ? '+' : ''}$${res.pnlDollars?.toFixed(0)} → saved to learning memory`)
      refreshBroker(livePrice)
      // Regenerate Pine Script after each close
      const allTrades = getTrades()
      const ps = generatePineScript(allTrades, 'NQ1!')
      if (ps) setPineScript(ps)
    }
  }

  function handleExportPine() {
    const allTrades = getTrades()
    const ps = generatePineScript(allTrades, 'NQ1!')
    if (ps) {
      setPineScript(ps)
      setTab('pine')
    }
  }

  function handleCopyPine() {
    if (!pineScript) return
    navigator.clipboard.writeText(pineScript).then(() => {
      setPineCopied(true)
      setTimeout(() => setPineCopied(false), 2500)
    })
  }

  function handleReset() {
    resetPaperAccount()
    refreshBroker(null)
    setPineScript(null)
    setShowReset(false)
  }

  // ── Helpers ─────────────────────────────────────────────────────
  function formatAge(ms) {
    if (!ms) return '—'
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60)   return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
  }

  function formatTime(ms) {
    if (!ms) return '—'
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const positionSide = position ? position.side : 'FLAT'
  const posColor = positionSide === 'LONG' ? 'var(--green)'
    : positionSide === 'SHORT' ? 'var(--red)' : 'var(--text-dim)'
  const signalColor = {
    LONG:  'var(--green)', SHORT: 'var(--red)',
    EXIT:  'var(--amber)', NONE:  'var(--text-dim)',
  }[signal?.action] || 'var(--text-dim)'
  const stats = getStats()
  const closedTrades = trades.filter(t => t.exitTime)
  const hasOpen = !!position

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 16px 80px' }}>

      {/* Nav */}
      <div className="row" style={{ marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-sm" onClick={onBack}>← Strategies</button>
        <button className="btn-sm" onClick={onBacktest}>📊 Backtest</button>
        <div style={{ flex: 1 }} />
        <button className="btn-sm" onClick={handleExportPine}
          disabled={closedTrades.length === 0}
          style={{ opacity: closedTrades.length === 0 ? 0.4 : 1 }}>
          📉 Export Pine Script
        </button>
        <button className="btn-sm"
          onClick={() => setShowReset(v => !v)}
          style={{ color: 'var(--red)' }}>
          Reset
        </button>
      </div>

      {showReset && (
        <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            Reset the paper account back to $25,000 and clear all trade history?
            This cannot be undone.
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={handleReset}
              style={{ padding: '6px 16px', background: 'var(--red)', color: '#fff',
                border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
              Yes, reset everything
            </button>
            <button onClick={() => setShowReset(false)} className="btn-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Eval Dashboard */}
      <EvalDashboard />

      {/* Account + Price row */}
      <div className="grid2" style={{ gap: 12, marginBottom: 12 }}>

        {/* Account */}
        <div className="stat-card">
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>PAPER ACCOUNT</div>
          <div style={{
            fontSize: 26, fontWeight: 800, letterSpacing: '-1px',
            color: stats.balance >= stats.startingBalance ? 'var(--green)' : 'var(--red)',
          }}>
            ${stats.balance.toLocaleString(undefined, { minimumFractionDigits: 0 })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            {stats.totalTrades} trades · {stats.winRate}% win rate
          </div>
          <div style={{ fontSize: 11, color: stats.realizedPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
            Realized: {stats.realizedPnl >= 0 ? '+' : ''}${stats.realizedPnl.toFixed(0)}
          </div>
        </div>

        {/* Live price */}
        <div className="stat-card">
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
            {PRIMARY} LIVE · {formatAge(priceAge)}
            <button onClick={fetchPrice}
              style={{ marginLeft: 8, fontSize: 10, color: 'var(--blue)', background: 'none',
                border: 'none', cursor: 'pointer', padding: 0 }}>
              ↻
            </button>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-1px' }}>
            {livePrice ? livePrice.toFixed(2) : '—'}
          </div>
          {priceError && (
            <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4 }}>
              {priceError}
            </div>
          )}
          {!priceError && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              Polling every 60s · 1 API call/min
            </div>
          )}
        </div>
      </div>

      {/* Signal + Position row */}
      <div className="grid2" style={{ gap: 12, marginBottom: 12 }}>

        {/* Signal */}
        <div className="card" style={{ borderColor: signalColor }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
            SIGNAL · {formatAge(signalAge)}
            {isEvaluating && <span style={{ marginLeft: 8, fontSize: 10 }}>evaluating…</span>}
            <button onClick={evaluateSignal}
              style={{ marginLeft: 8, fontSize: 10, color: 'var(--blue)', background: 'none',
                border: 'none', cursor: 'pointer', padding: 0 }}>
              ↻
            </button>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: signalColor, marginBottom: 4 }}>
            {signal?.action || '—'}
          </div>
          {signal?.reason && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{signal.reason}</div>
          )}
          {signalError && (
            <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{signalError}</div>
          )}
        </div>

        {/* Position */}
        <div className="card" style={{ borderColor: posColor }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>POSITION</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: posColor, marginBottom: 4 }}>
            {positionSide}
          </div>
          {position && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {position.quantity} × {SYMBOL} @ {position.entryPrice.toFixed(2)}
              </div>
              <div style={{
                fontSize: 15, fontWeight: 700, marginTop: 4,
                color: unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)',
              }}>
                Unrealized: {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
              </div>
              {position.stopLoss   && <div style={{ fontSize: 11, color: 'var(--red)' }}>SL {position.stopLoss}</div>}
              {position.takeProfit && <div style={{ fontSize: 11, color: 'var(--green)' }}>TP {position.takeProfit}</div>}
            </>
          )}
          {!position && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>No open position</div>
          )}
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <IVWallsPanel livePrice={livePrice} />
      </div>
      {/* Tabs */}
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        {[['trade', '⚡ Trade'], ['chart', '📈 Chart'], ['analysis', '🔍 Analysis'], ['history', `📋 History (${closedTrades.length})`], ['pine', '📉 Pine Script']].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
            border: '1px solid var(--border)', cursor: 'pointer',
            background: tab === t ? 'var(--blue)' : 'var(--surface)',
            color: tab === t ? '#fff' : 'var(--text)',
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Trade panel ─────────────────────────────────────────────── */}
      {tab === 'trade' && (
        <div className="card">

          {/* Auto-trade toggle */}
          <div className="row" style={{ marginBottom: 16, gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Auto-trade</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Fires orders automatically when signal changes direction
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <button onClick={() => setAutoTrade(v => !v)} style={{
              padding: '8px 16px', borderRadius: 6, fontSize: 13, fontWeight: 700,
              border: 'none', cursor: 'pointer',
              background: autoTrade ? 'var(--green)' : 'var(--surface)',
              color: autoTrade ? '#fff' : 'var(--text)',
              boxShadow: autoTrade ? '0 0 12px rgba(16,185,129,0.4)' : 'none',
            }}>
              {autoTrade ? '● AUTO ON' : '○ AUTO OFF'}
            </button>
          </div>

          {/* Learning system filter status */}
          {filterDecision && filterDecision.sampleSize >= 4 && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, marginBottom: 14,
              background: filterDecision.take
                ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${filterDecision.take
                ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
            }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <span style={{
                  fontSize: 13, fontWeight: 700,
                  color: filterDecision.take ? 'var(--green)' : 'var(--red)',
                }}>
                  {filterDecision.take ? '✓ Learning system: APPROVED' : '⛔ Learning system: BLOCKED'}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                  {filterDecision.sampleSize} backtests
                </span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
                <span>Expectancy: <strong style={{
                  color: filterDecision.expectancyR > 0 ? 'var(--green)' : 'var(--red)'
                }}>{filterDecision.expectancyR}R</strong></span>
                <span>Win rate: <strong>{filterDecision.winRate}%</strong></span>
                <span>Size: <strong>{filterDecision.sizeFactor}x</strong></span>
                {filterDecision.usedSession && (
                  <span>Session: <strong>{filterDecision.usedSession}</strong></span>
                )}
              </div>
              {!filterDecision.take && (
                <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>
                  This setup has negative expectancy in backtests — trade blocked to protect your account.
                </div>
              )}
            </div>
          )}

          {filterDecision && filterDecision.sampleSize < 4 && (
            <div style={{
              padding: '8px 12px', borderRadius: 8, marginBottom: 14,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--border)',
              fontSize: 11, color: 'var(--text-dim)',
            }}>
              🧠 Learning system: not enough data yet ({filterDecision.sampleSize}/8 backtests needed).
              Run more backtests to activate filtering.
            </div>
          )}

          {/* Dynamic risk display */}
          {riskCalc && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, marginBottom: 14,
              background: 'rgba(59,130,246,0.08)',
              border: '1px solid rgba(59,130,246,0.2)',
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--blue)' }}>
                📊 Dynamic Risk Calculator
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 8 }}>
                {[
                  ['Contracts', riskCalc.contracts],
                  ['Risk $', `$${riskCalc.riskDollars}`],
                  ['Risk %', `${riskCalc.riskPct}%`],
                  ['Stop', `${riskCalc.stopDistance}pts`],
                  ['Target', `${riskCalc.rrRatio}R`],
                  ['Profit', `$${riskCalc.potentialProfitDollars}`],
                ].map(([label, val]) => (
                  <div key={label} style={{ textAlign: 'center', padding: '6px', background: 'var(--surface)', borderRadius: 6 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                ATR {riskCalc.currentATR}pts
                {riskCalc.sampleSize >= 8 && ` · ${riskCalc.winRate}% win rate · ${riskCalc.riskMultiplier}x size`}
                {riskCalc.sampleSize < 8 && ' · No backtest data yet — using base 1% risk'}
              </div>
            </div>
          )}

          {/* SL / TP inputs */}
          <div className="row" style={{ gap: 8, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Stop Loss (optional)</div>
              <input
                type="number" step="0.25" placeholder="e.g. 22800"
                value={manualSL}
                onChange={e => setManualSL(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text)', fontSize: 13 }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Take Profit (optional)</div>
              <input
                type="number" step="0.25" placeholder="e.g. 22900"
                value={manualTP}
                onChange={e => setManualTP(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text)', fontSize: 13 }}
              />
            </div>
          </div>

          {/* Qty selector */}
          <div className="row" style={{ marginBottom: 14, gap: 8, alignItems: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600, minWidth: 80 }}>Contracts</div>
            <button onClick={() => setQty(q => Math.max(1, q - 1))}
              style={{ width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--surface)', cursor: 'pointer', fontSize: 18, color: 'var(--text)' }}>
              −
            </button>
            <div style={{ fontSize: 20, fontWeight: 700, minWidth: 32, textAlign: 'center' }}>{qty}</div>
            <button onClick={() => setQty(q => q + 1)}
              style={{ width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--surface)', cursor: 'pointer', fontSize: 18, color: 'var(--text)' }}>
              +
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}>
              {SYMBOL} micro · $2/pt · ~${(qty * 2 * (livePrice ? livePrice * 0.01 : 0)).toFixed(0)} notional
            </div>
          </div>

          {/* Buy / Sell buttons */}
          <div className="row" style={{ gap: 8 }}>
            <button
              onClick={() => placeOrder('LONG')}
              disabled={hasOpen || !livePrice}
              style={{
                flex: 1, padding: '14px', borderRadius: 8, border: 'none',
                background: 'var(--green)', color: '#fff', fontSize: 15, fontWeight: 800,
                cursor: (!hasOpen && livePrice) ? 'pointer' : 'not-allowed',
                opacity: (hasOpen || !livePrice) ? 0.4 : 1,
              }}>
              ▲ BUY LONG
            </button>
            <button
              onClick={() => placeOrder('SHORT')}
              disabled={hasOpen || !livePrice}
              style={{
                flex: 1, padding: '14px', borderRadius: 8, border: 'none',
                background: 'var(--red)', color: '#fff', fontSize: 15, fontWeight: 800,
                cursor: (!hasOpen && livePrice) ? 'pointer' : 'not-allowed',
                opacity: (hasOpen || !livePrice) ? 0.4 : 1,
              }}>
              ▼ SELL SHORT
            </button>
          </div>

          {hasOpen && (
            <button
              onClick={() => handleClose('manual')}
              style={{
                width: '100%', marginTop: 8, padding: '10px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text)', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}>
              ✕ Close {positionSide} position @ {livePrice?.toFixed(2)}
            </button>
          )}

          {!livePrice && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)', textAlign: 'center' }}>
              Waiting for price data — market may be closed outside RTH hours
            </div>
          )}
        </div>
      )}

      {/* ── Trade history ────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>Trade History</div>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {stats.wins}W / {stats.losses}L · {stats.winRate}% · avg win ${stats.avgWin} avg loss ${stats.avgLoss}
            </div>
          </div>

          {closedTrades.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              No completed trades yet. Place your first trade above.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...closedTrades].reverse().map(t => (
                <div key={t.id} style={{
                  padding: '10px 12px', background: 'var(--surface)',
                  border: `1px solid ${t.pnlDollars >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  borderRadius: 6,
                }}>
                  <div className="row">
                    <span style={{
                      fontSize: 12, fontWeight: 700,
                      color: t.side === 'LONG' ? 'var(--green)' : 'var(--red)',
                    }}>
                      {t.side === 'LONG' ? '▲' : '▼'} {t.side}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}>
                      {t.quantity}×{t.symbol}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700,
                      color: t.pnlDollars >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {t.pnlDollars >= 0 ? '+' : ''}${t.pnlDollars.toFixed(0)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                    Entry {t.entryPrice.toFixed(2)} @ {formatTime(t.entryTime)}
                    &nbsp;→&nbsp;
                    Exit {t.exitPrice.toFixed(2)} @ {formatTime(t.exitTime)}
                    &nbsp;·&nbsp;{t.exitReason}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Pine Script panel ────────────────────────────────────────── */}
      {tab === 'pine' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>TradingView Pine Script</div>
            <div style={{ flex: 1 }} />
            <button onClick={handleExportPine} className="btn-sm">↻ Regenerate</button>
          </div>

          {closedTrades.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              Complete at least one trade to generate the Pine Script.
            </div>
          ) : !pineScript ? (
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
                Generate Pine Script to visualize your {closedTrades.length} trades on TradingView.
              </div>
              <button onClick={handleExportPine}
                style={{ padding: '10px 20px', borderRadius: 8, background: 'var(--blue)',
                  color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                Generate Pine Script
              </button>
            </div>
          ) : (
            <>
              {/* Instructions */}
              <div style={{
                background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
                borderRadius: 6, padding: '10px 12px', marginBottom: 12, fontSize: 12,
                color: 'var(--text-muted)', lineHeight: 1.6,
              }}>
                <strong>How to add to TradingView:</strong><br/>
                1. Open your NQ or MNQ chart on TradingView<br/>
                2. Click Pine Script editor at the bottom → New indicator<br/>
                3. Select all → paste the code below → Add to chart<br/>
                4. Set chart to <strong>5-minute</strong> timeframe for best results
              </div>

              <button onClick={handleCopyPine}
                style={{
                  width: '100%', padding: '10px', borderRadius: 8, border: 'none',
                  background: pineCopied ? 'var(--green)' : 'var(--blue)',
                  color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  marginBottom: 10, transition: 'background 0.2s',
                }}>
                {pineCopied ? '✓ Copied to clipboard!' : '📋 Copy Pine Script'}
              </button>

              <textarea
                readOnly
                value={pineScript}
                style={{
                  width: '100%', boxSizing: 'border-box', height: 300,
                  background: '#0d1117', color: '#e6edf3',
                  border: '1px solid var(--border)', borderRadius: 6,
                  fontFamily: 'monospace', fontSize: 11, padding: '10px',
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                {closedTrades.length} trades · {pineScript.split('\n').length} lines
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Chart tab ─────────────────────────────────────────────── */}
      {tab === 'chart' && (
        <TradeChart trades={trades} livePrice={livePrice} />
      )}

      {/* ── Analysis / Diagnostics panel ──────────────────────────── */}
      {tab === 'analysis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {!diagnostics ? (
            <div className="card" style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              Signal hasn't evaluated yet — click ↻ on the Signal card or wait for the next cycle.
            </div>
          ) : (
            <>
              {/* Last bar read */}
              <div className="card">
                <div className="card-title">Last Bar Evaluated</div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12 }}>
                  {[
                    ['Time',  new Date(diagnostics.lastBar?.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })],
                    ['Open',  diagnostics.lastBar?.open?.toFixed(2)],
                    ['High',  diagnostics.lastBar?.high?.toFixed(2)],
                    ['Low',   diagnostics.lastBar?.low?.toFixed(2)],
                    ['Close', diagnostics.lastBar?.close?.toFixed(2)],
                    ['Bars used', diagnostics.barCount],
                  ].map(([label, val]) => (
                    <div key={label}>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
                      <div style={{ fontWeight: 700 }}>{val ?? '—'}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Indicator readings */}
              <div className="card">
                <div className="card-title">Indicator Readings</div>
                {Object.keys(diagnostics.indicators).length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    No named indicators found. The strategy may use inline calculations.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                    {Object.entries(diagnostics.indicators).map(([key, val]) => {
                      const num = typeof val === 'number' ? val : null
                      const close = diagnostics.lastBar?.close
                      const isAbove = num && close && close > num
                      const isBullish = key.toLowerCase().includes('bull') || val === true
                      const isBearish = key.toLowerCase().includes('bear') || val === false
                      const color = isBullish ? 'var(--green)'
                        : isBearish ? 'var(--red)'
                        : num && close ? (isAbove ? 'var(--green)' : 'var(--red)')
                        : 'var(--text)'

                      return (
                        <div key={key} style={{
                          padding: '8px 10px', background: 'var(--surface)',
                          border: '1px solid var(--border)', borderRadius: 6,
                        }}>
                          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3,
                            textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {key}
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 700, color }}>
                            {typeof val === 'boolean' ? (val ? '✓ YES' : '✗ NO')
                              : typeof val === 'number' ? val.toFixed(2)
                              : typeof val === 'object' && val !== null
                                ? JSON.stringify(val).slice(0, 30)
                                : String(val)}
                          </div>
                          {num && close && (
                            <div style={{ fontSize: 10, color, marginTop: 2 }}>
                              Price {isAbove ? 'above ↑' : 'below ↓'}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Strategy factors */}
              {diagnostics.factors?.length > 0 && (
                <div className="card">
                  <div className="card-title">Signal Factors</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {diagnostics.factors.map((f, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '7px 10px', background: 'var(--surface)',
                        border: `1px solid ${f.pass ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                        borderRadius: 6,
                      }}>
                        <span style={{ fontSize: 14, color: f.pass ? 'var(--green)' : 'var(--red)' }}>
                          {f.pass ? '✓' : '✗'}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{f.name || f.label || `Factor ${i + 1}`}</div>
                          {f.value !== undefined && (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                              {typeof f.value === 'number' ? f.value.toFixed(3) : String(f.value)}
                            </div>
                          )}
                        </div>
                        {f.weight !== undefined && (
                          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                            weight {f.weight}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Strategy signal body preview */}
              <div className="card">
                <div className="card-title">Signal Logic</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
                  This is the exact code running on every evaluation. Check it matches your strategy rules.
                </div>
                <pre style={{
                  background: '#0d1117', color: '#e6edf3',
                  padding: '10px', borderRadius: 6, fontSize: 10,
                  overflowX: 'auto', maxHeight: 200, overflowY: 'auto',
                  margin: 0, lineHeight: 1.5,
                  border: '1px solid var(--border)',
                }}>
                  {strategy?.signalBody || 'No signal body found'}
                </pre>
              </div>

              {/* Live activity feed */}
              <div className="card">
                <div className="row" style={{ marginBottom: 10 }}>
                  <div className="card-title" style={{ margin: 0 }}>🟢 Live Activity Feed</div>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setActivityLog([])} className="btn-sm" style={{ fontSize: 10 }}>Clear</button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
                  Every action the bot takes appears here in real time — price checks, indicator reads, signal decisions, trades.
                </div>
                {activityLog.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    Waiting for bot activity... Price updates every 60s, signal evaluates every 5min.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 340, overflowY: 'auto' }}>
                    {activityLog.map(e => (
                      <div key={e.id} style={{
                        padding: '6px 10px', borderRadius: 6,
                        background: 'var(--surface)',
                        borderLeft: `3px solid ${
                          e.type === 'trade'      ? 'var(--green)'  :
                          e.type === 'signal'     ? 'var(--blue)'   :
                          e.type === 'indicators' ? 'var(--amber)'  :
                          e.type === 'factors'    ? '#a855f7'       :
                          e.type === 'error'      ? 'var(--red)'    :
                          'var(--border)'
                        }`,
                      }}>
                        <div className="row" style={{ gap: 8, marginBottom: e.detail ? 2 : 0 }}>
                          <span style={{ fontSize: 10, color: 'var(--text-dim)', minWidth: 60 }}>{e.time}</span>
                          <span style={{
                            fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                            color: e.type === 'trade' ? 'var(--green)' : e.type === 'error' ? 'var(--red)' : 'var(--text-dim)',
                            minWidth: 70,
                          }}>
                            {e.type}
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{e.message}</span>
                        </div>
                        {e.detail && (
                          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 138, marginTop: 1 }}>
                            {e.detail}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

    </div>
  )
}
