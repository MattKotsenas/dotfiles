import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Registration starts unawaited refreshes. Awaiting just one refresh can return
// after it was superseded, before the latest auth snapshot/catalog is published.
export function trackModelRefreshes(runtime: ModelRuntime): (signal?: AbortSignal) => Promise<void> {
  const refresh = runtime.refresh.bind(runtime);
  const pending = new Set<ReturnType<ModelRuntime["refresh"]>>();
  let rejection: { error: unknown } | undefined;
  runtime.refresh = (options) => {
    const operation = refresh(options);
    pending.add(operation);
    operation.then(
      () => pending.delete(operation),
      (error: unknown) => {
        pending.delete(operation);
        rejection ??= { error };
      },
    );
    return operation;
  };
  return async (signal) => {
    signal?.throwIfAborted();
    let abort: (() => void) | undefined;
    const cancelled =
      signal &&
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
    try {
      while (pending.size) {
        const current = Promise.all([...pending]);
        await (cancelled ? Promise.race([current, cancelled]) : current);
      }
      if (rejection) throw rejection.error;
    } finally {
      if (signal && abort) signal.removeEventListener("abort", abort);
    }
  };
}
