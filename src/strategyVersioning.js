// Strategy Versioning — saves a checkpoint before every AI-proposed change
// so we can revert if the validation fails. Also tracks which months have
// been tested per strategy so the validation step always picks genuinely
// unseen data.

const VERSIONS_KEY = 'tradingbot_strategy_versions_v1'
const TESTED_MONTHS_KEY = 'tradingbot_tested_months_v1'
const MAX_VERSIONS = 20

// ── Version checkpoints ──────────────────────────────────────────

function loadVersions() {
  try { return JSON.parse(localStorage.getItem(VERSIONS_KEY) || '[]') } catch { return [] }
}
function saveVersions(v) {
  try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(v)) } catch {}
}

export function saveVersion({ strategyName, signalBody, indicatorDefs, metrics, note }) {
  const versions = loadVersions()
  versions.push({
    id: Date.now(),
    strategyName,
    signalBody,
    indicatorDefs: indicatorDefs || [],
    metrics: metrics || null,
    note: note || '',
    savedAt: Date.now(),
  })
  if (versions.length > MAX_VERSIONS) versions.splice(0, versions.length - MAX_VERSIONS)
  saveVersions(versions)
}

export function getVersions(strategyName = null) {
  const versions = loadVersions()
  return strategyName ? versions.filter(v => v.strategyName === strategyName) : versions
}

export function getPreviousVersion(strategyName) {
  const versions = getVersions(strategyName)
  // Second to last — the one before the most recent checkpoint
  return versions.length >= 2 ? versions[versions.length - 2] : versions[0] || null
}

export function clearVersions(strategyName) {
  const versions = loadVersions()
  saveVersions(strategyName ? versions.filter(v => v.strategyName !== strategyName) : [])
}

// ── Tested month tracking ─────────────────────────────────────────
// Each time a backtest runs, we record which months were used.
// The validation step then picks a month that was NEVER used for
// this strategy — ensuring genuine out-of-sample testing.

function loadTestedMonths() {
  try { return JSON.parse(localStorage.getItem(TESTED_MONTHS_KEY) || '{}') } catch { return {} }
}
function saveTestedMonths(d) {
  try { localStorage.setItem(TESTED_MONTHS_KEY, JSON.stringify(d)) } catch {}
}

export function addTestedMonths(strategyName, monthKeys) {
  const data = loadTestedMonths()
  if (!data[strategyName]) data[strategyName] = []
  for (const key of monthKeys) {
    if (!data[strategyName].includes(key)) data[strategyName].push(key)
  }
  saveTestedMonths(data)
}

export function getTestedMonths(strategyName) {
  return loadTestedMonths()[strategyName] || []
}

// Returns the first available month that has never been tested for
// this strategy. If all months have been tested, returns the oldest
// one (least recently tested is better than nothing).
export function getUnseenMonth(strategyName, availableMonths) {
  const tested = getTestedMonths(strategyName)
  const unseen = availableMonths.find(m => !tested.includes(m.key))
  if (unseen) return unseen
  // All tested — return the oldest available month
  return availableMonths[availableMonths.length - 1] || null
}

export function clearTestedMonths(strategyName) {
  const data = loadTestedMonths()
  if (strategyName) delete data[strategyName]
  else Object.keys(data).forEach(k => delete data[k])
  saveTestedMonths(data)
}
