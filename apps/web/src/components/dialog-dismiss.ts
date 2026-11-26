import { useRef, type MouseEvent, type PointerEvent } from "react";

export function useOutsideDismiss(dismiss: () => void, surface?: () => HTMLElement | null) {
  const origin = useRef<number | null>(null);
  const endedOutside = useRef(false);
  function outside(event: MouseEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = (surface ? surface() : event.currentTarget)?.getBoundingClientRect();
    return !!bounds && (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom);
  }
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!event.isPrimary) return;
      origin.current = event.button === 0 && outside(event) ? event.pointerId : null;
      endedOutside.current = false;
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (!event.isPrimary) return;
      endedOutside.current = origin.current === event.pointerId && outside(event);
      origin.current = null;
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      if (event.pointerId === origin.current) origin.current = null;
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const close = endedOutside.current && event.detail > 0 && outside(event);
      endedOutside.current = false;
      // Wait until click so the consumed gesture cannot activate a lower layer.
      if (close) dismiss();
    },
  };
}
