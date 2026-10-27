/**
 * Every outbound URL and top-level fact about Freeflow lives here.
 */

export const site = {
  name: "Freeflow",
  tagline: "Team chat where humans and agents work together.",
  description:
    "Freeflow is team chat where people and AI agents work together. Agents join channels as members, use the shared conversation as context, and keep their work visible to the whole team.",
  url: "https://flow.freeflow.im",
  repo: "freeflow-im/flow",
  /** The Freeflow home page, which lists every Freeflow tool. */
  home: "https://freeflow.im",
} as const;

/**
 * Routes that exist in the codebase but are not ready for visitors yet.
 * Flip a flag to true and the page goes live, plus its nav and footer links.
 */
export const routes: Record<"agents" | "migrate" | "selfHost", boolean> = {
  agents: false,
  migrate: false,
  selfHost: false,
};

const repo = "https://github.com/freeflow-im/flow";

export const links = {
  /** The live app. Every Log in button points here. */
  login: "https://app.freeflow.im",
  /** The live app, opened on its Register form. Every Sign up button points here. */
  signup: "https://app.freeflow.im/?register",

  github: repo,
  privacy: `${repo}/blob/main/packages/web/public/privacy.html`,
  terms: `${repo}/blob/main/LICENSE.md`,
  issues: `${repo}/issues`,
  discussions: `${repo}/discussions`,

  // Kept for the pages that are currently hidden.
  docs: `${repo}/tree/main/docs`,
  agentMembers: `${repo}/blob/main/docs/integrators/AGENT_MEMBERS.md`,
  agentsDesign: `${repo}/blob/main/docs/design/AGENTS_DESIGN.md`,
  storage: `${repo}/blob/main/docs/design/STORAGE.md`,
  deployment: `${repo}/blob/main/docs/ops/DEPLOYMENT.md`,
  macosReadme: `${repo}/blob/main/apps/macos/README.md`,
  appsDocs: `${repo}/blob/main/docs/integrators/APPS.md`,
  changelog: `${repo}/blob/main/CHANGELOG.md`,
  decisionLog: `${repo}/blob/main/decision_log.md`,
  todo: `${repo}/blob/main/TODO.md`,
  contributing: `${repo}/blob/main/CONTRIBUTING.md`,
  license: `${repo}/blob/main/LICENSE`,
  overview: `${repo}/blob/main/docs/specs/overview.md`,
  ios: "https://apps.apple.com/us/app/freeflow-team-chat/id6795695042",
  discord: "https://discord.gg/freeflow",
  x: "https://x.com/freeflowchat",

  // internal routes
  agents: "/agents",
  migrate: "/migrate",
  selfHost: "/self-host",
} as const;

/** Short, checkable facts. Nothing that needs a footnote. */
export const specs = [
  { value: "$0", label: "forever, any team size" },
  { value: "Open", label: "source, built in public" },
  { value: "Native", label: "agents, not add-ons" },
  { value: "3", label: "commands to self-host" },
] as const;
