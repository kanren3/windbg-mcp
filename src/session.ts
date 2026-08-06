/**
 * Debug session — subprocess management for cdb.exe / kd.exe.
 *
 * Combines the marker protocol from svnscha/mcp-windbg (per-command completion
 * markers on stdout) with the GenerateConsoleCtrlEvent break-in mechanism
 * verified to work from Bun via bun:ffi.
 *
 * Design:
 * - cdb/kd is spawned via spawnWin32 with CREATE_NEW_PROCESS_GROUP (no
 *   DETACHED_PROCESS) so the child gets a new process group but keeps a
 *   console, making GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT) effective.
 * - Every command is followed by `.echo MARKER_N`; the 50ms poll loop
 *   completes only on the exact marker the current command is waiting for.
 * - On timeout, CTRL+BREAK is sent and the session is resynchronized.
 * - Execution state is inferred from the prompt pattern and the presence of
 *   an outstanding marker — there is no DbgEng COM, so state is approximated
 *   from the text protocol.
 */

import { spawnWin32, type Win32Process } from "./spawn_win32.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_BASE = "COMMAND_COMPLETED_MARKER";

/** Prompt regex: matches `0:000>` (cdb), `3: kd>` (kd), `0: kd>` etc. */
const PROMPT_RE = /\d+:\s*(?:\d+|kd)>\s*$/;

// Debug execution status constants (mirror DEBUG_STATUS_* from dbgeng)
const DEBUG_STATUS_BREAK = 6;
const DEBUG_STATUS_NO_DEBUGGEE = 7;
const DEBUG_STATUS_GO = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebuggerExecutionState {
  raw_status: number;
  status_name: string;
  running: boolean;
  busy: boolean;
  ready_for_commands: boolean;
  requires_interrupt_before_command: boolean;
  summary: string;
}

export interface CommandExecutionResult {
  command: string;
  output: string;
  state_before: DebuggerExecutionState;
  state_after: DebuggerExecutionState;
}

export type SessionKind = "cdb" | "kd";

export interface SessionOptions {
  /** Path to cdb.exe or kd.exe */
  debuggerPath: string;
  /** Full launch args (including the debugger path at [0]) */
  launchArgs: string[];
  /** Seconds to wait for the debugger to become ready (default 60) */
  timeout: number;
  /** Whether this is a live (running target) session — enables CTRL+BREAK */
  isLiveSession: boolean;
  /** Human-readable target description (executable, dump path, pid, kernel string) */
  target: string;
}

// ---------------------------------------------------------------------------
// DebuggerSession
// ---------------------------------------------------------------------------

export class DebuggerSession {
  kind: SessionKind;
  /** Human-readable target description, shown by windbg_sessions. */
  target: string;
  /** Epoch-ms timestamp of session creation. */
  createdAt: number;
  private process: Win32Process;
  private isLiveSession: boolean;
  private timeout: number;

  private outputBuffer: string[] = [];
  private _markerSeq = 0;
  private _expectedMarker: string | null = null;
  private _ready = false;
  private _readyResolvers: ((value: boolean) => void)[] = [];
  private _atPrompt = false;
  private _hasDebuggee = true;
  private _stdoutBuffer = "";
  private _connectedToTarget = false;
  private _connectedToTargetResolvers: ((value: boolean) => void)[] = [];

  private _readTimer: ReturnType<typeof setInterval> | null = null;

  constructor(kind: SessionKind, opts: SessionOptions) {
    this.kind = kind;
    this.isLiveSession = opts.isLiveSession;
    this.timeout = opts.timeout;
    this.target = opts.target;
    this.createdAt = Date.now();

    // Build command line per CreateProcessW quoting rules:
    // - wrap in double quotes if the arg contains spaces or is empty
    // - escape literal backslashes before a quote, and literal quotes
    const cmdLine = opts.launchArgs
      .map((a) => {
        if (!a.includes(" ") && !a.includes('"') && a.length > 0) return a;
        // Escape: backslashes before a closing quote or end-of-string are doubled;
        // literal quotes are backslash-escaped.
        const escaped = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
        return `"${escaped}"`;
      })
      .join(" ");
    this.process = spawnWin32(cmdLine);

    // Poll stdout via PeekNamedPipe (non-blocking) instead of event listeners.
    // Streaming decoder handles multi-byte UTF-8 split across read boundaries.
    const decoder = new TextDecoder("utf-8");
    this._readTimer = setInterval(() => {
      try {
        const chunk = this.process.readStdout(4096);
        if (chunk.length > 0) this.onStdout(decoder.decode(chunk, { stream: true }));
      } catch { /* process may have exited */ }
    }, 50);
  }

