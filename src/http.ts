/** One deadline covers connection and response body consumption. */
export async function request(url: string, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  let rejectDeadline: (reason: unknown) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const cancel = () => {
    const error = new DOMException('Request cancelled', 'AbortError');
    controller.abort(error);
    rejectDeadline(error);
  };
  const timer = window.setTimeout(() => {
    const error = new DOMException('Request timed out', 'TimeoutError');
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);
  const cleanup = () => {
    window.clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
  };
  init.signal?.addEventListener('abort', cancel, { once: true });
  if (init.signal?.aborted) cancel();
  try {
    const response = await Promise.race([fetch(url, { ...init, signal: controller.signal }), deadline]);
    if (!response.ok) cleanup();
    return new Proxy(response, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (['json', 'text', 'arrayBuffer', 'blob', 'formData'].includes(String(property))) {
          return (...args: unknown[]) => Promise.race([Promise.resolve().then(() => value.apply(target, args)), deadline]).finally(cleanup);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
