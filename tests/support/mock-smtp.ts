/**
 * A local SMTP server for tests (no TLS): accepts AUTH PLAIN/LOGIN with the
 * configured credentials and records each message, with its body decoded.
 * Tests never send real mail.
 */
export interface ReceivedMail {
  from: string;
  to: string[];
  /** Raw message (headers and base64 body). */
  raw: string;
  subject: string;
  /** Decoded text body. */
  text: string;
}

export interface MockSmtp {
  port: number;
  messages: ReceivedMail[];
  /** Credentials the server accepts (null: no AUTH offered). */
  credentials: { username: string; password: string } | null;
  /** Make the next recipient be refused (e.g. 550 mailbox unavailable). */
  refuseRecipients: boolean;
  /** AUTH mechanisms offered in EHLO. */
  authMechanisms: string;
  stop(): void;
}

export function startMockSmtp(): MockSmtp {
  const state: MockSmtp = { port: 0, messages: [], credentials: { username: 'mailer', password: 'mail-secret-123' }, refuseRecipients: false, authMechanisms: 'PLAIN LOGIN', stop: () => {} };
  type Session = { buffer: string; from: string; to: string[]; data: string | null; login: 'user' | 'pass' | null; user: string; authed: boolean };

  const server = Bun.listen<Session>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(s) {
        s.data = { buffer: '', from: '', to: [], data: null, login: null, user: '', authed: false };
        s.write('220 mock.smtp ESMTP ready\r\n');
      },
      data(s, chunk) {
        const st = s.data;
        st.buffer += chunk.toString();
        let i: number;
        while ((i = st.buffer.indexOf('\r\n')) >= 0) {
          const line = st.buffer.slice(0, i);
          st.buffer = st.buffer.slice(i + 2);
          if (st.data !== null) {
            if (line === '.') {
              const raw = st.data;
              const [head = '', body = ''] = raw.split('\r\n\r\n');
              const subject = /^Subject: (.*)$/m.exec(head)?.[1] ?? '';
              const decodedSubject = subject.startsWith('=?UTF-8?B?') ? Buffer.from(subject.slice(10, -2), 'base64').toString('utf8') : subject;
              state.messages.push({ from: st.from, to: st.to, raw, subject: decodedSubject, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n') });
              st.data = null;
              s.write('250 queued\r\n');
            } else {
              st.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
            }
            continue;
          }
          if (st.login === 'user') { st.user = Buffer.from(line, 'base64').toString(); st.login = 'pass'; s.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (st.login === 'pass') {
            st.login = null;
            const ok = state.credentials && st.user === state.credentials.username && Buffer.from(line, 'base64').toString() === state.credentials.password;
            st.authed = !!ok;
            s.write(ok ? '235 ok\r\n' : '535 bad credentials\r\n');
            continue;
          }
          const [verb = '', ...rest] = line.split(' ');
          const arg = rest.join(' ');
          switch (verb.toUpperCase()) {
            case 'EHLO':
              s.write(`250-mock.smtp\r\n${state.credentials ? `250-AUTH ${state.authMechanisms}\r\n` : ''}250 8BITMIME\r\n`);
              break;
            case 'AUTH': {
              if (arg.toUpperCase().startsWith('LOGIN')) { st.login = 'user'; s.write('334 VXNlcm5hbWU6\r\n'); break; }
              const [, user = '', pass = ''] = Buffer.from(arg.slice(6), 'base64').toString().split('\0');
              const ok = state.credentials && user === state.credentials.username && pass === state.credentials.password;
              st.authed = !!ok;
              s.write(ok ? '235 ok\r\n' : '535 bad credentials\r\n');
              break;
            }
            case 'MAIL':
              if (state.credentials && !st.authed) { s.write('530 authentication required\r\n'); break; }
              st.from = /<(.*)>/.exec(arg)?.[1] ?? '';
              st.to = [];
              s.write('250 ok\r\n');
              break;
            case 'RCPT':
              if (state.refuseRecipients) { s.write('550 mailbox unavailable\r\n'); break; }
              st.to.push(/<(.*)>/.exec(arg)?.[1] ?? '');
              s.write('250 ok\r\n');
              break;
            case 'DATA':
              st.data = '';
              s.write('354 go ahead\r\n');
              break;
            case 'QUIT':
              s.write('221 bye\r\n');
              s.end();
              break;
            default:
              s.write('502 not implemented\r\n');
          }
        }
      },
    },
  });
  state.port = server.port;
  state.stop = () => server.stop(true);
  return state;
}
