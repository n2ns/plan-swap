// "Refresh usage limits of all accounts" for either product: the orchestration both share (re-entrancy, the manual
// cooldown split, the cancellable progress notification, the result messages), with the product differences as
// options. The per-account query, which joins a running refresh of the current / effective account, is the caller's.
import * as vscode from 'vscode';
import { queryEach, type UsageTarget } from './claudeUsage';
import { joinSentences, t, type MessageKey } from './i18n';

/** A query result of either product: a failure carries its detail ('cancelled' for a query the user ended). */
export type RefreshResult = { ok: true } | { ok: false; detail?: string };
/** A query that threw, as queryEach reports it */
export type RefreshThrew = { ok: false; reason: 'failed'; detail: string };

export interface RefreshAllOptions<R extends RefreshResult> {
  /** The product's messages: no eligible account, progress ({label}, {done}, {total}), cancelled ({ok}, {n}),
   *  done ({n}) and failed ({ok}, {n}, {failures}). */
  keys: { none: MessageKey; progress: MessageKey; cancelled: MessageKey; done: MessageKey; failed: MessageKey };
  /** The registered accounts a run may query (signed in, not an API card), in sidebar order */
  eligible(): UsageTarget[];
  /** Milliseconds left of the account's manual cooldown; 0 when it may be queried now */
  cooldownLeft(dir: string): number;
  /** One account's query; signal aborts when the user cancels the run */
  query(dir: string, signal: AbortSignal): Promise<R>;
  /** The localized failure of one account for the final warning */
  failureText(dir: string, result: Extract<R, { ok: false }> | RefreshThrew): string;
  /** Called once after the run, before the messages (the panel and status bar re-render) */
  afterRun(): void;
}

export interface RefreshAll {
  /** Runs the refresh; a call while one runs is ignored */
  run(): Promise<void>;
  /** Whether a run is in progress (the background checks of other accounts stop while one is) */
  running(): boolean;
}

interface CooldownSplit { due: UsageTarget[]; skipped: UsageTarget[]; waitMs: number }

/** Refresh-all targets that may be queried now, and those still in the manual cooldown (with the shortest wait left). */
export function splitCooldown(targets: UsageTarget[], remaining: (dir: string) => number): CooldownSplit {
  const split: CooldownSplit = { due: [], skipped: [], waitMs: Infinity };
  for (const target of targets) {
    const left = remaining(target.dir);
    if (left > 0) {
      split.skipped.push(target);
      split.waitMs = Math.min(split.waitMs, left);
    } else split.due.push(target);
  }
  return split;
}

/** Seconds shown for a cooldown wait, rounded up so "try again in N s" is never too early. */
export const cooldownSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

// At most this many failed accounts are named so the notification stays readable
const NAMED_FAILURES = 3;

/**
 * One product's refresh-all: every eligible account one after another (the caller's query serializes the CLI
 * processes). A second call while one runs is ignored; accounts still in the manual cooldown are skipped and counted
 * in the final message; cancelling aborts the running query, and a query the cancellation ended is neither a success
 * nor a failure. No eligible account or every account in its cooldown only shows an information message.
 */
export function createRefreshAll<R extends RefreshResult>(options: RefreshAllOptions<R>): RefreshAll {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    const eligible = options.eligible();
    if (!eligible.length) {
      void vscode.window.showInformationMessage(t(options.keys.none));
      return;
    }
    const { due: targets, skipped, waitMs } = splitCooldown(eligible, options.cooldownLeft);
    if (!targets.length) {
      void vscode.window.showInformationMessage(t('usage.allCooldown', { seconds: cooldownSeconds(waitMs) }));
      return;
    }
    const skippedNote = skipped.length ? [t('usage.allSkipped', { n: skipped.length })] : [];
    running = true;
    try {
      const abort = new AbortController();
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: true },
        (progress, token) => {
          token.onCancellationRequested(() => abort.abort());
          return queryEach<R>(targets, (dir) => options.query(dir, abort.signal), (target, index) => progress.report({
            message: t(options.keys.progress, { label: target.label, done: index + 1, total: targets.length }),
            increment: index === 0 ? 0 : 100 / targets.length,
          }), () => abort.signal.aborted);
        },
      );
      options.afterRun();
      const done = results.filter((r) => r.result.ok || r.result.detail !== 'cancelled' || !abort.signal.aborted);
      const failed = done.filter((r): r is typeof r & { result: Extract<R, { ok: false }> | RefreshThrew } => !r.result.ok);
      if (abort.signal.aborted) {
        void vscode.window.showInformationMessage(joinSentences(t(options.keys.cancelled, { ok: done.length - failed.length, n: targets.length }), ...skippedNote));
      } else if (!failed.length) {
        void vscode.window.showInformationMessage(joinSentences(t(options.keys.done, { n: results.length }), ...skippedNote));
      }
      if (!failed.length) return;
      const named = failed.slice(0, NAMED_FAILURES).map(({ target, result }) => `${target.label} (${options.failureText(target.dir, result)})`);
      if (failed.length > NAMED_FAILURES) named.push(t('claude.usageAllMore', { n: failed.length - NAMED_FAILURES }));
      void vscode.window.showWarningMessage(joinSentences(t(options.keys.failed, { ok: done.length - failed.length, n: done.length, failures: named.join('; ') }), ...(abort.signal.aborted ? [] : skippedNote)));
    } finally {
      running = false;
    }
  };
  return { run, running: () => running };
}
