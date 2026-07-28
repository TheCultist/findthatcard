"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

export type PagerDirection = -1 | 1;

/** Distance a slow, deliberate drag must cover before it changes card. */
const COMMIT_DISTANCE_PX = 72;
/** A much shorter drag still commits if it is thrown at least this fast. */
const FLICK_VELOCITY_PX_PER_MS = 0.45;
const FLICK_MIN_DISTANCE_PX = 16;
/** Only pointer samples this recent feed the flick speed, so a drag that stalls
 *  before release is read as a slow drag rather than as its earlier throw. */
const VELOCITY_WINDOW_MS = 120;

const EXIT_MIN_MS = 130;
const EXIT_MAX_MS = 260;
const ENTER_MS = 280;
const SETTLE_MS = 340;

/** How far the incoming card travels when no gesture threw the old one out. */
const CONTROL_ENTER_RATIO = 0.14;
const CONTROL_ENTER_MAX_PX = 56;

/** Fast out with a long soft tail — the curve iOS uses for sheets and pagers. */
const EASE_EXIT = "cubic-bezier(0.32, 0.72, 0, 1)";
/** easeOutQuint: decisive start, settles without overshooting. */
const EASE_ENTER = "cubic-bezier(0.22, 1, 0.36, 1)";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * iOS-style resistance. The offset approaches a limit asymptotically instead of
 * following the finger 1:1, so dragging past the end of the list reads as
 * "there is nothing over there" rather than as a broken drag.
 */
