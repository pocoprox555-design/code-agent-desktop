/**
 * ErrorBoundary — حماية واجهة المستخدم من الأخطاء
 *
 * يمنع crash كامل للتطبيق عند حدوث خطأ في أي مكون.
 * يعرض رسالة خطأ واضحة مع زر لإعادة المحاولة.
 */

import React from 'react'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  retryKey?: number
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[ErrorBoundary] خطأ في المكون:', error, errorInfo)
  }

  handleRetry = (): void => {
    // استخدام key لإعادة تحميل المكون بالكامل
    this.setState((prev) => ({ hasError: false, error: null, retryKey: (prev.retryKey ?? 0) + 1 }))
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div style={{
          padding: '20px',
          margin: '20px',
          borderRadius: '8px',
          backgroundColor: '#1a1a2e',
          border: '1px solid #e74c3c',
          color: '#fff',
          direction: 'rtl',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <h3 style={{ color: '#e74c3c', margin: '0 0 10px 0' }}>
            ⚠️ حدث خطأ غير متوقع
          </h3>
          <p style={{ color: '#ccc', fontSize: '14px', marginBottom: '15px' }}>
            {this.state.error?.message || 'خطأ غير معروف'}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '8px 16px',
              backgroundColor: '#3498db',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            🔄 إعادة المحاولة
          </button>
        </div>
      )
    }

    return <div key={this.state.retryKey}>{this.props.children}</div>
  }
}
