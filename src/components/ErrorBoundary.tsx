'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Optional label for identifying which component boundary caught the error */
  name?: string;
  /** When true, the reset button calls window.location.reload() instead of resetting state */
  reloadOnReset?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Client-side Error Boundary to catch runtime rendering errors
 * and prevent white-screen crashes. Wraps children gracefully.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[ErrorBoundary${this.props.name ? ` (${this.props.name})` : ''}]`,
      error,
      '\nComponent stack:',
      info.componentStack,
    );
  }

  handleReset = () => {
    if (this.props.reloadOnReset) {
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center gap-4 py-16 px-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">组件渲染错误</h3>
            <p className="text-xs text-muted-foreground max-w-md">
              {this.props.name && <span className="font-mono">[{this.props.name}] </span>}
              {this.state.error?.message || '发生了未知错误'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={this.handleReset} className="gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" />
            {this.props.reloadOnReset ? '重新加载' : '重试'}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
