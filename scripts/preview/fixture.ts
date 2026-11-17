// Synthetic host transport for the real bundled Webview. No account files or CLIs are accessed.
import type { AccountView, FromWebview, PanelState, TabMode, ToWebview } from '../../src/protocol';

type Locale = PanelState['locale'];
type ApplyOptions = { locale: Locale; width: number; active?: TabMode };
type PreviewApi = {
  apply(options: ApplyOptions): void;
  state(): PanelState;
  post(message: ToWebview): void;
  messages: FromWebview[];
  clearMessages(): void;
  // Synthetic Claude API cards (configured preset, configuration error, linked custom endpoint, keyless local server)
  // a check adds to the Claude accounts; never part of the default state, so the fixed layout checks keep their rows
  claudeApiCards(): AccountView[];
};

declare global {
  interface Window {
    preview: PreviewApi;
    acquireVsCodeApi: () => {
      postMessage(message: FromWebview): void;
      getState(): { tab?: TabMode } | undefined;
      setState(state: { tab?: TabMode }): void;
    };
  }
}

const params = new URLSearchParams(location.search);
const locales: Locale[] = ['en', 'zh-cn', 'zh-tw', 'es', 'ja', 'ko'];
const locale = locales.find((value) => value === params.get('locale')) ?? 'en';
const initialWidth = Number(params.get('width'));
const width = Number.isInteger(initialWidth) && initialWidth >= 180 && initialWidth <= 1000 ? initialWidth : 340;
const activeParam = params.get('active');
const active: TabMode = activeParam === 'codex' || activeParam === 'agy' ? activeParam : 'claude';
const sidebar = document.getElementById('sidebar')!;
const messages: FromWebview[] = [];
let currentState: PanelState;
let savedState: { tab?: TabMode } = { tab: active };
let suppressTabMessage = false;

function account(mode: 'claude' | 'codex', name: 'default' | 'work' | 'empty'): AccountView {
  const dir = `/fixture/.${mode === 'claude' ? 'claude' : 'codex'}${name === 'default' ? '' : `-${name}`}`;
  const base: AccountView = {
    kind: name === 'default' ? 'default' : 'named',
    name, label: name === 'default' ? 'Default' : name === 'work' ? 'Work' : 'Empty',
    dir, dirLabel: dir, loggedIn: name !== 'empty', usageEligible: name !== 'empty' || undefined, isCurrent: name === 'default',
    shared: name === 'default' ? undefined : name === 'work',
  };
  if (mode === 'codex') base.isSelected = name === 'default';
  if (name === 'default') {
    base.email = `${mode}-default@example.invalid`;
    base.plan = mode === 'claude' ? 'Pro' : 'Plus';
  } else if (name === 'work') {
    base.email = `${mode}-work-with-a-long-address@example.invalid`;
    base.plan = mode === 'claude' ? 'Ultra' : 'Pro';
    const now = Math.floor(Date.now() / 1000);
    base.usage = {
      windows: mode === 'claude' ? [
        { usedPercent: 42, windowMinutes: 300, resetsAt: now + 3 * 60 * 60 },
        { usedPercent: 86, windowMinutes: 10080, resetsAt: now + 3 * 24 * 60 * 60 },
        { usedPercent: 25, windowMinutes: 10080, resetsAt: now + 4 * 24 * 60 * 60, scope: 'Fable' },
      ] : [
        { usedPercent: 42, windowMinutes: 300, resetsAt: now + 3 * 60 * 60 },
        { usedPercent: 86, windowMinutes: 10080, resetsAt: now + 3 * 24 * 60 * 60 },
      ],
      checkedAt: Date.UTC(2026, 8, 30, 12),
    };
  }
  return base;
}

