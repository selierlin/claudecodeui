import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { projectsDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { AppError } from '@/shared/utils.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
};

/**
 * WorkBuddy resolves its config root from CODEBUDDY_CONFIG_DIR /
 * WORKBUDDY_CONFIG_DIR before falling back to the patched home directory, so
 * tests must clear those overrides to stay isolated from the host environment.
 */
const patchWorkbuddyEnv = () => {
  const savedValues = ['CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR'].map((key) => [key, process.env[key]] as const);
  for (const [key] of savedValues) {
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of savedValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
};

/**
 * This test covers Claude MCP support for all scopes (user/local/project) and all transports (stdio/http/sse),
 * including add, update/list, and remove operations.
 */
test('providerMcpService handles claude MCP scopes/transports with file-backed persistence', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'my-server'],
      env: { API_KEY: 'secret' },
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-API-Key': 'abc' },
      workspacePath,
    });

    const grouped = await providerMcpService.listProviderMcpServers('claude', { workspacePath });
    const claudeUser = grouped.user.find((server) => server.name === 'claude-user-stdio');
    const claudeLocal = grouped.local.find((server) => server.name === 'claude-local-http');
    const claudeProject = grouped.project.find((server) => server.name === 'claude-project-sse');
    assert.equal(claudeUser?.transport, 'stdio');
    assert.equal(claudeUser?.env?.API_KEY, '<redacted>');
    assert.equal(claudeLocal?.transport, 'http');
    assert.equal(claudeLocal?.headers?.Authorization, '<redacted>');
    assert.equal(claudeProject?.transport, 'sse');
    assert.equal(claudeProject?.headers?.['X-API-Key'], '<redacted>');

    // update behavior is the same upsert route with same name
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse-updated',
      headers: { 'X-API-Key': 'updated' },
      workspacePath,
    });

    const projectConfig = await readJson(path.join(workspacePath, '.mcp.json'));
    const projectServers = projectConfig.mcpServers as Record<string, unknown>;
    const projectServer = projectServers['claude-project-sse'] as Record<string, unknown>;
    assert.equal(projectServer.url, 'https://example.com/sse-updated');

    const removeResult = await providerMcpService.removeProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      workspacePath,
    });
    assert.equal(removeResult.removed, true);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Codex MCP support for user/project scopes, stdio/http formats,
 * and validation for unsupported scope/transport combinations.
 */
test('providerMcpService handles codex MCP TOML config and capability validation', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-codex-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'python',
      args: ['server.py'],
      env: { API_KEY: 'x' },
      envVars: ['API_KEY'],
      cwd: '/tmp',
    });

    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://codex.example.com/mcp',
      headers: { 'X-Custom-Header': 'value' },
      envHttpHeaders: { 'X-API-Key': 'MY_API_KEY_ENV' },
      bearerTokenEnvVar: 'MY_API_TOKEN',
      workspacePath,
    });

    const userTomlPath = path.join(tempRoot, '.codex', 'config.toml');
    const userConfig = TOML.parse(await fs.readFile(userTomlPath, 'utf8')) as Record<string, unknown>;
    const userServers = userConfig.mcp_servers as Record<string, unknown>;
    const userStdio = userServers['codex-user-stdio'] as Record<string, unknown>;
    assert.equal(userStdio.command, 'python');

    const projectTomlPath = path.join(workspacePath, '.codex', 'config.toml');
    const projectConfig = TOML.parse(await fs.readFile(projectTomlPath, 'utf8')) as Record<string, unknown>;
    const projectServers = projectConfig.mcp_servers as Record<string, unknown>;
    const projectHttp = projectServers['codex-project-http'] as Record<string, unknown>;
    assert.equal(projectHttp.url, 'https://codex.example.com/mcp');

    const grouped = await providerMcpService.listProviderMcpServers('codex', { workspacePath });
    const codexUser = grouped.user.find((server) => server.name === 'codex-user-stdio');
    const codexProject = grouped.project.find((server) => server.name === 'codex-project-http');
    assert.equal(codexUser?.env?.API_KEY, '<redacted>');
    assert.equal(codexProject?.headers?.['X-Custom-Header'], '<redacted>');
    assert.equal(codexProject?.envHttpHeaders?.['X-API-Key'], '<redacted>');

    // The edit form submits the redacted list response unchanged for secrets
    // while users edit unrelated fields. Those sentinel values must never
    // replace the persisted credentials.
    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'python3',
      args: ['server.py'],
      env: { API_KEY: '<redacted>' },
      envVars: ['API_KEY'],
      cwd: '/tmp',
    });
    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://codex.example.com/updated-mcp',
      headers: { 'X-Custom-Header': '<redacted>' },
      envHttpHeaders: { 'X-API-Key': '<redacted>' },
      bearerTokenEnvVar: 'MY_API_TOKEN',
      workspacePath,
    });

    const updatedUserConfig = TOML.parse(await fs.readFile(userTomlPath, 'utf8')) as Record<string, unknown>;
    const updatedUserServer = (updatedUserConfig.mcp_servers as Record<string, Record<string, unknown>>)['codex-user-stdio'];
    assert.equal((updatedUserServer?.env as Record<string, string>).API_KEY, 'x');
    const updatedProjectConfig = TOML.parse(await fs.readFile(projectTomlPath, 'utf8')) as Record<string, unknown>;
    const updatedProjectServer = (updatedProjectConfig.mcp_servers as Record<string, Record<string, unknown>>)['codex-project-http'];
    assert.equal((updatedProjectServer?.http_headers as Record<string, string>)['X-Custom-Header'], 'value');
    assert.equal((updatedProjectServer?.env_http_headers as Record<string, string>)['X-API-Key'], 'MY_API_KEY_ENV');

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers OpenCode MCP support for user/project config files, JSONC-compatible
 * reads, and validation for unsupported scope/transport combinations.
 */