  // -- Public API ---------------------------------------------------------

  /** Start the session and wait for the first prompt. */
  async start(): Promise<void> {
    if (this.kind === "kd") {
      // A kernel target attaches in stages:
      // 1. "Connected to target ..." — the UDP link is up. kd stops here and
      //    waits for a break-in (CTRL+C) before the target starts talking.
      // 2. "Kernel Debugger connection established" — printed AFTER break-in.
      // We must send CTRL+BREAK right after stage 1; waiting for stage 2
      // first is a deadlock (established only appears after the break-in).
      const connected = await this.waitForConnectedToTarget(this.timeout);
      if (!connected) {
        await this.close();
        throw new Error(
          "Timed out waiting for the kernel target to connect. " +
          "Is the target booted with debugging enabled and transmitting " +
          "on this transport? (kd reports 'no_debuggee' until it is.)",
        );
      }
      // Give kd a moment to settle, then break in (like the user pressing CTRL+C).
      await new Promise((r) => setTimeout(r, 1000));
      this.process.sendCtrlBreak();
    }
    const ok = await this.waitForPrompt(this.timeout);
    if (!ok) {
      await this.close();
      throw new Error("Debugger initialization timed out");
    }
  }

  private waitForConnectedToTarget(timeoutSec: number): Promise<boolean> {
    if (this._connectedToTarget) return Promise.resolve(true);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this._connectedToTargetResolvers.push(resolve);
    setTimeout(() => {
      if (!this._connectedToTarget) {
        this._connectedToTargetResolvers = this._connectedToTargetResolvers.filter((r) => r !== resolve);
        resolve(false);
      }
    }, timeoutSec * 1000);
    return promise;
  }

  /** Query the current execution state. */
  async queryState(): Promise<DebuggerExecutionState> {
    // Check liveness first — a dead process reports no_debuggee regardless
    // of whether the prompt flag was set.
    if (!this.process.isAlive()) {
      return executionStateFromRaw(DEBUG_STATUS_NO_DEBUGGEE);
    }
    // If we're at a prompt, the debugger is in BREAK state.
    if (this._atPrompt) {
      return executionStateFromRaw(DEBUG_STATUS_BREAK);
    }
    // If we have a pending marker and no prompt, the target is running.
    if (this._expectedMarker) {
      return executionStateFromRaw(DEBUG_STATUS_GO);
    }
    // Default: assume ready
    return executionStateFromRaw(DEBUG_STATUS_BREAK);
  }

  /** Execute a command and return its output. */
  async execute(command: string, timeout?: number): Promise<CommandExecutionResult> {
    // Fail fast if the debugger process is gone.
    if (!this.process.isAlive()) {
      throw new Error("Debugger process has exited. Open a new session.");
    }

    const stateBefore = await this.queryState();

    if (stateBefore.requires_interrupt_before_command) {
      throw new Error(
        `debugger is not ready for commands (status: ${stateBefore.status_name}). ${stateBefore.summary} Query execution state first and call \`windbg_interrupt_target\` if you need to break in.`,
      );
    }

    const marker = this.nextMarker();
    this._ready = false;
    this._expectedMarker = marker;
    this._atPrompt = false;
    this.outputBuffer = [];

    this.writeStdin(`${command}\n.echo ${marker}\n`);

    const cmdTimeout = timeout ?? this.timeout;
    const ok = await this.waitForReady(cmdTimeout * 1000);

    if (!ok) {
      // Try to abort and resync
      const resynced = await this.abortRunningCommand();
      const detail = resynced
        ? ""
        : this.isLiveSession
          ? " — the debugger may still be busy. Try windbg_interrupt_target to regain control, then windbg_sessions to check state."
          : " — the command may need more time. Retry this command with a larger timeout.";
      throw new Error(`Command timed out after ${cmdTimeout} seconds: ${command}${detail}`);
    }

    const output = this.outputBuffer.join("\n");
    const stateAfter = await this.queryState();

    return { command, output, state_before: stateBefore, state_after: stateAfter };
  }

