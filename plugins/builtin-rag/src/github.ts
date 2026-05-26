/**
 * github_source — pulls a GitHub repository tree at a given ref and
 * emits one document per file under the include / exclude globs.
 *
 * Two-step fetch:
 *   1. `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` lists
 *      every blob in the tree in a single round-trip (the GraphQL
 *      v4 path would be cheaper for very large repos but adds a
 *      separate auth surface). This is plenty for the practical
 *      ceiling — a few thousand files per repo.
 *   2. For each file that survives the glob filter, fetch
 *      `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`
 *      to read content. This is faster than `/git/blobs/{sha}` (no
 *      base64 round-trip) and gives us byte-identical raw content.
 *
 * The optional `token` secret bypasses GitHub's anonymous rate limit
 * (60/hr → 5k/hr) and unlocks private repos. Anonymous fetches work
 * out of the box for public repos.
 *
 * NUL handling + the default exclude list mirror filesystem_source —
 * Postgres JSONB refuses U+0000 and the include glob can sweep binary
 * blobs into the document stream if the operator isn't careful. Same
 * scrub + binary-extension exclusion applies here.
 */
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import crypto from "node:crypto";
// Re-use filesystem_source's glob → RegExp converter so we get the
// identical `**/`, brace-expansion, and special-char escaping rules.
// Hand-rolling a second copy here drifted on `**/` matching root-level
// files; this avoids the divergence.
import { globToRegExp } from "./ingest.ts";

const RAW_HOST = "https://raw.githubusercontent.com";
const API_HOST = "https://api.github.com";

const DEFAULT_EXCLUDE = [
  // Dependency stores + build artefacts; same shape as filesystem_source.
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/.venv/**",
  // Binary file extensions — JSONB refuses NUL bytes and these never
  // decode to useful text. (Mirrors filesystem_source's list.)
  "**/*.{png,jpg,jpeg,gif,ico,webp,bmp,tiff,avif}",
  "**/*.{mp3,mp4,mov,avi,webm,wav,flac,ogg}",
  "**/*.{zip,tar,gz,tgz,bz2,xz,7z,rar}",
  "**/*.{so,dylib,dll,exe,a,lib,o,bin}",
  "**/*.{pyc,pyo,class,jar,war}",
  "**/*.{pdf,doc,docx,xls,xlsx,ppt,pptx}",
  "**/*.{woff,woff2,ttf,otf,eot}",
  "**/*.{sqlite,db}",
  "**/*.{pack,idx}"
];

interface TreeNode {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
}

interface TreeResponse {
  tree: TreeNode[];
  truncated?: boolean;
}

/** Lightweight fetch with auth header + diagnostic 404/403 handling. */
async function ghFetch(
  url: string,
  token: string | undefined
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "ragdoll-github-source/1.0"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    throw new Error(`github_source: ${url} returned 404 — wrong repo / ref?`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `github_source: ${url} returned ${res.status} — token missing or insufficient scope`
    );
  }
  if (!res.ok) {
    throw new Error(`github_source: ${url} returned HTTP ${res.status}`);
  }
  return res;
}

