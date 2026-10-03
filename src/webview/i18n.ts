// Webview string tables (English, Simplified Chinese, Traditional Chinese, Spanish and Japanese). The host picks the locale and sends it in PanelState.locale.
// Every Webview string goes through t(). The Webview cannot import host code, so WEB_LOCALE_INFO, matchLocale and
// formatMessage duplicate src/i18n.ts (do not merge them); test/i18n.test.ts asserts the shared LOCALE_INFO fields match, the table set
// equals LOCALES and both formatMessage copies behave the same.
// Locale lifecycle: at module load the locale is guessed from navigator.language; main.ts then sets it from the
// host-rendered `<html lang>` (intlLocale() at creation) and calls setLocale(state.locale) on every `state` message,
// keeping `<html lang>` in sync, so t() always uses the locale of the most recent state.
import type { PanelState } from '../protocol';

export type Locale = PanelState['locale'];

// English is the source of truth; all tables must have exactly the same keys (enforced by the Record<MessageKey, string> type)
export const en = {
  'usage.barTitle': '{remaining}% left ({used}% used)',
  'usage.remaining': '{percent}% remaining',
  'usage.window': 'Limit',
  'usage.days': '{n}-day limit',
  'usage.hours': '{n}-hour limit',
  'usage.minutes': '{n}-minute limit',
  'usage.scoped': '{limit} · {scope}',
  'usage.resetsIn': 'Resets in {time} ({date})',
  'usage.exhausted': 'Used up',
  'usage.refreshTitle': 'Refresh usage limits of the current account',
  'usage.refreshAllTitle': 'Refresh usage limits of all accounts',
  'panel.loading': 'Loading accounts…',
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
  'claude.syncTitle': 'Re-link linked accounts to the default account and sync its MCP servers',
  'codex.syncTitle': 'Re-link linked accounts to the default account',

  'account.default': 'Default account',
  'account.loggedIn': 'Logged in',
  'account.notLoggedIn': 'Not logged in',
  'account.sharedBadge': 'Shares linked content with the default account; some files may remain independent',

  'list.title': 'All accounts',
  'row.rename': 'Rename',
  'row.renameAria': 'Rename {name}',
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
  'validate.labelTooLong': 'Display name can be at most {max, plural, one {# character} other {# characters}}',
  'validate.labelNewline': 'Display name cannot contain line breaks',
  'validate.labelDuplicate': "Same as another account's name",
  'validate.nameChars': 'Only A-Z, a-z, 0-9, underscores (_) and hyphens (-) are allowed',
  'validate.nameReserved': 'Cannot use the reserved name default',
  'validate.nameExists': 'An account with this name already exists',

  'add.title': 'Add account',
  'add.placeholder': 'Account name, e.g. work',
  'add.ariaLabel': 'New account name',
  'add.button': 'Add',
  'add.shared': "Link to the default account's settings and history",
  'claude.addHelpShared': "Will create {dir} linked to the default account's settings, rules, skills, history and sessions",
  'codex.addHelpShared': "Will create {dir} linked to the default account's settings, rules, skills, history, sessions and thread databases (memories stay per account)",
  'codex.addHelpSharedWin': "Will create {dir} linked to the default account's settings, rules, skills, history and sessions (memories and thread databases stay per account)",
  'add.help.independent': 'Will create {dir} with a copy of the default configuration, independent from then on',
  'add.helpIdle': 'Each account uses its own config directory {prefix}<name>',

  'disabled.title': 'Codex account switching is not enabled',
  'disabled.text':
    'When enabled, each account uses its own CODEX_HOME directory (default ~/.codex, others ~/.codex-<name>). The extension writes a marker block into ~/.profile and ~/.bashrc that reads the selected directory from a state file.',
  'disabled.textWin': 'When enabled, each account uses its own CODEX_HOME directory (default ~/.codex, others ~/.codex-<name>). The extension sets the per-user environment variable CODEX_HOME to the selected directory (removed for the default account).',
  'disabled.restartWsl': "Switching accounts requires restarting the editor's WSL server; all WSL windows disconnect.",
  'disabled.restartLocal': 'Switching accounts requires restarting this editor; all of its windows close and integrated terminals end.',
  'disabled.restartRemote': 'Switching accounts requires restarting the editor server in the remote environment.',
  'disabled.enable': 'Enable Codex switching',

  'pending.title': '{name} selected; takes effect after restarting the server',
  'pending.titleLocal': '{name} selected; takes effect after restarting the editor',
  'pending.text': 'Restarting the server disconnects all WSL windows (reload or reopen them); integrated terminals close.',
  'pending.textLocalManual': 'Fully exit this editor and start it again; reloading the window is not enough.',
  'pending.textRemote': 'Restart the editor server in the remote environment, then reconnect.',

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
  'footer.help': 'User guide',
  'footer.star': 'Star',
  'footer.version': 'v{version}',

  'versions.title': 'CLI and extension versions',
  'versions.close': 'Close',
};

