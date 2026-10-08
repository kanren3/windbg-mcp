/**
 * Native Win32 spawn with a new process group and piped stdio.
 * Console-free hosts use a short-lived helper to interrupt the child's console.
 */
import { execFile } from "node:child_process";
import { kernel32Ffi } from "./ffi.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const STARTF_USESHOWWINDOW = 0x00000001;
const STARTF_USESTDHANDLES = 0x00000100;
const HANDLE_FLAG_INHERIT = 0x00000001;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x00000102;
const WAIT_FAILED = 0xffffffff;

// ---------------------------------------------------------------------------
// Struct sizes (Windows x64 and arm64: 8-byte pointers, 4-byte DWORD/BOOL)
// ---------------------------------------------------------------------------
const SIZEOF_STARTUPINFOW = 104;
const SIZEOF_PROCESS_INFORMATION = 24;
const SIZEOF_SECURITY_ATTRIBUTES = 24;

// STARTUPINFOW offsets
const SI_CB = 0;
const SI_DWFLAGS = 60;
const SI_WSHOWWINDOW = 64;
const SI_HSTDINPUT = 80;
const SI_HSTDOUTPUT = 88;
const SI_HSTDERROR = 96;

// PROCESS_INFORMATION offsets
const PI_HPROCESS = 0;
const PI_HTHREAD = 8;
const PI_DWPROCESSID = 16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toWideString(s: string): Uint16Array {
  const buf = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  buf[s.length] = 0;
  return buf;
}

function readHandle(buf: ArrayBuffer, offset: number): bigint {
  return new DataView(buf).getBigUint64(offset, true);
}

function writeHandle(buf: ArrayBuffer, offset: number, val: bigint): void {
  new DataView(buf).setBigUint64(offset, val, true);
}

function readU32(buf: ArrayBuffer, offset: number): number {
  return new DataView(buf).getUint32(offset, true);
}

function writeU32(buf: ArrayBuffer, offset: number, val: number): void {
  new DataView(buf).setUint32(offset, val, true);
}


// ---------------------------------------------------------------------------
// Win32Process
// ---------------------------------------------------------------------------
export interface Win32Process {
  pid: number;
  /** Read up to `max` bytes from the child's stdout. Returns bytes read, or empty on EOF/error. */
  readStdout(max: number): Uint8Array;
  /** Write the supplied view to stdin. Returns bytes written; throws on failure. */
  writeStdin(data: Uint8Array): number;
  /** Send CTRL+BREAK to the child's process group. */
  sendCtrlBreak(): Promise<boolean>;
  /** Terminate the child, then release owned handles. */
  kill(): void;
  /** Release owned handles without terminating the child. Safe to call repeatedly. */
  dispose(): void;
  /** Check for a running child. Returns false after disposal; throws on wait failure. */
  isAlive(): boolean;
}

