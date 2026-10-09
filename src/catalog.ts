/**
 * Command catalog — types, loading, search, and URI resolution.
 *
 * Entries come from debugger.chm and local debuggercmds Markdown references,
 * each with an id, section, title, summary, tokens, and full documentation.
 * Command pages are addressed by `windbg://command/{id}`.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatalogSection = "command" | "meta_command" | "extension";

export interface CatalogEntry {
  id: string;
  section: CatalogSection;
  title: string;
  summary: string;
  tokens: string[];
  supports_text_execution: boolean;
  user_mode_syntax: string | null;
  kernel_mode_syntax: string | null;
  documentation: string;
  source?: string;
  compatibility_note?: string;
}

// ---------------------------------------------------------------------------
// URI constants
// ---------------------------------------------------------------------------

export const RESOURCE_SCHEME = "windbg://command/";
export const TEMPLATE_URI = "windbg://command/{id}";

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

const LEARN_COMMAND_ROOT = "https://learn.microsoft.com/windows-hardware/drivers/debuggercmds/";

/** Normalize links at catalog load, leaving stored/imported upstream bodies intact. */
export function normalizeDocumentationLinks(documentation: string, source = LEARN_COMMAND_ROOT): string {
  const absoluteLink = (target: string, image = false): string => {
    // External URLs and page-local anchors already have the intended destination.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return target;
    const url = new URL(target, source);
    if (!image && url.hostname === "learn.microsoft.com" &&
        url.pathname.startsWith("/windows-hardware/drivers/")) {
      url.pathname = url.pathname.replace(/\.md$/i, "");
    }
    return url.href;
  };

  // Links inside code are examples, not navigable documentation links.
  const chunks = documentation.split(/(^[ \t]*(?:`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\r?$)|`+[^`\r\n]*`+)/gm);
  for (let i = 0; i < chunks.length; i += 2) {
    chunks[i] = chunks[i]
      .replace(/(!?\[[^\]\r\n]*\]\(\s*)(<[^>\r\n]*>|[^\s)\r\n]+)/g,
        (_match, prefix: string, destination: string) => {
          const angled = destination.startsWith("<");
          const target = angled ? destination.slice(1, -1) : destination;
          const link = absoluteLink(target, prefix.startsWith("!"));
          return prefix + (angled ? `<${link}>` : link);
        })
      .replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
        (_match, prefix: string, quote: string, target: string) =>
          prefix + quote + absoluteLink(target) + quote)
      .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi,
        (_match, prefix: string, quote: string, target: string) =>
          prefix + quote + absoluteLink(target, true) + quote)
      .replace(/(:::image\b[^\r\n]*?\bsource\s*=\s*)(["'])([^"']*)\2/gi,
        (_match, prefix: string, quote: string, target: string) =>
          prefix + quote + absoluteLink(target, true) + quote);
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export class Catalog {
  private entries: CatalogEntry[];
  private byId: Map<string, number>;

  private constructor(entries: CatalogEntry[]) {
    this.entries = entries;
    this.byId = new Map();
    for (let i = 0; i < entries.length; i++) {
      this.byId.set(entries[i].id, i);
    }
  }

  private static instance: Catalog | null = null;

  static load(): Catalog {
    if (Catalog.instance) return Catalog.instance;
    const raw = JSON.parse(
      readFileSync(new URL("./data/catalog.json", import.meta.url), "utf-8"),
    ) as CatalogEntry[];
    // Validate section values
    const entries = raw.map((e): CatalogEntry => ({
      ...e,
      section: e.section === "meta_command" || e.section === "extension" ? e.section : "command",
      documentation: normalizeDocumentationLinks(e.documentation, e.source),
    }));
    Catalog.instance = new Catalog(entries);
    return Catalog.instance;
  }

  len(): number { return this.entries.length; }

  getById(id: string): CatalogEntry | null {
    const idx = this.byId.get(id);
    return idx !== undefined ? this.entries[idx] : null;
  }

  resolveResourceUri(uri: string): CatalogEntry | null {
    if (uri.startsWith(RESOURCE_SCHEME)) {
      return this.getById(uri.slice(RESOURCE_SCHEME.length));
    }
    return null;
  }

  search(query: string, limit: number): CatalogEntry[] {
    limit = Math.max(0, Math.trunc(limit));
    const needle = query.trim().toLowerCase();
    if (!needle) return this.entries.slice(0, limit);

    const terms = needle.split(/\s+/).filter(Boolean);
    const scored: { tier: number; score: number; matched: number; entry: CatalogEntry }[] = [];

    for (const entry of this.entries) {
      // A complete identity match outranks every fuzzy result, regardless of
      // how many aliases that result happens to have.
      let tier = entry.id.toLowerCase() === needle ? 4 : 0;
      let bestAlias = 0;
      for (const token of entry.tokens) {
        const lower = token.toLowerCase();
        if (lower === needle) { tier = Math.max(tier, 3); bestAlias = 500; }
        else if (lower.startsWith(needle)) { tier = Math.max(tier, 2); bestAlias = Math.max(bestAlias, 200); }
        else if (lower.includes(needle)) { tier = Math.max(tier, 1); bestAlias = Math.max(bestAlias, 100); }
      }

      let score = bestAlias;
      let matched = 0;
      const title = entry.title.toLowerCase();
      const summary = entry.summary.toLowerCase();
      for (const term of terms) {
        let bestTermAlias = 0;
        for (const token of entry.tokens) {
          const lower = token.toLowerCase();
          if (lower === term) bestTermAlias = Math.max(bestTermAlias, 50);
          else if (lower.startsWith(term)) bestTermAlias = Math.max(bestTermAlias, 20);
          else if (lower.includes(term)) bestTermAlias = Math.max(bestTermAlias, 10);
        }
        let termScore = bestTermAlias;
        if (title.includes(term)) termScore += 15;
        if (summary.includes(term)) termScore += 5;
        score += termScore;
        if (termScore > 0) matched++;
      }

      if (tier > 0 || score > 0) scored.push({ tier, score, matched, entry });
    }

    scored.sort((a, b) =>
      b.tier - a.tier || b.score - a.score || b.matched - a.matched || a.entry.id.localeCompare(b.entry.id),
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }

  renderIndex(): string {
    const commandCount = this.entries.filter((e) => e.section === "command").length;
    const metaCount = this.entries.filter((e) => e.section === "meta_command").length;
    const extensionCount = this.entries.filter((e) => e.section === "extension").length;

    let out = "";
    out += "Catalog\n-------\n";
    out += `Total entries: ${this.len()}\n`;
    out += `Commands: ${commandCount}\n`;
    out += `Meta-commands: ${metaCount}\n`;
    out += `Extension commands: ${extensionCount}\n`;
    return out;
  }
}
