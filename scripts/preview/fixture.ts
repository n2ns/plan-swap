// Synthetic host transport for the real bundled Webview. No account files or CLIs are accessed.
import type { AccountView, FromWebview, PanelMode, PanelState, ToWebview } from '../../src/protocol';

type Locale = PanelState['locale'];
type ApplyOptions = { locale: Locale; width: number; active?: PanelMode };
type PreviewApi = {
  apply(options: ApplyOptions): void;
  state(): PanelState;
  post(message: ToWebview): void;
  messages: FromWebview[];
  clearMessages(): void;
};

declare global {
  interface Window {
    preview: PreviewApi;
    acquireVsCodeApi: () => {
      postMessage(message: FromWebview): void;
      getState(): { tab?: PanelMode } | undefined;
      setState(state: { tab?: PanelMode }): void;
    };
  }
}

const params = new URLSearchParams(location.search);
const locales: Locale[] = ['en', 'zh-cn', 'es', 'ja'];
const locale = locales.find((value) => value === params.get('locale')) ?? 'en';
const initialWidth = Number(params.get('width'));
const width = Number.isInteger(initialWidth) && initialWidth >= 180 && initialWidth <= 1000 ? initialWidth : 340;
const active: PanelMode = params.get('active') === 'codex' ? 'codex' : 'claude';
const sidebar = document.getElementById('sidebar')!;
const messages: FromWebview[] = [];
let currentState: PanelState;
let savedState: { tab?: PanelMode } = { tab: active };
let suppressTabMessage = false;

function account(mode: PanelMode, name: 'default' | 'work' | 'empty'): AccountView {
  const dir = `/fixture/.${mode === 'claude' ? 'claude' : 'codex'}${name === 'default' ? '' : `-${name}`}`;
  const base: AccountView = {
    kind: name === 'default' ? 'default' : 'named',
    name, label: name === 'default' ? 'Default' : name === 'work' ? 'Work' : 'Empty',
    dir, dirLabel: dir, loggedIn: name !== 'empty', isCurrent: name === 'default',
    shared: name === 'default' ? undefined : name === 'work',
  };
  if (mode === 'codex') base.isSelected = name === 'default';
  if (name === 'default') {
    base.email = `${mode}-default@example.invalid`;
    base.plan = mode === 'claude' ? 'Pro' : 'Plus';
  } else if (name === 'work') {
    base.email = `${mode}-work-with-a-long-address@example.invalid`;
    base.plan = mode === 'claude' ? 'Max 20x' : 'Pro';
    base.usage = {
      windows: [
        { usedPercent: 42, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3 * 60 * 60 },
        { usedPercent: 86, windowMinutes: 10080, resetsAt: Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60 },
      ],
      checkedAt: Date.UTC(2026, 8, 30, 12),
    };
  }
  return base;
}

function makeState(nextLocale: Locale, nextActive: PanelMode): PanelState {
  return {
    active: nextActive, locale: nextLocale,
    claude: {
      enabled: true, accounts: ['default', 'work', 'empty'].map((name) => account('claude', name as 'default' | 'work' | 'empty')),
      dirPrefix: '/fixture/.claude-',
    },
    codex: {
      enabled: true, accounts: ['default', 'work', 'empty'].map((name) => account('codex', name as 'default' | 'work' | 'empty')),
      restart: { context: 'wsl', auto: true }, dirPrefix: '/fixture/.codex-',
    },
  };
}

function post(message: ToWebview): void {
  if (message.type === 'state') currentState = message.state;
  window.dispatchEvent(new MessageEvent<ToWebview>('message', { data: message }));
}

function apply(options: ApplyOptions): void {
  const nextWidth = Math.max(180, Math.min(1000, Math.trunc(options.width)));
  sidebar.style.width = `${nextWidth}px`;
  currentState = makeState(options.locale, options.active ?? currentState?.active ?? 'claude');
  post({ type: 'state', state: currentState });
  const desired = currentState.active;
  const tab = document.getElementById(`tab-${desired}`);
  if (tab?.getAttribute('aria-selected') !== 'true') {
    suppressTabMessage = true;
    try { tab?.click(); } finally { suppressTabMessage = false; }
  }
}

window.acquireVsCodeApi = () => ({
  postMessage(message) {
    if (suppressTabMessage && message.type === 'setTab') return;
    messages.push(message);
    if (message.type === 'ready') apply({ locale, width, active });
  },
  getState: () => savedState,
  setState(state) { savedState = state; },
});

window.preview = {
  apply,
  state: () => currentState,
  post,
  messages,
  clearMessages() { messages.length = 0; },
};
