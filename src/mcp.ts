import { McpServer, ResourceNotFoundError, ResourceTemplate, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { Catalog, TEMPLATE_URI } from "./catalog.js";
import { renderCommand, renderGuide, GUIDE_URI } from "./resources.js";
import { DEFAULT_OUTPUT_PAGE_BYTES, MAX_OUTPUT_PAGE_BYTES } from "./command_output.js";
import { MAX_COMMAND_LENGTH, MAX_COMMAND_LINE_LENGTH } from "./command_policy.js";
import {
  type DebuggerSession,
  createCdbExecutableSession,
  createCdbDumpSession,
  createCdbAttachSession,
  createKdSession,
} from "./session.js";

const SERVER_NAME = "windbg-mcp";
const SERVER_VERSION = "0.2.0";
const MAX_SESSIONS = 8;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATING = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const SERVER_INSTRUCTIONS = `WinDbg MCP server: drives cdb.exe (user mode) and kd.exe (kernel).

## Choose a tool by task
- Analyze a crash dump (.dmp/.mdmp) → windbg_open_dump, then windbg_execute_command with "!analyze -v"
- Debug a running process → windbg_attach_process (by pid or name)
- Start a new process under the debugger → windbg_open_executable
- Debug a kernel target (VM, test machine) → windbg_attach_kernel with a connection string
- Check debugger state → windbg_sessions (look for state="ready")
- Need a prompt while a command is pending → windbg_interrupt_target (also cancels dump commands)
- Run a debugger command → windbg_execute_command with an explicit session_id; CDB/KD determines applicability in the current context
- Collect output → omit command; use command_id and next_output_offset to fetch subsequent pages before starting another command
- Commands are not semantically filtered. Preserve debugger input and completion-marker output; timeouts do not confirm completion or cancel execution
- Unsure of the exact command → windbg_search_commands with a keyword
- End session, kill debuggee → windbg_close
- End session, keep debuggee running → windbg_detach

## After opening a session
1. Set symbols: windbg_execute_command with ".symfix" then ".reload"
2. For dumps: windbg_execute_command with "!analyze -v" first
3. For live targets: windbg_execute_command with "kb" for stack trace

## Resources
- windbg://guide/overview — full workflow guide
- windbg://command/{id} — full command documentation (several KB each; when the client supports subagents, run search + read + synthesis in a subagent to keep the main context lean)`;

interface SessionRecord {
  id: string;
  type: "executable" | "dump" | "process" | "kernel";
  session: DebuggerSession;
}

let sessionCounter = 0;
let shuttingDown = false;
const sessions = new Map<string, SessionRecord>();
// Factories spawn before start() has received the first prompt.
const openingSessions = new Set<DebuggerSession>();

export async function closeAllSessions(): Promise<void> {
  shuttingDown = true;
  const opening = [...openingSessions];
  openingSessions.clear();
  for (const session of opening) {
    try { session.killSync(); } catch { /* Keep closing registered sessions. */ }
  }
  await Promise.allSettled([...sessions.values()].map(async (rec) => {
    await rec.session.close();
    if (rec.session.outputCleanupError) console.error("Temporary output cleanup:", rec.session.outputCleanupError);
    sessions.delete(rec.id);
  }));
  // Failed closes stay registered for forced termination during shutdown.
}

export function killAllSessionsSync(): void {
  shuttingDown = true;
  const all = [...sessions.values()].map((rec) => rec.session).concat([...openingSessions]);
  openingSessions.clear();
  for (const session of all) {
    try { session.killSync(); } catch { /* Continue cleaning up other sessions. */ }
  }
  sessions.clear();
}

function discardExitedSessions(): void {
  for (const [id, rec] of sessions) {
    if (rec.session.exited) {
      sessions.delete(id);
      rec.session.killSync();
    }
  }
}

async function startSession(
  create: () => DebuggerSession,
  type: SessionRecord["type"],
  target?: string,
): Promise<CallToolResult> {
  // SDK argument validation can finish after the transport has disconnected.
  if (shuttingDown) throw new Error("Server is shutting down");
  discardExitedSessions();
  if (sessions.size + openingSessions.size >= MAX_SESSIONS) {
    throw new Error(`Session limit reached (${MAX_SESSIONS}, including sessions still opening). Close or detach a session first.`);
  }
  const session = create();
  openingSessions.add(session);
  try {
    await session.start();
    const state = await session.queryState();
    if (!openingSessions.has(session)) throw new Error("Server is shutting down");
    const id = (++sessionCounter).toString(16).padStart(8, "0");
    sessions.set(id, { id, type, session });
    return toolResult({ session_id: id, kind: session.kind, type, target: target ?? session.target, ...state });
  } catch (error) {
    session.killSync();
    throw error;
  } finally {
    openingSessions.delete(session);
  }
}

function requireSession(sessionId: string): SessionRecord {
  if (shuttingDown) throw new Error("Server is shutting down");
  discardExitedSessions();
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error("No matching debug session. Use windbg_sessions to list open sessions.");
  return rec;
}

function toolResult(data: object, structured = false, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    isError,
    ...(structured ? { structuredContent: data } : {}),
  };
}