function rubberBand(delta: number, dimension: number): number {
  const size = Math.max(dimension, 1);
  return (delta * size * 0.55) / (size + 0.55 * Math.abs(delta));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Drives the horizontal paging motion of a single element.
 *
 * The element is written to directly rather than through React state: a drag
 * produces a style write per touch frame, and re-rendering the whole card body
 * that often drops frames on mid-range phones.
 *
 * A committed swipe carries the outgoing card off-screen from wherever the
 * finger left it, and only then swaps content and brings the incoming card in
 * from the opposite edge — so the motion is continuous rather than snapping
 * back across the middle of the panel.
 */
export function usePagerAnimation() {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const samplesRef = useRef<{ time: number; x: number }[]>([]);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => clearTimer(), []);

  /** Hand the element back to its stylesheet. */
  const clearInlineMotion = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    node.style.transition = "";
    node.style.transform = "";
    node.style.opacity = "";
    node.style.willChange = "";
  }, []);

  const width = () => nodeRef.current?.offsetWidth || 320;

  /** True while an exit/enter/settle animation owns the element. */
  const isBusy = useCallback(() => busyRef.current, []);

  const beginDrag = useCallback(() => {
    const node = nodeRef.current;
    offsetRef.current = 0;
    samplesRef.current = [];
    clearTimer();
    busyRef.current = false;
    if (node) {
      node.style.transition = "none";
      node.style.willChange = "transform, opacity";
    }
  }, []);

  const updateDrag = useCallback((deltaX: number, resist: boolean) => {
    const node = nodeRef.current;
    if (!node) return;

    const size = width();
    const x = resist ? rubberBand(deltaX, size) : deltaX;
    offsetRef.current = x;

    const now = performance.now();
    const samples = samplesRef.current;
    samples.push({ time: now, x });
    while (samples.length > 2 && now - samples[0].time > VELOCITY_WINDOW_MS) {
      samples.shift();
    }

    node.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
    node.style.opacity = String(clamp(1 - Math.abs(x) / (size * 1.6), 0.45, 1));
  }, []);

  /** Signed px/ms over the recent sample window. */
  const velocity = () => {
    const samples = samplesRef.current;
    if (samples.length < 2) return 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = last.time - first.time;
    return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
  };

  /**
   * Which way the finished gesture committed, or null if it should settle back.
   * A flick takes its direction from velocity, a slow drag from total offset.
   */
  const resolveDrag = useCallback(
    (canPrev: boolean, canNext: boolean): PagerDirection | null => {
      const x = offsetRef.current;
      const v = velocity();
      const flicked =
        Math.abs(v) >= FLICK_VELOCITY_PX_PER_MS && Math.abs(x) >= FLICK_MIN_DISTANCE_PX;
      const dragged = Math.abs(x) >= COMMIT_DISTANCE_PX;
      if (!flicked && !dragged) return null;

      const direction: PagerDirection = (flicked ? v : x) < 0 ? 1 : -1;
      if (direction === 1 ? !canNext : !canPrev) return null;
      return direction;
    },
    []
  );

  /** Ease the element back to rest after a gesture that did not commit. */
  const settle = useCallback(() => {
    const node = nodeRef.current;
    offsetRef.current = 0;
    samplesRef.current = [];
    if (!node) return;

    clearTimer();
    busyRef.current = true;
    node.style.transition = `transform ${SETTLE_MS}ms ${EASE_ENTER}, opacity ${SETTLE_MS}ms ${EASE_ENTER}`;
    node.style.transform = "translate3d(0, 0, 0)";
    node.style.opacity = "1";
    timerRef.current = setTimeout(() => {
      busyRef.current = false;
      clearInlineMotion();
    }, SETTLE_MS);
  }, [clearInlineMotion]);

  /**
   * Carry the outgoing card off-screen, then invoke `onExited` so the caller can
   * swap in the next one. Duration follows the throw: a hard flick finishes fast,
   * a slow drag coasts.
   */
  const exit = useCallback((direction: PagerDirection, onExited: () => void) => {
    const node = nodeRef.current;
    if (!node || prefersReducedMotion()) {
      offsetRef.current = 0;
      onExited();
      return;
    }

    const size = width();
    const target = direction === 1 ? -size : size;
    const remaining = Math.abs(target - offsetRef.current);
    const speed = Math.max(Math.abs(velocity()), 0.8);
    const duration = clamp(remaining / speed, EXIT_MIN_MS, EXIT_MAX_MS);

    clearTimer();
    busyRef.current = true;
    node.style.transition = `transform ${duration}ms ${EASE_EXIT}, opacity ${duration}ms linear`;
    node.style.transform = `translate3d(${target}px, 0, 0)`;
    node.style.opacity = "0";
    offsetRef.current = target;

    timerRef.current = setTimeout(() => {
      busyRef.current = false;
      onExited();
    }, duration);
  }, []);

  /**
   * Bring the newly rendered card in. `fromExit` means the previous card was
   * thrown off-screen, so the incoming one travels the full width; otherwise it
   * slides a short distance, which suits arrow presses and cross-page loads
   * where nothing left the screen.
   */
  const enter = useCallback(
    (direction: PagerDirection, fromExit: boolean) => {
      const node = nodeRef.current;
      if (!node) return;

      node.scrollTop = 0;
      offsetRef.current = 0;
      samplesRef.current = [];

      if (prefersReducedMotion()) {
        clearInlineMotion();
        return;
      }

      const size = width();
      const travel = fromExit
        ? size
        : Math.min(size * CONTROL_ENTER_RATIO, CONTROL_ENTER_MAX_PX);
      const start = direction === 1 ? travel : -travel;

      clearTimer();
      busyRef.current = true;
      node.style.transition = "none";
      node.style.transform = `translate3d(${start}px, 0, 0)`;
      node.style.opacity = "0";
      node.style.willChange = "transform, opacity";

      // Commit the start frame before switching on the transition, otherwise the
      // browser coalesces both writes and the element simply appears at rest.
      void node.offsetWidth;

      node.style.transition = `transform ${ENTER_MS}ms ${EASE_ENTER}, opacity ${ENTER_MS}ms ease-out`;
      node.style.transform = "translate3d(0, 0, 0)";
      node.style.opacity = "1";

      timerRef.current = setTimeout(() => {
        busyRef.current = false;
        clearInlineMotion();
      }, ENTER_MS);
    },
    [clearInlineMotion]
  );

  /** Abort any in-flight motion and return the element to its resting style. */
  const reset = useCallback(() => {
    clearTimer();
    busyRef.current = false;
    offsetRef.current = 0;
    samplesRef.current = [];
    clearInlineMotion();
  }, [clearInlineMotion]);

  // Stable identity: consumers put this in dependency arrays.
  return useMemo(
    () => ({ nodeRef, isBusy, beginDrag, updateDrag, resolveDrag, settle, exit, enter, reset }),
    [isBusy, beginDrag, updateDrag, resolveDrag, settle, exit, enter, reset]
  );
}
