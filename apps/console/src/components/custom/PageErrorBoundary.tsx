import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, EmptyState, Page } from '@enterprise-ui/react';

interface State {
  error: Error | null;
}

/**
 * Keeps a crashing page from taking down the console: the shell, navigation
 * and header stay usable. Reset by changing `resetKey` (the current path).
 */
export class PageErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Console page crashed', error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Page title="Something went wrong">
        <EmptyState
          icon="error"
          title="This page could not be displayed"
          description="The rest of the console still works. Try again, or open another page. If it keeps happening, reload the console."
          actions={
            <>
              <Button onClick={() => this.setState({ error: null })}>Try again</Button>
              <Button variant="tertiary" onClick={() => window.location.reload()}>Reload console</Button>
            </>
          }
        />
      </Page>
    );
  }
}
