# pi-smart-timeouts design

Target: Pi 1.5.0 (`@earendil-works/pi-coding-agent`). File references below are relative to the
installed package root, `<pi>` = `~/.local/share/pi-node/current/lib/node_modules/@earendil-works/pi-coding-agent/`.
All answers were checked against the shipped `docs/`, `examples/extensions/` and `dist/` files.

## Step 1: API answers

### (a) Replacing the built-in `bash` while keeping Pi's execution and truncation

- Registering a tool named `bash` replaces the built-in without a warning:
  `docs/extensions.md:2342-2357`, `examples/extensions/tool-override.ts:69-70`.
- Renderers are inherited per slot when the override omits `renderCall`/`renderResult`
  (`docs/extensions.md:2359`). `promptSnippet` and `promptGuidelines` are **not** inherited and
  must be copied explicitly (`docs/extensions.md:2361`). The result shape, including `details`,
  must match (`docs/extensions.md:2363`).
- `createBashToolDefinition(cwd, options)` is exported (`dist/index.d.ts:26`) and returns the
  complete definition with snippet and guidelines (`docs/extensions.md:2401`,
  `dist/core/tools/bash.js:321-323`). Its `execute` owns everything that must stay identical:
  `OutputAccumulator`, streaming `onUpdate`, tail truncation to 2000 lines / 50 KB, the full-output
  temp file, the truncation footer, the `Command exited with code N` / `Command aborted` texts and
  `structuredContent` (`dist/core/tools/bash.js:172-308`).
- The execution backend is pluggable: `options.operations ?? createLocalBashOperations(...)`
  (`dist/core/tools/bash.js:159`; interface `BashOperations` in `dist/core/tools/bash.d.ts`;
  `docs/extensions.md:2375-2404`). `examples/extensions/ssh.ts:170-182` builds a bash definition
  with custom operations per call and delegates `execute` to it.
- Pi builds its own bash with `commandPrefix` (setting `shellCommandPrefix`) and `shellPath`
  (`dist/core/agent-session.js:2983-2992`). An override must pass the same values; they are
  readable with `pi.getSettings()` (`docs/extensions.md:2118-2120`), which returns raw settings
  (`dist/core/settings-manager.js:329-331`), so a leading `~` in `shellPath` is expanded by us
  like Pi does (`dist/core/settings-manager.js:772-773`, `dist/utils/paths.js:100-122`).
- Pi's `execute` passes the prepared environment to `ops.exec` (`PI_*` session variables, Pi's
  bin dir on `PATH`; `dist/core/tools/bash.js:135-157, 259-264`), so custom operations get it free.
- Exported helpers we reuse: `getShellConfig` (`dist/index.d.ts:44`), `truncateTail`,
  `truncateHead`, `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`, `formatSize` (`dist/index.d.ts:26`).
  Not exported: `killProcessTree`, `getShellEnv`, `OutputAccumulator`, `trackDetachedChildPid`
  (`dist/utils/shell.js:147-234`, `dist/core/tools/output-accumulator.js`).

**Answer:** register `bash` with our own schema/description, and in `execute` call
`createBashToolDefinition(ctx.cwd, { commandPrefix, operations: ours }).execute(...)`. Pi keeps
truncation, formatting, streaming and result shape; we only own process execution.

### (b) Can a tool call return while its child keeps running? Spawn ourselves?

- Yes. `execute` is an ordinary async function whose resolved value is the result
  (`dist/core/extensions/types.d.ts:533`); nothing ties a child process to it.
- Pi's `execute` returns as soon as `ops.exec` resolves (`dist/core/tools/bash.js:258-303`).
- Pi's local operations cannot be reused for this: they kill the process tree on timeout
  (`dist/core/tools/bash.js:84-90`) and resolve only after exit (`bash.js:103`,
  `dist/utils/child-process.js:23-105`).
