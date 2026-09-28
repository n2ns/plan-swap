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
export interface StubTerminal { name: string; sent: string[]; shown: number; sendText(text: string): void; show(): void }
export const window = {
  async showInformationMessage(..._args: unknown[]): Promise<string | undefined> { return undefined; },
  async showWarningMessage(..._args: unknown[]): Promise<string | undefined> { return undefined; },
  async showErrorMessage(..._args: unknown[]): Promise<string | undefined> { return undefined; },
  async showQuickPick<T>(_items: T[], _options?: unknown): Promise<T | undefined> { return undefined; },
  createTerminal(options: { name: string }): StubTerminal {
    const terminal: StubTerminal = {
      name: options.name,
      sent: [],
      shown: 0,
      sendText(text: string) { terminal.sent.push(text); },
      show() { terminal.shown++; },
    };
    return terminal;
  },
  onDidCloseTerminal(_listener: unknown) { return { dispose() {} }; },
};
export const commands = {
  /** Handlers by command id, as registered by the last registerCommand call for that id */
  registered: {} as Record<string, (...args: unknown[]) => Promise<void>>,
  registerCommand(id: string, handler: unknown) {
    commands.registered[id] = handler as (...args: unknown[]) => Promise<void>;
    return { dispose() { delete commands.registered[id]; } };
  },
  async executeCommand(..._args: unknown[]): Promise<void> {},
};

// Webview provider tests use in-memory sources, so no file watchers are created.
export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((item) => item !== listener); } };
  };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
  dispose(): void { this.listeners = []; }
}

export const Uri = {
  joinPath(base: { path: string }, ...parts: string[]) {
    const path = [base.path, ...parts].join('/');
    return { path, toString: () => path };
  },
};
