/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, MessageStrip, Text, useToast } from '@enterprise-ui/react';
import { CAPTURE_EXPORT_MAX } from '@clawrouter/shared';
import { downloadCaptures } from '../../services/captures.ts';

/**
 * Exports captures to a JSON file for a developer. Credentials are never in it;
 * message text (prompts, replies, tool arguments, images) is, unless masked.
 */
export function ExportCapturesDialog({ ids, onClose }: { ids: string[] | null; onClose: () => void }) {
  const toast = useToast();
  const [maskText, setMaskText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids) setError(null);
  }, [ids]);

  const n = ids?.length ?? 0;
  const tooMany = n > CAPTURE_EXPORT_MAX;
  const download = async () => {
    if (!ids) return;
    setBusy(true);
    setError(null);
    try {
      const name = await downloadCaptures(ids, maskText);
      toast.show({ tone: 'success', title: 'Capture file downloaded', description: name });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={ids !== null} onClose={onClose} size="md" title={n === 1 ? 'Export capture' : `Export ${n} captures`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="download" onClick={() => void download()} loading={busy} disabled={tooMany || n === 0}>Download file</Button>
      </>}
    >
      <Text>
        A JSON file with everything recorded: what the client sent, each call to a provider with its raw reply, and what the client got.
        Send it to whoever fixes ClawRouter. API keys and other credentials are never in it.
      </Text>
      <Checkbox
        label="Mask message text"
        checked={maskText}
        onChange={setMaskText}
        description="Prompts, replies, tool arguments and images become their length, such as [masked: 42 chars]. Models, roles, fields and errors stay, so most problems can still be found; leave it off when the problem may be in the text itself."
      />
      {!maskText && (
        <MessageStrip tone="warning">The file will contain users' prompts and replies as they were sent. Share it only with someone you trust with them.</MessageStrip>
      )}
      {tooMany && <MessageStrip tone="error">At most {CAPTURE_EXPORT_MAX} captures fit in one file. Select fewer.</MessageStrip>}
      {error && <MessageStrip tone="error">{error}</MessageStrip>}
    </Dialog>
  );
}
