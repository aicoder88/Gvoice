// One local inference slot. A file chunk already running finishes before a
// dictation, but no further file chunk starts while live dictation is busy.
export function createInferenceScheduler({ isInteractiveBusy = () => false, pollMs = 100 } = {}) {
  const pending = [];
  let running = false;
  let timer = null;
  const abortError = () => new DOMException('Work paused.', 'AbortError');
  function pump() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (running || !pending.length) return;
    let index = pending.findIndex(item => item.priority === 'interactive');
    if (index < 0 && isInteractiveBusy()) {
      timer = setTimeout(pump, pollMs);
      timer.unref?.();
      return;
    }
    if (index < 0) index = 0;
    const item = pending.splice(index, 1)[0];
    item.signal?.removeEventListener('abort', item.abort);
    if (item.signal?.aborted) { item.reject(abortError()); pump(); return; }
    running = true;
    Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
      running = false;
      pump();
    });
  }
  return {
    run(operation, { priority = 'interactive', signal } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const item = { operation, priority, signal, resolve, reject, abort: null };
        item.abort = () => {
          const index = pending.indexOf(item);
          if (index >= 0) { pending.splice(index, 1); reject(abortError()); pump(); }
        };
        signal?.addEventListener('abort', item.abort, { once: true });
        pending.push(item);
        pump();
      });
    },
    setBusyCheck(check) { isInteractiveBusy = check; pump(); },
  };
}

export const localInference = createInferenceScheduler();