- So we spawn the process ourselves **inside custom `BashOperations.exec`**, mirroring
  `bash.js:50-123` (shell from `getShellConfig`, `detached` process group on POSIX at line 65,
  stdin transport at 62-73, `128 + signal` exit codes at 110-113) and the stdio drain of
  `waitForChildProcess` (exit + 100 ms idle grace). On timeout `exec` stops forwarding data and
  resolves; the process keeps running as a job. Forwarding must stop because the accumulator
  throws on data after `finish()` (`output-accumulator.js:40-43`; Pi also gates with
  `acceptingOutput`, `bash.js:218-223`).
- Writing a fully custom `execute` instead would mean re-implementing the non-exported
  `OutputAccumulator` and every message text, which defeats compatibility. Rejected.

### (c) Inserting a message from async code, idle and busy

- API: `pi.sendMessage(message, options)` with
  `message = { customType, content, display, details }` and
  `options = { triggerTurn?: boolean, deliverAs?: "steer" | "followUp" | "nextTurn" }`
  (`docs/extensions.md:1625-1647`, `dist/core/extensions/types.d.ts:1281-1284`).
  Implementation: `dist/core/agent-session.js:1862-1898`.
- **Idle** + `triggerTurn: true` → `_startRun({ messageType: "custom", message })`
  (`agent-session.js:1883-1888`); `before_agent_start` sees `messageType: "custom"`
  (`docs/extensions.md:619`). `file-trigger.ts:22-28` is the example.
- **Busy** (`isStreaming` = run active, `agent-session.js:1081-1083`) with `deliverAs: "steer"` →
  `agent.steer()` (`agent-session.js:1875-1881`). The agent loop polls the steering queue after
  every turn and continues while it is non-empty, also after a turn without tool calls
  (`pi-agent-core/dist/agent-loop.js:95, 120-125, 189-192`): the message lands before the next
  model call.
- `"followUp"` waits until the agent would stop (`agent-loop.js:196-202`); `"nextTurn"` waits for
  the next user prompt (`agent-session.js:1872-1873, 1529`). While `agent_settled` handlers run, a
  triggering message is deferred until they finish (`agent-session.js:1884-1886`).
- `pi.sendUserMessage()` (`docs/extensions.md:1649-1679`) would look as if the user typed it. Not used.
- Custom messages reach the model as user-role text (`dist/core/messages.js:89-95`).
- Footgun: Escape with queued messages clears the agent queues, including steered custom
  messages (`dist/modes/interactive/interactive-mode.js:3961-3967` →
  `agent-session.js:1962-1969`). Mitigation below.
- After `session_shutdown`, captured `pi` methods throw (`dist/core/extensions/loader.js:299-311`
  `assertActive`, `docs/extensions.md:1476`).

**Both cases are possible:** one call, `sendMessage(msg, { triggerTurn: true, deliverAs: "steer" })`.

### (d) Lifecycle events for cleanup

- `session_shutdown` with `reason: "quit" | "reload" | "new" | "resume" | "fork"`
  (`docs/extensions.md:601-611`, `dist/core/extensions/types.d.ts:656-660`). Exit covers Ctrl+C,
  Ctrl+D, SIGHUP and SIGTERM (`docs/extensions.md:393`). Handlers are awaited
  (`dist/core/extensions/runner.js:80-86`, `dist/core/agent-session-runtime.js:297-301`,
  print mode signal path `dist/modes/print-mode.js:23-43`).
- Guidance: start resources lazily, never in the factory, and make `session_shutdown` idempotent
  (`docs/extensions.md:252-256`).
- Pi kills its own tracked detached children on SIGTERM/SIGHUP (`dist/utils/shell.js:169-185`,
  `print-mode.js:37-38`), but the tracking API is not exported. We track our own processes and add a
  synchronous `process.on("exit")` fallback.
