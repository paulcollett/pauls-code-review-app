import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import ts from "typescript";
import { branchStrip, config, worktreesFolder } from "./load-config.ts";

type Line = { kind: "add" | "del" | "ctx"; old?: number; new?: number; text: string };
type Hunk = { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: Line[] };
type FileDiff = {
  path: string;
  oldPath: string | null;
  status: "added" | "removed" | "modified" | "renamed";
  untracked: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
};

// A checkout on this Mac (host null) or on an SSH remote; `label` is the repo value the page uses, `home` that machine's $HOME.
type Repo = { host: string | null; top: string; label: string; home: string };

const port = Number(process.env.PORT ?? config.port);
const indexHtml = join(import.meta.dirname, "index.html");
const scanDirs = config.scan;
const remotes = new Map(Object.entries(config.remotes).map(([name, { host, scan }]) => [name, { target: host, scan }]));

// -A so fetches on the remote can use this Mac's GitHub key; -C because the link is bandwidth-bound and source compresses
// several-fold; one shared connection keeps each call cheap.
const sshOptions = [
  "-A",
  "-C",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=/tmp/code-diff-ssh-%C",
  "-o", "ControlPersist=10m",
];

type PullRequest = {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  headRefName: string;
  isDraft: boolean;
  author: { login: string; is_bot: boolean };
  assignees: { login: string }[];
  labels: { name: string }[];
  mergedBy: { login: string } | null;
};

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Stale-while-revalidate per key: a cached value returns at once and an old one refreshes in the background; concurrent callers share one run.
function swr<T>(ttl: number, fn: (key: string) => Promise<T>) {
  const entries = new Map<string, { value?: T; at: number; pending?: Promise<T> }>();
  return async (key: string): Promise<T> => {
    const entry = entries.get(key) ?? { at: 0 };
    entries.set(key, entry);
    const refresh = () =>
      (entry.pending ??= fn(key)
        .then((value) => {
          entry.value = value;
          entry.at = Date.now();
          return value;
        })
        .finally(() => (entry.pending = undefined)));
    if (entry.value === undefined) return refresh();
    if (Date.now() - entry.at > ttl) refresh().catch(() => {});
    return entry.value;
  };
}

// One run per checkout shared by every caller within `ms` of its start, such as the picker's two requests, or a
// lookup that rarely changes; on a remote each skipped run is an SSH round trip saved. A failed run isn't kept.
function shared<T>(ms: number, fn: (r: Repo) => Promise<T>) {
  const runs = new Map<string, { at: number; value: Promise<T> }>();
  return (r: Repo): Promise<T> => {
    const run = runs.get(r.label);
    if (run && Date.now() - run.at < ms) return run.value;
    const value = fn(r);
    runs.set(r.label, { at: Date.now(), value });
    value.catch(() => runs.delete(r.label));
    return value;
  };
}

// sshd refuses channels past MaxSessions (default 10) on the one shared connection, and /sources alone fans out ~25
// git calls; long-lived cat-file batches stay outside the cap and use the headroom left.
const sshSlots = new Map<string, { active: number; waiting: (() => void)[] }>();

async function withSshSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const slot = sshSlots.get(host) ?? { active: 0, waiting: [] };
  sshSlots.set(host, slot);
  if (slot.active >= 6) await new Promise<void>((resolve) => slot.waiting.push(resolve));
  else slot.active++;
  try {
    return await fn();
  } finally {
    const next = slot.waiting.shift();
    if (next) next();
    else slot.active--;
  }
}

function git(r: Repo, args: string[], okCodes = [0]) {
  const full = ["-c", "core.quotePath=false", ...args];
  if (!r.host) return run("git", full, r.top, okCodes);
  const host = r.host;
  return withSshSlot(host, () => run("ssh", [...sshOptions, host, `cd ${shq(r.top)} && git ${full.map(shq).join(" ")}`], homedir(), okCodes));
}

function spawnGit(r: Repo, args: string[]) {
  return r.host
    ? spawn("ssh", [...sshOptions, r.host, `cd ${shq(r.top)} && git ${args.map(shq).join(" ")}`])
    : spawn("git", args, { cwd: r.top });
}

function remoteShell(host: string, script: string, input = ""): Promise<Buffer> {
  return withSshSlot(host, () => new Promise<Buffer>((resolve, reject) => {
    const proc = spawn("ssh", [...sshOptions, host, script]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", spawnError("ssh", reject));
    proc.on("close", () => resolve(Buffer.concat(chunks)));
    proc.stdin.end(input);
  }));
}

// What to do when a command isn't on the server's PATH (it has the PATH of the shell that started it), shown in the
// page's error or toast.
const INSTALL: Record<string, string> = {
  code: "VS Code's command line `code` isn't set up. In VS Code, run \"Shell Command: Install 'code' command in PATH\", or ask Claude.",
  gh: "The GitHub CLI `gh` isn't installed. Install it (brew install gh) and run gh auth login, or ask Claude.",
  git: "`git` isn't installed. Run xcode-select --install, or ask Claude.",
};

function notFound(cmd: string) {
  return new Error(INSTALL[cmd] ?? `\`${cmd}\` isn't installed or isn't on the code-diff server's PATH. Ask Claude.`);
}

// A spawn's "error" handler: a missing command becomes notFound's message, anything else passes through.
const spawnError = (cmd: string, reject: (e: Error) => void) => (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? notFound(cmd) : e);

function run(cmd: string, args: string[], cwd: string, okCodes = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err?.code === "ENOENT") return reject(existsSync(cwd) ? notFound(cmd) : new Error(`Checkout folder not found: ${cwd}`));
        const code = err ? err.code : 0;
        if (typeof code === "number" && okCodes.includes(code)) resolve(stdout);
        else reject(new Error(stderr.trim() || err?.message));
      },
    );
  });
}

function expandHome(p: string) {
  return p.replace(/^~(?=$|\/)/, homedir());
}

function tildify(path: string, home = homedir()) {
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

// Remote paths are given relative to the remote home, so `~` never needs the remote shell to expand it inside quotes.
const homeRelative = (p: string) => p.replace(/^~\/?/, "") || ".";

// A remote file that is missing or not a regular file comes back as -1 instead of a size.
async function readRepoFiles(r: Repo, rels: string[]): Promise<(Buffer | null)[]> {
  if (!r.host) return Promise.all(rels.map((rel) => readFile(join(r.top, rel)).catch(() => null)));
  if (!rels.length) return [];
  const script = `cd ${shq(r.top)} && while IFS= read -r f; do if [ -f "$f" ]; then wc -c < "$f"; cat -- "$f"; else echo -1; fi; done`;
  const buf = await remoteShell(r.host, script, rels.map((rel) => rel + "\n").join(""));
  const out: (Buffer | null)[] = [];
  let i = 0;
  for (const _ of rels) {
    const nl = buf.indexOf(10, i);
    const size = Number(buf.subarray(i, nl).toString().trim());
    i = nl + 1;
    if (!(size >= 0)) {
      out.push(null);
      continue;
    }
    out.push(buf.subarray(i, i + size));
    i += size;
  }
  return out;
}

async function mtimes(r: Repo, rels: string[]) {
  if (!r.host) return Promise.all(rels.map((rel) => stat(join(r.top, rel)).then((s) => s.mtimeMs, () => 0)));
  if (!rels.length) return [];
  const script = `cd ${shq(r.top)} && while IFS= read -r f; do stat -c %Y -- "$f" 2>/dev/null || echo 0; done`;
  const out = await remoteShell(r.host, script, rels.map((rel) => rel + "\n").join(""));
  return out.toString().split("\n").filter(Boolean).map((s) => Number(s) * 1000);
}

function unquote(p: string) {
  return p.startsWith('"') ? JSON.parse(p) : p;
}

function stripPrefix(p: string) {
  return unquote(p.replace(/\t$/, "")).replace(/^[ab]\//, "");
}

function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = {
        path: m?.[2] ?? "",
        oldPath: m?.[1] ?? null,
        status: "modified",
        untracked: false,
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      hunk = undefined;
      files.push(file);
      continue;
    }
    if (!file) continue;

    if (hunk) {
      const sign = line[0];
      if (sign === "+") {
        hunk.lines.push({ kind: "add", new: newNo++, text: line.slice(1) });
        file.additions++;
        continue;
      }
      if (sign === "-") {
        hunk.lines.push({ kind: "del", old: oldNo++, text: line.slice(1) });
        file.deletions++;
        continue;
      }
      if (sign === " ") {
        hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) });
        continue;
      }
      if (sign === "\\") continue;
    }

    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      hunk = {
        header: line,
        oldStart: oldNo,
        oldCount: Number(h[2] ?? 1),
        newStart: newNo,
        newCount: Number(h[4] ?? 1),
        lines: [],
      };
      file.hunks.push(hunk);
    } else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "removed";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
    else if (line.startsWith("--- ") && line !== "--- /dev/null") file.oldPath = stripPrefix(line.slice(4));
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = stripPrefix(line.slice(4));
    else if (line.startsWith("Binary files ")) file.binary = true;
  }

  for (const f of files) {
    if (f.status === "removed" && f.oldPath) f.path = f.oldPath;
    if (f.status !== "renamed") f.oldPath = null;
  }
  return files;
}

