// Model lists of the API card services, kept in the state file (codex.modelCache) so the card forms offer them at once:
// services whose list needs no key (SERVICE_INFO publicModels: OpenRouter, and Ollama / LM Studio on this machine) are
// refreshed in the background after activation, and a list a form loaded with a key is stored for its service. Custom
// endpoints are never cached (their list belongs to one address). No runtime vscode import.
import type { StateMemento } from '../fileState';
import { API_SERVICES, DEEPSEEK_MODELS, SERVICE_INFO, type ApiService } from './codexProvider';
import { fetchModels } from './providerModels';

export const MODEL_CACHE_KEY = 'codex.modelCache';
// A cloud list is refetched after a day; a local server's list on every activation (models come and go there)
const PUBLIC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Entry { models: string[]; fetchedAt: number }

export class ModelCache {
  constructor(private readonly state: StateMemento, private readonly now = (): number => Date.now()) {}

  /** The list to offer for a service: DeepSeek's catalog models, else the cached list (none for custom endpoints) */
  get(service: ApiService): string[] | undefined {
    if (service === 'deepseek') return [...DEEPSEEK_MODELS];
    return service === 'custom' ? undefined : this.entry(service)?.models;
  }

  async set(service: ApiService, models: string[]): Promise<void> {
    if (service === 'deepseek' || service === 'custom' || !models.length) return;
    await this.state.updateWith<unknown>(MODEL_CACHE_KEY, (value) => ({
      ...(typeof value === 'object' && value !== null ? value : {}), [service]: { models, fetchedAt: this.now() } satisfies Entry,
    }));
  }

  /** Background refresh of the services whose list needs no key; failures are skipped. Resolves to whether a list changed */
  async refreshPublic(fetch: typeof fetchModels = fetchModels): Promise<boolean> {
    let changed = false;
    await Promise.all(API_SERVICES.filter((s) => SERVICE_INFO[s].publicModels).map(async (service) => {
      const cached = this.entry(service);
      const maxAge = SERVICE_INFO[service].keyRequired ? PUBLIC_MAX_AGE_MS : 0;
      if (cached && this.now() - cached.fetchedAt < maxAge) return;
      try {
        const models = await fetch(SERVICE_INFO[service].baseUrl!, '', SERVICE_INFO[service].keyRequired ? 15_000 : 3_000);
        if (JSON.stringify(models) !== JSON.stringify(cached?.models)) changed = true;
        await this.set(service, models);
      } catch { /* offline or the local server is not running: keep what is cached */ }
    }));
    return changed;
  }

  private entry(service: ApiService): Entry | undefined {
    const value = (this.state.get<Record<string, unknown>>(MODEL_CACHE_KEY) ?? {})[service] as Partial<Entry> | undefined;
    return Array.isArray(value?.models) && typeof value?.fetchedAt === 'number' && value.models.every((m) => typeof m === 'string')
      ? { models: value.models as string[], fetchedAt: value.fetchedAt } : undefined;
  }
}
