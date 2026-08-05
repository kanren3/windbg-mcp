#!/usr/bin/env bun
/**
 * windbg-mcp — stdio MCP server entry point.
 *
 * Reads newline-delimited JSON-RPC 2.0 from stdin, dispatches to McpServer,
 * writes responses to stdout. Exits when stdin closes (EOF).
 *
 * Requests are serialized: each dispatch is chained onto the previous one so
 * concurrent pipelined requests can't interleave and corrupt the session
 * marker protocol.
 *
 * On exit, closes all debug sessions so no kd/cdb child processes are leaked.
 */

import { McpServer, closeAllSessions, killAllSessionsSync } from "./mcp.ts";

async function main(): Promise<void> {
  const server = new McpServer();
  const stdin = process.stdin;
  const stdout = process.stdout;

  // Don't let stdout buffer — MCP messages must be line-delimited.
  stdout.setDefaultEncoding("utf-8");

  let buffer = "";
  // Serialize dispatches: each request waits for the previous one to settle.
  let tail: Promise<void> = Promise.resolve();

  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      tail = tail.then(() => dispatch(server, line, stdout));
    }
  });

  stdin.on("end", () => {
    // Wait for in-flight dispatches to settle before exiting.
    void tail.finally(() => process.exit(0));
  });

  stdin.on("close", () => {
    void tail.finally(() => process.exit(0));
  });
}

async function dispatch(server: McpServer, line: string, stdout: NodeJS.WriteStream): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    // JSON-RPC 2.0: parse errors get a -32700 response with id: null.
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }) + "\n");
    return;
  }

  const result = await server.handle(request);
  if (result === null) return; // notification, no response

  stdout.write(JSON.stringify(result) + "\n");
}

// Clean up debug sessions on every exit path: no leaked kd/cdb children.
let cleaning = false;
async function shutdown(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  try {
    await closeAllSessions();
  } catch { /* best effort */ }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.on("exit", () => {
  // Synchronous exit path: can't await, so just kill every debugger child.
  killAllSessionsSync();
});

main().catch((err) => {
  console.error("Fatal error:", err);
  void closeAllSessions().finally(() => process.exit(1));
});