export type MessageKey = keyof typeof en;

export const zhCn: Record<MessageKey, string> = {
  'usage.barTitle': '剩余 {remaining}%（已用 {used}%）',
  'usage.remaining': '剩余 {percent}%',
  'usage.window': '额度',
  'usage.days': '{n} 天额度',
  'usage.hours': '{n} 小时额度',
  'usage.minutes': '{n} 分钟额度',
  'usage.scoped': '{limit} · {scope}',
  'usage.resetsIn': '{time}后重置（{date}）',
  'usage.exhausted': '已用完',
  'usage.refreshTitle': '刷新当前账号的用量额度',
  'usage.refreshAllTitle': '刷新全部账号的用量额度',
  'panel.loading': '正在加载账号…',
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
  'claude.syncTitle': '将链接账号重新链接到默认账号，并同步 MCP 服务器',
  'codex.syncTitle': '将链接账号重新链接到默认账号',

  'account.default': '默认账号',
  'account.loggedIn': '已登录',
  'account.notLoggedIn': '未登录',
  'account.sharedBadge': '已链接的内容与默认账号共享；部分文件可能保持独立',

  'list.title': '全部账号',
  'row.rename': '重命名',
  'row.renameAria': '重命名 {name}',
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
  'validate.nameChars': '只能包含 A-Z、a-z、0-9、下划线（_）和连字符（-）',
  'validate.nameReserved': '不能使用保留名 default',
  'validate.nameExists': '已存在同名账号',

  'add.title': '添加账号',
  'add.placeholder': '账号名，例如 work',
  'add.ariaLabel': '新账号名',
  'add.button': '添加',
  'add.shared': '链接到默认账号的配置和历史',
  'claude.addHelpShared': '将创建 {dir}，设置、规则、技能、会话历史和会话记录链接到默认账号',
  'codex.addHelpShared': '将创建 {dir}，设置、规则、技能、会话历史、会话记录和会话数据库链接到默认账号（记忆仍按账号独立）',
  'codex.addHelpSharedWin': '将创建 {dir}，设置、规则、技能、会话历史和会话记录链接到默认账号（记忆与会话数据库仍按账号独立）',
  'add.help.independent': '将创建 {dir}，复制一份默认账号的配置，之后各自独立',
  'add.helpIdle': '每个账号使用独立的配置目录 {prefix}<名字>',

  'disabled.title': 'Codex 账号切换尚未启用',
  'disabled.text':
    '启用后，每个账号使用独立的 CODEX_HOME 目录（默认 ~/.codex，其他为 ~/.codex-<名字>）。插件会在 ~/.profile 与 ~/.bashrc 写入一段标记块，从状态文件读取所选目录。',
  'disabled.textWin': '启用后，每个账号使用独立的 CODEX_HOME 目录（默认 ~/.codex，其他为 ~/.codex-<名字>）。插件会把用户环境变量 CODEX_HOME 设为所选目录（默认账号时删除该变量）。',
  'disabled.restartWsl': '切换账号需要重启编辑器的 WSL 服务端，所有 WSL 窗口会断开。',
  'disabled.restartLocal': '切换账号需要重启当前编辑器，它的所有窗口会关闭，集成终端会结束。',
  'disabled.restartRemote': '切换账号需要在远程环境中重启编辑器服务端。',
  'disabled.enable': '启用 Codex 切换',

  'pending.title': '已选择 {name}，重启服务端后生效',
  'pending.titleLocal': '已选择 {name}，重启编辑器后生效',
  'pending.text': '重启服务端会断开所有 WSL 窗口（需重新加载或重新打开），集成终端关闭。',
  'pending.textLocalManual': '请完全退出当前编辑器后重新启动，仅重新加载窗口不够。',
  'pending.textRemote': '请在远程环境中重启编辑器服务端，然后重新连接。',

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
  'footer.help': '使用说明',
  'footer.star': 'Star',
  'footer.version': 'v{version}',

  'versions.title': 'CLI 与插件版本',
  'versions.close': '关闭',
};

