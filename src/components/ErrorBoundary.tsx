// @ts-nocheck
import React, { Component, ErrorInfo, ReactNode } from 'react';

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
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: 'var(--space-lg)',
            textAlign: 'center',
            fontFamily: 'var(--font-display)',
            background: 'var(--paper)',
            color: 'var(--ink)',
          }}
        >
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 400, margin: '0 0 var(--space-xs)', letterSpacing: '-0.01em' }}>
            Something went wrong
          </h1>
          <p style={{ color: 'var(--ink-soft)', fontFamily: 'var(--font-body)', margin: '0 0 var(--space-md)', maxWidth: '420px', lineHeight: 1.6 }}>
            An unexpected error occurred. Please try again.
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: 'var(--space-2xs) var(--space-md)',
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-base)',
              letterSpacing: '-0.01em',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--ink)',
              background: 'var(--ink)',
              color: 'var(--paper)',
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
