/**
 * Fails when something shaped like a real credential is committed (spec §37,
 * secret scanning). Runs in CI over tracked files; `--history` also searches
 * every commit.
 *
 *   bun run scan-secrets            tracked files
 *   bun run scan-secrets --history  all commits too
 *
 * Test fixtures are allowed only when obviously fake (they contain "canary",
 * "example", "fake", "dummy" or a run of 0123456789 in the same line).
 */
const PATTERNS: [string, RegExp][] = [
  ['OpenAI / Anthropic key', /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['ClawRouter API key', /crk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const FAKE = /canary|example|fake|dummy|0123456789|1234567890|wrong|deadbeef/i;
const FORBIDDEN_FILES = /(^|\/)(\.env|\.env\.local|secret\.key|setup-token)$|\.(pem|db|sqlite)$/;

const run = (args: string[]) => {
  const p = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return p.stdout.toString();
};

const findings: string[] = [];
for (const file of run(['ls-files']).split('\n').filter(Boolean)) {
  if (FORBIDDEN_FILES.test(file)) findings.push(`${file}: this kind of file must never be committed`);
}

// git uses POSIX extended regular expressions: no (?:...) groups.
const pattern = PATTERNS.map(([, re]) => re.source.replaceAll('(?:', '(')).join('|');
const grep = process.argv.includes('--history')
  ? run(['log', '--all', '-p', '--no-color', '-G', pattern, '--pretty=format:commit %h']).split('\n').filter((l) => l.startsWith('+') || l.startsWith('commit '))
  : run(['grep', '-nIE', pattern, '--', '.', ':!*.png', ':!bun.lock']).split('\n').filter(Boolean);

let where = '';
for (const line of grep) {
  if (line.startsWith('commit ')) {
    where = line.slice(7);
    continue;
  }
  for (const [name, re] of PATTERNS) {
    const match = re.exec(line)?.[0];
    // Judge the content only: a real key in a file called *.test.ts is still a leak.
    const content = where ? line : line.split(':').slice(2).join(':');
    if (match && !FAKE.test(content)) findings.push(`${where ? `${where}: ` : ''}${line.split(':').slice(0, 2).join(':')}: possible ${name} (${match.slice(0, 8)}…)`);
  }
}

if (findings.length) {
  console.error(`Possible secrets found:\n${[...new Set(findings)].map((f) => `  ${f}`).join('\n')}`);
  console.error('Remove them (and rotate the credential if it was real). Fake fixtures must look fake.');
  process.exit(1);
}
console.log('No secrets found.');