export const zhTw: Record<MessageKey, string> = {
  'usage.barTitle': '剩餘 {remaining}%（已用 {used}%）',
  'usage.remaining': '剩餘 {percent}%',
  'usage.window': '額度',
  'usage.days': '{n} 天額度',
  'usage.hours': '{n} 小時額度',
  'usage.minutes': '{n} 分鐘額度',
  'usage.scoped': '{limit} · {scope}',
  'usage.resetsIn': '{time}後重設（{date}）',
  'usage.exhausted': '已用完',
  'usage.refreshTitle': '重新整理目前帳號的用量額度',
  'usage.refreshAllTitle': '重新整理全部帳號的用量額度',
  'panel.loading': '正在載入帳號…',
  'tab.claude': 'Claude',
  'tab.codex': 'Codex',
  'tabs.ariaLabel': '帳號類型',

  'claude.loginTitle': '在終端機執行 claude 完成登入',
  'codex.loginTitle': '在終端機執行 codex login',
  'claude.terminalTitle': '在終端機中以此帳號執行 claude',
  'codex.terminalTitle': '在終端機中以此帳號執行 codex',
  'claude.loginHint': '按「登入」在終端機登入，或切換後在 Claude 面板登入',
  'codex.loginHint': '按「登入」在終端機登入，或切換後在 Codex 面板登入',
  'claude.mdTitle': '開啟全域 CLAUDE.md',
  'codex.mdTitle': '開啟全域 AGENTS.md',
  'claude.settingsTitle': '開啟 Claude Code 擴充功能設定',
  'codex.settingsTitle': '開啟 Codex 擴充功能設定',
  'claude.syncTitle': '將已連結帳號重新連結到預設帳號，並同步其 MCP 伺服器',
  'codex.syncTitle': '將已連結帳號重新連結到預設帳號',

  'account.default': '預設帳號',
  'account.loggedIn': '已登入',
  'account.notLoggedIn': '未登入',
  'account.sharedBadge': '已連結的內容與預設帳號共用；部分檔案可能保持獨立',

  'list.title': '全部帳號',
  'row.rename': '重新命名',
  'row.renameAria': '重新命名 {name}',
  'row.switch': '切換到此帳號',
  'row.login': '登入',
  'row.share': '連結到預設帳號：設定、規則、技能、記錄和工作階段會移入預設帳號，之後直接連結使用；登入保持獨立',
  'row.unshare': '與預設帳號拆分：移除連結，帳號取得一份自己的預設設定副本；記錄和工作階段留在預設帳號',
  'row.remove': '移除帳號',
  'rename.ariaLabel': '顯示名稱',
  'rename.save': '儲存（Enter）',
  'confirm.text': '要從清單中移除 {name} 嗎？',
  'confirm.hint': '接下來會另外詢問是否刪除帳號目錄。',
  'confirm.remove': '移除',
  'confirm.cancel': '取消',

  'validate.labelEmpty': '請輸入顯示名稱',
  'validate.labelTooLong': '顯示名稱最多 {max} 個字元',
  'validate.labelNewline': '顯示名稱不能包含換行',
  'validate.labelDuplicate': '與其他帳號的名稱重複',
  'validate.nameChars': '只能包含 A-Z、a-z、0-9、底線（_）和連字號（-）',
  'validate.nameReserved': '不能使用保留名稱 default',
  'validate.nameExists': '已有同名帳號',

  'add.title': '新增帳號',
  'add.placeholder': '帳號名稱，例如 work',
  'add.ariaLabel': '新帳號名稱',
  'add.button': '新增',
  'add.shared': '連結到預設帳號的設定和記錄',
  'claude.addHelpShared': '將建立 {dir}，設定、規則、技能、記錄和工作階段連結到預設帳號',
  'codex.addHelpShared': '將建立 {dir}，設定、規則、技能、記錄、工作階段和對話串資料庫連結到預設帳號（記憶仍依帳號獨立）',
  'codex.addHelpSharedWin': '將建立 {dir}，設定、規則、技能、記錄和工作階段連結到預設帳號（記憶與對話串資料庫仍依帳號獨立）',
  'add.help.independent': '將建立 {dir}，複製一份預設帳號的設定，之後各自獨立',
  'add.helpIdle': '每個帳號使用獨立的設定目錄 {prefix}<名稱>',

  'disabled.title': '尚未啟用 Codex 帳號切換',
  'disabled.text':
    '啟用後，每個帳號使用獨立的 CODEX_HOME 目錄（預設 ~/.codex，其他為 ~/.codex-<名稱>）。擴充功能會在 ~/.profile 與 ~/.bashrc 寫入一段標記區塊，從狀態檔案讀取所選目錄。',
  'disabled.textWin': '啟用後，每個帳號使用獨立的 CODEX_HOME 目錄（預設 ~/.codex，其他為 ~/.codex-<名稱>）。擴充功能會把使用者環境變數 CODEX_HOME 設為所選目錄（預設帳號時移除該變數）。',
  'disabled.restartWsl': '切換帳號需要重新啟動編輯器的 WSL 伺服器，所有 WSL 視窗都會中斷連線。',
  'disabled.restartLocal': '切換帳號需要重新啟動目前的編輯器，它的所有視窗都會關閉，整合式終端機也會結束。',
  'disabled.restartRemote': '切換帳號需要在遠端環境中重新啟動編輯器伺服器。',
  'disabled.enable': '啟用 Codex 切換',

  'pending.title': '已選擇 {name}，重新啟動伺服器後生效',
  'pending.titleLocal': '已選擇 {name}，重新啟動編輯器後生效',
  'pending.text': '重新啟動伺服器會中斷所有 WSL 視窗的連線（需重新載入或重新開啟），整合式終端機會關閉。',
  'pending.textLocalManual': '請完全結束目前的編輯器後再重新啟動，僅重新載入視窗並不夠。',
  'pending.textRemote': '請在遠端環境中重新啟動編輯器伺服器，然後重新連線。',

  'banner.title': '已切換到 {name}',
  'banner.text': '新工作階段使用新帳號；已開啟的工作階段仍使用舊帳號。重新載入後，所有面板都會以新帳號重新開始。',
  'banner.dismiss': '關閉提示',

  'tools.title': '工具',
  'tools.settings': '擴充功能設定',
  'tools.sync': '重新連結',
  'tools.updateCli': '更新 CLI',
  'tools.updateCliTitle': '在終端機中更新 CLI',

  'footer.versions': '顯示 CLI 與擴充功能版本',
  'common.reloadWindow': '重新載入視窗',
  'footer.restartExtHost': '重新啟動擴充功能主機',
  'footer.help': '使用指南',
  'footer.star': 'Star',
  'footer.version': 'v{version}',

  'versions.title': 'CLI 與擴充功能版本',
  'versions.close': '關閉',
};

