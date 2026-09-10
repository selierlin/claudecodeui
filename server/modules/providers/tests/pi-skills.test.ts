import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { PiSkillsProvider } from '@/modules/providers/list/pi/pi-skills.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

let restoreHomeDir: (() => void) | null = null;
let tempRoot: string | null = null;

async function withIsolatedSkills(runTest: (root: string) => Promise<void>): Promise<void> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-skills-test-'));
  process.env.PI_CODING_AGENT_DIR = path.join(root, '.pi', 'agent');
  restoreHomeDir = patchHomeDir(root);
  tempRoot = root;
  try {
    await runTest(root);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    restoreHomeDir();
    restoreHomeDir = null;
    await rm(root, { recursive: true, force: true });
    tempRoot = null;
  }
}

afterEach(() => {
  if (restoreHomeDir) {
    restoreHomeDir();
    restoreHomeDir = null;
  }
  if (tempRoot) {
    void rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

const skillMd = (name: string, description: string): string => (
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo a thing.\n`
);

test('discovers SKILL.md skills in the user pi skills root and ~/.agents/skills', async () => {
  await withIsolatedSkills(async (root) => {
    await mkdir(path.join(root, '.pi', 'agent', 'skills', 'alpha'), { recursive: true });
    await writeFile(path.join(root, '.pi', 'agent', 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha skill'));
    await mkdir(path.join(root, '.agents', 'skills', 'beta'), { recursive: true });
    await writeFile(path.join(root, '.agents', 'skills', 'beta', 'SKILL.md'), skillMd('beta', 'Beta skill'));

    const skills = await new PiSkillsProvider().listSkills({ workspacePath: root });
    const commands = skills.map((skill) => skill.command).sort();
    assert.deepEqual(commands, ['/skill:alpha', '/skill:beta']);
  });
});

test('treats root-level .md files as skills only in the pi agent skills root', async () => {
  await withIsolatedSkills(async (root) => {
    await mkdir(path.join(root, '.pi', 'agent', 'skills'), { recursive: true });
    await writeFile(path.join(root, '.pi', 'agent', 'skills', 'notes.md'), skillMd('notes', 'Root notes skill'));
    // Root-level .md under ~/.agents/skills is ignored by Pi.
    await mkdir(path.join(root, '.agents', 'skills'), { recursive: true });
    await writeFile(path.join(root, '.agents', 'skills', 'ignored.md'), skillMd('ignored', 'Should not load'));

    const skills = await new PiSkillsProvider().listSkills({ workspacePath: root });
    assert.deepEqual(skills.map((skill) => skill.command), ['/skill:notes']);
  });
});

test('discovers project .pi/skills and .agents/skills under the workspace', async () => {
  await withIsolatedSkills(async (root) => {
    const workspace = path.join(root, 'workspace', 'proj');
    await mkdir(path.join(workspace, '.pi', 'skills', 'proj-skill'), { recursive: true });
    await writeFile(path.join(workspace, '.pi', 'skills', 'proj-skill', 'SKILL.md'), skillMd('proj-skill', 'Project skill'));
    await mkdir(path.join(workspace, '.agents', 'skills', 'agent-skill'), { recursive: true });
    await writeFile(path.join(workspace, '.agents', 'skills', 'agent-skill', 'SKILL.md'), skillMd('agent-skill', 'Agents skill'));

    const skills = await new PiSkillsProvider().listSkills({ workspacePath: workspace });
    assert.ok(skills.some((skill) => skill.command === '/skill:proj-skill'));
    assert.ok(skills.some((skill) => skill.command === '/skill:agent-skill'));
  });
});

test('command prefix follows the /skill:name syntax', async () => {
  await withIsolatedSkills(async (root) => {
    await mkdir(path.join(root, '.pi', 'agent', 'skills', 'alpha'), { recursive: true });
    await writeFile(path.join(root, '.pi', 'agent', 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha skill'));

    const skills = await new PiSkillsProvider().listSkills({ workspacePath: root });
    assert.equal(skills[0].command, '/skill:alpha');
  });
});
