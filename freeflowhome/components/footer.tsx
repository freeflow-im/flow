import Link from "next/link";
import { links, site } from "@/site.config";
import { Container } from "@/components/ui";
import { Github, Logo } from "@/components/icons";

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line bg-paper">
      <Container className="py-6">
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo className="size-6 text-ink" />
            <span className="text-[15px] font-semibold tracking-tight text-ink">
              Freeflow
            </span>
          </Link>

          <p className="text-[12px] text-muted sm:absolute sm:left-1/2 sm:-translate-x-1/2">
            © {year} {site.name}. Free and open source.
          </p>

          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <a
              href={links.github}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 text-[12px] text-muted transition-colors hover:text-ink"
            >
              <Github className="size-[14px]" />
              GitHub
            </a>
            <a
              href={links.privacy}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[12px] text-muted transition-colors hover:text-ink"
            >
              Privacy
            </a>
          </nav>
        </div>
      </Container>
    </footer>
  );
}
