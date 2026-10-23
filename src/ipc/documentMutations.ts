export type PreMutationHook = (tabId: string) => Promise<void>;
const hooks = new Set<PreMutationHook>();

/** Hooks run (in registration order) before every queued mutation task. */
export function registerPreMutationHook(hook: PreMutationHook): () => void {
  hooks.add(hook);
  return () => { hooks.delete(hook); };
}

/**
 * One serialization lane per open tab. Every operation that reads and then
 * replaces PDF bytes (page edits, save, export, clipboard copy) goes through
 * this queue so it observes the latest revision when its turn starts.
 */
const mutationTails = new Map<string, Promise<void>>();

export function enqueueDocumentMutation<T>(
  tabId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(tabId) ?? Promise.resolve();
  const operation = previous.then(async () => {
    for (const hook of [...hooks]) await hook(tabId);
    return task();
  });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(tabId, tail);
  void tail.then(() => {
    if (mutationTails.get(tabId) === tail) mutationTails.delete(tabId);
  });
  return operation;
}

export async function waitForDocumentMutations(tabId: string): Promise<void> {
  // A completing operation can synchronously enqueue its successor, so loop
  // until this lane is genuinely empty rather than awaiting one snapshot.
  while (mutationTails.has(tabId)) {
    await mutationTails.get(tabId);
  }
}

export async function waitForAllDocumentMutations(): Promise<void> {
  while (mutationTails.size > 0) {
    await Promise.all([...mutationTails.values()]);
  }
}

export const hasPendingDocumentMutations = (): boolean =>
  mutationTails.size > 0;
