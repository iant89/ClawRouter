import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@enterprise-ui/react';

/**
 * An icon-only copy button that fits inside a field (an Input's `endAdornment`).
 * ENTERPRISE-UI's CopyButton always shows its label and status as text, which
 * crowds a field out. Here the icon turns into a tick (or a cross) for two seconds,
 * and the result is announced politely to screen readers.
 */
export function CopyIconButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  return (
    <>
      <IconButton
        icon={state === 'copied' ? 'accept' : state === 'failed' ? 'error' : 'copy'}
        label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}
        size="sm"
        neutral={state === 'idle'}
        type="button"
        onClick={() => void copy()}
      />
      <span className="claw-visually-hidden" role="status" aria-live="polite">
        {state === 'copied' ? 'Copied to the clipboard.' : state === 'failed' ? 'Could not copy. Select the text and copy it instead.' : ''}
      </span>
    </>
  );
}
