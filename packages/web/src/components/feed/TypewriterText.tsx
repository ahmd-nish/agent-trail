import { useState, useEffect, useRef } from "react";

interface Props {
  text: string;
  cps?: number;
  animate?: boolean;
  className?: string;
}

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function TypewriterText({ text, cps = 35, animate = true, className = "" }: Props) {
  const shouldAnimate = animate && !prefersReducedMotion;

  const posRef = useRef(shouldAnimate ? 0 : text.length);
  const hoveredRef = useRef(false);
  const [displayed, setDisplayed] = useState(shouldAnimate ? "" : text);

  // When animate toggles off, or text grows on a non-animated block, sync immediately.
  useEffect(() => {
    if (!shouldAnimate) {
      setDisplayed(text);
      posRef.current = text.length;
    }
  }, [text, shouldAnimate]);

  // Typewriter loop — re-runs whenever text grows or cps changes.
  useEffect(() => {
    if (!shouldAnimate) return;
    if (posRef.current >= text.length) return;

    const ms = 1000 / cps;
    const id = setInterval(() => {
      if (hoveredRef.current) return; // paused on hover
      if (posRef.current < text.length) {
        posRef.current += 1;
        setDisplayed(text.slice(0, posRef.current));
      } else {
        clearInterval(id);
      }
    }, ms);

    return () => clearInterval(id);
  }, [text, cps, shouldAnimate]);

  const isTyping = displayed.length < text.length;

  return (
    <span
      className={className}
      onMouseEnter={() => { hoveredRef.current = true; }}
      onMouseLeave={() => { hoveredRef.current = false; }}
    >
      {displayed}
      {isTyping && (
        <span
          aria-hidden="true"
          className="inline-block w-[2px] h-[0.85em] bg-current opacity-70 animate-pulse ml-px align-middle"
        />
      )}
    </span>
  );
}
