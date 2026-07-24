export function isHoldingQuoteSupported(symbol: string, explicit?: boolean): boolean {
  const normalized = symbol.trim().toLowerCase();
  if (explicit === false || !normalized) return false;
  return !normalized.startsWith('kr');
}
