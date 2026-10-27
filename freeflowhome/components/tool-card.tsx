import type { Tool } from "@/site.config";
import { Button, IconChip } from "@/components/ui";
import {
  ArrowRight,
  Check,
  Compass,
  FileText,
  Github,
  Key,
  Message,
} from "@/components/icons";

const icons = {
  message: Message,
  file: FileText,
  compass: Compass,
  key: Key,
} as const;

/**
 * One tool. `large` is for the main products: it adds the bullet list and the
 * install line, which the smaller agent tools leave out.
 */
export function ToolCard({ tool, large = false }: { tool: Tool; large?: boolean }) {
  const Glyph = icons[tool.icon];

  return (
    <article
      id={tool.id}
      className={`flex h-full flex-col rounded-surface border border-line bg-paper transition-colors duration-200 hover:border-line-strong ${
        large ? "gap-6 p-7 sm:p-9" : "gap-5 p-6 sm:p-7"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <IconChip>
          <Glyph className="size-5" />
        </IconChip>
        <span className="pt-2 text-right font-mono text-[11.5px] tracking-tight text-muted">
          {tool.platforms}
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        <h3 className={large ? "text-[1.75rem] leading-tight" : "text-[1.3rem] leading-tight"}>
          {tool.name}
        </h3>
        <p className={`font-medium text-ink ${large ? "text-[1.125rem]" : "text-[1rem]"}`}>
          {tool.tagline}
        </p>
        <p className="text-[15.5px] leading-relaxed text-body">{tool.body}</p>
      </div>

      {large && tool.points.length ? (
        <ul className="flex flex-col gap-2.5">
          {tool.points.map((point) => (
            <li key={point} className="flex items-start gap-2.5 text-[15px] text-body">
              <Check className="mt-1 size-4 shrink-0 text-free" />
              {point}
            </li>
          ))}
        </ul>
      ) : null}

      {large && tool.install ? (
        <div className="thin-scroll overflow-x-auto rounded-card bg-graphite px-4 py-3 font-mono text-[12.5px] whitespace-pre text-white/85">
          <span className="text-free select-none">$ </span>
          {tool.install}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-3 pt-1">
        {tool.site ? (
          <Button
            href={tool.site.href}
            size={large ? "lg" : "md"}
            icon={<ArrowRight className="size-[18px]" />}
          >
            {tool.site.label}
          </Button>
        ) : null}
        {tool.actions?.map((action) => (
          <Button
            key={action.href}
            href={action.href}
            variant="secondary"
            size={large ? "lg" : "md"}
            external
          >
            {action.label}
          </Button>
        ))}
        <Button
          href={tool.repo}
          variant={tool.site ? "ghost" : "secondary"}
          size={large ? "lg" : "md"}
          external
          icon={<Github className="size-[17px]" />}
        >
          {tool.site ? "Source" : "View on GitHub"}
        </Button>
      </div>
    </article>
  );
}
