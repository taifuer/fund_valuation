import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './http';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('HTTP deadline', () => {
  it('includes a body stalled after successful response headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:true, json:()=>new Promise(()=>{})}));
    const response = await request('/test', {}, 100);
    const result = response.json();
    const assertion = expect(result).rejects.toMatchObject({ name:'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
  it('preserves the caller cancellation signal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(()=>new Promise(()=>{})));
    const controller = new AbortController();
    const result = request('/test', {signal:controller.signal});
    controller.abort();
    await expect(result).rejects.toMatchObject({name:'AbortError'});
  });
  it('cleans up after a complete JSON response', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"value":1}')));
    const response = await request('/test');
    expect(await response.json()).toEqual({value:1});
    expect(vi.getTimerCount()).toBe(0);
  });
});
