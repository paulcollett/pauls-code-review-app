import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// config.jsonc holds the port (PORT overrides it), the dirs scanned for checkouts on this Mac, the SSH remotes (repo
// values for a remote read `name:path`), the terminal Claude sessions open in, the prompts they start with and how the VM gets your GitHub token. It's JSON plus comments and trailing commas.
export type Config = {
  port: number;
  scan: string[];
  remotes: Record<string, { host: string; scan: string }>;
  // The terminal Claude sessions open in; Terminal.app when not set.
  terminal?: { type: "mac-terminal" } | { type: "ghostty" } | { type: "rex"; path: string };
  prompts?: Record<string, string>;
  // For VM Claude: the file on the VM that sets your GitHub token (sourced first) and the env var it's in. When set,
  // that token becomes GH_TOKEN and gh there must be your login before Claude starts; when not, gh is used as it is.
  githubTokenToVM?: { sources: string; name: string };
  // Test files, as globs matched from any folder like .gitignore's. One ending in /** or /**/* also names test folders,
  // which start closed in the file tree; other test files fold to their header. Hidden until "Show tests".
  tests?: string[];
  // The dependency panel beside the file tree; hidden when false.
  experimental_depHierarchyPanel?: boolean;
  // A regex for a prefix your branch names share, such as an issue number. The PR panel shows it at the end, muted, and
  // PR worktrees are named without it.
  prPanelBranchStrip?: string;
  // PR labels, each with a color: each gets a tab in the PR panel, and its PRs are tinted that color.
  prPanelLabels?: Record<string, string>;
  // The folder, beside a clone, that PR and new-agent worktrees go in; ".worktrees" when not set.
  worktreesFolder?: string;
};

export const worktreesFolder = () => config.worktreesFolder || ".worktrees";

// prPanelBranchStrip as a regex anchored at the branch's start, or null.
export const branchStrip = () => (config.prPanelBranchStrip ? new RegExp(`^(?:${config.prPanelBranchStrip})`) : null);

const STRING = String.raw`("(?:[^"\\]|\\.)*")`;
const stripJsonc = (text: string) =>
  text
    .replace(new RegExp(String.raw`${STRING}|//[^\n]*|/\*[\s\S]*?\*/`, "g"), (_, str) => str ?? "")
    .replace(new RegExp(String.raw`${STRING}|,(\s*[}\]])`, "g"), (_, str, close) => str ?? close);

// config.jsonc is yours and git-ignored; a fresh clone without one runs on config.example.jsonc.
const file = ["config.jsonc", "config.example.jsonc"].map((name) => join(import.meta.dirname, name)).find((path) => existsSync(path));
if (!file) throw new Error("No config.jsonc: copy config.example.jsonc to config.jsonc");
export const config: Config = JSON.parse(stripJsonc(readFileSync(file, "utf8")));
