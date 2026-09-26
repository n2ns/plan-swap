// Minimal vscode module stub: esbuild aliases 'vscode' to this file; tests import it directly to control the configuration
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export interface UpdateRecord { section: string; key: string; value: unknown; target: unknown }

const store = new Map<string, Map<string, unknown>>();
export const updates: UpdateRecord[] = [];

/** Sets the value returned by getConfiguration(section).get(key); undefined means not set */
export function setConfig(section: string, key: string, value: unknown): void {
  if (!store.has(section)) store.set(section, new Map());
  store.get(section)!.set(key, value);
}

export function resetConfig(): void {
  store.clear();
  updates.length = 0;
}

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string): T | undefined {
        return store.get(section)?.get(key) as T | undefined;
      },
      async update(key: string, value: unknown, target: unknown): Promise<void> {
        setConfig(section, key, value);
        updates.push({ section, key, value, target });
      },
    };
  },
};

export const env: { remoteName: string | undefined } = { remoteName: undefined };
export const window = {
  async showInformationMessage(..._args: unknown[]): Promise<string | undefined> { return undefined; },
  async showWarningMessage(..._args: unknown[]): Promise<string | undefined> { return undefined; },
  onDidCloseTerminal(_listener: unknown) { return { dispose() {} }; },
};
export const commands = {
  registerCommand(_id: string, _handler: unknown) { return { dispose() {} }; },
  async executeCommand(..._args: unknown[]): Promise<void> {},
};
