import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH ??= path.join(os.homedir(), '.cloudcli', 'auth.db');

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { ClaudeSessionSynchronizer } = await import(
  '@/modules/providers/list/claude/claude-session-synchronizer.provider.js'
);

const apply = process.argv.includes('--apply');

try {
  await initializeDatabase();
  const results = await new ClaudeSessionSynchronizer().backfillLegacyNameSources({ apply });
  const actionable = results.filter((result) => result.action === 'updated' || result.action === 'source_only');
  const skipped = results.filter((result) => result.action.startsWith('skipped'));

  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Legacy Claude sessions scanned: ${results.length}`);
  console.log(`Would update / updated: ${actionable.length}`);
  console.log(`Skipped: ${skipped.length}\n`);

  for (const result of actionable) {
    const change = result.action === 'updated'
      ? `rename -> ${result.nextName}`
      : `source only -> ${result.source}`;
    console.log(`[${result.action}] ${result.sessionId} ${change}`);
  }
  for (const result of skipped) {
    console.log(`[${result.action}] ${result.sessionId} ${result.previousName ?? '(empty)'}`);
  }
} finally {
  closeConnection();
}
