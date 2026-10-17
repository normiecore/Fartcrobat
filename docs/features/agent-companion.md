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
Settings > MCP servers, save and restart. The advanced section supplies a TOML entry for the
same Codex host. It never rewrites the user's existing config or claims an installed connection
until a client actually connects. This is local-computer MCP, not a web/mobile connector.

Official setup reference checked 16 October 2026:
https://learn.chatgpt.com/docs/extend/mcp#configure-in-the-chatgpt-desktop-app

## Chat from the companion

MCP is client-initiated: Fartcrobat cannot start a conversation in another desktop app. Click
Chat here > Copy chat invitation, paste it into a connected Claude or ChatGPT desktop chat,
and let that agent join using `companion_chat`. The conversation can then take place under
the avatar while that external session stays active. No separate model, API key or billing
integration is added. If the client stops listening, the UI says so and asks the person to resume
in their AI app. Automatic wake-up of an idle desktop AI session is not implemented.

The tool without a session joins the focused window. Subsequent calls use the returned session,
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

The first successful Fartcrobat tool call joins an available companion automatically and returns
its private token in a separate MCP content block. The token belongs to the calling conversation,
not to the whole Claude Desktop connection. Subsequent tokenless calls never disclose an existing
token, even on the same connection. `companion_chat` must carry the token to consume or reply to
messages. A second conversation cannot silently take over. End & clear pauses joining until the
person selects Allow a new conversation; a disconnect clears the old session.

No invitation is needed. The AI app still controls tool calls: it must follow the returned listening
instructions, and Fartcrobat cannot wake a finished or closed external conversation. Connection
status and listening status remain separate. The companion uses three slow working poses (1.1 s
per pose), stops while waiting for review, and honours reduced motion.
