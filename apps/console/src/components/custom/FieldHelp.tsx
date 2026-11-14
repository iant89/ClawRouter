import type { ReactNode } from 'react';
import { IconButton, Popover } from '@enterprise-ui/react';

/**
 * An "i" button for a form field's longer explanation, shown in a popover
 * instead of under the field. Put it in the field's `endAdornment`; keep short,
 * essential hints (allowed range, format) under the field as its description.
 * The popover is titled with the field's label, so the button's name says which
 * field it explains.
 */
export function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover
      title={label}
      placement="bottom-end"
      width="22rem"
      trigger={<IconButton icon="information" label={`About ${label}`} size="sm" neutral type="button" />}
    >
      <div className="claw-field-help">{children}</div>
    </Popover>
  );
}
