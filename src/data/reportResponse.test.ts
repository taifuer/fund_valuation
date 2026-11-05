import { describe, expect, it, vi } from 'vitest';
import { readReportText } from '../../scripts/lib/report-response';

describe('bounded report downloads', () => {
  it('accepts announcements larger than the former 2 MB cap', async () => {
    const body = 'x'.repeat(2_100_000);
    expect(await readReportText(new Response(body))).toBe(body);
  });

  it('rejects declared oversized bodies before reading', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    await expect(readReportText(new Response(body, { headers: { 'content-length': '100' } }), 10))
      .rejects.toThrow('size limit');
    expect(cancel).toHaveBeenCalled();
  });

  it('checks actual bytes when length is absent or misleading', async () => {
    const cases: HeadersInit[] = [{}, { 'content-length': '1' }];
    for (const headers of cases) {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel,
      });
      await expect(readReportText(new Response(body, { headers }), 10)).rejects.toThrow('size limit');
      expect(cancel).toHaveBeenCalled();
    }
  });

  it('decodes UTF-8 across chunk boundaries and propagates body failures', async () => {
    const bytes = new TextEncoder().encode('财报');
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    expect(await readReportText(new Response(body), 6)).toBe('财报');
    await expect(readReportText(new Response(new ReadableStream({
      start(controller) { controller.error(new Error('body timeout')); },
    })))).rejects.toThrow('body timeout');
  });
});
