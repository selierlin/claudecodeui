import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { getPiAgentDir } from '@/modules/providers/list/pi/pi-models.provider.js';

// Status polling must not shell out (or block the event loop) on every call:
// the command resolution and probes are each cached briefly.
const RESOLUTION_TTL_MS = 30_000;
const VERSION_PROBE_TTL_MS = 30_000;
const VERSION_PROBE_TIMEOUT_MS = 2_000;
const AUTH_PROBE_TTL_MS = 30_000;
const AUTH_PROBE_TIMEOUT_MS = 5_000;

type CommandResolution = { command: string | null; source: 'override' | 'path' | 'missing' };

let resolution: { value: CommandResolution; resolvedAt: number } | null = null;
let versionProbe: { ok: boolean; checkedAt: number } | null = null;
let authProbe: { status: 'ready' | 'unauthenticated' | 'unknown'; checkedAt: number } | null = null;

/**
 * Resolves the `pi` executable: an explicit `PI_COMMAND` env override, then
 * PATH. Returns `command: null` when neither yields an executable — callers
 * must treat that as "not installed" instead of guessing at a bare command
 * name.
 */
function resolveCommand(): CommandResolution {
  if (resolution && Date.now() - resolution.resolvedAt < RESOLUTION_TTL_MS) {
    return resolution.value;
  }

  const next = resolveCommandUncached();
  resolution = { value: next, resolvedAt: Date.now() };
  return next;
}

function resolveCommandUncached(): CommandResolution {
  const override = process.env.PI_COMMAND?.trim();
  if (override) {
    return { command: override, source: 'override' };
  }

  try {
    // Use the absolute path from `which` so callers (PTY spawn, runtime spawn)
    // don't need `pi` to be on their own PATH — the backend process's PATH is
    // sufficient for resolution.
    const resolved = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
    if (resolved) {
      return { command: resolved, source: 'path' };
    }
  } catch {
    // Fall through to missing.
  }

  return { command: null, source: 'missing' };
}

/**
 * Returns the command the Pi runtime should spawn. When nothing is installed
 * the bare `pi` name is returned so the spawn surfaces a normal ENOENT
 * failure that the runtime already reports; auth status reads
 * `resolveCommand()` directly and never sees this fallback.
 */
export const getPiCommand = (): string => {
  return resolveCommand().command ?? 'pi';
};

/** Drops the cached resolution and probes (used by tests to force re-resolution). */
export function resetPiCommandForTests(): void {
  resolution = null;
  versionProbe = null;
  authProbe = null;
}

/**
 * Asynchronously verifies the resolved CLI actually runs. Non-blocking (a
 * synchronous probe would freeze the Node event loop for the timeout window on
 * every status query) and cached so the settings UI can poll freely.
 */
async function checkVersion(command: string): Promise<boolean> {
  if (versionProbe && Date.now() - versionProbe.checkedAt < VERSION_PROBE_TTL_MS) {
    return versionProbe.ok;
  }
  const ok = await new Promise<boolean>((resolve) => {
    execFile(command, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS }, (error) => {
      resolve(!error);
    });
  });
  versionProbe = { ok, checkedAt: Date.now() };
  return ok;
}

/** The provider `pi auth check` should probe — the configured default provider. */
function getDefaultAuthProvider(): string | null {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(getPiAgentDir(), 'settings.json'), 'utf8'),
    ) as { defaultProvider?: unknown };
    return typeof settings.defaultProvider === 'string' && settings.defaultProvider.trim()
      ? settings.defaultProvider.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Probes login state with `pi auth check --provider <p> --json`. "Not
 * authenticated" is data, not an exception: both the ready and the failed
 * shapes are cached so the settings UI can poll freely.
 */
async function checkAuthenticated(command: string): Promise<'ready' | 'unauthenticated' | 'unknown'> {
  if (authProbe && Date.now() - authProbe.checkedAt < AUTH_PROBE_TTL_MS) {
    return authProbe.status;
  }

  const provider = getDefaultAuthProvider();
  if (!provider) {
    // No configured default provider means `pi auth check` has nothing to
    // probe; fall back to the credentials document's presence.
    const status = fs.existsSync(path.join(getPiAgentDir(), 'auth.json'))
      ? 'ready'
      : 'unauthenticated';
    authProbe = { status, checkedAt: Date.now() };
    return status;
  }

  const status = await new Promise<'ready' | 'unauthenticated' | 'unknown'>((resolve) => {
    execFile(
      command,
      ['auth', 'check', '--provider', provider, '--json', '--no-refresh'],
      { timeout: AUTH_PROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error && !stdout) {
          // A failed probe (CLI error, timeout) says nothing about the
          // credentials — keep the login state unknown rather than claiming
          // the user is logged out.
          resolve('unknown');
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { status?: unknown };
          resolve(parsed.status === 'ready' ? 'ready' : 'unauthenticated');
        } catch {
          resolve('unknown');
        }
      },
    );
  });

  authProbe = { status, checkedAt: Date.now() };
  return status;
}

/** Provider registry auth adapter for the Pi CLI. */
export class PiProviderAuth implements IProviderAuth {
  /**
   * Pi owns login state in `~/.pi/agent/auth.json` (per-provider API keys and
   * OAuth entries). A working CLI proves the engine is available;
   * `pi auth check` against the configured default provider proves the
   * credentials are usable.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { command } = resolveCommand();
    const installed = command !== null;

    if (!installed) {
      return {
        installed: false,
        provider: 'pi',
        authenticated: false,
        authVerified: false,
        email: null,
        method: null,
        error: 'pi CLI not found (install @earendil-works/pi-coding-agent or add pi to PATH)',
      };
    }

    const versionOk = await checkVersion(command);
    if (!versionOk) {
      return {
        installed: true,
        provider: 'pi',
        authenticated: false,
        authVerified: false,
        email: null,
        method: null,
        error: 'pi CLI is present but failed to run',
      };
    }

    const authStatus = await checkAuthenticated(command);
    return {
      installed: true,
      provider: 'pi',
      authenticated: authStatus === 'ready',
      authVerified: authStatus === 'ready',
      email: null,
      method: authStatus === 'ready' ? 'pi_auth' : null,
      error: authStatus === 'ready'
        ? undefined
        : authStatus === 'unknown'
          ? 'Could not verify pi credentials (pi auth check failed)'
          : 'pi is not authenticated (run `pi auth` in a terminal)',
    };
  }
}
