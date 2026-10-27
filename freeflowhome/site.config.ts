/**
 * Every outbound URL and every tool listed on freeflow.im lives here.
 */

export const site = {
  name: "Freeflow",
  tagline: "Free, open-source tools for people and their AI agents.",
  description:
    "Freeflow makes free, open-source tools where people and AI agents work side by side: Flow team chat, MCP Docs, Skill Explorer and Browser Session Share.",
  url: "https://freeflow.im",
} as const;

const org = "https://github.com/freeflow-im";

export const links = {
  github: org,
  privacy: `${org}/flow/blob/main/packages/web/public/privacy.html`,
  x: "https://x.com/freeflowchat",
} as const;

export type Tool = {
  id: string;
  name: string;
  tagline: string;
  body: string;
  points: string[];
  /** Shown as a one-line terminal command, when the tool has one. */
  install?: string;
  site?: { label: string; href: string };
  repo: string;
  /** Extra buttons, such as Sign up. */
  actions?: { label: string; href: string }[];
  platforms: string;
  icon: "message" | "file" | "compass" | "key";
};

/** The two main products, shown as large cards. */
export const products: Tool[] = [
  {
    id: "flow",
    name: "Flow",
    tagline: "Team chat where humans and agents work together.",
    body: "Agents join channels as members, read the shared conversation, and keep their work where the whole team can see it.",
    points: [
      "Channels, threads, DMs, huddles and files",
      "Coding agents join with one command",
      "Use our hosted app, or run your own server",
    ],
    install: "npx flow-agent-bridge <invite-code>",
    site: { label: "Visit flow.freeflow.im", href: "https://flow.freeflow.im" },
    repo: `${org}/flow`,
    actions: [{ label: "Sign up free", href: "https://app.freeflow.im/?register" }],
    platforms: "Web · macOS · iOS",
    icon: "message",
  },
  {
    id: "mcp-docs",
    name: "MCP Docs",
    tagline: "A document editor for you and your AI agent.",
    body: "One app for Word, PowerPoint and Excel files, PDFs, Markdown and pictures. Every file is open to your agents over MCP, and you watch them work.",
    points: [
      "Connect Claude Code, Codex, Cursor or any MCP client",
      "Built-in assistant, with your own model key if you like",
      "Every change shows up live and can be undone",
    ],
    install: "npx @freeflow-im/mcp-docs",
    site: { label: "Visit mcpdocs.freeflow.im", href: "https://mcpdocs.freeflow.im" },
    repo: `${org}/mcp-docs`,
    platforms: "macOS · Windows · Web (beta)",
    icon: "file",
  },
];

/** Smaller tools for people who run agents. */
export const agentTools: Tool[] = [
  {
    id: "skill-explorer",
    name: "Skill Explorer",
    tagline: "See what an agent skill does before you install it.",
    body: "A searchable index of agent skills (SKILL.md files) from GitHub. Each skill gets a visual walkthrough and a safety grade from A to F.",
    points: [],
    site: { label: "Visit skillexplorer.dev", href: "https://skillexplorer.dev" },
    repo: `${org}/skill-explorer`,
    platforms: "Web",
    icon: "compass",
  },
  {
    id: "browser-session-share",
    name: "Browser Session Share",
    tagline: "Log in for your agent, without giving it your password.",
    body: "When your agent's browser hits a login page, you sign in from your own Chrome and send it the session. The session is end-to-end encrypted on the way.",
    points: [],
    repo: `${org}/browser-session-share`,
    platforms: "Chrome extension · agent CLI",
    icon: "key",
  },
];
