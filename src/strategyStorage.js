// Saved Strategies — syncs with Supabase so strategies appear on all devices.
// Falls back to localStorage if Supabase is unavailable.

import { sbGet, sbSet, sbDelete, sbGetAll } from './supabase'

const LOCAL_KEY  = 'tradingbot_saved_strategies_v2'
const SB_TABLE   = 'strategies'

// ── Local fallback ────────────────────────────────────────────────
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]') } catch { return [] }
}
function saveLocal(strategies) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(strategies)) } catch {}
}

function makeId(name) {
  const slug = (name || 'strategy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return `${slug}-${Date.now()}`
}

function makeSource(source = {}) {
  return { youtubeUrl: source.youtubeUrl || '', transcript: source.transcript || '', notes: source.notes || '', addedAt: Date.now() }
}

// ── Save a newly extracted strategy ─────────────────────────────
export async function saveStrategy(strategy, source = {}) {
  const record = {
    id:        makeId(strategy.name),
    strategy,
    sources:   [makeSource(source)],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  // Save locally first (instant)
  const local = loadLocal()
  local.push(record)
  saveLocal(local)

  // Sync to Supabase
  try { await sbSet(SB_TABLE, record, record.id) } catch {}

  return record.id
}

// ── Update strategy rules ────────────────────────────────────────
export async function updateStrategy(id, updatedStrategy) {
  const local = loadLocal()
  const idx   = local.findIndex(s => s.id === id)
  if (idx === -1) return false
  local[idx].strategy  = updatedStrategy
  local[idx].updatedAt = Date.now()
  saveLocal(local)
  try { await sbSet(SB_TABLE, local[idx], id) } catch {}
  return true
}

// ── Add combined source ──────────────────────────────────────────
export async function addCombinedSource(id, updatedStrategy, source = {}) {
  const local = loadLocal()
  const idx   = local.findIndex(s => s.id === id)
  if (idx === -1) return false
  local[idx].strategy  = updatedStrategy
  local[idx].sources   = [...(local[idx].sources || []), makeSource(source)]
  local[idx].updatedAt = Date.now()
  saveLocal(local)
  try { await sbSet(SB_TABLE, local[idx], id) } catch {}
  return true
}

// ── List all strategies — merge Supabase + local ─────────────────
export async function listStrategiesAsync() {
  try {
    const rows = await sbGetAll(SB_TABLE)
    if (rows?.length) {
      const strategies = rows.map(r => r.data).filter(Boolean)
      saveLocal(strategies)  // keep local in sync
      return strategies.sort((a, b) => b.updatedAt - a.updatedAt)
    }
  } catch {}
  return loadLocal().sort((a, b) => b.updatedAt - a.updatedAt)
}

// Sync version for places that need it immediately (kept for compatibility)
export function listStrategies() {
  return loadLocal().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getStrategy(id) {
  return loadLocal().find(s => s.id === id) || null
}

export async function deleteStrategy(id) {
  saveLocal(loadLocal().filter(s => s.id !== id))
  try { await sbDelete(SB_TABLE, id) } catch {}
}
