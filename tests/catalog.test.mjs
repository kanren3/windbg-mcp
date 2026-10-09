import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Catalog, RESOURCE_SCHEME, normalizeDocumentationLinks } from "../dist/catalog.js";
import { renderCommand } from "../dist/resources.js";

const catalog = Catalog.load();

function firstFor(query) {
  const results = catalog.search(query, 1);
  assert.equal(results.length, 1, `No result for ${query}`);
  return results[0];
}

function exactExtension(token) {
  const entry = firstFor(token);
  assert.equal(entry.section, "extension");
  assert.ok(entry.tokens.includes(token), `${token} resolved to a different command`);
  return entry;
}

test("core kernel-analysis extensions are directly searchable and resolvable", () => {
  for (const token of ["!analyze", "!process", "!thread", "!irp", "!pool", "!devstack"]) {
    const entry = exactExtension(token);
    assert.equal(catalog.getById(entry.id), entry);
    assert.equal(catalog.resolveResourceUri(RESOURCE_SCHEME + entry.id), entry);
    assert.ok(new URL(entry.source).pathname.includes("/debuggercmds/"));
  }
  assert.equal(firstFor("  !PROCESS  ").id, exactExtension("!process").id);
});

test("symbols distinguish process-context commands from process extensions", () => {
  const context = firstFor(".process");
  const process = exactExtension("!process");
  assert.ok(context.tokens.includes(".process"));
  assert.equal(context.section, "meta_command");
  assert.notEqual(context.id, process.id);
  assert.equal(context.id, "process_set_process_context");
  assert.equal(catalog.resolveResourceUri(RESOURCE_SCHEME + context.id), context);
  assert.notEqual(context.documentation, process.documentation);
});

test("qualified extension families and escaped underscores keep their identity", () => {
  for (const token of [
    "!ndiskd.netadapter", "!ndiskd.nbl", "!wdfkd.wdfdevice",
    "!usb3kd.xhci_findowner", "!usbkd._ehcidd",
  ]) exactExtension(token);
  for (const prefix of ["!ndiskd.", "!wdfkd.", "!usb3kd."]) {
    const entries = catalog.search(prefix, 5);
    assert.ok(entries.length > 1, `Missing family for ${prefix}`);
    assert.ok(entries.every((entry) => entry.tokens.some((token) => token.startsWith(prefix))));
  }
});

test("extension family options resolve as DLL-qualified commands", () => {
  const acx = exactExtension("!acxkd.help");
  for (const command of [
    "acxcircuit", "acxdataformat", "acxdataformatlist", "acxdevice", "acxelement",
    "acxevents", "acxfactory", "acxmanager", "acxmethods", "acxobjbag", "acxobject",
    "acxpin", "acxproperties", "acxstream", "acxstreambridge", "acxtarget", "acxtemplate",
  ]) {
    assert.equal(exactExtension(`!acxkd.${command}`).id, acx.id);
  }
  assert.equal(firstFor("!acxkd").id, acx.id);
  assert.ok(!acx.tokens.includes("!acxkd"));
  assert.ok(!acx.tokens.some((token) => token.startsWith("!wdfkd.")));
  assert.notEqual(firstFor("!wdfkd.wdfdriverinfo").id, acx.id);
});

test("AMLI subcommands and grouped commands do not collapse into wrong tokens", () => {
  const clear = exactExtension("!amli bc");
  const disable = exactExtension("!amli bd");
  exactExtension("!amli ?");
  assert.notEqual(clear.id, disable.id);
  const bytes = exactExtension("!db");
  assert.equal(exactExtension("!dw").id, bytes.id);
  assert.equal(exactExtension("!dc").id, bytes.id);
  assert.ok(!bytes.tokens.includes("!db, !dc"));
});

test("explicit extension headings override missing or descriptive metadata titles", () => {
  for (const token of ["!chklowmem", "!index", "!positions", "!tt"]) exactExtension(token);
});