function untrackedFile(path: string, buf: Buffer | null): FileDiff {
  const file: FileDiff = {
    path,
    oldPath: null,
    status: "added",
    untracked: true,
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
  if (!buf || buf.subarray(0, 8000).includes(0)) {
    file.binary = true;
    return file;
  }
  const lines = buf.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  file.additions = lines.length;
  if (lines.length) {
    file.hunks.push({
      header: `@@ -0,0 +1,${lines.length} @@`,
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: lines.length,
      lines: lines.map((text, i) => ({ kind: "add", new: i + 1, text })),
    });
  }
  return file;
}

const toplevels = new Map<string, Promise<Repo>>();

// Checkout locations are resolved once per repo value, but a worktree can be removed while a page still points at
// it, so a cached Mac checkout whose folder is gone is looked up again; a failed lookup is retried next time.
async function toplevel(dir: string) {
  const cached = toplevels.get(dir);
  if (cached) {
    const r = await cached.catch(() => null);
    if (r && (r.host || existsSync(r.top))) return r;
    toplevels.delete(dir);
  }
  const found = findToplevel(dir);
  toplevels.set(dir, found);
  found.catch(() => toplevels.delete(dir));
  return found;
}

async function findToplevel(dir: string): Promise<Repo> {
  const m = /^([\w-]+):(.*)$/.exec(dir);
  const remote = m && remotes.get(m[1]);
  if (!m || !remote) {
    const top = (await run("git", ["rev-parse", "--show-toplevel"], expandHome(dir))).trim();
    return { host: null, top, label: tildify(top), home: homedir() };
  }
  const script = `cd ~ && cd ${shq(homeRelative(m[2]))} && git rev-parse --show-toplevel && echo "$HOME"`;
  const out = await withSshSlot(remote.target, () => run("ssh", [...sshOptions, remote.target, script], homedir()));
  const [top, home] = out.trim().split("\n");
  return { host: remote.target, top, label: `${m[1]}:${tildify(top, home)}`, home };
}

// Without origin/HEAD, as in a local-only repo, the base is the first of these that exists, else HEAD so only
// uncommitted changes show.
const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

const defaultBranch = shared(60_000, async (r) => {
  const head = await git(r, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then((s) => s.trim(), () => "");
  if (head) return head;
  const refs = ["refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"];
  const found = new Set((await git(r, ["for-each-ref", "--format=%(refname:short)", ...refs]).catch(() => "")).split("\n"));
  return BASE_CANDIDATES.find((ref) => found.has(ref)) ?? "HEAD";
});

function repoPath(path: string) {
  const rel = posix.normalize(path);
  if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) throw new Error(`Path outside worktree: ${path}`);
  return rel;
}

const githubRepo = shared(60_000, async (r) => {
  const remote = (await git(r, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  return /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)?.[1] ?? null;
});

const userEmail = shared(60_000, (r) => git(r, ["config", "user.email"]).then((s) => s.trim(), () => ""));

// `pushed` means origin has the branch, so its files have a blob URL on GitHub.
async function githubInfo(r: Repo, from: string | null) {
  const [repo, current] = await Promise.all([
    githubRepo(r),
    from ? "" : git(r, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
  ]);
  if (!repo) return null;
  const branch = from ? from.replace(/^origin\//, "") : current.trim();
  const pushed = Boolean(branch) && !(from && prRef(from))
    && (await git(r, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).then(() => true, () => false));
  return { url: `https://github.com/${repo}`, branch, pushed };
}

async function verifyRef(r: Repo, ref: string) {
  if (ref.startsWith("-")) throw new Error(`Invalid ref: ${ref}`);
  await git(r, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => {
    throw new Error(`Unknown branch or commit: ${ref}`);
  });
}

// Without `from`, the diff is against the files on disk, so uncommitted and untracked changes show up too.
function source(q: URLSearchParams) {
  const repo = q.get("repo");
  if (!repo) throw new Error("repo is required");
  return { dir: repo, ref: q.get("from") || null };
}

// A `#123` from is a pull request; its head is fetched into our own ref so merged PRs with deleted branches still resolve.
function prRef(from: string) {
  const pr = /^#(\d+)$/.exec(from);
  return pr ? `refs/code-diff/pr/${pr[1]}` : null;
}

// A PR's base is fetched with it; a stale local origin/<base> would put everything merged since into the PR's diff.
async function fetchPr(r: Repo, from: string, to: string) {
  const ref = `refs/code-diff/pr/${from.slice(1)}`;
  const base = /^origin\/(.+)$/.exec(to)?.[1];
  const refspecs = [`+refs/pull/${from.slice(1)}/head:${ref}`, ...(base ? [`+refs/heads/${base}:refs/remotes/origin/${base}`] : [])];
  await git(r, ["fetch", "--quiet", "origin", ...refspecs]);
  return ref;
}

// When each PR was last fetched, keyed like its watcher, so a burst of refreshes fetches it once.
const prFetches = new Map<string, { at: number; pending?: Promise<void> }>();

// A PR already fetched is diffed from its local ref without waiting on GitHub, then fetched again in the background;
// the page is told to refresh only if that moved what the diff is between: the PR's head, and the merge-base (or the
// base itself for a direct diff), since the base branch moving on doesn't change a merge-base diff.
function refetchPr(r: Repo, from: string, to: string, mergeBase: boolean) {
  const key = `${r.label}|${from}`;
  const state = prFetches.get(key) ?? { at: 0 };
  prFetches.set(key, state);
  if (state.pending || Date.now() - state.at < 15_000) return;
  const ref = prRef(from)!;
  const ends = () => Promise.all([git(r, ["rev-parse", ref]), git(r, mergeBase ? ["merge-base", to, ref] : ["rev-parse", to])]).then((x) => x.join(" "));
  state.pending = ends()
    .then(async (before) => {
      await fetchPr(r, from, to);
      if ((await ends()) !== before) notifyWatchers(key);
    })
    .catch(() => {})
    .finally(() => {
      state.at = Date.now();
      state.pending = undefined;
    });
}

async function untrackedFiles(r: Repo) {
  const paths = (await git(r, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const contents = await readRepoFiles(r, paths);
  return paths.map((path, i) => untrackedFile(path, contents[i]));
}

// On a remote every git call is an SSH round trip, so side lookups run alongside the to → merge-base → diff chain,
// and refs are only checked one by one to explain a failure.
async function diff(dir: string, from: string | null, requestedTo: string | null, mergeBase: boolean) {
  const r = await toplevel(dir);
  const explain = async (to: string, ref: string | null): Promise<never> => {
    await verifyRef(r, to);
    if (ref) await verifyRef(r, ref);
    throw new Error(`Cannot compare ${ref ?? "HEAD"} with ${to}`);
  };
  const compare = async () => {
    const to = requestedTo || (await defaultBranch(r));
    if (to.startsWith("-") || from?.startsWith("-")) throw new Error("Invalid ref");
    const diffArgs = (base: string, ref: string | null) => ["diff", "--no-color", "--no-ext-diff", "-M", base, ...(ref ? [ref] : []), "--"];
    // On a remote the merge-base and the diff go in one SSH call, its first line the base.
    const between = async (ref: string | null) => {
      if (mergeBase && r.host) {
        const host = r.host;
        const diffCmd = diffArgs("BASE", ref).map((a) => (a === "BASE" ? '"$b"' : shq(a))).join(" ");
        const script = `cd ${shq(r.top)} && b=$(git merge-base ${shq(to)} ${shq(ref || "HEAD")}) && echo "$b" && git -c core.quotePath=false ${diffCmd}`;
        const out = await withSshSlot(host, () => run("ssh", [...sshOptions, host, script], homedir()));
        const newline = out.indexOf("\n");
        return { to, base: out.slice(0, newline), files: parseDiff(out.slice(newline + 1)) };
      }
      const base = mergeBase ? (await git(r, ["merge-base", to, ref || "HEAD"])).trim() : to;
      return { to, base, files: parseDiff(await git(r, diffArgs(base, ref))) };
    };
    const pr = from && prRef(from);
    if (!pr) return between(from).catch(() => explain(to, from));
    // Only a PR never fetched here waits on the fetch, found by its local ref being missing.
    const local = await between(pr).catch(() => null);
    if (local) {
      refetchPr(r, from, to, mergeBase);
      return local;
    }
    await fetchPr(r, from, to);
    prFetches.set(`${r.label}|${from}`, { at: Date.now() });
    return between(pr).catch(() => explain(to, pr));
  };
  const [head, github, untracked, { to, base, files }] = await Promise.all([
    from ? "" : git(r, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()),
    githubInfo(r, from),
    from ? [] : untrackedFiles(r),
    compare(),
  ]);
  return { repo: r.label, head, from, to, base, files: [...files, ...untracked], github };
}

async function fileContent(r: Repo, from: string | null, path: string) {
  const rel = repoPath(path);
  if (!from) {
    const [content] = await readRepoFiles(r, [rel]);
    if (!content) throw new Error(`Cannot read ${rel}`);
    return content;
  }
  const ref = prRef(from) ?? from;
  await verifyRef(r, ref);
  return git(r, ["show", `${ref}:${rel}`]);
}

const prList = swr(60_000, async (repo): Promise<PullRequest[]> => {
  const fields = "number,title,state,updatedAt,headRefName,isDraft,author,assignees,labels,mergedBy";
  const out = await run("gh", ["pr", "list", "-R", repo, "--state", "all", "--limit", "100", "--search", "sort:updated-desc", "--json", fields], homedir());
  return JSON.parse(out);
});

// GitHub's own rendering of the description, already sanitized, so the page can show it as HTML.
const prDescription = swr(60_000, async (key): Promise<{ bodyHTML: string; url: string; title: string; headRefName: string }> => {
  const [repo, number] = key.split("#");
  const [owner, name] = repo.split("/");
  const query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { bodyHTML url title headRefName } } }";
  const out = await run("gh", ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`, "-f", `query=${query}`], homedir());
  const { bodyHTML, url, title, headRefName }: { bodyHTML: string; url: string; title: string; headRefName: string } = JSON.parse(out).data.repository.pullRequest;
  return { url, title, headRefName, bodyHTML: bodyHTML.replace(/(<img[^>]*\ssrc=")([^"]+)"/g, (tag, start: string, src: string) => (repoFile(src.replace(/&amp;/g, "&")) ? `${start}/api/image?${new URLSearchParams({ url: src.replace(/&amp;/g, "&") })}"` : tag)) };
});

// A Claude session on the VM, opened in a new terminal tab: in a worktree of the PR's branch, or for a new agent a
// fresh one detached at the base branch. The remote's own git identity may be another account, so the user's is set
// for the session; with githubTokenToVM in config.jsonc, gh there gets the user's token and must be their login before
// Claude starts. The script goes up first so the tab's command stays
// a plain `bash path`; it deletes itself when it starts. The tab is titled after its worktree, and Claude
// is told not to retitle it, so asking for the same PR again finds the open tab instead of starting a second session.
// A checkout on the VM itself, with no PR, gets Claude in its own folder, titled after it like a local checkout's.
async function vmClaude(r: Repo, number: number | null, inPlace = false) {
  const term = terminal();
  const vm = inPlace ? [...remotes.values()].find((v) => v.target === r.host) : [...remotes.values()][0];
  if (!vm) throw new Error(inPlace ? "VM Claude in place is for checkouts on a remote" : "No remote set in config.jsonc");
  const repo = await githubRepo(r);
  if (!repo) throw new Error("This checkout has no GitHub remote");
  const identity = (key: string) => (r.host ? run("git", ["config", key], homedir()) : git(r, ["config", key])).then((v) => v.trim());
  const [name, email, login, base] = await Promise.all([identity("user.name"), identity("user.email"), ghLogin(""), defaultBranch(r)]);
  const pr = number ? await prDescription(`${repo}#${number}`) : null;
  const repoName = repo.split("/")[1];
  const scan = vm.scan.replace(/^~\/?/, "");
  const at = (path: string) => `"$HOME"/${shq(`${scan ? `${scan}/` : ""}${path}`)}`;
  const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, "");
  const worktree = pr ? prWorktreeName(pr.headRefName) : inPlace ? r.label : `agent-${stamp}`;
  const title = `🤖${pr ? worktree : inPlace ? posix.basename(r.top) : await newAgentName()}`;
  if ((pr || inPlace) && (await term.focus(title, vm.target))) return { worktree, focused: true };
  const vmPrompt = pr
    ? configPrompt("vmPr", { repo, login, base, number: number!, title: pr.title, url: pr.url, branch: pr.headRefName })
    : inPlace
      ? ""
      : configPrompt("vmNew", { repo, login, base });
  const tokenSetup = vmTokenSetup(login);
  const checkout = inPlace
    ? `dir=${shq(r.top)}`
    : pr
    ? `branch=${shq(pr.headRefName)}
git fetch --quiet origin "$branch" || fail "Couldn't fetch $branch from origin"
existing=$(git worktree list --porcelain | awk -v want="branch refs/heads/$branch" '/^worktree /{path=substr($0,10)} $0==want{print path}')
if [ -n "$existing" ]; then
  dir=$existing
  echo "$branch is already checked out in $dir, so Claude starts there"
elif [ -e "$dir" ]; then
  fail "$dir already exists but doesn't have $branch checked out"
elif git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add --quiet "$dir" "$branch" || fail "Couldn't add the worktree"
  git -C "$dir" merge --quiet --ff-only "origin/$branch" || echo "The VM's $branch has diverged from origin, so it's left as it is"
else
  git worktree add --quiet --track -b "$branch" "$dir" "origin/$branch" || fail "Couldn't add the worktree"
fi`
    : `git fetch --quiet origin || fail "Couldn't fetch origin"
[ -e "$dir" ] && fail "$dir already exists"
git worktree add --quiet --detach "$dir" ${shq(base)} || fail "Couldn't add the worktree"`;
  const script = `${tokenSetup ? `${tokenSetup.source}
` : ""}set -uo pipefail
rm -rf "$(dirname "$0")"
printf '\\033]2;%s\\007' ${shq(title)}
export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
fail() { printf '\\n%s\\n' "$1" >&2; exit 1; }
command -v git >/dev/null || fail "git isn't installed on the VM."
command -v claude >/dev/null || fail "Claude Code's claude command isn't installed on the VM, or isn't on its PATH. See https://claude.com/claude-code to install it."
export GIT_AUTHOR_NAME=${shq(name)} GIT_COMMITTER_NAME=${shq(name)} GIT_AUTHOR_EMAIL=${shq(email)} GIT_COMMITTER_EMAIL=${shq(email)}
${tokenSetup ? `${tokenSetup.check}
` : ""}echo "${tokenSetup ? "GitHub as $login, c" : "C"}ommits as $GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"
${inPlace ? "" : `cd ${at(repoName)} || fail "No ${repoName} clone in ${vm.scan} on the VM"
dir=${at(`${worktreesFolder()}/${worktree}/${repoName}`)}
`}${checkout}
cd "$dir" || fail "No $dir on the VM"
exec claude${vmPrompt ? ` ${shq(vmPrompt)}` : ""}
`;
  const path = (await remoteShell(vm.target, `d=$(mktemp -d) && cat > "$d/run.sh" && echo "$d/run.sh"`, script)).toString().trim();
  if (!/^\/\S+\/run\.sh$/.test(path)) throw new Error(`Couldn't put the start script on the VM${path ? `: ${path}` : ""}`);
  await term.open({ argv: ["bash", path], host: vm.target }, title);
  return { worktree, focused: false };
}

// githubTokenToVM's start-script lines: source its file (ssh runs bash with ~/.bashrc but a Rex block doesn't), make its
// variable gh's token, and stop unless gh is the user's login rather than another account on the remote.
function vmTokenSetup(login: string) {
  const t = config.githubTokenToVM;
  if (!t) return null;
  if (!/^[A-Za-z_]\w*$/.test(t.name)) throw new Error(`githubTokenToVM.name in config.jsonc isn't a variable name: ${t.name}`);
  const file = t.sources.startsWith("~/") ? `"$HOME"/${shq(t.sources.slice(2))}` : shq(t.sources);
  return {
    source: `[ -r ${file} ] && . ${file}`,
    check: `[ -n "\${${t.name}:-}" ] || fail ${shq(`${t.sources} on the VM didn't set ${t.name}`)}
export GH_TOKEN="$${t.name}"
command -v gh >/dev/null || fail "The GitHub CLI gh isn't installed on the VM."
login=$(gh api user -q .login 2>&1) || fail "gh on the VM isn't logged in: $login"
[ "$login" = ${shq(login)} ] || fail "gh on the VM is $login, not ${login}"`,
  };
}

// A PR's worktree is named after its branch, less config.jsonc's prPanelBranchStrip prefix.
function prWorktreeName(branch: string) {
  const strip = branchStrip();
  return (strip ? branch.replace(strip, "") || branch : branch).replace(/\//g, "-");
}

// A prompt from config.jsonc with its {name}s filled from vars, or from the other prompts there by their keys.
function configPrompt(key: string, vars: Record<string, string | number>, seen: string[] = []): string {
  const text = config.prompts?.[key];
  if (text === undefined) throw new Error(`No prompts.${key} in config.jsonc`);
  if (seen.includes(key)) throw new Error(`prompts.${key} in config.jsonc includes itself`);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name in vars) return String(vars[name]);
    if (config.prompts && name in config.prompts) return configPrompt(name, vars, [...seen, key]);
    throw new Error(`prompts.${key} in config.jsonc has an unknown {${name}}`);
  });
}

// Claude in a checkout on this Mac, in a terminal tab titled after its folder; asking again switches to that tab. The
// terminal may start with a bare PATH and claude is often added to it in a shell rc file, which only an interactive
// shell reads, hence -i. For a PR it starts in a worktree of the PR's branch, made beside the clone in worktreesFolder
// as on the VM, or in
// whichever worktree already has that branch checked out.
async function localClaude(r: Repo, number: number | null) {
  if (r.host) throw new Error("Local Claude is for checkouts on this Mac");
  const term = terminal();
  if (!number) {
    const title = `🏠${basename(r.top)}`;
    if (await term.focus(title)) return { focused: true };
    await openLocalClaudeTab(term, r.top, title);
    return { focused: false };
  }
  const repo = await githubRepo(r);
  if (!repo) throw new Error("This checkout has no GitHub remote");
  const pr = await prDescription(`${repo}#${number}`);
  const branch = pr.headRefName;
  const worktree = prWorktreeName(branch);
  const title = `🏠${worktree}`;
  if (await term.focus(title)) return { worktree, focused: true };
  const [login, base] = await Promise.all([ghLogin(""), defaultBranch(r)]);
  const prompt = configPrompt("localPr", { repo, login, base, number, title: pr.title, url: pr.url, branch });
  await git(r, ["fetch", "--quiet", "origin", branch]).catch(() => { throw new Error(`Couldn't fetch ${branch} from origin`); });
  const list = await git(r, ["worktree", "list", "--porcelain"]);
  let dir = list.split("\n\n").map((entry) => entry.split("\n")).find((lines) => lines.includes(`branch refs/heads/${branch}`))?.[0].slice("worktree ".length);
  if (!dir) {
    dir = join(dirname(r.top), worktreesFolder(), worktree, basename(r.top));
    if (existsSync(dir)) throw new Error(`${dir} already exists but doesn't have ${branch} checked out`);
    if (await git(r, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false)) {
      await git(r, ["worktree", "add", "--quiet", dir, branch]);
      // A local branch that has diverged from origin is left as it is.
      await git({ ...r, top: dir }, ["merge", "--quiet", "--ff-only", `origin/${branch}`]).catch(() => {});
    } else {
      await git(r, ["worktree", "add", "--quiet", "--track", "-b", branch, dir, `origin/${branch}`]);
    }
  }
  await openLocalClaudeTab(term, dir, title, prompt);
  return { worktree, focused: false };
}

// A new local agent is always a new session, titled with a random family name like a new VM agent.
async function newLocalAgent(r: Repo) {
  if (r.host) throw new Error("A local agent needs a checkout on this Mac");
  const term = terminal();
  await openLocalClaudeTab(term, r.top, `🏠${await newAgentName()}`);
}

async function openLocalClaudeTab(term: Terminal, dir: string, title: string, prompt = "") {
  const missing = "Claude Code's `claude` command isn't installed or isn't on your shell's PATH. See https://claude.com/claude-code to install it.";
  const script = `printf '\\033]2;%s\\007' ${shq(title)}; command -v claude >/dev/null || { printf '\\n%s\\n' ${shq(missing)} >&2; exit 1; }; export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1; exec claude${prompt ? ` ${shq(prompt)}` : ""}`;
  await term.open({ argv: [process.env.SHELL || "/bin/zsh", "-lic", script], dir }, title);
}

const FAMILY_NAMES = "https://raw.githubusercontent.com/kkrypt0nn/wordlists/main/wordlists/names/top_family_names_usa.txt";

// A new agent's tab title is a random family name, fetched each time rather than kept; its worktree keeps the timestamp.
async function newAgentName() {
  const res = await fetch(FAMILY_NAMES);
  if (!res.ok) throw new Error(`Couldn't fetch the name list: ${res.status}`);
  const names = (await res.text()).split("\n").map((n) => n.trim().toLowerCase()).filter((n) => /^[a-z]+$/.test(n));
  return names[Math.floor(Math.random() * names.length)];
}

// The terminal Claude sessions open in, from config.jsonc; each endpoint checks for one before doing any work. A tab is
// found by its title: a Rex block's label, a Ghostty tab's name, which the tab's script sets and Claude is told to keep,
// or a Terminal.app tab's custom title.
// A tab's command runs in dir on this Mac, or on host: an SSH remote's target, which is also its Rex host's label.
type Tab = { argv: string[]; dir?: string; host?: string };
type Terminal = { focus: (title: string, host?: string) => Promise<boolean>; open: (tab: Tab, title: string) => Promise<void> };

function terminal(): Terminal {
  const t = config.terminal ?? { type: "mac-terminal" };
  const command = ({ argv, host }: Tab) => (host ? ["ssh", "-t", host, ...argv] : argv).map(shq).join(" ");
  switch (t.type) {
    case "rex":
      if (!t.path || !existsSync(t.path)) throw new Error(`Rex's rex CLI isn't at ${t.path}. Fix terminal.path in config.jsonc, or ask Claude.`);
      return { focus: (title, host) => focusRexBlock(t.path, title, host), open: (tab, title) => openRexBlock(t.path, tab, title) };
    case "ghostty":
      return {
        focus: async (title) => (await requireApp("Ghostty"), focusGhosttyTab(title)),
        open: async (tab) => (await requireApp("Ghostty"), openGhosttyTab(command(tab), tab.dir)),
      };
    case "mac-terminal":
      return { focus: (title) => focusMacTerminalTab(title), open: (tab, title) => openMacTerminalTab(command(tab), title, tab.dir) };
    default:
      throw new Error(`terminal.type in config.jsonc is ${JSON.stringify((t as { type: unknown }).type)}: use mac-terminal, ghostty or rex`);
  }
}

// A terminal app named in config.jsonc must be installed; AppleScript to a missing app fails with a cryptic error.
async function requireApp(name: string) {
  const found = await run("open", ["-Ra", name], homedir()).then(() => true, () => false);
  if (!found) throw new Error(`${name} isn't installed, but config.jsonc's terminal.type is set to it. Install it or pick another terminal, or ask Claude.`);
}

// Claude tabs go in a Rex session of their own, named every time: a command without one fails when Rex has no
// session ("no session found") and when it has several ("session target default is ambiguous"). A remote's tabs go in
// that session on the remote's own Rex server (-S), so they're Rex's remote sessions rather than ssh in a local one.
// `rex focus` takes a block label and exits 3 when nothing has it, or when the session doesn't exist yet. Rex doesn't
// come to the front by itself.
const REX_SESSION = "code-diff";
const rexServer = (host?: string) => (host ? ["-S", host] : []);

async function focusRexBlock(rex: string, title: string, host?: string) {
  const found = await run(rex, [...rexServer(host), "focus", "-s", REX_SESSION, title], homedir()).then(
    () => true,
    (e: Error) => {
      if (/not found/.test(e.message)) return false;
      throw e;
    },
  );
  if (found) await run("open", ["-b", REX_APP], homedir());
  return found;
}

// A new Rex window, kept open after its command exits so a failure stays readable. On this Mac argv runs as is in dir
// (--shell=none); on a remote it runs through the login shell's environment there, so PATH finds bash and claude. The
// first one makes the session, whose opening block is then labelled like the rest.
async function openRexBlock(rex: string, { argv, dir = homedir(), host }: Tab, title: string) {
  const server = rexServer(host);
  const block = [...(host ? [] : ["--cwd", dir, "--shell=none"]), "--keep-open", "--json", "--", ...argv];
  await run(rex, [...server, "run", "-s", REX_SESSION, "--label", title, ...block], homedir()).catch(async (e: Error) => {
    if (!/session target .* not found/.test(e.message)) throw e;
    const made: { initial_windows: { block_ids: string[] }[] } = JSON.parse(await run(rex, [...server, "new", REX_SESSION, ...block], homedir()));
    await run(rex, [...server, "block", "rename", "-s", REX_SESSION, made.initial_windows[0].block_ids[0], title], homedir());
  });
  await run("open", ["-b", REX_APP], homedir());
}

const REX_APP = "com.superlogical.rex";

async function focusGhosttyTab(title: string) {
  const script = `tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      if name of t is ${JSON.stringify(title)} then
        activate
        focus focused terminal of t
        return true
      end if
    end repeat
  end repeat
  return false
end tell`;
  return (await run("osascript", ["-e", script], homedir())).trim() === "true";
}

async function openGhosttyTab(command: string, dir = homedir()) {
  const script = `tell application "Ghostty"
  activate
  set config to new surface configuration
  set initial working directory of config to ${JSON.stringify(dir)}
  set command of config to ${JSON.stringify(command)}
  set wait after command of config to true
  if (count of windows) is 0 then
    new window with configuration config
  else
    new tab in front window with configuration config
  end if
end tell`;
  await run("osascript", ["-e", script], homedir());
}

// Terminal.app finds a tab by the custom title it was opened with; it isn't asked when it isn't running, so a check
// doesn't launch it.
async function focusMacTerminalTab(title: string) {
  const script = `if application "Terminal" is not running then return false
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if custom title of t is ${JSON.stringify(title)} then
        set selected of t to true
        set index of w to 1
        activate
        return true
      end if
    end repeat
  end repeat
  return false
end tell`;
  return (await run("osascript", ["-e", script], homedir())).trim() === "true";
}

// A new Terminal.app window running command in dir through the login shell; the window stays open after it exits as
// the profile's "When the shell exits" setting says.
async function openMacTerminalTab(command: string, title: string, dir = homedir()) {
  const script = `tell application "Terminal"
  activate
  set t to do script ${JSON.stringify(`cd ${shq(dir)} && ${command}`)}
  set custom title of t to ${JSON.stringify(title)}
end tell`;
  await run("osascript", ["-e", script], homedir());
}

// A repo file linked from GitHub markdown (blob ?raw=true, raw/, or raw.githubusercontent.com). A private repo's only
// open to the signed-in github.com page, so the page here gets these through the API instead.
function repoFile(url: string) {
  const m = /^https:\/\/(?:github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)|raw\.githubusercontent\.com\/([^/]+)\/([^/]+))\/([^/?#]+)\/([^?#]+)/.exec(url);
  return m && { owner: m[1] ?? m[3], repo: m[2] ?? m[4], ref: m[5], path: m[6] };
}

const ghToken = swr(3_600_000, async () => (await run("gh", ["auth", "token"], homedir())).trim());

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

async function repoImage(res: ServerResponse, url: string) {
  const file = repoFile(url);
  const type = IMAGE_TYPES[file?.path.split(".").pop()?.toLowerCase() ?? ""];
  if (!file || !type) return json(res, 400, { error: "Not an image in a GitHub repo" });
  const api = `https://api.github.com/repos/${file.owner}/${file.repo}/contents/${file.path}?ref=${encodeURIComponent(file.ref)}`;
  const got = await fetch(api, { headers: { authorization: `Bearer ${await ghToken("")}`, accept: "application/vnd.github.raw" } });
  if (!got.ok) return json(res, got.status, { error: await got.text() });
  res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=86400" });
  res.end(Buffer.from(await got.arrayBuffer()));
}

type PrComment = { login: string; human: boolean; at: string };
type CommentNode = { author: { login: string; __typename: string } | null; createdAt: string };
type ReviewNode = { author: CommentNode["author"]; submittedAt: string | null; body: string; comments: { totalCount: number; nodes: { createdAt: string }[] } };

// Any comment bumps a PR's updatedAt, so a PR's comments are fetched again only once it changes.
const prCommentCache = new Map<string, PrComment[]>();

async function prComments(repo: string, prs: PullRequest[]) {
  const key = (p: PullRequest) => `${repo}#${p.number}@${p.updatedAt}`;
  const missing = prs.filter((p) => !prCommentCache.has(key(p)));
  const [owner, name] = repo.split("/");
  const chunks = Array.from({ length: Math.ceil(missing.length / 25) }, (_, i) => missing.slice(i * 25, i * 25 + 25));
  await Promise.all(chunks.map(async (chunk) => {
    const fields = "comments(last: 50) { nodes { author { login __typename } createdAt } } reviews(last: 50) { nodes { author { login __typename } submittedAt body comments(last: 1) { totalCount nodes { createdAt } } } }";
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${chunk.map((p) => `pr${p.number}: pullRequest(number: ${p.number}) { ${fields} }`).join(" ")} } }`;
    const out = await run("gh", ["api", "graphql", "-f", `query=${query}`], homedir());
    const found: Record<string, { comments: { nodes: CommentNode[] }; reviews: { nodes: ReviewNode[] } } | null> = JSON.parse(out).data.repository;
    for (const p of chunk) {
      const pr = found[`pr${p.number}`];
      if (!pr) continue;
      const entry = (author: CommentNode["author"], at: string) => ({ login: author?.login ?? "", human: author?.__typename === "User", at });
      // An approval with no text isn't a comment; a review's line comments are, dated by the newest.
      const reviews = pr.reviews.nodes
        .filter((v) => v.body.trim() || v.comments.totalCount)
        .map((v) => entry(v.author, v.comments.nodes[0]?.createdAt ?? v.submittedAt ?? ""));
      prCommentCache.set(key(p), [...pr.comments.nodes.map((c) => entry(c.author, c.createdAt)), ...reviews]);
    }
  }));
  return prs.map((p) => prCommentCache.get(key(p)) ?? []);
}

// Logins of humans other than `me` who commented, and whether one did after me (only once I've commented).
function commentSummary(comments: PrComment[], me: string) {
  const others = comments.filter((c) => c.human && c.login !== me);
  const myLast = comments.filter((c) => c.login === me).reduce((last, c) => (c.at > last ? c.at : last), "");
  return { by: [...new Set(others.map((c) => c.login))], after: myLast !== "" && others.some((c) => c.at > myLast) };
}

const labelFor = (r: Repo, path: string) => `${r.host ? `${r.label.split(":")[0]}:` : ""}${tildify(path, r.home)}`;

type BranchDates = Map<string, { local: number; origin: number; email: string }>;

// A local branch or checkout for the "from" dropdown; the page nests it under its PR or origin branch when one
// exists, else lists it under its machine's "Only" group. `path` is set for checkouts, `branch` is null when detached.
type SourceRow = {
  machine?: string;
  branch: string | null;
  ref: string;
  changedAt: number;
  path: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  merged?: boolean;
};

const branchDates = shared(5_000, async (r): Promise<BranchDates> => {
  const out = await git(r, ["for-each-ref", "--format=%(refname)%00%(committerdate:unix)%00%(authoremail:trim)", "refs/heads", "refs/remotes/origin"]);
  const byName: BranchDates = new Map();
  for (const line of out.split("\n").filter(Boolean)) {
    const [refname, date, email] = line.split("\0");
    if (refname === "refs/remotes/origin/HEAD") continue;
    const name = refname.replace(/^refs\/(heads|remotes\/origin)\//, "");
    const entry = byName.get(name) ?? { local: 0, origin: 0, email: "" };
    if (refname.startsWith("refs/heads/")) entry.local = Number(date);
    else Object.assign(entry, { origin: Number(date), email });
    byName.set(name, entry);
  }
  return byName;
});

// Branches already in the base branch, so finished work isn't flagged as unfinished.
const mergedRefs = shared(5_000, async (r) => {
  const base = await defaultBranch(r);
  const out = await git(r, ["for-each-ref", `--merged=${base}`, "--format=%(refname)", "refs/heads", "refs/remotes/origin"]).catch(() => "");
  return new Set(out.split("\n").filter(Boolean));
});

// The user's own PRs of any age: open ones are always listed, and since squash merges leave a branch looking
// unmerged to git, a branch whose PRs are all merged or closed counts as finished.
const myPrs = swr(300_000, async (repo) => {
  const fields = "number,title,state,updatedAt,headRefName,isDraft,author,assignees,labels,mergedBy";
  const out = await run("gh", ["pr", "list", "-R", repo, "--author", "@me", "--state", "all", "--limit", "300", "--json", fields], homedir());
  const prs: PullRequest[] = JSON.parse(out);
  const openPrs = prs.filter((p) => p.state === "OPEN");
  const openBranches = new Set(openPrs.map((p) => p.headRefName));
  const finished = [...new Set(prs.filter((p) => !openBranches.has(p.headRefName)).map((p) => p.headRefName))];
  return { open: openPrs, finished };
});

// A PR from another author still finishes a branch, so the few branches that would show as the user's unfinished
// work are checked against all of their PRs.
const branchPrStates = swr(300_000, async (key) => {
  const [repo, branch] = key.split("\0");
  const out = await run("gh", ["pr", "list", "-R", repo, "--head", branch, "--state", "all", "--json", "state"], homedir());
  const prs: { state: string }[] = JSON.parse(out);
  return prs.map((p) => p.state);
});

const ghLogin = swr(86_400_000, async () => (await run("gh", ["api", "user", "-q", ".login"], homedir())).trim());

// How far each local branch is ahead of and behind its origin branch; on a remote they're all counted in one SSH call.
async function trackBranches(r: Repo, byName: BranchDates, names: string[]) {
  const tracked = names.filter((name) => byName.get(name)?.local && byName.get(name)?.origin);
  const range = (name: string) => `refs/heads/${name}...refs/remotes/origin/${name}`;
  const counts = !tracked.length
    ? []
    : r.host
    ? (await remoteShell(r.host, `cd ${shq(r.top)} || exit; ${tracked.map((n) => `echo $(git rev-list --left-right --count ${shq(range(n))} 2>/dev/null)`).join("; ")}`))
        .toString()
        .split("\n")
    : await Promise.all(tracked.map((n) => git(r, ["rev-list", "--left-right", "--count", range(n)]).catch(() => "")));
  const found = new Map(tracked.map((name, i) => {
    const [ahead = 0, behind = 0] = (counts[i] ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
    return [name, { ahead, behind }];
  }));
  return (name: string) => found.get(name) ?? { ahead: 0, behind: 0 };
}

// A remote's checkouts from the scan that reads them all in one SSH call, null when r isn't in it. The scan can be
// a minute old, so r's own row, the one being viewed, is read fresh.
async function snapshotRows(r: Repo, byName: BranchDates, merged: Set<string>) {
  const [snapshot, state, currentBranch] = await Promise.all([
    remoteSnapshot(r.label.split(":")[0]).catch(() => []),
    checkoutState(r),
    git(r, ["symbolic-ref", "--short", "-q", "HEAD"]).then((b) => b.trim() || null, () => null),
  ]);
  const self = snapshot.find((c) => c.repo.top === r.top);
  if (!self) return null;
  const tracked = currentBranch ? (await trackBranches(r, byName, [currentBranch]))(currentBranch) : { ahead: 0, behind: 0 };
  const row = (top: string, label: string, branch: string | null, fields: Pick<SourceRow, "changedAt" | "dirty" | "ahead" | "behind">): SourceRow => ({
    branch,
    ref: top === r.top ? "" : `repo:${label}`,
    path: label.replace(/^[\w-]+:/, ""),
    merged: branch ? merged.has(`refs/heads/${branch}`) : undefined,
    ...fields,
  });
  const head = row(r.top, r.label, currentBranch, { changedAt: state.editedAt, dirty: state.dirty, ...tracked });
  // The scan counts a detached checkout against origin/HEAD; the picker shows no counts without a branch.
  const rest = snapshot
    .filter((c) => c.main === self.main && c.repo.top !== r.top)
    .map((c) => {
      const branch = c.branch === "HEAD" ? null : c.branch;
      return row(c.repo.top, c.repo.label, branch, { changedAt: c.editedAt, dirty: c.dirty, ahead: branch ? c.ahead : 0, behind: branch ? c.behind : 0 });
    })
    .sort((a, b) => b.changedAt - a.changedAt);
  return { rows: [head, ...rest], open: new Set([head, ...rest].map((x) => x.branch ?? undefined)) };
}

async function checkoutRows(r: Repo, byName: BranchDates, merged: Set<string>) {
  const fromSnapshot = r.host ? await snapshotRows(r, byName, merged) : null;
  if (fromSnapshot) return fromSnapshot;
  const [trees, currentBranch] = await Promise.all([
    git(r, ["worktree", "list", "--porcelain"]).then(parseWorktrees),
    git(r, ["symbolic-ref", "--short", "-q", "HEAD"]).then((b) => b.trim() || undefined, () => undefined),
  ]);
  const row = async (t: { path: string; branch?: string }): Promise<SourceRow> => {
    const w: Repo = { ...r, top: t.path, label: labelFor(r, t.path) };
    const [state, tracked] = await Promise.all([checkoutState(w), t.branch ? trackBranches(r, byName, [t.branch]).then((of) => of(t.branch!)) : null]);
    return {
      branch: t.branch ?? null,
      ref: t.path === r.top ? "" : `repo:${w.label}`,
      changedAt: state.editedAt,
      path: w.label.replace(/^[\w-]+:/, ""),
      dirty: state.dirty,
      ahead: tracked?.ahead ?? 0,
      behind: tracked?.behind ?? 0,
      merged: t.branch ? merged.has(`refs/heads/${t.branch}`) : undefined,
    };
  };
  const checkouts = trees.filter((t) => t.usable && (!isTmp(t.path) || t.path === r.top));
  const current = checkouts.find((t) => t.path === r.top) ?? { path: r.top, branch: currentBranch };
  const [head, ...rest] = await Promise.all([current, ...checkouts.filter((t) => t.path !== r.top)].map(row));
  return { rows: [head, ...rest.sort((a, b) => b.changedAt - a.changedAt)], open: new Set(checkouts.map((t) => t.branch)) };
}

// r's machine: its checkouts, then the 20 newest local branches no checkout has open; plus every origin branch.
// Origin branches carry whether their tip is `email`'s and whether they're merged, for the unfinished-work dot.
async function localBranches(r: Repo, email: string) {
  const [byName, merged] = await Promise.all([branchDates(r), mergedRefs(r)]);
  const { rows, open } = await checkoutRows(r, byName, merged);
  const newest = [...byName]
    .filter(([name, d]) => d.local && !open.has(name))
    .sort(([, a], [, b]) => b.local - a.local)
    .slice(0, 20);
  const tracked = await trackBranches(r, byName, newest.map(([name]) => name));
  const branches = newest.map(([name, d]): SourceRow => ({
    branch: name,
    ref: name,
    changedAt: d.local * 1000,
    path: null,
    dirty: false,
    merged: merged.has(`refs/heads/${name}`),
    ...tracked(name),
  }));
  const origin = [...byName]
    .filter(([, d]) => d.origin)
    .map(([name, d]) => ({
      name,
      changedAt: d.origin * 1000,
      mine: Boolean(email) && d.email === email,
      merged: merged.has(`refs/remotes/origin/${name}`),
    }))
    .sort((a, b) => b.changedAt - a.changedAt);
  return { rows: [...rows, ...branches], origin };
}

// Checkouts of the same GitHub repo on the other machines, labelled by machine: every remote but r's own, plus the
// Mac's when r is remote.
async function otherCheckouts(r: Repo): Promise<SourceRow[]> {
  const repo = await githubRepo(r);
  if (!repo) return [];
  const remoteRows = await Promise.all(
    [...remotes].filter(([, cfg]) => cfg.target !== r.host).map(async ([name]) =>
      (await remoteSnapshot(name).catch(() => []))
        .filter((c) => c.github === repo)
        .map((c) => ({
          machine: name.toUpperCase(),
          branch: c.branch === "HEAD" ? null : c.branch,
          ref: `repo:${c.repo.label}`,
          changedAt: c.editedAt,
          path: c.repo.label.replace(/^[\w-]+:/, ""),
          dirty: c.dirty,
          ahead: c.ahead,
          behind: c.behind,
        }))),
  );
  const mac = r.host ? (await localRepos("")).find((c) => c.github === repo) : undefined;
  const macRepo = mac && (await toplevel(mac.path));
  const macRows = macRepo
    ? (await checkoutRows(macRepo, await branchDates(macRepo), await mergedRefs(macRepo))).rows.map((row) => ({
        ...row,
        machine: "Local",
        ref: row.ref || `repo:${macRepo.label}`,
      }))
    : [];
  return [...remoteRows.flat(), ...macRows];
}

// The PRs the picker lists: the 100 most recently updated plus any of the user's own still open, newest first.
async function listedPrs(repo: string) {
  const [recent, mine] = await Promise.all([
    prList(repo).catch((): PullRequest[] => []),
    myPrs(repo).catch(() => ({ open: [] as PullRequest[], finished: [] as string[] })),
  ]);
  const known = new Set(recent.map((p) => p.number));
  const prs = [...recent, ...mine.open.filter((p) => !known.has(p.number))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { prs, finished: mine.finished };
}

// The picker's lists. Comments and the per-branch PR checks wait on these PRs and take seconds more when not cached,
// so they come separately from prActivity and the lists show without them.
async function sources(dir: string) {
  const r = await toplevel(dir);
  const [email, repo] = await Promise.all([userEmail(r), githubRepo(r)]);
  const [listed, { rows, origin }, login] = await Promise.all([
    repo ? listedPrs(repo) : { prs: [], finished: [] },
    localBranches(r, email),
    ghLogin("").catch(() => ""),
  ]);
  return { prs: listed.prs, rows, origin, me: login, finished: listed.finished };
}

// Who commented on each listed PR, and the user's unmerged origin branches that a PR from anyone has finished.
async function prActivity(dir: string) {
  const r = await toplevel(dir);
  const repo = await githubRepo(r);
  if (!repo) return { comments: {}, finished: [] };
  const [email, { prs, finished }, login, byName, merged] = await Promise.all([
    userEmail(r),
    listedPrs(repo),
    ghLogin("").catch(() => ""),
    branchDates(r),
    mergedRefs(r),
  ]);
  const done = new Set(finished);
  const heads = new Set(prs.map((p) => p.headRefName));
  const candidates = [...byName]
    .filter(([name, d]) => d.origin && email && d.email === email && !merged.has(`refs/remotes/origin/${name}`) && !done.has(name) && !heads.has(name))
    .map(([name]) => name);
  const [comments, states] = await Promise.all([
    prComments(repo, prs).catch(() => prs.map((): PrComment[] => [])),
    Promise.all(candidates.map((name) => branchPrStates(`${repo}\0${name}`).catch((): string[] => []))),
  ]);
  return {
    comments: Object.fromEntries(prs.map((p, i) => [p.number, commentSummary(comments[i] ?? [], login)])),
    finished: candidates.filter((_, i) => states[i].length && !states[i].includes("OPEN")),
  };
}

async function branches(dir: string) {
  const out = await git(await toplevel(dir), ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  return out.split("\n").filter(Boolean);
}

function parseWorktrees(out: string) {
  return out
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.trim().split("\n");
      const get = (key: string) => lines.find((l) => l.startsWith(key + " "))?.slice(key.length + 1);
      return {
        path: get("worktree") ?? "",
        head: get("HEAD"),
        branch: get("branch")?.replace("refs/heads/", ""),
        usable: !lines.includes("bare") && !lines.some((l) => l.startsWith("prunable")),
      };
    });
}

const isTmp = (path: string) => /^(\/private)?\/tmp\//.test(path);

// Every child of a scan dir that is inside a repo reports that repo's worktrees, so groups are keyed by the main worktree.
function groupWorktrees(lists: ReturnType<typeof parseWorktrees>[], toRepo: (path: string) => Repo) {
  const groups = new Map<string, Repo[]>();
  for (const trees of lists) {
    const main = trees[0]?.path;
    if (!main || groups.has(main)) continue;
    groups.set(main, trees.filter((t) => t.usable && !isTmp(t.path)).map((t) => toRepo(t.path)));
  }
  return [...groups].filter(([, worktrees]) => worktrees.length).map(([main, worktrees]) => ({ main, worktrees }));
}

async function localGroups() {
  const dirs = await Promise.all(
    scanDirs.map(async (scan) => {
      const root = expandHome(scan);
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
    }),
  );
  const lists = await Promise.all(
    dirs.flat().map((dir) => run("git", ["worktree", "list", "--porcelain"], dir).then(parseWorktrees, () => [])),
  );
  return groupWorktrees(lists, (top) => ({ host: null, top, label: tildify(top), home: homedir() }))
    .map((g) => ({ name: basename(g.main), ...g }));
}

// One SSH call per remote: every repo under the scan dir, each worktree's branch, last commit, newest uncommitted
// file, ahead/behind and origin, gathered in parallel on the remote. Fields are tab-separated; $HOME follows \x1d.
const remoteScanScript = (scan: string) => `cd ~ || exit
seen=" "
for d in ${shq(homeRelative(scan))}/*/; do
  main=$(git -C "$d" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
  [ -n "$main" ] || continue
  case "$seen" in *" $main "*) continue ;; esac
  seen="$seen$main "
  url=$(git -C "$main" remote get-url origin 2>/dev/null)
  git -C "$main" worktree list --porcelain | awk '/^worktree /{p=substr($0,10)} /^(bare|prunable)/{p=""} /^$/{if(p)print p; p=""} END{if(p)print p}' | {
    while IFS= read -r w; do
      (
        cd "$w" 2>/dev/null || exit
        b=$(git symbolic-ref --short -q HEAD || echo HEAD)
        c=$(git log -1 --format=%ct 2>/dev/null)
        st=$(git --no-optional-locks status --porcelain -z 2>/dev/null | tr '\\0' '\\n')
        m=$(printf '%s\\n' "$st" | cut -c4- | while IFS= read -r f; do [ -n "$f" ] && stat -c %Y -- "$f" 2>/dev/null; done | sort -n | tail -1)
        ab=$(git rev-list --left-right --count "HEAD...refs/remotes/origin/$b" 2>/dev/null | tr '\\t' ' ')
        dirty=0; [ -n "$st" ] && dirty=1
        printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$main" "$w" "$b" "\${c:-0}" "\${m:-0}" "$dirty" "$ab" "$url"
      ) &
    done
    wait
  }
done
printf '\\035%s' "$HOME"`;

const remoteSnapshot = swr(30_000, async (name) => {
  const cfg = remotes.get(name);
  if (!cfg) return [];
  const [body, home] = (await remoteShell(cfg.target, remoteScanScript(cfg.scan))).toString().split("\x1d");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [main, top, branch, commit, mtime, dirty, ab, url] = line.split("\t");
      const [ahead, behind] = ab ? ab.trim().split(" ").map(Number) : [0, 0];
      return {
        repo: { host: cfg.target, top, label: `${name}:${tildify(top, home)}`, home },
        main: `${name}:${tildify(main, home)}`,
        branch,
        editedAt: Math.max(Number(commit), Number(mtime)) * 1000,
        dirty: dirty === "1",
        ahead,
        behind,
        github: /github\.com[:/](.+?)(?:\.git)?$/.exec(url ?? "")?.[1] ?? null,
      };
    })
    .filter((c) => !isTmp(c.repo.top));
});

const localRepos = swr(30_000, async () => {
  const groups = await localGroups();
  const checkouts = await Promise.all(
    groups.map(async (g) => {
      const github = await githubRepo(g.worktrees[0]);
      const main = tildify(g.main);
      return Promise.all(g.worktrees.map(async (w) => ({ path: w.label, editedAt: (await checkoutState(w)).editedAt, github, main })));
    }),
  );
  return checkouts.flat();
});

// One entry per repo: a GitHub repo gathers its Mac and remote checkouts, anything else is keyed by its main worktree.
// Picking a repo opens its main Mac checkout (else its most recently edited one); `worktrees` lets the page find which
// repo the current checkout belongs to.
async function repos() {
  const [local, ...snapshots] = await Promise.all([
    localRepos(""),
    ...[...remotes.keys()].map((name) => remoteSnapshot(name).catch(() => [])),
  ]);
  const remote = snapshots.flat().map((c) => ({ path: c.repo.label, editedAt: c.editedAt, github: c.github, main: c.main }));
  const all = [...local, ...remote].sort((a, b) => b.editedAt - a.editedAt);
  const byRepo = Map.groupBy(all, (c) => c.github ?? c.main);
  return [...byRepo]
    .map(([key, list]) => ({
      name: list[0].github ?? basename(key),
      github: Boolean(list[0].github),
      path: list.find((c) => c.path === c.main && !c.path.includes(":"))?.path ?? list.find((c) => !c.path.includes(":"))?.path ?? list[0].path,
      editedAt: list[0].editedAt,
      worktrees: list.map((c) => c.path),
    }))
    .sort((a, b) => b.editedAt - a.editedAt);
}

// Edited time is the newest of the last commit and any uncommitted file; --no-optional-locks keeps status from
// rewriting the index we'd then read as an edit.
async function checkoutState(r: Repo) {
  const [commit, status] = await Promise.all([
    git(r, ["log", "-1", "--format=%ct"]).catch(() => "0"),
    git(r, ["--no-optional-locks", "status", "--porcelain", "-z"]).catch(() => ""),
  ]);
  const rels = status.split("\0").filter((e) => e.length > 3).map((e) => e.slice(3));
  return { dirty: rels.length > 0, editedAt: Math.max(Number(commit) * 1000, ...(await mtimes(r, rels))) };
}

// A ref's file opens from a worktree sitting on that exact commit. Otherwise one review worktree per repo under
// /tmp/code-diff is moved to it, so opening many commits doesn't leave a full checkout behind for each. If that
// worktree has uncommitted edits it's left alone and the commit gets a worktree of its own.
async function editorTarget(r: Repo, from: string | null, rel: string) {
  if (!from) return { dir: r.top, file: join(r.top, rel) };
  const sha = (await git(r, ["rev-parse", `${prRef(from) ?? from}^{commit}`])).trim();
  const trees = parseWorktrees(await git(r, ["worktree", "list", "--porcelain"]));
  const match = trees.find((t) => t.usable && t.head === sha);
  if (match) return { dir: match.path, file: posix.join(match.path, rel) };
  const name = basename(trees[0]?.path ?? r.top);
  await pruneCommitWorktrees(r, trees, name);
  const review = posix.join("/tmp/code-diff", `${name}-review`);
  const existing = trees.find((t) => t.usable && t.path.replace(/^\/private/, "") === review);
  let dir = review;
  if (!existing) await git(r, ["worktree", "add", "--quiet", "--detach", dir, sha]);
  else if ((await git({ ...r, top: existing.path }, ["status", "--porcelain"])).trim() === "") {
    dir = existing.path;
    await git({ ...r, top: dir }, ["checkout", "--quiet", "--detach", sha]);
  } else {
    dir = posix.join("/tmp/code-diff", `${name}-${sha.slice(0, 10)}`);
    await git(r, ["worktree", "add", "--quiet", "--detach", dir, sha]);
  }
  return { dir, file: posix.join(dir, rel) };
}

// Drops the per-commit worktrees editorTarget used to make (and still makes when the review one is dirty), along
// with the records of any whose folder is already gone. `worktree remove` refuses ones with uncommitted edits.
async function pruneCommitWorktrees(r: Repo, trees: ReturnType<typeof parseWorktrees>, name: string) {
  await git(r, ["worktree", "prune"]);
  const stale = new RegExp(`^/tmp/code-diff/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{10}$`);
  const old = trees.filter((t) => t.usable && stale.test(t.path.replace(/^\/private/, "")));
  await Promise.all(old.map((t) => git(r, ["worktree", "remove", t.path]).catch(() => {})));
}

// The left side of a VS Code diff must be a real file, so the base version is written read-only under its commit.
async function baseSnapshot(r: Repo, sha: string, rel: string) {
  const file = join("/tmp/code-diff/base", sha.slice(0, 10), rel);
  if (await access(file).then(() => true, () => false)) return file;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await git(r, ["show", `${sha}:${rel}`]), { mode: 0o444 });
  return file;
}

// Same as baseSnapshot, written on the remote so a Remote-SSH window can diff two files on that machine.
async function remoteBaseSnapshot(r: Repo, host: string, sha: string, rel: string) {
  const file = posix.join("/tmp/code-diff/base", sha.slice(0, 10), rel);
  const script = `cd ${shq(r.top)} && f=${shq(file)} && { [ -f "$f" ] || { mkdir -p "$(dirname "$f")" && git show ${shq(`${sha}:${rel}`)} > "$f" && chmod 444 "$f"; }; }`;
  await remoteShell(host, script);
  return file;
}

// The base branch's tip in a worktree under /tmp/code-diff, which the picker hides. Each open moves it to the new tip
// unless it has uncommitted changes, and a /tmp cleared by a reboot just means it's added again.
async function openBaseBranch(r: Repo) {
  const base = await defaultBranch(r);
  await git(r, ["fetch", "--quiet", "origin", base.replace(/^origin\//, "")]);
  const trees = parseWorktrees(await git(r, ["worktree", "list", "--porcelain"]));
  const dir = posix.join("/tmp/code-diff", `${basename(trees[0]?.path ?? r.top)}-${base.replace(/^origin\//, "")}`);
  const existing = trees.find((t) => t.usable && t.path.replace(/^\/private/, "") === dir);
  let kept = false;
  if (existing) {
    const w = { ...r, top: existing.path };
    kept = (await git(w, ["status", "--porcelain"])).trim() !== "";
    if (!kept) await git(w, ["checkout", "--quiet", "--detach", base]);
  } else {
    await git(r, ["worktree", "prune"]);
    await git(r, ["worktree", "add", "--quiet", "--detach", dir, base]);
  }
  await run("code", [...(r.host ? ["--remote", `ssh-remote+${r.host}`] : []), dir], homedir());
  return { base, kept };
}

// `code -r` lands in the last focused window, so the target folder is focused first. A remote checkout opens in a
// Remote-SSH window on that machine, with the worktree and base copy both living there.
async function openDiffInEditor(r: Repo, from: string | null, left: string, path: string, oldPath: string) {
  const rel = repoPath(path);
  const oldRel = repoPath(oldPath);
  await verifyRef(r, left);
  const sha = (await git(r, ["rev-parse", `${left}^{commit}`])).trim();
  const inBase = await git(r, ["cat-file", "-e", `${sha}:${oldRel}`]).then(() => true, () => false);
  const { dir, file } = await editorTarget(r, from, rel);
  const remote = r.host ? ["--remote", `ssh-remote+${r.host}`] : [];
  await run("code", [...remote, dir], homedir());
  if (!inBase) return run("code", ["-r", ...remote, file], homedir());
  const base = r.host ? await remoteBaseSnapshot(r, r.host, sha, oldRel) : await baseSnapshot(r, sha, oldRel);
  await run("code", ["-r", ...remote, "--diff", base, file], homedir());
}

const codeFile = /\.(?:m|c)?[jt]sx?$/;
const importSpec = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function catFiles(r: Repo, specs: string[]): Promise<(string | null)[]> {
  return new Promise((resolve, reject) => {
    const proc = spawnGit(r, ["cat-file", "--batch"]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", spawnError(r.host ? "ssh" : "git", reject));
    proc.on("close", () => {
      const buf = Buffer.concat(chunks);
      const out: (string | null)[] = [];
      let i = 0;
      for (const _ of specs) {
        const nl = buf.indexOf(10, i);
        const header = /^\S+ \S+ (\d+)$/.exec(buf.subarray(i, nl).toString());
        i = nl + 1;
        if (!header) {
          out.push(null);
          continue;
        }
        const size = Number(header[1]);
        out.push(buf.subarray(i, i + size).toString("utf8"));
        i += size + 1;
      }
      resolve(out);
    });
    proc.stdin.end(specs.map((s) => s + "\n").join(""));
  });
}

async function readSources(r: Repo, ref: string | null, paths: string[]) {
  const contents = ref
    ? await catFiles(r, paths.map((p) => `${ref}:${p}`))
    : (await readRepoFiles(r, paths)).map((b) => b?.toString("utf8") ?? null);
  return new Map(paths.map((p, i) => [p, contents[i]]));
}

const resolveRoot = "/repo";
const configFile = /(^|\/)(package\.json|[jt]sconfig[^/]*\.json)$/;

// Every path in the version being viewed: the working tree (tracked and untracked) or a commit's tree.
async function treePaths(r: Repo, ref: string | null) {
  const out = ref
    ? await git(r, ["ls-tree", "-r", "--name-only", "-z", ref])
    : await git(r, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

function jsonObject(text: string | null | undefined): Record<string, unknown> {
  const value: unknown = text ? ts.parseConfigFileTextToJson("", text).config : undefined;
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function globToRegex(glob: string) {
  const segments = glob.replace(/\/+$/, "").split("/").map((seg) =>
    seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
  return new RegExp(`^${segments.join("/")}$`);
}

// Root package.json workspaces (array or { packages }) mapped from package name to folder.
function workspaceDirs(configs: Map<string, string | null>) {
  const ws = jsonObject(configs.get("package.json")).workspaces;
  const list: unknown = Array.isArray(ws) ? ws : ws && typeof ws === "object" && "packages" in ws ? ws.packages : [];
  const patterns = (Array.isArray(list) ? list : []).filter((g) => typeof g === "string").map(globToRegex);
  const dirs = new Map<string, string>();
  for (const [path, text] of configs) {
    if (!path.endsWith("package.json") || path === "package.json") continue;
    const dir = posix.dirname(path);
    const name = jsonObject(text).name;
    if (typeof name === "string" && patterns.some((p) => p.test(dir))) dirs.set(name, dir);
  }
  return dirs;
}

// TypeScript's own resolver over a virtual tree of the version being viewed, so tsconfig (extends, paths, baseUrl,
// moduleResolution), index files and package.json main/types/exports behave as in the editor. Workspace packages
// resolve through node_modules/<name>, which isn't in the tree, so those paths are redirected to the package's folder.
// Imports TypeScript won't resolve (CSS, images) fall back to plain relative and `paths` matching.
async function dependencies(r: Repo, ref: string | null, files: string[]) {
  const changed = new Set(files);
  const tree = await treePaths(r, ref);
  const present = new Set(tree);
  const dirs = new Set<string>();
  for (const p of tree) for (let d = posix.dirname(p); d !== "." && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  const configPaths = tree.filter((p) => configFile.test(p) && !p.includes("node_modules/"));
  const contents = await readSources(r, ref, [...configPaths, ...files.filter((f) => codeFile.test(f))]);
  const workspaces = workspaceDirs(new Map(configPaths.map((p) => [p, contents.get(p) ?? null])));

  const redirect = (abs: string) => {
    const m = /^\/repo\/node_modules\/((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(abs);
    const dir = m && workspaces.get(m[1]);
    return m && dir ? `${resolveRoot}/${dir}${m[2] ?? ""}` : abs;
  };
  const rel = (abs: string) => {
    const p = redirect(abs).replace(/\/+$/, "");
    if (p === resolveRoot) return "";
    return p.startsWith(resolveRoot + "/") ? p.slice(resolveRoot.length + 1) : null;
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (p) => {
      const f = rel(p);
      return f !== null && present.has(f);
    },
    directoryExists: (p) => {
      const d = rel(p);
      if (d === "node_modules") return workspaces.size > 0;
      if (d?.startsWith("node_modules/@") && !d.slice(13).includes("/")) return [...workspaces.keys()].some((n) => n.startsWith(d.slice(13) + "/"));
      return d === "" || (d !== null && dirs.has(d));
    },
    readFile: (p) => {
      const f = rel(p);
      return f === null ? undefined : contents.get(f) ?? undefined;
    },
    realpath: redirect,
    getCurrentDirectory: () => resolveRoot,
  };

  const configName = ["tsconfig.json", "jsconfig.json"].find((c) => present.has(c));
  const parseHost = { ...host, useCaseSensitiveFileNames: true, readDirectory: () => [] };
  const parsed = configName
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(`${resolveRoot}/${configName}`, (p) => host.readFile(p)).config ?? {}, parseHost, resolveRoot).options
    : { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const options: ts.CompilerOptions = { ...parsed, allowJs: true, resolveJsonModule: true };
  const cache = ts.createModuleResolutionCache(resolveRoot, (s) => s, options);

  const fallback = (from: string, spec: string) => {
    if (spec.startsWith(".")) return posix.join(posix.dirname(from), spec);
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const star = pattern.indexOf("*");
      const pre = star < 0 ? pattern : pattern.slice(0, star);
      const post = star < 0 ? "" : pattern.slice(star + 1);
      if (star < 0 ? spec !== pattern : !(spec.startsWith(pre) && spec.endsWith(post))) continue;
      const middle = star < 0 ? "" : spec.slice(pre.length, spec.length - post.length);
      for (const target of targets) {
        const f = rel(posix.join(options.baseUrl ?? resolveRoot, target.replace("*", middle)));
        if (f && present.has(f)) return f;
      }
    }
    return null;
  };
  const resolve = (from: string, spec: string) => {
    const hit = ts.resolveModuleName(spec, `${resolveRoot}/${from}`, options, host, cache).resolvedModule;
    const file = hit ? rel(hit.resolvedFileName) : fallback(from, spec);
    return file && changed.has(file) ? file : null;
  };

  const edges: Record<string, string[]> = {};
  for (const file of files.filter((f) => codeFile.test(f))) {
    const text = contents.get(file);
    if (!text) continue;
    const found = new Set<string>();
    for (const m of text.matchAll(importSpec)) {
      const hit = resolve(file, m[1] ?? m[2] ?? m[3]);
      if (hit && hit !== file) found.add(hit);
    }
    if (found.size) edges[file] = [...found];
  }
  return edges;
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c));
    proc.on("error", spawnError("git", reject));
    proc.on("close", () => resolve(out));
    proc.stdin.end(input);
  });
}

// A burst of saves becomes one event, and git-ignored paths never fire.
function watchLocal(top: string, emit: () => void) {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    const paths = [...pending];
    pending = new Set();
    const ignored = new Set((await gitWithInput(top, ["check-ignore", "--stdin"], paths.join("\n") + "\n")).split("\n"));
    if (paths.some((p) => !ignored.has(p))) emit();
  };
  const watcher = watch(top, { recursive: true }, (_event, name) => {
    if (!name || /(^|\/)(\.git|node_modules)(\/|$)/.test(name)) return;
    pending.add(name);
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
  });
  return () => watcher.close();
}

// Reads a signature now and every `interval`; a failed read keeps the last one so a dropped connection isn't a change.
function poll(interval: number, read: () => Promise<string>, onChange: () => void) {
  let last: string | null = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const sig = await read().catch(() => last);
    busy = false;
    if (last !== null && sig !== last) onChange();
    last = sig;
  };
  tick();
  const timer = setInterval(tick, interval);
  return () => clearInterval(timer);
}

// The VM has no inotify tools, so its working tree is fingerprinted every 2s: tracked changes plus untracked names, times and sizes.
function watchRemote(host: string, top: string, emit: () => void) {
  const script = `cd ${shq(top)} && { git --no-optional-locks diff HEAD --no-ext-diff; git ls-files -o --exclude-standard -z | xargs -0 -r stat -c '%n %Y %s'; } 2>/dev/null | md5sum`;
  return poll(2000, async () => (await remoteShell(host, script)).toString(), emit);
}

// PRs and origin branches move on GitHub, so they're checked there every 30s and fetched before the refresh, since a
// PR's diff reads its local ref. Anything else is a ref in the checkout and is cheap to check every 3s.
function watchRef(r: Repo, from: string, emit: () => void) {
  const pr = /^#(\d+)$/.exec(from)?.[1];
  const branch = /^origin\/(.+)$/.exec(from)?.[1];
  const remoteRef = pr ? `refs/pull/${pr}/head` : branch ? `refs/heads/${branch}` : null;
  if (!remoteRef) return poll(3000, () => git(r, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]), emit);
  const refspec = pr ? `+${remoteRef}:refs/code-diff/pr/${pr}` : `+${remoteRef}:refs/remotes/origin/${branch}`;
  const onChange = () => git(r, ["fetch", "--quiet", "origin", refspec]).then(emit, emit);
  return poll(30_000, async () => (await git(r, ["ls-remote", "origin", remoteRef])).split("\t")[0], onChange);
}

const watchers = new Map<string, { stop: () => void; clients: Set<ServerResponse>; emit: () => void }>();

function notifyWatchers(key: string) {
  watchers.get(key)?.emit();
}

// One watcher per repo and `from`, shared by its open pages and stopped when the last one closes.
function watchRepo(r: Repo, from: string | null, res: ServerResponse) {
  const key = `${r.label}|${from ?? ""}`;
  let entry = watchers.get(key);
  if (!entry) {
    const clients = new Set<ServerResponse>();
    const emit = () => {
      for (const c of clients) c.write("data: change\n\n");
    };
    const stop = from ? watchRef(r, from, emit) : r.host ? watchRemote(r.host, r.top, emit) : watchLocal(r.top, emit);
    entry = { stop, clients, emit };
    watchers.set(key, entry);
  }
  const { clients, stop } = entry;
  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
    if (clients.size) return;
    stop();
    watchers.delete(key);
  });
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams;
  try {
    if (url.pathname === "/api/watch") {
      const { dir, ref } = source(q);
      const r = await toplevel(dir);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": watching\n\n");
      return watchRepo(r, ref, res);
    }
    if (url.pathname === "/api/health") {
      return json(res, 200, { app: "code-diff" });
    }
    if (url.pathname === "/api/diff") {
      const { dir, ref } = source(q);
      return json(res, 200, await diff(dir, ref, q.get("to"), q.get("base") !== "direct"));
    }
    if (url.pathname === "/api/file") {
      const { dir, ref } = source(q);
      const content = await fileContent(await toplevel(dir), ref, q.get("path") ?? "");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(content);
    }
    if (url.pathname === "/api/open-diff" && req.method === "POST") {
      const { dir, ref } = source(q);
      const path = q.get("path") ?? "";
      await openDiffInEditor(await toplevel(dir), ref, q.get("left") ?? "", path, q.get("old") || path);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/deps" && req.method === "POST") {
      const { dir, ref } = source(q);
      const { paths } = JSON.parse(await readBody(req)) as { paths: string[] };
      return json(res, 200, await dependencies(await toplevel(dir), ref && (prRef(ref) ?? ref), paths));
    }
    if (url.pathname === "/api/sources") {
      return json(res, 200, await sources(source(q).dir));
    }
    if (url.pathname === "/api/pr-activity") {
      return json(res, 200, await prActivity(source(q).dir));
    }
    if (url.pathname === "/api/open-base" && req.method === "POST") {
      return json(res, 200, await openBaseBranch(await toplevel(source(q).dir)));
    }
    if (url.pathname === "/api/local-claude" && req.method === "POST") {
      return json(res, 200, await localClaude(await toplevel(source(q).dir), Number(q.get("number")) || null));
    }
    if (url.pathname === "/api/new-local-agent" && req.method === "POST") {
      await newLocalAgent(await toplevel(source(q).dir));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/vm-claude" && req.method === "POST") {
      const number = Number(q.get("number")) || null;
      const r = await toplevel(source(q).dir);
      return json(res, 200, await vmClaude(r, number, !number && !!r.host && q.get("inPlace") === "1"));
    }
    if (url.pathname === "/api/image") {
      return repoImage(res, q.get("url") ?? "");
    }
    if (url.pathname === "/api/pr") {
      const repo = await githubRepo(await toplevel(source(q).dir));
      if (!repo) return json(res, 404, { error: "No GitHub remote" });
      return json(res, 200, await prDescription(`${repo}#${Number(q.get("number"))}`));
    }
    if (url.pathname === "/api/checkouts") {
      return json(res, 200, await otherCheckouts(await toplevel(source(q).dir)));
    }
    if (url.pathname === "/api/branches") {
      return json(res, 200, await branches(q.get("repo") || process.cwd()));
    }
    if (url.pathname === "/api/repos") {
      return json(res, 200, await repos());
    }
    if (url.pathname === "/") {
      // config.jsonc settings the page needs go in its #settings script, < escaped so a value can't close the tag.
      const settings = JSON.stringify({ tests: config.tests ?? ["__tests__/**/*", "*.test.*"], depHierarchyPanel: config.experimental_depHierarchyPanel ?? true, branchStrip: config.prPanelBranchStrip ?? null, labels: config.prPanelLabels ?? {}, worktreesFolder: worktreesFolder() }).replace(/</g, "\\u003c");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end((await readFile(indexHtml, "utf8")).replace('<script id="settings" type="application/json">{}</script>', () => `<script id="settings" type="application/json">${settings}</script>`));
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

// The port is the single-instance lock: a second start exits cleanly instead of crashing.
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.log(`code-diff: port ${port} already in use`);
  process.exit(0);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`code-diff on http://localhost:${port}/?repo=${encodeURIComponent(process.cwd())}`);
  repos().catch(() => {});
});
