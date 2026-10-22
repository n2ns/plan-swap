// Registered Claude accounts in the state file (FileMemento): key 'accounts' (named accounts only; the default is
// implicit), 'ignoredDirs' and 'claude.order'. The behavior is AccountStoreBase's (src/accountStore.ts). Imports no vscode.
import type { StateMemento } from './fileState';
import { AccountStoreBase } from './accountStore';
import type { Account } from './paths';
import { DEFAULT_NAME, defaultDir, scanAccountDirs } from './paths';

export class AccountStore extends AccountStoreBase<Account> {
  constructor(state: StateMemento) {
    super(state, { stateKey: 'accounts', ignoredKey: 'ignoredDirs', orderKey: 'claude.order', defaultName: DEFAULT_NAME, defaultDir, scan: scanAccountDirs });
  }
}
