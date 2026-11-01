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

## tso-autostart.ps1

Keeps the client running with the login the launcher already stores. It replaces
`SettlersOnline.ps1` (including its `settings.json` backup) as the way to start
the game, and is safe to run next to `tso-monitor.ps1`.

```bash
powershell -ExecutionPolicy Bypass -File tools\tso-autostart.ps1
```

Run it with `-CheckOnly` to print the game status, launcher and client state
without starting anything.

What it does:

- Starts the newest launcher under `C:\Users\Roland\TSOClient` that has a
  `settings.dat`, with `--x64 --autologin`, in that folder (the launcher opens
  `settings.dat` relative to its working directory). `--autostart` is not a
  launcher option and is ignored. `--autologin` needs "remember me" ticked in the
  launcher once.
- Before each start it asks the game site, one GET every 2 minutes. 503 with the
  maintenance page means maintenance, 200 means the site is up, anything else
  means unknown. It only logs in when the site is up.
- The site returns before the game (over 30 minutes on 2026-10-30), and the login
  server answers the same either way, so only a login proves the game is up.
  After maintenance the first login waits 30 minutes (`-AfterMaintenanceSec`).
- Restarts a client that exited with any non-zero code. Code 0 is a manual close
  while the game is up, which stays closed (`-RestartOnCleanExit` overrides it).
- While the client runs it checks the site every 5 minutes and closes the client
  after two maintenance answers in a row, then restarts it when the game is back
  (`-NoCloseOnMaintenance` turns this off).
- Failed starts back off from 2 minutes, doubling up to 30. After 8 in a row
  (`-MaxFailures`, about 2.5 hours) it exits with code 2, because each one is a
  real login attempt.
- Never starts a login next to an open launcher: a new login ends the session
  started elsewhere. A launcher it started itself that is stuck after 5 minutes
  gets closed; a CAPTCHA stays open for you to solve and blocks retries.

Other options: `-ClientRoot`, `-LauncherRoot`, `-StatusUrl`, `-LogDir`,
`-BackupDir` (empty disables the backup), `-IntervalSec`, `-StatusWaitSec`,
`-StatusRunningSec`, `-BackoffBaseSec`, `-BackoffMaxSec`, `-LaunchTimeoutSec`,
`-StableSec`, `-CloseTimeoutSec`, `-CloseAfterHits`.

Output goes to `tso_portable\steward\autostart\autostart-YYYY-MM-DD.log`. It
never contains credentials: the login stays in `settings.dat`, and the game
process command line (which carries the auth token) is never read. Do not add
`--debug`, which makes the launcher write that token to `debug.txt`.

### Auto-start at logon (optional)

The task must run as your user with "only when logged on" (the default for
`/SC ONLOGON` with no password), because the client needs your desktop:

```bash
schtasks /Create /TN "TSO Autostart" /SC ONLOGON /RL LIMITED /TR "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\dev\steward\tools\tso-autostart.ps1"
```

Stop it with `schtasks /End /TN "TSO Autostart"`, remove it with
`schtasks /Delete /TN "TSO Autostart" /F`.