export const es: Record<MessageKey, string> = {
  'usage.barTitle': '{remaining}% restante ({used}% usado)',
  'usage.remaining': '{percent}% restante',
  'usage.window': 'Límite',
  'usage.days': '{n, plural, one {Límite de # día} other {Límite de # días}}',
  'usage.hours': 'Límite de {n} h',
  'usage.minutes': 'Límite de {n} min',
  'usage.scoped': '{limit} · {scope}',
  'usage.resetsIn': 'Se restablece en {time} ({date})',
  'usage.exhausted': 'Agotado',
  'usage.refreshTitle': 'Actualizar los límites de uso de la cuenta actual',
  'usage.refreshAllTitle': 'Actualizar los límites de uso de todas las cuentas',
  'panel.loading': 'Cargando cuentas…',
  'tab.claude': 'Claude',
  'tab.codex': 'Codex',
  'tabs.ariaLabel': 'Tipo de cuenta',

  'claude.loginTitle': 'Ejecuta claude en un terminal para iniciar sesión',
  'codex.loginTitle': 'Ejecuta codex login en un terminal',
  'claude.terminalTitle': 'Ejecutar claude con esta cuenta en un terminal',
  'codex.terminalTitle': 'Ejecutar codex con esta cuenta en un terminal',
  'claude.loginHint': 'Pulsa «Acceder» para iniciar sesión en un terminal, o cambia de cuenta e inicia sesión en el panel de Claude',
  'codex.loginHint': 'Pulsa «Acceder» para iniciar sesión en un terminal, o cambia de cuenta e inicia sesión en el panel de Codex',
  'claude.mdTitle': 'Abrir CLAUDE.md global',
  'codex.mdTitle': 'Abrir AGENTS.md global',
  'claude.settingsTitle': 'Abrir ajustes de la extensión Claude Code',
  'codex.settingsTitle': 'Abrir ajustes de la extensión Codex',
  'claude.syncTitle': 'Volver a vincular las cuentas vinculadas a la cuenta predeterminada y sincronizar sus servidores MCP',
  'codex.syncTitle': 'Volver a vincular las cuentas vinculadas a la cuenta predeterminada',

  'account.default': 'Cuenta predeterminada',
  'account.loggedIn': 'Sesión iniciada',
  'account.notLoggedIn': 'Sin sesión',
  'account.sharedBadge': 'Comparte el contenido vinculado con la cuenta predeterminada; algunos archivos pueden seguir siendo independientes',

  'list.title': 'Todas las cuentas',
  'row.rename': 'Renombrar',
  'row.renameAria': 'Renombrar {name}',
  'row.switch': 'Cambiar a esta cuenta',
  'row.login': 'Acceder',
  'row.share': 'Vincular a la cuenta predeterminada: los ajustes, reglas, Skills, historial y sesiones se integran en ella y se comparten desde entonces; el inicio de sesión sigue siendo independiente',
  'row.unshare': 'Desvincular de la cuenta predeterminada: se eliminan los enlaces y se copia la configuración predeterminada para uso independiente; el historial y las sesiones permanecen en la cuenta predeterminada',
  'row.remove': 'Quitar cuenta',
  'rename.ariaLabel': 'Nombre visible',
  'rename.save': 'Guardar (Enter)',
  'confirm.text': '¿Quitar {name} de la lista?',
  'confirm.hint': 'Se te preguntará por separado si quieres eliminar el directorio de la cuenta.',
  'confirm.remove': 'Quitar',
  'confirm.cancel': 'Cancelar',

  'validate.labelEmpty': 'Introduce un nombre visible',
  'validate.labelTooLong': 'El nombre visible admite hasta {max, plural, one {# carácter} other {# caracteres}}',
  'validate.labelNewline': 'El nombre visible no admite saltos de línea',
  'validate.labelDuplicate': 'Coincide con el nombre de otra cuenta',
  'validate.nameChars': 'Solo se admiten A-Z, a-z, 0-9, guiones bajos (_) y guiones (-)',
  'validate.nameReserved': 'No se puede usar el nombre reservado default',
  'validate.nameExists': 'Ya existe una cuenta con este nombre',

  'add.title': 'Añadir cuenta',
  'add.placeholder': 'Nombre de cuenta, p. ej., work',
  'add.ariaLabel': 'Nombre de la nueva cuenta',
  'add.button': 'Añadir',
  'add.shared': 'Vincular ajustes e historial a la cuenta predeterminada',
  'claude.addHelpShared': 'Se creará {dir}, vinculado a los ajustes, reglas, Skills, historial y sesiones de la cuenta predeterminada',
  'codex.addHelpShared': 'Se creará {dir}, vinculado a los ajustes, reglas, Skills, historial, sesiones y bases de datos de conversaciones de la cuenta predeterminada (Memories se mantiene separado por cuenta)',
  'codex.addHelpSharedWin': 'Se creará {dir}, vinculado a los ajustes, reglas, Skills, historial y sesiones de la cuenta predeterminada (Memories y las bases de datos de conversaciones permanecen independientes por cuenta)',
  'add.help.independent': 'Se creará {dir} con una copia de la configuración predeterminada; desde entonces será independiente',
  'add.helpIdle': 'Cada cuenta usa su propio directorio de configuración {prefix}<name>',

  'disabled.title': 'Cambio de cuenta de Codex desactivado',
  'disabled.text': 'Al activarlo, cada cuenta usa su propio directorio CODEX_HOME (por defecto ~/.codex; las demás, ~/.codex-<name>). La extensión escribe un bloque delimitado en ~/.profile y ~/.bashrc que lee el directorio seleccionado de un archivo de estado.',
  'disabled.textWin': 'Al activarlo, cada cuenta usa su propio directorio CODEX_HOME (por defecto ~/.codex; las demás, ~/.codex-<name>). La extensión define la variable de entorno de usuario CODEX_HOME con el directorio seleccionado (se elimina para la cuenta predeterminada).',
  'disabled.restartWsl': 'Cambiar de cuenta requiere reiniciar el servidor WSL del editor; se desconectarán todas las ventanas WSL.',
  'disabled.restartLocal': 'Cambiar de cuenta requiere reiniciar este editor; se cerrarán todas sus ventanas y terminales integrados.',
  'disabled.restartRemote': 'Cambiar de cuenta requiere reiniciar el servidor del editor en el entorno remoto.',
  'disabled.enable': 'Activar cambio de cuenta de Codex',

  'pending.title': '{name} seleccionada; se aplicará al reiniciar el servidor',
  'pending.titleLocal': '{name} seleccionada; se aplicará al reiniciar el editor',
  'pending.text': 'Reiniciar el servidor desconecta todas las ventanas WSL (recárgalas o ábrelas de nuevo) y cierra los terminales integrados.',
  'pending.textLocalManual': 'Cierra por completo este editor y vuelve a abrirlo; no basta con recargar la ventana.',
  'pending.textRemote': 'Reinicia el servidor del editor en el entorno remoto y vuelve a conectarte.',

  'banner.title': 'Cuenta cambiada a {name}',
  'banner.text': 'Las nuevas sesiones usan la nueva cuenta; las abiertas siguen usando la anterior. Al recargar, todos los paneles empiezan de nuevo con la nueva cuenta.',
  'banner.dismiss': 'Cerrar aviso',

  'tools.title': 'Herramientas',
  'tools.settings': 'Ajustes',
  'tools.sync': 'Revincular',
  'tools.updateCli': 'Actualizar CLI',
  'tools.updateCliTitle': 'Actualizar CLI en un terminal',

  'footer.versions': 'Ver versiones de CLI y extensiones',
  'common.reloadWindow': 'Recargar ventana',
  'footer.restartExtHost': 'Reiniciar Extension Host',
  'footer.help': 'Guía de uso',
  'footer.star': 'Star',
  'footer.version': 'v{version}',

  'versions.title': 'Versiones de CLI y extensiones',
  'versions.close': 'Cerrar',
};

