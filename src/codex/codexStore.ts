// Registered Codex accounts in the FileMemento (keys codex.accounts and codex.ignoredDirs); the default account
// { CODEX_DEFAULT_NAME, codexDefaultDir() } is implicit. The behavior is AccountStoreBase's (src/accountStore.ts).
import type { Memento } from 'vscode';
import { AccountStoreBase } from '../accountStore';
import type { CodexAccount } from './codexPaths';
import { CODEX_DEFAULT_NAME, codexDefaultDir, scanCodexDirs } from './codexPaths';

export class CodexAccountStore extends AccountStoreBase<CodexAccount> {
  constructor(state: Memento) {
    super(state, { stateKey: 'codex.accounts', ignoredKey: 'codex.ignoredDirs', defaultName: CODEX_DEFAULT_NAME, defaultDir: codexDefaultDir, scan: scanCodexDirs });
  }
}
