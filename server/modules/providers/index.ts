export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// getWorkbuddyCommand: used by the websocket shell service to spawn the
// WorkBuddy CLI at its resolved absolute path (not reliant on the PTY's PATH).
export { getWorkbuddyCommand } from './list/workbuddy/workbuddy-auth.provider.js';

// getPiCommand: used by the websocket shell service to spawn the Pi CLI at its
// resolved absolute path (not reliant on the PTY's PATH).
export { getPiCommand } from './list/pi/pi-auth.provider.js';
