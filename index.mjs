import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIONS = ['FORNO', 'DRINKS', 'KITCHEN'];
const FILE_NAMES = {
  FORNO: 'pizzaiolo.txt',
  DRINKS: 'bibite.txt',
  KITCHEN: 'cucina.txt',
};
const testPrintersOnly = process.argv.includes('--test-printers');

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requiredSetting(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in print-agent/.env.`);
  return value;
}

function normalizeAgentId(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
  return normalized.length >= 3 ? normalized : 'pizzeria-print-agent';
}

const outputMode = (process.env.PRINT_OUTPUT_MODE?.trim() || 'tcp').toLowerCase();
if (!['tcp', 'files'].includes(outputMode)) {
  throw new Error('PRINT_OUTPUT_MODE must be either tcp or files.');
}
const sharedPrinterPort = integerSetting('PRINTER_PORT', 9100, 1, 65535);
const config = {
  apiUrl: testPrintersOnly ? '' : requiredSetting('PRINT_API_URL').replace(/\/+$/, ''),
  token: testPrintersOnly ? '' : requiredSetting('PRINT_AGENT_TOKEN'),
  outputMode,
  outputDirectory: path.resolve(APP_DIR, process.env.FILE_OUTPUT_DIR?.trim() || 'test-output'),
  printers: outputMode === 'tcp'
    ? Object.fromEntries(STATIONS.map((station) => [station, {
      host: requiredSetting(`PRINTER_${station}_IP`),
      port: integerSetting(`PRINTER_${station}_PORT`, sharedPrinterPort, 1, 65535),
    }]))
    : {},
  receiptWidth: integerSetting('RECEIPT_WIDTH', 42, 24, 80),
  receiptTextWidth: integerSetting('RECEIPT_TEXT_WIDTH', 1, 1, 2),
  receiptTextHeight: integerSetting('RECEIPT_TEXT_HEIGHT', 2, 1, 2),
  codeTable: integerSetting('PRINTER_CODE_TABLE', 19, 0, 255),
  encoding: process.env.PRINTER_ENCODING?.trim() || 'cp858',
  timezone: process.env.RECEIPT_TIMEZONE?.trim() || 'Europe/Rome',
  pollIntervalMs: integerSetting('POLL_INTERVAL_MS', 3000, 1000, 60000),
  printerTimeoutMs: integerSetting('PRINTER_TIMEOUT_MS', 8000, 1000, 60000),
  apiTimeoutMs: integerSetting('API_TIMEOUT_MS', 15000, 1000, 60000),
  agentId: normalizeAgentId(process.env.AGENT_ID?.trim() || `pizzeria-${os.hostname()}`),
  lockPort: integerSetting('AGENT_LOCK_PORT', 31999, 1024, 65535),
};

if (!iconv.encodingExists(config.encoding)) {
  throw new Error(`Unsupported PRINTER_ENCODING: ${config.encoding}`);
}
if (!testPrintersOnly) {
  const api = new URL(config.apiUrl);
  if (api.protocol !== 'https:'
    && !(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname))) {
    throw new Error('PRINT_API_URL must use HTTPS (HTTP is allowed only for localhost).');
  }
}

function log(level, message, details = {}) {
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
  (level === 'error' ? console.error : console.log)(line);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listenForSingleInstance(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error('The print agent is already running on this computer.'));
      } else {
        reject(error);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function wrapText(text, width, prefix = '') {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const available = Math.max(8, width - prefix.length);
  const words = normalized.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (word.length > available) {
      if (current) {
        lines.push(prefix + current);
        current = '';
      }
      for (let offset = 0; offset < word.length; offset += available) {
        lines.push(prefix + word.slice(offset, offset + available));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > available) {
      lines.push(prefix + current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(prefix + current);
  return lines;
}

function parseDatabaseDate(value) {
  if (!value) return null;
  const includesTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = new Date(includesTimezone ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatReceivedTime(value) {
  const date = parseDatabaseDate(value);
  if (!date) return '--:--';
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function buildTicketText(payload) {
  const width = Math.floor(config.receiptWidth / config.receiptTextWidth);
  const separator = '-'.repeat(width);
  const order = payload.order;
  const lines = [`*** ${payload.station} ***`, `ORDINE #${order.displayCode}`];

  if (order.fulfillmentType === 'DINE_IN') {
    lines.push(`SALA - TAVOLO ${order.tableNumber || '?'}`);
    lines.push(`PERSONE: ${order.peopleCount || '?'}`);
    lines.push(`RICEVUTO: ${formatReceivedTime(order.createdAt)}`);
  } else {
    lines.push('ASPORTO');
    lines.push(`RITIRO: ${order.pickupTime || '--:--'}`);
  }
  lines.push(...wrapText(`NOME: ${order.customerName}`, width));
  lines.push(separator);
  if (payload.serviceNote) {
    lines.push(...wrapText(`*** ${payload.serviceNote} ***`, width));
    lines.push(separator);
  }

  for (const item of payload.items) {
    lines.push(...wrapText(`${item.quantity}x ${item.name}`, width));
    for (const extra of item.extras || []) {
      lines.push(...wrapText(`+ ${extra}`, width, '  '));
    }
    if (item.note) lines.push(...wrapText(`NOTA: ${item.note}`, width, '  '));
  }
  lines.push(separator, '', '');
  return lines.join('\n');
}

