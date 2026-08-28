import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';

const directory = path.dirname(fileURLToPath(import.meta.url));

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const received = [];
const printerServer = net.createServer((socket) => {
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.on('end', () => received.push(Buffer.concat(chunks)));
});

const printerPort = await listen(printerServer);
const lockPort = await availablePort();
const child = spawn(process.execPath, [path.join(directory, 'index.mjs'), '--test-printers'], {
  cwd: directory,
  env: {
    ...process.env,
    PRINT_OUTPUT_MODE: 'tcp',
    PRINTER_FORNO_IP: '127.0.0.1',
    PRINTER_DRINKS_IP: '127.0.0.1',
    PRINTER_KITCHEN_IP: '127.0.0.1',
    PRINTER_PORT: String(printerPort),
    RECEIPT_TEXT_WIDTH: '1',
    RECEIPT_TEXT_HEIGHT: '2',
    AGENT_LOCK_PORT: String(lockPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve) => child.once('exit', resolve));

const deadline = Date.now() + 2000;
while (received.length < 3 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await new Promise((resolve) => printerServer.close(resolve));

assert.equal(exitCode, 0, `Agent failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
assert.equal(received.length, 3, 'Expected one TCP ticket for each of the three stations.');
const decoded = received.map((ticket) => iconv.decode(ticket, 'cp858'));
for (const station of ['FORNO', 'DRINKS', 'KITCHEN']) {
  assert(decoded.some((ticket) => ticket.includes(`*** ${station} ***`)), `Missing ${station} ticket.`);
}
for (const ticket of decoded) {
  assert(ticket.includes('ORDINE #TEST'));
  assert(ticket.includes('NOME: Prova accenti: à è é ì ò ù'));
  assert(!ticket.includes('TOTAL'));
  assert(!ticket.includes('€'));
}
for (const ticket of received) {
  assert.notEqual(
    ticket.indexOf(Buffer.from([0x1d, 0x21, 0x10])),
    -1,
    'Expected the ESC/POS double-height text command.',
  );
}
const fornoTicket = decoded.find((ticket) => ticket.includes('*** FORNO ***'));
assert(fornoTicket?.includes('SEGUI - CI SONO FRITTI'));
for (const ticket of decoded.filter((value) => !value.includes('*** FORNO ***'))) {
  assert(!ticket.includes('SEGUI - CI SONO FRITTI'));
}

const fileOutputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pizzeria-print-files-'));
try {
  const fileLockPort = await availablePort();
  const fileChild = spawn(process.execPath, [path.join(directory, 'index.mjs'), '--test-printers'], {
    cwd: directory,
    env: {
      ...process.env,
      PRINT_OUTPUT_MODE: 'files',
      FILE_OUTPUT_DIR: fileOutputDirectory,
      RECEIPT_TEXT_WIDTH: '1',
      RECEIPT_TEXT_HEIGHT: '2',
      AGENT_LOCK_PORT: String(fileLockPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fileStdout = '';
  let fileStderr = '';
  fileChild.stdout.on('data', (chunk) => { fileStdout += chunk; });
  fileChild.stderr.on('data', (chunk) => { fileStderr += chunk; });
  const fileExitCode = await new Promise((resolve) => fileChild.once('exit', resolve));
  assert.equal(
    fileExitCode,
    0,
    `File-mode agent failed.\nstdout:\n${fileStdout}\nstderr:\n${fileStderr}`,
  );
  for (const [fileName, station] of [
    ['pizzaiolo.txt', 'FORNO'],
    ['bibite.txt', 'DRINKS'],
    ['cucina.txt', 'KITCHEN'],
  ]) {
    const contents = fs.readFileSync(path.join(fileOutputDirectory, fileName), 'utf8');
    assert(contents.includes(`SIMULATED JOB: TEST-${station}`));
    assert(contents.includes(`*** ${station} ***`));
    assert(contents.includes('ORDINE #TEST'));
    assert(!contents.includes('TOTAL'));
    assert(!contents.includes('€'));
    if (station === 'FORNO') assert(contents.includes('SEGUI - CI SONO FRITTI'));
    else assert(!contents.includes('SEGUI - CI SONO FRITTI'));
  }
} finally {
  const temporaryRoot = path.resolve(os.tmpdir());
  assert(path.resolve(fileOutputDirectory).startsWith(`${temporaryRoot}${path.sep}`));
  fs.rmSync(fileOutputDirectory, { recursive: true, force: true });
}

console.log('Local print-agent TCP/ESC-POS and three-file simulation tests passed.');