const nonEmptyString = z.string().regex(/\S/, "Must contain a non-whitespace character");
const sessionIdSchema = nonEmptyString.describe("Required session id returned by an open/attach tool or windbg_sessions");
const timeoutSchema = z.number().positive().optional().describe("Positive waiting budget in seconds (default 60); expiry does not cancel a command");
const cdbPathSchema = z.string().optional().describe("Custom cdb.exe path (auto-detected if omitted)");
const symbolsPathSchema = z.string().optional().describe("Symbol search path (-y)");
const stateSchema = z.enum(["ready", "busy", "unavailable", "closing", "exited"])
  .describe("Debugger process and command-channel state, not target execution state");

export function createMcpServer(): McpServer {
  const catalog = Catalog.load();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: SERVER_INSTRUCTIONS,
    cacheHints: { "server/discover": { ttlMs: 3600000, cacheScope: "public" } },
  });

  server.registerTool("windbg_open_executable", {
    title: "Start and debug an executable",
    description: "Launch a process under cdb.exe. Returns a session_id. windbg_close terminates the debuggee; windbg_detach lets it keep running. Set symbols with .symfix and .reload, then use g with wait_for_completion:false or set breakpoints first.",
    annotations: MUTATING,
    inputSchema: z.object({
      executable: nonEmptyString.describe("Path to the executable to debug"),
      args: z.array(z.string()).optional().describe("Command-line arguments for the debuggee"),
      cdb_path: cdbPathSchema,
      symbols_path: symbolsPathSchema,
      timeout: timeoutSchema,
    }),
  }, (args) => startSession(() => createCdbExecutableSession(args.executable, args.args ?? [], {
    cdbPath: args.cdb_path, symbolsPath: args.symbols_path, timeout: args.timeout,
  }), "executable"));

  server.registerTool("windbg_open_dump", {
    title: "Open a crash dump",
    description: "Open a crash dump (.dmp/.mdmp/.hdmp) for analysis. Returns a session_id. Set symbols with .symfix and .reload, then run !analyze -v. The target is static, but a long debugger command can still be interrupted.",
    annotations: { ...MUTATING, destructiveHint: false },
    inputSchema: z.object({
      dump_path: nonEmptyString.describe("Path to the crash dump file"),
      cdb_path: cdbPathSchema,
      symbols_path: symbolsPathSchema,
      timeout: timeoutSchema,
    }),
  }, (args) => startSession(() => createCdbDumpSession(args.dump_path, {
    cdbPath: args.cdb_path, symbolsPath: args.symbols_path, timeout: args.timeout,
  }), "dump"));

  server.registerTool("windbg_close", {
    title: "Close a debug session",
    description: "Close the debugger process: request q, then force termination if cooperative shutdown fails. Closing a user-mode debugger can terminate its targets. Use windbg_detach when the debugger must detach rather than be forcibly terminated.",
    annotations: MUTATING,
    inputSchema: z.object({ session_id: sessionIdSchema }),
  }, async ({ session_id }) => {
    const rec = requireSession(session_id);
    await rec.session.close();
    sessions.delete(rec.id);
    return toolResult({
      closed: rec.id, type: rec.type, target: rec.session.target,
      ...(rec.session.outputCleanupError ? { output_cleanup_error: rec.session.outputCleanupError } : {}),
    });
  });

  server.registerTool("windbg_attach_process", {
    title: "Attach to a running process",
    description: "Attach cdb.exe to a running user-mode process by pid or name, but not both. Returns a session_id and breaks into the target. Set symbols, then use kb or dv. Use windbg_detach to leave the process running.",
    annotations: MUTATING,
    inputSchema: z.object({
      pid: z.number().int().positive().optional().describe("Decimal process ID (-p)"),
      name: nonEmptyString.optional().describe("Process name (-pn), e.g. notepad.exe"),
      cdb_path: cdbPathSchema,
      symbols_path: symbolsPathSchema,
      timeout: timeoutSchema,
    }).refine((args) => (args.pid !== undefined) !== (args.name !== undefined), {
      message: "Provide exactly one of pid or name",
    }),
  }, (args) => startSession(() => createCdbAttachSession(args.pid === undefined ? args.name! : String(args.pid), {
    cdbPath: args.cdb_path, symbolsPath: args.symbols_path, timeout: args.timeout,
  }), "process"));

  server.registerTool("windbg_attach_kernel", {
    title: "Attach to a kernel target",
    description: "Attach kd.exe to a target booted with debugging enabled. Returns a session_id. Connections: net:port=50000,key=1.2.3.4 (port defaults to 50000), com:pipe,port=\\\\.\\pipe\\com_1,baud=115200,reconnect,resets=0, or com:port=COM1,baud=115200. Set symbols, then use kb or !process 0 0.",
    annotations: MUTATING,
    inputSchema: z.object({
      kernel_connection: nonEmptyString.describe("Kernel connection string (-k)"),
      kd_path: z.string().optional().describe("Custom kd.exe path (auto-detected if omitted)"),
      symbols_path: symbolsPathSchema,
      timeout: timeoutSchema,
    }),
  }, (args) => startSession(() => createKdSession(args.kernel_connection, {
    kdPath: args.kd_path, symbolsPath: args.symbols_path, timeout: args.timeout,
  }), "kernel", args.kernel_connection));

  server.registerTool("windbg_detach", {
    title: "Detach from a debug session",
    description: "Send qd (quit and detach) to the current debugger context and wait for debugger exit. Intended to leave live user-mode or kernel-mode targets running. CDB/KD determines applicability; an unsuccessful detach leaves the session available for recovery.",
    annotations: { ...MUTATING, destructiveHint: false },
    inputSchema: z.object({ session_id: sessionIdSchema }),
  }, async ({ session_id }) => {
    const rec = requireSession(session_id);
    await rec.session.detach();
    sessions.delete(rec.id);
    return toolResult({
      detached: rec.id, type: rec.type, target: rec.session.target,
      ...(rec.session.outputCleanupError ? { output_cleanup_error: rec.session.outputCleanupError } : {}),
    });
  });

  server.registerTool("windbg_sessions", {
    title: "List active debug sessions",
    description: "List active sessions with their initial type and target, plus current debugger process and command-channel state. Commands may change targets; type and target are not a live target inventory. A new command requires state=ready. Busy means a command is pending, not that the target is running. Unavailable means readiness is unconfirmed or I/O failed; error carries I/O details. Exited debuggers are removed from this list. Collect output with windbg_execute_command without command, or interrupt with windbg_interrupt_target.",
    annotations: READ_ONLY,
    inputSchema: z.object({}),
    outputSchema: z.object({
      sessions: z.array(z.object({
        session_id: z.string(),
        created_at: z.string(),
        type: z.enum(["executable", "dump", "process", "kernel"]).describe("How the session was initially opened"),
        kind: z.enum(["cdb", "kd"]),
        target: z.string().describe("Initial target description; commands may change the active targets"),
        state: stateSchema,
        error: z.string().optional(),
      })),
    }),
  }, async () => {
    discardExitedSessions();
    const list = [];
    for (const rec of sessions.values()) {
      list.push({
        session_id: rec.id,
        created_at: new Date(rec.session.createdAt).toISOString(),
        type: rec.type,
        kind: rec.session.kind,
        target: rec.session.target,
        ...await rec.session.queryState(),
      });
    }
    return toolResult({ sessions: list }, true);
  });

  server.registerTool("windbg_interrupt_target", {
    title: "Interrupt a target or debugger command",
    description: "Send CTRL+BREAK and wait for a confirmed command prompt. Stops a live target or cancels a debugger command, including dump commands. On failure the session remains available for recovery. Collect command output afterward with windbg_execute_command without command.",
    annotations: MUTATING,
    inputSchema: z.object({ session_id: sessionIdSchema }),
  }, async ({ session_id }) => {
    const rec = requireSession(session_id);
    return toolResult({ session_id: rec.id, ...await rec.session.interrupt() });
  });

  server.registerTool("windbg_execute_command", {
    title: "Execute a debugger command",
    description: "Send debugger command text to CDB/KD without semantic filtering, or omit command to collect captured output. The debugger determines applicability and reports command errors in its output. Results are paginated UTF-8 text: use command_id and next_output_offset while has_more_output is true. Drain pages before starting another command, which expires previous output. completed:true means the private completion marker was observed; timeout does not cancel execution. state reports the current debugger process and command channel. An observed debugger exit returns state=exited and captured output; it does not imply command success. Exit removes the session and its output, so the final response is the last available page. I/O and output storage failures remain tool errors. Use wait_for_completion:false for g. Commands, scripts and extensions must preserve debugger input and completion-marker output. Lifecycle tools are convenient alternatives, not mandatory command routes.",
    annotations: MUTATING,
    inputSchema: z.object({
      command: nonEmptyString.max(MAX_COMMAND_LENGTH).regex(/^[\x09\x0a\x0d\x20-\x7e]+$/, "Use ASCII debugger command text; Unicode paths belong in tool parameters").optional().describe(`ASCII command text, up to ${MAX_COMMAND_LENGTH} characters and ${MAX_COMMAND_LINE_LENGTH} per line; blank lines are ignored. Omit to collect output.`),
      session_id: sessionIdSchema,
      timeout: timeoutSchema,
      wait_for_completion: z.boolean().default(true).describe("Wait within timeout; false returns an immediate cumulative snapshot"),
      command_id: nonEmptyString.optional().describe("Output identity returned by execute; required when continuing a page"),
      output_offset: z.number().int().nonnegative().optional().describe("UTF-8 byte offset from next_output_offset; collect calls only"),
      max_output_bytes: z.number().int().min(4).max(MAX_OUTPUT_PAGE_BYTES).optional().describe(`Page byte budget (default ${DEFAULT_OUTPUT_PAGE_BYTES}, maximum ${MAX_OUTPUT_PAGE_BYTES})`),
    }),
    outputSchema: z.object({
      command: z.string(),
      command_id: z.string(),
      output: z.string(),
      output_offset: z.number().int().nonnegative(),
      next_output_offset: z.number().int().nonnegative(),
      total_output_bytes: z.number().int().nonnegative(),
      has_more_output: z.boolean(),
      output_error: z.string().optional(),
      completed: z.boolean(),
      state: stateSchema,
      error: z.string().optional(),
    }),
  }, async ({ session_id, command, timeout, wait_for_completion, command_id, output_offset, max_output_bytes }) => {
    const rec = requireSession(session_id);
    try {
      const result = await rec.session.execute(command, timeout, wait_for_completion, { command_id, output_offset, max_output_bytes });
      return toolResult(result, true, result.error !== undefined || result.output_error !== undefined);
    } finally {
      if (rec.session.exited) {
        sessions.delete(rec.id);
        rec.session.killSync();
      }
    }
  });

  server.registerTool("windbg_search_commands", {
    title: "Search WinDbg command reference",
    description: "Search the WinDbg/KD command catalog by keyword. Returns commands with summaries and resource URIs for the full documentation.",
    annotations: READ_ONLY,
    inputSchema: z.object({
      query: nonEmptyString.describe("Search query, e.g. breakpoint, stack trace, dt or .sympath"),
      limit: z.number().int().positive().optional().describe("Maximum results (default 10)"),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        id: z.string(),
        title: z.string(),
        tokens: z.array(z.string()),
        summary: z.string(),
        resource: z.string(),
      })),
    }),
  }, ({ query, limit }) => {
    const results = catalog.search(query.trim(), limit ?? 10).map((entry) => ({
      id: entry.id,
      title: entry.title,
      tokens: entry.tokens,
      summary: entry.summary,
      resource: `windbg://command/${entry.id}`,
    }));
    return toolResult({ results }, true);
  });

  server.registerResource("windbg guide", GUIDE_URI, {
    title: "WinDbg MCP guide",
    description: "Workflow for mapping debugger requests to tools and command resources",
    mimeType: "text/plain",
  }, (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: renderGuide(catalog) }],
  }));

  server.registerResource("windbg command page", new ResourceTemplate(TEMPLATE_URI, { list: undefined }), {
    title: "WinDbg command page",
    description: "Full debugger command topic by catalog id",
    mimeType: "text/plain",
  }, (uri) => {
    const entry = catalog.resolveResourceUri(uri.href);
    if (!entry) throw new ResourceNotFoundError(uri.href);
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: renderCommand(entry) }] };
  });

  return server;
}