test("ambiguous unqualified commands keep separate pages and qualified aliases", () => {
  for (const token of ["!dp", "!locks"]) {
    const matches = catalog.search(token, 20).filter((entry) => entry.tokens.includes(token));
    assert.ok(matches.length > 1, `${token} lost a documented variant`);
    assert.equal(new Set(matches.map((entry) => entry.id)).size, matches.length);
    for (const entry of matches) assert.equal(catalog.resolveResourceUri(RESOURCE_SCHEME + entry.id), entry);
  }
  assert.ok(exactExtension("!ntsdexts.dp").tokens.includes("!dp"));
  assert.ok(exactExtension("!ntsdexts.locks").tokens.includes("!locks"));
});

test("resource resolution rejects unknown IDs and unrelated schemes", () => {
  const process = exactExtension("!process");
  assert.equal(catalog.resolveResourceUri("windbg://command/missing-command"), null);
  assert.equal(catalog.resolveResourceUri("other://command/" + process.id), null);
});

test("short exact command tokens and catalog IDs outrank fuzzy aliases", () => {
  const identities = {
    r: "r_registers",
    a: "a_assemble",
    k: "k_kb_kc_kd_kp_kp_kv_display_stack_backtrace",
    t: "t_trace",
  };
  for (const [token, id] of Object.entries(identities)) {
    assert.equal(firstFor(token).id, id);
    assert.equal(firstFor(`  ${token.toUpperCase()}  `).id, id);
    assert.equal(firstFor(id).id, id);
  }
});

test("fuzzy ranking uses the best alias while retaining multi-term relevance", () => {
  const entry = (id, tokens, title = "") => ({
    id, tokens, title, summary: "", section: "command",
    supports_text_execution: true, user_mode_syntax: null,
    kernel_mode_syntax: null, documentation: "",
  });
  const useful = entry("useful", ["memory", "inspect"], "Memory inspection");
  const noisy = entry("noisy", Array.from({ length: 30 }, (_, index) => `memory_alias_${index}`));
  const exactId = entry("mem", ["unrelated"]);
  const ranked = new Catalog([noisy, useful, exactId]);
  assert.equal(ranked.search("mem", 1)[0], exactId);
  assert.equal(ranked.search("memory", 1)[0], useful);
  assert.equal(ranked.search("memo", 1)[0], useful);
  assert.equal(ranked.search("inspect memory", 1)[0], useful);
});

