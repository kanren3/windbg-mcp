import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Kernel32Ffi } from "./ffi.js";

const kernel32 = dlopen("kernel32.dll", {
  CreatePipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
  SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.bool },
  CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
  GenerateConsoleCtrlEvent: { args: [FFIType.u32, FFIType.u32], returns: FFIType.bool },
  TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.bool },
  WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  PeekNamedPipe: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
});
const k32 = kernel32.symbols;

export const kernel32Ffi: Kernel32Ffi = {
  createPipe: (readBuf, writeBuf, sa, size) => k32.CreatePipe(ptr(readBuf), ptr(writeBuf), ptr(sa), size),
  setHandleInformation: (h, mask, flags) => k32.SetHandleInformation(h, mask, flags),
  createProcessW: (app, cmd, pa, ta, inherit, flags, env, cwd, si, pi) => k32.CreateProcessW(app, ptr(cmd), pa, ta, inherit, flags, env, cwd, ptr(si), ptr(pi)),
  closeHandle: (h) => k32.CloseHandle(h),
  readFile: (h, buf, count, bytesBuf, ov) => k32.ReadFile(h, ptr(buf), count, ptr(bytesBuf), ov),
  writeFile: (h, buf, count, bytesBuf, ov) => k32.WriteFile(h, ptr(buf), count, ptr(bytesBuf), ov),
  getLastError: () => k32.GetLastError(),
  generateConsoleCtrlEvent: (e, g) => k32.GenerateConsoleCtrlEvent(e, g),
  terminateProcess: (h, c) => k32.TerminateProcess(h, c),
  waitForSingleObject: (h, ms) => k32.WaitForSingleObject(h, ms),
  peekNamedPipe: (h, buf, size, bytesBuf, availBuf, leftoverBuf) =>
    k32.PeekNamedPipe(h, buf ? ptr(buf) : null, size, bytesBuf ? ptr(bytesBuf) : null, availBuf ? ptr(availBuf) : null, leftoverBuf ? ptr(leftoverBuf) : null),
};
