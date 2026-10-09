import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import type { Kernel32Ffi } from "./ffi.js";

const kernel32 = dlopen("kernel32.dll", {
  CreatePipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CreateNamedPipeW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
  ConnectNamedPipe: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  CreateEventW: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
  GetOverlappedResult: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  CancelIoEx: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetProcessHeap: { args: [], returns: FFIType.u64 },
  HeapAlloc: { args: [FFIType.u64, FFIType.u32, FFIType.u64], returns: FFIType.ptr },
  HeapFree: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  GenerateConsoleCtrlEvent: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
  WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  PeekNamedPipe: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  FreeConsole: { args: [], returns: FFIType.i32 },
  AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
});
const k32 = kernel32.symbols;

export const kernel32Ffi: Kernel32Ffi = {
  createPipe: (readBuf, writeBuf, sa, size) => k32.CreatePipe(ptr(readBuf), ptr(writeBuf), ptr(sa), size) !== 0,
  createNamedPipeW: (name, mode, pipeMode, instances, outSize, inSize, timeout) => BigInt(k32.CreateNamedPipeW(ptr(name), mode, pipeMode, instances, outSize, inSize, timeout, null)),
  createFileW: (name, access, share, sa, disposition, flags) => BigInt(k32.CreateFileW(ptr(name), access, share, ptr(sa), disposition, flags, 0n)),
  connectNamedPipe: (h, ov) => k32.ConnectNamedPipe(h, ptr(ov)) !== 0,
  createEventW: () => BigInt(k32.CreateEventW(null, 1, 0, null)),
  allocatePinnedBuffer: (size) => {
    const heap = k32.GetProcessHeap();
    const allocation = k32.HeapAlloc(heap, 8, BigInt(size)); // HEAP_ZERO_MEMORY
    if (!allocation) throw new Error(`HeapAlloc(${size}) failed`);
    try {
      const buffer = toArrayBuffer(allocation, 0, size);
      let freed = false;
      return { buffer, free() { if (!freed) { freed = true; k32.HeapFree(heap, 0, allocation); } } };
    } catch (error) {
      k32.HeapFree(heap, 0, allocation);
      throw error;
    }
  },
  getOverlappedResult: (h, ov, transferred) => k32.GetOverlappedResult(h, ptr(ov), ptr(transferred), 0) !== 0,
  cancelIoEx: (h, ov) => k32.CancelIoEx(h, ptr(ov)) !== 0,
  setHandleInformation: (h, mask, flags) => k32.SetHandleInformation(h, mask, flags) !== 0,
  createProcessW: (app, cmd, pa, ta, inherit, flags, env, cwd, si, pi) => k32.CreateProcessW(app, ptr(cmd), pa, ta, inherit ? 1 : 0, flags, env, cwd, ptr(si), ptr(pi)) !== 0,
  closeHandle: (h) => k32.CloseHandle(h) !== 0,
  readFile: (h, buf, count, bytesBuf, ov) => k32.ReadFile(h, ptr(buf), count, ptr(bytesBuf), ov) !== 0,
  writeFile: (h, buf, count, bytesBuf, ov) => k32.WriteFile(h, buf.byteLength === 0 ? null : ptr(buf), count, bytesBuf ? ptr(bytesBuf) : null, ov ? ptr(ov) : null) !== 0,
  getLastError: () => k32.GetLastError(),
  generateConsoleCtrlEvent: (e, g) => k32.GenerateConsoleCtrlEvent(e, g) !== 0,
  terminateProcess: (h, c) => k32.TerminateProcess(h, c) !== 0,
  waitForSingleObject: (h, ms) => k32.WaitForSingleObject(h, ms),
  peekNamedPipe: (h, buf, size, bytesBuf, availBuf, leftoverBuf) =>
    k32.PeekNamedPipe(h, buf ? ptr(buf) : null, size, bytesBuf ? ptr(bytesBuf) : null, availBuf ? ptr(availBuf) : null, leftoverBuf ? ptr(leftoverBuf) : null) !== 0,
  getConsoleProcessList: (list, count) => k32.GetConsoleProcessList(ptr(list), count),
  freeConsole: () => k32.FreeConsole() !== 0,
  attachConsole: (pid) => k32.AttachConsole(pid) !== 0,
};
