import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Hand-rolled inline SVG set keeps the dependency tree at zero and every glyph
 * on the same 24px stroke grid. All icons inherit `currentColor`.
 */
function Base({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ArrowRight(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Base>
  );
}

export function ArrowDown(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Base>
  );
}

export function Check(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Base>
  );
}

export function Cross(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Base>
  );
}

export function Dash(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="M6 12h12" />
    </Base>
  );
}

export function Lock(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Base>
  );
}

export function Bolt(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </Base>
  );
}

export function Terminal(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </Base>
  );
}

export function Code(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m9 17-5-5 5-5M15 7l5 5-5 5" />
    </Base>
  );
}

export function Hash(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9 3 7 21M17 3l-2 18M3.5 8.5h17M3 15.5h17" />
    </Base>
  );
}

export function Message(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.2-4.2A8 8 0 1 1 21 12Z" />
    </Base>
  );
}

export function Users(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
      <circle cx="9" cy="7" r="3.2" />
      <path d="M22 20v-1.5a4 4 0 0 0-3-3.87M16.5 4.2a3.2 3.2 0 0 1 0 5.6" />
    </Base>
  );
}

export function Server(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="3.5" width="18" height="7" rx="2" />
      <rect x="3" y="13.5" width="18" height="7" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </Base>
  );
}

export function Layers(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3.5 12.5 8.5 4.7 8.5-4.7M3.5 16.8l8.5 4.7 8.5-4.7" />
    </Base>
  );
}

export function Shield(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 22s8-3.5 8-9.5V5.5L12 2.5 4 5.5V12.5C4 18.5 12 22 12 22Z" />
      <path d="m9 12 2 2 4-4" />
    </Base>
  );
}

export function Sparkle(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3v5M12 16v5M4.5 12h5M14.5 12h5M6.9 6.9l2.5 2.5M14.6 14.6l2.5 2.5M17.1 6.9l-2.5 2.5M9.4 14.6l-2.5 2.5" />
    </Base>
  );
}

export function Box(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M20.5 7.5 12 3 3.5 7.5v9L12 21l8.5-4.5v-9Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </Base>
  );
}

export function Paperclip(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M20 11.5 12.3 19a5 5 0 0 1-7-7l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7.2-7.2" />
    </Base>
  );
}

export function Globe(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.8 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.8-3.8-9S9.5 5.7 12 3Z" />
    </Base>
  );
}

export function Apple(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M16.36 12.7c.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.11 8.76.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.2-2.48-.03-.01-2.3-.88-2.31-3.5ZM14.2 6.2c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.06 1.7-.93 2.7.97.08 1.97-.5 2.59-1.23Z" />
    </svg>
  );
}

export function Github(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 1.7a10.3 10.3 0 0 0-3.26 20.07c.52.1.71-.22.71-.5v-1.75c-2.87.62-3.48-1.38-3.48-1.38-.47-1.2-1.15-1.52-1.15-1.52-.94-.64.07-.63.07-.63 1.04.08 1.58 1.07 1.58 1.07.92 1.58 2.42 1.12 3.01.86.1-.67.36-1.13.65-1.39-2.29-.26-4.7-1.15-4.7-5.1 0-1.13.4-2.05 1.06-2.77-.1-.26-.46-1.3.1-2.72 0 0 .87-.28 2.84 1.06a9.8 9.8 0 0 1 5.17 0c1.97-1.34 2.83-1.06 2.83-1.06.57 1.42.21 2.46.11 2.72.66.72 1.06 1.64 1.06 2.77 0 3.96-2.42 4.83-4.72 5.09.37.32.7.95.7 1.92v2.85c0 .28.19.6.72.5A10.3 10.3 0 0 0 12 1.7Z" />
    </svg>
  );
}

export function Discord(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M19.3 5.6a16.2 16.2 0 0 0-4-1.24l-.25.5c1.32.32 2.4.8 3.4 1.4a12.9 12.9 0 0 0-9-1.03c-.5.12-.98.26-1.45.42a13.4 13.4 0 0 1 3.44-1.4l-.25-.5A16 16 0 0 0 4.7 5.6C2.15 9.42 1.46 13.14 1.8 16.8a16.3 16.3 0 0 0 4.96 2.5l.98-1.6c-.55-.2-1.07-.45-1.56-.74l.38-.28a11.6 11.6 0 0 0 9.9 0l.38.28c-.49.29-1.01.53-1.56.74l.98 1.6a16.2 16.2 0 0 0 4.95-2.5c.4-4.24-.68-7.93-2.9-11.2ZM8.55 14.6c-.96 0-1.75-.88-1.75-1.96 0-1.09.77-1.97 1.75-1.97s1.77.89 1.75 1.97c0 1.08-.77 1.96-1.75 1.96Zm6.9 0c-.96 0-1.75-.88-1.75-1.96 0-1.09.77-1.97 1.75-1.97s1.76.89 1.74 1.97c0 1.08-.76 1.96-1.74 1.96Z" />
    </svg>
  );
}