- Also used: `session_start` (`docs/extensions.md:473-483`) to read flags,
  `message_end` to confirm delivery of our message, `agent_settled` with `aborted`
  (`dist/core/extensions/types.d.ts:820-824`) for the Escape fallback, `context`
  (`docs/extensions.md:815-827`) to drop duplicate exit messages, and
  `session_before_compact` / `session_compact` / `session_compact_failed` to hold messages while
  a compaction runs (Pi is then neither streaming nor idle, `agent-session.js:1081-1087`, and a
  triggering message would start a run beside the compaction, `agent-session.js:1882-1888, 2248`).

### (e) Package layout, `pi install npm:<name>`, gallery

- `docs/packages.md:46-76`: a package is an npm package with conventional directories
  (`extensions/`, `skills/`, `prompts/`, `themes/`) or an explicit manifest
  `"pi": { "extensions": ["./src/index.ts"], ... }`. TypeScript loads directly through jiti
  (`docs/extensions.md:211`).
- Keyword `"pi-package"` makes an npm package eligible for the gallery at
  <https://pi.dev/packages>; optional `pi.image` / `pi.video` add previews (`docs/packages.md:78`).
  The docs describe no submission step: publishing to npm with the keyword is the listing path.
  `README.md` has no gallery information.
- Host packages (`@earendil-works/pi-coding-agent`, `typebox`, ...) go in `peerDependencies` with
  `"*"`, never in `dependencies` (`docs/packages.md:100-116`).
- `CHANGELOG.md` at the root with `## [x.y.z]` headings is shown after updates
  (`docs/packages.md:80-98`).
- Install: `pi install npm:pi-smart-timeouts`; try once: `pi -e npm:pi-smart-timeouts`
  (`docs/packages.md:9-31`).

(b) and (c) are possible, so the build proceeds.

## Prior art (npm search, 2026-11-24)

