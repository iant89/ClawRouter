/**
 * Builds ENTERPRISE-UI from the parent repository and packs it into
 * vendor/enterprise-ui-react.tgz, which the console installs as
 * `@enterprise-ui/react`. Only the published files (dist/) end up in the
 * tarball, so the console gets exactly what an npm consumer would.
 *
 *   bun scripts/build-ui.ts [--skip-build]
 */
import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const clawapiRoot = resolve(import.meta.dir, '..');
const uiRoot = process.env.ENTERPRISE_UI_PATH ? resolve(process.env.ENTERPRISE_UI_PATH) : resolve(clawapiRoot, '..');
const vendor = join(clawapiRoot, 'vendor');
const target = join(vendor, 'enterprise-ui-react.tgz');

async function run(cmd: string[], cwd: string) {
  console.log(`$ ${cmd.join(' ')}   (in ${cwd})`);
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited with ${code}`);
}

const pkgPath = join(uiRoot, 'package.json');
if (!existsSync(pkgPath)) throw new Error(`ENTERPRISE-UI not found at ${uiRoot}. Set ENTERPRISE_UI_PATH.`);
const pkg = (await Bun.file(pkgPath).json()) as { name: string; version: string };
if (pkg.name !== '@enterprise-ui/react') throw new Error(`${uiRoot} is not ENTERPRISE-UI (found ${pkg.name}).`);

if (!process.argv.includes('--skip-build')) {
  if (!existsSync(join(uiRoot, 'node_modules'))) await run(['npm', 'ci', '--no-audit', '--no-fund'], uiRoot);
  await run(['npm', 'run', 'build:lib'], uiRoot);
}
mkdirSync(vendor, { recursive: true });
await run(['npm', 'pack', '--silent', '--pack-destination', vendor], uiRoot);
renameSync(join(vendor, `enterprise-ui-react-${pkg.version}.tgz`), target);
console.log(`\nENTERPRISE-UI ${pkg.version} packed to ${target}`);