export function Slack(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M5.1 15.2a2.1 2.1 0 1 1-2.1-2.1h2.1v2.1Zm1.06 0a2.1 2.1 0 0 1 4.2 0v5.3a2.1 2.1 0 0 1-4.2 0v-5.3ZM8.26 6.7a2.1 2.1 0 1 1 2.1-2.1v2.1h-2.1Zm0 1.07a2.1 2.1 0 0 1 0 4.2H2.94a2.1 2.1 0 0 1 0-4.2h5.32ZM18.9 8.84a2.1 2.1 0 1 1 2.1 2.1h-2.1v-2.1Zm-1.06 0a2.1 2.1 0 0 1-4.2 0V3.5a2.1 2.1 0 1 1 4.2 0v5.34ZM15.74 17.3a2.1 2.1 0 1 1-2.1 2.1v-2.1h2.1Zm0-1.06a2.1 2.1 0 0 1 0-4.2h5.32a2.1 2.1 0 0 1 0 4.2h-5.32Z" />
    </svg>
  );
}

/** Brand mark. Full colour by design, so it ignores `currentColor`. */
export function Logo(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id="freeflowMarkGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8B46DE" />
          <stop offset="1" stopColor="#4C1188" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#freeflowMarkGradient)" />
      <path d="M140 258 L214 320 L52 392 Z" fill="#ffffff" />
      <rect x="86" y="72" width="340" height="248" rx="76" fill="#ffffff" />
      <g fill="none" stroke="#6D28D9" strokeWidth="32" strokeLinecap="round">
        <path d="M175 158 c 28 -32 58 -32 90 0 s 62 32 90 0" />
        <path d="M145 240 c 24 -27 50 -27 75 0 s 51 27 75 0" />
      </g>
    </svg>
  );
}

export function Menu(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Base>
  );
}

export function Chevron(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <path d="m6 9 6 6 6-6" />
    </Base>
  );
}

export function Branch(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="6.5" cy="5" r="2.2" />
      <circle cx="6.5" cy="19" r="2.2" />
      <circle cx="17.5" cy="8" r="2.2" />
      <path d="M6.5 7.2v9.6M17.5 10.2v.8a4 4 0 0 1-4 4h-3.2" />
    </Base>
  );
}

export function PullRequest(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="6.5" cy="5.5" r="2.2" />
      <circle cx="6.5" cy="18.5" r="2.2" />
      <circle cx="17.5" cy="18.5" r="2.2" />
      <path d="M6.5 7.7v8.6M17.5 16.3V10a3 3 0 0 0-3-3h-2.7" />
      <path d="m13.6 4.8-1.9 2.2 1.9 2.2" />
    </Base>
  );
}

export function Play(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10.2 8.8 15.5 12l-5.3 3.2V8.8Z" />
    </Base>
  );
}

export function Rotate(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 12a8.5 8.5 0 1 1 2.8 6.3" />
      <path d="M3.2 19.2v-5h5" />
    </Base>
  );
}

export function Bug(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="7.5" y="7.5" width="9" height="12" rx="4.5" />
      <path d="M9.5 5.5a2.5 2.5 0 0 1 5 0M3.5 11h4M16.5 11h4M3.5 17h4M16.5 17h4M12 11v6" />
    </Base>
  );
}

/** Resolves the string names used in `lib/content.ts` to a component. */
const registry = {
  message: Message,
  users: Users,
  lock: Lock,
  bolt: Bolt,
  code: Code,
  layers: Layers,
  shield: Shield,
  server: Server,
  globe: Globe,
  apple: Apple,
  sparkle: Sparkle,
  box: Box,
  terminal: Terminal,
  hash: Hash,
} as const;

export type IconName = keyof typeof registry;

export function Icon({ name, ...props }: IconProps & { name: IconName }) {
  const Cmp = registry[name];
  return <Cmp {...props} />;
}

export function FileText(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </Base>
  );
}

export function Compass(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </Base>
  );
}

export function Key(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14 9l2 2" />
    </Base>
  );
}
