/** Canonical origin. Override with NEXT_PUBLIC_SITE_URL for previews. */
export const siteUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:3000" : "https://pcskit.causly.in")
).replace(/\/$/, "");

export const site = {
  name: "PCSKit",
  fullName: "PCSKit: Project Continuity Kit",
  tagline: "Your AI agent stopped. The next one picks up exactly where it left off.",
  description:
    "PCSKit is a local-first CLI and MCP server that hands work from one AI coding agent to the next, with every fact labelled verified, reported or inferred.",
  version: "0.1.0",
  license: "Apache-2.0",
  packageName: "@knihal/pcskit",
  installCommand: "npm install -g @knihal/pcskit",
  repo: "https://github.com/KNIHAL/pcskit",
  npm: "https://www.npmjs.com/package/@knihal/pcskit",
} as const;
