// Pure grouping of account directories signed in to the same identity (same user in the same workspace/organization). No vscode import.
// Identity values are opaque comparison keys: never displayed, logged, persisted or sent to the Webview.

/** Groups entries that share an identity; only groups with two or more members are returned, members in input order, groups ordered by their first member. Entries without an identity are ignored. */
export function sameIdentityGroups<T extends { identity?: string }>(entries: readonly T[]): T[][] {
  const byIdentity = new Map<string, T[]>();
  for (const e of entries) {
    if (!e.identity) continue;
    const group = byIdentity.get(e.identity);
    if (group) group.push(e);
    else byIdentity.set(e.identity, [e]);
  }
  // Map preserves insertion order, i.e. the order of each group's first member
  return [...byIdentity.values()].filter((g) => g.length >= 2);
}

/** Stable, order-insensitive signature of a set of groups built from their dirs only (no identity values), for warning once per situation. */
export function identityGroupsKey(groups: ReadonlyArray<ReadonlyArray<{ dir: string }>>): string {
  return groups
    .map((g) => g.map((e) => e.dir).sort().join('\0'))
    .sort()
    .join('\n');
}
