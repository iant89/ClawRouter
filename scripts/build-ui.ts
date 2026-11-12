/**
 * Refreshes the vendored ENTERPRISE-UI package, vendor/enterprise-ui-react.tgz.
 *
 * ENTERPRISE-UI is not on npm yet, so the console depends on a tarball that is
 * committed to this repository: a fresh clone needs only `bun install`. Run this
 * script only when you want a newer ENTERPRISE-UI, from a local checkout of it:
 *
 *   ENTERPRISE_UI_PATH=../ENTERPRISE-UI bun run ui:build [--skip-build]
 *   bun install
 *
 * Only the published files (dist/) go into the tarball, so the console gets
 * exactly what an npm consumer would. Record the ENTERPRISE-UI commit in
 * vendor/README.md and commit the new tarball.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const vendor = join(root, 'vendor');
const target = join(vendor, 'enterprise-ui-react.tgz');

async function run(cmd: string[], cwd: string): Promise<string> {
  console.log(`$ ${cmd.join(' ')}   (in ${cwd})`);
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'inherit' });
  const out = await new Response(proc.stdout).text();
  process.stdout.write(out);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited with ${code}`);
  return out.trim();
}

if (!process.env.ENTERPRISE_UI_PATH) {
  console.error('Set ENTERPRISE_UI_PATH to a local ENTERPRISE-UI checkout, e.g.\n  ENTERPRISE_UI_PATH=../ENTERPRISE-UI bun run ui:build');
  process.exit(1);
}
const uiRoot = resolve(process.env.ENTERPRISE_UI_PATH);
const pkgPath = join(uiRoot, 'package.json');
if (!existsSync(pkgPath)) throw new Error(`ENTERPRISE-UI not found at ${uiRoot}.`);
const pkg = (await Bun.file(pkgPath).json()) as { name: string; version: string };
if (pkg.name !== '@enterprise-ui/react') throw new Error(`${uiRoot} is not ENTERPRISE-UI (found ${pkg.name}).`);

if (!process.argv.includes('--skip-build')) {
  if (!existsSync(join(uiRoot, 'node_modules'))) await run(['npm', 'ci', '--no-audit', '--no-fund'], uiRoot);
  await run(['npm', 'run', 'build:lib'], uiRoot);
}
mkdirSync(vendor, { recursive: true });
await run(['npm', 'pack', '--silent', '--pack-destination', vendor], uiRoot);
renameSync(join(vendor, `enterprise-ui-react-${pkg.version}.tgz`), target);

const commit = await run(['git', 'rev-parse', 'HEAD'], uiRoot).catch(() => 'unknown');
console.log(`\nENTERPRISE-UI ${pkg.version} (${commit}) packed to ${target}`);
console.log('Next: update the commit in vendor/README.md, run `bun install`, and commit the tarball.');
