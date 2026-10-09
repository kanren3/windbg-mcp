import test from "node:test";
import assert from "node:assert/strict";
import { validateDebuggerCommand, MAX_COMMAND_LENGTH, MAX_COMMAND_LINE_LENGTH } from "../dist/command_policy.js";

test("command size is bounded independently of output pagination", () => {
  assert.throws(() => validateDebuggerCommand(".echo " + "x".repeat(MAX_COMMAND_LENGTH)), Error);
  assert.throws(() => validateDebuggerCommand('.echo ' + 'X'.repeat(MAX_COMMAND_LINE_LENGTH - 5)), Error);
  assert.throws(() => validateDebuggerCommand('.echo ' + '中'.repeat(1024)), Error);
});

test("empty commands and input control bytes cannot enter the redirected stream", () => {
  for (const command of ["", " \t\r\n", ".echo before\n\u0002", ".echo \u0000", ".echo \u007f"]) {
    assert.throws(() => validateDebuggerCommand(command), Error);
  }
});

test("line endings normalize and empty console lines do not repeat commands", () => {
  assert.equal(
    validateDebuggerCommand(' \r\n.echo FIRST\r.echo SECOND\n\t\n.printf "  spaces  "\r\n'),
    '.echo FIRST\n.echo SECOND\n.printf "  spaces  "',
  );
});
