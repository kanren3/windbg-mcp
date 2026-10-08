import test from "node:test";
import assert from "node:assert/strict";

// Native debugger imports require Windows, even for protocol-only requests.
const windows = process.platform === "win32";
const { McpServer } = windows ? await import("../dist/mcp.js") : {};
const request = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test("invalid envelopes are rejected, not executed or mistaken for notifications", { skip: !windows }, async () => {
  const server = new McpServer();
  const invalid = [
    null, [], {}, { method: "ping" },
    { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: 1 },
    request(null, "ping"), request(true, "ping"), request({}, "ping"), request(1.5, "ping"),
    request(2, "ping", null), request(3, "ping", "bad"), request(4, "ping", []),
    { jsonrpc: "2.0", method: "ping", params: 1 },
  ];
  for (const value of invalid) {
    const response = await server.handle(value);
    assert.equal(response.error.code, -32600, JSON.stringify(value));
    assert.equal(response.jsonrpc, "2.0");
  }
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "ping" }), null);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "unknown" }), null);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "unknown" } }), null);
  assert.deepEqual(await server.handle(request("中文", "ping")), {
    jsonrpc: "2.0", id: "中文", result: { resultType: "complete" },
  });
});

test("protocol parameters and tool input failures use their separate error channels", { skip: !windows }, async () => {
  const server = new McpServer();
  let id = 0;
  for (const params of [undefined, {}, { name: 1 }, { name: "unknown" }, { name: "windbg_sessions", arguments: [] }, { name: "windbg_sessions", arguments: null }]) {
    const response = await server.handle(request(++id, "tools/call", params));
    assert.equal(response.error.code, -32602, JSON.stringify(params));
  }
  const badArguments = [
    ["windbg_open_executable", {}],
    ["windbg_open_executable", { executable: "node.exe", args: ["ok", 2] }],
    ["windbg_open_executable", { executable: "node.exe", args: "bad" }],
    ["windbg_open_dump", { dump_path: 1 }],
    ["windbg_attach_kernel", { kernel_connection: "" }],
    ["windbg_attach_process", {}],
    ["windbg_attach_process", { pid: 1, name: "node.exe" }],
    ...[0, -1, 1.5, "12", Infinity, NaN].map((pid) => ["windbg_attach_process", { pid }]),
    ["windbg_attach_process", { name: 1 }],
    ["windbg_execute_command", { command: 1 }],
    ["windbg_execute_command", { command: "" }],
    ["windbg_execute_command", { wait_for_completion: "false" }],
    ...[0, -1, Infinity, NaN, "1"].map((timeout) => ["windbg_execute_command", { timeout }]),
    ["windbg_open_dump", { dump_path: "example.dmp", cdb_path: 1 }],
    ["windbg_attach_kernel", { kernel_connection: "net:port=50000,key=1.2.3.4", symbols_path: [] }],
    ["windbg_close", { session_id: null }],
    ["windbg_detach", { session_id: "" }],
    ["windbg_interrupt_target", { session_id: 2 }],
    ["windbg_search_commands", { query: " " }],
    ...[0, -1, 1.5, Infinity, "2"].map((limit) => ["windbg_search_commands", { query: "stack", limit }]),
  ];
  for (const [name, args] of badArguments) {
    const response = await server.handle(request(++id, "tools/call", { name, arguments: args }));
    assert.equal(response.error, undefined, name);
    assert.equal(response.result.isError, true, `${name}: ${JSON.stringify(args)}`);
  }
  const noSession = await server.handle(request(++id, "tools/call", {
    name: "windbg_execute_command", arguments: { session_id: "does-not-exist" },
  }));
  assert.equal(noSession.result.isError, true);
});

test("resource parameter errors and missing resources have distinct protocol codes", { skip: !windows }, async () => {
  const server = new McpServer();
  for (const params of [undefined, {}, { uri: 1 }, { uri: "not a URI" }]) {
    const response = await server.handle(request(1, "resources/read", params));
    assert.equal(response.error.code, -32602);
  }
  const missing = await server.handle(request(2, "resources/read", { uri: "windbg://command/__missing_resource__" }));
  assert.equal(missing.error.code, -32002);
});

