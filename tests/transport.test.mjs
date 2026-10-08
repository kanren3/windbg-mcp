import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const windows = process.platform === "win32";
const cdbPath = process.env.WINDBG_MCP_TEST_CDB_PATH;
const nativeDebugger = windows && Boolean(cdbPath);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function client(t) {
  const child = spawn(process.env.WINDBG_MCP_TEST_RUNTIME ?? process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const waiting = new Map();
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      messages.push(message);
      waiting.get(message.id)?.resolve(message);
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      for (const waiter of waiting.values()) waiter.reject(new Error(`Server exited (${code}): ${stderr}`));
      resolve(code);
    });
  });

  function response(id, timeout = 5000) {
    const existing = messages.find((message) => message.id === id);
    if (existing) return Promise.resolve(existing);
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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    return result;
  }

  async function call(name, args = {}, timeout = 5000) {
    const message = await request("tools/call", { name, arguments: args }, timeout);
    assert.equal(message.error, undefined, JSON.stringify(message));
    return message.result;
  }

  async function stop() {
    if (!child.stdin.destroyed) child.stdin.end();
    const timer = setTimeout(() => child.kill(), 20000);
    try { assert.equal(await exited, 0, stderr); }
    finally { clearTimeout(timer); }
  }
  t.after(stop);
  return { child, messages, request, response, call, stop };
}

function payload(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

test("stdio preserves Chinese characters split inside a UTF-8 code point", { skip: !windows }, async (t) => {
  const transport = client(t);
  const id = "测试";
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n");
  const split = bytes.indexOf(Buffer.from("测")) + 1;
  const received = transport.response(id);
  transport.child.stdin.write(bytes.subarray(0, split));
  await delay(50);
  transport.child.stdin.write(bytes.subarray(split));
  assert.equal((await received).id, id);
});

test("EOF flushes accepted pipelined responses and valid notifications produce no response", { skip: !windows }, async (t) => {
  const transport = client(t);
  transport.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "ping" }) + "\n");
  transport.child.stdin.write(JSON.stringify({ jsonrpc: "1.0", id: "invalid", method: "ping" }) + "\n");
  const invalid = transport.response("invalid");
  const ping = transport.request("ping");
  const listed = transport.request("tools/list");
  const guide = transport.request("resources/read", { uri: "windbg://guide/overview" });
  transport.child.stdin.end();
  assert.equal((await invalid).error.code, -32600);
  assert.ok((await ping).result);
  await listed;
  await guide;
  await transport.stop();
  assert.equal(transport.messages.length, 4);
});

test("ping, a different session, and interrupt stay responsive during a pending g", {
  skip: !nativeDebugger,
}, async (t) => {
  const transport = client(t);
  const openArgs = {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cdb_path: cdbPath,
    timeout: 15,
  };
  const first = payload(await transport.call("windbg_open_executable", openArgs, 20000));
  const second = payload(await transport.call("windbg_open_executable", openArgs, 20000));
  // Omitting command before any execution is an actual tool runtime failure.
  const noHistory = await transport.call("windbg_execute_command", { session_id: first.session_id });
  assert.equal(noHistory.isError, true);
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
  assert.equal(budgetExpired.state_after.ready_for_commands, false);
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
  const transport = client(t);
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
  assert.equal(payload(idle.result).state.ready_for_commands, true);
  assert.equal(payload(stop.result).state.ready_for_commands, true);
  assert.equal(payload(run.result).completed, true);
  const collected = payload(await transport.call("windbg_execute_command", {
    session_id, wait_for_completion: false,
  }));
  assert.equal(collected.command, "g");
  assert.equal(collected.completed, true);
  assert.equal(collected.state_after.ready_for_commands, true);
  payload(await transport.call("windbg_close", { session_id }));
});

test("EOF during opening finishes the accepted request before session cleanup", {
  skip: !nativeDebugger,
}, async (t) => {
  const transport = client(t);
  const opening = transport.call("windbg_open_executable", {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cdb_path: cdbPath,
    timeout: 15,
  }, 20000);
  transport.child.stdin.end();
  const session = payload(await opening);
  assert.equal(session.type, "executable");
  assert.ok(session.session_id);
  await transport.stop();
});
