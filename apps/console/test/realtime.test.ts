import { describe, expect, test } from 'bun:test';
import { backoffMs, RealtimeConnection, type RealtimeMessage, type RealtimeState } from '../src/services/realtime.ts';

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  drop(code = 1006) {
    this.onclose?.({ code, reason: '' } as CloseEvent);
  }
}

/** Manual timers: `tick(ms)` runs everything due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => void pending.delete(id as number),
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

const HELLO = { type: 'hello', user: { id: 'u', username: 'admin' }, permissions: ['providers.read'], heartbeatMs: 25_000 };

function setup() {
  const timers = fakeTimers();
  const sockets: FakeSocket[] = [];
  let ended = 0;
  const c = new RealtimeConnection({
    url: 'ws://test/api/ws', onSessionEnded: () => { ended += 1; }, random: () => 1,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as never;
    },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const states: RealtimeState[] = [];
  const messages: RealtimeMessage[] = [];
  c.onStateChange((s) => states.push(s));
  c.subscribe((m) => messages.push(m));
  return { c, timers, sockets, states, messages, ended: () => ended };
}

describe('backoffMs', () => {
  test('doubles from 1 s to a 30 s cap, with jitter of up to half', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffMs(3, () => 0)).toBe(4000);
  });
});

describe('RealtimeConnection', () => {
  test('is live after hello; reconnects with backoff after a drop, then asks listeners to resync', () => {
    const { c, timers, sockets, states, messages } = setup();
    c.start();
    sockets[0]!.receive(HELLO);
    expect(c.state).toBe('live');
    sockets[0]!.drop();
    expect(c.state).toBe('reconnecting');
    timers.tick(999);
    expect(sockets).toHaveLength(1);
    timers.tick(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop(); // still down: the next wait doubles
    timers.tick(1999);
    expect(sockets).toHaveLength(2);
    timers.tick(1);
    sockets[2]!.receive(HELLO);
    expect(states).toEqual(['connecting', 'live', 'reconnecting', 'live']);
    expect(messages.map((m) => m.type)).toEqual(['hello', 'resync', 'hello']);
  });

  test('a session that ended (4401) stops reconnecting and signs the console out', () => {
    const { c, timers, sockets, ended } = setup();
    c.start();
    sockets[0]!.receive(HELLO);
    sockets[0]!.drop(4401);
    timers.tick(60_000);
    expect(sockets).toHaveLength(1);
    expect(c.state).toBe('offline');
    expect(ended()).toBe(1);
  });

  test('sends pings and treats a silent connection as dead', () => {
    const { c, timers, sockets } = setup();
    c.start();
    sockets[0]!.receive(HELLO);
    timers.tick(25_000);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    timers.tick(30_000); // no pong for 55 s after the last message
    expect(sockets[0]!.closedWith).toBe(4000);
    expect(c.state).toBe('reconnecting');
  });

  test('stop closes the socket and does not reconnect', () => {
    const { c, timers, sockets } = setup();
    c.start();
    sockets[0]!.receive(HELLO);
    c.stop();
    sockets[0]!.drop(1000);
    timers.tick(60_000);
    expect(sockets).toHaveLength(1);
    expect(c.state).toBe('offline');
  });

  test('retryNow skips the backoff wait', () => {
    const { c, sockets } = setup();
    c.start();
    sockets[0]!.receive(HELLO);
    sockets[0]!.drop();
    c.retryNow();
    expect(sockets).toHaveLength(2);
  });
});
