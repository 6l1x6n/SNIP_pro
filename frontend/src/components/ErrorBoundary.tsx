import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Короткое название блока для сообщения об ошибке («поиск», «PDF-просмотр»). */
  label?: string
  /** Компактный режим: не на весь экран, а на место блока (для модалок/вкладок). */
  inline?: boolean
}

interface State {
  error: Error | null
}

/**
 * Ловит рендер-ошибки поддерева и показывает фолбэк вместо белого экрана
 * (в SearchView такой случай уже бывал). Кнопка «Перезагрузить блок»
 * перемонтирует поддерево; «Перезагрузить страницу» — крайний случай.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info.componentStack)
  }

  private reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: this.props.inline ? 24 : '15vh 24px 0',
          textAlign: 'center',
          color: 'var(--text-2, inherit)',
        }}
      >
        <div style={{ fontSize: 32 }} aria-hidden>⚠️</div>
        <div>
          <b>Блок {this.props.label ? `«${this.props.label}» ` : ''}упал из-за ошибки.</b>
          <div style={{ opacity: 0.7, fontSize: 13, marginTop: 4 }}>{error.message}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={this.reset}>Перезагрузить блок</button>
          <button onClick={() => window.location.reload()}>Всю страницу</button>
        </div>
      </div>
    )
  }
}
