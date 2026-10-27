// Model lists of the Claude API card services, kept in the state file (claude.modelCache) so the card forms offer them
// at once: services whose list needs no key (CLAUDE_SERVICE_INFO publicModels: OpenRouter, and Ollama on this machine)
// are refreshed in the background after activation, and a list a form loaded with a key is stored for its service.
// DeepSeek offers its fixed list; custom endpoints are never cached (their list belongs to one address). No runtime
// vscode import.
import type { StateMemento } from './fileState';
import { CLAUDE_API_SERVICES, CLAUDE_SERVICE_INFO, claudeModelsUrl, type ClaudeApiService } from './claudeProvider';
import { fetchModels } from './codex/providerModels';

export const CLAUDE_MODEL_CACHE_KEY = 'claude.modelCache';
// A cloud list is refetched after a day; a local server's list on every activation (models come and go there)
const PUBLIC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Entry { models: string[]; fetchedAt: number }

export class ClaudeModelCache {
  constructor(private readonly state: StateMemento, private readonly now = (): number => Date.now()) {}

  /** The list to offer for a service: DeepSeek's fixed models, else the cached list (none for custom endpoints) */
  get(service: ClaudeApiService): string[] | undefined {
    const fixed = CLAUDE_SERVICE_INFO[service].models;
    if (fixed) return [...fixed];
    return service === 'custom' ? undefined : this.entry(service)?.models;
  }

  async set(service: ClaudeApiService, models: string[]): Promise<void> {
    if (CLAUDE_SERVICE_INFO[service].models || service === 'custom' || !models.length) return;
    await this.state.updateWith<unknown>(CLAUDE_MODEL_CACHE_KEY, (value) => ({
      ...(typeof value === 'object' && value !== null ? value : {}), [service]: { models, fetchedAt: this.now() } satisfies Entry,
    }));
  }

  /** Background refresh of the services whose list needs no key; failures are skipped. Resolves to whether a list changed */
  async refreshPublic(fetch: typeof fetchModels = fetchModels): Promise<boolean> {
    let changed = false;
    await Promise.all(CLAUDE_API_SERVICES.filter((s) => CLAUDE_SERVICE_INFO[s].publicModels).map(async (service) => {
      const info = CLAUDE_SERVICE_INFO[service];
      const cached = this.entry(service);
      const maxAge = info.keyRequired ? PUBLIC_MAX_AGE_MS : 0;
      if (cached && this.now() - cached.fetchedAt < maxAge) return;
      try {
        const models = await fetch(claudeModelsUrl(service, info.baseUrl!), '', info.keyRequired ? 15_000 : 3_000);
        if (JSON.stringify(models) !== JSON.stringify(cached?.models)) changed = true;
        await this.set(service, models);
      } catch { /* offline or the local server is not running: keep what is cached */ }
    }));
    return changed;
  }

  private entry(service: ClaudeApiService): Entry | undefined {
    const value = (this.state.get<Record<string, unknown>>(CLAUDE_MODEL_CACHE_KEY) ?? {})[service] as Partial<Entry> | undefined;
    return Array.isArray(value?.models) && typeof value?.fetchedAt === 'number' && value.models.every((m) => typeof m === 'string')
      ? { models: value.models as string[], fetchedAt: value.fetchedAt } : undefined;
  }
}
