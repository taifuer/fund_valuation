export function changeSinceBasis(
  currentValue: number,
  fallbackChangePercent: number,
  basisValue?: number | null,
): number {
  if (
    Number.isFinite(currentValue)
    && currentValue > 0
    && basisValue != null
    && Number.isFinite(basisValue)
    && basisValue > 0
  ) {
    return (currentValue / basisValue - 1) * 100;
  }
  return Number.isFinite(fallbackChangePercent) ? fallbackChangePercent : 0;
}

export function combineHoldingAndFxChange(
  holdingChangePercent: number,
  fxChangePercent: number,
): number {
  return ((1 + holdingChangePercent / 100) * (1 + fxChangePercent / 100) - 1) * 100;
}
