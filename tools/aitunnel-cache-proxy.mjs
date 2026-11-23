import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = 4000;
const UPSTREAM = "https://api.aitunnel.ru/v1";
const CACHE_DIR = path.resolve(".opencode/llm-cache");
const STATS_FILE = path.resolve(".opencode/cache-stats.json");

fs.mkdirSync(CACHE_DIR, { recursive: true });

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch {
    return { hits: 0, misses: 0, savedPromptTokens: 0, savedCompletionTokens: 0 };
  }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function makeCacheKey(urlPath, bodyObj) {
  const payload = JSON.stringify({
    urlPath,
    model: bodyObj.model,
    messages: bodyObj.messages,
    tools: bodyObj.tools,
    tool_choice: bodyObj.tool_choice,
    reasoning_effort: bodyObj.reasoning_effort,
    temperature: bodyObj.temperature ?? 0,
    response_format: bodyObj.response_format
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const cleanPath = req.url.replace(/^\/v1/, "");
    const bypass = req.headers["x-cache-bypass"] === "1";

    let bodyObj = null;
    let cacheFile = null;

    if (req.method === "POST" && rawBody && !bypass) {
      try {
        bodyObj = JSON.parse(rawBody);
        const key = makeCacheKey(cleanPath, bodyObj);
        cacheFile = path.join(CACHE_DIR, key + ".json");

        if (fs.existsSync(cacheFile)) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
          const stats = loadStats();
          stats.hits += 1;
          stats.savedPromptTokens += cached.usage?.prompt_tokens || 0;
          stats.savedCompletionTokens += cached.usage?.completion_tokens || 0;
          saveStats(stats);

          res.writeHead(200, {
            "Content-Type": cached.contentType,
            "X-Local-Cache": "HIT"
          });
          res.end(cached.body);
          return;
        }
      } catch {}
    }

    const upstreamUrl = new URL(UPSTREAM + cleanPath);
    const forwardHeaders = {
      "Content-Type": req.headers["content-type"] || "application/json",
      "Authorization": req.headers["authorization"] || ""
    };
    if (req.headers["http-referer"]) forwardHeaders["HTTP-Referer"] = req.headers["http-referer"];
    if (req.headers["x-title"]) forwardHeaders["X-Title"] = req.headers["x-title"];

    const proxyReq = https.request(
      {
        hostname: upstreamUrl.hostname,
        port: 443,
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers: forwardHeaders
      },
      (proxyRes) => {
        const contentType = proxyRes.headers["content-type"] || "application/json";
        res.writeHead(proxyRes.statusCode || 502, {
          "Content-Type": contentType,
          "X-Local-Cache": "MISS"
        });

        const respChunks = [];
        proxyRes.on("data", (chunk) => {
          respChunks.push(chunk);
          res.write(chunk);
        });

        proxyRes.on("end", () => {
          res.end();
          if (proxyRes.statusCode === 200 && cacheFile && respChunks.length > 0) {
            const fullResp = Buffer.concat(respChunks).toString("utf8");
            let usage = null;
            try {
              if (!contentType.includes("text/event-stream")) {
                usage = JSON.parse(fullResp).usage || null;
              }
            } catch {}

            fs.writeFileSync(
              cacheFile,
              JSON.stringify({
                createdAt: new Date().toISOString(),
                model: bodyObj?.model,
                contentType,
                usage,
                body: fullResp
              })
            );
            const stats = loadStats();
            stats.misses += 1;
            saveStats(stats);
          }
        });
      }
    );

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "AITunnel proxy error: " + err.message } }));
    });

    if (rawBody) proxyReq.write(rawBody);
    proxyReq.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[AITunnel Cache Proxy] Listening on http://127.0.0.1:" + PORT + "/v1");
});
