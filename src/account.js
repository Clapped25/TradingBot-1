// Account simulation engine — position sizing, contract point values,
// and open/realized PnL tracking for ES/NQ futures.

// Point values per contract. Micro contracts (MES/MNQ) are used by
// default — they fit a $25k retail account far better than full-size
// minis, where a single ES point move ($50) can blow past a 1% risk
// budget on a single tight structural stop.
export const CONTRACT_SPECS = {
  ES: {
    full:  { label: 'ES (E-mini)',  pointValue: 50, tickSize: 0.25 },
    micro: { label: 'MES (Micro)',  pointValue: 5,  tickSize: 0.25 },
  },
  NQ: {
    full:  { label: 'NQ (E-mini)',  pointValue: 20, tickSize: 0.25 },
    micro: { label: 'MNQ (Micro)',  pointValue: 2,  tickSize: 0.25 },
  },
}

export function getContractSpec(symbolKey, useMicro = true) {
  const spec = CONTRACT_SPECS[symbolKey] || CONTRACT_SPECS.ES
  return useMicro ? spec.micro : spec.full
}

// ── Position sizing ──────────────────────────────────────────────
// Caps risk at riskPct of the current account balance. If the
// structural stop is too wide to fit even 1 micro contract within
// that risk budget, the trade is skipped entirely (contracts: 0) —
// this is real risk management, not just a display number.
export function calculatePositionSize({ accountBalance, riskPct, stopDistance, symbolKey, useMicro = true }) {
  const spec = getContractSpec(symbolKey, useMicro)
  const riskDollars = accountBalance * (riskPct / 100)
  const riskPerContract = Math.abs(stopDistance) * spec.pointValue
  if (riskPerContract <= 0) return { contracts: 0, riskDollars, riskPerContract: 0, spec }
  const contracts = Math.floor(riskDollars / riskPerContract)
  return { contracts, riskDollars, riskPerContract, spec }
}

// ── Find the open position (if any) at a given bar index ────────
// Used to compute live "open PnL" while replaying — looks for an
// entry that hasn't been matched with an exit yet by this point.
export function getOpenPositionAt(trades, atBarIndex) {
  let openEntry = null
  for (const t of trades) {
    if (t.barIndex > atBarIndex) break
    if (t.type === 'entry') openEntry = t
    if (t.type === 'exit') openEntry = null
  }
  return openEntry
}

// ── Compute unrealized PnL for an open position at the current price ──
export function calcOpenPnl(openEntry, currentPrice, symbolKey, useMicro = true) {
  if (!openEntry) return 0
  const spec = getContractSpec(symbolKey, useMicro)
  return (currentPrice - openEntry.price) * spec.pointValue * openEntry.contracts
}

// ── Realized PnL up to a given bar index (sum of closed trades) ──
export function calcRealizedPnl(trades, uptoBarIndex = Infinity) {
  return trades
    .filter(t => t.type === 'exit' && t.barIndex <= uptoBarIndex)
    .reduce((sum, t) => sum + (t.dollarPnl || 0), 0)
}
