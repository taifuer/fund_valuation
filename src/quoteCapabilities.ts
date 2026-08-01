export function isHoldingQuoteSupported(symbol: string, explicit?: boolean): boolean {
  const normalized = symbol.trim().toLowerCase();
  return explicit !== false && normalized.length > 0;
}