test('providerMcpService handles opencode MCP config and capability validation', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-opencode-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(tempRoot, '.config', 'opencode'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, '.config', 'opencode', 'opencode.jsonc'),
    `{
      // Existing comments should not block OpenCode MCP reads.
      "mcp": {}
    }\n`,
    'utf8',
  );

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'opencode-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'x' },
    });

    await providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'opencode-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://opencode.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    const userConfig = await readJson(path.join(tempRoot, '.config', 'opencode', 'opencode.jsonc'));
    const userServers = userConfig.mcp as Record<string, unknown>;
    const userStdio = userServers['opencode-user-stdio'] as Record<string, unknown>;
    assert.equal(userStdio.type, 'local');
    assert.deepEqual(userStdio.command, ['node', 'server.js']);
    assert.deepEqual(userStdio.environment, { API_KEY: 'x' });

    const projectConfig = await readJson(path.join(workspacePath, 'opencode.json'));
    const projectServers = projectConfig.mcp as Record<string, unknown>;
    const projectHttp = projectServers['opencode-project-http'] as Record<string, unknown>;
    assert.equal(projectHttp.type, 'remote');
    assert.equal(projectHttp.url, 'https://opencode.example.com/mcp');

    const grouped = await providerMcpService.listProviderMcpServers('opencode', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'opencode-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.project.some((server) => server.name === 'opencode-project-http' && server.transport === 'http'));

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('opencode', {
        name: 'opencode-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('opencode', {
        name: 'opencode-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Cursor MCP JSON format and user/project scope persistence.
 */
test('providerMcpService handles cursor MCP JSON config formats', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-gc-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-stdio',
      scope: 'project',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server'],
      env: { API_KEY: 'value' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-http',
      scope: 'user',
      transport: 'http',
      url: 'http://localhost:3333/mcp',
      headers: { API_KEY: 'value' },
    });

    const cursorUserConfig = await readJson(path.join(tempRoot, '.cursor', 'mcp.json'));
    const cursorHttpServer = (cursorUserConfig.mcpServers as Record<string, unknown>)['cursor-http'] as Record<string, unknown>;
    assert.equal(cursorHttpServer.url, 'http://localhost:3333/mcp');
    assert.equal(cursorHttpServer.type, undefined);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers the global MCP adder requirement: only http/stdio are allowed and
 * one payload is written to all providers.
 */
test('providerMcpService global adder writes to all providers and rejects unsupported transports', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-global-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const registeredProject = projectsDb.createProjectPath(workspacePath).project;

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const globalResult = await providerMcpService.addMcpServerToAllProviders({
      name: 'global-http',
      scope: 'project',
      transport: 'http',
      url: 'https://global.example.com/mcp',
      workspacePath,
    });

    assert.equal(globalResult.length, 7);
    // DSH remains externally managed and Pi has no native MCP support;
    // WorkBuddy persists its native MCP config and therefore participates in
    // the global add operation.
    const dshEntry = globalResult.find((entry) => entry.provider === 'dsh');
    assert.equal(dshEntry?.created, false);
    const piEntry = globalResult.find((entry) => entry.provider === 'pi');
    assert.equal(piEntry?.created, false);
    assert.ok(
      globalResult
        .filter((entry) => entry.provider !== 'dsh' && entry.provider !== 'pi')
        .every((entry) => entry.created === true),
    );

    const claudeProject = await readJson(path.join(workspacePath, '.mcp.json'));
    assert.ok((claudeProject.mcpServers as Record<string, unknown>)['global-http']);

    const codexProject = TOML.parse(await fs.readFile(path.join(workspacePath, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    assert.ok((codexProject.mcp_servers as Record<string, unknown>)['global-http']);

    const opencodeProject = await readJson(path.join(workspacePath, 'opencode.json'));
    assert.ok((opencodeProject.mcp as Record<string, unknown>)['global-http']);

    const cursorProject = await readJson(path.join(workspacePath, '.cursor', 'mcp.json'));
    assert.ok((cursorProject.mcpServers as Record<string, unknown>)['global-http']);

    const workbuddyProject = await readJson(path.join(workspacePath, '.mcp.json'));
    assert.equal(((workbuddyProject.mcpServers as Record<string, unknown>)['global-http'] as Record<string, unknown> | undefined)?.type, 'http');

    await assert.rejects(
      providerMcpService.addMcpServerToAllProviders({
        name: 'global-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_GLOBAL_MCP_TRANSPORT' &&
        error.statusCode === 400,
    );
  } finally {
    if (registeredProject) {
      projectsDb.deleteProjectById(registeredProject.project_id);
    }
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService persists and reads WorkBuddy user, project, and local scopes', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const registeredProject = projectsDb.createProjectPath(workspacePath).project;
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreWorkbuddyEnv = patchWorkbuddyEnv();

  try {
    const userServer = await providerMcpService.upsertProviderMcpServer('workbuddy', {
      name: 'user-server', scope: 'user', transport: 'stdio', command: 'node', args: ['user'],
      env: { API_KEY: 'workbuddy-secret' },
    });
    assert.equal(userServer.env?.API_KEY, '<redacted>');
    await providerMcpService.upsertProviderMcpServer('workbuddy', {
      name: 'project-server', scope: 'project', transport: 'sse', url: 'https://example.test/sse', workspacePath,
    });
    await providerMcpService.upsertProviderMcpServer('workbuddy', {
      name: 'local-server', scope: 'local', transport: 'http', url: 'https://example.test/mcp',
      workspacePath,
    });

    const grouped = await providerMcpService.listProviderMcpServers('workbuddy', { workspacePath });
    assert.equal(grouped.user[0]?.name, 'user-server');
    assert.equal(grouped.user[0]?.env?.API_KEY, '<redacted>');
    assert.equal(grouped.project[0]?.transport, 'sse');
    assert.equal(grouped.local[0]?.name, 'local-server');

    const removed = await providerMcpService.removeProviderMcpServer('workbuddy', {
      name: 'local-server', scope: 'local', workspacePath,
    });
    assert.equal(removed.removed, true);

    await providerMcpService.upsertProviderMcpServer('workbuddy', {
      name: 'user-server', scope: 'user', transport: 'stdio', command: 'node', args: ['updated'],
      env: { API_KEY: '<redacted>' },
    });
    const userConfig = await readJson(path.join(tempRoot, '.workbuddy', '.mcp.json'));
    assert.equal(
      (((userConfig.mcpServers as Record<string, unknown>)['user-server'] as Record<string, unknown>).env as Record<string, string>).API_KEY,
      'workbuddy-secret',
    );
  } finally {
    if (registeredProject) {
      projectsDb.deleteProjectById(registeredProject.project_id);
    }
    restoreWorkbuddyEnv();
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService serializes concurrent WorkBuddy writes within one scope', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-concurrent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const registeredProject = projectsDb.createProjectPath(workspacePath).project;
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreWorkbuddyEnv = patchWorkbuddyEnv();

  try {
    await Promise.all([
      providerMcpService.upsertProviderMcpServer('workbuddy', {
        name: 'first-server', scope: 'project', transport: 'stdio', command: 'node', workspacePath,
      }),
      providerMcpService.upsertProviderMcpServer('workbuddy', {
        name: 'second-server', scope: 'project', transport: 'stdio', command: 'node', workspacePath,
      }),
    ]);

    const grouped = await providerMcpService.listProviderMcpServers('workbuddy', { workspacePath });
    assert.deepEqual(
      grouped.project.map((server) => server.name).sort(),
      ['first-server', 'second-server'],
    );
  } finally {
    if (registeredProject) {
      projectsDb.deleteProjectById(registeredProject.project_id);
    }
    restoreWorkbuddyEnv();
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService restricts existing WorkBuddy MCP config permissions', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-permissions-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const configPath = path.join(workspacePath, '.mcp.json');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
  await fs.chmod(configPath, 0o644);
  const registeredProject = projectsDb.createProjectPath(workspacePath).project;

  try {
    await providerMcpService.upsertProviderMcpServer('workbuddy', {
      name: 'private-server',
      scope: 'project',
      transport: 'stdio',
      command: 'node',
      env: { API_KEY: 'secret' },
      workspacePath,
    });

    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  } finally {
    if (registeredProject) {
      projectsDb.deleteProjectById(registeredProject.project_id);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService rejects unregistered WorkBuddy project paths', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-unregistered-'));
  const workspacePath = path.join(tempRoot, 'outside-project');
  await fs.mkdir(workspacePath, { recursive: true });
  try {
    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('workbuddy', {
        name: 'outside-server',
        scope: 'project',
        transport: 'stdio',
        command: 'echo',
        workspacePath,
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'MCP_WORKSPACE_NOT_REGISTERED'
        && error.statusCode === 403,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService rejects a WorkBuddy project MCP symlink during read and write', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-symlink-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const outsideConfigPath = path.join(tempRoot, 'outside-mcp.json');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(outsideConfigPath, JSON.stringify({ mcpServers: { outside: { command: 'touch' } } }), 'utf8');
  await fs.symlink(outsideConfigPath, path.join(workspacePath, '.mcp.json'));
  const registeredProject = projectsDb.createProjectPath(workspacePath).project;
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreWorkbuddyEnv = patchWorkbuddyEnv();

  try {
    for (const operation of [
      () => providerMcpService.listProviderMcpServersForScope('workbuddy', 'project', { workspacePath }),
      () => providerMcpService.upsertProviderMcpServer('workbuddy', {
        name: 'blocked-server', scope: 'project', transport: 'stdio', command: 'echo', workspacePath,
      }),
    ]) {
      await assert.rejects(operation, (error: unknown) => error instanceof AppError
        && error.code === 'MCP_CONFIG_SYMLINK_NOT_ALLOWED'
        && error.statusCode === 400);
    }
    const outsideConfig = await readJson(outsideConfigPath);
    assert.deepEqual(outsideConfig, { mcpServers: { outside: { command: 'touch' } } });
  } finally {
    if (registeredProject) {
      projectsDb.deleteProjectById(registeredProject.project_id);
    }
    restoreWorkbuddyEnv();
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService rejects a registered WorkBuddy workspace reached through a parent symlink', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-parent-link-'));
  const realParentPath = path.join(tempRoot, 'real-parent');
  const linkedParentPath = path.join(tempRoot, 'linked-parent');
  const workspacePath = path.join(linkedParentPath, 'workspace');
  await fs.mkdir(path.join(realParentPath, 'workspace'), { recursive: true });
  await fs.symlink(realParentPath, linkedParentPath, 'dir');
  const registeredProject = projectsDb.createProjectPath(workspacePath).project;
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreWorkbuddyEnv = patchWorkbuddyEnv();

  try {
    await assert.rejects(
      providerMcpService.listProviderMcpServersForScope('workbuddy', 'project', { workspacePath }),
      (error: unknown) => error instanceof AppError
        && error.code === 'MCP_WORKSPACE_SYMLINK_NOT_ALLOWED'
        && error.statusCode === 400,
    );
  } finally {
    if (registeredProject) {
      projectsDb.deleteProjectById(registeredProject.project_id);
    }
    restoreWorkbuddyEnv();
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService rejects a WorkBuddy user config directory symlink', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-config-link-'));
  const realConfigDir = path.join(tempRoot, 'real-config');
  const linkedConfigDir = path.join(tempRoot, 'linked-config');
  await fs.mkdir(realConfigDir, { recursive: true });
  await fs.symlink(realConfigDir, linkedConfigDir, 'dir');
  const restoreWorkbuddyEnv = patchWorkbuddyEnv();
  process.env.WORKBUDDY_CONFIG_DIR = linkedConfigDir;

  try {
    await assert.rejects(
      providerMcpService.listProviderMcpServersForScope('workbuddy', 'user'),
      (error: unknown) => error instanceof AppError
        && error.code === 'MCP_CONFIG_DIRECTORY_SYMLINK_NOT_ALLOWED'
        && error.statusCode === 400,
    );
    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('workbuddy', {
        name: 'blocked-user-server', scope: 'user', transport: 'stdio', command: 'echo',
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'MCP_CONFIG_DIRECTORY_SYMLINK_NOT_ALLOWED'
        && error.statusCode === 400,
    );
    assert.deepEqual(await fs.readdir(realConfigDir), []);
  } finally {
    restoreWorkbuddyEnv();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService merges WorkBuddy user scope across .mcp.json and mcp.json', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-workbuddy-dual-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const workbuddyConfigDir = path.join(tempRoot, '.workbuddy');
  await fs.mkdir(workbuddyConfigDir, { recursive: true });
  const registeredProject = projectsDb.createProjectPath(workspacePath).project;
  await fs.writeFile(
    path.join(workbuddyConfigDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'desktop-server': { type: 'stdio', command: 'node', args: ['desktop'] },
      },
    }),
    'utf8',
  );

  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreWorkbuddyEnv = patchWorkbuddyEnv();
  try {
    // New servers land in .mcp.json so the CLI resolves them at runtime.
    await providerMcpService.upsertProviderMcpServer('workbuddy', {
      name: 'cli-server', scope: 'user', transport: 'http', url: 'https://example.test/mcp',
    });

    const dotConfig = await readJson(path.join(workbuddyConfigDir, '.mcp.json'));
    assert.ok((dotConfig.mcpServers as Record<string, unknown>)['cli-server']);
    const plainConfig = await readJson(path.join(workbuddyConfigDir, 'mcp.json'));
    assert.ok((plainConfig.mcpServers as Record<string, unknown>)['desktop-server']);
    assert.equal(Object.hasOwn(plainConfig.mcpServers as Record<string, unknown>, 'cli-server'), false);

    // The merged list exposes servers from both files.
    const grouped = await providerMcpService.listProviderMcpServers('workbuddy', { workspacePath });
    const userNames = grouped.user.map((entry) => entry.name).sort();
    assert.deepEqual(userNames, ['cli-server', 'desktop-server']);

    // Editing a desktop-managed server keeps it in mcp.json.
    await providerMcpService.upsertProviderMcpServer('workbuddy', {
      name: 'desktop-server', scope: 'user', transport: 'stdio', command: 'node', args: ['desktop-v2'],
    });
    const updatedPlain = await readJson(path.join(workbuddyConfigDir, 'mcp.json'));
    assert.deepEqual(
      ((updatedPlain.mcpServers as Record<string, unknown>)['desktop-server'] as Record<string, unknown>)?.args,
      ['desktop-v2'],
    );
    const updatedDot = await readJson(path.join(workbuddyConfigDir, '.mcp.json'));
    assert.equal(Object.hasOwn(updatedDot.mcpServers as Record<string, unknown>, 'desktop-server'), false);

    // Removing a server deletes it from the file that contained it.
    await providerMcpService.removeProviderMcpServer('workbuddy', {
      name: 'cli-server', scope: 'user',
    });
    const dotAfterRemove = await readJson(path.join(workbuddyConfigDir, '.mcp.json'));
    assert.equal((dotAfterRemove.mcpServers as Record<string, unknown>)['cli-server'], undefined);
    const plainAfterRemove = await readJson(path.join(workbuddyConfigDir, 'mcp.json'));
    assert.ok((plainAfterRemove.mcpServers as Record<string, unknown>)['desktop-server']);
  } finally {
    if (registeredProject) {
      projectsDb.deleteProjectById(registeredProject.project_id);
    }
    restoreWorkbuddyEnv();
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
