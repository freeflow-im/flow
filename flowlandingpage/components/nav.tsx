"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { links, site } from "@/site.config";
import { Button } from "@/components/ui";
import { Github, Logo, Menu, Cross } from "@/components/icons";

const nav = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Why Freeflow", href: "/#why-freeflow" },
  { label: "Open source", href: "/#open-source" },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

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
          onClick={() => setOpen(false)}
        >
          <Logo className="size-7 text-ink" />
          <span className="text-[17px]">Freeflow</span>
        </Link>

        <ul className="hidden items-center gap-1 lg:flex">
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

        <div className="hidden items-center gap-2 lg:flex">
          <a
            href={links.github}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Freeflow on GitHub"
            className="inline-flex size-10 items-center justify-center rounded-full text-body transition-colors hover:bg-mist hover:text-ink"
          >
            <Github className="size-[19px]" />
          </a>
          <Button href={links.login} variant="ghost" external>
            Log in
          </Button>
          <Button href={links.signup} variant="primary" external>
            Sign up free
          </Button>
        </div>

        <div className="flex items-center gap-2 lg:hidden">
          <a
            href={links.github}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Freeflow on GitHub"
            className="inline-flex size-10 items-center justify-center rounded-full text-body"
          >
            <Github className="size-[19px]" />
          </a>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex size-10 items-center justify-center rounded-full border border-line text-ink"
          >
            {open ? <Cross className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>

      {open ? (
        <div className="border-t border-line bg-paper lg:hidden">
          <ul className="mx-auto flex w-full max-w-6xl flex-col px-5 py-3 sm:px-8">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block border-b border-line py-3.5 text-[16px] font-medium text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <a
                href={site.home}
                className="block border-b border-line py-3.5 text-[16px] font-medium text-ink"
              >
                More Freeflow tools
              </a>
            </li>
            <li className="flex flex-col gap-2 pt-4 pb-2">
              <Button href={links.signup} variant="primary" size="lg" external>
                Sign up free
              </Button>
              <Button href={links.login} variant="secondary" size="lg" external>
                Log in
              </Button>
            </li>
          </ul>
        </div>
      ) : null}
    </header>
  );
}
