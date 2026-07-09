import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Surfaces in the browser console with full detail for debugging
    console.error('TradingBot crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 640, margin: '60px auto', padding: '0 20px' }}>
          <div className="card" style={{ borderColor: 'var(--red-border)' }}>
            <div className="card-title" style={{ color: 'var(--red)' }}>Something crashed</div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 12 }}>
              {this.state.error.message || String(this.state.error)}
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
              Open your browser console (F12, or right-click → Inspect → Console) for the full error trace —
              that's the fastest way to pin down exactly what broke.
            </p>
            <button
              className="btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => this.setState({ error: null })}
            >
              ↺ Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
