import { kernel32Ffi } from "./ffi.js";

/** Called only in a short-lived helper, whose process group is separate from the debugger's. */
export function sendCtrlBreakToConsole(pid: number): void {
  const ffi = kernel32Ffi;
  if (!ffi.freeConsole()) {
    throw new Error(`FreeConsole failed: ${ffi.getLastError()}`);
  }
  if (!ffi.attachConsole(pid)) {
    throw new Error(`AttachConsole(${pid}) failed: ${ffi.getLastError()}`);
  }
  // Never broadcast: the helper is not a descendant of this debugger process group.
  if (!ffi.generateConsoleCtrlEvent(1, pid)) {
    throw new Error(`GenerateConsoleCtrlEvent(${pid}) failed: ${ffi.getLastError()}`);
  }
}
