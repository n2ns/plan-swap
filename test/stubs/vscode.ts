// Minimal vscode module stub: esbuild aliases 'vscode' to this file; tests import it directly to control the configuration
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const version = '1.107.0';

export interface UpdateRecord { section: string; key: string; value: unknown; target: unknown }

const store = new Map<string, Map<string, unknown>>();
const defaults = new Map<string, Map<string, unknown>>();
export const updates: UpdateRecord[] = [];

/** Sets the value returned by getConfiguration(section).get(key); undefined means not set */
export function setConfig(section: string, key: string, value: unknown): void {
  if (!store.has(section)) store.set(section, new Map());
  store.get(section)!.set(key, value);
}

/** Sets a manifest default independently from an explicit user configuration. */
export function setConfigDefault(section: string, key: string, value: unknown): void {
  if (!defaults.has(section)) defaults.set(section, new Map());
  defaults.get(section)!.set(key, value);
}

export function resetConfig(): void {
  store.clear();
  defaults.clear();
  updates.length = 0;
}

type ConfigurationListener = (e: { affectsConfiguration(section: string): boolean }) => void;
const configurationListeners = new Set<ConfigurationListener>();

/** Fires workspace.onDidChangeConfiguration for a change of `changed` (e.g. 'planswap.statusBar.alignment') */
export function fireConfigurationChange(changed: string): void {
  const event = { affectsConfiguration: (section: string) => changed === section || changed.startsWith(`${section}.`) };
  for (const listener of [...configurationListeners]) listener(event);
}

export const workspace = {
  onDidChangeConfiguration(listener: ConfigurationListener) {
    configurationListeners.add(listener);
    return { dispose() { configurationListeners.delete(listener); } };
  },
  async openTextDocument(options: { language: string; content: string }) { return options; },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        return (store.get(section)?.get(key) as T | undefined) ?? (defaults.get(section)?.get(key) as T | undefined) ?? defaultValue;
      },
      inspect<T>(key: string) {
        return { key: `${section}.${key}`, defaultValue: defaults.get(section)?.get(key) as T | undefined, globalValue: store.get(section)?.get(key) as T | undefined,
          workspaceValue: undefined, workspaceFolderValue: undefined };
      },
      async update(key: string, value: unknown, target: unknown): Promise<void> {
        setConfig(section, key, value);
        updates.push({ section, key, value, target });
      },
    };
  },
};

export const env: { remoteName: string | undefined; language: string; clipboard: { writeText(text: string): Promise<void> }; openExternal(uri: { toString(): string }): Promise<boolean> } = {
  remoteName: undefined,
  language: 'en',
  clipboard: { async writeText(_text: string) {} },
  async openExternal() { return true; },
};
export interface StubTerminal { name: string; sent: string[]; shown: number; sendText(text: string): void; show(): void }
export const StatusBarAlignment = { Left: 1, Right: 2 };

export class ThemeColor {
  constructor(public readonly id: string) {}
}

/** Like vscode.MarkdownString: appendText escapes markdown syntax, appendMarkdown appends as is */
export class MarkdownString {
  isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
  supportHtml?: boolean;
  constructor(public value = '', public supportThemeIcons = false) {}
  appendText(text: string): this {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
    return this;
  }
  appendMarkdown(markdown: string): this {
    this.value += markdown;
    return this;
  }
}

/** Tooltip as the reader sees it: markdown escapes removed and line breaks restored (for assertions) */
/**
 * Readable text of the status bar's HTML: a table becomes one line per row, `| cell | cell |` (a spanning cell is one
 * cell); in any cell or fragment, codicons become `$(name)`, links `[text](href "title")`, <strong> `**`, <em> `_`, and
 * character references are decoded.
 */
export function htmlText(html: string): string {
  const cell = (part: string): string => part
    .replace(/<span class="codicon codicon-([a-z-]+)"><\/span>/g, '$($1)')
    .replace(/<a href="([^"]*)" title="([^"]*)">(.*?)<\/a>/g, '[$3]($1 "$2")')
    .replace(/<\/?strong>/g, '**')
    .replace(/<\/?em>/g, '_')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  if (!html.includes('<tr>')) return cell(html);
  return [...html.matchAll(/<tr>(.*?)<\/tr>/g)]
    .map(([, row]) => `| ${[...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(([, c]) => cell(c)).join(' | ')} |`)
    .join('\n');
}

/** Readable text of a tooltip: the status bar's HTML through htmlText; other markdown only loses its backslash escapes. */
export function tooltipText(tooltip: string | MarkdownString): string {
  if (typeof tooltip === 'string') return tooltip;
  if (tooltip.value.startsWith('<table>')) return htmlText(tooltip.value);
  return tooltip.value.replace(/ {2}\n/g, '\n').replace(/\\(.)/g, '$1');
}

export const statusBarItems: Array<{ alignment: number; text: string; tooltip: string | MarkdownString; command: string; name?: string; backgroundColor?: ThemeColor; accessibilityInformation?: { label: string; role?: string }; visible: boolean; disposed?: boolean; show(): void; hide(): void; dispose(): void }> = [];
export const window = {
  state: { focused: true },
  async showTextDocument<T>(document: T): Promise<T> { return document; },
  createStatusBarItem(alignment: number) {
    const item: (typeof statusBarItems)[number] = { alignment, text: '', tooltip: '', command: '', visible: false,
      show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.visible = false; this.disposed = true; } };
    statusBarItems.push(item);
    return item;
  },
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
  parse(value: string) {
    return { scheme: value.split(':')[0], toString: () => value };
  },
  joinPath(base: { path: string }, ...parts: string[]) {
    const path = [base.path, ...parts].join('/');
    return { path, toString: () => path };
  },
};
