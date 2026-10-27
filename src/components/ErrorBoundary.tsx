// @ts-nocheck
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { detectLocale, getMessages } from '../i18n';
import ReaderStatus from './ReaderStatus';

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
        <ReaderStatus
          title={t.errors.somethingWentWrong}
          actions={
            <>
              <button
                className="reader-status-btn reader-status-btn-primary"
                onClick={this.handleRetry}
              >
                {t.errors.tryAgain}
              </button>
              <a className="reader-status-btn" href="/">
                {t.common.goHome}
              </a>
            </>
          }
        >
          {t.errors.unexpectedError}
        </ReaderStatus>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
