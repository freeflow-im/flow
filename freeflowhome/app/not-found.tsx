import { Button, Container } from "@/components/ui";
import { ArrowRight } from "@/components/icons";

export default function NotFound() {
  return (
    <section className="flex min-h-[70vh] items-center py-32">
      <Container>
        <div className="mx-auto flex max-w-lg flex-col items-center gap-5 text-center">
          <span className="font-mono text-[13px] text-muted">404</span>
          <h1 className="text-[clamp(2rem,5vw,3rem)] leading-tight font-semibold">
            This page doesn&rsquo;t <em className="serif-accent text-accent">exist</em>.
          </h1>
          <p className="text-[1.0625rem] leading-relaxed text-body">
            Looking for Flow? It moved to flow.freeflow.im.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Button href="/" size="lg" icon={<ArrowRight className="size-[18px]" />}>
              Freeflow home
            </Button>
            <Button href="https://flow.freeflow.im" variant="secondary" size="lg">
              Go to Flow
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}
