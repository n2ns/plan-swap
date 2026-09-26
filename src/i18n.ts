// Host-side message tables and lookup. Must not import vscode so pure modules can use it.

export type Locale = 'en' | 'zh-cn';

// English is the source of truth for the key set.
export const en = {
  // Common
  'common.continue': 'Continue',
  'common.delete': 'Delete',
  'common.deleteDir': 'Delete Directory',
  'common.reloadWindow': 'Reload Window',
  'common.loggedIn': 'Logged in',
  'common.notLoggedIn': 'Not logged in',
  'common.noAccounts': 'No accounts to choose from.',
  'common.listSep': '; ',
  'common.nameSep': ', ',
  'account.external': 'External directory',
  'account.alreadyCurrent': '{label} is already the current account.',
  'account.dirMissing': 'Account directory does not exist: {dir}',
  'account.createDirFailed': 'Failed to create account directory: {error}',
  'account.removeDirPrompt': 'Account {label} was removed from the list. Also delete directory {dir}?',
  'account.deleteDirFailed': 'Failed to delete directory: {error}',

  // extension.ts
  'ext.linuxOnly': 'PlanSwap only supports WSL/Linux.',
  'ext.codexUnavailable': 'Codex account switching is unavailable: {error}',
  'ext.codexLegacyFailed': 'Cannot migrate the Codex switching setup of an earlier version (ai-switcher): {error}',

  // Account name validation (add account)
  'name.empty': 'Enter an account name',
  'name.invalid': 'Only letters, digits, underscores and hyphens are allowed',
  'name.reserved': 'Cannot use the reserved name {name}',
  'name.exists': 'An account with this name already exists',
  'name.dupLabel': "Same as an existing account's display name",
  'name.sameAsDefaultDir': 'This account directory is the same as the default account directory',

  // Display name validation (labels.validate)
  'label.empty': 'Enter a display name',
  'label.tooLong': 'Display name can be at most {max} characters',
  'label.newline': 'Display name cannot contain line breaks',
  'label.dupName': 'Same as an existing account name',

  // Claude commands
  'claude.switchFailed':
    'Switch failed. Possible causes: the official Claude Code extension is not installed or enabled in the current environment, or settings.json has a syntax error. Original error: {error}',
  'claude.switched':
    'Switched to {label}. New sessions will use this account; sessions already open are still using the old account.',
  'claude.removeCurrent': '{label} is the current account and cannot be deleted. Switch to another account first.',
  'claude.removeConfirm': 'Delete account {label}?',
  'claude.removeDirDetail':
    "The directory contains this account's login credentials and session history and cannot be recovered once deleted. If you just switched away from this account and have not reloaded the window, open sessions are still using this directory.",
  'share.removeDirDetail':
    "Linked data in the default account will be kept. This account directory and everything stored locally in it, including login credentials, per-account memories, backups and other unlinked files, will be permanently deleted.",
  'claude.pick.switch': 'Select the account to switch to',
  'claude.pick.remove': 'Select the account to delete',
  'claude.pick.terminal': 'Select the account to open claude with in a terminal',
  'claude.loginNotLanded':
    'Login did not land in this directory: no login info found under {dir}. Check whether ~/.bashrc or similar overrides CLAUDE_CONFIG_DIR, or reopen the terminal and log in again.',

  // Codex commands
  'codex.manualRestartHint':
    'Manual alternative: close all {editor} windows connected to this distro, wait at least 5 minutes, then reopen.',
  'codex.manualRestartHintVscode': 'Close all VS Code windows connected to this distro, wait a few seconds, then reopen them.',
  'codex.manualRestartHintUnknown':
    'Close all editor windows connected to this distro, wait at least 5 minutes, then reopen them. If the account has still not changed, run "wsl --shutdown" in Windows (this stops all WSL distros) and reopen.',
  'codex.manualRestartRequired': "This editor's WSL server cannot be restarted automatically. {hint}",
  'codex.manualRestartHintLocal':
    'When ready, fully exit this Linux editor instance and use the original launcher with CODEX_HOME set to the selected account directory (unset it for default). Preserve the profile and keyring setup; a dbus-run-session launcher must create a fresh session. Reload Window alone does not apply the new environment.',
  'codex.manualRestartRequiredLocal': 'This Linux editor cannot be restarted automatically. {hint}',
  'codex.switchConfirmManualLocal': 'Save this Codex account selection? It stays pending until you restart this Linux editor manually. {hint}',
  'codex.manualRestartHintRemote':
    'Restart the editor server in the remote environment with CODEX_HOME set to the selected account directory, then reconnect. For the default account, unset CODEX_HOME before restarting the server.',
  'codex.manualRestartRequiredRemote': 'Automatic restart is unavailable for this remote environment. {hint}',
  'codex.switchConfirmManualRemote': 'The new Codex account requires restarting the remote editor server. {hint} Continue?',
  'claude.switchConfirm': 'Switch the Claude account to {label}? New sessions will use it; sessions already open keep the current account until the window is reloaded.',
  'claude.switchButton': 'Switch',
  'codex.switchConfirm':
    "Switching the Codex account restarts {editor}'s WSL server: all WSL windows disconnect and prompt to reload, all extensions restart, and integrated terminals close. Continue?",
  'codex.switchConfirmManual':
    'The new Codex account takes effect only after the WSL server restarts, which this editor cannot do automatically. {hint} Continue?',
  'codex.restartConfirm':
    "Restart {editor}'s WSL server: all WSL windows disconnect and prompt to reload, all extensions restart, and integrated terminals close. Continue?",
  'codex.restartPlanFailed': 'Cannot restart the WSL server automatically: {error}\n{hint}',
  'codex.restartFailed': 'Failed to restart the WSL server: {error}\n{hint}',
  'codex.enableFailed': 'Cannot enable Codex account switching: {error}',
  'codex.enableFailedReasons': 'Cannot enable Codex account switching:\n{reasons}',
  'codex.enableConfirm':
    'The following marker block will be written to ~/.profile and ~/.bashrc to set CODEX_HOME in login shells. Continue?',
  'codex.enableButton': 'Write',
  'codex.writeRcFailed': 'Failed to write rc files: {error}',
  'codex.rollbackFailedSuffix': '\nRollback failed: {errors}',
  'codex.selfCheckFailed': 'Self-check failed; rc files were rolled back: {detail}',
  'codex.selfCheckFailedRollbackFailed': 'Self-check failed: {detail}\nRollback failed: {errors}',
  'codex.disableConfirm':
    'The marker blocks in ~/.profile and ~/.bashrc will be removed and the selected Codex account cleared. CODEX_HOME in open windows does not change until the editor or its server restarts. Continue?',
  'codex.disableButton': 'Disable',
  'codex.disableFailed': 'Failed to disable: {error}',
  'codex.writeStateFailed': 'Failed to write the state file: {error}',
  'codex.seedSkipped': 'Account {name} was created; the following files were not copied:\n{list}',
  'codex.seedSkippedItem': '{file}: {reason}',
  'codex.removeEffective':
    '{label} is the account in effect in this window and cannot be deleted. Switch to another account first.',
  'codex.removeSelected':
    '{label} is the selected account waiting for a restart to take effect and cannot be deleted. Switch to another account first.',
  'codex.removeConfirm': 'Delete Codex account {label}?',
  'codex.removeDirDetail':
    "The directory contains this account's login credentials, sessions and local data and cannot be recovered once deleted.",
  'codex.pick.switch': 'Select the Codex account to switch to',
  'codex.pick.remove': 'Select the Codex account to delete',
  'codex.pick.terminal': 'Select the account to run codex with in a terminal',

  // codexPaths.copyCodexSeed skip reasons
  'codex.seed.srcMissing': 'Source file does not exist',
  'codex.seed.dstExists': 'Target already exists',
  'codex.seed.readFailed': 'Failed to read source file',
  'codex.seed.hasSection': 'Contains a {section} section',
  'codex.seed.hasTopKey': 'Contains top-level key {key}',
  'codex.seed.blocked': '{reason}; not copied',

  // codexState.preCheck / removeRcBlocks / selfCheck
  'codex.pre.notBash': 'Login shell is not bash (current SHELL={shell}); only bash is supported',
  'codex.pre.shellUnset': 'unset',
  'codex.pre.bashProfile': '{file} exists and does not source ~/.bashrc; login shells will not read ~/.profile',
  'codex.pre.broken': 'Marker block is incomplete; please fix {file} manually',
  'codex.pre.userExport': '{file} already has your own export CODEX_HOME, which conflicts',
  'codex.rc.missingEnd': 'Marker block is incomplete (missing end marker); please check {file} manually',
  'codex.self.bashFailed': 'Cannot run bash: {error}',
  'codex.self.mismatch': 'CODEX_HOME in the login shell is "{actual}", expected "{expected}"{stderr}',
  'codex.self.stderr': '; stderr: {stderr}',
  'codex.self.error': 'Self-check error: {error}',

  // codexServer.planRestart
  'server.statUnparseable': 'Cannot parse stat format',
  'server.notFound': 'Cannot find the WSL server process',
  'server.unsupported': 'Parent process is not a WSL server that supports automatic restart: {cmdline}',
  'server.noCommit': 'Cannot read the server commit from product.json',
  'server.pidReadFailed': 'Failed to read pid file: {file}',
  'server.pidMismatch': 'The pid file does not match the server process',

  // paths.checkSafeToDelete / codexPaths.checkCodexSafeToDelete
  'del.notHomeChild': 'Directory is not a direct child of the home directory: {dir}',
  'del.badName': 'Directory name does not match the {pattern} format: {dir}',
  'del.isDefault': 'Cannot delete the default account directory: {dir}',
  'del.missing': 'Directory does not exist: {dir}',
  'del.symlink': 'Directory is a symbolic link; refusing to delete: {dir}',
  'del.notDir': 'Path is not a directory: {dir}',
  'mcp.badTarget': 'Not a valid JSON object, left unchanged: {file}',
  'mcp.changed': 'Changed by Claude Code while syncing, left unchanged; try again: {file}',
  'share.busy': 'Claude Code is still running with account {name}; close its sessions and try again.',
  'share.badSource': "The default account's info file is not a valid JSON object; nothing was synced: {file}",
  'share.busyCodex': "Codex is still running with account {name}; close it (including the editor's Codex panel sessions) and try again.",
  'del.daemonAlive': "This account's codex daemon is still running; refusing to delete: {dir}",

  // tools.ts
  'tools.updateCli': 'Update {vendor} CLI',
  'tools.codexNotInit': 'The Codex part is not initialized; cannot restart.',
  'tools.syncNotInit': 'The {vendor} part is not initialized; cannot re-link linked accounts.',
  'tools.pick.sync': 'Select the vendor whose linked accounts to re-link',
  'sync.none': 'No linked {vendor} accounts to re-link.',
  'sync.attempted': 'Attempted to re-link {count} linked {vendor} account(s).',
  'sync.done': 'Re-linked {count} linked {vendor} account(s) to the default account.',
  'sync.issues': 'Needs attention: {list}',
  'sync.item': '{name}: {notes}',
  'share.addNotes': 'Account {name} was created and linked, but: {notes}',
  'share.addLinkFailed': 'Account {name} was created, but linking it to the default account failed: {error}',
  'share.addCopyFailed': "Account {name} was created, but copying the default account's configuration failed: {error}",
  'share.current': 'Switch away from {label} before linking it.',
  'share.confirm': "Link {label} to the default account? Its history, memory, settings and other folders in {dir} are moved into the default account and replaced by links; the login stays. Files that differ from the default account's are kept for manual merging: inside linked folders next to the default file with a .from-<name> suffix, top-level files in the account directory as <file>.independent-backup. This cannot be undone automatically.",
  'share.confirmButton': 'Link',
  'share.confirmCodex': "Link {label} to the default account? Its sessions, history, settings, rules, skills and thread databases in {dir} are moved into the default account and replaced by links; the login and memories stay per account. Files that differ from the default account's are kept for manual merging: inside linked folders next to the default file with a .from-<name> suffix; config.toml, AGENTS.md, hooks.json and the thread databases in the account directory as <file>.independent-backup. Resuming a session started by another ChatGPT account may be rejected by the server. This cannot be undone automatically.",
  'share.done': '{label} is now linked to the default account. {summary}',
  'share.nothingElse': 'Nothing needed manual attention.',
  'share.failed': 'Linking {label} stopped: {error}',
  'unshare.current': 'Switch away from {label} before unlinking it.',
  'unshare.confirm': 'Unlink {label} from the default account? The links in {dir} are removed and the account gets its own copy of the default settings, rules, skills and MCP servers. Its history and sessions stay in the default account; the account starts without any. The login stays. This cannot be undone automatically.',
  'unshare.confirmCodex': 'Unlink {label} from the default account? The links in {dir} are removed and the account gets its own copy of the default configuration, rules and skills. Its sessions, history and thread databases stay in the default account; the account starts without any. The login and memories stay. This cannot be undone automatically.',
  'unshare.confirmButton': 'Unlink',
  'unshare.done': '{label} is now independent: removed {removed} link(s), copied {copied}.',
  'unshare.nothingCopied': 'nothing',
  'unshare.skipped': 'Not copied: {list}.',
  'unshare.failed': 'Unlinking {label} stopped: {error}',
  'unshare.default': 'The default directory cannot be made independent: {dir}',
  'unshare.notShared': 'Not a linked account: {dir}',
  'share.refreshWarning': 'Re-linking {label} to the default account reported: {notes}',
  'share.r.moved': 'moved {count} file(s) into the default account',
  'share.r.duplicates': 'dropped {count} identical file(s)',
  'share.r.keptBoth': 'kept both versions, merge manually: {list}',
  'share.r.backups': 'backed up: {list}',
  'share.r.conflicts': 'kept the account\'s own: {list}',
  'share.r.refused': 'not linked for safety: {list}',
  'tools.fileMissingCreate': 'File does not exist. Create it?\n{file}',
  'tools.create': 'Create',
  'tools.createFailed': 'Failed to create file: {error}',
  'tools.openFailed': 'Failed to open file: {error}',
  'tools.ver.notFound': 'Not found',
  'tools.ver.timeout': 'Timed out',
  'tools.ver.failed': 'Failed: {error}',
  'tools.ver.noOutput': '(no output)',
  'tools.ver.claudeExt': 'Claude Code extension',
  'tools.ver.codexExt': 'Codex extension',
  'tools.ver.placeholder': 'CLI and extension versions (display only)',
  'tools.pick.settings': 'Select the extension whose settings to open',
};

