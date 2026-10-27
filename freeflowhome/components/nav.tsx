"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { links } from "@/site.config";
import { Github, Logo } from "@/components/icons";

const nav = [
  { label: "Tools", href: "/#tools" },
  { label: "Open source", href: "/#open-source" },
];

/** One short row: few enough links that it never needs a mobile menu. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-200 ${
        scrolled
          ? "border-b border-line bg-paper/85 backdrop-blur-xl"
          : "border-b border-transparent bg-paper/0"
      }`}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8"
      >
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 font-semibold tracking-tight text-ink"
        >
          <Logo className="size-7 text-ink" />
          <span className="text-[17px]">Freeflow</span>
        </Link>

        <div className="flex items-center gap-1">
          <ul className="flex items-center gap-1">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="rounded-full px-3 py-2 text-[14px] font-medium text-body transition-colors hover:bg-mist hover:text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <a
            href={links.github}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Freeflow on GitHub"
            className="inline-flex size-10 items-center justify-center rounded-full text-body transition-colors hover:bg-mist hover:text-ink"
          >
            <Github className="size-[19px]" />
          </a>
        </div>
      </nav>
    </header>
  );
}
