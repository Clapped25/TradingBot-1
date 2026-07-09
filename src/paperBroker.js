// ─────────────────────────────────────────────────────────────────────────────
// Paper Broker — built-in simulated trading engine
//
// Zero external connections. All trades stored in localStorage so they survive
// page refreshes. Think of this as your own mini exchange.
//
// Contract specs (multiplier = $ per point per contract):
//   MNQ  $2/pt   MES  $5/pt   NQ  $20/pt   ES  $50/pt
// ─────────────────────────────────────────────────────────────────────────────

const TRADES_KEY  = 'tradingbot_paper_trades'
const ACCOUNT_KEY = 'tradingbot_paper_account'

export const CONTRACT_SPECS = {
  MNQ: { multiplier: 2,  tickSize: 0.25, tickValue: 0.50,  name: 'Micro Nasdaq-100' },
  MES: { multiplier: 5,  tickSize: 0.25, tickValue: 1.25,  name: 'Micro S&P 500' },
  NQ:  { multiplier: 20, tickSize: 0.25, tickValue: 5.00,  name: 'E-mini Nasdaq-100' },
  ES:  { multiplier: 50, tickSize: 0.25, tickValue: 12.50, name: 'E-mini S&P 500' },
}

const DEFAULT_ACCOUNT = {
  startingBalance: 25000,
  balance:         25000,
  realizedPnl:     0,
  totalTrades:     0,
  wins:            0,
  losses:          0,
}

// ── Account ──────────────────────────────────────────────────────────────────

export function getAccount() {
  try {
    const s = localStorage.getItem(ACCOUNT_KEY)
    return s ? JSON.parse(s) : { ...DEFAULT_ACCOUNT }
  } catch {
    return { ...DEFAULT_ACCOUNT }
  }
}

function saveAccount(account) {
  try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)) } catch {}
}

// ── Trades ───────────────────────────────────────────────────────────────────

export function getTrades() {
  try {
    const s = localStorage.getItem(TRADES_KEY)
    return s ? JSON.parse(s) : []
  } catch {
    return []
  }
}

function saveTrades(trades) {
  try { localStorage.setItem(TRADES_KEY, JSON.stringify(trades)) } catch {}
}

// ── Open position (at most one at a time) ────────────────────────────────────

export function getOpenPosition() {
  return getTrades().find(t => !t.exitTime) || null
}

// ── Open a new trade ─────────────────────────────────────────────────────────

export function openTrade({ symbol = 'MNQ', side, entryPrice, quantity = 1, stopLoss, takeProfit, signal }) {
  const existing = getOpenPosition()
  if (existing) return { error: 'Position already open — close it first' }

  const spec  = CONTRACT_SPECS[symbol] || CONTRACT_SPECS.MNQ
  const trade = {
    id:          Date.now(),
    symbol,
    side,          // 'LONG' | 'SHORT'
    entryPrice,
    quantity,
    stopLoss:    stopLoss  || null,
    takeProfit:  takeProfit || null,
    signal:      signal    || null,  // what signal triggered this
    entryTime:   Date.now(),
    exitTime:    null,
    exitPrice:   null,
    exitReason:  null,
    pnlPoints:   null,
    pnlDollars:  null,
    multiplier:  spec.multiplier,
  }

  const trades = getTrades()
  trades.push(trade)
  saveTrades(trades)
  return { ok: true, trade }
}

// ── Close the open trade ─────────────────────────────────────────────────────

export function closeTrade({ exitPrice, exitReason = 'manual' }) {
  const trades = getTrades()
  const idx    = trades.findIndex(t => !t.exitTime)
  if (idx === -1) return { error: 'No open position to close' }

  const trade      = trades[idx]
  const pnlPoints  = trade.side === 'LONG'
    ? exitPrice - trade.entryPrice
    : trade.entryPrice - exitPrice
  const pnlDollars = pnlPoints * trade.multiplier * trade.quantity

  trades[idx] = {
    ...trade,
    exitTime:   Date.now(),
    exitPrice,
    exitReason,
    pnlPoints,
    pnlDollars,
  }
  saveTrades(trades)

  // Update account
  const account = getAccount()
  account.balance     += pnlDollars
  account.realizedPnl += pnlDollars
  account.totalTrades++
  if (pnlDollars > 0) account.wins++
  else account.losses++
  saveAccount(account)

  return { ok: true, trade: trades[idx], pnlDollars }
}

// ── Unrealized P&L for the open position at a given price ────────────────────

export function getUnrealizedPnl(currentPrice) {
  const pos = getOpenPosition()
  if (!pos || !currentPrice) return 0
  const diff = pos.side === 'LONG'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice
  return diff * pos.multiplier * pos.quantity
}

// ── Check if current price has hit stop loss or take profit ──────────────────
// Call this on every price update. Returns 'stopLoss' | 'takeProfit' | null.

export function checkAutoExit(currentPrice) {
  const pos = getOpenPosition()
  if (!pos) return null

  if (pos.stopLoss) {
    const hitStop = pos.side === 'LONG'
      ? currentPrice <= pos.stopLoss
      : currentPrice >= pos.stopLoss
    if (hitStop) return 'stopLoss'
  }

  if (pos.takeProfit) {
    const hitTp = pos.side === 'LONG'
      ? currentPrice >= pos.takeProfit
      : currentPrice <= pos.takeProfit
    if (hitTp) return 'takeProfit'
  }

  return null
}

// ── Account statistics ────────────────────────────────────────────────────────

export function getStats() {
  const account = getAccount()
  const trades  = getTrades().filter(t => t.exitTime)
  const winRate = account.totalTrades > 0
    ? ((account.wins / account.totalTrades) * 100).toFixed(1)
    : '0.0'
  const avgWin  = trades.filter(t => t.pnlDollars > 0).length > 0
    ? (trades.filter(t => t.pnlDollars > 0).reduce((s, t) => s + t.pnlDollars, 0) /
       trades.filter(t => t.pnlDollars > 0).length).toFixed(0)
    : '0'
  const avgLoss = trades.filter(t => t.pnlDollars < 0).length > 0
    ? (trades.filter(t => t.pnlDollars < 0).reduce((s, t) => s + t.pnlDollars, 0) /
       trades.filter(t => t.pnlDollars < 0).length).toFixed(0)
    : '0'

  return { ...account, winRate, avgWin, avgLoss }
}

// ── Reset everything ─────────────────────────────────────────────────────────

export function resetPaperAccount() {
  try {
    localStorage.removeItem(TRADES_KEY)
    localStorage.removeItem(ACCOUNT_KEY)
  } catch {}
}
