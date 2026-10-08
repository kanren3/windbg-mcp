import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';

const supported = process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch);

function quoteArgument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

async function spawnScript(script) {
  const { spawnWin32 } = await import('../dist/spawn_win32.js');
  return spawnWin32(`${quoteArgument(process.execPath)} -e ${quoteArgument(script)}`);
}

async function readUntil(child, expected) {
  const deadline = Date.now() + 10000;
  let output = '';
  while (Date.now() < deadline) {
    output += Buffer.from(child.readStdout(65536)).toString('utf8');
    if (output.includes(expected)) return output;
    await delay(10);
  }
  assert.fail(`Missing ${JSON.stringify(expected)} in child output: ${JSON.stringify(output)}`);
}

async function waitForExit(child) {
  const deadline = Date.now() + 10000;
  while (child.isAlive() && Date.now() < deadline) await delay(10);
  assert.equal(child.isAlive(), false, 'child must have exited');
}

test('writeStdin respects Uint8Array and Buffer view offsets', { skip: !supported }, async () => {
  for (const makeView of [
    () => new Uint8Array([9, 1, 2, 3, 4, 8]).subarray(1, 5),
    () => Buffer.from([9, 1, 2, 3, 4, 8]).subarray(1, 5),
  ]) {
    const child = await spawnScript(`
      let data = Buffer.alloc(0);
      process.stdout.write('ready');
      process.stdin.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        if (data.length >= 4) {
          const valid = data.toString('hex') === '01020304';
          process.stdout.write(valid ? 'validated' : 'incorrect', () => process.exit(valid ? 0 : 1));
        }
      });
    `);
    try {
      await readUntil(child, 'ready');
      assert.equal(child.writeStdin(makeView()), 4);
      const output = await readUntil(child, 'validated');
      assert.equal(output.includes('incorrect'), false);
      await waitForExit(child);
      child.dispose();
      child.dispose();
      assert.equal(child.isAlive(), false);
    } finally {
      child.kill();
    }
  }
});

test('writeStdin reports a broken pipe after the child exits', { skip: !supported }, async () => {
  const child = await spawnScript(`process.stdout.write('input-closing');`);
  try {
    await readUntil(child, 'input-closing');
    await waitForExit(child);
    assert.throws(() => child.writeStdin(new Uint8Array([1])), Error);
  } finally {
    child.kill();
    child.kill();
  }
});

test('dispose releases handles without terminating a live child', { skip: !supported }, async () => {
  const child = await spawnScript(`
    process.stdout.write('ready');
    setTimeout(() => {}, 30000);
  `);
  try {
    await readUntil(child, 'ready');
    assert.equal(child.isAlive(), true);
    child.dispose();
    child.dispose();
    child.kill(); // Disposed handles must not be reused for termination.
    assert.equal(process.kill(child.pid, 0), true, 'disposed child must still exist');
    assert.equal(child.isAlive(), false, 'disposed wrapper no longer owns a process handle');
    assert.throws(() => child.writeStdin(new Uint8Array([1])), Error);
    assert.equal(await child.sendCtrlBreak(), false);
  } finally {
    try { process.kill(child.pid); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    child.dispose();
  }
});

test('console-free hosts retain redirected handles and do not acquire a console', { skip: !supported }, () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import koffi from 'koffi';
    import { spawnWin32 } from './dist/spawn_win32.js';
    import { kernel32Ffi } from './dist/ffi.js';
    const getStdHandle = koffi.load('kernel32.dll').func('uint64 GetStdHandle(uint32)');
    const standard = [0xfffffff6, 0xfffffff5, 0xfffffff4];
    const before = standard.map((id) => BigInt(getStdHandle(id)));
    assert.equal(kernel32Ffi.getConsoleProcessList(new ArrayBuffer(4), 1), 0);
    process.on('SIGINT', () => {});
    process.on('exit', () => process.stdout.write('exit-intact'));
    const child = spawnWin32('"' + process.execPath + '" -e "process.exit(0)"');
    try {
      assert.deepEqual(standard.map((id) => BigInt(getStdHandle(id))), before);
      assert.equal(kernel32Ffi.getConsoleProcessList(new ArrayBuffer(4), 1), 0);
      let input = '';
      for await (const chunk of process.stdin) input += chunk.toString();
      assert.equal(input, 'stdin-intact');
      process.stdout.write('stdout-intact');
      process.stderr.write('stderr-intact');
    } finally {
      child.kill();
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), input: 'stdin-intact', detached: true,
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, 'stdout-intactexit-intact');
  assert.equal(result.stderr, 'stderr-intact');
});

