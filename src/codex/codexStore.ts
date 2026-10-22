// Registered Codex accounts in the FileMemento (keys codex.accounts, codex.ignoredDirs and codex.order); the default account
// { CODEX_DEFAULT_NAME, codexDefaultDir() } is implicit. The behavior is AccountStoreBase's (src/accountStore.ts).
import type { StateMemento } from '../fileState';
import { AccountStoreBase } from '../accountStore';
import type { CodexAccount } from './codexPaths';
import { CODEX_DEFAULT_NAME, codexDefaultDir, scanCodexDirs } from './codexPaths';

export class CodexAccountStore extends AccountStoreBase<CodexAccount> {
  constructor(state: StateMemento) {
    super(state, { stateKey: 'codex.accounts', ignoredKey: 'codex.ignoredDirs', orderKey: 'codex.order', defaultName: CODEX_DEFAULT_NAME, defaultDir: codexDefaultDir, scan: scanCodexDirs });
  }
}
