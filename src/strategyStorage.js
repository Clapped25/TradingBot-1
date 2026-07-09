// Saved Strategies — persists what Claude extracted from each video so
// you never have to re-paste a URL or pay for re-extraction. A single
// saved strategy can be built from MULTIPLE videos: `sources` is an
// array, one entry per video that contributed to it, while `strategy`
// holds the single current combined rule set.
// (The actual LEARNING data lives separately in tradeMemory.js, pooled
// across every strategy — this file only stores the rule sets themselves.)

const STORAGE_KEY = 'tradingbot_saved_strategies_v2'

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveAll(strategies) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(strategies))
  } catch {
    // storage full or unavailable — saving just won't persist this session
  }
}

function makeId(name) {
  const slug = (name || 'strategy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return `${slug}-${Date.now()}`
}

function makeSource(source = {}) {
  return {
    youtubeUrl: source.youtubeUrl || '',
    transcript: source.transcript || '',
    notes: source.notes || '',
    addedAt: Date.now(),
  }
}

// ── Save a newly extracted strategy, with its source material ───
export function saveStrategy(strategy, source = {}) {
  const strategies = loadAll()
  const record = {
    id: makeId(strategy.name),
    strategy,
    sources: [makeSource(source)],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  strategies.push(record)
  saveAll(strategies)
  return record.id
}

// ── Update an existing saved strategy's rules (e.g. after AI feedback) ──
export function updateStrategy(id, updatedStrategy) {
  const strategies = loadAll()
  const idx = strategies.findIndex(s => s.id === id)
  if (idx === -1) return false
  strategies[idx].strategy = updatedStrategy
  strategies[idx].updatedAt = Date.now()
  saveAll(strategies)
  return true
}

// ── Combine: update the strategy AND record the new video as another source ──
export function addCombinedSource(id, updatedStrategy, source = {}) {
  const strategies = loadAll()
  const idx = strategies.findIndex(s => s.id === id)
  if (idx === -1) return false
  strategies[idx].strategy = updatedStrategy
  strategies[idx].sources = [...(strategies[idx].sources || []), makeSource(source)]
  strategies[idx].updatedAt = Date.now()
  saveAll(strategies)
  return true
}

export function listStrategies() {
  return loadAll().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getStrategy(id) {
  return loadAll().find(s => s.id === id) || null
}

export function deleteStrategy(id) {
  saveAll(loadAll().filter(s => s.id !== id))
}
