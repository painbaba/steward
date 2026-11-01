# tools

Helpers that run outside steward's `src/` and are not part of the bundle.

## tso-monitor.ps1

Standalone crash and resource monitor for the TSO AIR client. It runs next to
the client (not inside it) and samples every process started from the client
folder, so that after a crash you can tell from the trend whether steward
(memory/GDI growth, log spam) or something else was involved.

Start it in a PowerShell window before (or after) starting the client:

```bash
powershell -ExecutionPolicy Bypass -File tools\tso-monitor.ps1
```

Options: `-IntervalSec 15`, `-LogDir <dir>`, `-ClientRoot <tso_portable>`,
`-ProcessName client64.exe`, `-WarnPrivateMB 3000`, `-LeakMBPerHour 150`,
`-LeakWindowMin 30`. It waits for the client, picks it up again after a
restart, and only one instance runs at a time. Stop it with Ctrl+C.

Output goes to `tso_portable\steward\monitor\`:

- `samples-YYYY-MM-DD.csv`: memory (working set, private, virtual, peak),
  handles, threads, CPU %, GDI/USER objects, responding, system free RAM and
  commit charge, `console.log` size and growth. One row per process per sample.
- `events-YYYY-MM-DD.log`: process start/exit with decoded exit code, and
  warnings (memory threshold, steady private-bytes growth, GDI/USER near the
  10000 limit, window not responding, system commit above 90%).
- `crash-<time>-<exe>-<pid>.txt`: written on every exit: the last 20 samples,
  the last 200 lines of `steward\logs\console.log`, then (about 45 s later)
  matching Application Error / WER / runtime event log entries, new dumps in
  `%LOCALAPPDATA%\CrashDumps` and WER report folders.

Reading it: a crash with flat private bytes and GDI counts in the samples and
no steward error in the console tail points away from a steward leak. Steady
growth in the hours before the exit, or a `console.log` that suddenly grows
fast, points at steward. `VirtualMB` around 2 TB is normal for the 64-bit
client (address-space reservations); it matters only for the 32-bit
`client.exe`, which has a 2 GB limit and gets a warning at 75%.

A log rotation shows as a negative `ConsoleLogDeltaKB`. The crash snapshot
tails only the current `console.log`, so a crash just after a rotation has a
short tail; the rest is in `console.log.1`.

### Auto-start at logon (optional)

```bash
schtasks /Create /TN "TSO Monitor" /SC ONLOGON /RL LIMITED /TR "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\dev\steward\tools\tso-monitor.ps1"
```

Remove it again with `schtasks /Delete /TN "TSO Monitor" /F`.
