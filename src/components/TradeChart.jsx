import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode, CandlestickSeries, createSeriesMarkers } from 'lightweight-charts'
import { fetchMonthRange } from '../massiveFinance'

const PRIMARY = 'NQ'
const TF      = '5m'

export default function TradeChart({ trades = [], livePrice = null }) {
  const containerRef = useRef(null)
  const chartRef     = useRef(null)
  const candleRef    = useRef(null)
  const markerRef    = useRef(null)
  const priceRef     = useRef(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [barCount, setBarCount] = useState(0)
  const timerRef = useRef(null)

  // ── Init chart once ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor:  '#9ca3af',
        fontSize:   11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      timeScale: {
        borderColor:    'rgba(255,255,255,0.1)',
        timeVisible:    true,
        secondsVisible: false,
      },
      width:  containerRef.current.clientWidth,
      height: 360,
    })

    // v5: chart.addSeries(SeriesType, options)
    const candles = chart.addSeries(CandlestickSeries, {
      upColor:         '#10b981',
      downColor:       '#ef4444',
      borderUpColor:   '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor:     '#10b981',
      wickDownColor:   '#ef4444',
    })

    chartRef.current  = chart
    candleRef.current = candles

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current  = null
      candleRef.current = null
      priceRef.current  = null
      markerRef.current = null
    }
  }, [])

  // ── Load data ────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!candleRef.current) return
    setError(null)

    try {
      const now   = new Date()
      const year  = now.getFullYear()
      const month = now.getMonth() + 1
      const prevY = month === 1 ? year - 1 : year
      const prevM = month === 1 ? 12 : month - 1

      const [curr, prev] = await Promise.all([
        fetchMonthRange(PRIMARY, TF, year, month),
        fetchMonthRange(PRIMARY, TF, prevY, prevM),
      ])

      const all = [...prev, ...curr].slice(-80)
      if (all.length === 0) {
        setError('No data — market may be closed')
        setLoading(false)
        return
      }

      const data = all.map(b => ({
        time:  Math.floor(b.time / 1000),
        open:  b.open,
        high:  b.high,
        low:   b.low,
        close: b.close,
      }))

      candleRef.current.setData(data)
      setBarCount(data.length)
      paintMarkers(data)
      chartRef.current.timeScale().fitContent()
      setLoading(false)
    } catch (e) {
      setError(e.message)
      setLoading(false)
    }
  }, [trades])

  // ── Paint trade markers ──────────────────────────────────────────
  function paintMarkers(candles) {
    if (!candleRef.current || !candles.length) return

    const markers = []
    for (const t of trades) {
      const entryBar = nearest(candles, t.entryTime)
      if (entryBar !== null) {
        markers.push({
          time:     entryBar,
          position: t.side === 'LONG' ? 'belowBar' : 'aboveBar',
          color:    t.side === 'LONG' ? '#10b981' : '#ef4444',
          shape:    t.side === 'LONG' ? 'arrowUp' : 'arrowDown',
          text:     `${t.side === 'LONG' ? '▲' : '▼'} ${t.entryPrice?.toFixed(0)}`,
          size:     2,
        })
      }
      if (t.exitTime && t.exitPrice) {
        const exitBar = nearest(candles, t.exitTime)
        if (exitBar !== null) {
          const win = t.pnlDollars >= 0
          markers.push({
            time:     exitBar,
            position: win ? 'aboveBar' : 'belowBar',
            color:    win ? '#0d9488' : '#9f1239',
            shape:    'circle',
            text:     `${win ? '+' : ''}$${t.pnlDollars?.toFixed(0)}`,
            size:     1,
          })
        }
      }
    }

    markers.sort((a, b) => a.time - b.time)

    try {
      // v5: createSeriesMarkers replaces series.setMarkers()
      if (markerRef.current) {
        try { markerRef.current.detach?.() } catch {}
      }
      if (markers.length > 0) {
        markerRef.current = createSeriesMarkers(candleRef.current, markers)
      }
    } catch (e) {
      console.warn('Chart markers:', e.message)
    }
  }

  // ── Live price line ──────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current || !livePrice) return
    try {
      if (priceRef.current) {
        try { candleRef.current.removePriceLine(priceRef.current) } catch {}
      }
      priceRef.current = candleRef.current.createPriceLine({
        price:            livePrice,
        color:            '#60a5fa',
        lineWidth:        1,
        lineStyle:        2,
        axisLabelVisible: true,
        title:            'Live',
      })
    } catch {}
  }, [livePrice])

  // ── Reload on trade changes ──────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current || loading) return
    loadData()
  }, [trades.length])

  // ── Initial load + 60s refresh ───────────────────────────────────
  useEffect(() => {
    loadData()
    timerRef.current = setInterval(loadData, 60_000)
    return () => clearInterval(timerRef.current)
  }, [])

  function nearest(candles, ms) {
    if (!ms) return null
    const target = Math.floor(ms / 1000)
    let best = candles[0], bestD = Math.abs(candles[0].time - target)
    for (const c of candles) {
      const d = Math.abs(c.time - target)
      if (d < bestD) { best = c; bestD = d }
    }
    return bestD < 50 * 60 ? best.time : null
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 6, fontSize: 11, color: 'var(--text-dim)', alignItems: 'center' }}>
        <span>NQ 5m · {barCount} bars</span>
        <span>·</span>
        <span style={{ color: '#60a5fa' }}>{livePrice ? `Live: ${livePrice.toFixed(2)}` : 'Waiting...'}</span>
        <div style={{ flex: 1 }} />
        <button onClick={loadData} style={{ fontSize: 10, color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer' }}>↻ refresh</button>
      </div>

      <div style={{ display: 'flex', gap: 14, marginBottom: 8, fontSize: 11, color: 'var(--text-dim)' }}>
        <span>▲ <span style={{ color: '#10b981' }}>Long</span></span>
        <span>▼ <span style={{ color: '#ef4444' }}>Short</span></span>
        <span>● <span style={{ color: '#0d9488' }}>Win</span></span>
        <span>● <span style={{ color: '#9f1239' }}>Loss</span></span>
        <span>— <span style={{ color: '#60a5fa' }}>Live price</span></span>
      </div>

      <div ref={containerRef} style={{
        width: '100%', borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'rgba(0,0,0,0.2)',
        overflow: 'hidden', minHeight: 360,
      }} />

      {loading && (
        <div style={{
          position: 'absolute', top: 40, left: 0, right: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.4)', borderRadius: 8,
          fontSize: 13, color: 'var(--text-dim)',
        }}>
          Loading NQ candles...
        </div>
      )}

      {error && !loading && (
        <div style={{
          position: 'absolute', top: 40, left: 0, right: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.4)', borderRadius: 8,
          fontSize: 12, color: 'var(--red)', padding: '0 20px', textAlign: 'center',
        }}>
          {error}
        </div>
      )}
    </div>
  )
}
