# Feature: agent-access

Lets AI apps on the same computer (Claude Desktop first, through a Fartcrobat extension) work with
the documents open in Fartcrobat: read them, see what the person is looking at and has selected,
and make the same changes the person could make. Changes appear live and are undoable ("Agent:" in
Edit > Undo). Irreversible actions need one click from the person in Fartcrobat.

Decisions (from the owner):
- Default: **on for everyone** (Preferences switch "Allow AI apps to work with your documents";
  a machine policy file can force it on or off).
- The agent can reach **whatever the person can**: any file their account can read or write, every
  open document, including password-protected ones they already unlocked. No per-document sharing.
- **Irreversible actions ask first** in Fartcrobat (Decline is the default): overwriting a file on
  disk (save over the original, export or extract over an existing file), discarding unsaved
  changes, applying redactions, removing security. Signing and protecting open Fartcrobat's own
  dialog, where the person types passwords; passwords never reach the agent.
- Target for v1: **Claude Desktop on Windows**. macOS and Linux work the same way (Unix socket) and
  are tested in CI on Linux.

## Architecture

```
Claude Desktop --stdio, MCP--> shim (Node, in the .mcpb extension)
   --named pipe / Unix socket, NDJSON, mutual HMAC auth--> Fartcrobat main process
   --IPC 'agent:request' / 'feature:agent-access:reply'--> window (renderer) --> DocumentModel / engine
```

Contracts (do not change without updating every side):
- `src/shared/agent/protocol.ts`: pipe protocol, endpoint/app files, framing, tool result shape,
  error codes, MCP server instructions.
- `src/shared/agent/tools.ts`: the 30 tools (name, description, JSON Schema, annotations, gate).
  The shim advertises exactly these; the renderer implements one handler per name.
- `src/shared/agent/bridge.ts`: main <-> window messages, routing rules, status, audit entries.
- `src/features/agent-access/ipc.ts`: the feature's invoke channels.
- `src/features/agent-access/tools/common.tsx`: handler types and helpers (handles, page ranges,
  rects, `confirmAgentAction`, `runAsAgent`).
- Engine: `EngineClient.runAs(actor, fn)` tags engine calls; `Dispatcher.call(..., actor)` makes
  undo labels read "Agent: <label>".

### Main process (`src/features/agent-access/main.ts`, `main/**`)

- Starts when agent access is enabled (preference `agentAccess`, default true, overridden by the
  machine policy file: Windows `%ProgramData%\Fartcrobat\policy.json`, macOS
  `/Library/Application Support/Fartcrobat/policy.json`, Linux `/etc/fartcrobat/policy.json`,
  `{ "agentAccess": { "enabled": true | false } }`; tests may point `FARTCROBAT_POLICY_FILE` at
  another file). Stops and removes the endpoint file when turned off; restarts when turned on.
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
- Sends `agent:status` to every window when connections or settings change; answers
  `feature:agent-access:status`, `disconnect`, `attention` (show, restore and focus the window;
  `flashFrame` on Windows when focusing is refused), `revealAuditLog`, `installExtension` (opens
  `<resources>/agent/fartcrobat.mcpb` with `shell.openPath`, which hands it to Claude Desktop).

### Window (`src/features/agent-access/index.tsx`, `ui/**`, `tools/**`)

- A global component listens for `agent:request`, finds the handler in `TOOL_HANDLERS`, validates
  nothing beyond what the handler checks, runs it with a `ToolContext` (AbortSignal tied to
  `agent:cancel`), converts `ToolError`/exceptions into `AgentToolResult.error`, and replies once.
  Before running a tool that changes a document, it commits the person's pending typing
  (`commitActiveEditors`), like a menu command would.
- Every handler that changes a document wraps its engine calls in `runAsAgent(doc, ...)`.
- Visible indicator while any AI app is connected (Home and documents): "Claude connected" with a
  pulse while a call runs; clicking it opens the Agent activity right panel (recent calls with
  tool, document, outcome and time; Disconnect; a link to Preferences).
- Preferences section "AI apps": the switch (read-only with a note when policy decides),
  connection list, "Add to Claude Desktop" button, "Show audit log", one paragraph explaining what
  agents can do and that document text they read goes to the AI app's service.

### Shim (`src/agent-shim/`, built to `resources/agent/fartcrobat.mcpb`)

- Node 18+ ESM bundle with `@modelcontextprotocol/server` 2.2.0 (pinned; the SDK's own protocol
  negotiation). Advertises `AGENT_TOOLS` with `SERVER_INSTRUCTIONS`, maps `AgentToolResult` to MCP
  content (`data` as one JSON text block, images as image blocks, `error` as isError
  "[code] message"), forwards MCP cancellation and progress.
- Finds the app through `<userData>/agent-access/endpoint.json` (userData: `FARTCROBAT_USER_DATA`,
  else `%APPDATA%\Fartcrobat`, `~/Library/Application Support/Fartcrobat`,
  `$XDG_CONFIG_HOME/Fartcrobat` or `~/.config/Fartcrobat`). If the app is not running, starts it
  from `app.json` (or the default per-user install path on Windows) and waits up to 30 s for the
  endpoint. Reconnects after the app restarts. Verifies the app's MAC before sending anything.
- Tool calls never wait silently: if the app cannot be reached the result is an error saying
  Fartcrobat is not running or agent access is off.

## Testing

- Unit (vitest): protocol framing and auth, page-range parsing, the tool catalogue (unique names,
  valid schemas, no parameter named like a secret, every tool has a handler), main routing and
  audit redaction, the shim's result mapping, "Agent:" undo labels through the LocalEngine.
- End to end (Playwright): launch the built app with its own userData, start the built shim with
  an MCP client over stdio, call tools, and check the app (document state, undo label, confirm
  dialog: Decline and Apply). Skips nothing on Linux CI.
