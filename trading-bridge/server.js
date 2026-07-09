'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// TradingBot ↔ IBKR TWS Bridge
//
// Run this alongside the React app:
//   cd trading-bridge && npm install && node server.js
//
// Requires TWS to be running locally with:
//   - Paper trading account logged in
//   - API enabled (Edit → Global Configuration → API → Settings)
//   - Port set to 7497
//   - "Allow connections from localhost" checked
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express')
const cors    = require('cors')
const http    = require('http')
const { WebSocketServer } = require('ws')

// Load IBKR API
let IBApi, EventName
try {
  const mod = require('@stoqey/ib')
  IBApi     = mod.IBApi
  EventName = mod.EventName
  if (!IBApi) throw new Error('IBApi not found in @stoqey/ib exports')
} catch (e) {
  console.error('❌ Could not load @stoqey/ib:', e.message)
  console.error('   Run: cd trading-bridge && npm install')
  process.exit(1)
}

// ── Config ────────────────────────────────────────────────────────────────────
const TWS_PORT    = 7497          // paper trading port (live = 7496)
const TWS_HOST    = '127.0.0.1'
const BRIDGE_PORT = 3001          // what the React app connects to
const CLIENT_ID   = 1

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  connected:   false,
  nextOrderId: null,
  positions:   {},              // localSymbol → { symbol, quantity, avgCost }
  marketData:  {},              // reqId → { last, bid, ask }
  orders:      {},              // orderId → status
  pnl:         {},              // reqId → pnl
  error:       null,
  tradeLog:    [],              // filled orders history
}

let mktDataReqId = 100          // counter for market data request IDs

// ── HTTP + WebSocket servers ──────────────────────────────────────────────────
const app    = express()
const server = http.createServer(app)
const wss    = new WebSocketServer({ server })

app.use(cors())
app.use(express.json())

function broadcast(data) {
  const msg = JSON.stringify(data)
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg) })
}

// ── IBKR connection ───────────────────────────────────────────────────────────
const ib = new IBApi({ clientId: CLIENT_ID, host: TWS_HOST, port: TWS_PORT })

ib.on(EventName.connected, () => {
  state.connected = true
  state.error     = null
  console.log('✓ Connected to TWS on port', TWS_PORT)
  ib.reqIds(-1)
  ib.reqPositions()
  broadcast({ type: 'status', connected: true })
})

ib.on(EventName.disconnected, () => {
  state.connected = false
  console.log('✗ Disconnected from TWS — is TWS running?')
  broadcast({ type: 'status', connected: false })
  // Auto-reconnect after 5 seconds
  setTimeout(() => {
    if (!state.connected) {
      console.log('Attempting reconnect...')
      try { ib.connect() } catch (e) {}
    }
  }, 5000)
})

ib.on(EventName.error, (err, code, reqId) => {
  // Suppress harmless market data farm warnings
  if ([2104, 2106, 2107, 2108, 2158, 10167].includes(code)) return
  const msg = err?.message || String(err)
  console.warn(`IB [${code}] req=${reqId}: ${msg}`)
  state.error = msg
  broadcast({ type: 'error', code, message: msg, reqId })
})

ib.on(EventName.nextValidId, (orderId) => {
  state.nextOrderId = orderId
  console.log('Next order ID:', orderId)
  broadcast({ type: 'nextOrderId', orderId })
})

ib.on(EventName.position, (account, contract, pos, avgCost) => {
  const key = contract.localSymbol || contract.symbol
  if (pos === 0) {
    delete state.positions[key]
  } else {
    state.positions[key] = {
      symbol:   key,
      secType:  contract.secType,
      quantity: pos,
      avgCost:  avgCost || 0,
    }
  }
  broadcast({ type: 'positions', positions: state.positions })
})

ib.on(EventName.positionEnd, () => {
  broadcast({ type: 'positions', positions: state.positions })
})

ib.on(EventName.tickPrice, (reqId, tickType, price) => {
  if (!state.marketData[reqId]) state.marketData[reqId] = {}
  if (tickType === 1) state.marketData[reqId].bid  = price  // bid
  if (tickType === 2) state.marketData[reqId].ask  = price  // ask
  if (tickType === 4) state.marketData[reqId].last = price  // last
  if (tickType === 9) state.marketData[reqId].close = price // close
  broadcast({ type: 'tick', reqId, tickType, price, data: state.marketData[reqId] })
})

ib.on(EventName.tickSize, (reqId, tickType, size) => {
  if (!state.marketData[reqId]) state.marketData[reqId] = {}
  if (tickType === 5) state.marketData[reqId].lastSize = size
  if (tickType === 0) state.marketData[reqId].bidSize  = size
  if (tickType === 3) state.marketData[reqId].askSize  = size
  broadcast({ type: 'tickSize', reqId, tickType, size })
})

ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
  state.orders[orderId] = { orderId, status, filled, remaining, avgFillPrice }
  if (status === 'Filled') {
    const entry = { ...state.orders[orderId], filledAt: Date.now() }
    state.tradeLog.unshift(entry)
    if (state.tradeLog.length > 100) state.tradeLog.pop()
    // Refresh positions after fill
    ib.reqPositions()
  }
  broadcast({ type: 'orderStatus', orderId, status, filled, remaining, avgFillPrice })
})

ib.on(EventName.openOrder, (orderId, contract, order, orderState) => {
  broadcast({ type: 'openOrder', orderId, symbol: contract.localSymbol || contract.symbol, 
    action: order.action, qty: order.totalQuantity, status: orderState.status })
})

