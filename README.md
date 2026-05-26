# trade-option-flow

Standalone Electron app: visualises option order flow as a grid of mini-charts —
ATM ± N strikes × (call | put). Each cell shows bid/ask lines plus trade bubbles
sized by volume and coloured by direction (buy / sell). Time axis radiates
outward from the central strike column, so the freshest activity is always next
to the strike value and history fans out toward the screen edges.

Sits on top of a fork of the **DWX Connect** MQL5 expert advisor
(`extensions/dwx/DWX_Service_IS.mq5`) with three local extensions:
`SUBSCRIBE_TICKS`, `GET_SYMBOLS`, `SUBSCRIBE_MARKET_DEPTH`.

## Requirements

- A running MT5 terminal with `DWX_Service_IS.ex5` attached to a chart and
  Algo Trading enabled.
- Node 18+ on the host where you run the Electron app.

## Repo layout

```
trade-option-flow/
├── package.json
├── main.js               # Electron main: owns dwx_client, brokers IPC
├── preload.js            # context-bridge → window.mt5
├── renderer/
│   ├── index.html
│   ├── style.css
│   └── app.js            # grid + canvas charts + render loop
├── lib/
│   ├── dwx_client.js     # Node-port of the DWX client (file IPC with MQL)
│   └── occ.js            # OCC symbol parser, chain builder, ATM pick
└── extensions/
    └── dwx/
        └── DWX_Service_IS.mq5  # the EA that ships ticks/symbols/quotes to disk
```

Drop the `extensions/dwx/DWX_Service_IS.mq5` into your terminal's
`MQL5\Experts\` folder, compile in MetaEditor (F7), then attach to any chart.

## Install & run

```bash
cd trade-option-flow
npm install
npm start
```

Or pass the MT5 files dir on the command line / via env:

```bash
npm start -- --files-dir="C:\Users\me\AppData\Roaming\MetaQuotes\Terminal\<HASH>\MQL5\Files"
# or
MT5_FILES_DIR="..." npm start
```

## Usage

1. Enter your MT5 `MQL5\Files` directory → **Connect**.
2. Type the option root (default `SPY`) → expiries auto-load from the broker.
3. Pick an expiry (0DTE prefilled if today is one).
4. The **Underlying** field is the symbol used to derive ATM (mid of bid/ask).
   Default `SPY`. Change if your broker names the underlying differently.
5. **Strikes ±** controls how many strikes above and below ATM to show
   (default 5 → 11 rows including ATM).
6. **Window** is the rolling time window per cell in minutes.
7. **Go** → contracts start streaming.

## Record & replay (debug visualisation without MT5)

Most option brokers don't expose historical option ticks via `CopyTicks`, so
there's no "give me yesterday's flow" button. The app instead records a live
session to a file you can replay offline as many times as you want.

Record a session:

```bash
npm start -- --record                              # auto path: ./recordings/flow-<ts>.jsonl
npm start -- --record=./recordings/my-spy-0dte.jsonl
```

Every event sent to the renderer (`mt5:quote`, `mt5:ticks`, `mt5:message`)
plus the `get-symbols` / `build-chain` results are appended as JSONL.

Replay (MT5 not required — DWX is bypassed):

```bash
npm start -- --replay=./recordings/my-spy-0dte.jsonl
npm start -- --replay=./recordings/my-spy-0dte.jsonl --replay-speed=10
```

Speed `1` = real time, `10` = 10× faster, `0.5` = slow-mo. The renderer is
unaware it's a recording — same code path, same visuals.

## What you see

Layout: **calls left | strike middle | puts right**, highest strike on top.
The strike closest to ATM is highlighted yellow.

Each cell:
- blue line — bid history
- pink line — ask history
- bubbles — trades; radius ∝ √volume; colour: blue=buy, pink=sell, green=neutral
- time axis points inward toward the strike column; the right edge of every
  call chart and the left edge of every put chart is "now".

X-axis: sliding window driven by the freshest tick across all symbols (so we
don't depend on broker-server-time vs Date.now() alignment).
Y-axis: auto-scaled per cell.

## Architecture

```
 ┌───────────────────┐
 │ MT5 + DWX_Service │  MQL writes DWX_*.txt files
 └─────────┬─────────┘
           │ filesystem
 ┌─────────▼─────────┐
 │ lib/dwx_client.js │  poll loops parse JSON, emit events
 └─────────┬─────────┘
           │ require()
 ┌─────────▼─────────┐
 │ main.js (Electron)│  owns dwx_client, brokers IPC
 └─────────┬─────────┘
           │ IPC (window.mt5 in renderer)
 ┌─────────▼─────────┐
 │ renderer/app.js   │  grid layout, canvas charts, render loop
 └───────────────────┘
```

## Tunables

- **Strikes ±**, **Window**, **Underlying root** — all in the toolbar.
- `defaultTickLookbackSec` / `tickWriteThrottleMs` in
  `extensions/dwx/DWX_Service_IS.mq5` — change if you want shorter/longer
  bootstrap windows or smoother / heavier file traffic.
- `MAX_PER_SYMBOL` in `renderer/app.js` — buffer cap per contract on the JS side.

## Known limitations

- Symbol resolution relies on OCC-style names (`SPY YYMMDDCNNNNNNNN`). Brokers
  using exotic formats need the parser in `lib/occ.js` extended.
- ATM is the mid of underlying bid/ask. If the broker doesn't list the
  underlying (e.g. SPY ETF) under the same MT5 instance as the options,
  the app falls back to the median strike — not ideal.
- Ticks are pulled via `SymbolInfoTick` polling at ~25 ms intervals (we tried
  `CopyTicks` history first but most option brokers don't supply it). That
  means we accumulate from the moment of subscription — no instant bootstrap
  with historical data, allow ~30-60 seconds to fill the window after Go.
- Running Electron from a mapped/network drive on Windows usually triggers
  GPU process launch failures. `main.js` already disables HW acceleration,
  GPU compositing, and the sandbox to work around this — at the cost of
  software-only Canvas rendering (which is fine for our chart count).
