const http = require("http");
const fs = require("fs");
const path = require("path");

const port = 3000;

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function createReply(message) {
    const text = message.toLowerCase();
    const topic = message.replace(/^(can you|could you|please|help me|tell me|explain|what is|what are|how do i)\s+/i, "").replace(/[?.!]+$/, "").trim();

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

    if (text.includes("hello") || text.includes("hi ") || text === "hi") {
        return "Hey! I’m Orbit. Tell me what you’re working on, and we’ll find a useful next step together.";
    }

    return `I can help with ${topic || "that"}. What result are you aiming for, and what have you tried already? That will let me give you a specific next step instead of guessing.`;
}

function readRequestBody(req, callback) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        try {
            callback(null, JSON.parse(body));
        } catch {
            callback(new Error("Invalid JSON"));
        }
    });
    req.on("error", callback);
}

const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
        readRequestBody(req, (error, body) => {
            if (error || !body.message || typeof body.message !== "string" || !body.message.trim()) {
                sendJson(res, 400, { error: "Please send a message." });
                return;
            }

            sendJson(res, 200, { reply: createReply(body.message.trim()) });
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
});