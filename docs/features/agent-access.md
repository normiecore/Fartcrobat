# Feature: agent-access

Lets AI apps on the same computer (Claude Desktop first, through a Fartcrobat extension) work with
the documents open in Fartcrobat: read them, see what the person is looking at and has selected,
and make the same changes the person could make. Changes appear live and are undoable ("Agent:" in
Edit > Undo). Irreversible actions need one click from the person in Fartcrobat.

## Decisions

From the owner:
- Default: **on for everyone** (Preferences switch "Allow AI apps to work with your documents";
  a machine policy file can force it on or off).
- The agent can reach **whatever the person can**: any file their account can read or write
  (network shares included), every open document, including password-protected ones they already
  unlocked, and protected files whose password is saved on this device (they open without a
  prompt; see passwordless.md). No per-document sharing.
- **Irreversible actions ask first** in Fartcrobat with one click (Decline is the default):
  overwriting a file on disk (save over the original, export or extract over an existing file),
  discarding unsaved changes, applying redactions, removing security, and undoing or redoing a
  change the person made (or applied redactions). Signing and protecting open Fartcrobat's own
  dialog, where the person types passwords and makes the deliberate click; passwords never reach
  the agent.
- Target for v1: **Claude Desktop on Windows**. macOS and Linux work the same way (Unix socket) and
  are tested in CI on Linux.