for (const hasConsole of [false, true]) {
  test(`${hasConsole ? 'shared' : 'isolated'} console interrupts only the child group without changing host handlers`, { skip: !supported }, () => {
    const script = `
      import assert from 'node:assert/strict';
      import koffi from 'koffi';
      import { setTimeout as delay } from 'node:timers/promises';
      import { spawnWin32 } from './dist/spawn_win32.js';
      import { kernel32Ffi } from './dist/ffi.js';
      const quoteArgument = ${quoteArgument.toString()};
      const readUntil = ${readUntil.toString()};
      const hasConsole = ${hasConsole};
      const k32 = koffi.load('kernel32.dll');
      const getWindow = k32.func('uint64 GetConsoleWindow()');
      const isVisible = koffi.load('user32.dll').func('int IsWindowVisible(uint64)');
      const hostWindow = BigInt(getWindow());
      const hostVisibility = isVisible(hostWindow);
      assert.equal(kernel32Ffi.getConsoleProcessList(new ArrayBuffer(4), 1) > 0, hasConsole);
      let hostBreaks = 0;
      let hostInterrupts = 0;
      process.on('SIGBREAK', () => { hostBreaks++; });
      process.on('SIGINT', () => { hostInterrupts++; });
      let child, sibling;
      process.on('exit', () => {
        child?.kill();
        sibling?.kill();
        process.stdout.write('host-exited');
      });
      const targetCode = \`
        const assert = require('node:assert/strict');
        const koffi = require('koffi');
        const k = koffi.load('kernel32.dll');
        const list = k.func('uint32 GetConsoleProcessList(void *, uint32)');
        const processes = Buffer.alloc(4096);
        const count = list(processes, 1024);
        assert.ok(count > 0 && count <= 1024);
        const pids = Array.from({length: count}, (_, i) => processes.readUInt32LE(i * 4));
        assert.equal(pids.includes(\${process.pid}), \${hasConsole});
        const window = k.func('uint64 GetConsoleWindow()')();
        const visible = koffi.load('user32.dll').func('int IsWindowVisible(uint64)')(window);
        if (!\${hasConsole}) assert.equal(visible, 0);
        process.on('SIGBREAK', () => process.stdout.write('interrupted'));
        process.stdout.write('ready');
        setInterval(() => {}, 1000);
      \`;
      child = spawnWin32(quoteArgument(process.execPath) + ' -e ' + quoteArgument(targetCode));
      sibling = spawnWin32(quoteArgument(process.execPath) + ' -e ' + quoteArgument(targetCode));
      let timer;
      try {
        await readUntil(child, 'ready');
        await readUntil(sibling, 'ready');
        let ticks = 0;
        timer = setInterval(() => { ticks++; }, 1);
        assert.equal(await child.sendCtrlBreak(), true);
        if (!hasConsole) assert.ok(ticks > 0, 'helper startup must not block the host event loop');
        await readUntil(child, 'interrupted');
        await delay(100);
        assert.equal(sibling.readStdout(65536).length, 0);
        assert.equal(sibling.isAlive(), true);
        assert.equal(child.isAlive(), true);
        assert.equal(hostBreaks, 0);
        assert.equal(BigInt(getWindow()), hostWindow);
        assert.equal(isVisible(hostWindow), hostVisibility);
        assert.equal(kernel32Ffi.getConsoleProcessList(new ArrayBuffer(4), 1) > 0, hasConsole);
        if (hasConsole) {
          // Broadcast only inside this fixture's own console.
          const members = new ArrayBuffer(4096);
          const memberCount = kernel32Ffi.getConsoleProcessList(members, 1024);
          assert.ok(memberCount > 0 && memberCount <= 1024);
          const owned = new Set([process.pid, child.pid, sibling.pid]);
          for (let i = 0; i < memberCount; i++) {
            assert.ok(owned.has(new DataView(members).getUint32(i * 4, true)));
          }
          assert.notEqual(k32.func('int SetConsoleCtrlHandler(void *, int)')(null, 0), 0);
          assert.equal(kernel32Ffi.generateConsoleCtrlEvent(0, 0), true);
          const deadline = Date.now() + 5000;
          while (hostInterrupts === 0 && Date.now() < deadline) await delay(10);
          assert.equal(hostInterrupts, 1, 'original Node SIGINT handler must still receive console events');
          assert.equal(child.isAlive(), true);
          assert.equal(sibling.isAlive(), true);
        } else {
          const detachedCode = "require('koffi').load('kernel32.dll').func('int FreeConsole()')();process.stdout.write('detached');setInterval(()=>{},1000)";
          const detached = spawnWin32(quoteArgument(process.execPath) + ' -e ' + quoteArgument(detachedCode));
          try {
            await readUntil(detached, 'detached');
            await assert.rejects(detached.sendCtrlBreak(), Error);
            assert.equal(detached.isAlive(), true, 'failed control delivery must not kill the target');
          } finally {
            detached.kill();
          }
        }
      } finally {
        clearInterval(timer);
        child.kill();
        sibling.kill();
      }
    `;
    // Start a console host from a console-free launcher so libuv initializes after console creation.
    const launcher = hasConsole ? `
      import { spawnSync } from 'node:child_process';
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(script)}], {
        encoding: 'utf8', timeout: 35000, windowsHide: false,
      });
      process.stdout.write(child.stdout ?? '');
      process.stderr.write(child.stderr ?? child.error?.message ?? '');
      process.exitCode = child.status ?? 1;
    ` : script;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', launcher], {
      cwd: new URL('..', import.meta.url), detached: true,
      encoding: 'utf8', timeout: 40000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout, 'host-exited');
    assert.equal(result.stderr, '');
  });
}
