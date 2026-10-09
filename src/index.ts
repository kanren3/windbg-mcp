#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, closeAllSessions, killAllSessionsSync } from "./mcp.js";

class DebuggerTransport extends StdioServerTransport {
  private closing = false;

  override async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await super.close();
    } finally {
      void shutdown();
    }
  }
}

const transport = new DebuggerTransport();
const handle = serveStdio(createMcpServer, {
  transport,
  onerror: (error) => console.error("MCP transport error:", error.message),
});
let closing: Promise<void> | undefined;

function shutdown(): Promise<void> {
  if (closing) return closing;

  // The SDK client may terminate the host two seconds after closing stdin.
  const deadline = setTimeout(() => {
    killAllSessionsSync();
    process.exit();
  }, 1500);
  deadline.unref();
  const sessionsClosed = closeAllSessions();
  closing = (async () => {
    try {
      await handle.close();
      await sessionsClosed;
    } finally {
      killAllSessionsSync();
      clearTimeout(deadline);
    }
  })().catch((error) => {
    console.error("Shutdown error:", error);
    process.exitCode = 1;
  });
  return closing;
}


process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGHUP", () => { void shutdown(); });
process.on("exit", killAllSessionsSync);
