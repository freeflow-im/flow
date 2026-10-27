import type { ReactNode } from "react";
import { ArrowRight } from "@/components/icons";

/* -------------------------------------------------------------------------- */
/*  Layout                                                                     */
/* -------------------------------------------------------------------------- */

export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}

export function Section({
  children,
  id,
  tone = "paper",
  className = "",
}: {
  children: ReactNode;
  id?: string;
  tone?: "paper" | "mist" | "dark";
  className?: string;
}) {
  const tones = {
    paper: "bg-paper",
    mist: "bg-mist border-y border-line",
    dark: "bg-ink text-white/70",
  } as const;

  return (
    <section
      id={id}
      className={`py-20 sm:py-28 lg:py-32 ${tones[tone]} ${className}`}
    >
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Typography                                                                 */
/* -------------------------------------------------------------------------- */

export function Eyebrow({
  children,
  tone = "accent",
  className = "",
}: {
  children: ReactNode;
  tone?: "accent" | "free" | "warn" | "dark";
  className?: string;
}) {
  const tones = {
    accent: "bg-accent-soft text-accent border-accent-line",
    free: "bg-free-soft text-free border-free/20",
    warn: "bg-warn-soft text-warn border-warn/20",
    dark: "bg-white/10 text-white/80 border-white/15",
  } as const;

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-medium tracking-tight ${tones[tone]} ${className}`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {children}
    </span>
  );
}

/**
 * Two-tone section heading: a muted first line, a solid second line.
 * Lifted from the reference set to give every section a readable rhythm.
 */
export function SectionHeading({
  lead,
  title,
  body,
  align = "center",
  dark = false,
}: {
  lead?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  align?: "center" | "left";
  dark?: boolean;
}) {
  const alignment =
    align === "center" ? "text-center items-center mx-auto" : "text-left items-start";

  return (
    <div className={`flex max-w-3xl flex-col gap-5 ${alignment}`}>
      <h2
        className={`text-[clamp(2rem,4vw,3.15rem)] leading-[1.08] font-semibold ${
          dark ? "text-white" : ""
        }`}
      >
        {lead ? (
          <span className={`block ${dark ? "text-white/45" : "text-muted"}`}>
            {lead}
          </span>
        ) : null}
        <span className="block">{title}</span>
      </h2>
      {body ? (
        <p
          className={`max-w-2xl text-[1.0625rem] leading-relaxed ${
            dark ? "text-white/60" : "text-body"
          }`}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pass an empty/undefined `href` and the button renders but goes nowhere.
 * Used while the destination does not exist yet.
 */
export function Button({
  href,
  children,
  variant = "primary",
  size = "md",
  icon,
  external,
  className = "",
}: {
  href?: string | null;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "invert";
  size?: "md" | "lg";
  icon?: ReactNode;
  external?: boolean;
  className?: string;
}) {
  const variants = {
    primary:
      "bg-accent text-white hover:bg-accent-hover shadow-[0_1px_2px_rgba(16,17,26,0.16)]",
    secondary:
      "bg-paper text-ink border border-line-strong hover:border-ink/25 hover:bg-mist",
    ghost: "text-ink hover:bg-mist border border-transparent",
    invert: "bg-white text-ink hover:bg-white/90",
  } as const;

  const sizes = {
    md: "h-10 px-4 text-[15px]",
    lg: "h-12 px-6 text-[15px]",
  } as const;

  const classes = `group inline-flex shrink-0 items-center justify-center gap-2 rounded-[0.6rem] font-medium tracking-tight whitespace-nowrap transition-colors duration-150 ${variants[variant]} ${sizes[size]} ${className}`;

  if (!href) {
    return (
      <span role="button" aria-disabled="true" className={`${classes} cursor-default`}>
        {icon}
        {children}
      </span>
    );
  }

  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className={classes}
    >
      {icon}
      {children}
    </a>
  );
}

export function TextLink({
  href,
  children,
  external,
  dark = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
  dark?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className={`group inline-flex items-center gap-1.5 text-[15px] font-medium transition-colors ${
        dark ? "text-white/80 hover:text-white" : "text-accent hover:text-accent-hover"
      }`}
    >
      {children}
      <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/*  Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = "",
  dark = false,
  hover = true,
}: {
  children: ReactNode;
  className?: string;
  dark?: boolean;
  hover?: boolean;
}) {
  return (
    <div
      className={`rounded-panel border p-6 transition-colors duration-200 ${
        dark
          ? `border-white/10 bg-white/[0.03] ${hover ? "hover:border-white/20" : ""}`
          : `border-line bg-paper ${hover ? "hover:border-line-strong" : ""}`
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function IconChip({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "free" | "warn" | "dark";
}) {
  const tones = {
    accent: "bg-accent-soft text-accent",
    free: "bg-free-soft text-free",
    warn: "bg-warn-soft text-warn",
    dark: "bg-white/10 text-white",
  } as const;

  return (
    <span
      className={`inline-flex size-10 items-center justify-center rounded-[10px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({
  value,
  label,
  dark = false,
}: {
  value: string;
  label: string;
  dark?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`font-mono text-[1.75rem] leading-none font-medium tracking-tight ${
          dark ? "text-white" : "text-ink"
        }`}
      >
        {value}
      </span>
      <span
        className={`text-[13.5px] ${dark ? "text-white/50" : "text-muted"}`}
      >
        {label}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Code                                                                       */
/* -------------------------------------------------------------------------- */

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border border-line bg-mist px-1.5 py-0.5 font-mono text-[0.86em] text-ink">
      {children}
    </code>
  );
}

/** A dark, chrome-topped code panel. `lines` render as-is, monospaced. */
export function CodePanel({
  title,
  lines,
  className = "",
}: {
  title?: string;
  lines: string[];
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-panel border border-white/10 bg-graphite ${className}`}
    >
      {title ? (
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="ml-2 font-mono text-[12px] text-white/45">{title}</span>
        </div>
      ) : null}
      <pre className="thin-scroll overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.75] text-white/80">
        <code>{lines.join("\n")}</code>
      </pre>
    </div>
  );
}

/** Shell block with `$` prompts and a blinking caret on the last line. */
export function TerminalPanel({
  commands,
  caption,
}: {
  commands: { cmd: string; note?: string }[];
  caption?: string;
}) {
  return (
    <div className="overflow-hidden rounded-panel border border-white/10 bg-graphite">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="ml-2 font-mono text-[12px] text-white/45">
          {caption ?? "bash"}
        </span>
      </div>
      <div className="thin-scroll overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.9]">
        {commands.map((c, i) => (
          <div key={c.cmd}>
            {c.note ? (
              <div className="text-white/35">{`# ${c.note}`}</div>
            ) : null}
            <div className="whitespace-pre text-white/85">
              <span className="text-free select-none">$ </span>
              {c.cmd}
              {i === commands.length - 1 ? (
                <span className="caret ml-1 inline-block h-[1em] w-[7px] translate-y-[2px] bg-white/70" />
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Misc                                                                       */
/* -------------------------------------------------------------------------- */

export function Divider({ className = "" }: { className?: string }) {
  return <hr className={`border-t border-line ${className}`} />;
}

export function Badge({
  children,
  tone = "free",
}: {
  children: ReactNode;
  tone?: "free" | "accent" | "warn" | "muted";
}) {
  const tones = {
    free: "bg-free-soft text-free",
    accent: "bg-accent-soft text-accent",
    warn: "bg-warn-soft text-warn",
    muted: "bg-mist text-muted",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] tracking-tight uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
