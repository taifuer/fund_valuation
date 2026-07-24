import { describe, expect, it } from 'vitest';
import { isHoldingQuoteSupported } from './quoteCapabilities';

describe('isHoldingQuoteSupported', () => {
  it('accepts supported market symbols', () => {
    expect(isHoldingQuoteSupported('gb_nvda')).toBe(true);
    expect(isHoldingQuoteSupported('hk00700')).toBe(true);
  });

  it('rejects explicitly unsupported and Korean equity symbols', () => {
    expect(isHoldingQuoteSupported('gb_nvda', false)).toBe(false);
    expect(isHoldingQuoteSupported('kr000660')).toBe(false);
    expect(isHoldingQuoteSupported('kr005930', true)).toBe(false);
  });

  it('rejects empty symbols', () => {
    expect(isHoldingQuoteSupported('')).toBe(false);
  });
});
