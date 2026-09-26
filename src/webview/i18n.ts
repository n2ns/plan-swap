// Webview string tables (English + Simplified Chinese). The host picks the locale and sends it in PanelState.locale.
import type { PanelState } from '../protocol';

export type Locale = PanelState['locale'];

// English is the source of truth; the zh-cn table must have exactly the same keys
export const en = {
  'tab.claude': 'Claude',
  'tab.codex': 'Codex',
  'tabs.ariaLabel': 'Account type',

  'claude.loginTitle': 'Run claude in a terminal to log in',
  'codex.loginTitle': 'Run codex login in a terminal',
  'claude.terminalTitle': 'Run claude with this account in a terminal',
  'codex.terminalTitle': 'Run codex with this account in a terminal',
  'claude.loginHint': 'Click "Log in" to log in from a terminal, or switch and log in from the Claude panel',
  'codex.loginHint': 'Click "Log in" to log in from a terminal, or switch and log in from the Codex panel',
  'claude.mdTitle': 'Open global CLAUDE.md',
  'codex.mdTitle': 'Open global AGENTS.md',
  'claude.settingsTitle': 'Open Claude Code extension settings',
  'codex.settingsTitle': 'Open Codex extension settings',
  'claude.syncTitle': "Re-link every linked account to the default account's settings, rules, skills, history and sessions, and mirror its MCP servers",
  'codex.syncTitle': "Re-link every linked account to the default account's settings, rules, skills, history, sessions and thread databases",

  'account.default': 'Default account',
  'account.current': 'Current account',
  'account.loggedIn': 'Logged in',
  'account.notLoggedIn': 'Not logged in',
  'account.sharedBadge': "Linked to the default account's settings, rules, skills, history and sessions",

  'list.title': 'All accounts',
  'row.rename': 'Rename',
  'row.switch': 'Switch to this account',
  'row.login': 'Log in',
  'row.share': 'Link to the default account: its settings, rules, skills, history and sessions move into the default account and are linked from then on; the login stays separate',
  'row.unshare': 'Unlink from the default account: the links are removed and the account gets its own copy of the default configuration; history and sessions stay in the default account',
  'row.remove': 'Remove account',
  'rename.ariaLabel': 'Display name',
  'rename.save': 'Save (Enter)',
  'confirm.text': 'Remove {name} from the list?',
  'confirm.hint': 'You will be asked separately whether to delete the account directory.',
  'confirm.remove': 'Remove',
  'confirm.cancel': 'Cancel',

  'validate.labelEmpty': 'Enter a display name',
  'validate.labelTooLong': 'Display name can be at most {max} characters',
  'validate.labelNewline': 'Display name cannot contain line breaks',
  'validate.labelDuplicate': "Same as another account's name",
  'validate.nameChars': 'Only letters, digits, underscores and hyphens are allowed',
  'validate.nameReserved': 'Cannot use the reserved name default',
  'validate.nameExists': 'An account with this name already exists',

  'add.title': 'Add account',
  'add.placeholder': 'Account name, e.g. work',
  'add.ariaLabel': 'New account name',
  'add.button': 'Add',
  'add.shared': "Link to the default account's settings and history",
  'claude.addHelpShared': "Will create {dir} linked to the default account's settings, rules, skills, history and sessions",
  'codex.addHelpShared': "Will create {dir} linked to the default account's settings, rules, skills, history, sessions and thread databases (memories stay per account)",
  'add.help.independent': 'Will create {dir} with a copy of the default configuration, independent from then on',
  'add.helpIdle': 'Each account uses its own config directory {prefix}<name>',

  'disabled.title': 'Codex account switching is not enabled',
  'disabled.text':
    'When enabled, each account uses its own CODEX_HOME directory (default ~/.codex, others ~/.codex-<name>). The extension writes a marker block into ~/.profile and ~/.bashrc that reads the selected directory from a state file.',
  'disabled.restartWsl': "Switching accounts requires restarting the editor's WSL server; all WSL windows disconnect.",
  'disabled.restartLocal': 'Switching accounts requires restarting this editor; all of its windows close and integrated terminals end.',
  'disabled.restartRemote': 'Switching accounts requires restarting the editor server in the remote environment.',
  'disabled.enable': 'Enable Codex switching',

  'pending.title': '{name} selected; takes effect after restarting the server',
  'pending.titleLocal': '{name} selected; takes effect after restarting the editor',
  'pending.text': 'Restarting the server disconnects all WSL windows (reload or reopen them); integrated terminals close.',
  'pending.textLocalManual': 'Fully exit this editor and start it again; reloading the window is not enough.',
  'pending.textRemote': 'Restart the editor server in the remote environment, then reconnect.',
  'pending.restart': 'Restart server',
  'pending.instructions': 'Show instructions',

  'banner.title': 'Switched to {name}',
  'banner.text': 'New sessions use the new account; open sessions still use the old one. After reloading, all panels start over with the new account.',
  'banner.dismiss': 'Dismiss',

  'tools.title': 'Tools',
  'tools.settings': 'Settings',
  'tools.sync': 'Re-link',
  'tools.updateCli': 'Update CLI',
  'tools.updateCliTitle': 'Update CLI in a terminal',

  'footer.versions': 'Show CLI and extension versions',
  'common.reloadWindow': 'Reload Window',
  'footer.restartExtHost': 'Restart Extension Host',
  'footer.restartServer': 'Restart WSL Server',
  'footer.restartManual': 'How to Apply the Codex Account',
  'footer.help': 'User guide',
  'footer.star': 'Star',
  'footer.version': 'v{version}',

  'versions.title': 'CLI and extension versions',
  'versions.close': 'Close',
};

