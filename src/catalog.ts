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

export type ToolRouting = "execute_command" | "interrupt_target" | "documentation_only";

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
}

// ---------------------------------------------------------------------------
// URI constants
// ---------------------------------------------------------------------------

export const RESOURCE_SCHEME = "windbg://command/";
export const TEMPLATE_URI = "windbg://command/{id}";

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

export function entryToolRouting(entry: CatalogEntry): ToolRouting {
  if (entry.supports_text_execution) return "execute_command";
  if (entry.tokens.some((t) => t.toUpperCase() === "CTRL+C")) return "interrupt_target";
  return "documentation_only";
}

export function entryRecommendedTool(entry: CatalogEntry): string | null {
  switch (entryToolRouting(entry)) {
    case "execute_command": return "windbg_execute_command";
    case "interrupt_target": return "windbg_interrupt_target";
    case "documentation_only": return null;
  }
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
    const scored: { score: number; matched: number; entry: CatalogEntry }[] = [];

    for (const entry of this.entries) {
      let score = 0;
      let matched = 0;

      // Exact id match
      if (entry.id === needle) score += 1000;

      // Token matches
      for (const token of entry.tokens) {
        const tl = token.toLowerCase();
        if (tl === needle) score += 500;
        else if (tl.startsWith(needle)) score += 200;
        else if (tl.includes(needle)) score += 100;
      }

      // Per-term matches
      for (const term of terms) {
        let hit = false;
        for (const token of entry.tokens) {
          const tl = token.toLowerCase();
          if (tl === term) { score += 50; hit = true; }
          else if (tl.startsWith(term)) { score += 20; hit = true; }
          else if (tl.includes(term)) { score += 10; hit = true; }
        }
        if (entry.title.toLowerCase().includes(term)) { score += 15; hit = true; }
        if (entry.summary.toLowerCase().includes(term)) { score += 5; hit = true; }
        if (hit) matched++;
      }

      if (score > 0) scored.push({ score, matched, entry });
    }

    scored.sort((a, b) =>
      b.score - a.score || b.matched - a.matched || a.entry.id.localeCompare(b.entry.id),
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }

  renderIndex(): string {
    const commandCount = this.entries.filter((e) => e.section === "command").length;
    const metaCount = this.entries.filter((e) => e.section === "meta_command").length;
    const extensionCount = this.entries.filter((e) => e.section === "extension").length;

    let out = "";
    out += "WinDbg MCP guide\n\n";
    out += "Recommended flow:\n";
    out += "1. Find a command with `windbg_search_commands`, then read `windbg://command/{id}` for its full documentation.\n";
    out += "2. Call `windbg_sessions` to check the debugger state before execution.\n";
    out += "3. Collect a pending command by calling `windbg_execute_command` without command, or cancel it with `windbg_interrupt_target`.\n";
    out += "4. Submit a new command only when ready_for_commands is true; use wait_for_completion=false to return without waiting.\n\n";
    out += `Total entries: ${this.len()}\n`;
    out += `Commands: ${commandCount}\n`;
    out += `Meta-commands: ${metaCount}\n`;
    out += `Extension commands: ${extensionCount}\n`;
    out += "Session state tool: windbg_sessions\n";
    out += `Command page template: ${TEMPLATE_URI}\n\n`;
    return out;
  }
}
