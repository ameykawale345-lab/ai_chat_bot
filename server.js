const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";
const MAX_TOKENS = 1024;

// Models Orbit is allowed to route to. The client picks one; we validate it here.
const ALLOWED_MODELS = {
    "claude-sonnet-5": "claude-sonnet-5",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-opus-4-8": "claude-opus-4-8",
};
const DEFAULT_MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are Orbit, a sharp, warm AI thinking companion built into a small chat app.
Be genuinely useful: give direct answers first, then brief supporting detail. Default to concise
responses; expand only when the question calls for depth. Use markdown formatting (headers, bold,
lists, code blocks) when it improves clarity, but don't over-format simple replies. Ask at most one
clarifying question, and only when it's truly needed to give a good answer. Be honest about
uncertainty instead of guessing confidently.`;

// ---------------------------------------------------------------------------
// Tiny in-memory rate limiter (per IP, sliding window). Good enough for a
// small single-instance app; swap for a real store if you ever scale this out.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const requestLog = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    timestamps.push(now);
    requestLog.set(ip, timestamps);
    return timestamps.length > RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// Fallback "brain" used only when no ANTHROPIC_API_KEY is configured, so the
// app still runs out of the box in a limited demo mode.
// ---------------------------------------------------------------------------
function normalizeMessage(message) {
    return message.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function fallbackReply(message) {
    const text = normalizeMessage(message);
    const topic = message
        .replace(/^(can you|could you|please|help me|tell me|explain|what is|what are|how do i|how can i|i need help with)\s+/i, "")
        .replace(/[?.!]+$/, "")
        .trim();

    if (!text) return "I'm here to help. Say hi, ask a question, or tell me what you want to do today.";
    if (/(^|\s)(hi|hello|hey|hey there|yo|sup)\b/.test(text)) {
        return "Hey! I'm Orbit, running in demo mode right now (no API key configured). Add an ANTHROPIC_API_KEY to unlock real answers — see the README.";
    }
    return `I can help with ${topic || "that"} once you add an ANTHROPIC_API_KEY environment variable — I'm currently running in limited demo mode. See the README for setup.`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function readRequestBody(req, callback) {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 200_000) {
            tooLarge = true;
            req.destroy();
        }
    });
    req.on("end", () => {
        if (tooLarge) return callback(new Error("Message too large"));
        try {
            callback(null, JSON.parse(body));
        } catch {
            callback(new Error("Invalid JSON"));
        }
    });
    req.on("error", callback);
}

function sanitizeHistory(rawMessages) {
    if (!Array.isArray(rawMessages)) return [];
    return rawMessages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
        .slice(-40); // cap history length sent per request
}

// ---------------------------------------------------------------------------
// Streams a Groq/OpenAI-compatible response. Groq keys use the gsk_ prefix,
// but the endpoint accepts OpenAI-style chat completions requests.
// ---------------------------------------------------------------------------
async function streamGroq({ messages, signal, onDelta }) {
    const upstream = await fetch(GROQ_URL, {
        method: "POST",
        signal,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                ...messages,
            ],
            temperature: 0.7,
            stream: true,
        }),
    });

    if (!upstream.ok || !upstream.body) {
        let detail = "";
        try {
            const errJson = await upstream.json();
            detail = errJson?.error?.message || "";
        } catch {
            // ignore parse failure and use generic fallback below
        }
        const err = new Error(detail || `Groq API error (${upstream.status})`);
        err.status = upstream.status;
        throw err;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const payloadText = trimmed.slice(5).trim();
            if (payloadText === "[DONE]") continue;

            try {
                const payload = JSON.parse(payloadText);
                const chunk = payload.choices?.[0]?.delta?.content;
                if (typeof chunk === "string") {
                    fullText += chunk;
                    onDelta(chunk);
                }
            } catch {
                // ignore incomplete stream frames
            }
        }
    }

    return fullText;
}

