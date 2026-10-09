import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const windows = process.platform === "win32";
const cdbPath = process.env.WINDBG_MCP_TEST_CDB_PATH;
const nativeDebugger = windows && Boolean(cdbPath);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function connect(t, era) {
  const client = new Client({ name: "windbg-contract-tests", version: "1.0.0" }, {
    versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
  });
  const transport = new StdioClientTransport({
    command: process.env.WINDBG_MCP_TEST_RUNTIME ?? process.execPath,
    args: [entry],
    env: process.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await client.close();
    assert.equal(stderr, "");
  });
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), era);
  return client;
}

function payload(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

for (const era of ["legacy", "modern"]) {
  test(`${era}: catalog search resolves to the matching command resource`, { skip: !windows }, async (t) => {
    const client = await connect(t, era);
    const result = await client.callTool({
      name: "windbg_search_commands", arguments: { query: "!process", limit: 1 },
    });
    assert.equal(result.isError, false);
    const [command] = result.structuredContent.results;
    assert.ok(command.tokens.includes("!process"));
    const resource = await client.readResource({ uri: command.resource });
    assert.equal(resource.contents[0].uri, command.resource);
    assert.match(resource.contents[0].text, /EPROCESS/);
    const guide = await client.readResource({ uri: "windbg://guide/overview" });
    assert.match(guide.contents[0].text, /windbg_execute_command/);
  });

  test(`${era}: invalid tool inputs and missing sessions remain recoverable tool errors`, { skip: !windows }, async (t) => {
    const client = await connect(t, era);
    const invalid = [
      ["windbg_open_executable", {}],
      ["windbg_open_executable", { executable: process.execPath, args: ["-e", 2] }],
      ["windbg_open_dump", { dump_path: 1 }],
      ["windbg_attach_kernel", { kernel_connection: " " }],
      ["windbg_attach_process", {}],
      ["windbg_attach_process", { pid: 2147483647, name: "__not_a_process__.exe" }],
      ["windbg_attach_process", { pid: 1.5 }],
      ["windbg_execute_command", { session_id: "does-not-exist", command: " " }],
      ["windbg_execute_command", { session_id: "does-not-exist", wait_for_completion: "false" }],
      ["windbg_execute_command", { session_id: "does-not-exist", timeout: 0 }],
      ["windbg_close", { session_id: null }],
      ["windbg_detach", { session_id: "" }],
      ["windbg_search_commands", { query: " " }],
      ["windbg_search_commands", { query: "stack", limit: -1 }],
      ["windbg_execute_command", { session_id: "does-not-exist" }],
    ];
    for (const [name, args] of invalid) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
    }
    const state = await client.callTool({ name: "windbg_sessions", arguments: {} });
    assert.deepEqual(state.structuredContent.sessions, []);
  });

  test(`${era}: unavailable resources are protocol errors and do not close the connection`, { skip: !windows }, async (t) => {
    const client = await connect(t, era);
    await assert.rejects(
      client.readResource({ uri: "windbg://command/__missing_resource__" }),
      (error) => error.code === -32602,
    );
    const result = await client.callTool({
      name: "windbg_search_commands", arguments: { query: ".process", limit: 1 },
    });
    assert.deepEqual(result.structuredContent.results[0].tokens, [".process"]);
  });
}

