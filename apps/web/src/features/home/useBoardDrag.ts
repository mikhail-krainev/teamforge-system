import { useRef, type PointerEvent } from 'react';

interface DragState {
  item: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Pointer handlers that let a board item be dragged; the offset lives in --dx/--dy on the element. */
export function useBoardDrag() {
  const dragRef = useRef<DragState | null>(null);
  const topLayerRef = useRef(1);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const item = event.currentTarget;
    item.setPointerCapture(event.pointerId);
    topLayerRef.current += 1;
    item.style.zIndex = String(topLayerRef.current);
    dragRef.current = {
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: Number.parseFloat(item.style.getPropertyValue('--dx')) || 0,
      originY: Number.parseFloat(item.style.getPropertyValue('--dy')) || 0,
    };
    item.dataset.isDragging = 'true';
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const board = drag.item.closest('.board')?.getBoundingClientRect();
    const rect = drag.item.getBoundingClientRect();
    const currentX = Number.parseFloat(drag.item.style.getPropertyValue('--dx')) || 0;
    const currentY = Number.parseFloat(drag.item.style.getPropertyValue('--dy')) || 0;
    let nextX = drag.originX + event.clientX - drag.startX;
    let nextY = drag.originY + event.clientY - drag.startY;
    if (board) {
      // Keep the whole item inside the board: shift is measured from where the item sits now.
      nextX = currentX + clamp(nextX - currentX, board.left - rect.left, board.right - rect.right);
      nextY = currentY + clamp(nextY - currentY, board.top - rect.top, board.bottom - rect.bottom);
    }
    drag.item.style.setProperty('--dx', `${nextX}px`);
    drag.item.style.setProperty('--dy', `${nextY}px`);
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    delete drag.item.dataset.isDragging;
    dragRef.current = null;
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