function buildEscPosTicket(payload) {
  const ESC = 0x1b;
  const GS = 0x1d;
  const textSize = ((config.receiptTextHeight - 1) << 4) | (config.receiptTextWidth - 1);
  return Buffer.concat([
    Buffer.from([ESC, 0x40]),
    Buffer.from([ESC, 0x74, config.codeTable]),
    Buffer.from([ESC, 0x61, 0]),
    Buffer.from([ESC, 0x45, 1]),
    Buffer.from([GS, 0x21, textSize]),
    iconv.encode(buildTicketText(payload), config.encoding),
    Buffer.from([GS, 0x21, 0]),
    Buffer.from([ESC, 0x45, 0]),
    Buffer.from([0x0a]),
    Buffer.from([ESC, 0x64, 4]),
    Buffer.from([GS, 0x56, 65, 3]),
  ]);
}

function sendToPrinter(station, payload) {
  const printer = config.printers[station];
  if (!printer) return Promise.reject(new Error(`No printer configured for station ${station}.`));
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host: printer.host, port: printer.port });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(config.printerTimeoutMs);
    socket.once('timeout', () => socket.destroy(new Error(`Printer ${station} timed out.`)));
    socket.once('error', finish);
    socket.once('connect', () => socket.end(payload, (error) => finish(error || undefined)));
  });
}

