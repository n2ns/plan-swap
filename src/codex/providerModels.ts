// Model lists of API card endpoints: GET <baseUrl>/models in the OpenAI list format ({ data: [{ id }] }), returning the
// sorted, unique model IDs. PlanSwap's only network requests of its own go through here: the background refresh of the
// lists that need no key (modelCache.ts, no key sent) and a card form's request to the endpoint it names, with the key
// typed there or saved in that card. Redirects are refused (a key must not follow them elsewhere) and errors carry only a
// status code, never the response body or the key. No runtime vscode import.

export type ModelListErrorCode = 'http' | 'network' | 'format';
export class ModelListError extends Error {
  constructor(readonly code: ModelListErrorCode, readonly status?: number) {
    super(code);
    this.name = 'ModelListError';
  }
}

/** options.anthropic: an Anthropic-style service (Claude API cards), which also takes the key as x-api-key and needs
 *  anthropic-version. */
export async function fetchModels(baseUrl: string, key: string, timeoutMs = 15_000, options?: { anthropic?: boolean }): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(options?.anthropic ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ModelListError('network');
  }
  if (!response.ok) throw new ModelListError('http', response.status);
  let body: unknown;
  try { body = await response.json(); } catch { throw new ModelListError('format'); }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ModelListError('format');
  const ids = data.map((entry) => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/\s|[\x00-\x1f\x7f]/u.test(id));
  if (!ids.length) throw new ModelListError('format');
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
