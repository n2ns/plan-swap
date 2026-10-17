// Timing rules shared by both vendors' usage code. No vscode import.

/** A usage observation dated this far in the future is still accepted (clock differences between the machine that
 *  queried and this one); anything later is ignored until the clocks agree. */
export const FUTURE_TOLERANCE_MS = 2 * 60_000;
