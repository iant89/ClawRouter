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

/**
 * The model choice in "Capture the next requests": an "All models" entry at the top
 * of a list of checkboxes. All and particular models exclude each other: checking
 * All clears the models, checking a model clears All, and clearing the last model
 * checks All again. Nothing chosen is never a state.
 */

export const ALL_MODELS = '*';

export function nextModelChoice(previous: string[], next: string[]): string[] {
  const models = next.filter((m) => m !== ALL_MODELS);
  if (next.includes(ALL_MODELS) && !previous.includes(ALL_MODELS)) return [ALL_MODELS];
  return models.length ? models : [ALL_MODELS];
}

/** What the API is sent: null for every model. */
export const modelsToSend = (choice: string[]): string[] | null => {
  const models = choice.filter((m) => m !== ALL_MODELS);
  return models.length ? models : null;
};

/** "gpt-4o-mini", "a and b", "a, b and c", or "5 models", for the page's banner. */
export function describeModels(models: string[]): string {
  if (models.length > 3) return `${models.length} models`;
  return models.length <= 2 ? models.join(' and ') : `${models.slice(0, -1).join(', ')} and ${models.at(-1)}`;
}
