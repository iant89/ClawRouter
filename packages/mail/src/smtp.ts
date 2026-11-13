import type { Socket, SocketHandler } from 'bun';

/**
 * A minimal SMTP client (RFC 5321) for ClawRouter's own mail: sign-in codes and
 * security notices. Plain text only, one recipient per message. TLS is implicit
 * (`tls`, usually port 465), negotiated with STARTTLS (`starttls`, usually 587,
 * refused if the server does not offer it), or off (`none`, local relays only).
 */
export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string | null;
  password: string | null;
  /** Sender address, e.g. "ClawRouter <clawrouter@example.com>". */
  from: string;
  /** Reject invalid server certificates (always true outside tests). */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export class SmtpError extends Error {
  constructor(message: string, readonly code: number | null = null) {
    super(message);
    this.name = 'SmtpError';
  }
}

/** Header injection guard: a header value must be a single line. */
const singleLine = (v: string, what: string) => {
  if (/[\r\n]/.test(v)) throw new SmtpError(`${what} must be a single line`);
  return v;
};

/** The bare address inside "Name <addr>". */
export const addressOf = (v: string) => (/<([^<>]+)>\s*$/.exec(v)?.[1] ?? v).trim();

export const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);

/** RFC 5322 message: UTF-8 text, base64 body (no line-length or dot issues). */
export function buildMessage(from: string, msg: MailMessage, now = new Date()): string {
  const domain = addressOf(from).split('@')[1] ?? 'localhost';
  const body = Buffer.from(msg.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${singleLine(from, 'From')}`,
    `To: ${singleLine(msg.to, 'To')}`,
    `Subject: ${encodeHeader(singleLine(msg.subject, 'Subject'))}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

/** Reads SMTP replies (possibly multi-line) from whatever socket is current. */
class Conversation {
  private buffer = '';
  private waiting: ((line: string) => void) | null = null;
  private failed: Error | null = null;
  socket!: Socket<undefined>;

  readonly handlers: SocketHandler<undefined> = {
    data: (_s, chunk) => {
      this.buffer += chunk.toString();
      this.flush();
    },
    error: (_s, error) => this.fail(new SmtpError(`connection error: ${error.message}`)),
    close: () => this.fail(new SmtpError('the mail server closed the connection')),
    connectError: (_s, error) => this.fail(new SmtpError(`cannot connect: ${error.message}`)),
  };

  private fail(error: Error) {
    this.failed ??= error;
    const w = this.waiting;
    this.waiting = null;
    w?.('');
  }

  private flush() {
    if (!this.waiting) return;
    // A complete reply ends with a line "NNN text" (not "NNN-text").
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
        const reply = lines.slice(0, i + 1).join('\n');
        this.buffer = lines.slice(i + 1).join('\r\n');
        const w = this.waiting;
        this.waiting = null;
        w(reply);
        return;
      }
    }
  }

  reply(timeoutMs: number): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new SmtpError('the mail server did not answer in time'));
      }, timeoutMs);
      this.waiting = (raw) => {
        clearTimeout(timer);
        if (this.failed) return reject(this.failed);
        resolve({ code: Number(raw.slice(0, 3)), text: raw });
      };
      this.flush();
    });
  }
}

/** Sends one message. Throws SmtpError with the server's reply on failure (never includes the password). */
export async function sendMail(config: SmtpConfig, msg: MailMessage): Promise<void> {
  const to = addressOf(msg.to);
  if (!EMAIL_PATTERN.test(to)) throw new SmtpError('invalid recipient address');
  const timeout = config.timeoutMs ?? 15_000;
  const conv = new Conversation();
  const tls = config.security === 'tls' ? { rejectUnauthorized: config.rejectUnauthorized ?? true, serverName: config.host } : undefined;
  conv.socket = await Bun.connect({ hostname: config.host, port: config.port, socket: conv.handlers, ...(tls ? { tls } : {}) }).catch((e: Error) => {
    throw new SmtpError(`cannot connect to ${config.host}:${config.port}: ${e.message}`);
  });

  const send = (line: string) => conv.socket.write(`${line}\r\n`);
  const expect = async (codes: number[], what: string) => {
    const r = await conv.reply(timeout);
    if (!codes.includes(r.code)) throw new SmtpError(`${what} refused: ${r.text.split('\n').pop()?.slice(0, 200)}`, r.code);
    return r;
  };

  try {
    await expect([220], 'greeting');
    const hello = `EHLO ${config.from ? (addressOf(config.from).split('@')[1] ?? 'localhost') : 'localhost'}`;
    send(hello);
    let ehlo = await expect([250], 'EHLO');
    if (config.security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError('the mail server does not offer STARTTLS');
      send('STARTTLS');
      await expect([220], 'STARTTLS');
      const [, secure] = conv.socket.upgradeTLS({ tls: { rejectUnauthorized: config.rejectUnauthorized ?? true, serverName: config.host }, socket: conv.handlers });
      conv.socket = secure;
      send(hello);
      ehlo = await expect([250], 'EHLO');
    }
    if (config.username) {
      const password = config.password ?? '';
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        send(`AUTH PLAIN ${Buffer.from(`\0${config.username}\0${password}`).toString('base64')}`);
        await expect([235], 'sign-in');
      } else {
        send('AUTH LOGIN');
        await expect([334], 'sign-in');
        send(Buffer.from(config.username).toString('base64'));
        await expect([334], 'sign-in');
        send(Buffer.from(password).toString('base64'));
        await expect([235], 'sign-in');
      }
    }
    send(`MAIL FROM:<${addressOf(singleLine(config.from, 'From'))}>`);
    await expect([250], 'sender');
    send(`RCPT TO:<${to}>`);
    await expect([250, 251], 'recipient');
    send('DATA');
    await expect([354], 'message');
    // Dot-stuffing: a line starting with "." gets another one.
    conv.socket.write(`${buildMessage(config.from, msg).replace(/^\./gm, '..')}\r\n.\r\n`);
    await expect([250], 'message');
    send('QUIT');
    await conv.reply(timeout).catch(() => undefined);
  } finally {
    conv.socket.end();
  }
}
