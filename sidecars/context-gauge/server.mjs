#!/usr/bin/env node
/**
 * Antigravity Sidecar Web Server for the Codex-style Context Usage Gauge.
 * Zero external dependencies — serves the minimalist circular gauge UI and
 * streams real-time transcript.jsonl updates over Server-Sent Events (SSE).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverBrainDirs,
  discoverConversations,
  findConversation,
  parseLimitArg,
  parseTranscriptContent,
} from "../../skills/context-usage/scripts/context-usage.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_HTML_PATH = path.join(__dirname, "ui.html");

const DEFAULT_POLL_INTERVAL_MS = 1500;
const MAX_LIST_SESSIONS = 12;

/**
 * Build the current usage snapshot for the requested conversation & limit.
 * @param {{ conversationId?: string | null, limitRaw?: string | null, appDataDir?: string | null }} options
 */
export function buildUsageSnapshot(options = {}) {
  let customLimit = null;
  if (options.limitRaw && options.limitRaw !== "auto") {
    customLimit = parseLimitArg(options.limitRaw);
  }

  const brainDirs = discoverBrainDirs(options.appDataDir || null);
  const conversations = discoverConversations(brainDirs);

  if (conversations.length === 0) {
    return {
      current: null,
      sessions: [],
      serverTime: new Date().toISOString(),
    };
  }

  let target = conversations[0];
  if (options.conversationId) {
    try {
      target = findConversation(conversations, options.conversationId);
    } catch {
      // Fallback to latest active conversation if requested ID isn't created on disk yet.
      target = conversations[0];
    }
  }

  const readReport = (conv) => {
    const raw = fs.readFileSync(conv.transcriptPath, "utf8");
    return parseTranscriptContent(raw, {
      conversationId: conv.conversationId,
      transcriptPath: conv.transcriptPath,
      customLimit,
    });
  };

  const current = readReport(target);
  const sessions = conversations.slice(0, MAX_LIST_SESSIONS).map((conv) => {
    if (conv.conversationId === target.conversationId) return current;
    return readReport(conv);
  });

  return {
    current,
    sessions,
    serverTime: new Date().toISOString(),
  };
}

/**
 * Create the HTTP server for the Context Gauge sidecar.
 * @param {{ appDataDir?: string | null, pollIntervalMs?: number }} [config]
 */
export function createSidecarServer(config = {}) {
  const uiHtml = fs.readFileSync(UI_HTML_PATH, "utf8");
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sseClients = new Set();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (pathname === "/healthz" || pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/" || pathname === "/index.html" || pathname === "/ui.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(uiHtml);
      return;
    }

    if (pathname === "/api/usage") {
      try {
        const snapshot = buildUsageSnapshot({
          conversationId: reqUrl.searchParams.get("conversationId"),
          limitRaw: reqUrl.searchParams.get("limit"),
          appDataDir: config.appDataDir || null,
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(snapshot));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname === "/api/events") {
      const conversationId = reqUrl.searchParams.get("conversationId");
      const limitRaw = reqUrl.searchParams.get("limit");

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");

      let lastFingerprint = "";
      const pushIfChanged = (force = false) => {
        if (res.writableEnded || res.destroyed) return;
        try {
          const snapshot = buildUsageSnapshot({
            conversationId,
            limitRaw,
            appDataDir: config.appDataDir || null,
          });
          const cur = snapshot.current;
          const fingerprint = cur
            ? `${cur.conversationId}:${cur.contextTokens}:${cur.contextLimit}:${cur.totalSteps}:${cur.compactionCount}:${snapshot.sessions.length}`
            : "empty";
          if (force || fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
          }
        } catch {
          // Ignore transient read errors during active writes.
        }
      };

      pushIfChanged(true);
      const timer = setInterval(() => pushIfChanged(false), pollIntervalMs);
      const client = { res, timer };
      sseClients.add(client);

      req.on("close", () => {
        clearInterval(timer);
        sseClients.delete(client);
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  server.on("close", () => {
    for (const client of sseClients) {
      clearInterval(client.timer);
      if (!client.res.writableEnded) {
        client.res.end();
      }
    }
    sseClients.clear();
  });

  return server;
}

function startMain() {
  const portEnv = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || "0";
  const port = Number.parseInt(portEnv, 10);
  const listenPort = Number.isNaN(port) ? 0 : port;

  const server = createSidecarServer();

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, shutdown);
  }

  server.on("error", (err) => {
    console.error(`Context Gauge sidecar failed to bind port ${listenPort}: ${err.message}`);
    process.exit(1);
  });

  server.listen(listenPort, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : listenPort;
    console.error(`Context Gauge sidecar listening on http://127.0.0.1:${actualPort}`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startMain();
}