export const githubSourcePlugin: InProcessPlugin = {
  manifest: {
    id: "github_source",
    name: "GitHub Source",
    version: "1.0.0",
    category: "datasource",
    description:
      "Reads files from a GitHub repository at a given ref. Emits one document per file under the include globs. Public repos work anonymously (subject to 60/hr rate limit); supplying a token unlocks 5k/hr and private repos.",
    configSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        repo: {
          type: "string",
          description: "Repository in `owner/name` form (e.g. `anthropics/claude-code`)."
        },
        ref: {
          type: "string",
          default: "main",
          description: "Branch, tag, or commit SHA. Defaults to `main`."
        },
        include: {
          type: "array",
          items: { type: "string" },
          default: ["**/*"],
          description: "Glob patterns (relative to repo root); a file is included iff it matches at least one."
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "Glob patterns excluded after include matching. Common heavy directories + binary extensions are excluded by default."
        },
        maxFileSize: {
          type: "integer",
          default: 1048576,
          description: "Skip files larger than this many bytes (default 1 MiB)."
        },
        computeHash: {
          type: "boolean",
          default: false,
          description: "Compute a sha256 of each file's content. The GitHub tree response already carries a blob sha (git-flavored); enable this when downstream `delta_filter` needs the content sha (mtime+hash mode)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          format: "secret-ref",
          description: "GitHub personal access token (classic) or fine-grained token. Required for private repos; optional for public ones (lifts the 60/hr rate limit to 5k/hr)."
        }
      },
      additionalProperties: false
    },
    outputPorts: [
      { name: "documents", description: "Array of { docId, path, content, mtime, sha256?, size }." },
      { name: "repo", description: "Resolved repo (`owner/name@ref`), surfaced for downstream auditing." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "git-branch",
      color: "#0f172a",
      formHints: {
        repo: { widget: "text" },
        ref: { widget: "text" },
        include: { widget: "tags" },
        exclude: { widget: "tags" },
        maxFileSize: { widget: "number", min: 1, step: 1024 },
        computeHash: { widget: "checkbox" },
        token: { widget: "secret" }
      }
    }
  },
  async execute({ config, secrets }) {
    const repo = String(config.repo ?? "").trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(
        `github_source: \`repo\` must be \`owner/name\`, got "${repo}"`
      );
    }
    // `ref` accepts a branch, tag, or full SHA. When unset or set to
    // the sentinel "HEAD"/"default" we discover the repo's default
    // branch via `/repos/{owner}/{name}` — keeps the demo working
    // against legacy repos like `octocat/Hello-World` that still use
    // `master`, without hardcoding the demo to one branch name.
    let ref = String(config.ref ?? "").trim();
    const wantsDefault =
      ref === "" || /^(head|default)$/i.test(ref);
    if (wantsDefault) {
      const metaRes = await ghFetch(
        `${API_HOST}/repos/${repo}`,
        secrets.token ? String(secrets.token) : undefined
      );
      const meta = (await metaRes.json()) as { default_branch?: string };
      ref = meta.default_branch ?? "main";
    }
    const include = (Array.isArray(config.include) ? (config.include as string[]) : ["**/*"]).map(
      globToRegExp
    );
    const excludeList = Array.isArray(config.exclude) ? (config.exclude as string[]) : [];
    const exclude = [...DEFAULT_EXCLUDE, ...excludeList].map(globToRegExp);
    const maxFileSize = Number(config.maxFileSize ?? 1048576);
    const computeHash = config.computeHash === true;
    const token = secrets.token ? String(secrets.token) : undefined;

    // Step 1: pull the recursive tree. `{ref}` accepts a branch, tag,
    // or full SHA — GitHub resolves it. The `recursive=1` flag is
    // capped at 100k entries server-side; the `truncated` flag tells
    // us if we hit it. Most application repos are well under this.
    const treeUrl = `${API_HOST}/repos/${repo}/git/trees/${encodeURIComponent(
      ref
    )}?recursive=1`;
    const treeRes = await ghFetch(treeUrl, token);
    const treeBody = (await treeRes.json()) as TreeResponse;
    if (treeBody.truncated) {
      // Soft warning: surface in the result so the operator can see
      // the run was incomplete; not throwing so the pipeline still
      // gets the rows we did read.
      console.warn(
        `github_source: tree for ${repo}@${ref} was truncated by GitHub (>100k entries)`
      );
    }
    const blobs = (treeBody.tree ?? []).filter((n) => n.type === "blob");

    // Step 2: per-blob content fetch. Sequential — parallelizing
    // tends to trigger GitHub's secondary rate limit on bigger repos
    // and the wall-clock win on small-to-medium repos isn't worth the
    // complexity. If this becomes a bottleneck, swap in a small
    // p-limit pool.
    const documents: Array<{
      docId: string;
      path: string;
      content: string;
      mtime: string;
      size: number;
      sha256?: string;
    }> = [];
    const auditMtime = new Date().toISOString(); // see comment in loop
    for (const blob of blobs) {
      const rel = blob.path;
      if (!include.some((re) => re.test(rel))) continue;
      if (exclude.some((re) => re.test(rel))) continue;
      if (blob.size !== undefined && blob.size > maxFileSize) continue;

      const rawUrl = `${RAW_HOST}/${repo}/${encodeURIComponent(ref)}/${rel
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      const raw = await ghFetch(rawUrl, token);
      const content = await raw.text();

      // NUL scrub — same logic as filesystem_source. JSONB refuses
      // U+0000 anywhere; >1% NUL density usually means we're looking
      // at a binary the include glob shouldn't have matched.
      const nulMatches = content.match(/\u0000/g);
      const nulCount = nulMatches ? nulMatches.length : 0;
      if (nulCount > Math.max(8, content.length * 0.01)) continue;
      const sanitized =
        nulCount > 0 ? content.replace(/\u0000/g, "\uFFFD") : content;

      // GitHub doesn't expose per-file mtime on the tree response.
      // We could fall back to the commit history of each blob (1 API
      // call per file — too expensive) or to the tree-level commit's
      // date. We use the latter via a stamp from the time of this
      // execution; downstream `delta_filter` should be in `hash` mode
      // when paired with this plugin (not mtime).
      documents.push({
        docId: rel,
        path: rel,
        content: sanitized,
        mtime: auditMtime,
        size: blob.size ?? sanitized.length,
        ...(computeHash
          ? {
              sha256: crypto
                .createHash("sha256")
                .update(sanitized)
                .digest("hex")
            }
          : {})
      });
    }
    return {
      outputs: { documents, repo: `${repo}@${ref}` }
    };
  }
};