test("modern SDK default stdio buffer reconstructs more than 6 MiB without losing the session", {
  skip: !nativeDebugger, timeout: 120000,
}, async (t) => {
  // Deliberately use connect's unmodified official transport buffer settings.
  const client = await connect(t, "modern");
  const opened = payload(await client.callTool({
    name: "windbg_open_executable", arguments: {
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      cdb_path: cdbPath, symbols_path: process.env.SystemRoot, timeout: 15,
    },
  }));
  const session_id = opened.session_id;
  const pidResult = payload(await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command: "? @$tpid" },
  }));
  const match = pidResult.output.match(/Evaluate expression: (\d+)/);
  assert.ok(match, pidResult.output);
  const ownedPid = Number(match[1]);
  t.after(() => {
    try { process.kill(ownedPid); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  process.kill(ownedPid, 0);

  const line = "0123456789abcdef".repeat(32);
  const rows = 14000;
  const expected = Array(rows).fill(line).join("\n");
  const expectedBytes = Buffer.byteLength(expected, "utf8");
  assert.ok(expectedBytes > 6 * 1024 * 1024);
  const command = `.for (r @$t0=0; @$t0<0n${rows}; r @$t0=@$t0+1) { .echo ${line} }`;
  let response = await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command, timeout: 60 },
  }, { timeout: 65000 });
  const first = payload(response);
  assert.equal(first.completed, true);
  assert.equal(first.has_more_output, true);
  assert.equal(first.total_output_bytes, expectedBytes);
  const pages = [];
  let offset = 0;
  const hash = createHash("sha256");
  for (;;) {
    const page = payload(response);
    const bytes = Buffer.byteLength(page.output, "utf8");
    assert.equal(page.command_id, first.command_id);
    assert.equal(page.completed, true);
    assert.equal(page.output_offset, offset);
    assert.equal(page.total_output_bytes, expectedBytes);
    assert.ok(bytes > 0 && bytes <= 65536);
    assert.equal(page.next_output_offset, offset + bytes);
    assert.equal(page.has_more_output, page.next_output_offset < expectedBytes);
    // Both structured content and text content must fit one bounded response.
    assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 256 * 1024);
    pages.push(page.output);
    hash.update(page.output, "utf8");
    offset = page.next_output_offset;
    if (!page.has_more_output) break;
    response = await client.callTool({
      name: "windbg_execute_command", arguments: {
        session_id, command_id: first.command_id, output_offset: offset,
      },
    });
  }
  assert.equal(offset, expectedBytes);
  assert.ok(pages.length > 96);
  assert.equal(hash.digest("hex"), createHash("sha256").update(expected, "utf8").digest("hex"));
  assert.equal(pages.join(""), expected);
  process.kill(ownedPid, 0);

  const successor = payload(await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command: ".echo SDK-CONNECTION-SURVIVES" },
  }));
  assert.equal(successor.output, "SDK-CONNECTION-SURVIVES");
  assert.notEqual(successor.command_id, first.command_id);
  const stale = await client.callTool({
    name: "windbg_execute_command", arguments: {
      session_id, command_id: first.command_id, output_offset: 0,
    },
  });
  assert.equal(stale.isError, true);
  const current = payload(await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command_id: successor.command_id },
  }));
  assert.equal(current.output, successor.output);
  assert.equal(current.command_id, successor.command_id);
  const listed = payload(await client.callTool({ name: "windbg_sessions", arguments: {} }));
  assert.deepEqual(listed.sessions.map((session) => session.session_id), [session_id]);
  assert.equal(listed.sessions[0].state.ready_for_commands, true);
  process.kill(ownedPid, 0);
  payload(await client.callTool({ name: "windbg_close", arguments: { session_id } }));
});

test("native target termination keeps the debugger usable and direct quit releases its session", {
  skip: !nativeDebugger, timeout: 30000,
}, async (t) => {
  const client = await connect(t, "modern");
  const { session_id } = payload(await client.callTool({
    name: "windbg_open_executable", arguments: {
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      cdb_path: cdbPath, symbols_path: process.env.SystemRoot, timeout: 10,
    },
  }));
  const pidResult = payload(await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command: "? @$tpid" },
  }));
  const match = pidResult.output.match(/Evaluate expression: (\d+)/);
  assert.ok(match, pidResult.output);
  const pid = Number(match[1]);
  t.after(() => {
    try { process.kill(pid); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  const killed = payload(await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command: ".kill" },
  }));
  assert.equal(killed.completed, true);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const usable = payload(await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command: '.printf "%d", 6*7' },
  }));
  assert.equal(usable.output, "42");
  const quit = await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command: "q" },
  });
  assert.equal(quit.isError, true);
  assert.deepEqual(payload(await client.callTool({ name: "windbg_sessions", arguments: {} })).sessions, []);
});

test("explicit close terminates a session whose commands suppressed completion markers", {
  skip: !nativeDebugger, timeout: 30000,
}, async (t) => {
  const client = await connect(t, "modern");
  const { session_id } = payload(await client.callTool({
    name: "windbg_open_executable", arguments: {
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      cdb_path: cdbPath, symbols_path: process.env.SystemRoot, timeout: 4,
    },
  }));
  const unconfirmed = payload(await client.callTool({
    name: "windbg_execute_command", arguments: { session_id, command: ".outmask- /l 0xffffffff", timeout: 0.1 },
  }));
  assert.equal(unconfirmed.completed, false);
  const closed = payload(await client.callTool({ name: "windbg_close", arguments: { session_id } }));
  assert.equal(closed.closed, session_id);
  assert.deepEqual(payload(await client.callTool({ name: "windbg_sessions", arguments: {} })).sessions, []);
});
