#!/usr/bin/env node
/**
 * Newline-delimited UTF-8 JSON-RPC over stdio. Requests dispatch concurrently;
 * each debugger session serializes its own writes so interrupt and ping remain
 * responsive. EOF drains accepted requests before closing debugger children.
 */

import { McpServer, closeAllSessions, killAllSessionsSync } from "./mcp.js";

async function main(): Promise<void> {
  const server = new McpServer();
  const stdin = process.stdin;
  const stdout = process.stdout;
  const inFlight = new Set<Promise<void>>();
  let buffer = "";
  let accepting = true;
  let finishing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  function shutdown(exitCode = 0, signal = false): Promise<void> {
    accepting = false;
    stdin.pause();
    // A signal may interrupt requests; EOF must first finish accepted input.
    if (signal && !closing) closing = closeAllSessions();
    if (finishing) return finishing;
    finishing = (async () => {
      await Promise.allSettled([...inFlight]);
      await (closing ?? closeAllSessions());
      // Flush every response before exiting; process.exit alone can lose writes.
      await new Promise<void>((resolve) => stdout.end(resolve));
      process.exit(exitCode);
    })();
    return finishing;
  }

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    if (!accepting) return;
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const pending = dispatch(server, line, stdout).catch((err) => {
        console.error("Fatal dispatch error:", err);
        void shutdown(1);
      });
      inFlight.add(pending);
      void pending.then(() => inFlight.delete(pending));
    }
  });

  stdin.on("end", () => { void shutdown(); });
  stdin.on("close", () => { void shutdown(); });
  stdin.on("error", (err) => {
    console.error("stdin error:", err);
    void shutdown(1, true);
  });
  process.on("SIGINT", () => { void shutdown(0, true); });
  process.on("SIGTERM", () => { void shutdown(0, true); });
  process.on("SIGHUP", () => { void shutdown(0, true); });
}

async function dispatch(server: McpServer, line: string, stdout: NodeJS.WriteStream): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }) + "\n");
    return;
  }

  const result = await server.handle(request);
  if (result !== null) stdout.write(JSON.stringify(result) + "\n");
}

// The synchronous fallback includes sessions still waiting for their first prompt.
process.on("exit", killAllSessionsSync);

main().catch((err) => {
  console.error("Fatal error:", err);
  killAllSessionsSync();
  process.exit(1);
});
