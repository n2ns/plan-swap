// Synthetic, local-only measurements. This is not a UI benchmark or a performance gate.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AccountStore } from '../../src/accounts';
import { claudePanelSource } from '../../src/accountsPanel';
import { IdentityWarnings, claudeIdentity } from '../../src/identityWarnings';
import { LabelStore } from '../../src/labels';
import { readAccountInfo, type Account } from '../../src/paths';
import { StatusBar } from '../../src/statusBar';
import { makeTempHome, MemoryMemento } from '../helpers';
import { resetConfig } from '../stubs/vscode';

const WARMUPS = 5;
const ACCOUNT_COUNTS = [1, 10, 50];
const FILE_SIZES = [1024, 256 * 1024, 1024 * 1024];

function measure(fn: () => void, samples: number) {
  for (let i = 0; i < WARMUPS; i++) fn();
  const timings: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    fn();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);

  // Instrument one separate invocation after timing; the wrappers never affect the measured durations.
  const mutableFs: typeof fs = require('node:fs');
  const originalRead = mutableFs.readFileSync;
  const originalParse = JSON.parse;
  let readCalls = 0;
  let parseCalls = 0;
  let bytesRead = 0;
  try {
    mutableFs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const content = originalRead(...args);
      readCalls++;
      bytesRead += typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
      return content;
    }) as typeof fs.readFileSync;
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      parseCalls++;
      return originalParse(text, reviver);
    }) as typeof JSON.parse;
    fn();
  } finally {
    mutableFs.readFileSync = originalRead;
    JSON.parse = originalParse;
  }
  const percentile = (fraction: number) => timings[Math.ceil(fraction * timings.length) - 1];
  return {
    medianMs: percentile(0.5), p95Ms: percentile(0.95),
    readCallsPerCycle: readCalls, parseCallsPerCycle: parseCalls, bytesReadPerCycle: bytesRead,
  };
}

function runCase(accountCount: number, fileSizeBytes: number) {
  const temp = makeTempHome(`perf-${accountCount}-${fileSizeBytes}`);
  try {
    const named: Account[] = [];
    const dirs = [path.join(temp.home, '.claude')];
    fs.mkdirSync(dirs[0]);
    for (let i = 1; i < accountCount; i++) {
      const dir = path.join(temp.home, `.claude-perf${i}`);
      fs.mkdirSync(dir);
      dirs.push(dir);
      named.push({ name: `perf${i}`, dir });
    }
    const info = { oauthAccount: {
      emailAddress: 'synthetic@example.invalid', organizationType: 'claude_pro',
      accountUuid: 'synthetic-user', organizationUuid: 'synthetic-org',
    }, filler: '' };
    const baseBytes = Buffer.byteLength(JSON.stringify(info));
    info.filler = 'x'.repeat(Math.max(0, fileSizeBytes - baseBytes));
    const payload = JSON.stringify(info);
    fs.writeFileSync(path.join(temp.home, '.claude.json'), payload);
    for (const dir of dirs.slice(1)) fs.writeFileSync(path.join(dir, '.claude.json'), payload);

    const memento = new MemoryMemento();
    memento.data.set('accounts', named);
    const store = new AccountStore(memento);
    const labels = new LabelStore(memento, 'claude.labels');
    const source = claudePanelSource(store, labels);
    const statusBar = new StatusBar(store, labels);
    const identityWarnings = new IdentityWarnings([{
      vendor: 'Claude',
      accounts: () => store.all().map((a) => ({ dir: a.dir, label: a.name })),
      identityOf: claudeIdentity,
    }], () => {});
    try {
      const direct = () => { for (const dir of dirs) readAccountInfo(dir); };
      const panel = () => {
        if (source.accounts().length !== accountCount) throw Error('synthetic account count mismatch');
      };
      // Mirrors the Claude reads in AccountsPanel.pushState() and its extension.ts onDidChange callback.
      // It excludes file watchers, Codex, Webview messaging and rendering.
      const combined = () => { panel(); statusBar.update(); identityWarnings.check(); };
      const samples = accountCount === 50 && fileSizeBytes === 1024 * 1024 ? 25 : 50;
      return {
        accountCount, jsonBytesEach: Buffer.byteLength(payload), samples,
        direct: measure(direct, samples),
        panelSource: measure(panel, samples),
        combinedClaudeReads: measure(combined, samples),
      };
    } finally {
      statusBar.dispose();
    }
  } finally {
    temp.restore();
  }
}

resetConfig();
const cases = [];
for (const accountCount of ACCOUNT_COUNTS) {
  for (const fileSizeBytes of FILE_SIZES) cases.push(runCase(accountCount, fileSizeBytes));
}
process.stdout.write(JSON.stringify({
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  warmups: WARMUPS,
  layers: {
    direct: 'readAccountInfo once per synthetic account',
    panelSource: 'claudePanelSource.accounts()',
    combinedClaudeReads: 'panelSource + StatusBar.update + IdentityWarnings.check; excludes watchers, Codex and Webview',
  },
  instrumentation: 'readFileSync and JSON.parse counts are taken in a separate invocation after timing',
  cases,
}) + '\n');
