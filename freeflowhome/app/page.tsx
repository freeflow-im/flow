import { agentTools, links, products } from "@/site.config";
import { Button, Container, Eyebrow, Section, SectionHeading } from "@/components/ui";
import { ArrowDown, Github } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { ToolCard } from "@/components/tool-card";

const principles = [
  {
    title: "Free to use",
    body: "Every tool is free to download or use online. You can also run it yourself.",
  },
  {
    title: "Open source",
    body: "The source for every tool is on GitHub. We build in public, so you can read it, run it and change it.",
  },
  {
    title: "Made for agents",
    body: "Agents are users here, not an add-on. They work over open protocols like MCP, in the same place you do.",
  },
];

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden pt-36 pb-20 sm:pt-44 sm:pb-24">
        <div
          aria-hidden="true"
          className="dot-grid pointer-events-none absolute inset-0 text-line-strong/60 [mask-image:radial-gradient(ellipse_at_top,#000_20%,transparent_70%)]"
        />
        <Container className="relative">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-7 text-center">
            <Eyebrow tone="free">Free and open source</Eyebrow>
            <h1 className="text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.04] font-semibold">
              Tools for people{" "}
              <em className="serif-accent text-accent">and</em> their agents.
            </h1>
            <p className="max-w-2xl text-[1.1875rem] leading-relaxed text-body">
              Freeflow makes free, open-source tools where you and your AI
              agents work side by side: in team chat, in your documents, and in
              the browser.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button href="#tools" size="lg" icon={<ArrowDown className="size-[18px]" />}>
                See the tools
              </Button>
              <Button
                href={links.github}
                variant="secondary"
                size="lg"
                external
                icon={<Github className="size-[18px]" />}
              >
                freeflow-im on GitHub
              </Button>
            </div>
          </div>
        </Container>
      </section>

      {/* Products */}
      <Section id="tools" tone="mist">
        <Container>
          <SectionHeading
            lead="Two apps,"
            title={
              <>
                one <em className="serif-accent text-accent">shared</em> workspace.
              </>
            }
            body="Talk with your team and your agents in Flow. Write and edit files with them in MCP Docs."
          />
          <div className="mt-14 grid gap-6 lg:grid-cols-2">
            {products.map((tool, i) => (
              <Reveal key={tool.id} delay={i * 80}>
                <ToolCard tool={tool} large />
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* Agent tools */}
      <Section>
        <Container>
          <SectionHeading
            align="left"
            lead="For people who run agents"
            title="Small tools that solve one problem."
          />
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {agentTools.map((tool, i) => (
              <Reveal key={tool.id} delay={i * 80}>
                <ToolCard tool={tool} />
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>

      {/* Principles */}
      <Section id="open-source" tone="dark">
        <Container>
          <SectionHeading
            dark
            lead="How we build"
            title={
              <>
                Free, open, and <em className="serif-accent">built in public</em>.
              </>
            }
          />
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {principles.map((p) => (
              <div
                key={p.title}
                className="flex flex-col gap-3 rounded-panel border border-white/10 bg-white/[0.03] p-6"
              >
                <h3 className="text-[1.15rem] text-white">{p.title}</h3>
                <p className="text-[15.5px] leading-relaxed text-white/60">{p.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-12 flex justify-center">
            <Button
              href={links.github}
              variant="invert"
              size="lg"
              external
              icon={<Github className="size-[18px]" />}
            >
              Browse all repos
            </Button>
          </div>
        </Container>
      </Section>
    </>
  );
}
