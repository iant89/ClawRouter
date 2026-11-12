import { REALTIME_CLOSE, REALTIME_PATH, type RealtimeServerMessage } from '@clawrouter/shared';

/**
 * live: connected and receiving; reconnecting: lost, retrying with backoff;
 * offline: stopped (signed out, or the session ended).
 */
export type RealtimeState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Messages delivered to listeners: the server's, plus `resync` after a reconnect (events may have been missed). */
export type RealtimeMessage = RealtimeServerMessage | { type: 'resync' };

type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

export interface RealtimeOptions {
  /** Called when the server says the session ended (close 4401): sign in again. */
  onSessionEnded: () => void;
  url?: string;
  createSocket?: (url: string) => SocketLike;
  /** Timers and randomness, injectable for tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  random?: () => number;
}

const MAX_BACKOFF_MS = 30_000;

/** Delay before reconnect attempt `n` (0-based): 1 s, 2 s, 4 s … 30 s, each with up to 50% random jitter off. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.round(base * (0.5 + random() * 0.5));
}

/**
 * One live connection for the whole console (spec §25). Reconnects with
 * exponential backoff and jitter, detects dead connections with a heartbeat, and
 * tells listeners to resync after any gap. Never reconnects once the session has
 * ended. The browser sends the session cookie; nothing secret is held here.
 */
export class RealtimeConnection {
  state: RealtimeState = 'offline';
  private ws: SocketLike | null = null;
  private attempt = 0;
  private everConnected = false;
  private stopped = true;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private heartbeatMs = 25_000;
  private readonly listeners = new Set<(m: RealtimeMessage) => void>();
  private readonly stateListeners = new Set<(s: RealtimeState) => void>();
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (id: unknown) => void;

  constructor(private readonly options: RealtimeOptions) {
    this.setT = options.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearT = options.clearTimeout ?? ((id) => window.clearTimeout(id as number));
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'signed out');
    this.setState('offline');
  }

  /** Try now instead of waiting for the backoff (e.g. the tab became visible again). */
  retryNow() {
    if (this.stopped || this.state !== 'reconnecting') return;
    this.clearT(this.reconnectTimer);
    this.connect();
  }

  subscribe(listener: (m: RealtimeMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(listener: (s: RealtimeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private connect() {
    this.setState(this.everConnected ? 'reconnecting' : 'connecting');
    const url = this.options.url ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${REALTIME_PATH}`;
    const ws = (this.options.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(url);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.armWatchdog();
      let msg: RealtimeServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as RealtimeServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        this.heartbeatMs = msg.heartbeatMs;
        const reconnected = this.everConnected;
        this.everConnected = true;
        this.attempt = 0;
        this.setState('live');
        this.scheduleHeartbeat();
        if (reconnected) this.emit({ type: 'resync' });
      }
      this.emit(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (ev.code === REALTIME_CLOSE.SESSION_ENDED) {
        this.stopped = true;
        this.setState('offline');
        this.options.onSessionEnded();
        return;
      }
      if (this.stopped) return;
      this.setState('reconnecting');
      this.reconnectTimer = this.setT(() => this.connect(), backoffMs(this.attempt++, this.options.random));
    };
    ws.onerror = () => {
      // A close event always follows; reconnection is handled there.
    };
  }

  private scheduleHeartbeat() {
    this.clearT(this.heartbeatTimer);
    this.heartbeatTimer = this.setT(() => {
      try {
        this.ws?.send(JSON.stringify({ type: 'ping' }));
      } catch {
        // the close handler deals with it
      }
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
  }

  /** No message for two heartbeats (pongs included): the connection is dead even if the browser has not noticed. */
  private armWatchdog() {
    this.clearT(this.watchdogTimer);
    this.watchdogTimer = this.setT(() => {
      const ws = this.ws;
      if (!ws) return;
      ws.onclose?.({ code: 4000, reason: 'heartbeat timeout' } as CloseEvent);
      ws.close(4000, 'heartbeat timeout');
    }, this.heartbeatMs * 2 + 5_000);
  }

  private clearTimers() {
    this.clearT(this.reconnectTimer);
    this.clearT(this.heartbeatTimer);
    this.clearT(this.watchdogTimer);
  }

  private emit(m: RealtimeMessage) {
    for (const l of this.listeners) {
      try {
        l(m);
      } catch (error) {
        console.error('realtime listener failed', error);
      }
    }
  }

  private setState(s: RealtimeState) {
    if (this.state === s) return;
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }
}