- **Copy-restricted documents** (security settings that don't allow copying): agents may read
  their text, as the person reads it on screen. `get_page_text`, `find_text`, `get_context`,
  `get_document_info`, `list_annotations`, `list_form_fields` and `render_page` return their content
  with `copyRestricted: true`, and `SERVER_INSTRUCTIONS` ask the agent not to copy that text into
  files or other apps. `export_document` stays refused, like Fartcrobat's own Export and Copy. The
  restriction is advisory (pictures of the pages show the same text), so this is a usage rule,
  not a security boundary.
- **Network shares** stay reachable (redirected folders, DFS). On Windows, any path starting with
  two separators (`\\server\share\...`, `//server/share/...`, `/\server\...`) is a network path,
  as it is for Windows itself. The first time an AI app connection uses a computer in a window, the
  person is asked once ("Use a network location?", Allow or Decline) before Fartcrobat touches the
  path, because on Windows even checking that a file exists there signs in to that computer with
  the person's account. Computers of documents open in the window count as allowed. The answer
  lasts until that AI app disconnects or the window closes; calls made while the question is on
  screen wait for it. Namespace and device paths (`\\?\...`, `\\.\...`) and Windows device
  names (`CON`, `NUL`, `COM1`...) are refused. On macOS and Linux a `\\server\share` path is
  refused, since it would be read as a relative one.
- **Calls that wait** for the person (a confirmation, a password prompt, the Sign or Protect
  dialog) or run long answer after about 45 s with `{"status": "still_running", "ticket": ...}`
  instead of being cut off by the AI app's request timeout (60 s in Claude Desktop). The person's
  dialog stays open. The agent calls `wait_for_result` with the ticket, which waits up to about
  45 s and returns the result or `still_running` again; `cancel: true` stops the call (a
  confirmation still open counts as declined). The audit log records `pending` for the first
  answer and the real outcome with the `wait_for_result` call that returns it.
- **Handles change on reload**: a handle is `<windowId>-<boot>-doc-<n>` (windowId is
  `w<webContents id>`), and `<boot>` is new on every renderer load. A handle from before a reload
  gives `stale_handle` instead of pointing at another document; the agent calls `list_documents`.

## Architecture

```
Claude Desktop --stdio, MCP--> shim (Node, in the .mcpb extension)
   --named pipe / Unix socket, NDJSON, mutual HMAC auth--> Fartcrobat main process
   --IPC 'agent:request' / 'feature:agent-access:reply'--> window (renderer) --> DocumentModel / engine
```

Contracts (do not change without updating every side):
- `src/shared/agent/protocol.ts`: pipe protocol, endpoint/app files, framing, tool result shape,
  error codes, MCP server instructions.
- `src/shared/agent/tools.ts`: the tool catalogue (name, description, JSON Schema, annotations, gate).
  The shim advertises exactly these; the renderer implements one handler per name
  (`wait_for_result` may be answered by the runner itself).
- `src/shared/agent/bridge.ts`: main <-> window messages, routing rules, status, audit entries.
- `src/features/agent-access/ipc.ts`: the feature's invoke channels.
- `src/features/agent-access/tools/common.tsx`: handler types and helpers (handles, page ranges,
  rects, `confirmAgentAction`, `runAsAgent`).
- Engine: `EngineClient.runAs(actor, fn)` tags engine calls; `Dispatcher.call(..., actor)` makes
  undo labels read "Agent: <label>".

### Main process (`src/features/agent-access/main.ts`, `main/**`)

- Starts when agent access is enabled (preference `agentAccess`, default true, overridden by a
  machine policy, read by `src/main/policy.ts`, which remembered passwords share). Windows: the
  REG_DWORD `AgentAccess` under `HKLM\SOFTWARE\Policies\Fartcrobat` (1 is on, 0 off; read with
  `reg.exe`), which Group Policy or Intune can set and only administrators can write. macOS
  `/Library/Application Support/Fartcrobat/policy.json`, Linux `/etc/fartcrobat/policy.json`,
  `{ "agentAccess": { "enabled": true | false } }`. A policy that exists but cannot be read or
  understood turns access off. Tests may point `FARTCROBAT_POLICY_FILE` at a file on any system.
  Stops and removes the endpoint file when turned off; restarts when turned on. `app.json` records
  whether access is on so the shim does not start the app to be refused.
- Listens on a random address: `\\.\pipe\fartcrobat-agent-<32 hex>` on Windows; on other systems
  `<private 0700 temp dir>/agent.sock`. Writes `<userData>/agent-access/endpoint.json`
  (`AgentEndpoint`, file mode 0600, written atomically) and `app.json` (`AgentAppInfo`: the
  executable and args to start the app; kept after quit). Removes endpoint.json on quit.
- Only the primary instance runs it (it is registered from the normal feature `register`, which
  only runs in the instance that got the single-instance lock).
- Handshake per `protocol.ts`: hello (nonce) -> auth (HMAC of nonce with the token, own nonce,
  client info) -> ready (HMAC of the shim's nonce). Constant-time comparison. Bad auth: reject and
  close. Allow several connections (one per AI app), each with an id.
- Routes calls per `bridge.ts`, forwards cancel, relays progress, answers `ping`.
  Unknown tool names get `unknown_tool` without reaching a renderer. A window that closes with
  calls running answers them with `stale_handle`.
- Audit log `<userData>/agent-access/audit.jsonl`: one `AgentAuditEntry` per finished call. Never
  document content, comment text, form values or passwords: argument names only, plus the values
  of `handle`, `path`, `paths` and `pages`.
- Sends `agent:status` to every window when connections or settings change and when a call
  starts or finishes (for the running counts), coalesced into one broadcast per turn of the event
  loop. Answers `feature:agent-access:status`, `disconnect`, `attention` (show, restore and focus
  the window; `flashFrame` on Windows when focusing is refused), `revealAuditLog`,
  `installExtension` (opens `<resources>/agent/fartcrobat.mcpb`, or
  `<appPath>/out/agent/fartcrobat.mcpb` when unpackaged, with `shell.openPath`, which hands it to
  Claude Desktop; when the file is missing it returns "The Claude Desktop extension is not
  included in this copy of Fartcrobat.").

### Window (`src/features/agent-access/index.tsx`, `ui/**`, `tools/**`)

- `startAgentRunner()` (`runner.ts`) listens for `agent:request` from the moment the feature module
  loads, before the first render, so a call sent while the window starts is not lost. It finds the
  handler in `TOOL_HANDLERS`, validates nothing beyond what the handler checks, runs it with a
  `ToolContext` (AbortSignal tied to `agent:cancel`), converts `ToolError`/exceptions into
  `AgentToolResult.error`, and replies once. A handler still running 15 s after a cancel
  (`CANCEL_GRACE_MS`) is answered `aborted`. Before every tool except the context and view tools
  (so also `open_document` and `combine_files`), it commits the person's pending typing
  (`commitActiveEditors`), like a menu command would.
- Every handler that changes a document wraps its engine calls in `runAsAgent(doc, ...)`. Comments,
  replies and redaction marks an agent adds are signed "Agent (Claude)" (or the AI app's name).
- `open_document` returns the tab already showing a file, also a tab converted from it (Word, an
  image...) until that is saved as a PDF (`convertedFrom` in its result and in `list_documents`).
  It only sees the tabs of the window the call went to. Without `page` it reports the page the
  document opened at, after its Initial View (`initialViewSettled`) and remembered view.
- Visible indicator while any AI app is connected: "Claude connected" with a pulse while a call
  runs. In a document, clicking it opens the Agent activity right panel (recent calls with tool,
  document, outcome and time; Disconnect; a link to Preferences); on Home it opens the same list
  as a popover. It is hidden in Read Mode.
- Disconnect closes that AI app's connections and blocks the app (by its reported name) from
  reconnecting until the person clicks "Allow again" (in the panel or Preferences) or restarts
  Fartcrobat. Its shim is told `disconnected` and refused with `blocked` meanwhile, so it does
  not silently reconnect on the next call.
- One question at a time: while a confirmation, network-location question or password prompt
  from an agent is on screen, another agent call that needs the person answers `busy`.
- Preferences section "AI apps": the switch (read-only with a note when policy decides),
  connection list, "Add to Claude Desktop" button, "Show audit log", one paragraph explaining what
  agents can do and that document text they read goes to the AI app's service.

### Shim (`src/agent-shim/`)

- Built by `npm run build:agent`: `scripts/build-agent-shim.mjs` writes `out/agent/shim.mjs` and
  `scripts/build-agent-extension.mjs` packs it into `out/agent/fartcrobat.mcpb` (its manifest
  requires Node 20 or later). The installers ship it as `<resources>/agent/fartcrobat.mcpb`.
- Node 20+ ESM bundle with `@modelcontextprotocol/server` 2.2.0 (pinned; the SDK's own protocol
  negotiation). Advertises `AGENT_TOOLS` with `SERVER_INSTRUCTIONS`, maps `AgentToolResult` to MCP
  content (`data` as one JSON text block, images as image blocks, `error` as isError
  "[code] message"), forwards MCP cancellation and progress.
- Finds the app through `<userData>/agent-access/endpoint.json` (userData: `FARTCROBAT_USER_DATA`,
  else `%APPDATA%\Fartcrobat`, `~/Library/Application Support/Fartcrobat`,
  `$XDG_CONFIG_HOME/Fartcrobat` or `~/.config/Fartcrobat`). If the app is not running, starts it
  from `app.json` when its executable still exists; otherwise, unless `FARTCROBAT_USER_DATA` names
  a separate profile (a folder other than the usual one, `separateProfile` in `launch.ts`), from
  the installed copy (Windows: the installer's `InstallLocation` in HKCU or HKLM,
  `%LOCALAPPDATA%\Programs\Fartcrobat`, `Program Files\Fartcrobat`; macOS: `/Applications` or
  `~/Applications`; Linux: `/opt/Fartcrobat`). Waits up to 30 s for the endpoint. Reconnects after
  the app restarts. Verifies the app's MAC before sending anything.
- Connects on the first call and reconnects on the next call after the connection drops, never
  on its own. Does not start the app when `app.json` says agent access is off. After the person
  disconnects the AI app, each call is refused with `blocked` (and nothing is started) until they
  allow it again.
- On Windows, starts the app through WMI (`Win32_Process.Create` from PowerShell) rather than as
  a child process. Claude Desktop is an MSIX package, and Windows redirects its descendants'
  AppData writes into a private copy, which would split the app's settings, endpoint file and
  audit log from the real ones. On macOS it uses `open -a`. Otherwise, or if that fails, a
  detached child.
- If the app cannot be reached the result is an error saying Fartcrobat is not running or agent
  access is off. A call that waits for the person answers `still_running` before the AI app's
  request timeout (see Decisions).

## Testing

- Unit (vitest): protocol framing and auth, page-range parsing, path checks, the tool catalogue
  (`tests/engine/agent-catalogue.test.ts`: unique names, closed object schemas, no parameter that
  could carry a secret, a handler for every tool), main routing and audit redaction, the shim's
  result mapping, "Agent:" undo labels through the LocalEngine, and the handlers that ask first
  (`tests/engine/agent-tools-handlers.test.ts`: network locations, undo of the person's steps,
  copy-restricted documents).
- End to end (Playwright): launch the built app with its own userData, start the built shim with
  an MCP client over stdio, call tools, and check the app (document state, undo label, confirm
  dialog: Decline and Apply). Skips nothing on Linux CI.


## Native editing and design-aware reflow

See [agent-text-editing.md](agent-text-editing.md) for native text editing, document layout inspection,
linked column/page flows that keep the design, and an explicitly approved new-design option.
