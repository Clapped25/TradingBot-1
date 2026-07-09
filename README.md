# Trading Bot

A web app that lets you paste a YouTube trading strategy video, extracts the rules with Claude AI, and backtests them on live Binance Futures data — with a bar-by-bar replay showing every trade and why it was taken.

## Features

- **Strategy input** — paste a YouTube URL or describe a strategy in text
- **AI extraction** — Claude reads the video transcript and builds a signal function
- **Review & edit** — see the entry/exit rules and edit the JS signal function directly
- **Backtest** — runs against 300 bars of real Binance Futures OHLCV data
- **Replay** — watch the bot take trades bar by bar with speed control (0.5× to 64×)
- **Trade log** — every trade shows exactly why it entered and why it exited

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Add your Anthropic API key

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Then open `.env` and add your key:

```
VITE_ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Get a free key at: https://console.anthropic.com/

Market data (ES/NQ futures) comes from Yahoo Finance — free, no API key, no signup. It's delayed ~15-20 minutes, which is fine for backtesting but not for live trading.

### 3. Run the app

```bash
npm run dev
```

Open http://localhost:5173 in your browser.

## How it works

1. **Paste a YouTube URL** — the app tries to pull the video's captions automatically
2. **Claude analyzes the strategy** — extracts indicators, entry/exit rules, and generates a JavaScript signal function
3. **Configure the backtest** — pick a Binance Futures symbol (BTC, ETH, SOL, etc.) and timeframe
4. **Watch the replay** — press Play to step through candles bar by bar, watching trades appear on the chart with green ▲ entry and red ▼ exit markers

## File structure

```
src/
├── App.jsx              # Screen routing (input → review → results)
├── claude.js            # Claude API + Binance data fetching
├── indicators.js        # EMA, SMA, RSI calculations
├── backtest.js          # Backtest engine + stats
├── index.css            # Dark trading terminal theme
└── components/
    ├── StrategyInput.jsx     # Screen 1: URL + description
    ├── StrategyReview.jsx    # Screen 2: rules + signal function editor
    ├── BacktestResults.jsx   # Screen 3: chart, replay, trade log
    └── CandlestickChart.jsx  # TradingView lightweight-charts wrapper
```

## Coming soon

- [ ] Live WebSocket feed (Binance real-time streaming)
- [ ] Short selling support
- [ ] Stop loss / take profit levels
- [ ] Multiple timeframe analysis
- [ ] Strategy export / save
