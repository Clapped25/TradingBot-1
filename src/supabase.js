// src/supabase.js
// Single Supabase client used across the whole app

const SUPABASE_URL  = 'https://dxnxtthvupbfydttqcpk.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4bnh0dGh2dXBiZnlkdHRxY3BrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1NTg2ODQsImV4cCI6MjA5OTEzNDY4NH0.BTa6EW2JMlpUmGmc7bj-h0rr-HLnEDet_IKbY5DLhao'

// Lightweight REST helper — no SDK needed, saves bundle size
export async function sbGet(table, id = 'main') {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=data`,
    { headers: headers() }
  )
  if (!res.ok) return null
  const rows = await res.json()
  return rows?.[0]?.data ?? null
}

export async function sbSet(table, data, id = 'main') {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}`,
    {
      method:  'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates' },
      body:    JSON.stringify({ id, data, updated_at: new Date().toISOString() }),
    }
  )
  return res.ok
}

export async function sbGetAll(table) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=id,data`,
    { headers: headers() }
  )
  if (!res.ok) return []
  return await res.json()
}

export async function sbDelete(table, id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,
    { method: 'DELETE', headers: headers() }
  )
  return res.ok
}

function headers() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON,
    'Authorization': `Bearer ${SUPABASE_ANON}`,
  }
}