ib.on(EventName.pnlSingle, (reqId, pos, dailyPnl, unrealizedPnl, realizedPnl, value) => {
  state.pnl[reqId] = { pos, dailyPnl, unrealizedPnl, realizedPnl, value }
  broadcast({ type: 'pnl', reqId, pos, dailyPnl, unrealizedPnl, realizedPnl, value })
})

ib.on(EventName.execDetails, (reqId, contract, execution) => {
  broadcast({ type: 'execution', 
    symbol: contract.localSymbol || contract.symbol,
    action: execution.side,
    qty:    execution.shares,
    price:  execution.price,
    time:   execution.time
  })
})

// ── Contract helpers ──────────────────────────────────────────────────────────
const QUARTERLY = [
  { month: 3, code: 'H' }, { month: 6,  code: 'M' },
  { month: 9, code: 'U' }, { month: 12, code: 'Z' },
]

function getFrontMonth() {
  const now = new Date()
  const y   = now.getFullYear()
  const m   = now.getMonth() + 1
  const exp = QUARTERLY.find(e => e.month >= m) || QUARTERLY[0]
  const yr  = exp.month >= m ? y : y + 1
  return String(yr) + String(exp.month).padStart(2, '0')
}

function makeContract(symbol, contractMonth) {
  const cm = contractMonth || getFrontMonth()
  return {
    symbol,
    secType:                        'FUT',
    exchange:                       'CME',
    currency:                       'USD',
    lastTradeDateOrContractMonth:   cm,
    multiplier:                     symbol === 'MNQ' ? '2' : '5',
  }
}

// ── REST Routes ───────────────────────────────────────────────────────────────

// Status — what the React app polls on load
app.get('/api/status', (req, res) => {
  res.json({
    connected:   state.connected,
    nextOrderId: state.nextOrderId,
    positions:   state.positions,
    error:       state.error,
    frontMonth:  getFrontMonth(),
  })
})

// Refresh positions
app.get('/api/positions', (req, res) => {
  if (state.connected) ib.reqPositions()
  res.json(state.positions)
})

// Trade log
app.get('/api/trades', (req, res) => {
  res.json(state.tradeLog)
})

// Subscribe to live market data for a symbol
app.post('/api/subscribe', (req, res) => {
  const { symbol, contractMonth } = req.body
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  const reqId    = mktDataReqId++
  const contract = makeContract(symbol, contractMonth)

  try {
    ib.reqMktData(reqId, contract, '', false, false)
    res.json({ ok: true, reqId, contract, frontMonth: getFrontMonth() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/subscribe/:reqId', (req, res) => {
  try {
    ib.cancelMktData(parseInt(req.params.reqId))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Place an order
app.post('/api/order', (req, res) => {
  if (!state.connected)   return res.status(503).json({ error: 'Not connected to TWS' })
  if (!state.nextOrderId) return res.status(503).json({ error: 'Waiting for order ID from TWS' })

  const { symbol, action, quantity = 1, contractMonth, orderType = 'MKT', limitPrice } = req.body

  if (!symbol || !action)                   return res.status(400).json({ error: 'symbol and action required' })
  if (!['BUY','SELL'].includes(action.toUpperCase())) return res.status(400).json({ error: 'action must be BUY or SELL' })

  const contract = makeContract(symbol, contractMonth)
  const orderId  = state.nextOrderId++

  const order = {
    orderId,
    action:        action.toUpperCase(),
    totalQuantity: quantity,
    orderType:     orderType.toUpperCase(),
    tif:           'DAY',
  }
  if (orderType === 'LMT' && limitPrice) order.lmtPrice = limitPrice

  try {
    ib.placeOrder(orderId, contract, order)
    console.log(`📤 Order ${orderId}: ${action.toUpperCase()} ${quantity} ${symbol}`)
    res.json({ ok: true, orderId, contract, order })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Close position for a symbol
app.post('/api/close', (req, res) => {
  if (!state.connected) return res.status(503).json({ error: 'Not connected to TWS' })

  const { symbol } = req.body
  const pos = Object.values(state.positions).find(p =>
    p.symbol.startsWith(symbol || 'MNQ') && p.quantity !== 0
  )

  if (!pos) return res.status(404).json({ error: 'No open position found' })

  const action   = pos.quantity > 0 ? 'SELL' : 'BUY'
  const quantity = Math.abs(pos.quantity)
  const contract = makeContract(symbol || 'MNQ')
  const orderId  = state.nextOrderId++

  try {
    ib.placeOrder(orderId, contract, {
      orderId,
      action,
      totalQuantity: quantity,
      orderType:     'MKT',
      tif:           'DAY',
    })
    console.log(`📤 Close ${orderId}: ${action} ${quantity} ${pos.symbol}`)
    res.json({ ok: true, orderId, action, quantity })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Cancel an open order
app.delete('/api/order/:orderId', (req, res) => {
  try {
    ib.cancelOrder(parseInt(req.params.orderId))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('React app connected via WebSocket')
  ws.send(JSON.stringify({
    type:        'init',
    connected:   state.connected,
    positions:   state.positions,
    nextOrderId: state.nextOrderId,
    frontMonth:  getFrontMonth(),
  }))
})

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(BRIDGE_PORT, () => {
  console.log(`\n🌉 Trading Bridge running on http://localhost:${BRIDGE_PORT}`)
  console.log(`   Connecting to TWS at ${TWS_HOST}:${TWS_PORT}...`)
  console.log(`   Make sure TWS is open and paper trading is active\n`)
  try { ib.connect() } catch (e) {
    console.error('Initial connect failed:', e.message)
  }
})

process.on('SIGINT', () => {
  console.log('\nShutting down bridge...')
  if (state.connected) try { ib.disconnect() } catch {}
  process.exit(0)
})
