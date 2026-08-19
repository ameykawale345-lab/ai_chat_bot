# Orbit AI

A small, sharp-looking chat app now powered by the real Claude API — streaming
responses, multi-turn memory, a model switcher, markdown rendering, and a
"stop generating" button.

## What changed from the starter version

- **Real answers, not canned replies.** `server.js` calls the Anthropic
  Messages API instead of matching keywords.
- **Streaming.** Tokens appear as they're generated, proxied straight from
  Claude to the browser over a chunked HTTP response.
- **Conversation memory.** The browser keeps the running history and sends it
  with each request, so Orbit remembers earlier turns in the chat.
- **Model switcher.** Pick Sonnet 5 (balanced), Opus 4.8 (deepest reasoning),
  or Haiku 4.5 (fastest) from the header dropdown.
- **Markdown rendering.** Headings, lists, and code blocks render properly
  (via `marked`, sanitized with `DOMPurify`).
- **Stop button.** The send button turns into a stop button mid-response.
- **Rate limiting.** A simple per-IP limiter (30 requests/minute) guards
  against runaway usage.
- **Demo mode.** If no API key is set, the app still runs using a lightweight
  offline responder, with a banner explaining how to unlock the real thing.

## Setup

1. Install dependencies (there are none beyond Node's built-ins — Node 18+
   ships with a global `fetch`):
   ```bash
   npm install
   ```
2. Get an API key from the
   [Anthropic Console](https://console.anthropic.com/settings/keys) and set
   it as an environment variable:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
   (Or copy `.env.example` to `.env` and load it with your preferred method —
   this app reads `process.env` directly and doesn't ship a dotenv loader.)
3. Start the server:
   ```bash
   npm start
   ```
4. Open [http://localhost:3000](http://localhost:3000).

Without step 2, the app still runs — it just falls back to a limited demo
responder and shows a banner telling you to add a key.

## Notes

- Conversation history lives in the browser tab only; refreshing the page
  clears it. Add persistence (e.g. localStorage or a database) if you want
  chats to survive a reload.
- The system prompt (Orbit's personality) lives in `server.js` as
  `SYSTEM_PROMPT` — edit it there to change how Orbit talks.
- `ALLOWED_MODELS` in `server.js` whitelists which model IDs the client is
  allowed to request, so the dropdown can't be tampered with into calling an
  arbitrary model string.