export const ja: Record<MessageKey, string> = {
  'usage.barTitle': '残り {remaining}%（使用済み {used}%）',
  'usage.remaining': '残り {percent}%',
  'usage.window': '利用枠',
  'usage.days': '{n} 日間の上限',
  'usage.hours': '{n} 時間の上限',
  'usage.minutes': '{n} 分間の上限',
  'usage.scoped': '{limit} · {scope}',
  'usage.resetsIn': '{time}後にリセット（{date}）',
  'usage.exhausted': '使い切り',
  'usage.refreshTitle': '現在のアカウントの使用量の上限を更新',
  'usage.refreshAllTitle': 'すべてのアカウントの使用量の上限を更新',
  'panel.loading': 'アカウントを読み込み中…',
  'tab.claude': 'Claude',
  'tab.codex': 'Codex',
  'tabs.ariaLabel': 'アカウントの種類',

  'claude.loginTitle': 'ターミナルで claude を実行してログイン',
  'codex.loginTitle': 'ターミナルで codex login を実行',
  'claude.terminalTitle': 'このアカウントでターミナルから claude を実行',
  'codex.terminalTitle': 'このアカウントでターミナルから codex を実行',
  'claude.loginHint': '「ログイン」からターミナルでログインするか、アカウントを切り替えて Claude パネルでログインしてください',
  'codex.loginHint': '「ログイン」からターミナルでログインするか、アカウントを切り替えて Codex パネルでログインしてください',
  'claude.mdTitle': 'グローバル CLAUDE.md を開く',
  'codex.mdTitle': 'グローバル AGENTS.md を開く',
  'claude.settingsTitle': 'Claude Code 拡張機能の設定を開く',
  'codex.settingsTitle': 'Codex 拡張機能の設定を開く',
  'claude.syncTitle': 'リンク済みアカウントを既定のアカウントに再リンクし、MCP サーバーを同期します',
  'codex.syncTitle': 'リンク済みアカウントを既定のアカウントに再リンクします',

  'account.default': '既定のアカウント',
  'account.loggedIn': 'ログイン済み',
  'account.notLoggedIn': '未ログイン',
  'account.sharedBadge': 'リンクした内容を既定のアカウントと共有。一部のファイルは独立したままの場合があります',

  'list.title': 'すべてのアカウント',
  'row.rename': '名前を変更',
  'row.renameAria': '{name} の名前を変更',
  'row.switch': 'このアカウントに切り替え',
  'row.login': 'ログイン',
  'row.share': '既定のアカウントにリンク：設定・ルール・Skills・履歴・セッションを既定のアカウントに統合し、以後は共有します。ログインは独立したままです',
  'row.unshare': '既定のアカウントとのリンクを解除：リンクを削除し、既定の設定のコピーを独立して使用します。履歴とセッションは既定のアカウントに残ります',
  'row.remove': 'アカウントを削除',
  'rename.ariaLabel': '表示名',
  'rename.save': '保存（Enter）',
  'confirm.text': '{name} を一覧から削除しますか？',
  'confirm.hint': 'アカウントのディレクトリも削除するかは、別途確認します。',
  'confirm.remove': '削除',
  'confirm.cancel': 'キャンセル',

  'validate.labelEmpty': '表示名を入力してください',
  'validate.labelTooLong': '表示名は {max} 文字以内で入力してください',
  'validate.labelNewline': '表示名に改行は使えません',
  'validate.labelDuplicate': '別のアカウントと名前が重複しています',
  'validate.nameChars': '使用できるのは A-Z、a-z、0-9、アンダースコア（_）、ハイフン（-）のみです',
  'validate.nameReserved': '予約名 default は使えません',
  'validate.nameExists': '同じ名前のアカウントがすでにあります',

  'add.title': 'アカウントを追加',
  'add.placeholder': 'アカウント名（例：work）',
  'add.ariaLabel': '新しいアカウント名',
  'add.button': '追加',
  'add.shared': '既定のアカウントの設定と履歴にリンク',
  'claude.addHelpShared': '{dir} を作成し、既定のアカウントの設定・ルール・Skills・履歴・セッションにリンクします',
  'codex.addHelpShared': '{dir} を作成し、既定のアカウントの設定・ルール・Skills・履歴・セッション・スレッドデータベースにリンクします（Memories はアカウントごとに独立）',
  'codex.addHelpSharedWin': '{dir} を作成し、既定のアカウントの設定・ルール・Skills・履歴・セッションにリンクします（Memories とスレッドデータベースはアカウントごとに独立）',
  'add.help.independent': '{dir} を作成し、既定の設定をコピーします。以後は独立して使用します',
  'add.helpIdle': 'アカウントごとに専用の設定ディレクトリ {prefix}<name> を使います',

  'disabled.title': 'Codex のアカウント切り替えは無効です',
  'disabled.text': '有効にすると、アカウントごとに専用の CODEX_HOME ディレクトリを使います（既定は ~/.codex、その他は ~/.codex-<name>）。拡張機能は ~/.profile と ~/.bashrc にマーカーブロックを書き込み、状態ファイルから選択中のディレクトリを読み取ります。',
  'disabled.textWin': '有効にすると、アカウントごとに専用の CODEX_HOME ディレクトリを使います（既定は ~/.codex、その他は ~/.codex-<name>）。拡張機能はユーザー環境変数 CODEX_HOME を選択中のディレクトリに設定します（既定のアカウントでは削除します）。',
  'disabled.restartWsl': '切り替えにはエディタの WSL サーバーの再起動が必要です。すべての WSL ウィンドウが切断されます。',
  'disabled.restartLocal': '切り替えにはエディタの再起動が必要です。すべてのウィンドウと統合ターミナルが閉じます。',
  'disabled.restartRemote': '切り替えにはリモート環境でエディタのサーバーを再起動する必要があります。',
  'disabled.enable': 'Codex の切り替えを有効化',

  'pending.title': '{name} を選択済み。サーバー再起動後に適用',
  'pending.titleLocal': '{name} を選択済み。エディタ再起動後に適用',
  'pending.text': '再起動すると、すべての WSL ウィンドウが切断され、統合ターミナルが閉じます。ウィンドウは再読み込みするか、開き直してください。',
  'pending.textLocalManual': 'エディタを完全に終了してから起動し直してください。ウィンドウの再読み込みだけでは適用されません。',
  'pending.textRemote': 'リモート環境でエディタのサーバーを再起動し、再接続してください。',

  'banner.title': '{name} に切り替えました',
  'banner.text': '新規セッションは新しいアカウントを使用します。既存のセッションは以前のアカウントのままです。再読み込みすると、すべてのパネルが新しいアカウントで最初から始まります。',
  'banner.dismiss': '通知を閉じる',

  'tools.title': 'ツール',
  'tools.settings': '設定',
  'tools.sync': '再リンク',
  'tools.updateCli': 'CLI を更新',
  'tools.updateCliTitle': 'ターミナルで CLI を更新',

  'footer.versions': 'CLI と拡張機能のバージョンを表示',
  'common.reloadWindow': 'ウィンドウを再読み込み',
  'footer.restartExtHost': 'Extension Host を再起動',
  'footer.help': '使い方',
  'footer.star': 'Star',
  'footer.version': 'v{version}',

  'versions.title': 'CLI と拡張機能のバージョン',
  'versions.close': '閉じる',
};

