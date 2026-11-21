/**
 * Builds the Pagefind search index into public/_pagefind (runs as `postbuild`).
 *
 * 1. Preferred: index the HTML that `next build` prerendered, so heading anchors work in results.
 * 2. Fallback: if that HTML is missing or yields no searchable pages in the build environment,
 *    index the MDX sources directly. Search then works without per-heading results instead of the
 *    whole deployment failing.
 *
 * Set SEARCH_SOURCE=content to force the fallback (useful to test it locally).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as pagefind from "pagefind";

const OUTPUT = "public/_pagefind";
const HTML_DIRS = [".next/server/app", "out"];
const CONTENT_DIR = "content";

function walk(dir, predicate, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, predicate, out);
    else if (predicate(name)) out.push(path);
  }
  return out;
}

/** Plain text from an MDX file: no frontmatter, imports, JSX tags or markdown punctuation. */
function toPlainText(source) {
  return source
    .replace(/^---[\s\S]*?\n---\s*/, "")
    .replace(/^import .*$/gm, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#|]/g, " ")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function frontmatterTitle(source, fallback) {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  const title = match?.[1]
    .match(/^title:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return title || fallback;
}

function routeFor(file) {
  const rel = relative(CONTENT_DIR, file)
    .split(sep)
    .join("/")
    .replace(/\.mdx?$/, "");
  const route = rel.replace(/(^|\/)index$/, "");
  return route ? `/docs/${route}` : "/docs";
}

/**
 * Without any page carrying data-pagefind-body, Pagefind would index every html file, including
 * error pages. So HTML is only used when real content pages are tagged.
 */
async function addFromHtml(index) {
  for (const dir of HTML_DIRS) {
    const files = existsSync(dir) ? walk(dir, (n) => n.endsWith(".html")) : [];
    const tagged = files.filter((f) => readFileSync(f, "utf8").includes("data-pagefind-body"));
    console.log(`[search] ${dir}: ${files.length} html files, ${tagged.length} searchable`);
    if (tagged.length === 0) continue;
    const { errors } = await index.addDirectory({ path: dir });
    for (const e of errors) console.warn(`[search] ${e}`);
  }
}

async function addFromContent(index) {
  for (const file of walk(CONTENT_DIR, (n) => /\.mdx?$/.test(n))) {
    const source = readFileSync(file, "utf8");
    const route = routeFor(file);
    const { errors } = await index.addCustomRecord({
      url: route,
      content: toPlainText(source),
      language: "en",
      meta: { title: frontmatterTitle(source, route) },
    });
    for (const e of errors) console.warn(`[search] ${route}: ${e}`);
  }
}

/** Builds one index from the given source and returns how many searchable pages it holds. */
async function build(source) {
  const { errors, index } = await pagefind.createIndex({});
  if (!index) throw new Error(`could not create an index: ${errors.join("; ")}`);
  if (source === "html") await addFromHtml(index);
  else await addFromContent(index);
  const { errors: writeErrors } = await index.writeFiles({ outputPath: OUTPUT });
  if (writeErrors.length > 0)
    throw new Error(`could not write the index: ${writeErrors.join("; ")}`);
  const entry = JSON.parse(readFileSync(join(OUTPUT, "pagefind-entry.json"), "utf8"));
  return Object.values(entry.languages ?? {}).reduce((sum, l) => sum + (l.page_count ?? 0), 0);
}

try {
  let source = process.env.SEARCH_SOURCE === "content" ? "content" : "html";
  let pages = await build(source);
  if (pages === 0 && source === "html") {
    console.warn(
      "[search] prerendered HTML gave no searchable pages; indexing MDX sources instead",
    );
    source = "content";
    pages = await build(source);
  }
  if (pages === 0) throw new Error("nothing was indexed");
  console.log(`[search] indexed ${pages} pages from ${source} into ${OUTPUT}`);
} catch (error) {
  console.error(`[search] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await pagefind.close();
}
