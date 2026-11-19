#!/usr/bin/env node
/**
 * Antigravity Sidecar Web Server for the Codex-style Context Usage Gauge.
 * Zero external dependencies — serves the minimalist circular gauge UI and
 * exposes a fast JSON endpoint (/api/usage) backed by local transcript.jsonl files.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
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
const MAX_LIST_SESSIONS = 12;

function loadPreloadJs() {
  const candidates = [];
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    candidates.push(path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, "lib", "node_modules", "sidecar_sdk", "preload.js"));
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    let dir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    for (let i = 0; i < 6; i += 1) {
      if (path.basename(dir) === "sidecar_data") {
        candidates.push(path.join(path.dirname(dir), "lib", "node_modules", "sidecar_sdk", "preload.js"));
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  candidates.push(path.join(os.homedir(), ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js"));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8");
      }
    } catch {
      // Ignore unreadable candidates
    }
  }
  return "// Antigravity sidecar preload stub\n";
}

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
 * @param {{ appDataDir?: string | null }} [config]
 */
export function createSidecarServer(config = {}) {
  const preloadJs = loadPreloadJs();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (pathname === "/healthz" || pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/preload.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(preloadJs);
      return;
    }

    if (pathname === "/" || pathname === "/index.html" || pathname === "/ui.html") {
      const uiHtml = fs.readFileSync(UI_HTML_PATH, "utf8");
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

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  // Short keep-alive timeout so proxy connections recycle cleanly.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;

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
    console.log(`[sidecar] listening on 127.0.0.1:${actualPort}`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startMain();
}
