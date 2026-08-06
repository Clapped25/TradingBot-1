// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Risk Engine
//
// Combines three inputs to size every trade:
// 1. Signal quality score — stronger setup = more risk allowed
// 2. Fixed dollar risk — never risk more than $400 base per trade
// 3. ATR-based stops — volatile market = fewer contracts automatically
// ─────────────────────────────────────────────────────────────────────────────

import { calcATR } from './indicators'

const CONTRACT_SPECS = {
  MNQ: { multiplier: 2,  tickSize: 0.25 },
  MES: { multiplier: 5,  tickSize: 0.25 },
  NQ:  { multiplier: 20, tickSize: 0.25 },
  ES:  { multiplier: 50, tickSize: 0.25 },
}

export function calcDynamicRisk({
  candles,
  side,
  entryPrice,
  symbol      = 'MNQ',
  accountSize = 25000,
  decision    = {},
  baseRiskPct = 1,
  signalScore = 4,
}) {
  const spec = CONTRACT_SPECS[symbol] || CONTRACT_SPECS.MNQ

  // ATR for stop and volatility scaling
  const atrSeries  = calcATR(candles, 14)
  const currentATR = atrSeries[atrSeries.length - 1] || 50

  // From learning memory
  const winRate    = decision.winRate    ?? 50
  const expectancy = decision.expectancyR ?? 0
  const confidence = decision.confidence  ?? 0
  const sampleSize = decision.sampleSize  ?? 0

  // ── Step 1: Quality score adjusts base risk ───────────────────
  const BASE_RISK = 400
  const score     = signalScore || 4
  const scoreMultiplier = score <= 3 ? 0.5
    : score === 4 ? 0.75
    : score === 5 ? 1.0
    : 1.25  // score 6+

  const adjustedRisk = Math.round(BASE_RISK * scoreMultiplier)

  // ── Step 2: ATR-based stop distance (1x ATR) ──────────────────
  const stopDist   = +currentATR.toFixed(2)
  const targetDist = +(currentATR * 2).toFixed(2)

  // ── Step 3: Contracts from adjusted risk + ATR ────────────────
  const dollarPerPoint = spec.multiplier
  const rawContracts   = adjustedRisk / (stopDist * dollarPerPoint)
  const contracts      = Math.max(1, Math.min(6, Math.round(rawContracts)))
  const actualRisk     = +(contracts * stopDist * dollarPerPoint).toFixed(2)

  // ── Step 4: Stop and target prices ───────────────────────────
  const stopPrice   = side === 'LONG'
    ? +(entryPrice - stopDist).toFixed(2)
    : +(entryPrice + stopDist).toFixed(2)
  const targetPrice = side === 'LONG'
    ? +(entryPrice + targetDist).toFixed(2)
    : +(entryPrice - targetDist).toFixed(2)

  return {
    stopDistance:           stopDist,
    stopPrice,
    targetPrice,
    targetDistance:         targetDist,
    rrRatio:                2,
    contracts,
    riskDollars:            actualRisk,
    riskPct:                +((actualRisk / accountSize) * 100).toFixed(2),
    potentialProfitDollars: +(contracts * targetDist * dollarPerPoint).toFixed(2),
    currentATR:             +currentATR.toFixed(2),
    winRate,
    expectancy,
    confidence,
    sampleSize,
    reasoning: `Score ${score}(${scoreMultiplier}x) · $${adjustedRisk} risk · ATR ${stopDist}pts · ${contracts}x · 2R`,
  }
}
