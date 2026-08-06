// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Risk Engine
//
// Combines two inputs to size every trade differently:
//
// 1. WIN PROBABILITY from learning memory
//    — How often has this exact signal combo won historically?
//    — Higher win rate = bigger size, tighter target acceptable
//    — Lower win rate = smaller size, need wider target to be worth it
//
// 2. ATR-BASED STOPS (Average True Range)
//    — How much is the market actually moving right now?
//    — Volatile market = wider stop, same dollar risk = fewer contracts
//    — Quiet market = tighter stop, same dollar risk = more contracts
//
// Output for each trade:
//   stopDistance  — how many points away to place stop loss
//   stopPrice     — exact stop loss price
//   targetPrice   — exact take profit price
//   riskDollars   — dollar amount being risked
//   contracts     — how many contracts to trade
//   rrRatio       — reward to risk ratio for this trade
//   confidence    — 0-1 score from learning memory
//   reasoning     — human readable explanation
// ─────────────────────────────────────────────────────────────────────────────

import { calcATR } from './indicators'

// Contract specs
const CONTRACT_SPECS = {
  MNQ: { multiplier: 2,  tickSize: 0.25 },
  MES: { multiplier: 5,  tickSize: 0.25 },
  NQ:  { multiplier: 20, tickSize: 0.25 },
  ES:  { multiplier: 50, tickSize: 0.25 },
}

/**
 * Calculate dynamic risk parameters for a trade
 *
 * @param {object} params
 * @param {Array}   params.candles      - recent price bars
 * @param {string}  params.side         - 'LONG' or 'SHORT'
 * @param {number}  params.entryPrice   - current price
 * @param {string}  params.symbol       - 'MNQ', 'MES', etc
 * @param {number}  params.accountSize  - total account balance
 * @param {object}  params.decision     - from shouldTakeTrade()
 * @param {number}  params.baseRiskPct  - base % of account to risk (default 1%)
 */
export function calcDynamicRisk({
  candles,
  side,
  entryPrice,
  symbol     = 'MNQ',
  accountSize = 25000,
  decision   = {},
  baseRiskPct = 1,
}) {
  const spec = CONTRACT_SPECS[symbol] || CONTRACT_SPECS.MNQ

  // ── Step 1: ATR-based stop distance ───────────────────────────
  const atrSeries  = calcATR(candles, 14)
  const currentATR = atrSeries[atrSeries.length - 1] || 50  // fallback 50pts

  // Stop = 1.5x ATR away from entry — gives trade room to breathe
  // Volatile market (high ATR) = wider stop naturally
  // Quiet market (low ATR) = tighter stop naturally
  const atrMultiplier = 1.5
  const stopDistance  = +(currentATR * atrMultiplier).toFixed(2)

  const stopPrice = side === 'LONG'
    ? +(entryPrice - stopDistance).toFixed(2)
    : +(entryPrice + stopDistance).toFixed(2)

  // ── Step 2: Win probability adjusts RR target ─────────────────
  const winRate    = decision.winRate    ?? 50   // % (0-100)
  const expectancy = decision.expectancyR ?? 0
  const confidence = decision.confidence  ?? 0
  const sampleSize = decision.sampleSize  ?? 0

  // Math: For a given win rate, minimum RR needed to be profitable:
  //   minRR = (1 - winRate) / winRate
  //   e.g. 40% win rate needs at least 1.5R to break even
  //        60% win rate only needs 0.67R to break even
  const winRateFraction = winRate / 100
  const minRR = winRateFraction > 0
    ? +((1 - winRateFraction) / winRateFraction).toFixed(2)
    : 2

  // Target RR = minimum needed + edge premium based on confidence
  // More confident = aim higher since edge is proven
  const edgePremium = confidence * 1.5  // up to +1.5R extra when fully confident
  const rrRatio     = +Math.max(1.5, minRR + edgePremium).toFixed(2)

  const targetDistance = +(stopDistance * rrRatio).toFixed(2)
  const targetPrice    = side === 'LONG'
    ? +(entryPrice + targetDistance).toFixed(2)
    : +(entryPrice - targetDistance).toFixed(2)

  // ── Step 3: Position sizing from win probability ───────────────
  // Base risk adjusts with learning memory confidence
  // No data → risk base %
  // Proven edge → risk up to 1.5x base
  // Weak edge → risk down to 0.5x base
  const riskPct     = baseRiskPct
  const riskDollars = +(accountSize * (riskPct / 100)).toFixed(2)

// Contracts = risk dollars / (stop distance × multiplier)
  // Then scaled by win probability and proven edge
  const dollarPerPoint  = spec.multiplier
  const rawContracts    = riskDollars / (stopDistance * dollarPerPoint)
  const winFrac         = Math.max(0.3, Math.min(0.9, winRate / 100))
  const probMultiplier  = Math.max(0.5, Math.min(2.0, winFrac * 2.5))
  const edgeMultiplier  = Math.max(0.5, Math.min(2.0, 1 + expectancy * 0.5))
  const finalMultiplier = probMultiplier * edgeMultiplier
  const contracts       = sampleSize < 8
    ? 1
    : Math.min(6, Math.max(1, Math.round(rawContracts * finalMultiplier)))

  // Actual risk after rounding to whole contracts
  const actualRiskDollars  = +(contracts * stopDistance * dollarPerPoint).toFixed(2)
  const actualRiskPct      = +((actualRiskDollars / accountSize) * 100).toFixed(2)
  const potentialProfitDollars = +(contracts * targetDistance * dollarPerPoint).toFixed(2)

  // ── Step 4: Human readable reasoning ──────────────────────────
  const reasons = []
  if (sampleSize >= 8) {
    reasons.push(`${winRate}% win rate over ${sampleSize} backtests`)
    reasons.push(`${expectancy > 0 ? '+' : ''}${expectancy}R expectancy`)
  } else {
    reasons.push(`No backtest data yet — using base ${baseRiskPct}% risk`)
  }
  reasons.push(`ATR ${currentATR.toFixed(1)}pts → ${stopDistance}pt stop`)
  reasons.push(`${rrRatio}R target`)

  return {
    // Stop & target
    stopDistance,
    stopPrice,
    targetPrice,
    rrRatio,

    // Position size
    contracts,
    riskDollars: actualRiskDollars,
    riskPct:     actualRiskPct,
    potentialProfitDollars,

    // Context
    currentATR:     +currentATR.toFixed(2),
    winRate,
    expectancy,
    confidence,
    sampleSize,

    // Summary
    reasoning: reasons.join(' · '),
  }
}
