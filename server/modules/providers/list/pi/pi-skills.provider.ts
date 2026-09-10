import os from 'node:os';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkill, ProviderSkillListOptions, ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
  readProviderSkillMarkdownDefinitionFromContent,
} from '@/shared/utils.js';
import { getPiAgentDir } from '@/modules/providers/list/pi/pi-models.provider.js';

/**
 * Pi invokes a skill as `/skill:name`, which `commandForSkill` spells out
 * because `commandPrefix` only supports the `/` and `$` one-character forms.
 */
const piSkillCommand = (skillName: string): string => `/skill:${skillName}`;

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

/**
 * Direct root-level `.md` files are individual skills only inside Pi's own
 * skill roots (`~/.pi/agent/skills` and `<cwd>/.pi/skills`); the shared
 * scanner only understands directory-style SKILL.md skills, so this provider
 * appends those root files itself.
 */
async function listRootMarkdownSkills(rootDir: string): Promise<ProviderSkill[]> {
  const skills: ProviderSkill[] = [];
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }
    const skillPath = path.join(rootDir, entry.name);
    try {
      const content = await readFile(skillPath, 'utf8');
      const definition = readProviderSkillMarkdownDefinitionFromContent(
        content,
        entry.name.replace(/\.md$/i, ''),
      );
      if (!definition.description.trim()) {
        // Root markdown files must look like skills (valid front matter with a
        // non-empty description); anything else is ignored silently by Pi.
        continue;
      }
      skills.push({
        provider: 'pi',
        name: definition.name,
        description: definition.description,
        command: piSkillCommand(definition.name),
        scope: 'user',
        sourcePath: skillPath,
      });
    } catch {
      // A malformed root file should not hide other valid skills.
    }
  }

  return skills;
}

/** Provider registry skills adapter for Pi. */
export class PiSkillsProvider extends SkillsProvider {
  constructor() {
    super('pi');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    // User roots always load.
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(getPiAgentDir(), 'skills'),
      recursive: true,
      commandForSkill: piSkillCommand,
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      recursive: true,
      commandForSkill: piSkillCommand,
    });

    // Project roots load only once Pi trusts the project; they are listed the
    // same way so a trusted project shows its skills (see the integration
    // plan's project-trust decision note).
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.pi', 'skills'),
      recursive: true,
      commandForSkill: piSkillCommand,
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.agents', 'skills'),
      recursive: true,
      commandForSkill: piSkillCommand,
    });

    // Pi also walks `.agents/skills` from the cwd up to the topmost git root.
    if (repoRoot && repoRoot !== workspacePath) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.agents', 'skills'),
        recursive: true,
        commandForSkill: piSkillCommand,
      });
    }

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getPiAgentDir(), 'skills'),
      commandForSkill: piSkillCommand,
    };
  }

  override async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const skills = await super.listSkills(options);
    const workspacePath = resolveWorkspacePath(options?.workspacePath);

    // Root-level `.md` skills exist only in Pi's own skill roots.
    const piRoots = [
      { rootDir: path.join(getPiAgentDir(), 'skills'), scope: 'user' as const },
      { rootDir: path.join(workspacePath, '.pi', 'skills'), scope: 'repo' as const },
    ];
    const seen = new Set(skills.map((skill) => path.resolve(skill.sourcePath)));
    for (const { rootDir, scope } of piRoots) {
      for (const skill of await listRootMarkdownSkills(rootDir)) {
        if (scope === 'repo') {
          skill.scope = 'repo';
        }
        const resolved = path.resolve(skill.sourcePath);
        if (!seen.has(resolved)) {
          seen.add(resolved);
          skills.push(skill);
        }
      }
    }

    return skills;
  }
}
