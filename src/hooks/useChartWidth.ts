import { useLayoutEffect, useState } from 'react';

export function useChartWidth() {
  const [element, ref] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => {
      const measured = element.getBoundingClientRect().width;
      if (measured > 0) setWidth(Math.round(measured));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { width, ref };
}