  /** Interrupt (break into) the running target. */
  async interrupt(): Promise<DebuggerExecutionState> {
    if (!this.isLiveSession || !this.process.isAlive()) {
      return await this.queryState();
    }

    this.process.sendCtrlBreak();

    // Wait briefly for the break to take effect
    await Bun.sleep(500);
    return await this.queryState();
  }

  /**
   * Close the session with `q`: debugging ends and, for a process cdb
   * created (open_executable), the debuggee is terminated with it.
   */
  async close(): Promise<void> {
    this._stopReader();
    try {
      // Kernel targets left halted freeze the machine; resume before quitting.
      if (this.kind === "kd") {
        this.writeStdin("g\n");
        await Bun.sleep(300);
      }
      this.writeStdin("q\n");
    } catch { /* process may already be gone */ }

    await Bun.sleep(300);
    try { this.process.kill(); } catch { /* already exited */ }
  }

  /**
   * Detach with `qd`: debugging ends but the debuggee keeps running.
   * User-mode only; kernel sessions fall back to plain `q`.
   */
  async detach(): Promise<void> {
    this._stopReader();
    try {
      this.writeStdin(this.kind === "cdb" ? "qd\n" : "q\n");
    } catch { /* process may already be gone */ }

    await Bun.sleep(300);
    try { this.process.kill(); } catch { /* already exited */ }
  }

  /**
   * Synchronously kill the debugger child process. Used from the process
   * "exit" handler where async cleanup cannot run to completion.
   */
  killSync(): void {
    this._stopReader();
    try { this.process.kill(); } catch { /* already exited */ }
  }

  private _stopReader(): void {
    if (this._readTimer) {
      clearInterval(this._readTimer);
      this._readTimer = null;
    }
  }

  get pid(): number | undefined { return this.process.pid; }
  get exited(): boolean { return !this.process.isAlive(); }

  // -- Internal: marker protocol ------------------------------------------

  private nextMarker(): string {
    this._markerSeq++;
    return `${MARKER_BASE}_${this._markerSeq}`;
  }

  private writeStdin(data: string): void {
    try {
      this.process.writeStdin(new TextEncoder().encode(data));
    } catch { /* process may be gone */ }
  }

  private waitForPrompt(timeoutSec: number): Promise<boolean> {
    // Send a bare marker; when it echoes, the prompt is ready.
    const marker = this.nextMarker();
    this._expectedMarker = marker;
    this.writeStdin(`.echo ${marker}\n`);
    return this.waitForReady(timeoutSec * 1000);
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    if (this._ready) return Promise.resolve(true);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this._readyResolvers.push(resolve);
    const timer = setTimeout(() => {
      // Only fail if this resolver is still pending (i.e. hasn't been flushed
      // by a successful marker). Prevents a stale timer from aborting the
      // next in-flight command.
      const idx = this._readyResolvers.indexOf(resolve);
      if (idx >= 0) {
        this._readyResolvers.splice(idx, 1);
        resolve(false);
      }
    }, timeoutMs);
    // Clear our own timer when resolved by a successful marker.
    void promise.then(() => clearTimeout(timer));
    return promise;
  }

  private flushResolvers(value: boolean): void {
    const resolvers = this._readyResolvers;
    this._readyResolvers = [];
    for (const r of resolvers) r(value);
  }

  private async abortRunningCommand(): Promise<boolean> {
    if (!this.isLiveSession || !this.process.isAlive()) return false;

    this.process.sendCtrlBreak();

    // Wait asynchronously for the pending marker so the event loop stays
    // responsive (the 50ms _readTimer poll is what sets _ready).
    const deadline = Date.now() + Math.min(10000, Math.max(3000, this.timeout * 1000));
    while (Date.now() < deadline) {
      if (this._ready) {
        this._expectedMarker = null;
        return true;
      }
      await Bun.sleep(50);
    }
    this._expectedMarker = null;
    return false;
  }

