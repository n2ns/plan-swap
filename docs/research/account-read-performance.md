# Synthetic Claude account-read baseline

Recorded 2026-09-30 on Linux x64, Node v24.21.0. This is a local synthetic measurement, not a UI latency result, a performance gate or a real-account workload distribution.

## Reproduce

Run `npm run perf --silent > report.json`. The runner bundles the benchmark in a disposable directory and uses `makeTempHome` for every case. It creates synthetic account-info JSON only; no real accounts, credentials, CLIs or editor processes are used. Temporary fixtures are removed on completion.

Account counts include default. Each layer had five warmups and 50 samples (25 for 50 accounts / 1 MiB), with nearest-rank percentiles and warm filesystem caches; host load and garbage collection can affect results.

Three layers are measured independently:

- `direct`: one `readAccountInfo` call per account.
- `panelSource`: `claudePanelSource.accounts()` with real account/label stores and a stubbed editor API.
- `combinedClaudeReads`: panel source, `StatusBar.update()` and `IdentityWarnings.check()` in sequence.

The combined layer excludes watchers, Codex, Webview messaging and rendering. It does not measure a complete refresh or cold activation. Read/parse counters come from a separate invocation after timing, so instrumentation is excluded from durations.

## Recorded results

Durations in milliseconds, rounded to three decimals:

| Accounts | JSON per account | Panel median | Panel p95 | Combined median | Combined p95 |
|---|---|---:|---:|---:|---:|
| 1 | 1 KiB | 0.023 | 0.068 | 0.068 | 0.156 |
| 1 | 256 KiB | 0.628 | 1.104 | 1.976 | 2.582 |
| 1 | 1 MiB | 2.620 | 3.447 | 5.801 | 6.819 |
| 10 | 1 KiB | 0.232 | 0.380 | 0.239 | 0.483 |
| 10 | 256 KiB | 4.095 | 4.881 | 15.145 | 16.879 |
| 10 | 1 MiB | 27.385 | 29.492 | 32.660 | 56.021 |
| 50 | 1 KiB | 0.926 | 1.283 | 1.179 | 1.650 |
| 50 | 256 KiB | 21.923 | 24.597 | 48.110 | 70.669 |
| 50 | 1 MiB | 141.672 | 145.755 | 226.307 | 288.973 |

For N accounts, direct and panel layers each read/parse N files. The combined layer reads/parses 2N + 1 files. These counts demonstrate repeated reads across consumers; the large-file cases show their potential cost.

## Decision

No production cache or read-path change was introduced. Small synthetic configurations were inexpensive in this run. Large configurations cost more, but the actual distribution of account counts, file sizes and refresh frequency has not been established. Before optimizing, collect relevant non-sensitive scale/timing evidence and define a supported target. Any future cache also needs explicit invalidation behavior and before/after measurements under the same conditions.
