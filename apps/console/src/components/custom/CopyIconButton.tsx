import { IconButton, useToast } from '@enterprise-ui/react';

/**
 * An icon-only copy button that fits inside a field (an Input's `endAdornment`).
 * ENTERPRISE-UI's CopyButton always shows its label and status as text, which
 * crowds a field out. The result is reported with a toast (announced to screen
 * readers by the toast region).
 */
export function CopyIconButton({ value, label, copiedTitle = 'Copied to the clipboard' }: {
  value: string;
  /** Accessible name and tooltip, e.g. "Copy setup key". */
  label: string;
  /** Title of the success toast. */
  copiedTitle?: string;
}) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.show({ tone: 'success', title: copiedTitle });
    } catch {
      toast.show({ tone: 'error', title: 'Could not copy', description: 'Select the text and copy it instead.', duration: 10_000 });
    }
  };
  return <IconButton icon="copy" label={label} size="sm" neutral type="button" onClick={() => void copy()} />;
}
