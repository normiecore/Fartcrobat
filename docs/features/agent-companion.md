# Agent companion

The movable companion shows actual MCP activity in plain language and offers a compact in-app
conversation. Claude connections use a terracotta pixel creature; ChatGPT/Codex connections use
an OpenAI-inspired knot creature. These vector illustrations identify the connected provider;
they are not a claim of an official integration or mascot endorsement.

Drag the grip or focus it and use arrow keys. Position is remembered, clamped when the window
resizes, and keyboard accessible. Click the creature to expand/collapse chat; Escape collapses
chat. Minimize returns it to the Agent indicator; Agent activity and Preferences > AI apps can
restore it. Read Mode hides it. Reduced-motion preferences disable the animation.

## Connect ChatGPT Desktop

Preferences > AI apps > Connect ChatGPT Desktop shows the installation-specific STDIO command,
argument and environment variable. Requires Node.js 22+ on PATH. Add it in ChatGPT Desktop's
Settings > MCP servers, save and restart. Installed copies ship the helper next to app.asar
(electron-builder.yml) and point ChatGPT at a copy in `<userData>/agent-helper/shim.mjs`
(`main/helperCopy.ts`): an AppImage's resources move on every launch, and an update replaces them.
Each start refreshes that copy when it exists, so it always matches the app. The release
workflow runs `tests/e2e/agent-chatgpt.spec.ts` against the packaged app. The setup also names
the userData folder in `FARTCROBAT_USER_DATA`, because ChatGPT passes servers only part of the
environment (XDG_CONFIG_HOME, for one). The helper does not take the usual folder for a separate
profile (`separateProfile` in `src/agent-shim/launch.ts`), so it starts Fartcrobat as for the
Claude extension: through WMI on Windows, which keeps it out of ChatGPT's MSIX package and its
private AppData, and with LaunchServices on a Mac. The advanced section supplies a TOML entry for the
same Codex host. It never rewrites the user's existing config or claims an installed connection
until a client actually connects. This is local-computer MCP, not a web/mobile connector.

Official setup reference checked 16 October 2026:
https://learn.chatgpt.com/docs/extend/mcp#configure-in-the-chatgpt-desktop-app

## Chat from the companion

MCP is client-initiated: Fartcrobat cannot start a conversation in another desktop app. The
person opens the chat (Chat here, or the avatar), and the next conversation that uses Fartcrobat
joins it (see 0.2.1 below). The conversation can then take place under the avatar while that
external session stays active. No separate model, API key or billing
integration is added. If the client stops listening, the UI says so and asks the person to resume
in their AI app. Automatic wake-up of an idle desktop AI session is not implemented.

`companion_chat` without a session joins the focused window's chat while it is open and nobody
owns it (an extension from before 0.2.1 joins this way). Subsequent calls use the returned session,
which routes back to that window even if focus changes. Calls wait at most 30 seconds. User
messages include the document handle at submission time; agents should pass that handle when
working on the requested document. Replies require the delivered message id (`reply_to`).
The UI shows waiting versus received delivery state, not a simulated answer.

Only the owning connection can consume messages or reply. Another connection cannot take over;
End & clear, disconnect, reload or app exit ends the chat. The last 100 messages live in renderer
memory only. No chat contents are put in the audit log. Messages are sent to the selected AI
app's service via its existing MCP connection. Existing edit reviews, permissions and undo
behavior still apply. Ending chat stops the companion exchange; it does not cancel unrelated
PDF tools already executing (use Agent activity to disconnect the client if needed).

The thought bubble describes observed tool activity, not private reasoning. It does not claim
to know what the external model is doing between tool calls. This first version does not provide
speech input, API-backed standalone chat, or stream the desktop app's entire conversation.

## 0.2.1: automatic conversation joining

Opening the chat (Chat here, or the avatar) lets the next conversation that uses Fartcrobat join:
its next successful tool call returns the private token in a separate MCP content block. Nothing
joins before the person opens the chat, so a conversation that only asks about a document is not
told to listen, and who reads what the person types is their choice. One conversation joins per
opening, and closing or minimizing the chat before one joins takes the opening back
(`disarmCompanion`). Opening the chat also keeps the companion on screen (`revealed`, 0.2.2): in
0.2.1 the companion hid when every AI app disconnected, and a chat opened before that stayed open
out of sight, where it could not be closed, until the next conversation joined. The token belongs
to the calling conversation, not to the whole Claude Desktop connection. Subsequent tokenless
calls never disclose an existing token, even on the same connection. `companion_chat` must carry
the token to consume or reply to messages. A second conversation cannot silently take over. End & clear, or a disconnect of the joined conversation,
ends the chat: nobody joins again until the person selects Allow a new conversation.

Only a reply that goes straight back to a live call joins (`runner.ts`): a call that answered
still_running (its result goes through wait_for_result) or that the AI app cancelled would carry
the token to nobody and leave the chat owned by no one who can use it. A cancel that crosses the
reply on its way back can still do that; End & clear, then Allow a new conversation, frees the chat.

A shim from before 0.2.1 drops the token (it builds results from `data` and images only), and a
Claude Desktop extension keeps the shim it was added with until it is added again. Calls from such
a shim never join by themselves (`shimForwardsCompanion` in `src/shared/agent/protocol.ts`,
applied by the router; an explicit `companion_chat` still joins, since its session comes back in
`data`), and the chat and the connection list tell the person to add the extension again.

No invitation is needed. The AI app still controls tool calls: it must follow the returned listening
instructions, and Fartcrobat cannot wake a finished or closed external conversation. Connection
status and listening status remain separate. The companion uses three slow working poses (1.1 s
per pose), stops while waiting for review, and honours reduced motion.
