/**
 * Native Win32 process spawn with CREATE_NEW_PROCESS_GROUP (no DETACHED_PROCESS).
 *
 * Node/Bun's `detached: true` sets CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS.
 * DETACHED_PROCESS removes the console, which breaks GenerateConsoleCtrlEvent.
 * Python's subprocess.CREATE_NEW_PROCESS_GROUP only creates a new process group
 * while keeping the console — that's what svnscha/mcp-windbg relies on.
 *
 * This module replicates that exact behavior via CreateProcessW FFI.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const STARTF_USESTDHANDLES = 0x00000100;
const HANDLE_FLAG_INHERIT = 0x00000001;

// ---------------------------------------------------------------------------
// FFI bindings
// ---------------------------------------------------------------------------
const kernel32 = dlopen("kernel32.dll", {
  CreatePipe: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.bool,
  },
  SetHandleInformation: {
    args: [FFIType.u64, FFIType.u32, FFIType.u32],
    returns: FFIType.bool,
  },
  CreateProcessW: {
    args: [
      FFIType.ptr,   // lpApplicationName
      FFIType.ptr,   // lpCommandLine
      FFIType.ptr,   // lpProcessAttributes
      FFIType.ptr,   // lpThreadAttributes
      FFIType.bool,  // bInheritHandles
      FFIType.u32,   // dwCreationFlags
      FFIType.ptr,   // lpEnvironment
      FFIType.ptr,   // lpCurrentDirectory
      FFIType.ptr,   // lpStartupInfo
      FFIType.ptr,   // lpProcessInformation
    ],
    returns: FFIType.bool,
  },
  CloseHandle: {
    args: [FFIType.u64],
    returns: FFIType.bool,
  },
  ReadFile: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.bool,
  },
  WriteFile: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.bool,
  },
  GetLastError: {
    args: [],
    returns: FFIType.u32,
  },
  GenerateConsoleCtrlEvent: {
    args: [FFIType.u32, FFIType.u32],
    returns: FFIType.bool,
  },
  TerminateProcess: {
    args: [FFIType.u64, FFIType.u32],
    returns: FFIType.bool,
  },
  WaitForSingleObject: {
    args: [FFIType.u64, FFIType.u32],
    returns: FFIType.u32,
  },
  PeekNamedPipe: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.bool,
  },
});

// ---------------------------------------------------------------------------
// Struct sizes (x64)
// ---------------------------------------------------------------------------
const SIZEOF_STARTUPINFOW = 104;
const SIZEOF_PROCESS_INFORMATION = 24;
const SIZEOF_SECURITY_ATTRIBUTES = 24;

// STARTUPINFOW offsets
const SI_CB = 0;
const SI_DWFLAGS = 60;
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
  /** Write data to the child's stdin. Returns bytes written. */
  writeStdin(data: Uint8Array): number;
  /** Send CTRL+BREAK to the child's process group. */
  sendCtrlBreak(): boolean;
  /** Terminate the child process. */
  kill(): void;
  /** Check if the process is still running. */
  isAlive(): boolean;
}

/**
 * Spawn a process with CREATE_NEW_PROCESS_GROUP (keeping console) and piped stdio.
 */
