function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function globalFutureReferencePrice(primaryRaw: unknown, fallbackRaw: unknown, price: number): number {
  return positiveNumber(primaryRaw) ?? positiveNumber(fallbackRaw) ?? (price > 0 ? price : 0);
}
