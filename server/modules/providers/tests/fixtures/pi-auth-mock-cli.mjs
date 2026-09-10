#!/usr/bin/env node
// Mock of the Pi CLI for auth tests: handles `--version` and
// `auth check --provider <p> --json [--no-refresh]`.
// The `auth check` result is selected by MOCK_AUTH: ready | not_ready.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('0.85.1\n');
  process.exit(0);
}

const authIndex = args.indexOf('auth');
const checkIndex = args.indexOf('check');
if (authIndex >= 0 && checkIndex >= 0) {
  const mode = process.env.MOCK_AUTH || 'ready';
  if (mode === 'ready') {
    process.stdout.write(JSON.stringify({ status: 'ready', provider: 'ark', authType: 'api_key' }));
    process.exit(0);
  }
  process.stderr.write('unknown provider\n');
  process.stdout.write(JSON.stringify({ status: 'not_ready', provider: 'missing', reason: 'provider_not_found' }));
  process.exit(1);
}

process.stderr.write('unknown command\n');
process.exit(2);