test("the for resource documents the loop token rather than an extension", () => {
  const entry = firstFor(".for");
  assert.equal(entry.id, "for_token");
  assert.equal(entry.section, "meta_command");
  assert.equal(new URL(entry.source).pathname, "/windows-hardware/drivers/debuggercmds/-for");
  assert.match(entry.documentation, /\.for\s+\(InitialCommand\s*;\s*Condition\s*;\s*IncrementCommands\)/);
  assert.match(entry.documentation, /\.for\s+\(r\s+eax=0\s*;/);
  assert.doesNotMatch(entry.documentation, /!for_each_frame/);
  assert.notEqual(exactExtension("!for_each_frame").id, entry.id);
  assert.equal(catalog.resolveResourceUri(RESOURCE_SCHEME + entry.id), entry);
});

test("qd preserves upstream restrictions separately from verified kernel compatibility", () => {
  const qd = firstFor("qd");
  assert.match(qd.documentation, /user mode only/i);
  assert.match(qd.compatibility_note, /outdated/i);
  assert.match(qd.compatibility_note, /verif/i);
  assert.match(qd.compatibility_note, /kernel.mode/i);
  assert.match(qd.compatibility_note, /not.*dumps/i);
  const rendered = renderCommand(qd);
  const compatibility = rendered.indexOf(qd.compatibility_note);
  const documentation = rendered.indexOf(qd.documentation);
  assert.ok(compatibility >= 0 && documentation > compatibility);
  assert.equal(new URL(qd.source).pathname, "/windows-hardware/drivers/debuggercmds/qd--quit-and-detach-");
});

test("documentation links normalize relative Markdown and HTML without changing code or external URLs", () => {
  const source = "https://learn.microsoft.com/windows-hardware/drivers/debuggercmds/-sample";
  const root = "https://learn.microsoft.com/windows-hardware/drivers/";
  const code = '```dbgcmd\n.echo [literal](../debugger/example.md)\n<a href="example.md">literal</a>\n```';
  const documentation = [
    "[Context](../debugger/changing-contexts.md#session-context)",
    "[Type](dt--display-type-.md#remarks)",
    '<a class="topic" href="../debugger/debugger-command-window.md#commands">Window</a>',
    "<a href='../audio/acx-audio-class-extensions-overview.md'>Audio</a>",
    "[DDI](/windows-hardware/drivers/ddi/ntifs/nf-ntifs-iowriteerrorlogentry.md?view=windows-driver#remarks)",
    "[External](https://example.org/reference.md#part)",
    "[Protocol relative](//example.org/reference.md)",
    "[Local](#Parameters)",
    "![Image](images/diagram.md)",
    '<img src="images/diagram.png" alt="diagram">',
    ':::image type="content" source="images/diagram.png" alt-text="diagram":::',
    "`[literal](example.md)`",
    code,
  ].join("\n\n");
  const normalized = normalizeDocumentationLinks(documentation, source);
  assert.ok(normalized.includes(root + "debugger/changing-contexts#session-context"));
  assert.ok(normalized.includes(root + "debuggercmds/dt--display-type-#remarks"));
  assert.ok(normalized.includes(root + "debugger/debugger-command-window#commands"));
  assert.ok(normalized.includes(root + "audio/acx-audio-class-extensions-overview"));
  assert.ok(normalized.includes(root + "ddi/ntifs/nf-ntifs-iowriteerrorlogentry?view=windows-driver#remarks"));
  assert.ok(normalized.includes("[External](https://example.org/reference.md#part)"));
  assert.ok(normalized.includes("[Protocol relative](//example.org/reference.md)"));
  assert.ok(normalized.includes("[Local](#Parameters)"));
  assert.ok(normalized.includes(`![Image](${root}debuggercmds/images/diagram.md)`));
  assert.ok(normalized.includes(root + "debuggercmds/images/diagram.png"));
  assert.ok(normalized.includes("`[literal](example.md)`"));
  assert.ok(normalized.includes(code));
  assert.equal(normalizeDocumentationLinks(normalized, source), normalized);
});

test("retained meta-command and imported extension links share the load boundary", () => {
  const root = "https://learn.microsoft.com/windows-hardware/drivers/";
  assert.ok(firstFor(".for").documentation.includes(root + "debugger/using-debugger-command-programs"));
  assert.ok(exactExtension("!acxkd.help").documentation.includes(root + "audio/acx-audio-class-extensions-overview"));
  assert.ok(exactExtension("!address").documentation.includes(`href="${root}debuggercmds/-foreach"`));
  assert.ok(exactExtension("!sprocess").documentation.includes(`href="${root}debugger/changing-contexts#session-context"`));
});

test("extension import is deterministic on temporary assets and preserves retained source bodies", () => {
  const directory = mkdtempSync(join(tmpdir(), "windbg-catalog-"));
  try {
    const path = join(directory, "catalog.json");
    const retained = [{
      id: "for_token", section: "meta_command", title: ".for", summary: "loop",
      tokens: [".for"], supports_text_execution: true,
      user_mode_syntax: null, kernel_mode_syntax: null,
      documentation: "[Context](../debugger/changing-contexts.md#session-context)",
      compatibility_note: "Retained metadata",
    }];
    writeFileSync(path, JSON.stringify(retained, null, 2) + "\n");
    const body = '# !sample\n\n[Context](../debugger/changing-contexts.md#session-context)\n<a href="-for.md">Loop</a>\n';
    writeFileSync(join(directory, "-sample.md"), '---\ntitle: "!sample"\ndescription: "Sample extension"\n---\n' + body);
    const importer = fileURLToPath(new URL("../scripts/import-extensions.mjs", import.meta.url));
    execFileSync(process.execPath, [importer, directory, path]);
    const first = readFileSync(path, "utf8");
    execFileSync(process.execPath, [importer, directory, path]);
    assert.equal(readFileSync(path, "utf8"), first);
    const imported = JSON.parse(first);
    assert.deepEqual(imported[0], retained[0]);
    assert.equal(imported[1].documentation, body);
    const normalized = normalizeDocumentationLinks(imported[1].documentation, imported[1].source);
    assert.ok(normalized.includes("https://learn.microsoft.com/windows-hardware/drivers/debugger/changing-contexts#session-context"));
    assert.ok(normalized.includes('href="https://learn.microsoft.com/windows-hardware/drivers/debuggercmds/-for"'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

