import { Component } from 'react'
import { LuTriangleAlert, LuRotateCw } from 'react-icons/lu'

// Ловит исключения рендера, чтобы одна битая запись не роняла всё приложение в белый экран.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)' }}>
          <div className="panel" style={{ maxWidth: 460, textAlign: 'center' }}>
            <div style={{ color: 'var(--danger)', display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <LuTriangleAlert size={40} />
            </div>
            <h2 style={{ justifyContent: 'center', marginBottom: 8 }}>Что-то пошло не так</h2>
            <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 18 }}>
              Произошла ошибка при отображении страницы. Данные не потеряны — попробуйте обновить.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn ghost" onClick={this.reset}>
                <span className="ic"><LuRotateCw size={16} /></span> Попробовать снова
              </button>
              <button className="btn" onClick={() => window.location.reload()}>Перезагрузить</button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
