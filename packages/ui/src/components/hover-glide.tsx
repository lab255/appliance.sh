'use client';

import { useEffect, useRef, useState, type HTMLAttributes, type PointerEvent } from 'react';
import * as m from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { selectTransition, useTransition } from '../motion/use-transition.js';
import { cn } from '../lib/utils.js';

type Rect = { x: number; y: number; width: number; height: number };

/** One measured highlight per list. Mark rows with data-hover-glide-item.
 * Gaps remain inert, and nested controls keep their own click/focus behavior.
 * Transforms need only domAnimation; no shared-layout feature bundle is loaded.
 */
export function HoverGlide({
  as: Container = 'div',
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: 'div' | 'nav' | 'ul' }) {
  const container = useRef<HTMLElement>(null);
  const active = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const { immediate } = useTransition();
  const Highlight = Container === 'ul' ? m.li : m.div;

  const clear = () => {
    active.current = null;
    setRect(null);
  };
  const measure = () => {
    const root = container.current;
    const row = active.current;
    if (!root || !row || !root.contains(row)) {
      setRect(null);
      return;
    }
    const r = row.getBoundingClientRect();
    const c = root.getBoundingClientRect();
    setRect({
      x: r.left - c.left + root.scrollLeft - root.clientLeft,
      y: r.top - c.top + root.scrollTop - root.clientTop,
      width: r.width,
      height: r.height,
    });
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    // Portalled menus bubble through React, but do not belong to this list.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.pointerType === 'touch') return;
    const row = (event.target as Element).closest<HTMLElement>('[data-hover-glide-item]');
    if (
      !row ||
      row.closest('[data-hover-glide]') !== event.currentTarget ||
      row.matches('[aria-disabled="true"], :disabled, [aria-current="page"]')
    ) {
      clear();
      return;
    }
    active.current = row;
    measure();
  };

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    // Reflow/filtering must never leave a highlight parked on a stale row.
    const reset = () => {
      active.current = null;
      setRect(null);
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reset);
    resize?.observe(root);
    const mutations = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) => !(node instanceof Element && node.hasAttribute('data-hover-glide-highlight'))
          )
        )
      )
        reset();
    });
    mutations.observe(root, { childList: true, subtree: true });
    window.addEventListener('resize', reset);
    return () => {
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', reset);
    };
  }, []);

  return (
    <Container
      {...props}
      ref={(element: HTMLElement | null) => {
        container.current = element;
      }}
      data-hover-glide={immediate ? 'immediate' : 'animated'}
      className={cn('hover-glide', className)}
      onPointerMove={(event) => {
        props.onPointerMove?.(event);
        if (!event.defaultPrevented) move(event);
      }}
      onPointerLeave={(event) => {
        props.onPointerLeave?.(event);
        clear();
      }}
      onScroll={(event) => {
        props.onScroll?.(event);
        clear();
      }}
    >
      {/* Unmount Presence itself on reduction: even an in-flight exit disappears. */}
      {!immediate && (
        <AnimatePresence>
          {rect && (
            <Highlight
              aria-hidden="true"
              data-hover-glide-highlight=""
              className="hover-glide-highlight"
              initial={{ ...rect, opacity: 0 }}
              animate={{ ...rect, opacity: 1 }}
              transition={selectTransition(false, 'fast')}
              exit={{ opacity: 0, transition: selectTransition(false, 'fast', 'exit') }}
            />
          )}
        </AnimatePresence>
      )}
      {children}
    </Container>
  );
}