function appendTicketToFile(station, payload, jobId) {
  const fileName = FILE_NAMES[station];
  if (!fileName) throw new Error(`No simulation file configured for station ${station}.`);
  fs.mkdirSync(config.outputDirectory, { recursive: true });
  const filePath = path.join(config.outputDirectory, fileName);
  const separator = '='.repeat(config.receiptWidth);
  const record = [
    separator,
    `SIMULATED JOB: ${jobId}`,
    `GENERATED: ${new Date().toISOString()}`,
    separator,
    buildTicketText(payload),
  ].join('\n');
  const descriptor = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(descriptor, `${record}\n`, null, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return filePath;
}

async function deliverTicket(station, payload, jobId) {
  if (config.outputMode === 'files') {
    return { destination: appendTicketToFile(station, payload, jobId) };
  }
  await sendToPrinter(station, buildEscPosTicket(payload));
  return { destination: `${config.printers[station].host}:${config.printers[station].port}` };
}

async function apiPost(pathname, body, attempts = 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${config.apiUrl}${pathname}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.message || data.error || `API returned HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function openPrintedJournal() {
  const stateDirectory = path.join(APP_DIR, 'state');
  fs.mkdirSync(stateDirectory, { recursive: true });
  const journalPath = path.join(stateDirectory, 'printed-jobs.log');
  const printed = new Set();
  if (fs.existsSync(journalPath)) {
    for (const line of fs.readFileSync(journalPath, 'utf8').split(/\r?\n/)) {
      const jobId = line.trim();
      if (jobId) printed.add(jobId);
    }
  }
  const descriptor = fs.openSync(journalPath, 'a');
  fs.fsyncSync(descriptor);
  return {
    printed,
    record(jobId) {
      fs.writeSync(descriptor, `${jobId}\n`, null, 'utf8');
      fs.fsyncSync(descriptor);
      printed.add(jobId);
    },
    close() {
      fs.closeSync(descriptor);
    },
  };
}

async function reportFailure(job, error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const result = await apiPost(`/api/print-agent/jobs/${job.id}/fail`, {
      leaseToken: job.leaseToken,
      error: message,
    });
    log('error', 'Print failed; server scheduled a retry.', {
      jobId: job.id,
      station: job.station,
      retryInSeconds: result.retryInSeconds,
      error: message,
    });
  } catch (reportError) {
    log('error', 'Print failed and failure could not be reported; the lease will expire.', {
      jobId: job.id,
      station: job.station,
      error: message,
      reportError: reportError instanceof Error ? reportError.message : String(reportError),
    });
  }
}

async function processJob(job, journal) {
  if (journal.printed.has(job.id)) {
    try {
      await apiPost(`/api/print-agent/jobs/${job.id}/complete`, {
        leaseToken: job.leaseToken,
      }, 3);
      log('info', 'Previously printed job acknowledged without reprinting.', {
        jobId: job.id,
        station: job.station,
      });
    } catch (error) {
      log('error', 'Could not acknowledge previously printed job; it will be retried safely.', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  try {
    await deliverTicket(job.station, job.payload, job.id);
  } catch (error) {
    await reportFailure(job, error);
    return;
  }

  try {
    journal.record(job.id);
  } catch (error) {
    const fatalError = new Error(
      `Ticket reached ${job.station}, but the durable local journal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    fatalError.fatalLocalState = true;
    throw fatalError;
  }

  try {
    await apiPost(`/api/print-agent/jobs/${job.id}/complete`, {
      leaseToken: job.leaseToken,
    }, 3);
    log('info', config.outputMode === 'files' ? 'Ticket written to simulation file.' : 'Ticket printed.', {
      jobId: job.id,
      station: job.station,
      order: job.payload.order.displayCode,
      ...(config.outputMode === 'files'
        ? { file: path.join(config.outputDirectory, FILE_NAMES[job.station]) }
        : {}),
    });
  } catch (error) {
    // The journal is already durable. When this lease expires, the same job
    // will be acknowledged from the journal without reaching the printer.
    log('error', 'Ticket printed, but server acknowledgement failed; retry is safe.', {
      jobId: job.id,
      station: job.station,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function processClaimedJobs(jobs, journal) {
  const grouped = new Map(STATIONS.map((station) => [station, []]));
  for (const job of jobs) {
    const stationJobs = grouped.get(job.station);
    if (!stationJobs) throw new Error(`Server returned unknown station ${job.station}.`);
    stationJobs.push(job);
  }
  const results = await Promise.allSettled([...grouped.values()].map(async (stationJobs) => {
    for (const job of stationJobs) await processJob(job, journal);
  }));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function runPrinterTest() {
  for (const station of STATIONS) {
    const payload = {
      version: 1,
      station,
      order: {
        id: 0,
        displayCode: 'TEST',
        customerName: 'Prova accenti: à è é ì ò ù',
        fulfillmentType: station === 'FORNO' ? 'DINE_IN' : 'TAKEAWAY',
        createdAt: new Date().toISOString(),
        pickupTime: '20:30',
        tableNumber: '5',
        peopleCount: 2,
      },
      items: [{ quantity: 2, name: 'Margherita', extras: ['Salsiccia', 'Patatine'], note: 'Ben cotta' }],
      ...(station === 'FORNO' ? { serviceNote: 'SEGUI - CI SONO FRITTI' } : {}),
    };
    const delivery = await deliverTicket(station, payload, `TEST-${station}`);
    log('info', config.outputMode === 'files' ? 'Simulation test written.' : 'Printer test sent.', {
      station,
      destination: delivery.destination,
    });
  }
}

let stopping = false;
let journal;
let lockServer;
let resourcesClosed = false;

function requestStop(signal) {
  if (stopping) return;
  stopping = true;
  log('info', 'Stopping print agent.', { signal });
}

function closeResources() {
  if (resourcesClosed) return;
  resourcesClosed = true;
  journal?.close();
  lockServer?.close();
}

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

try {
  lockServer = await listenForSingleInstance(config.lockPort);
  if (testPrintersOnly) {
    await runPrinterTest();
    requestStop('printer-test-complete');
  } else {
    journal = openPrintedJournal();
    log('info', 'Print agent started.', {
      agentId: config.agentId,
      outputMode: config.outputMode,
      ...(config.outputMode === 'files' ? { outputDirectory: config.outputDirectory } : {}),
    });
    while (!stopping) {
      try {
        const result = await apiPost('/api/print-agent/claim', {
          agentId: config.agentId,
          limit: 10,
        });
        const jobs = Array.isArray(result.jobs) ? result.jobs : [];
        if (jobs.length) await processClaimedJobs(jobs, journal);
      } catch (error) {
        if (error?.fatalLocalState) throw error;
        log('error', 'Print-agent cycle failed.', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!stopping) await sleep(config.pollIntervalMs);
    }
  }
  closeResources();
} catch (error) {
  log('error', 'Print agent stopped.', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  requestStop('fatal-error');
  closeResources();
}
