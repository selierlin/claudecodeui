import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_PREDEFINED_MODELS,
  applyClaudeModelMappings,
  extractClaudeEventModel,
  pickClaudeModelMappings,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

const findOption = (value: string) => {
  const option = CLAUDE_PREDEFINED_MODELS.OPTIONS.find((candidate) => candidate.value === value);
  assert.ok(option, `predefined option ${value} must exist`);
  return option;
};

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('leaves the catalog untouched when no alias is mapped', () => {
  const annotated = applyClaudeModelMappings(CLAUDE_PREDEFINED_MODELS, {});

  assert.deepEqual(annotated, CLAUDE_PREDEFINED_MODELS);
});

test('rewrites the label of an alias and its [1m] variant without touching value or effort', () => {
  const annotated = applyClaudeModelMappings(
    CLAUDE_PREDEFINED_MODELS,
    { sonnet: 'doubao-seed-2.1-turbo' },
  );

  const sonnet = annotated.OPTIONS.find((option) => option.value === 'sonnet');
  assert.ok(sonnet);
  assert.equal(sonnet.label, 'Sonnet → doubao-seed-2.1-turbo');
  assert.match(sonnet.description ?? '', /Mapped via ANTHROPIC_DEFAULT_SONNET_MODEL\.$/);
  assert.equal(sonnet.value, findOption('sonnet').value);
  assert.deepEqual(sonnet.effort, findOption('sonnet').effort);

  const sonnet1m = annotated.OPTIONS.find((option) => option.value === 'sonnet[1m]');
  assert.ok(sonnet1m);
  assert.equal(sonnet1m.label, 'Sonnet (1M context) → doubao-seed-2.1-turbo');

  // Unmapped aliases keep their predefined display strings.
  const haiku = annotated.OPTIONS.find((option) => option.value === 'haiku');
  assert.ok(haiku);
  assert.equal(haiku.label, findOption('haiku').label);
  assert.equal(annotated.DEFAULT, CLAUDE_PREDEFINED_MODELS.DEFAULT);
});

test('annotates the default option when ANTHROPIC_MODEL is mapped', () => {
  const annotated = applyClaudeModelMappings(
    CLAUDE_PREDEFINED_MODELS,
    { default: 'doubao-seed-evolving' },
  );

  const fallback = annotated.OPTIONS.find((option) => option.value === 'default');
  assert.ok(fallback);
  assert.equal(fallback.label, 'Default → doubao-seed-evolving');
  assert.match(fallback.description ?? '', /Mapped via ANTHROPIC_MODEL\.$/);
});

test('opusplan lists both mapped targets, and only the mapped one when partial', () => {
  const both = applyClaudeModelMappings(
    CLAUDE_PREDEFINED_MODELS,
    { opus: 'doubao-seed-evolving', sonnet: 'doubao-seed-2.1-turbo' },
  );
  const opusPlanBoth = both.OPTIONS.find((option) => option.value === 'opusplan');
  assert.ok(opusPlanBoth);
  assert.equal(opusPlanBoth.label, 'Opus Plan → doubao-seed-evolving / doubao-seed-2.1-turbo');
  assert.match(opusPlanBoth.description ?? '', /ANTHROPIC_DEFAULT_OPUS_MODEL \+ ANTHROPIC_DEFAULT_SONNET_MODEL/);

  const sonnetOnly = applyClaudeModelMappings(
    CLAUDE_PREDEFINED_MODELS,
    { sonnet: 'doubao-seed-2.1-turbo' },
  );
  const opusPlanSonnet = sonnetOnly.OPTIONS.find((option) => option.value === 'opusplan');
  assert.ok(opusPlanSonnet);
  assert.equal(opusPlanSonnet.label, 'Opus Plan → doubao-seed-2.1-turbo');
  assert.match(opusPlanSonnet.description ?? '', /ANTHROPIC_DEFAULT_SONNET_MODEL\.$/);
  assert.doesNotMatch(opusPlanSonnet.description ?? '', /ANTHROPIC_DEFAULT_OPUS_MODEL/);
});

test('the predefined catalog itself stays immutable', () => {
  applyClaudeModelMappings(
    CLAUDE_PREDEFINED_MODELS,
    { opus: 'doubao-seed-evolving', sonnet: 'doubao-seed-2.1-turbo', haiku: 'doubao-seed-2.0-lite' },
  );

  assert.equal(
    findOption('opus').label,
    'Opus',
  );
  assert.equal(
    findOption('sonnet').label,
    'Sonnet',
  );
});

test('pickClaudeModelMappings lets earlier sources win per alias', () => {
  const processEnv = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-process-env' };
  const activeFileEnv = {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-settings-file',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'doubao-seed-evolving',
  };
  const userSettingsEnv = {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-user-settings',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'from-user-settings',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2.0-lite',
  };

  const mappings = pickClaudeModelMappings(processEnv, activeFileEnv, userSettingsEnv);

  assert.deepEqual(mappings, {
    sonnet: 'from-process-env',
    opus: 'doubao-seed-evolving',
    haiku: 'doubao-seed-2.0-lite',
  });
});

test('pickClaudeModelMappings ignores blank, non-string, and unmapped values', () => {
  const mappings = pickClaudeModelMappings({
    ANTHROPIC_MODEL: '   ',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 42,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2.0-lite',
  });

  assert.deepEqual(mappings, { haiku: 'doubao-seed-2.0-lite' });
  assert.deepEqual(pickClaudeModelMappings({}), {});
});
