// Paper Broker — syncs trades and account with Supabase for cross-device access.
// Falls back to localStorage if offline.

import { sbGet, sbSet } from './supabase'

const LOCAL_TRADES  = 'tradingbot_paper_trades'
const LOCAL_ACCOUNT = 'tradingbot_paper_account'
const SB_TABLE      = 'paper_trades'
const SB_ACCOUNT    = 'paper_account'

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

// ── Local helpers ────────────────────────────────────────────────
function loadLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
function saveLocal(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)) } catch {}
}

// ── Account ──────────────────────────────────────────────────────
export function getAccount() {
  return loadLocal(LOCAL_ACCOUNT, { ...DEFAULT_ACCOUNT })
}

async function saveAccount(account) {
  saveLocal(LOCAL_ACCOUNT, account)
  try { await sbSet(SB_ACCOUNT, account, 'main') } catch {}
}

// ── Trades ───────────────────────────────────────────────────────
export function getTrades() {
  return loadLocal(LOCAL_TRADES, [])
}

async function saveTrades(trades) {
  saveLocal(LOCAL_TRADES, trades)
  try { await sbSet(SB_TABLE, trades, 'main') } catch {}
}

// ── Sync FROM Supabase (call on app load) ────────────────────────
export async function syncFromSupabase() {
  try {
    const [trades, account] = await Promise.all([
      sbGet(SB_TABLE,   'main'),
      sbGet(SB_ACCOUNT, 'main'),
    ])
    if (trades)  saveLocal(LOCAL_TRADES,  trades)
    if (account) saveLocal(LOCAL_ACCOUNT, account)
    return true
  } catch {
    return false
  }
}

// ── Open position ────────────────────────────────────────────────
export function getOpenPosition() {
  return getTrades().find(t => !t.exitTime) || null
}

// ── Open a trade ─────────────────────────────────────────────────
export async function openTrade({ symbol = 'MNQ', side, entryPrice, quantity = 1, stopLoss, takeProfit, signal, factors, regime }) {
  if (getOpenPosition()) return { error: 'Position already open — close it first' }

  const spec  = CONTRACT_SPECS[symbol] || CONTRACT_SPECS.MNQ
  const trade = {
    id:          Date.now(),
    symbol,
    side,
    entryPrice,
    quantity,
    stopLoss:    stopLoss    || null,
    takeProfit:  takeProfit  || null,
    signal:      signal      || null,
    factors:     factors     || {},
    regime:      regime      || 'unknown',
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
  await saveTrades(trades)
  return { ok: true, trade }
}

// ── Close the open trade ─────────────────────────────────────────
export async function closeTrade({ exitPrice, exitReason = 'manual' }) {
  const trades = getTrades()
  const idx    = trades.findIndex(t => !t.exitTime)
  if (idx === -1) return { error: 'No open position to close' }

  const trade      = trades[idx]
  const pnlPoints  = trade.side === 'LONG'
    ? exitPrice - trade.entryPrice
    : trade.entryPrice - exitPrice
  const pnlDollars = pnlPoints * trade.multiplier * trade.quantity

  trades[idx] = { ...trade, exitTime: Date.now(), exitPrice, exitReason, pnlPoints, pnlDollars }
  await saveTrades(trades)

  const account = getAccount()
  account.balance     += pnlDollars
  account.realizedPnl += pnlDollars
  account.totalTrades++
  if (pnlDollars > 0) account.wins++
  else account.losses++
  await saveAccount(account)

  return { ok: true, trade: trades[idx], pnlDollars }
}

// ── Unrealized P&L ───────────────────────────────────────────────
export function getUnrealizedPnl(currentPrice) {
  const pos = getOpenPosition()
  if (!pos || !currentPrice) return 0
  const diff = pos.side === 'LONG'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice
  return diff * pos.multiplier * pos.quantity
}

// ── Check SL/TP ──────────────────────────────────────────────────
export function checkAutoExit(currentPrice) {
  const pos = getOpenPosition()
  if (!pos) return null
  if (pos.stopLoss) {
    const hit = pos.side === 'LONG' ? currentPrice <= pos.stopLoss : currentPrice >= pos.stopLoss
    if (hit) return 'stopLoss'
  }
  if (pos.takeProfit) {
    const hit = pos.side === 'LONG' ? currentPrice >= pos.takeProfit : currentPrice <= pos.takeProfit
    if (hit) return 'takeProfit'
  }
  return null
}

// ── Stats ────────────────────────────────────────────────────────
export function getStats() {
  const account = getAccount()
  const trades  = getTrades().filter(t => t.exitTime)
  const winRate = account.totalTrades > 0
    ? ((account.wins / account.totalTrades) * 100).toFixed(1) : '0.0'
  const avgWin  = trades.filter(t => t.pnlDollars > 0).length > 0
    ? (trades.filter(t => t.pnlDollars > 0).reduce((s, t) => s + t.pnlDollars, 0) /
       trades.filter(t => t.pnlDollars > 0).length).toFixed(0) : '0'
  const avgLoss = trades.filter(t => t.pnlDollars < 0).length > 0
    ? (trades.filter(t => t.pnlDollars < 0).reduce((s, t) => s + t.pnlDollars, 0) /
       trades.filter(t => t.pnlDollars < 0).length).toFixed(0) : '0'
  return { ...account, winRate, avgWin, avgLoss }
}

// ── Reset ────────────────────────────────────────────────────────
export async function resetPaperAccount() {
  saveLocal(LOCAL_TRADES,  [])
  saveLocal(LOCAL_ACCOUNT, { ...DEFAULT_ACCOUNT })
  try {
    await Promise.all([
      sbSet(SB_TABLE,   [],                  'main'),
      sbSet(SB_ACCOUNT, { ...DEFAULT_ACCOUNT }, 'main'),
    ])
  } catch {}
}
