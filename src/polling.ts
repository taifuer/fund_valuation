type AsyncTask = () => Promise<unknown> | unknown;

function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function startAdaptivePolling(task: AsyncTask, delay: () => number): () => void {
  let stopped = false;
  let running = false;
  let timer: number | null = null;

  function clearTimer() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    if (stopped || !pageIsVisible()) return;
    timer = window.setTimeout(run, Math.max(delay(), 1_000));
  }

  async function run() {
    timer = null;
    if (stopped || !pageIsVisible() || running) return;
    running = true;
    try {
      await task();
    } finally {
      running = false;
      schedule();
    }
  }

  function handleVisibilityChange() {
    clearTimer();
    if (pageIsVisible() && !running) void run();
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleVisibilityChange);
  schedule();

  return () => {
    stopped = true;
    clearTimer();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleVisibilityChange);
  };
}
