import test from "node:test";
import assert from "node:assert/strict";
import { Catalog, RESOURCE_SCHEME, entryToolRouting } from "../dist/catalog.js";

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
  assert.equal(entryToolRouting(entry), "execute_command");
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

