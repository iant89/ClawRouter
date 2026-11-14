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
    // Pages load on first visit (phase 16). After ClawRouter is upgraded, an open
    // console asks for page files that no longer exist: only a reload helps.
    if (isStaleBuild(this.state.error)) {
      return (
        <Page title="ClawRouter was updated">
          <EmptyState
            icon="refresh"
            title="Reload to continue"
            description="A newer version of the console is available. Reload to open this page."
            actions={<Button variant="primary" onClick={() => window.location.reload()}>Reload console</Button>}
          />
        </Page>
      );
    }
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

/** A page's code could not be loaded (Chrome, Firefox and Safari word it differently). */
export function isStaleBuild(error: Error): boolean {
  return /dynamically imported module|module script failed|Importing a module script|error loading dynamically imported|Unable to preload/i.test(error.message);
}