The two timeout packages named in the brief only set a default/cap and Pi still kills:
`pi-bash-timeout` 0.2.1 (re-declares `timeout` in milliseconds) and `@piotr-oles/pi-bash-timeout`
1.0.1 (injects a default via `tool_call`). Several packages already auto-background with
completion wake-ups, for example `pi-patty-bg-tasks` ("Claude Code parity — auto-background after
120s, run_in_background flag"), `pi-background`, `pi-bg-bash`, `pi-background-bash` and
`pi-better-background-tasks`, plus a number of scoped packages. Their code was not reviewed.
This package delegates all output handling to Pi's own bash definition; how the others do it was not checked.

## Design

### Components

| File | Role |
|---|---|
| `src/index.ts` | Extension factory: flags, tool registration, lifecycle, exit notifications, status line |
| `src/config.ts` | Default/max timeout from flags > env > built-in, validation, timeout resolution |
| `src/jobs.ts` | `ShellProcess` (spawn, output sink, drain), `JobManager` (jobs, kill, shutdown) |
| `src/bash-tool.ts` | The `bash` override: custom `BashOperations`, background result |
| `src/job-tools.ts` | `job_output`, `job_status`, `job_kill`, the exit message text |
| `src/text.ts` | Durations, exit descriptions, UTF-8 safe file reads |
| `test/` | node:test suite against Pi's real modules (`register.mjs` maps the host imports); `smoke/` drives the installed `pi` with a scripted faux model |

### Flow of one `bash` call

1. Resolve the timeout: omitted → default (120 s); given → validated like Pi, then capped at the
   max (600 s). `run_in_background: true` ignores it.
2. Build Pi's definition per call with `commandPrefix` from settings and our operations; call its
   `execute` with `{ command, timeout }`.
3. `exec` spawns the shell (own process group on POSIX), forwards stdout/stderr to Pi's
   accumulator and records it in a sink (memory, spilled to a file above 1 MiB).
4. Exit before the timeout → resolve with the exit code; the sink is discarded; Pi's result is
   returned unchanged.
5. The timeout is validated inside `exec`, where Pi validates it, so `Invalid timeout` surfaces
   the same way. When the timeout hits a shell that already exited but whose process group still
   writes (`cmd & echo started`), a 250 ms retry moves it to a job; Pi would kill it there.
6. Timeout first (or `run_in_background`) → stop forwarding, persist the sink to the job file
   (`<tmpdir>/pi-job-<id>-<hex>.log`, mode 0600, `wx`), register the job, resolve with exit
   code 0 so Pi formats the output so far as a normal result. The wrapper appends the notice and
   patches `structuredContent` (`exit_code: -1`, `job_id`, `job_output_path`).
7. Abort (Escape) during the foreground phase kills the tree and Pi throws `Command aborted`,
   as before (SIGSTOP before SIGKILL on macOS, like Pi).

### Job exit

- On exit (stdio drained), the job records code, signal and end time, closes the file and the
  extension sends one custom message (`customType: "pi-smart-timeouts"`, `display: true`) with
  `{ triggerTurn: true, deliverAs: "steer" }`: id, command, exit code (signal name when killed by a
  signal), run time, output file and the last 20 lines (max 4 KB).
- Delivery is confirmed by `message_end`. If a run settles with `aborted: true` while a notice
  that was steered (sent while Pi was busy) is still undelivered, it is re-queued as `nextTurn`:
  TUI Escape clears the queue (`interactive-mode.js:3961-3967`), so it reaches the model with the
  next prompt instead of being lost or starting a turn the user just stopped. RPC/SDK `abort`
  keeps the queue, which would deliver it twice; a `context` handler keeps only the first exit
  message per job id in every model request.
- While a compaction runs, notices are held and sent when `session_compact` /
  `session_compact_failed` arrives, or when `ctx.isIdle()` turns true (250 ms poll).
- Jobs killed by `job_kill` or by shutdown send no message.

### Tools

- `bash`: Pi's schema plus `run_in_background` (boolean, optional); `timeout` keeps seconds.
  Description = Pi's text with the timeout sentence replaced. Pi's snippet and guideline are kept.
- `job_output(job_id, lines?, offset?)`: last `lines` (default 100) or the output from a byte
  offset, both capped at Pi's 2000 lines / 50 KB; reports state, size and the next offset.
- `job_status(job_id?)`: one job or all jobs: state, exit code, run time, pid, output file.
- `job_kill(job_id)`: SIGTERM to the process group, SIGKILL after 2 s; Windows `taskkill /T /F`.

### Configuration

| Setting | Flag | Env | Default |
|---|---|---|---|
| Default timeout (s) | `--smart-timeouts-default` | `PI_SMART_TIMEOUTS_DEFAULT_S` | 120 |
| Maximum timeout (s) | `--smart-timeouts-max` | `PI_SMART_TIMEOUTS_MAX_S` | 600 |

Flag beats env beats default. Invalid values produce a warning and fall through. A default
above the max is lowered to the max. Values are capped at Node's timer limit (2147483.647 s).
Flags are only readable from `session_start`, so the tools are registered in the factory with
env values and registered again at `session_start` when flags change the numbers in the
descriptions.

### Shutdown

`session_shutdown` (any reason, also `/reload`, `/new`, `/resume`, `/fork`) marks the instance
disposed, SIGTERMs every live process group (jobs and foreground commands), SIGKILLs after
500 ms and awaits it. A `process.on("exit")` hook SIGKILLs anything left synchronously.

### Model-facing text

Positive imperatives, one meaning per sentence, no reasons. Guidelines added to Pi's:

- `Set run_in_background on bash for servers, watchers and other commands that run until stopped.`
- `End your turn to wait for a background job.`
- `Kill a background job with job_kill as soon as you no longer need its result.`

### Limits (documented in README)

- Processes that leave the process group (`setsid`, daemons) are not killed.
- SIGKILL of Pi itself, or SIGINT in print mode (Pi has no SIGINT handler there), leaves jobs running.
- In print/JSON mode Pi exits after the last prompt; running jobs are killed then.
- `structuredContent.exit_code` is `-1` for a backgrounded call; codemode scripts must check `job_id`.
- Job files stay in the temp directory, like Pi's own `pi-bash-*` files.
- Windows code paths mirror Pi's but are untested.
