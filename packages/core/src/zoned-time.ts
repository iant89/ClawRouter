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

/** Wall-clock time in an IANA time zone, without a date library. */
export interface WallTime {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, f);
  }
  return f;
};

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time at instant `t` in `timeZone`. */
export function wallTime(t: number, timeZone: string): WallTime & { second: number } {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  const utcDay = new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay();
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second!, weekday: utcDay === 0 ? 7 : utcDay };
}

/** Offset of `timeZone` from UTC at instant `t`, in ms (positive east of Greenwich). */
function offset(t: number, timeZone: string): number {
  const w = wallTime(t, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` shows this date and hour.
 * Day and month overflow like `Date.UTC` (day 0 is the last day of the previous
 * month). A time skipped by a daylight-saving change resolves to the hour after.
 */
export function fromWallTime(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  let guess = wall - offset(wall, timeZone);
  guess = wall - offset(guess, timeZone);
  return guess;
}