/** Spawn a separate process group without changing the host's console attachment. */
export function spawnWin32(commandLine: string): Win32Process {
  const ffi = kernel32Ffi;
  const sharedConsole = ffi.getConsoleProcessList(new ArrayBuffer(4), 1) !== 0;

  // --- Create pipes ---
  // stdin: parent writes to writeStdin, child reads from readStdin
  // stdout: child writes to writeStdout, parent reads from readStdout
  // stderr uses the child's stdout write handle, so both streams share one pipe.

  const sa = new ArrayBuffer(SIZEOF_SECURITY_ATTRIBUTES);
  writeU32(sa, 0, SIZEOF_SECURITY_ATTRIBUTES);
  writeHandle(sa, 8, 0n); // lpSecurityDescriptor = NULL
  writeU32(sa, 16, 1);    // bInheritHandle = TRUE

  // stdin pipe
  const stdinRead = new ArrayBuffer(8);
  const stdinWrite = new ArrayBuffer(8);
  if (!ffi.createPipe(stdinRead, stdinWrite, sa, 0)) {
    throw new Error(`CreatePipe(stdin) failed: ${ffi.getLastError()}`);
  }

  // Buffer output bursts while the event loop is between reader polls.
  const stdoutRead = new ArrayBuffer(8);
  const stdoutWrite = new ArrayBuffer(8);
  if (!ffi.createPipe(stdoutRead, stdoutWrite, sa, 64 * 1024)) {
    const err = ffi.getLastError();
    // Don't leak stdin pipe on failure
    ffi.closeHandle(readHandle(stdinRead, 0));
    ffi.closeHandle(readHandle(stdinWrite, 0));
    throw new Error(`CreatePipe(stdout) failed: ${err}`);
  }

  // stderr merges into stdout (like Python subprocess.STDOUT).
  // We point hStdError at the same stdout pipe write end.
  // No separate stderr pipe needed.

  // Prevent parent-side handles from being inherited into the child.
  // If these fail, the pipe ends leak into this and future children.
  if (!ffi.setHandleInformation(readHandle(stdinWrite, 0), HANDLE_FLAG_INHERIT, 0) ||
      !ffi.setHandleInformation(readHandle(stdoutRead, 0), HANDLE_FLAG_INHERIT, 0)) {
    const err = ffi.getLastError();
    ffi.closeHandle(readHandle(stdinRead, 0));
    ffi.closeHandle(readHandle(stdinWrite, 0));
    ffi.closeHandle(readHandle(stdoutRead, 0));
    ffi.closeHandle(readHandle(stdoutWrite, 0));
    throw new Error(`SetHandleInformation failed: ${err}`);
  }

  // --- STARTUPINFOW ---
  const si = new ArrayBuffer(SIZEOF_STARTUPINFOW);
  writeU32(si, SI_CB, SIZEOF_STARTUPINFOW);
  writeU32(si, SI_DWFLAGS, STARTF_USESTDHANDLES | (sharedConsole ? 0 : STARTF_USESHOWWINDOW));
  // Hide only the new child console; never alter an existing user's console.
  if (!sharedConsole) new DataView(si).setUint16(SI_WSHOWWINDOW, 0, true); // SW_HIDE
  writeHandle(si, SI_HSTDINPUT, readHandle(stdinRead, 0));
  writeHandle(si, SI_HSTDOUTPUT, readHandle(stdoutWrite, 0));
  writeHandle(si, SI_HSTDERROR, readHandle(stdoutWrite, 0)); // stderr → stdout pipe

  // --- PROCESS_INFORMATION ---
  const pi = new ArrayBuffer(SIZEOF_PROCESS_INFORMATION);

  // --- Command line (must be mutable) ---
  const cmdBuf = toWideString(commandLine);

  // --- CreateProcess ---
  const ok = ffi.createProcessW(
    null,               // lpApplicationName — use command line
    cmdBuf.buffer as ArrayBuffer, // lpCommandLine
    null,               // lpProcessAttributes
    null,               // lpThreadAttributes
    true,               // bInheritHandles
    CREATE_NEW_PROCESS_GROUP,
    null,               // lpEnvironment (inherit)
    null,               // lpCurrentDirectory (inherit)
    si,                 // lpStartupInfo
    pi,                 // lpProcessInformation
  );
  const createError = ok ? 0 : ffi.getLastError();

  // Close child-side handles (they were duplicated into the child)
  ffi.closeHandle(readHandle(stdinRead, 0));
  ffi.closeHandle(readHandle(stdoutWrite, 0));
  // Note: hStdError points to the same stdoutWrite handle — already closed above.

  if (!ok) {
    ffi.closeHandle(readHandle(stdinWrite, 0));
    ffi.closeHandle(readHandle(stdoutRead, 0));
    throw new Error(`CreateProcessW failed: error ${createError}`);
  }

  const hProcess = readHandle(pi, PI_HPROCESS);
  const hThread = readHandle(pi, PI_HTHREAD);
  const pid = readU32(pi, PI_DWPROCESSID);

  // Close thread handle (not needed)
  ffi.closeHandle(hThread);

  const parentStdinWrite = readHandle(stdinWrite, 0);
  const parentStdoutRead = readHandle(stdoutRead, 0);
  let disposed = false;

  const bytesBuf = new ArrayBuffer(4);
  const availBuf = new ArrayBuffer(4);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    ffi.closeHandle(hProcess);
    ffi.closeHandle(parentStdinWrite);
    ffi.closeHandle(parentStdoutRead);
  }

  return {
    pid,

    readStdout(max: number): Uint8Array {
      if (disposed) return new Uint8Array(0);
      // Peek first — don't block if no data available
      const peekOk = ffi.peekNamedPipe(parentStdoutRead, null, 0, null, availBuf, null);
      if (!peekOk) return new Uint8Array(0);
      const avail = readU32(availBuf, 0);
      if (avail === 0) return new Uint8Array(0);
      const toRead = Math.min(avail, max);
      const buf = new Uint8Array(toRead);
      const ok = ffi.readFile(parentStdoutRead, buf.buffer, toRead, bytesBuf, null);
      if (!ok) return new Uint8Array(0);
      const n = readU32(bytesBuf, 0);
      return n === buf.length ? buf : buf.subarray(0, n);
    },

    writeStdin(data: Uint8Array): number {
      if (disposed) throw new Error("Cannot write stdin after process disposal");
      const ok = ffi.writeFile(parentStdinWrite, data, data.byteLength, bytesBuf, null);
      if (!ok) throw new Error(`WriteFile(stdin) failed: ${ffi.getLastError()}`);
      return readU32(bytesBuf, 0);
    },

    async sendCtrlBreak(): Promise<boolean> {
      if (disposed) return false;
      if (sharedConsole) {
        if (!ffi.generateConsoleCtrlEvent(1, pid)) {
          throw new Error(`GenerateConsoleCtrlEvent failed: ${ffi.getLastError()}`);
        }
        return true;
      }

      // The helper must run in another process; its URL selects source or compiled code.
      const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
      const helperUrl = new URL(`./console_control${extension}`, import.meta.url);
      const script = `const { sendCtrlBreakToConsole } = await import(${JSON.stringify(helperUrl.href)}); sendCtrlBreakToConsole(${pid});`;
      const args = !("Bun" in globalThis)
        ? ["--input-type=module", "-e", script]
        : ["-e", script];
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, args, { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }, (error, _stdout, stderr) => {
          if (error) reject(new Error(`CTRL+BREAK helper failed: ${stderr.trim() || error.message}`));
          else resolve();
        });
      });
      return true;
    },

    kill(): void {
      if (disposed) return;
      if (!ffi.terminateProcess(hProcess, 1)) {
        const error = ffi.getLastError();
        // TerminateProcess also fails if the child has already exited.
        if (ffi.waitForSingleObject(hProcess, 0) !== WAIT_OBJECT_0) {
          throw new Error(`TerminateProcess failed: ${error}`);
        }
      }
      dispose();
    },

    dispose,

    isAlive(): boolean {
      if (disposed) return false;
      const result = ffi.waitForSingleObject(hProcess, 0);
      if (result === WAIT_OBJECT_0) return false;
      if (result === WAIT_TIMEOUT) return true;
      if (result === WAIT_FAILED) {
        throw new Error(`WaitForSingleObject failed: ${ffi.getLastError()}`);
      }
      throw new Error(`Unexpected process wait result: ${result}`);
    },
  };
}
