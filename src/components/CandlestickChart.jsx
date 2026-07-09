import { useEffect, useRef } from 'react'
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts'

const IND_COLORS = {
  ema9:   '#f0a020',
  ema21:  '#2d6cdf',
  ema50:  '#9c7aff',
  sma20:  '#00a8b5',
  sma50:  '#f0a020',
  sma200: '#9c7aff',
}

function toChartTime(ms) {
  return Math.floor(ms / 1000)
}

export default function CandlestickChart({ candles, indicators, trades, replayIdx }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const lineSeriesMap = useRef({})
  const riskLinesRef = useRef({ stop: null, target: null })

  // Create chart once on mount
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 340,
      layout: {
        background:  { color: '#161618' },
        textColor:   '#8a8a90',
        fontSize:    11,
        fontFamily:  'Inter, -apple-system, sans-serif',
      },
      grid: {
        vertLines: { color: '#2a2a2e' },
        horzLines: { color: '#2a2a2e' },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#3a3a3e', labelBackgroundColor: '#2a2a2e' },
        horzLine: { color: '#3a3a3e', labelBackgroundColor: '#2a2a2e' },
      },
      rightPriceScale: {
        borderColor: '#2a2a2e',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: '#2a2a2e',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale:  true,
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:        '#00c878',
      downColor:      '#ff4757',
      borderUpColor:  '#00c878',
      borderDownColor:'#ff4757',
      wickUpColor:    '#00c878',
      wickDownColor:  '#ff4757',
    })

    chartRef.current = chart
    candleSeriesRef.current = candleSeries

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [])

  // Update data whenever candles / replay / indicators / trades change
  useEffect(() => {
    if (!candleSeriesRef.current || !candles.length) return

    const chart = chartRef.current
    const candleSeries = candleSeriesRef.current
    const limit = replayIdx != null ? replayIdx + 1 : candles.length
    const visibleCandles = candles.slice(0, limit)

    // Candle data
    candleSeries.setData(
      visibleCandles.map(c => ({
        time:  toChartTime(c.time),
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      }))
    )

    // Trade markers — v5 uses createSeriesMarkers
    const visibleTrades = trades.filter(t => t.barIndex < limit)
    try {
      createSeriesMarkers(
        candleSeries,
        visibleTrades.map(t => ({
          time:     toChartTime(t.time),
          position: t.type === 'entry' ? 'belowBar' : 'aboveBar',
          color:    t.type === 'entry'
            ? '#00c878'
            : (t.pnlPct >= 0 ? '#00c878' : '#ff4757'),
          shape:    t.type === 'entry' ? 'arrowUp' : 'arrowDown',
          text:     t.type === 'entry'
            ? 'Buy'
            : `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct?.toFixed(2)}%`,
          size: 1,
        }))
      )
    } catch (e) { console.warn('Markers:', e.message) }

    // Indicator line series — create/update
    // Only draw indicators that are continuous price values (EMA/SMA) —
    // SMC detectors (FVG, liquidity sweep, BOS, etc.) are true/false flags,
    // not prices, and would break the chart if plotted as a line series.
    const priceInds = Object.entries(indicators).filter(([k]) => IND_COLORS[k] !== undefined)

    // Remove line series no longer needed
    Object.keys(lineSeriesMap.current).forEach(id => {
      if (!indicators[id]) {
        chart.removeSeries(lineSeriesMap.current[id])
        delete lineSeriesMap.current[id]
      }
    })

    priceInds.forEach(([id, values]) => {
      if (!lineSeriesMap.current[id]) {
        lineSeriesMap.current[id] = chart.addSeries(LineSeries, {
          color:            IND_COLORS[id] || '#888888',
          lineWidth:        1.5,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        })
      }
      const data = values
        .slice(0, limit)
        .map((v, i) => v != null ? { time: toChartTime(candles[i].time), value: v } : null)
        .filter(Boolean)
      lineSeriesMap.current[id].setData(data)
    })

    // Stop loss / take profit lines for the currently open position —
    // lets you visually watch the bot's risk management while it trades.
    const candleSeries2 = candleSeriesRef.current
    if (riskLinesRef.current.stop) { candleSeries2.removePriceLine(riskLinesRef.current.stop); riskLinesRef.current.stop = null }
    if (riskLinesRef.current.target) { candleSeries2.removePriceLine(riskLinesRef.current.target); riskLinesRef.current.target = null }

    let openEntry = null
    for (const t of trades) {
      if (t.barIndex >= limit) break
      if (t.type === 'entry') openEntry = t
      if (t.type === 'exit') openEntry = null
    }
    if (openEntry && openEntry.stopPrice != null) {
      riskLinesRef.current.stop = candleSeries2.createPriceLine({
        price: openEntry.stopPrice,
        color: '#ff4757',
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: 'Stop',
      })
      riskLinesRef.current.target = candleSeries2.createPriceLine({
        price: openEntry.takeProfitPrice,
        color: '#00c878',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Target',
      })
    }

    // Scroll chart to show latest candle during replay
    if (replayIdx != null) {
      chart.timeScale().scrollToRealTime()
    }
  }, [candles, indicators, trades, replayIdx])

  return <div ref={containerRef} style={{ width: '100%', borderRadius: 6, overflow: 'hidden' }} />
}
