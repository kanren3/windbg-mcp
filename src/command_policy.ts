export const MAX_COMMAND_LENGTH = 64 * 1024;
// Leave room for the line terminator and NUL in CDB's 4096-character input buffer.
export const MAX_COMMAND_LINE_LENGTH = 4094;

/** Validates redirected input framing without interpreting debugger commands. */
export function validateDebuggerCommand(command: string): string {
  if (!command.trim()) throw new Error("command must not be empty");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters`);
  if (/[^\x00-\x7f]/.test(command)) {
    throw new Error("CDB/KD redirected command input is limited to ASCII; pass Unicode paths through the dedicated tool parameters");
  }
  const lines = command.split(/\r\n|\r|\n/);
  if (lines.some((line) => line.length > MAX_COMMAND_LINE_LENGTH)) {
    throw new Error(`Each debugger command line must be at most ${MAX_COMMAND_LINE_LENGTH} ASCII characters`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
    throw new Error("Debugger input control characters are not supported");
  }
  // Empty console input repeats the previous CDB command, including private framing commands.
  return lines.filter((line) => line.trim().length > 0).join("\n");
}
