// The find bar's matches drawn over a textarea (the Markdown editor's, a text file's), which cannot highlight its own
// text: a layer laid exactly over its text box, with the same font and wrapping, whose text is invisible but whose
// matches are marked, and which scrolls with it (sideways too, for text that does not wrap). It ignores the mouse, so
// the textarea is used as ever beneath it.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';

/** The textarea's styles the layer must share for its text to fall in the same places. */
const COPIED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'whiteSpace', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;

export function TextareaMatches({ textareaRef, text, starts, length, current }: { textareaRef: RefObject<HTMLTextAreaElement | null>; text: string; starts: number[]; length: number; current: number }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<CSSProperties | null>(null);

  // Follow the textarea's place, size and font (the panel is resized, the window too).
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const measure = () => {
      const cs = getComputedStyle(ta);
      const style: CSSProperties = {
        left: ta.offsetLeft + ta.clientLeft,
        top: ta.offsetTop + ta.clientTop,
        width: ta.clientWidth,
        height: ta.clientHeight,
      };
      for (const k of COPIED) (style as Record<string, string>)[k] = cs[k];
      setBox(style);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ta);
    const follow = () => {
      if (!layerRef.current) return;
      layerRef.current.scrollTop = ta.scrollTop;
      layerRef.current.scrollLeft = ta.scrollLeft;
    };
    ta.addEventListener('scroll', follow);
    return () => {
      ro.disconnect();
      ta.removeEventListener('scroll', follow);
    };
  }, [textareaRef]);

  // Keep the scroll in step after each redraw, and bring a newly shown match into view (once: the person may
  // scroll away from it).
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const layer = layerRef.current;
    if (!ta || !layer) return;
    const key = current >= 0 ? `${current}:${starts[current]}` : null;
    const mark = layer.querySelector<HTMLElement>('mark.find-current');
    if (key !== shown.current && mark) {
      if (mark.offsetTop < ta.scrollTop || mark.offsetTop + mark.offsetHeight > ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, mark.offsetTop - ta.clientHeight / 3);
      if (mark.offsetLeft < ta.scrollLeft || mark.offsetLeft + mark.offsetWidth > ta.scrollLeft + ta.clientWidth) ta.scrollLeft = Math.max(0, mark.offsetLeft - ta.clientWidth / 3);
    }
    shown.current = key;
    layer.scrollTop = ta.scrollTop;
    layer.scrollLeft = ta.scrollLeft;
  });

  if (!box) return null;
  const parts: ReactNode[] = [];
  let at = 0;
  starts.forEach((s, i) => {
    parts.push(text.slice(at, s));
    parts.push(
      <mark key={i} className={i === current ? 'find-current' : undefined}>
        {text.slice(s, s + length)}
      </mark>,
    );
    at = s + length;
  });
  // A final line break takes a line in the textarea; the space keeps it in the layer too.
  parts.push(`${text.slice(at)} `);
  return (
    <div ref={layerRef} className="md-find-layer" style={box} aria-hidden="true">
      {parts}
    </div>
  );
}