// The agy tab: saved copies of agy sign-ins, the signed-in one current; windows scoped by agy's model groups
function agyAccounts(): AccountView[] {
  const now = Math.floor(Date.now() / 1000);
  const row = (name: string, label: string, email: string, isCurrent: boolean, usedPercent: number[]): AccountView => ({
    kind: 'named', name, label, dir: `/fixture/.config/planswap/agy/accounts/${name}`, dirLabel: `/fixture/.config/planswap/agy/accounts/${name}`,
    email, loggedIn: true, isCurrent, usageEligible: isCurrent,
    usage: {
      windows: [
        { usedPercent: usedPercent[0], windowMinutes: 300, resetsAt: now + 2 * 60 * 60, scope: 'Gemini Models' },
        { usedPercent: usedPercent[1], windowMinutes: 10080, resetsAt: now + 5 * 24 * 60 * 60, scope: 'Gemini Models' },
        { usedPercent: usedPercent[2], windowMinutes: 10080, resetsAt: now + 6 * 24 * 60 * 60, scope: 'Claude and GPT models' },
      ],
      checkedAt: Date.UTC(2026, 8, 30, 12),
    },
  });
  return [
    row('g000000000001', 'personal', 'personal@example.invalid', true, [10, 35, 0]),
    row('g000000000002', 'work-with-a-long-name', 'work-with-a-long-address@example.invalid', false, [0, 92, 50]),
  ];
}

function claudeApiCards(): AccountView[] {
  const card = (name: string, label: string, view: Partial<AccountView>): AccountView => ({
    kind: 'named', name, label, dir: `/fixture/.claude-${name}`, dirLabel: `/fixture/.claude-${name}`,
    loggedIn: true, isCurrent: false, shared: false, ...view,
  });
  return [
    card('deepseek', 'DeepSeek', { provider: 'DeepSeek API', plan: 'DeepSeek API', providerService: 'deepseek', providerModel: 'deepseek-v4-pro',
      providerBaseUrl: 'https://api.deepseek.com/anthropic', providerHasKey: true, providerConfigured: true }),
    card('broken', 'Broken', { provider: 'Kimi API', plan: 'Kimi API', providerService: 'kimi', providerConfigured: false,
      providerError: 'Synthetic provider configuration error', loggedIn: false }),
    card('gateway', 'Gateway', { provider: 'Custom API', plan: 'Custom API', providerService: 'custom', providerModel: 'gateway-model',
      providerBaseUrl: 'https://gateway.example.test/anthropic', providerHost: 'gateway.example.test', providerHasKey: true, providerConfigured: true, shared: true }),
    card('local', 'Local', { provider: 'Ollama API', plan: 'Ollama API', providerService: 'ollama', providerModel: 'qwen3-coder',
      providerBaseUrl: 'http://localhost:11434', providerHost: 'localhost:11434', providerHasKey: false, providerConfigured: true }),
  ];
}

function makeState(nextLocale: Locale, nextActive: TabMode): PanelState {
  return {
    active: nextActive, locale: nextLocale,
    claude: {
      enabled: true, accounts: ['default', 'work', 'empty'].map((name) => account('claude', name as 'default' | 'work' | 'empty')),
      dirPrefix: '/fixture/.claude-',
      apiServices: [
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', keyRequired: true, models: ['deepseek-flash', 'deepseek-v4-pro'] },
        { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/anthropic', keyRequired: true },
        { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', keyRequired: false },
        { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', keyRequired: true, models: ['anthropic/model-a', 'z-ai/model-c'] },
        { id: 'zai', name: 'Z.ai', baseUrl: 'https://api.z.ai/api/anthropic', keyRequired: true },
        { id: 'custom', name: '', keyRequired: false },
      ],
    },
    codex: {
      enabled: true, accounts: ['default', 'work', 'empty'].map((name) => account('codex', name as 'default' | 'work' | 'empty')),
      restart: { context: 'wsl', auto: true }, dirPrefix: '/fixture/.codex-',
      apiServices: [
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/', keyRequired: true, models: ['deepseek-flash', 'deepseek-v4-pro'] },
        { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', keyRequired: true },
        { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyRequired: false },
        { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyRequired: false },
        { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, models: ['anthropic/model-a', 'openai/model-b', 'z-ai/model-c'] },
        { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', keyRequired: true },
        { id: 'zai', name: 'Z.ai', baseUrl: 'https://api.z.ai/api/v1', keyRequired: true },
        { id: 'custom', name: '', keyRequired: false },
      ],
    },
    agy: { enabled: true, accounts: agyAccounts(), hideRecommendation: true },
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
  claudeApiCards,
};