const TABLES: Record<Locale, Record<MessageKey, string>> = { en, 'zh-cn': zhCn, 'zh-tw': zhTw, es, ja };

// Per-locale metadata the Webview needs; the LOCALE_INFO rows of src/i18n.ts without userGuide (keep both in step)
export const WEB_LOCALE_INFO: Record<Locale, {
  intl: string;
  match: string[];
  sentenceSeparator: '' | ' ';
  durationStyle: 'narrow' | 'short';
  durationUnitSeparator: '' | ' ';
}> = {
  en: { intl: 'en', match: ['en'], sentenceSeparator: ' ', durationStyle: 'narrow', durationUnitSeparator: ' ' },
  'zh-cn': { intl: 'zh-CN', match: ['zh-cn', 'zh'], sentenceSeparator: '', durationStyle: 'narrow', durationUnitSeparator: '' },
  'zh-tw': { intl: 'zh-TW', match: ['zh-tw', 'zh-hk', 'zh-mo'], sentenceSeparator: '', durationStyle: 'short', durationUnitSeparator: ' ' },
  es: { intl: 'es', match: ['es'], sentenceSeparator: ' ', durationStyle: 'narrow', durationUnitSeparator: ' ' },
  ja: { intl: 'ja', match: ['ja'], sentenceSeparator: '', durationStyle: 'short', durationUnitSeparator: ' ' },
};

