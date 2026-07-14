// @ts-nocheck
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { detectLocale, getMessages } from '../i18n';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      // Class components can't use the useI18n hook — resolve the locale
      // directly. This screen renders rarely, so no need for reactivity.
      const t = getMessages(detectLocale());
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '20px',
            textAlign: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <h1 style={{ fontSize: '24px', marginBottom: '12px' }}>
            {t.errors.somethingWentWrong}
          </h1>
          <p style={{ color: '#666', marginBottom: '24px', maxWidth: '400px' }}>
            {t.errors.unexpectedError}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '10px 24px',
              fontSize: '16px',
              borderRadius: '8px',
              border: 'none',
              background: '#4f46e5',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            {t.errors.tryAgain}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