  // -- Internal: stdout reader -------------------------------------------

  private onStdout(data: string): void {
    this._stdoutBuffer += data;

    let nl: number;
    while ((nl = this._stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this._stdoutBuffer.slice(0, nl).replace(/\r$/, "");
      this._stdoutBuffer = this._stdoutBuffer.slice(nl + 1);
      this.processLine(line);
    }

    // cdb/kd print the prompt (e.g. "0: kd>") with no trailing newline.
    // After a marker completes, discard any trailing prompt residue so it
    // doesn't pollute the next command's first output line.
    if (this._ready && this._stdoutBuffer && PROMPT_RE.test(this._stdoutBuffer.trim())) {
      this._stdoutBuffer = "";
    }
  }

  private processLine(line: string): void {
    // Kernel debugger: "Connected to target" means the UDP link is up.
    // kd stops here and waits for CTRL+C before the target starts talking.
    if (this.kind === "kd" && !this._connectedToTarget
        && line.includes("Connected to target")) {
      this._connectedToTarget = true;
      const resolvers = this._connectedToTargetResolvers;
      this._connectedToTargetResolvers = [];
      for (const r of resolvers) r(true);
    }

    // "Kernel Debugger connection established" is printed after break-in;
    // no action needed here (the prompt check below handles readiness).

    // Check for prompt pattern at end of line
    if (PROMPT_RE.test(line.trim())) {
      this._atPrompt = true;
    }

    // Check for marker
    if (this._expectedMarker && line.includes(this._expectedMarker)) {
      // The marker line itself is not output; we may have collected output
      // before it. Drop the marker line.
      this._expectedMarker = null;
      this._ready = true;
      this._atPrompt = true;
      this.outputBuffer = this.outputBuffer.filter((l) => !l.includes(MARKER_BASE));
      this.flushResolvers(true);
      return;
    }

    // Accumulate output lines (skip empty lines that are just whitespace)
    if (line.trim()) {
      this.outputBuffer.push(line);
    }
  }
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

const DEFAULT_CDB_PATHS = [
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\cdb.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x64)\\cdb.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x86)\\cdb.exe",
];

const DEFAULT_KD_PATHS = [
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\kd.exe",
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\kd.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x64)\\kd.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x86)\\kd.exe",
];

import { lstatSync } from "node:fs";
import { join } from "node:path";

// existsSync/stat follows reparse points and fails on Store execution-alias
// targets (ACL-blocked package dir); lstat inspects the link itself and works
// for real files and aliases alike.
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WinDbg for Windows (Store/MSIX) auto-detection
// ---------------------------------------------------------------------------
// The Store package's binaries under %ProgramFiles%\WindowsApps are
// ACL-blocked for direct launch, but Microsoft registers per-user App
// Execution Aliases under %LOCALAPPDATA%\Microsoft\WindowsApps (cdbX64.exe,
// kdX64.exe, ...) that launch through the Store activation layer as a normal
// user. Probe those fixed paths, same as the classic paths, on every call.

function storeAliasCandidates(exeName: "cdb.exe" | "kd.exe"): string[] {
  const stem = exeName === "cdb.exe" ? "cdb" : "kd";
  const names = process.arch === "arm64"
    ? [`${stem}ARM64.exe`, `${stem}X64.exe`]
    : [`${stem}X64.exe`, `${stem}X86.exe`];
  const localAppData = process.env.LOCALAPPDATA
    ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
  return names.map((n) => join(localAppData, "Microsoft", "WindowsApps", n));
}

function findExecutable(customPath: string | undefined, exeName: "cdb.exe" | "kd.exe"): string {
  if (customPath && pathExists(customPath)) return customPath;
  // Priority: explicit path → Store aliases → Windows Kits → legacy Debugging
  // Tools. Everything is probed on every call, so a WinDbg installed after
  // server start is picked up without a restart.
  for (const p of storeAliasCandidates(exeName)) if (pathExists(p)) return p;
  const classicPaths = exeName === "cdb.exe" ? DEFAULT_CDB_PATHS : DEFAULT_KD_PATHS;
  for (const p of classicPaths) if (pathExists(p)) return p;
  throw new Error(
    `Could not find ${exeName}. Install WinDbg (Microsoft Store) or Debugging Tools for Windows, or pass an explicit path (cdb_path / kd_path).`,
  );
}

