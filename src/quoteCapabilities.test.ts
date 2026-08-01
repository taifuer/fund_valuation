import { describe, expect, it } from 'vitest';
import { isHoldingQuoteSupported } from './quoteCapabilities';

describe('isHoldingQuoteSupported', () => {
  it('accepts supported market symbols', () => {
    expect(isHoldingQuoteSupported('gb_nvda')).toBe(true);
    expect(isHoldingQuoteSupported('hk00700')).toBe(true);
  });

  it('accepts backend-adapted Korean and Japanese equity symbols', () => {
    expect(isHoldingQuoteSupported('kr000660')).toBe(true);
    expect(isHoldingQuoteSupported('jp6857', true)).toBe(true);
  });

  it('rejects explicitly unsupported symbols', () => {
    expect(isHoldingQuoteSupported('gb_nvda', false)).toBe(false);
  });

  it('rejects empty symbols', () => {
    expect(isHoldingQuoteSupported('')).toBe(false);
  });
});
