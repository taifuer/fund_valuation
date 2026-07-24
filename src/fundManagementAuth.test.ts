import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFundManagementToken,
  fundManagementHeaders,
  readFundManagementToken,
  storeFundManagementToken,
} from './fundManagementAuth';

describe('fund management authentication', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('keeps the token in session storage and adds it to request headers', () => {
    storeFundManagementToken(' management-secret ');

    expect(readFundManagementToken()).toBe('management-secret');
    expect(fundManagementHeaders({ Accept: 'application/json' })).toEqual({
      Accept: 'application/json',
      'X-Fund-Management-Token': 'management-secret',
    });
  });

  it('clears the token without adding an empty header', () => {
    storeFundManagementToken('management-secret');
    clearFundManagementToken();

    expect(readFundManagementToken()).toBe('');
    expect(fundManagementHeaders()).toEqual({});
  });
});