export function spawnWin32(commandLine: string): Win32Process {
  const k32 = kernel32.symbols;

  // --- Create pipes ---
  // stdin: parent writes to writeStdin, child reads from readStdin
  // stdout: child writes to writeStdout, parent reads from readStdout
  // stderr: child writes to writeStderr, parent reads from readStderr

  const sa = new ArrayBuffer(SIZEOF_SECURITY_ATTRIBUTES);
  writeU32(sa, 0, SIZEOF_SECURITY_ATTRIBUTES);
  writeHandle(sa, 8, 0n); // lpSecurityDescriptor = NULL
  writeU32(sa, 16, 1);    // bInheritHandle = TRUE

  // stdin pipe
  const stdinRead = new ArrayBuffer(8);
  const stdinWrite = new ArrayBuffer(8);
  if (!k32.CreatePipe(ptr(stdinRead), ptr(stdinWrite), ptr(sa), 0)) {
    throw new Error(`CreatePipe(stdin) failed: ${k32.GetLastError()}`);
  }

  // stdout pipe
  const stdoutRead = new ArrayBuffer(8);
  const stdoutWrite = new ArrayBuffer(8);
  if (!k32.CreatePipe(ptr(stdoutRead), ptr(stdoutWrite), ptr(sa), 0)) {
    // Don't leak stdin pipe on failure
    k32.CloseHandle(readHandle(stdinRead, 0));
    k32.CloseHandle(readHandle(stdinWrite, 0));
    throw new Error(`CreatePipe(stdout) failed: ${k32.GetLastError()}`);
  }

  // stderr merges into stdout (like Python subprocess.STDOUT).
  // We point hStdError at the same stdout pipe write end.
  // No separate stderr pipe needed.

  // Prevent parent-side handles from being inherited into the child.
  // If these fail, the pipe ends leak into this and future children.
  if (!k32.SetHandleInformation(readHandle(stdinWrite, 0), HANDLE_FLAG_INHERIT, 0) ||
      !k32.SetHandleInformation(readHandle(stdoutRead, 0), HANDLE_FLAG_INHERIT, 0)) {
    k32.CloseHandle(readHandle(stdinRead, 0));
    k32.CloseHandle(readHandle(stdinWrite, 0));
    k32.CloseHandle(readHandle(stdoutRead, 0));
    k32.CloseHandle(readHandle(stdoutWrite, 0));
    throw new Error(`SetHandleInformation failed: ${k32.GetLastError()}`);
  }

  // --- STARTUPINFOW ---
  const si = new ArrayBuffer(SIZEOF_STARTUPINFOW);
  writeU32(si, SI_CB, SIZEOF_STARTUPINFOW);
  writeU32(si, SI_DWFLAGS, STARTF_USESTDHANDLES);
  writeHandle(si, SI_HSTDINPUT, readHandle(stdinRead, 0));
  writeHandle(si, SI_HSTDOUTPUT, readHandle(stdoutWrite, 0));
  writeHandle(si, SI_HSTDERROR, readHandle(stdoutWrite, 0)); // stderr → stdout pipe

  // --- PROCESS_INFORMATION ---
  const pi = new ArrayBuffer(SIZEOF_PROCESS_INFORMATION);

  // --- Command line (must be mutable) ---
  const cmdBuf = toWideString(commandLine);

  // --- CreateProcess ---
  const ok = k32.CreateProcessW(
    null,            // lpApplicationName — use command line
    ptr(cmdBuf.buffer), // lpCommandLine
    null,            // lpProcessAttributes
    null,            // lpThreadAttributes
    true,            // bInheritHandles
    CREATE_NEW_PROCESS_GROUP,
    null,            // lpEnvironment (inherit)
    null,            // lpCurrentDirectory (inherit)
    ptr(si),         // lpStartupInfo
    ptr(pi),         // lpProcessInformation
  );

  // Close child-side handles (they were duplicated into the child)
  k32.CloseHandle(readHandle(stdinRead, 0));
  k32.CloseHandle(readHandle(stdoutWrite, 0));
  // Note: hStdError points to the same stdoutWrite handle — already closed above.

  if (!ok) {
    const err = k32.GetLastError();
    k32.CloseHandle(readHandle(stdinWrite, 0));
    k32.CloseHandle(readHandle(stdoutRead, 0));
    throw new Error(`CreateProcessW failed: error ${err}`);
  }

  const hProcess = readHandle(pi, PI_HPROCESS);
  const hThread = readHandle(pi, PI_HTHREAD);
  const pid = readU32(pi, PI_DWPROCESSID);

  // Close thread handle (not needed)
  k32.CloseHandle(hThread);

  const parentStdinWrite = readHandle(stdinWrite, 0);
  const parentStdoutRead = readHandle(stdoutRead, 0);
  let killed = false;

  const bytesBuf = new ArrayBuffer(4);

  return {
    pid,

    readStdout(max: number): Uint8Array {
      // Peek first — don't block if no data available
      const availBuf = new ArrayBuffer(4);
      const peekOk = k32.PeekNamedPipe(parentStdoutRead, null, 0, null, ptr(availBuf), null);
      if (!peekOk) return new Uint8Array(0);
      const avail = readU32(availBuf, 0);
      if (avail === 0) return new Uint8Array(0);
      const toRead = Math.min(avail, max);
      const buf = new Uint8Array(toRead);
      const ok = k32.ReadFile(parentStdoutRead, ptr(buf.buffer), toRead, ptr(bytesBuf), null);
      if (!ok) return new Uint8Array(0);
      const n = readU32(bytesBuf, 0);
      return buf.slice(0, n);
    },

    writeStdin(data: Uint8Array): number {
      const ok = k32.WriteFile(parentStdinWrite, ptr(data.buffer), data.length, ptr(bytesBuf), null);
      if (!ok) return 0;
      return readU32(bytesBuf, 0);
    },

    sendCtrlBreak(): boolean {
      return k32.GenerateConsoleCtrlEvent(1, pid) as boolean; // CTRL_BREAK_EVENT=1
    },

    kill(): void {
      if (killed) return;
      killed = true;
      k32.TerminateProcess(hProcess, 1);
      k32.CloseHandle(hProcess);
      k32.CloseHandle(parentStdinWrite);
      k32.CloseHandle(parentStdoutRead);
    },

    isAlive(): boolean {
      if (killed) return false;
      const result = k32.WaitForSingleObject(hProcess, 0);
      return result !== 0; // WAIT_OBJECT_0 = 0 means exited
    },
  };
}
