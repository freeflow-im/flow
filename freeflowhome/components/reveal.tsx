"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Fades and lifts its children into view once, the first time they intersect.
 * Falls back to instantly visible when IntersectionObserver is unavailable or
 * the visitor prefers reduced motion (handled in CSS).
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.06 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${className}`}
      data-shown={shown ? "true" : "false"}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
