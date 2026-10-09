import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
const cdbPath = process.env.WINDBG_MCP_TEST_CDB_PATH;
const nativeDebugger = windows && Boolean(cdbPath);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function client(t, modern = false) {
  const child = spawn(process.env.WINDBG_MCP_TEST_RUNTIME ?? process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.resolve(message);
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      for (const waiter of [...waiting.values()]) waiter.reject(new Error(`Server exited (${code}): ${stderr}`));
      resolve(code);
    });
  });

  function response(id, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Timed out awaiting response ${id}: ${stderr}`));
      }, timeout);
      waiting.set(id, {
        resolve: (message) => { clearTimeout(timer); waiting.delete(id); resolve(message); },
        reject: (error) => { clearTimeout(timer); waiting.delete(id); reject(error); },
      });
    });
  }

  function request(method, params, timeout = 5000) {
    const id = ++nextId;
    const result = response(id, timeout);
    const input = modern ? { _meta: meta, ...params } : params;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(input === undefined ? {} : { params: input }) }) + "\n");
    return result;
  }

  async function call(name, args = {}, timeout = 5000) {
    const message = await request("tools/call", { name, arguments: args }, timeout);
    assert.equal(message.error, undefined, JSON.stringify(message));
    return message.result;
  }

  async function stop() {
    if (!child.stdin.destroyed) child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    try { assert.equal(await exited, 0, stderr); }
    finally { clearTimeout(timer); }
  }
  t.after(stop);
  if (modern) {
    const discovered = await request("server/discover", {});
    assert.equal(discovered.error, undefined);
  } else {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "windbg-transport-tests", version: "1.0.0" },
    });
    assert.equal(initialized.error, undefined);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  return { child, request, response, call, stop, meta };
}

function payload(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

test("stdio preserves Chinese characters split inside a UTF-8 code point", { skip: !windows }, async (t) => {
  const transport = await client(t);
  const id = "测试";
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n");
  const split = bytes.indexOf(Buffer.from("测")) + 1;
  const received = transport.response(id);
  transport.child.stdin.write(bytes.subarray(0, split));
  await delay(50);
  transport.child.stdin.write(bytes.subarray(split));
  assert.equal((await received).id, id);
});

test("modern requests reject invalid version metadata without losing a usable connection", { skip: !windows }, async (t) => {
  const transport = await client(t, true);
  const args = { name: "windbg_search_commands", arguments: { query: "!analyze", limit: 1 } };
  const unsupported = await transport.request("tools/call", {
    ...args, _meta: { ...transport.meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
  });
  assert.equal(unsupported.error.code, -32022);
  assert.equal(unsupported.error.data.requested, "1900-01-01");
  const malformed = await transport.request("tools/call", {
    ...args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
  });
  assert.equal(malformed.error.code, -32602);
  const result = payload(await transport.call(args.name, args.arguments));
  assert.deepEqual(result.results[0].tokens, ["!analyze"]);
  await transport.stop();
});

test("a discovery probe can fall back to a legacy connection without shutting down", { skip: !windows }, async (t) => {
  const transport = await client(t, true);
  const initialized = await transport.request("initialize", {
    _meta: undefined, protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "legacy-fallback-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  transport.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const response = await transport.request("tools/call", {
    _meta: undefined, name: "windbg_search_commands", arguments: { query: "!analyze", limit: 1 },
  });
  assert.deepEqual(payload(response.result).results[0].tokens, ["!analyze"]);
});

test("ping, a different session, and interrupt stay responsive during a pending g", {
  skip: !nativeDebugger,
}, async (t) => {
  const transport = await client(t);
  const openArgs = {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cdb_path: cdbPath,
    timeout: 15,
  };
  const first = payload(await transport.call("windbg_open_executable", openArgs, 20000));
  const second = payload(await transport.call("windbg_open_executable", openArgs, 20000));
  for (const [name, args] of [
    ["windbg_close", {}],
    ["windbg_detach", {}],
    ["windbg_interrupt_target", {}],
    ["windbg_execute_command", { command: ".echo WRONG-SESSION" }],
  ]) {
    const rejected = await transport.call(name, args);
    assert.equal(rejected.isError, true, name);
  }
  const intact = payload(await transport.call("windbg_sessions"));
  assert.deepEqual(intact.sessions.map((session) => session.session_id), [first.session_id, second.session_id]);
  assert.ok(intact.sessions.every((session) => session.state === "ready"));
  // Omitting command before any execution is an actual tool runtime failure.
  const noHistory = await transport.call("windbg_execute_command", { session_id: first.session_id });
  assert.equal(noHistory.isError, true);
  for (const opened of [first, second]) {
    const result = payload(await transport.call("windbg_execute_command", {
      session_id: opened.session_id, command: `.echo INTACT-${opened.session_id}`,
    }));
    assert.equal(result.completed, true);
    assert.equal(result.output, `INTACT-${opened.session_id}`);
  }
  const badSession = await transport.call("windbg_close", { session_id: "does-not-exist" });
  assert.equal(badSession.isError, true);
  const emptySession = await transport.call("windbg_close", { session_id: "" });
  assert.equal(emptySession.isError, true);
  const sessions = payload(await transport.call("windbg_sessions"));
  assert.deepEqual(sessions.sessions.map((session) => session.session_id), [first.session_id, second.session_id]);

  let runningSettled = false;
  const running = transport.call("windbg_execute_command", {
    session_id: first.session_id, command: "g", timeout: 8,
  }, 12000).finally(() => { runningSettled = true; });
  // Attach a rejection handler immediately so a failing assertion cannot leave
  // an unobserved request promise while the teardown drains the real server.
  void running.catch(() => {});
  await delay(100);
  const ping = transport.request("ping", undefined, 2000);
  const other = transport.call("windbg_execute_command", {
    session_id: second.session_id, command: ".echo independent-session", timeout: 2,
  }, 3000);
  const [pingResponse, otherResponse] = await Promise.all([ping, other]);
  assert.ok(pingResponse.result);
  const otherResult = payload(otherResponse);
  assert.equal(otherResult.completed, true);
  assert.match(otherResult.output, /independent-session/);
  const pendingSnapshot = payload(await transport.call("windbg_execute_command", {
    session_id: first.session_id, wait_for_completion: false,
  }, 12000));
  const originalWaitStillPending = !runningSettled;
  payload(await transport.call("windbg_interrupt_target", { session_id: first.session_id }, 3000));
  assert.equal(payload(await running).completed, true);
  assert.equal(originalWaitStillPending, true);
  assert.equal(pendingSnapshot.command, "g");
  assert.equal(pendingSnapshot.completed, false);
  const collected = payload(await transport.call("windbg_execute_command", {
    session_id: first.session_id, wait_for_completion: false,
  }));
  assert.equal(collected.command, "g");
  assert.equal(collected.completed, true);
  const resumed = payload(await transport.call("windbg_execute_command", {
    session_id: first.session_id, command: "g", wait_for_completion: false,
  }));
  assert.equal(resumed.completed, false);
  const budgetExpired = payload(await transport.call("windbg_execute_command", {
    session_id: first.session_id, timeout: 0.05,
  }));
  assert.equal(budgetExpired.command, "g");
  assert.equal(budgetExpired.completed, false);
  assert.equal(budgetExpired.state, "busy");
  payload(await transport.call("windbg_interrupt_target", { session_id: first.session_id }, 3000));
  const finished = payload(await transport.call("windbg_execute_command", {
    session_id: first.session_id, timeout: 2,
  }));
  assert.equal(finished.completed, true);
  payload(await transport.call("windbg_close", { session_id: first.session_id }));
  payload(await transport.call("windbg_close", { session_id: second.session_id }));
});

test("one stdin batch keeps idle interrupt, g, and its interrupt distinct", {
  skip: !nativeDebugger,
}, async (t) => {
  const transport = await client(t);
  const opened = payload(await transport.call("windbg_open_executable", {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cdb_path: cdbPath,
    timeout: 15,
  }, 20000));
  const session_id = opened.session_id;
  assert.equal(payload(await transport.call("windbg_execute_command", {
    session_id, command: "? 1+1",
  })).completed, true);
  const ids = ["batch-idle", "batch-run", "batch-stop"];
  const responses = ids.map((id) => transport.response(id, 10000));
  for (const response of responses) void response.catch(() => {});
  transport.child.stdin.write([
    { jsonrpc: "2.0", id: ids[0], method: "tools/call", params: {
      name: "windbg_interrupt_target", arguments: { session_id },
    } },
    { jsonrpc: "2.0", id: ids[1], method: "tools/call", params: {
      name: "windbg_execute_command", arguments: { session_id, command: "g", timeout: 2 },
    } },
    { jsonrpc: "2.0", id: ids[2], method: "tools/call", params: {
      name: "windbg_interrupt_target", arguments: { session_id },
    } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n");
  const [idle, run, stop] = await Promise.all(responses);
  assert.equal(payload(idle.result).state, "ready");
  assert.equal(payload(stop.result).state, "ready");
  assert.equal(payload(run.result).completed, true);
  const collected = payload(await transport.call("windbg_execute_command", {
    session_id, wait_for_completion: false,
  }));
  assert.equal(collected.command, "g");
  assert.equal(collected.completed, true);
  assert.equal(collected.state, "ready");
  payload(await transport.call("windbg_close", { session_id }));
});

test("EOF during a pending command closes the debugger and its owned target", {
  skip: !nativeDebugger, timeout: 30000,
}, async (t) => {
  const transport = await client(t, true);
  const directory = mkdtempSync(join(tmpdir(), "windbg-mcp-disconnect-"));
  const path = join(directory, "target.json");
  let owned;
  t.after(() => {
    if (owned) {
      for (const pid of [owned.target, owned.debugger]) {
        try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const script = `const fs = require('node:fs'); const path = ${JSON.stringify(path)}; fs.writeFileSync(path + '.tmp', JSON.stringify({target:process.pid,debugger:process.ppid})); fs.renameSync(path + '.tmp', path); setInterval(() => {}, 1000);`;
  const opened = payload(await transport.call("windbg_open_executable", {
    executable: process.execPath, args: ["-e", script], cdb_path: cdbPath,
    symbols_path: process.env.SystemRoot, timeout: 5,
  }, 10000));
  const running = transport.call("windbg_execute_command", {
    session_id: opened.session_id, command: "g", timeout: 10,
  }, 15000);
  void running.catch(() => {});
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) await delay(25);
  owned = JSON.parse(readFileSync(path, "utf8"));
  process.kill(owned.target, 0);
  process.kill(owned.debugger, 0);
  const rejected = assert.rejects(running);
  await transport.stop();
  await rejected;
  for (const pid of [owned.target, owned.debugger]) {
    const deadline = Date.now() + 2000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); await delay(25); }
      catch (error) { assert.equal(error.code, "ESRCH"); alive = false; }
    }
    assert.equal(alive, false, `Owned process ${pid} survived disconnect`);
  }
});

test("eight-session capacity includes an opening session and releases failed opening slots", {
  skip: !nativeDebugger, timeout: 120000,
}, async (t) => {
  const transport = await client(t);
  const directory = mkdtempSync(join(tmpdir(), "windbg-mcp-capacity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const openArgs = {
    executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    cdb_path: cdbPath, symbols_path: process.env.SystemRoot, timeout: 10,
  };
  const opened = [];
  for (let i = 0; i < 7; i++) {
    opened.push(payload(await transport.call("windbg_open_executable", openArgs, 15000)));
  }
  // One stdin write dispatches both opens before a native startup prompt can
  // finish the eighth one. A broken limit can create at most two extra targets.
  const openingId = "capacity-opening";
  const rejectedId = "capacity-overflow";
  let openingSettled = false;
  const opening = transport.response(openingId, 15000).finally(() => { openingSettled = true; });
  const overflow = transport.response(rejectedId, 15000);
  void opening.catch(() => {});
  void overflow.catch(() => {});
  transport.child.stdin.write([openingId, rejectedId].map((id) => JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "windbg_open_executable", arguments: openArgs,
    },
  })).join("\n") + "\n");
  const refused = await overflow;
  assert.equal(refused.error, undefined);
  assert.equal(refused.result.isError, true);
  assert.equal(openingSettled, false, "Overflow must be rejected while the eighth session is still opening");
  const started = await opening;
  assert.equal(started.error, undefined);
  opened.push(payload(started.result));
  const full = payload(await transport.call("windbg_sessions"));
  assert.deepEqual(full.sessions.map((session) => session.session_id), opened.map((session) => session.session_id));
  assert.equal(full.sessions.length, 8);
  assert.equal((await transport.call("windbg_open_executable", openArgs)).isError, true);

  const released = opened.pop();
  payload(await transport.call("windbg_close", { session_id: released.session_id }));
  const failed = await transport.call("windbg_open_executable", {
    ...openArgs, executable: join(directory, "missing-owned-target.exe"), timeout: 2,
  }, 7000);
  assert.equal(failed.isError, true);
  opened.push(payload(await transport.call("windbg_open_executable", openArgs, 15000)));
  const restored = payload(await transport.call("windbg_sessions"));
  assert.equal(restored.sessions.length, 8);
  assert.deepEqual(restored.sessions.map((session) => session.session_id), opened.map((session) => session.session_id));
  for (const selected of [opened[0], opened.at(-1)]) {
    const result = payload(await transport.call("windbg_execute_command", {
      session_id: selected.session_id, command: ".echo CAPACITY-SESSION-ALIVE", timeout: 2,
    }, 5000));
    assert.equal(result.output, "CAPACITY-SESSION-ALIVE");
    assert.equal(result.completed, true);
  }
  for (const session of opened) {
    payload(await transport.call("windbg_close", { session_id: session.session_id }));
  }
  assert.deepEqual(payload(await transport.call("windbg_sessions")).sessions, []);
});
