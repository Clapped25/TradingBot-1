import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import CandlestickChart from './CandlestickChart'
import LearningPanel from './LearningPanel'
import ConfluencePanel from './ConfluencePanel'
import TradeJournal from './TradeJournal'
import AccountPanel from './AccountPanel'
import SignalDiagnostics from './SignalDiagnostics'
import FeedbackLoop from './FeedbackLoop'
import { buildIndicators } from '../indicators'
import { createBacktestEngine, calcStats, walkForwardValidate, runBacktest } from '../backtest'
import { recordBacktestTrades, getCombinationStats, getAllTrades, getQualityStats, SESSION_LABELS } from '../tradeMemory'
import { saveLearningSnapshot } from '../learningHistory'
import { getOpenPositionAt } from '../account'
import { getStrategyFeedback } from '../claude'
import { saveVersion, getPreviousVersion, addTestedMonths, getUnseenMonth } from '../strategyVersioning'
import { fetchSelectedMonths, getAvailableMonths } from '../massiveFinance'

const SPEED_MS   = [800, 400, 200, 100, 50, 16, 16, 16]  // ms between renders
const BATCH_SIZE = [  1,   1,   1,   1,  1,  5, 20, 50]  // bars per render at high speeds
const SPEED_LABELS = ['0.5×', '1×', '2×', '4×', '8×', '16×', '32×', '64×']
const IND_COLORS = {
  ema9: '#f0a020', ema21: '#2d6cdf', ema50: '#9c7aff',
  sma20: '#00a8b5', sma50: '#f0a020', sma200: '#9c7aff',
}