const LOCALE_IDS = Object.keys(WEB_LOCALE_INFO) as Locale[];

// Picks the locale for a language tag (lowercased first): a full-tag match first, then the primary subtag; English otherwise.
// A copy of matchLocale in src/i18n.ts
export function matchLocale(language: string): Locale {
  const tag = language.toLowerCase();
  const primary = tag.split('-')[0];
  return LOCALE_IDS.find((l) => WEB_LOCALE_INFO[l].match.includes(tag))
    ?? LOCALE_IDS.find((l) => WEB_LOCALE_INFO[l].match.includes(primary))
    ?? 'en';
}

// Before the first state arrives, guess from the webview's language (it follows the editor's display language)
let current: Locale = matchLocale(navigator.language.toLowerCase());

export function getLocale(): Locale {
  return current;
}

/** Sets the locale used by t(); an id without a table falls back to 'en'. */
export function setLocale(locale: Locale): void {
  current = TABLES[locale] ? locale : 'en';
}

// BCP 47 tag of a locale (the current one by default) for Intl APIs and <html lang>
export function intlLocale(locale?: Locale): string {
  return WEB_LOCALE_INFO[locale ?? current].intl;
}

const PLURAL_RE = /\{(\w+)\s*,\s*plural\s*,((?:\s*(?:zero|one|two|few|many|other)\s*\{[^{}]*(?:\{\w+\}[^{}]*)*\})+)\s*\}/g;
const BRANCH_RE = /(zero|one|two|few|many|other)\s*\{([^{}]*(?:\{\w+\}[^{}]*)*)\}/g;
const pluralRules = new Map<string, Intl.PluralRules>();

