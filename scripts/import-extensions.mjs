// Import explicit extension-reference pages without regenerating the existing
// standard/meta-command catalog. Run: node scripts/import-extensions.mjs <debuggercmds-dir>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const docsDirectory = process.argv[2];
if (!docsDirectory) {
  throw new Error("Usage: node scripts/import-extensions.mjs <debuggercmds-dir> [catalog-json]");
}
const catalogPath = process.argv[3] ?? new URL("../src/data/catalog.json", import.meta.url);
const original = readFileSync(catalogPath, "utf8");
const retained = JSON.parse(original).filter((entry) => entry.section !== "extension");
const extensions = [];
const ids = new Set(retained.map((entry) => entry.id));
const commandPattern = /^![a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*(?:\s+(?:[a-zA-Z0-9_]+|\?))?$/;
const learnRoot = "https://learn.microsoft.com/windows-hardware/drivers/debuggercmds/";

// These pages use single-line YAML strings. Decode the quoted scalars, but do
// not treat front matter or command examples as a source of command identities.
function scalar(frontMatter, field, file) {
  const value = frontMatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1].trim();
  if (!value) throw new Error(`${file}: missing ${field}`);
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

const files = readdirSync(docsDirectory).filter((file) => file.endsWith(".md")).sort();
for (const file of files) {
  const text = readFileSync(join(docsDirectory, file), "utf8").replaceAll("\r\n", "\n");
  const page = text.match(/^\uFEFF?---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!page) throw new Error(`${file}: missing front matter`);
  const metadataTitle = scalar(page[1], "title", file);
  const heading = page[2].match(/^#\s+(.+)$/m)?.[1]
    .replace(/\\([_*!])/g, "$1").trim();
  if (!heading?.startsWith("!") && !metadataTitle.startsWith("!")) continue;
  if (!heading?.startsWith("!")) {
    throw new Error(`${file}: extension title has no explicit extension heading`);
  }

  // Keep grouped commands and AMLI subcommands intact. A parenthesized literal
  // DLL-qualified alias is also searchable; wildcard DLL names are not tokens.
  const tokens = heading.split("(", 1)[0].trim().split(/\s*,\s*/);
  if (tokens.some((token) => !commandPattern.test(token))) {
    throw new Error(`${file}: ambiguous extension heading ${heading}`);
  }
  const family = page[2].match(/^(![a-zA-Z0-9_]+)\.\[[^\]\r\n]+\][ \t]*$/m)?.[1];
  if (tokens.length === 1 && family === tokens[0]) {
    // Family syntax names a DLL; its Options table declares the callable exports.
    const parameters = page[2].split(/^## Parameters[ \t]*$/m)[1]?.split(/^#{1,2}[ \t]/m)[0];
    const commands = [...(parameters ?? "").matchAll(/^\|[ \t]*!([a-zA-Z0-9_]+)[ \t]*\|/gm)]
      .map((match) => `${family}.${match[1]}`);
    if (!commands.length) throw new Error(`${file}: extension family has no declared commands`);
    tokens.splice(0, tokens.length, ...new Set(commands));
  }
  for (const alias of heading.matchAll(/\((![a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)\)/g)) {
    if (!tokens.includes(alias[1])) tokens.push(alias[1]);
  }
  const stem = basename(file, ".md");
  const id = "extension_" + stem.replace(/^-+|-+$/g, "").replace(/[^a-zA-Z0-9]+/g, "_");
  if (ids.has(id)) throw new Error(`${file}: duplicate catalog id ${id}`);
  ids.add(id);
  extensions.push({
    id,
    section: "extension",
    title: heading,
    summary: scalar(page[1], "description", file),
    tokens,
    supports_text_execution: true,
    user_mode_syntax: null,
    kernel_mode_syntax: null,
    source: learnRoot + stem,
    documentation: page[2].trim() + "\n",
  });
}
if (!extensions.length) throw new Error("No explicit extension-command pages found");

// Preserve the existing entry order, field values, and file newline convention.
const newline = original.includes("\r\n") ? "\r\n" : "\n";
writeFileSync(catalogPath, (JSON.stringify([...retained, ...extensions], null, 2) + "\n").replaceAll("\n", newline));
const tokenCounts = new Map();
for (const entry of extensions) {
  for (const token of entry.tokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
}
console.log(JSON.stringify({
  markdown_pages: files.length,
  retained_entries: retained.length,
  imported_extension_pages: extensions.length,
  unique_extension_tokens: tokenCounts.size,
  shared_tokens: [...tokenCounts].filter(([, count]) => count > 1).map(([token, pages]) => ({ token, pages })),
  total_entries: retained.length + extensions.length,
}, null, 2));
