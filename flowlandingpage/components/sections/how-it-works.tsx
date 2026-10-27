import { steps } from "@/lib/content";
import { Reveal } from "@/components/reveal";
import { Container, Section, SectionHeading } from "@/components/ui";
import { Check, Github } from "@/components/icons";

/* Each step gets a small picture instead of a second paragraph. */

function TerminalVisual() {
  return (
    <div className="overflow-hidden rounded-[10px] border border-white/10 bg-graphite px-3.5 py-3 font-mono text-[11.5px] leading-[1.85]">
      <div className="text-white/85">
        <span className="text-free select-none">$ </span>docker compose up -d
      </div>
      <div className="text-white/85">
        <span className="text-free select-none">$ </span>pnpm dev
      </div>
      <div className="mt-1 text-free">✓ ready on 127.0.0.1:8787</div>
    </div>
  );
}

function InviteVisual() {
  const people = [
    { initials: "PR", color: "#c2410c" },
    { initials: "SO", color: "#0e7490" },
    { initials: "MK", color: "#3f6212" },
    { initials: "AL", color: "#7c3aed" },
  ];

  return (
    <div className="rounded-[10px] border border-line bg-mist px-3.5 py-3">
      <code className="block truncate font-mono text-[11.5px] text-accent">
        freeflow://invite/8f3a…c214
      </code>
      <div className="mt-3 flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {people.map((p) => (
            <span
              key={p.initials}
              className="inline-flex size-6 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 ring-mist"
              style={{ backgroundColor: p.color }}
            >
              {p.initials}
            </span>
          ))}
        </div>
        <span className="inline-flex items-center gap-1 text-[11.5px] text-free">
          <Check className="size-3" />
          joined
        </span>
      </div>
    </div>
  );
}

function AgentVisual() {
  return (
    <div className="rounded-[10px] border border-line bg-mist px-3.5 py-3">
      <code className="block truncate font-mono text-[11.5px] text-body">
        reads freeflow-im/flow · can push
      </code>
      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-[6px] bg-accent text-[9px] font-semibold text-white">
          RB
        </span>
        <span className="text-[12px] font-medium text-ink">review-bot</span>
        <span className="rounded bg-accent-soft px-1 py-px font-mono text-[9px] tracking-wide text-accent uppercase">
          app
        </span>
        <span className="ml-auto size-1.5 rounded-full bg-[#3fbf7f]" />
      </div>
    </div>
  );
}

const visuals = [TerminalVisual, InviteVisual, AgentVisual];

export function HowItWorks() {
  return (
    <Section id="how" tone="paper">
      <Container>
        <Reveal>
          <SectionHeading
            lead="No signup. No sales call."
            title={
              <>
                Three steps, then it&rsquo;s{" "}
                <em className="serif-accent text-accent">yours</em>.
              </>
            }
          />
        </Reveal>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {steps.map((s, i) => {
            const Visual = visuals[i];
            return (
              <Reveal key={s.n} delay={i * 90}>
                <div className="flex h-full flex-col rounded-panel border border-line bg-paper p-6">
                  <span className="font-mono text-[12px] text-accent">{s.n}</span>
                  <h3 className="mt-3 text-[1.0625rem] font-semibold">
                    {s.title}
                  </h3>
                  <p className="mt-1.5 text-[14.5px] leading-relaxed text-body">
                    {s.body}
                  </p>
                  <div className="mt-5">
                    <Visual />
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={280}>
          <p className="mt-8 flex flex-wrap items-center justify-center gap-2 text-center text-[14px] text-muted">
            <Github className="size-4" />
            Nothing to sign up for. The whole thing is a repo.
          </p>
        </Reveal>
      </Container>
    </Section>
  );
}