export type MessageKey = keyof typeof en;

export const zhCn: Record<MessageKey, string> = {
  'common.continue': '继续',
  'common.delete': '删除',
  'common.deleteDir': '删除目录',
  'common.reloadWindow': '重新加载窗口',
  'common.loggedIn': '已登录',
  'common.notLoggedIn': '未登录',
  'common.noAccounts': '没有可选择的账号。',
  'common.listSep': '；',
  'common.nameSep': '、',
  'account.external': '外部目录',
  'account.alreadyCurrent': '{label} 已是当前账号。',
  'account.dirMissing': '账号目录不存在：{dir}',
  'account.createDirFailed': '创建账号目录失败：{error}',
  'account.removeDirPrompt': '账号 {label} 已从列表移除。是否同时删除目录 {dir}？',
  'account.deleteDirFailed': '删除目录失败：{error}',

  'ext.linuxOnly': 'PlanSwap仅支持 WSL/Linux。',
  'ext.codexUnavailable': 'Codex 账号切换不可用：{error}',
  'ext.codexLegacyFailed': '无法迁移旧版本（ai-switcher）的 Codex 切换配置：{error}',

  'name.empty': '请输入账号名',
  'name.invalid': '只能包含字母、数字、下划线和连字符',
  'name.reserved': '不能使用保留名 {name}',
  'name.exists': '已存在同名账号',
  'name.dupLabel': '与已有账号的显示名相同',
  'name.sameAsDefaultDir': '该账号目录与默认账号目录相同',

  'label.empty': '请输入显示名',
  'label.tooLong': '显示名最多 {max} 个字符',
  'label.newline': '显示名不能包含换行',
  'label.dupName': '与已有账号名相同',

  'claude.switchFailed':
    '切换失败。可能原因：当前环境未安装或启用官方 Claude Code 插件；或 settings.json 存在语法错误。原始错误：{error}',
  'claude.switched': '已切换到 {label}。新会话将使用该账号，已打开的会话仍在使用旧账号。',
  'claude.removeCurrent': '{label} 是当前账号，不能删除。请先切换到其他账号。',
  'claude.removeConfirm': '确定删除账号 {label}？',
  'claude.removeDirDetail':
    '目录内含该账号的登录凭据与会话历史，删除后无法恢复。若刚从该账号切走且尚未重新加载窗口，已打开的会话仍在使用此目录。',
  'claude.pick.switch': '选择要切换到的账号',
  'claude.pick.remove': '选择要删除的账号',
  'claude.pick.terminal': '选择要在终端中打开 claude 的账号',
  'claude.loginNotLanded':
    '登录未落到该目录：{dir} 下未检测到登录信息。请检查 ~/.bashrc 等是否覆盖了 CLAUDE_CONFIG_DIR，或重新打开终端登录。',

  'codex.manualRestartHint': '手动方式：关闭所有连接到该发行版的 {editor} 窗口，等待至少 5 分钟后重新打开。',
  'codex.manualRestartHintVscode': '关闭所有连接到该发行版的 VS Code 窗口，等待几秒后重新打开。',
  'codex.manualRestartHintUnknown': '关闭所有连接到该发行版的编辑器窗口，等待至少 5 分钟后重新打开；若账号仍未切换，请在 Windows 中运行 "wsl --shutdown"（会停止所有 WSL 发行版）后重新打开。',
  'codex.manualRestartRequired': '无法自动重启此编辑器的 WSL 服务端。{hint}',
  'codex.manualRestartHintLocal': '准备好后，请完全退出当前 Linux 编辑器实例，通过原启动方式重新打开，并将 CODEX_HOME 设为所选账号目录（默认账号则取消设置）。保留原配置和密钥环环境；使用 dbus-run-session 时需重新创建会话。仅重新加载窗口不会应用新的环境变量。',
  'codex.manualRestartRequiredLocal': '当前 Linux 编辑器不支持自动重启。{hint}',
  'codex.switchConfirmManualLocal': '保存此 Codex 账号选择？手动重启当前 Linux 编辑器后才会生效。{hint}',
  'codex.manualRestartHintRemote': '请在远程环境中重启编辑器服务端，启动时将 CODEX_HOME 设置为所选账号目录，然后重新连接。切回默认账号时，请在重启服务端前取消设置 CODEX_HOME。',
  'codex.manualRestartRequiredRemote': '当前远程环境不支持自动重启。{hint}',
  'codex.switchConfirmManualRemote': '新 Codex 账号需要重启远程编辑器服务端后才生效。{hint}继续？',
  'claude.switchConfirm': '将 Claude 账号切换到 {label}？新会话将使用该账号，已打开的会话在重新加载窗口前仍使用当前账号。',
  'claude.switchButton': '切换',
  'codex.switchConfirm':
    '切换 Codex 账号会重启 {editor} 的 WSL 服务端：所有 WSL 窗口会断开并提示重新加载，所有扩展重启，集成终端关闭。继续？',
  'codex.switchConfirmManual': '新 Codex 账号要在 WSL 服务端重启后才生效，此编辑器无法自动重启。{hint}继续？',
  'codex.restartConfirm':
    '重启 {editor} 的 WSL 服务端：所有 WSL 窗口会断开并提示重新加载，所有扩展重启，集成终端关闭。继续？',
  'codex.restartPlanFailed': '无法自动重启 WSL 服务端：{error}\n{hint}',
  'codex.restartFailed': '重启 WSL 服务端失败：{error}\n{hint}',
  'codex.enableFailed': '无法启用 Codex 账号切换：{error}',
  'codex.enableFailedReasons': '无法启用 Codex 账号切换：\n{reasons}',
  'codex.enableConfirm': '将在 ~/.profile 与 ~/.bashrc 中写入以下标记块，用于在登录 shell 中设置 CODEX_HOME。继续？',
  'codex.enableButton': '写入',
  'codex.writeRcFailed': '写入 rc 文件失败：{error}',
  'codex.rollbackFailedSuffix': '\n回滚失败：{errors}',
  'codex.selfCheckFailed': '自检失败，已回滚 rc 文件：{detail}',
  'codex.selfCheckFailedRollbackFailed': '自检失败：{detail}\n回滚失败：{errors}',
  'codex.disableConfirm':
    '将删除 ~/.profile 与 ~/.bashrc 中的标记块并清除已选择的 Codex 账号。已打开窗口的 CODEX_HOME 在重启编辑器或其服务端前不变。继续？',
  'codex.disableButton': '停用',
  'codex.disableFailed': '停用失败：{error}',
  'codex.writeStateFailed': '写入状态文件失败：{error}',
  'codex.seedSkipped': '账号 {name} 已创建，以下文件未复制：\n{list}',
  'codex.seedSkippedItem': '{file}：{reason}',
  'codex.removeEffective': '{label} 是本窗口生效的账号，不能删除。请先切换到其他账号。',
  'codex.removeSelected': '{label} 是已选择、等待重启后生效的账号，不能删除。请先切换到其他账号。',
  'codex.removeConfirm': '确定删除 Codex 账号 {label}？',
  'codex.removeDirDetail': '目录内含该账号的登录凭据、会话与本地数据，删除后无法恢复。',
  'share.removeDirDetail': '默认账号中的链接目标会保留。本账号目录及其中本地存储的全部内容（包括登录凭据、独立记忆、备份和其他未链接文件）将永久删除。',
  'codex.pick.switch': '选择要切换到的 Codex 账号',
  'codex.pick.remove': '选择要删除的 Codex 账号',
  'codex.pick.terminal': '选择要在终端中运行 codex 的账号',

  'codex.seed.srcMissing': '源文件不存在',
  'codex.seed.dstExists': '目标已存在',
  'codex.seed.readFailed': '源文件读取失败',
  'codex.seed.hasSection': '含 {section} 段',
  'codex.seed.hasTopKey': '含顶层键 {key}',
  'codex.seed.blocked': '{reason}，不复制',

  'codex.pre.notBash': '登录 shell 不是 bash（当前 SHELL={shell}），仅支持 bash',
  'codex.pre.shellUnset': '未设置',
  'codex.pre.bashProfile': '存在 {file} 且未 source ~/.bashrc，登录 shell 不会读取 ~/.profile',
  'codex.pre.broken': '标记块不完整，请手工修复 {file}',
  'codex.pre.userExport': '{file} 中已有用户自己的 export CODEX_HOME，存在冲突',
  'codex.rc.missingEnd': '标记块不完整（缺少结束标记），请手工检查 {file}',
  'codex.self.bashFailed': '无法运行 bash：{error}',
  'codex.self.mismatch': '登录 shell 中 CODEX_HOME 为 "{actual}"，预期 "{expected}"{stderr}',
  'codex.self.stderr': '；stderr：{stderr}',
  'codex.self.error': '自检出错：{error}',

  'server.statUnparseable': 'stat 格式无法解析',
  'server.notFound': '找不到 WSL 服务端进程',
  'server.unsupported': '父进程不是支持自动重启的 WSL 服务端：{cmdline}',
  'server.noCommit': '无法从 product.json 读取服务端 commit',
  'server.pidReadFailed': '读取 pid 文件失败：{file}',
  'server.pidMismatch': 'pid 文件与服务端进程不匹配',

  'del.notHomeChild': '目录不是用户主目录的直接子目录：{dir}',
  'del.badName': '目录名不符合 {pattern} 格式：{dir}',
  'del.isDefault': '不能删除默认账号目录：{dir}',
  'del.missing': '目录不存在：{dir}',
  'del.symlink': '目录是符号链接，拒绝删除：{dir}',
  'del.notDir': '路径不是目录：{dir}',
  'mcp.badTarget': '不是有效的 JSON 对象，未作修改：{file}',
  'mcp.changed': '同步期间被 Claude Code 修改，未作修改，请重试：{file}',
  'share.busy': '账号 {name} 仍有 Claude Code 在运行，请关闭其会话后重试。',
  'share.badSource': '默认账号的信息文件不是有效的 JSON 对象，未作同步：{file}',
  'share.busyCodex': '账号 {name} 仍有 Codex 在运行，请先关闭（包括编辑器 Codex 面板里的会话）后重试。',
  'del.daemonAlive': '该账号的 codex 守护进程仍在运行，拒绝删除：{dir}',

  'tools.updateCli': '更新 {vendor} CLI',
  'tools.codexNotInit': 'Codex 部分未初始化，无法重启。',
  'tools.syncNotInit': '{vendor} 部分未初始化，无法重新链接账号。',
  'tools.pick.sync': '选择要重新链接账号的厂家',
  'sync.none': '没有可重新链接的 {vendor} 链接账号。',
  'sync.attempted': '已尝试重新链接 {count} 个 {vendor} 账号。',
  'sync.done': '已把 {count} 个 {vendor} 链接账号重新链接到默认账号。',
  'sync.issues': '需要处理：{list}',
  'sync.item': '{name}：{notes}',
  'share.addNotes': '账号 {name} 已创建并链接，但：{notes}',
  'share.addLinkFailed': '账号 {name} 已创建，但链接到默认账号失败：{error}',
  'share.addCopyFailed': '账号 {name} 已创建，但复制默认账号的配置失败：{error}',
  'share.current': '请先切换到其他账号，再把 {label} 链接到默认账号。',
  'share.confirm': '把 {label} 链接到默认账号？{dir} 里的会话历史、记忆、设置和其他文件夹会移入默认账号并换成链接，登录保持不变。与默认账号不同的文件会保留下来供手动合并：链接文件夹里的文件以 .from-<名字> 后缀保存在默认文件旁边，顶层文件则在账号目录里改名为 <文件名>.independent-backup。此操作无法自动撤销。',
  'share.confirmButton': '链接',
  'share.confirmCodex': '把 {label} 链接到默认账号？{dir} 里的会话、历史、设置、规则、技能和会话数据库会移入默认账号并换成链接，登录和记忆仍按账号独立。与默认账号不同的文件会保留下来供手动合并：链接文件夹里的文件以 .from-<名字> 后缀保存在默认文件旁边，config.toml、AGENTS.md、hooks.json 和会话数据库则在账号目录里改名为 <文件名>.independent-backup。续接由其他 ChatGPT 账号开始的会话可能被服务器拒绝。此操作无法自动撤销。',
  'share.done': '{label} 已链接到默认账号。{summary}',
  'share.nothingElse': '没有需要手动处理的内容。',
  'share.failed': '链接 {label} 时中止：{error}',
  'unshare.current': '请先切换到其他账号，再把 {label} 与默认账号拆分。',
  'unshare.confirm': '把 {label} 与默认账号拆分？会移除 {dir} 里的链接，并复制一份默认账号的设置、规则、技能和 MCP 服务器给它。会话历史和会话记录留在默认账号，此账号从空白开始。登录保持不变。此操作无法自动撤销。',
  'unshare.confirmCodex': '把 {label} 与默认账号拆分？会移除 {dir} 里的链接，并复制一份默认账号的配置、规则和技能给它。会话、历史和会话数据库留在默认账号，此账号从空白开始。登录和记忆保持不变。此操作无法自动撤销。',
  'unshare.confirmButton': '拆分',
  'unshare.done': '{label} 已改为独立账号：移除了 {removed} 个链接，复制了 {copied}。',
  'unshare.nothingCopied': '无',
  'unshare.skipped': '未复制：{list}。',
  'unshare.failed': '拆分 {label} 时中止：{error}',
  'unshare.default': '默认目录不能改为独立账号：{dir}',
  'unshare.notShared': '不是链接账号：{dir}',
  'share.refreshWarning': '重新链接 {label} 到默认账号时提示：{notes}',
  'share.r.moved': '已把 {count} 个文件移入默认账号',
  'share.r.duplicates': '删除了 {count} 个完全相同的文件',
  'share.r.keptBoth': '两个版本都已保留，请手动合并：{list}',
  'share.r.backups': '已备份：{list}',
  'share.r.conflicts': '保留了账号自己的：{list}',
  'share.r.refused': '出于安全未链接：{list}',
  'tools.fileMissingCreate': '文件不存在，是否创建？\n{file}',
  'tools.create': '创建',
  'tools.createFailed': '创建文件失败：{error}',
  'tools.openFailed': '打开文件失败：{error}',
  'tools.ver.notFound': '未找到',
  'tools.ver.timeout': '执行超时',
  'tools.ver.failed': '执行失败：{error}',
  'tools.ver.noOutput': '（无输出）',
  'tools.ver.claudeExt': 'Claude Code 插件',
  'tools.ver.codexExt': 'Codex 插件',
  'tools.ver.placeholder': 'CLI 与插件版本（仅展示）',
  'tools.pick.settings': '选择要打开设置的插件',
};

const tables: Record<Locale, Record<MessageKey, string>> = { en, 'zh-cn': zhCn };

let current: Locale = 'en';

export function setLocale(l: Locale): void {
  current = l;
}

export function getLocale(): Locale {
  return current;
}

/** Looks up a message in the current locale and fills `{name}` placeholders; unknown placeholders are left as-is. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = tables[current][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** The message in every locale (e.g. to reserve all localized display names). */
export function translationsOf(key: MessageKey): string[] {
  return Object.values(tables).map((table) => table[key]);
}