// ---------------------------------------------------------------------------
// Streams a Claude response. Calls onDelta(text) for each text chunk as it
// arrives and resolves with the full text once the stream ends.
// ---------------------------------------------------------------------------
async function streamClaude({ model, messages, signal, onDelta }) {
    const upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        signal,
        headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages,
            stream: true,
        }),
    });

    if (!upstream.ok || !upstream.body) {
        let detail = "";
        try {
            const errJson = await upstream.json();
            detail = errJson?.error?.message || "";
        } catch {
            // ignore parse failure, use generic message below
        }
        const err = new Error(detail || `Claude API error (${upstream.status})`);
        err.status = upstream.status;
        throw err;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const rawEvent of events) {
            const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(5).trim();
            if (!jsonStr) continue;

            let payload;
            try {
                payload = JSON.parse(jsonStr);
            } catch {
                continue;
            }

            if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
                const chunk = payload.delta.text;
                fullText += chunk;
                onDelta(chunk);
            } else if (payload.type === "error") {
                throw new Error(payload.error?.message || "Claude API stream error");
            }
        }
    }

    return fullText;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
        const ip = req.socket.remoteAddress || "unknown";
        if (isRateLimited(ip)) {
            sendJson(res, 429, { error: "You're sending messages a bit fast — try again in a moment." });
            return;
        }

        readRequestBody(req, async (error, body) => {
            if (error) {
                sendJson(res, 400, { error: error.message === "Message too large" ? error.message : "Please send valid JSON." });
                return;
            }

            const message = typeof body.message === "string" ? body.message.trim() : "";
            if (!message) {
                sendJson(res, 400, { error: "Please send a message." });
                return;
            }
            if (message.length > 8000) {
                sendJson(res, 400, { error: "That message is too long — try trimming it a bit." });
                return;
            }

            const history = sanitizeHistory(body.history);
            const requestedModel = typeof body.model === "string" ? body.model : DEFAULT_MODEL;
            const model = ALLOWED_MODELS[requestedModel] || ALLOWED_MODELS[DEFAULT_MODEL];
            const messages = [...history, { role: "user", content: message }];

            // No AI key configured: fall back to the offline canned responder,
            // returned as a single chunk so the client streaming code still works.
            if (!GROQ_API_KEY && !ANTHROPIC_API_KEY) {
                res.writeHead(200, {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Transfer-Encoding": "chunked",
                    "X-Orbit-Mode": "demo",
                });
                res.end(fallbackReply(message));
                return;
            }

            res.writeHead(200, {
                "Content-Type": "text/plain; charset=utf-8",
                "Transfer-Encoding": "chunked",
                "X-Orbit-Mode": GROQ_API_KEY ? "live-groq" : "live",
            });

            const controller = new AbortController();
            req.on("close", () => controller.abort());

            try {
                if (GROQ_API_KEY) {
                    await streamGroq({
                        messages,
                        signal: controller.signal,
                        onDelta: (chunk) => res.write(chunk),
                    });
                } else {
                    await streamClaude({
                        model,
                        messages,
                        signal: controller.signal,
                        onDelta: (chunk) => res.write(chunk),
                    });
                }
            } catch (err) {
                if (err.name === "AbortError") {
                    // client disconnected / stopped generation — nothing to do
                } else {
                    const providerName = GROQ_API_KEY ? "Groq" : "Claude";
                    console.error(`${providerName} API error:`, err.message);
                    if (!res.headersSent) {
                        sendJson(res, err.status === 401 ? 401 : 502, {
                            error: err.status === 401
                                ? "The API key on the server looks invalid."
                                : `Orbit couldn't reach ${providerName} just now. Please try again.`,
                        });
                        return;
                    }
                    res.write(`\n\n[Orbit hit an error: ${err.message}]`);
                }
            } finally {
                res.end();
            }
        });
        return;
    }

    if (req.method !== "GET" || req.url !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
    }

    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
        if (err) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error loading HTML file");
            return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
    });
});

server.listen(PORT, () => {
    if (!GROQ_API_KEY && !ANTHROPIC_API_KEY) {
        console.log(`⚠ No AI API key configured — Orbit is running in limited demo mode.`);
    } else if (GROQ_API_KEY) {
        console.log(`✅ Groq API key detected — Orbit is using the Groq provider.`);
    } else {
        console.log(`✅ Anthropic API key detected — Orbit is using the Anthropic provider.`);
    }
    console.log(`Orbit running at http://localhost:${PORT}`);
});
