/**
 * Reading history events — see
 * docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md.
 *
 * Every event is permanent and identified by `[device, seq]`: `device` is the
 * recording install's random ID, `seq` counts up per device. Nothing is ever
 * edited or deleted; `forget`/`restart` are applied when stats are computed.
 */

export type Layout = 'single' | 'double' | 'continuous-v' | 'continuous-h';
export type Orientation = 'portrait' | 'landscape';

/** One view (whatever was on screen together) and how long it stayed. */
export interface PagePayload {
  kind: 'page';
  volume: string;
  /** 1-based, inclusive. Whole pages: any page with any part on screen. */
  first_page: number;
  last_page: number;
  /** Characters of each page first_page..last_page, in order. */
  page_chars: number[];
  /** Characters of every page before first_page (position, not reading). */
  chars_before: number;
  /** Raw time on screen, uncapped. `null` = unknown (legacy conversion only). */
  dwell_ms: number | null;
  layout: Layout | 'unknown';
  orientation: Orientation | 'unknown';
  viewport: { w: number; h: number } | null;
}

/** A manual stat edit (volume editor): totals moved by these deltas. */
export interface AdjustPayload {
  kind: 'adjust';
  volume: string;
  time_delta_ms: number;
  chars_delta: number;
}

/** "Restart series": a new read pass of this volume starts here. */
export interface RestartPayload {
  kind: 'restart';
  volume: string;
}

/**
 * "Forget this volume's stats": ignore its events recorded before `before`.
 * `scope: 'time'` forgets only reading time/speed ("delete speed data"), and
 * keeps characters read; absent = forget everything.
 */
export interface ForgetPayload {
  kind: 'forget';
  volume: string;
  before: number;
  scope?: 'time';
}

export type EventPayload = PagePayload | AdjustPayload | RestartPayload | ForgetPayload;

/** `t` = epoch ms on the recording device (for `page`: when the view opened). */
export type ReadingEvent = { device: string; seq: number; t: number } & EventPayload;

export type DeviceClass = 'phone' | 'tablet' | 'laptop' | 'desktop' | 'unknown';

/** Facts a device records about itself. User labels live elsewhere (phase 4). */
export interface DeviceFacts {
  device: string;
  class: DeviceClass;
  os?: string;
  browser?: string;
  first_seen: string;
  last_seen: string;
}
