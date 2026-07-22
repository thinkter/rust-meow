/** A chat merge invalidates requests sent against its old transport identity.
 * Drop those pending flags so their now-ignored completions cannot leave the
 * canonical poll disabled forever. Canonical requests remain untouched. */
export function clearMergedPollVotes(
  pending: Readonly<Record<string, boolean>>,
  oldChatId: string,
): Record<string, boolean> {
  const remapped: Record<string, boolean> = {};
  const oldPrefix = `${oldChatId}:`;
  for (const [key, value] of Object.entries(pending)) {
    if (!key.startsWith(oldPrefix)) remapped[key] = value;
  }
  return remapped;
}
