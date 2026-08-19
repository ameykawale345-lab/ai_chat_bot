const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT) || 3000;

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function normalizeMessage(message) {
    return message.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function createReply(message) {
    const text = normalizeMessage(message);
    const topic = message
        .replace(/^(can you|could you|please|help me|tell me|explain|what is|what are|how do i|how can i|i need help with)\s+/i, "")
        .replace(/[?.!]+$/, "")
        .trim();

    if (!text) {
        return "I’m here to help. Say hi, ask a question, or tell me what you want to do today.";
    }

    if (/(^|\s)(hi|hello|hey|hey there|yo|sup)\b/.test(text) || /^greetings?\b/.test(text)) {
        return "Hey! I’m Orbit. Tell me what you’re working on, and I’ll help you with a clear next step.";
    }

    if (/(plan|schedule|routine|day plan).*(my day|today|day)/.test(text) || /plan my day/.test(text) || /help me plan my day/.test(text)) {
        return "Here’s a simple day plan: start with your top 3 priorities, do the hardest task in your best focus window, block time for quick wins, and leave a short break before the end of the day. Want me to tailor it to your work, study, or personal goals?";
    }

    if (text.includes("brainstorm") || text.includes("idea")) {
        return `For ${topic || "that idea"}, start by defining who it helps and the one problem it solves. Then choose the smallest version you could finish this week. What part should we shape first: the audience, the features, or the first step?`;
    }

    if (text.includes("clear") || text.includes("writing") || text.includes("rewrite")) {
        return `I can help improve ${topic || "your writing"}. Paste the text and tell me the intended audience and tone. I’ll make it clearer while preserving your meaning.`;
    }

    if (text.includes("code") || text.includes("bug") || text.includes("javascript") || text.includes("python") || text.includes("html")) {
        return `I can help troubleshoot ${topic || "that code"}. Send the relevant code, the error message, and what you expected to happen. I’ll trace the likely cause and suggest a focused fix.`;
    }

    if (text.includes("webhook")) {
        return "A webhook is an automatic message sent from one app to another when an event happens. For example, a payment service can send your server a POST request when a payment succeeds, so your app can react immediately instead of repeatedly checking for updates.";
    }

    if (text.includes("explain") || text.includes("how does") || text.includes("what is")) {
        return `Here’s the short version of ${topic || "that"}: I need one bit more context to give you an accurate explanation. What are you using it for, or which part feels confusing?`;
    }

    if (text.includes("plan") || text.includes("next")) {
        return `For ${topic || "your plan"}, define the outcome first, then choose one action that can be finished in 20 minutes. What deadline or constraint should the plan account for?`;
    }

    return `I can help with ${topic || "that"}. What result are you aiming for, and what have you tried already? That will let me give you a specific next step instead of guessing.`;
}

async function getAIReply(message) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey || typeof fetch !== "function") {
        return createReply(message);
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are Orbit, a helpful AI assistant that gives practical, clear, and supportive answers." },
                { role: "user", content: message },
            ],
            temperature: 0.7,
        }),
    });

    const data = await response.json();

    if (!response.ok) {
        const errorMessage = data?.error?.message || "The AI service returned an error.";
        throw new Error(errorMessage);
    }

    return data.choices?.[0]?.message?.content?.trim() || "I’m here, but I couldn’t generate a response right now.";
}

function readRequestBody(req, callback) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        try {
            callback(null, JSON.parse(body || "{}"));
        } catch {
            callback(new Error("Invalid JSON"));
        }
    });
    req.on("error", callback);
}

const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
        readRequestBody(req, async (error, body) => {
            if (error || !body.message || typeof body.message !== "string" || !body.message.trim()) {
                sendJson(res, 400, { error: "Please send a message." });
                return;
            }

            try {
                const reply = await getAIReply(body.message.trim());
                sendJson(res, 200, { reply });
            } catch (err) {
                sendJson(res, 500, { error: err.message || "Unable to generate a response." });
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

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    if (!process.env.OPENAI_API_KEY) {
        console.log("OPENAI_API_KEY not set. Falling back to local reply logic until configured.");
    }
});

module.exports = { createReply, getAIReply };