import { useState, useEffect } from 'react'
import StrategyInput from './components/StrategyInput'
import StrategyReview from './components/StrategyReview'
import BacktestResults from './components/BacktestResults'
import LearningDashboard from './components/LearningDashboard'
import LiveMode from './components/LiveMode'
import { updateStrategy, listStrategiesAsync } from './strategyStorage'
import { syncFromSupabase } from './paperBroker'
import { syncMemoryFromSupabase } from './tradeMemory'

const SCREENS = ['input', 'review', 'results']
const STEP_LABELS = ['Strategy Input', 'Review Rules', 'Backtest & Replay']

export default function App() {
  const [screen, setScreen] = useState('input')
  const [prevScreen, setPrevScreen] = useState('input')
  const [strategy, setStrategy] = useState(null)
  const [strategyId, setStrategyId] = useState(null)
  const [backtestData, setBacktestData] = useState(null)
  const [synced, setSynced] = useState(false)

  // Sync all data from Supabase on load
  useEffect(() => {
    Promise.all([
      syncFromSupabase(),
      syncMemoryFromSupabase(),
    ]).finally(() => setSynced(true))
  }, [])

  const screenIdx = SCREENS.indexOf(screen)
  const isDashboard = screen === 'dashboard'
  const isLive      = screen === 'live'

  function handleStrategyExtracted(s, id) {
    setStrategy(s); setStrategyId(id); setScreen('review')
  }

  function handleGoLive(s, id) {
    setStrategy(s); setStrategyId(id); setScreen('live')
  }

  function handleStrategyChange(updated) {
    setStrategy(updated)
    if (strategyId) updateStrategy(strategyId, updated)
  }

  function handleBacktestComplete(data) {
    setBacktestData(data); setScreen('results')
  }

  function handleNew() {
    setStrategy(null); setStrategyId(null); setBacktestData(null); setScreen('input')
  }

  function openDashboard() {
    setPrevScreen(screen); setScreen('dashboard')
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            <span className="logo-text">Trading<span>Bot</span></span>
          </div>

          {!isDashboard && !isLive && (
            <div className="steps">
              {STEP_LABELS.map((label, i) => (
                <div key={label} className={`step ${screenIdx >= i ? 'step-active' : ''}`}>
                  <span className="step-num">{i + 1}</span>
                  <span className="step-label">{label}</span>
                </div>
              ))}
            </div>
          )}

          {isLive && (
            <span style={{
              fontSize: 11, fontWeight: 700, color: 'var(--green)',
              background: 'rgba(16,185,129,0.1)', padding: '3px 10px',
              borderRadius: 20, border: '1px solid rgba(16,185,129,0.3)',
            }}>
              ● PAPER TRADING
            </span>
          )}

          {!isLive && (
            <button
              className="btn-sm"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              onClick={isDashboard ? () => setScreen(prevScreen) : openDashboard}
            >
              {isDashboard ? '← Back' : '📊 Learning'}
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        {screen === 'dashboard' && (
          <LearningDashboard onBack={() => setScreen(prevScreen)} />
        )}

        {screen === 'input' && (
          <StrategyInput
            onStrategyExtracted={handleStrategyExtracted}
            onGoLive={handleGoLive}
          />
        )}

        {screen === 'review' && strategy && (
          <StrategyReview
            strategy={strategy}
            onStrategyChange={handleStrategyChange}
            onBack={() => setScreen('input')}
            onBacktestComplete={handleBacktestComplete}
          />
        )}

        {screen === 'results' && backtestData && (
          <BacktestResults
            {...backtestData}
            strategy={strategy}
            strategyId={strategyId}
            onStrategyChange={handleStrategyChange}
            onBack={() => setScreen('review')}
            onNew={handleNew}
          />
        )}

        {screen === 'live' && strategy && (
          <LiveMode
            strategy={strategy}
            onBack={() => setScreen('input')}
            onBacktest={() => setScreen(backtestData ? 'results' : 'review')}
          />
        )}
      </main>
    </div>
  )
}