// Fills a message: ICU plural blocks `{name, plural, one {…} other {…}}` pick a branch by Intl.PluralRules of `intl`
// with `#` replaced by the count (left as-is when the count is missing or not a finite number), then `{name}`
// placeholders are replaced with params (unknown placeholders are left as-is). An identical copy of formatMessage in
// src/i18n.ts, whose comment documents the full syntax and edge cases
export function formatMessage(text: string, params: Record<string, string | number> | undefined, intl: string): string {
  if (!params) return text;
  const plural = text.replace(PLURAL_RE, (block, name: string, body: string) => {
    const count = Number(params[name]);
    if (!(name in params) || !Number.isFinite(count)) return block;
    const branches: Record<string, string> = {};
    for (const [, cat, branch] of body.matchAll(BRANCH_RE)) branches[cat] = branch;
    if (!('other' in branches)) return block;
    let rules = pluralRules.get(intl);
    if (!rules) pluralRules.set(intl, rules = new Intl.PluralRules(intl));
    return (branches[rules.select(count)] ?? branches.other).replaceAll('#', String(params[name]));
  });
  return plural.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Looks up a message in the current locale and fills its plural blocks and `{name}` placeholders (see formatMessage). */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return formatMessage(TABLES[current][key], params, WEB_LOCALE_INFO[current].intl);
}

// Joins translated sentences with the current locale's sentenceSeparator: Chinese and Japanese end sentences with a
// full-width stop and use no space after it
export function joinSentences(...sentences: string[]): string {
  return sentences.join(WEB_LOCALE_INFO[current].sentenceSeparator);
}
