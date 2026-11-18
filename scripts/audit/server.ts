/**
 * Starts and stops production-build servers for the audit. Each server gets its own
 * port, database and environment; it is stopped by its own process (never by name).
 */
import { join } from 'node:path';

export interface AuditServer {
  base: string;
  pid: number;
  log: string;
  env: Record<string, string>;
  stop(): Promise<string>;
}

export async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

export async function startServer(dist: string, dir: string, name: string, env: Record<string, string>): Promise<AuditServer> {
  const port = await freePort();
  const tls = Boolean(env.CLAWROUTER_TLS_CERT_FILE);
  const full: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CLAWROUTER_ENV: 'production',
    CLAWROUTER_HOST: '127.0.0.1',
    CLAWROUTER_PORT: String(port),
    CLAWROUTER_BACKUP_INTERVAL_HOURS: '0',
    CLAWROUTER_LOG_FORMAT: 'json',
    ...(tls ? {} : { CLAWROUTER_COOKIE_SECURE: 'false' }),
    ...env,
  };
  const log = join(dir, `${name}.log`);
  const child = Bun.spawn(['bun', 'main.js'], { cwd: dist, env: full, stdout: Bun.file(log), stderr: Bun.file(`${log}.err`) });
  const base = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health/ready`, { tls: { rejectUnauthorized: false } } as RequestInit);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) throw new Error(`${name} exited: ${await Bun.file(`${log}.err`).text()}`);
    await Bun.sleep(100);
  }
  return {
    base, pid: child.pid, log, env: full,
    async stop() {
      child.kill('SIGTERM');
      await child.exited;
      return Bun.file(log).text();
    },
  };
}

/** Runs a bundled command-line tool (dist/cli/<name>.js) with the given environment. */
export async function cli(dist: string, name: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['bun', join('cli', `${name}.js`), ...args], { cwd: dist, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}