export type MessageKey = keyof typeof en;

export const zhCn: Record<MessageKey, string> = {
  'tab.claude': 'Claude',
  'tab.codex': 'Codex',
  'tabs.ariaLabel': '账号类型',

  'claude.loginTitle': '在终端运行 claude 完成登录',
  'codex.loginTitle': '在终端运行 codex login',
  'claude.terminalTitle': '在终端中以此账号运行 claude',
  'codex.terminalTitle': '在终端中以此账号运行 codex',
  'claude.loginHint': '点「登录」在终端登录，或切换后在 Claude 面板登录',
  'codex.loginHint': '点「登录」在终端登录，或切换后在 Codex 面板登录',
  'claude.mdTitle': '打开全局 CLAUDE.md',
  'codex.mdTitle': '打开全局 AGENTS.md',
  'claude.settingsTitle': '打开 Claude Code 插件设置',
  'codex.settingsTitle': '打开 Codex 插件设置',
  'claude.syncTitle': '把所有链接账号重新链接到默认账号的设置、规则、技能、会话历史和会话记录，并同步默认账号的 MCP 服务器',
  'codex.syncTitle': '把所有链接账号重新链接到默认账号的设置、规则、技能、会话历史、会话记录和会话数据库',

  'account.default': '默认账号',
  'account.current': '当前账号',
  'account.loggedIn': '已登录',
  'account.notLoggedIn': '未登录',
  'account.sharedBadge': '已链接到默认账号的设置、规则、技能、会话历史和会话记录',

  'list.title': '全部账号',
  'row.rename': '重命名',
  'row.switch': '切换到此账号',
  'row.login': '登录',
  'row.share': '链接到默认账号：设置、规则、技能、会话历史和会话记录会并入默认账号，之后直接使用默认账号的；登录保持独立',
  'row.unshare': '与默认账号拆分：移除链接，账号获得一份自己的默认配置副本；会话历史和会话记录留在默认账号',
  'row.remove': '删除账号',
  'rename.ariaLabel': '显示名',
  'rename.save': '保存（回车）',
  'confirm.text': '从列表中删除 {name}？',
  'confirm.hint': '下一步会单独询问是否删除账号目录。',
  'confirm.remove': '删除',
  'confirm.cancel': '取消',

  'validate.labelEmpty': '请输入显示名',
  'validate.labelTooLong': '显示名最多 {max} 个字符',
  'validate.labelNewline': '显示名不能包含换行',
  'validate.labelDuplicate': '与其他账号的名字重复',
  'validate.nameChars': '只能包含字母、数字、下划线和连字符',
  'validate.nameReserved': '不能使用保留名 default',
  'validate.nameExists': '已存在同名账号',

  'add.title': '添加账号',
  'add.placeholder': '账号名，例如 work',
  'add.ariaLabel': '新账号名',
  'add.button': '添加',
  'add.shared': '链接到默认账号的配置和历史',
  'claude.addHelpShared': '将创建 {dir}，设置、规则、技能、会话历史和会话记录链接到默认账号',
  'codex.addHelpShared': '将创建 {dir}，设置、规则、技能、会话历史、会话记录和会话数据库链接到默认账号（记忆仍按账号独立）',
  'add.help.independent': '将创建 {dir}，复制一份默认账号的配置，之后各自独立',
  'add.helpIdle': '每个账号使用独立的配置目录 {prefix}<名字>',

  'disabled.title': 'Codex 账号切换尚未启用',
  'disabled.text':
    '启用后，每个账号使用独立的 CODEX_HOME 目录（默认 ~/.codex，其他为 ~/.codex-<名字>）。插件会在 ~/.profile 与 ~/.bashrc 写入一段标记块，从状态文件读取所选目录。',
  'disabled.restartWsl': '切换账号需要重启编辑器的 WSL 服务端，所有 WSL 窗口会断开。',
  'disabled.restartLocal': '切换账号需要重启当前编辑器，它的所有窗口会关闭，集成终端会结束。',
  'disabled.restartRemote': '切换账号需要在远程环境中重启编辑器服务端。',
  'disabled.enable': '启用 Codex 切换',

  'pending.title': '已选择 {name}，重启服务端后生效',
  'pending.titleLocal': '已选择 {name}，重启编辑器后生效',
  'pending.text': '重启服务端会断开所有 WSL 窗口（需重新加载或重新打开），集成终端关闭。',
  'pending.textLocalManual': '请完全退出当前编辑器后重新启动，仅重新加载窗口不够。',
  'pending.textRemote': '请在远程环境中重启编辑器服务端，然后重新连接。',
  'pending.restart': '重启服务端',
  'pending.instructions': '查看操作说明',

  'banner.title': '已切换到 {name}',
  'banner.text': '新会话使用新账号；已打开的会话仍在使用旧账号。重新加载后所有面板以新账号重新开始。',
  'banner.dismiss': '关闭提示',

  'tools.title': '工具',
  'tools.settings': '插件设置',
  'tools.sync': '重新链接',
  'tools.updateCli': '更新 CLI',
  'tools.updateCliTitle': '在终端中更新 CLI',

  'footer.versions': '显示 CLI 与插件版本',
  'common.reloadWindow': '重新加载窗口',
  'footer.restartExtHost': '重启扩展宿主',
  'footer.restartServer': '重启 WSL 服务端',
  'footer.restartManual': '如何应用 Codex 账号',
  'footer.help': '使用说明',
  'footer.star': 'Star',
  'footer.version': 'v{version}',

  'versions.title': 'CLI 与插件版本',
  'versions.close': '关闭',
};

const TABLES: Record<Locale, Record<MessageKey, string>> = { en, 'zh-cn': zhCn };

// Before the first state arrives, guess from the webview's language (it follows the editor's display language)
let current: Locale = navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = TABLES[locale] ? locale : 'en';
}

// Replaces `{name}` placeholders with params; unknown placeholders are left as-is
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = TABLES[current][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