export default function BacktestResults({
  candles, indicators: initialIndicators,
  symbol, tf, strategy, strategyId, riskConfig, onStrategyChange, onBack, onNew,
}) {
  // Local, mutable copies — these get replaced when feedback/optimization is applied
  const [indicatorDefs, setIndicatorDefs] = useState(strategy.indicators || [])
  const [signalBody, setSignalBody] = useState(strategy.signalBody || '')
  const [indicators, setIndicators] = useState(initialIndicators)
  const [appliedNote, setAppliedNote] = useState('')
  const [walkForward, setWalkForward] = useState(null)
  const [walkForwardLoading, setWalkForwardLoading] = useState(false)
  const [feedbackStatus, setFeedbackStatus] = useState(null)   // null | 'loading' | 'proposed' | 'rejected' | 'validating' | 'kept' | 'reverted'
  const [feedbackData, setFeedbackData] = useState(null)       // the AI's proposed changes
  const [validationResult, setValidationResult] = useState(null) // metrics before/after
  const [memoryRefresh, setMemoryRefresh] = useState(0)
  const [memoryUpdate, setMemoryUpdate] = useState(null) // visible proof the session's trades were folded into permanent learning

  // Just a human-readable label for the shared trade memory — NOT a partition.
  const sourceLabel = strategy.name || 'Untitled strategy'

  const signalFn = useMemo(
    () => new Function('i', 'candles', 'ind', 'pos', signalBody || 'return{action:"none"}'),
    [signalBody]
  )

  // The live, stateful engine. It holds ZERO trades until evaluateBar()
  // is actually called — which only happens during replay, one bar at
  // a time, in the exact order a live feed would deliver them. There is
  // no precomputed result sitting here waiting to be revealed.
  const engineRef = useRef(createBacktestEngine(riskConfig))

  const START_BAR = Math.min(20, candles.length - 1)
  const [replayIdx, setReplayIdx]       = useState(START_BAR)
  const [hasStarted, setHasStarted]     = useState(false)
  const [isPlaying, setIsPlaying]       = useState(false)
  const [speed, setSpeed]               = useState(4)
  const [shownTrades, setShownTrades]   = useState([]) // built live by the engine — the only source of truth
  const [blockedCount, setBlockedCount] = useState(0)   // trades the learning filter skipped — for transparency
  const [alert, setAlert]               = useState(null)
  const [expandedTrade, setExpandedTrade] = useState(null)
  const timerRef = useRef(null)
  const alertTimerRef = useRef(null)

  const trades = shownTrades
  const exits = trades.filter(t => t.type === 'exit')
  const isFinished = hasStarted && replayIdx >= candles.length - 1
  const stats = exits.length > 0 ? calcStats(exits, riskConfig?.accountBalance) : null

  // Seed the shared trade memory only once a full pass has actually
  // completed — not on every partial tick, so memory isn't spammed
  // with incomplete snapshots. This is also the proof-of-learning
  // moment: we show exactly what got added and how close each combo
  // from this session now is to actively filtering future trades.
  useEffect(() => {
    if (isFinished && exits.length) {
      recordBacktestTrades(exits, sourceLabel)
      setMemoryRefresh(n => n + 1)

      const comboKeyFor = (factors) => Object.entries(factors || {})
        .filter(([, v]) => v === true).map(([k]) => k).sort().join(' + ')
      const sessionCombos = [...new Set(exits.map(t => comboKeyFor(t.factors)).filter(Boolean))]
      const allCombos = getCombinationStats(1)
      const comboProgress = sessionCombos.map(combo => {
        const stat = allCombos.find(c => c.combo === combo)
        return {
          combo,
          total: stat?.total || 0,
          expectancyR: stat?.expectancyR ?? null,
          active: (stat?.total || 0) >= 8,
        }
      })

      const allTradesForStrategy = getAllTrades().filter(t => t.sourceStrategy === sourceLabel)
      const cumulativeTotal = allTradesForStrategy.length
      setMemoryUpdate({ tradeCount: exits.length, cumulativeTotal, comboProgress })

      // Save a timestamped snapshot so the Learning Dashboard can chart progress
      const qualStats = getQualityStats()
      const activeFilters = allCombos.filter(c => c.total >= 8 && c.expectancyR <= 0).length
      const winTradesCount = allTradesForStrategy.filter(t => t.win).length
      const winRateAll = allTradesForStrategy.length
        ? +(winTradesCount / allTradesForStrategy.length * 100).toFixed(1) : 0
      const avgExpR = allCombos.length
        ? +(allCombos.reduce((s, c) => s + (c.expectancyR || 0), 0) / allCombos.length).toFixed(3) : null

      // Regime stats across all trades for this strategy
      const regimeMap = {}
      for (const t of allTradesForStrategy) {
        const r = t.regime || 'unknown'
        if (!regimeMap[r]) regimeMap[r] = { wins: 0, total: 0, totalPnl: 0 }
        regimeMap[r].total++
        if (t.win) regimeMap[r].wins++
        regimeMap[r].totalPnl += t.pnlPct || 0
      }
      const regimeStats = Object.entries(regimeMap).map(([regime, s]) => ({
        regime,
        total: s.total,
        winRate: +(s.wins / s.total * 100).toFixed(1),
        avgPnl: +(s.totalPnl / s.total).toFixed(2),
      }))

      saveLearningSnapshot({
        strategyName: sourceLabel,
        newTradesThisRun: exits.length,
        cumulativeTradeCount: cumulativeTotal,
        expectancyR: avgExpR,
        winRate: winRateAll,
        blockedThisRun: blockedCount,
        activeFilterCount: activeFilters,
        avgMfeR: qualStats?.avgMfeR ?? null,
        avgMaeR: qualStats?.avgMaeR ?? null,
        avgQuality: qualStats?.avgQuality ?? null,
        comboStats: allCombos,
        regimeStats,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFinished])

  // Auto-trigger AI feedback when a backtest finishes and has trades
  // Small delay so the memory update renders first
  useEffect(() => {
    if (!isFinished || !exits.length || feedbackStatus) return
    const timer = setTimeout(async () => {
      setFeedbackStatus('loading')
      setFeedbackData(null)
      setValidationResult(null)
      try {
        const fb = await getStrategyFeedback(strategy, shownTrades, stats || {})
        setFeedbackData(fb)
        setFeedbackStatus('proposed')
      } catch (e) {
        console.error('Auto feedback error:', e)
        setFeedbackStatus(null) // silently fail — don't block the results screen
      }
    }, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFinished])

  async function handleApproveFeedback() {
    if (!feedbackData?.newSignalBody) return
    setFeedbackStatus('validating')

    try {
      // 1. Save checkpoint of current strategy before changing anything
      saveVersion({
        strategyName: sourceLabel,
        signalBody: signalBody,
        indicatorDefs: indicatorDefs,
        metrics: stats ? { winRate: stats.winRate, expectancyR: null, tradeCount: exits.length } : null,
        note: 'Before AI feedback change',
      })

      // 2. Pick an unseen month for validation
      const availableMonths = getAvailableMonths(30)
      const unseenMonth = getUnseenMonth(sourceLabel, availableMonths)
      setValidationResult({ unseenMonth })

      // 3. Compute "before" metrics from current stats
      const beforeMetrics = {
        winRate: parseFloat(stats?.winRate || 0),
        expectancyR: stats ? +(exits.reduce((s, t) => s + (t.riskDollars ? t.dollarPnl / t.riskDollars : 0), 0) / exits.length).toFixed(2) : 0,
        tradeCount: exits.length,
      }

      // 4. Fetch unseen month data
      const unseenCandles = await fetchSelectedMonths(riskConfig.symbolKey, tf || '1h', [unseenMonth])

      if (!unseenCandles.length) throw new Error('No data returned for unseen month')

      // 5. Run new signal on unseen data
      const unseenIndicators = buildIndicators(unseenCandles, indicatorDefs || [])
      const newSignalFn = new Function('i', 'candles', 'ind', 'pos', feedbackData.newSignalBody)
      const { exits: unseenExits } = runBacktest(unseenCandles, unseenIndicators, newSignalFn, riskConfig)
      const afterStats = calcStats(unseenExits, riskConfig?.accountBalance || 25000)

      const afterMetrics = {
        winRate: parseFloat(afterStats?.winRate || 0),
        expectancyR: unseenExits.length
          ? +(unseenExits.reduce((s, t) => s + (t.riskDollars ? t.dollarPnl / t.riskDollars : 0), 0) / unseenExits.length).toFixed(2)
          : 0,
        tradeCount: unseenExits.length,
      }

      // 6. Did it improve? Better expectancy OR win rate with meaningful sample
      const improved = afterMetrics.tradeCount >= 3 &&
        (afterMetrics.expectancyR > beforeMetrics.expectancyR ||
         afterMetrics.winRate > beforeMetrics.winRate)

      setValidationResult({ unseenMonth, before: beforeMetrics, after: afterMetrics, improved })

      if (improved) {
        // Keep the change — apply to strategy
        onStrategyChange({ ...strategy, signalBody: feedbackData.newSignalBody })
        addTestedMonths(sourceLabel, [unseenMonth.key])
        setFeedbackStatus('kept')
      } else {
        // Revert — don't apply
        setFeedbackStatus('reverted')
      }
    } catch (e) {
      console.error('Validation error:', e)
      setFeedbackStatus('reverted')
      setValidationResult(prev => ({ ...prev, error: e.message }))
    }
  }

  function handleRejectFeedback() {
    setFeedbackStatus('rejected')
  }

  function handleWalkForward() {
    setWalkForwardLoading(true)
    setWalkForward(null)
    // Small delay so the loading state renders before blocking computation
    setTimeout(() => {
      try {
        const result = walkForwardValidate(candles, indicators, signalFn, riskConfig)
        setWalkForward(result)
      } catch (e) {
        console.error('Walk-forward error:', e)
      } finally {
        setWalkForwardLoading(false)
      }
    }, 50)
  }

  function handleApplyChange({ indicatorDefs: newDefs, signalBody: newSignalBody }) {
    const newIndicators = buildIndicators(candles, newDefs)
    setIndicatorDefs(newDefs)
    setSignalBody(newSignalBody)
    setIndicators(newIndicators)
    engineRef.current = createBacktestEngine(riskConfig) // fresh engine for the revised strategy
    resetReplay()
    setAppliedNote('Press ▶ Play to test the updated strategy')
    setTimeout(() => setAppliedNote(''), 5000)

    // Keep the saved strategy record up to date with the improved version
    if (onStrategyChange) {
      onStrategyChange({ ...strategy, indicators: newDefs, signalBody: newSignalBody })
    }
  }

  // Clean up timers on unmount
  useEffect(() => () => {
    clearTimeout(timerRef.current)
    clearTimeout(alertTimerRef.current)
  }, [])

  // ── Replay step — asks the engine to evaluate exactly ONE new bar ──
  // This is the causal guarantee: evaluateBar(next, ...) only ever sees
  // candles[0..next] and indicator values up to that index. The engine
  // has no mechanism to peek further ahead than the bar it's currently
  // being asked about.
  const step = useCallback((currentIdx) => {
    // Process multiple bars per render at high speeds to prevent lag
    const batch = BATCH_SIZE[speed] || 1
    let idx = currentIdx
    let lastEvent = null
    let newTrades = []
    let blocked = 0

    for (let b = 0; b < batch; b++) {
      const next = idx + 1
      if (next >= candles.length) {
        setIsPlaying(false)
        setReplayIdx(candles.length - 1)
        if (newTrades.length) setShownTrades(prev => [...prev, ...newTrades])
        if (blocked) setBlockedCount(n => n + blocked)
        return
      }
      idx = next

      const event = engineRef.current.evaluateBar(next, candles, indicators, signalFn)
      if (event?.type === 'blocked') {
        blocked++
        lastEvent = event
      } else if (event) {
        newTrades.push(event)
        lastEvent = event
      }
    }

    // Single React state update for the whole batch — prevents lag
    setReplayIdx(idx)
    if (newTrades.length) setShownTrades(prev => [...prev, ...newTrades])
    if (blocked) setBlockedCount(n => n + blocked)
    if (lastEvent) {
      setAlert(lastEvent)
      clearTimeout(alertTimerRef.current)
      alertTimerRef.current = setTimeout(() => setAlert(null), 4000)
    }

    timerRef.current = setTimeout(() => step(idx), SPEED_MS[speed])
  }, [candles, indicators, signalFn, speed])

  function startPlay() {
    if (isPlaying) return
    const freshStart = !hasStarted || replayIdx >= candles.length - 1
    const start = freshStart ? START_BAR : replayIdx
    if (freshStart) {
      engineRef.current = createBacktestEngine(riskConfig) // genuinely fresh run, zero prior state
      setShownTrades([])
      setBlockedCount(0)
      setMemoryUpdate(null)
    }
    setReplayIdx(start)
    setHasStarted(true)
    setIsPlaying(true)
    setAlert(null)
    timerRef.current = setTimeout(() => step(start), SPEED_MS[speed])
  }

  function pausePlay() {
    clearTimeout(timerRef.current)
    setIsPlaying(false)
  }

  function resetReplay() {
    clearTimeout(timerRef.current)
    clearTimeout(alertTimerRef.current)
    setIsPlaying(false)
    setHasStarted(false)
    setReplayIdx(START_BAR)
    setShownTrades([])
    setBlockedCount(0)
    setMemoryUpdate(null)
    setAlert(null)
    setWalkForward(null)
    setFeedbackStatus(null)
    setFeedbackData(null)
    setValidationResult(null)
    setExpandedTrade(null)
    engineRef.current = createBacktestEngine(riskConfig)
  }

  // Speed change restarts timer at new interval if playing
  function handleSpeedChange(val) {
    setSpeed(Number(val))
    if (isPlaying) {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => step(replayIdx), SPEED_MS[Number(val)])
    }
  }

  // Which trades to show in the log — nothing until the bot has actually played through
  const logTrades = hasStarted ? shownTrades.filter(t => t.type === 'exit') : []

  // Progress %
  const progress = hasStarted ? (replayIdx / (candles.length - 1)) * 100 : 0

  return (
    <div>
      {/* Nothing is revealed until you press Play — the bot hasn't looked yet */}
      {!hasStarted ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '28px 20px' }}>
          <p style={{ fontSize: 13, lineHeight: 1.6 }}>
            ▶ Press Play below to start the bot scanning through the chart, bar by bar — account balance, PnL, and trades will appear as it finds them, live.
          </p>
        </div>
      ) : trades.length > 0 ? (
        <AccountPanel
          candles={candles}
          trades={trades}
          stats={stats}
          startingBalance={riskConfig?.accountBalance}
          replayIdx={replayIdx}
          symbolKey={riskConfig?.symbolKey}
          useMicro={riskConfig?.useMicro}
        />
      ) : isFinished ? (
        <SignalDiagnostics indicators={indicators} candles={candles} />
      ) : (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '20px' }}>
          Scanning... no trades found yet through bar {replayIdx} of {candles.length}.
        </div>
      )}

      {hasStarted && stats && (
        <div className="grid2" style={{ marginBottom: 14 }}>
          <div className="stat-card">
            <div className="stat-val" style={{ fontSize: 17 }}>{stats.total}</div>
            <div className="stat-lbl">Total trades</div>
          </div>
          <div className="stat-card">
            <div className="stat-val" style={{ fontSize: 17, color: 'var(--red)' }}>-${stats.maxDDDollar}</div>
            <div className="stat-lbl">Max drawdown</div>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {symbol} · {tf} · {candles.length} bars
          </span>
          <span style={{ flex: 1 }} />
          {/* Indicator legend */}
          <div className="chart-legend">
            {Object.entries(indicators)
              .filter(([k]) => IND_COLORS[k] !== undefined)
              .map(([id]) => (
                <div key={id} className="legend-item">
                  <div className="legend-line" style={{ background: IND_COLORS[id] || '#888' }} />
                  {id.toUpperCase()}
                </div>
              ))}
            <div className="legend-item">
              <span style={{ color: 'var(--green)', fontSize: 13 }}>▲</span> Buy
            </div>
            <div className="legend-item">
              <span style={{ color: 'var(--red)', fontSize: 13 }}>▼</span> Exit
            </div>
          </div>
        </div>

        <CandlestickChart
          candles={candles}
          indicators={indicators}
          trades={trades}
          replayIdx={replayIdx}
        />

        {/* Progress bar */}
        {hasStarted && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {/* Replay controls */}
        <div className="replay-controls">
          {!isPlaying
            ? <button className="btn-sm active" onClick={startPlay}>▶ Play</button>
            : <button className="btn-sm active" onClick={pausePlay}>⏸ Pause</button>
          }
          <button className="btn-sm" onClick={resetReplay}>↺ Reset</button>

          <div className="row" style={{ gap: 8, marginLeft: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Speed</span>
            <input
              type="range" min={0} max={7} value={speed}
              onChange={e => handleSpeedChange(e.target.value)}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 32 }}>
              {SPEED_LABELS[speed]}
            </span>
          </div>

          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
            {hasStarted
              ? `Bar ${replayIdx} / ${candles.length}`
              : `${candles.length} bars — press Play to start`
            }
          </span>
        </div>

        {/* Live bot status — makes it visible the bot is actively scanning, not frozen */}
        {hasStarted && (
          <div className="row" style={{ marginTop: 8, fontSize: 12 }}>
            {(() => {
              const openNow = getOpenPositionAt(trades.filter(t => t.barIndex <= replayIdx), replayIdx)
              if (openNow) {
                return (
                  <span style={{ color: 'var(--green)' }}>
                    ● In position — {openNow.contracts}× since bar {openNow.barIndex}, stop {openNow.stopPrice.toFixed(2)}, target {openNow.takeProfitPrice.toFixed(2)}
                  </span>
                )
              }
              return (
                <span style={{ color: 'var(--text-dim)' }}>
                  {isPlaying ? '◌ Scanning for a setup...' : isFinished ? '○ Finished — flat' : '⏸ Paused — flat'}
                </span>
              )
            })()}
            {blockedCount > 0 && (
              <span style={{ marginLeft: 'auto', color: 'var(--amber)' }}>
                🛡️ {blockedCount} skipped by learning
              </span>
            )}
          </div>
        )}
      </div>

      {/* Trade alert */}
      {alert && <TradeAlert trade={alert} allTrades={trades} />}

      {appliedNote && (
        <div className="trade-alert win" style={{ marginBottom: 12 }}>
          <div className="trade-alert-title">✓ Strategy updated</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{appliedNote}</div>
        </div>
      )}

      {/* Automated feedback loop — runs after every completed session */}
      <FeedbackLoop
        status={feedbackStatus}
        feedback={feedbackData}
        validationResult={validationResult}
        onApprove={handleApproveFeedback}
        onReject={handleRejectFeedback}
      />

      {/* Walk-forward validation — the honest test of whether improvement is real */}
      {isFinished && (
        <div className="card">
          <div className="row" style={{ marginBottom: 4 }}>
            <div>
              <div className="card-title" style={{ margin: 0 }}>Walk-forward validation</div>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                Splits your data into 3 windows and runs the strategy on each independently. The only honest test that performance isn't just overfitting.
              </p>
            </div>
            <button
              className="btn-sm"
              style={{ flexShrink: 0, alignSelf: 'flex-start', marginLeft: 12 }}
              onClick={handleWalkForward}
              disabled={walkForwardLoading}
            >
              {walkForwardLoading ? '⏳ Running...' : '🔬 Run walk-forward test'}
            </button>
          </div>

          {walkForward && (() => {
            const verdictColor = walkForward.verdict === 'pass' ? 'var(--green)' : walkForward.verdict === 'marginal' ? 'var(--amber)' : 'var(--red)'
            const verdictText = walkForward.verdict === 'pass'
              ? '✓ PASS — positive expectancy across all 3 periods including out-of-sample'
              : walkForward.verdict === 'marginal'
              ? '⚠ MARGINAL — profitable in 2 of 3 periods but failed the unseen test'
              : '✗ FAIL — strategy does not generalize across different market periods'
            return (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: verdictColor, marginBottom: 10 }}>
                  {verdictText}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {walkForward.results.map((r, i) => {
                    const positive = r.stats && parseFloat(r.stats.totalDollarPnl) > 0
                    return (
                      <div key={i} className="stat-card" style={{
                        flex: '1 1 0', minWidth: 140,
                        borderColor: positive ? 'var(--green-border)' : 'var(--red-border)',
                      }}>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>{r.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>{r.dateStart} → {r.dateEnd}</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: positive ? 'var(--green)' : 'var(--red)' }}>
                          {r.stats ? (parseFloat(r.stats.totalDollarPnl) >= 0 ? '+' : '') + '$' + r.stats.totalDollarPnl : 'No trades'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                          {r.tradeCount} trades · {r.stats?.winRate ?? 0}% win
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      <LearningPanel
        strategy={strategy}
        candles={candles}
        indicatorDefs={indicatorDefs}
        signalBody={signalBody}
        trades={trades}
        stats={stats}
        onApply={handleApplyChange}
      />

      {/* Proof the bot actually learned from this session — not just a claim */}
      {memoryUpdate && (
        <div className="card" style={{ borderColor: 'var(--blue)' }}>
          <div className="card-title" style={{ color: 'var(--blue)' }}>✓ Memory updated</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            +{memoryUpdate.tradeCount} trade{memoryUpdate.tradeCount !== 1 ? 's' : ''} from this session permanently recorded.
          </p>

          {/* Cumulative progress toward 100 trades */}
          {(() => {
            const total = memoryUpdate.cumulativeTotal || 0
            const progress = Math.min(100, (total / 100) * 100)
            const status = total >= 100 ? { label: 'Strategy is statistically reliable', color: 'var(--green)' }
              : total >= 50 ? { label: 'Getting meaningful — keep running', color: 'var(--amber)' }
              : total >= 20 ? { label: 'Building sample size', color: 'var(--amber)' }
              :               { label: 'Need more trades before trusting results', color: 'var(--red)' }
            return (
              <div style={{ marginBottom: memoryUpdate.comboProgress.length ? 14 : 0 }}>
                <div className="row" style={{ marginBottom: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: status.color }}>
                    {total} total trades — {status.label}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                    {total}/100
                  </span>
                </div>
                <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    width: `${progress}%`, height: '100%', borderRadius: 3,
                    background: status.color, transition: 'width 0.4s ease',
                  }} />
                </div>
                {total < 100 && (
                  <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5 }}>
                    {100 - total} more trades needed for statistical reliability. Run across different date ranges to get there faster.
                  </p>
                )}
              </div>
            )
          })()}

          {memoryUpdate.comboProgress.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>Factor combo progress toward active filtering (8 trades needed):</div>
              {memoryUpdate.comboProgress.map((c, i) => (
                <div key={i} className="row" style={{ fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>{c.combo}</span>
                  {c.active ? (
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                      ● actively filtering ({c.total} trades, {c.expectancyR >= 0 ? '+' : ''}{c.expectancyR}R)
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-dim)' }}>
                      {c.total}/8 — {8 - c.total} more to activate
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ConfluencePanel refreshKey={memoryRefresh} />

      <TradeJournal refreshKey={memoryRefresh} />

      {/* Trade log */}
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="card-title" style={{ margin: 0 }}>
            Trade log — {logTrades.length} completed trade{logTrades.length !== 1 ? 's' : ''}
          </div>
          {isFinished && exits.length > 0 && stats && (
            <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto' }}>
              Avg win: <span style={{ color: 'var(--green)' }}>+{stats.avgWin}%</span>
              &nbsp;&nbsp;Avg loss: <span style={{ color: 'var(--red)' }}>{stats.avgLoss}%</span>
            </span>
          )}
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {logTrades.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-dim)', textAlign: 'center', padding: '20px 0' }}>
              {isFinished
                ? 'No trades were taken. See the diagnostic above, or try adjusting the signal function.'
                : 'Press Play — trades will appear here the moment the bot takes them.'}
            </p>
          ) : (
            logTrades.map((t, i) => {
              const entry = trades.find(e => e.type === 'entry' && e.barIndex === t.entryBarIdx)
              const win = t.pnlPct > 0
              const isExpanded = expandedTrade === i
              return (
                <div
                  key={i}
                  className={`trade-row ${win ? 'win' : 'loss'}`}
                  onClick={() => setExpandedTrade(isExpanded ? null : i)}
                >
                  <div className="row">
                    <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>#{i + 1}</span>
                    <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                      Buy <b style={{ color: 'var(--text)' }}>{entry?.price.toFixed(2) ?? '—'}</b>
                      <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>→</span>
                      Sell <b style={{ color: 'var(--text)' }}>{t.price.toFixed(2)}</b>
                      <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>
                        {t.contracts}× · {t.barIndex - (t.entryBarIdx ?? 0)} bars
                        {t.rMultiple != null && <> · {t.rMultiple >= 0 ? '+' : ''}{t.rMultiple}R</>}
                        {entry?.time != null && <> · {new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}
                      </span>
                    </span>
                    <span className="spacer" />
                    <span className="trade-pnl">
                      {win ? '+' : ''}${t.dollarPnl?.toFixed(2) ?? '0.00'}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>
                      {isExpanded ? '▲' : '▼'}
                    </span>
                  </div>

                  {isExpanded && (
                    <div className="trade-detail" onClick={e => e.stopPropagation()}>
                      <div style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: 500, color: 'var(--green)' }}>Why entered: </span>
                        <span style={{ color: 'var(--text-muted)' }}>{entry?.reason ?? '—'}</span>
                      </div>
                      <div style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: 500, color: 'var(--red)' }}>Why exited: </span>
                        <span style={{ color: 'var(--text-muted)' }}>{t.reason}</span>
                      </div>
                      <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                        Stop: {t.stopPrice?.toFixed(2)} · Target: {t.takeProfitPrice?.toFixed(2)} · {t.contracts} contract{t.contracts !== 1 ? 's' : ''} · {(win ? '+' : '')}{t.pnlPct.toFixed(2)}%
                      </div>
                      <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                        R achieved: <b style={{ color: win ? 'var(--green)' : 'var(--red)' }}>{t.rMultiple != null ? `${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple}R` : '—'}</b>
                        {t.plannedRR != null && <>&nbsp;/ planned {t.plannedRR}R</>}
                        &nbsp;·&nbsp;MFE {t.mfeR != null ? `${t.mfeR}R` : '—'} · MAE {t.maeR != null ? `${t.maeR}R` : '—'}
                        &nbsp;·&nbsp;Quality {t.qualityScore != null ? t.qualityScore : '—'}
                      </div>
                      <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                        Held {t.barsHeld ?? (t.barIndex - (t.entryBarIdx ?? 0))} bars
                        &nbsp;·&nbsp;Regime: {t.regime ?? 'unknown'}
                        &nbsp;·&nbsp;Session: {SESSION_LABELS[t.session] ?? t.session ?? '—'}
                        &nbsp;·&nbsp;Risk: ${t.riskDollars?.toFixed(0) ?? '—'}
                        {t.atr != null && <>&nbsp;·&nbsp;ATR {t.atr}</>}
                        {t.entryWinRate != null && <>&nbsp;·&nbsp;Learned WR {t.entryWinRate}%</>}
                      </div>
                      <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                        Entry: {new Date(entry?.time ?? 0).toLocaleString()}
                        &nbsp;→&nbsp;
                        Exit: {new Date(t.time).toLocaleString()}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn-sm" onClick={onBack}>← Edit strategy</button>
        <button className="btn-sm" onClick={onNew}>＋ New strategy</button>
      </div>
    </div>
  )
}

// ── Trade alert popup ────────────────────────────────────────
function TradeAlert({ trade, allTrades }) {
  if (trade.type === 'blocked') {
    return (
      <div className="trade-alert" style={{ marginBottom: 12, borderColor: 'var(--amber-border, rgba(240,160,32,0.3))' }}>
        <div className="trade-alert-title" style={{ color: 'var(--amber)' }}>🛡️ Trade skipped — learning filter</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{trade.reason}</div>
      </div>
    )
  }

  const isEntry = trade.type === 'entry'
  const win = !isEntry && trade.pnlPct >= 0
  const cls = isEntry ? 'entry' : win ? 'win' : 'loss'
  const entry = !isEntry
    ? allTrades.find(e => e.type === 'entry' && e.barIndex === trade.entryBarIdx)
    : null

  return (
    <div className={`trade-alert ${cls}`} style={{ marginBottom: 12 }}>
      <div className="trade-alert-title">
        {isEntry
          ? `▲ BUY @ ${trade.price.toFixed(2)}`
          : `▼ EXIT @ ${trade.price.toFixed(2)} — ${win ? '+' : ''}${trade.pnlPct?.toFixed(2)}%`
        }
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{trade.reason}</div>
      {!isEntry && entry && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
          Entered at {entry.price.toFixed(2)} · held {trade.barIndex - trade.entryBarIdx} bars
        </div>
      )}
    </div>
  )
}