export function createCdbExecutableSession(
  executable: string,
  execArgs: string[],
  opts?: { cdbPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const cdbPath = findExecutable(opts?.cdbPath, "cdb.exe");
  // cdb parses options before the first non-option token (the debuggee command
  // line), so -y MUST precede the executable; otherwise it is passed to the
  // debuggee as its own argument.
  const args = [
    cdbPath,
    ...(opts?.symbolsPath ? ["-y", opts.symbolsPath] : []),
    executable,
    ...execArgs,
  ];
  return new DebuggerSession("cdb", {
    debuggerPath: cdbPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: true,
    target: executable,
  });
}

export function createCdbDumpSession(
  dumpPath: string,
  opts?: { cdbPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const cdbPath = findExecutable(opts?.cdbPath, "cdb.exe");
  const args = [cdbPath, "-z", dumpPath];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("cdb", {
    debuggerPath: cdbPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: false,
    target: dumpPath,
  });
}

export function createCdbAttachSession(
  attachSpec: string,
  opts?: { cdbPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const cdbPath = findExecutable(opts?.cdbPath, "cdb.exe");
  // attachSpec is either a decimal pid (-p) or a process name (-pn)
  const flag = /^\d+$/.test(attachSpec) ? "-p" : "-pn";
  const args = [cdbPath, flag, attachSpec];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("cdb", {
    debuggerPath: cdbPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: true,
    target: `pid ${attachSpec}`,
  });
}

export function createKdSession(
  kernelConnection: string,
  opts?: { kdPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const kdPath = findExecutable(opts?.kdPath, "kd.exe");
  const args = [kdPath, "-k", kernelConnection];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("kd", {
    debuggerPath: kdPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: true,
    target: kernelConnection,
  });
}

// ---------------------------------------------------------------------------
// Execution state helpers
// ---------------------------------------------------------------------------

export function executionStateFromRaw(rawStatus: number): DebuggerExecutionState {
  const map: Record<number, [string, boolean, boolean, string]> = {
    0: ["no_change", false, false, "Debugger state is unchanged and commands can be issued."],
    1: ["go", true, false, "The target is running."],
    2: ["go_handled", true, false, "The target is running after a handled event."],
    3: ["go_not_handled", true, false, "The target is running after an unhandled event."],
    4: ["step_over", true, false, "The target is running while step-over is in progress."],
    5: ["step_into", true, false, "The target is running while step-into is in progress."],
    6: ["break", false, false, "The target is broken in and ready for debugger commands."],
    7: ["no_debuggee", false, false, "No debuggee is currently active."],
    8: ["step_branch", true, false, "The target is running while step-branch is in progress."],
    9: ["ignore_event", false, true, "The debugger is processing an event and is not ready for commands."],
    10: ["restart_requested", false, true, "The debugger is restarting the target."],
    11: ["reverse_go", true, false, "The target is running in reverse execution mode."],
    12: ["reverse_step_branch", true, false, "The target is reverse-stepping through a branch."],
    13: ["reverse_step_over", true, false, "The target is reverse step-over running."],
    14: ["reverse_step_into", true, false, "The target is reverse step-into running."],
    15: ["out_of_sync", false, true, "The debugger is out of sync and not ready for commands."],
    16: ["wait_input", false, true, "The debugger is waiting for input and is treated as busy."],
    17: ["timeout", false, true, "The debugger reported a timeout and is treated as busy."],
  };

  const [statusName, running, busy, summary] = map[rawStatus] ?? [
    "unknown", false, true,
    "The debugger returned an unknown execution status; interrupt before issuing commands.",
  ];

  const readyForCommands = !running && !busy;
  return {
    raw_status: rawStatus,
    status_name: statusName,
    running,
    busy,
    ready_for_commands: readyForCommands,
    requires_interrupt_before_command: !readyForCommands,
    summary,
  };
}
