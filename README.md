# Local print agent

This small Node.js program runs on exactly one always-on Windows PC, mini-PC, or Raspberry Pi inside the pizzeria. It pulls confirmed print jobs from the Cloudflare Worker and sends each station only its own items over raw ESC/POS TCP (normally port 9100):

- `FORNO`: pizzas and calzoni
- `DRINKS`: drinks
- `KITCHEN`: fried food, chips, and other kitchen items

Tickets contain the station, order number, customer name, station items, extras/notes, and either the takeaway pickup time or the dining-room table, party size, and received time. They intentionally contain no prices or totals. For a table order containing both forno and kitchen/fried items, the forno ticket also prints `SEGUI - CI SONO FRITTI` so the pizzas can follow the fried course.

## Prerequisites

- Node.js 20.6 or newer
- The PC connected to the same local network as all three printers
- A static IP or router DHCP reservation for every printer
- Printers that accept ESC/POS data over TCP, normally port 9100
- Exactly one active copy of this agent

Print each printer's self-test page to identify its IP and supported code table. From PowerShell, verify each address before continuing:

```powershell
Test-NetConnection 192.168.1.150 -Port 9100
Test-NetConnection 192.168.1.151 -Port 9100
Test-NetConnection 192.168.1.152 -Port 9100
```

## Installation

From this directory:

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

Set the public site URL, the shared print-agent token, and the three printer IPs in `.env`. Never commit that file.

Run the automated TCP/ESC-POS smoke test (it uses a local fake printer and does not need `.env`):

```powershell
npm test
```

Test all physical printers without contacting Cloudflare:

```powershell
npm run test-printers
```

Each printer should produce one ticket. Confirm accented Italian characters, line width, feed, and paper cut. If accents are wrong, use the code-page number from that printer's manual in `PRINTER_CODE_TABLE`; its numeric ESC/POS value is vendor-specific. `PRINTER_ENCODING=cp858` is the matching default text encoding.

Start normal processing with either:

```powershell
npm start
```

or double-click `start-print-agent.cmd`. The command file installs dependencies on its first run and then starts the agent. Turning off the PC requires no server changes; start the same command again when the PC turns on.

For automatic startup on Windows, press `Win+R`, open `shell:startup`, and place a shortcut to `start-print-agent.cmd` there. Keep the terminal visible during the first live shifts so printer/network errors are easy to spot.

## Three-file simulation at home

To exercise the complete website → D1 queue → local agent pipeline without receipt printers, change this value in `.env`:

```env
PRINT_OUTPUT_MODE=files
FILE_OUTPUT_DIR=./test-output
```

In this mode, printer IPs are ignored. `npm start` still claims, leases, routes, journals, and acknowledges jobs normally, but it appends human-readable tickets to exactly three files:

```text
test-output/pizzaiolo.txt  ← FORNO
test-output/bibite.txt     ← DRINKS
test-output/cucina.txt     ← KITCHEN
```

Every simulated ticket includes its D1 print-job UUID. This makes a true duplicate visible: the same order and station should have only one `SIMULATED JOB` record. Files are append-only so evidence survives an agent restart. Delete the three files manually before a new controlled test if you want clean counters; do not delete `state/printed-jobs.log`.

`npm run test-printers` respects the selected output mode. With `files`, it appends one `TEST` ticket to each file without contacting Cloudflare. With `tcp`, it sends one physical test to each configured printer.

Be careful when `PRINT_API_URL` points to production: file mode acknowledges claimed jobs as successfully delivered, so those test jobs will not later print on paper. Run only one agent against the queue. At the pizzeria, switch back to:

```env
PRINT_OUTPUT_MODE=tcp
```

## Reliability model

The Worker gives each job a 90-second lease. Failed printer writes are returned to D1 with exponential retry delays from 5 seconds up to 5 minutes. Expired leases are reclaimed automatically after a PC, network, or process interruption.

Before acknowledging a successful print to Cloudflare, the agent synchronously appends the job ID to `state/printed-jobs.log`. If the Worker acknowledgement is lost, the reclaimed job is recognized locally and acknowledged without printing again. Do not delete this state directory during normal operation.

Raw ESC/POS printers do not provide a durable job acknowledgement. There is therefore one unavoidable narrow ambiguity: the process or PC could fail after the operating system sent bytes to the printer but before the local journal was flushed. No software-only bridge can guarantee exactly-once printing across that hardware boundary. The D1 dedupe key, leases, single-instance lock, and durable local journal remove the normal duplicate cases. Do not run a second agent on another PC unless deliberately replacing the first one.

If the agent reports that a ticket reached a printer but its local journal failed, it stops instead of retrying automatically. Preserve the terminal message and inspect the already printed ticket plus the `state` directory before restarting.

## Configuration reference

Required values:

- `PRINT_API_URL`
- `PRINT_AGENT_TOKEN`
- `PRINTER_FORNO_IP`, `PRINTER_DRINKS_IP`, and `PRINTER_KITCHEN_IP` in `tcp` mode

`PRINT_OUTPUT_MODE` defaults to `tcp`; `files` selects the at-home simulation. `PRINTER_PORT` defaults to `9100`. A station can override it with `PRINTER_FORNO_PORT`, `PRINTER_DRINKS_PORT`, or `PRINTER_KITCHEN_PORT`. Ticket text defaults to double height with normal width (`RECEIPT_TEXT_HEIGHT=2`, `RECEIPT_TEXT_WIDTH=1`). Use `1` for normal size or `2` for double size; normal width avoids reducing the number of characters per line. The other optional defaults are documented in `.env.example`.
