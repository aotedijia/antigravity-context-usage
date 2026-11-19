#!/usr/bin/env node
/**
 * Antigravity Context Usage Inspector
 * Zero-dependency CLI that reads Antigravity transcript.jsonl files
 * and reports exact conversation context occupancy (input_tokens + cache_read_tokens).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONTEXT_LIMIT = 1_000_000;
const TRANSCRIPT_REL_PATH = path.join(".system_generated", "logs", "transcript.jsonl");
const APP_DIR_CANDIDATES = ["antigravity", "antigravity-ide", "antigravity-cli"];

/**
 * Parse a human-friendly token limit string such as "200k", "1m", "128000", "1,000,000".
 * @param {string | number} raw
 * @returns {number}
 */
export function parseLimitArg(raw) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error(`Invalid --limit value: ${raw}`);
    }
    return Math.round(raw);
  }
  const cleaned = String(raw).trim().toLowerCase().replace(/[_,]/g, "");
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    throw new Error(`Invalid --limit value "${raw}". Use a positive integer or shorthand like 200k, 1m.`);
  }
  const base = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  const value = Math.round(base * multiplier);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --limit value: ${raw}`);
  }
  return value;
}

/**
 * Resolve model context window limit in tokens.
 * @param {string | null | undefined} model
 * @param {number | null | undefined} customLimit
 * @returns {{ limit: number, source: "custom" | "model" | "default" }}
 */
export function resolveContextLimit(model, customLimit = null) {
  if (customLimit != null) {
    return { limit: customLimit, source: "custom" };
  }
  const normalized = (model || "").trim().toLowerCase();
  if (!normalized) {
    return { limit: DEFAULT_CONTEXT_LIMIT, source: "default" };
  }
  if (normalized.includes("gemini")) {
    return { limit: 1_000_000, source: "model" };
  }
  if (normalized.includes("claude")) {
    if (normalized.includes("1m")) {
      return { limit: 1_000_000, source: "model" };
    }
    return { limit: 200_000, source: "model" };
  }
  if (/gpt-4\.1/.test(normalized)) {
    return { limit: 1_000_000, source: "model" };
  }
  if (/gpt-5/.test(normalized)) {
    return { limit: 400_000, source: "model" };
  }
  if (/gpt-4o/.test(normalized)) {
    return { limit: 128_000, source: "model" };
  }
  if (/\bo[134](?:-|$)/.test(normalized)) {
    return { limit: 200_000, source: "model" };
  }
  return { limit: DEFAULT_CONTEXT_LIMIT, source: "default" };
}

/**
 * Extract a short readable prompt title from the first USER_INPUT content.
 * @param {string} raw
 * @returns {string}
 */
export function extractPromptTitle(raw) {
  if (!raw || typeof raw !== "string") return "";
  let text = raw;
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
    text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "");
  }
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 48) return singleLine;
  return `${singleLine.slice(0, 47)}…`;
}

/**
 * Parse a transcript.jsonl string into focused context-usage statistics.
 * Context occupancy for a step is `input_tokens + cache_read_tokens`.
 * @param {string} content
 * @param {{ conversationId?: string, transcriptPath?: string, customLimit?: number | null }} [options]
 */
export function parseTranscriptContent(content, options = {}) {
  const lines = content.split(/\r?\n/);
  let totalSteps = 0;
  let title = "";
  let model = null;
  let compactionCount = 0;
  let lastCheckpointAt = null;
  let lastCheckpointStep = null;

  let currentSegmentPeak = 0;
  let allTimePeak = 0;
  let latest = null;
  let lastTimestamp = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let step;
    try {
      step = JSON.parse(line);
    } catch {
      // Ignore partially written trailing JSONL line during active turns.
      continue;
    }

    totalSteps += 1;
    if (step.created_at) {
      lastTimestamp = step.created_at;
    }

    if (!title && step.type === "USER_INPUT" && typeof step.content === "string") {
      title = extractPromptTitle(step.content);
    }

    if (step.type === "CHECKPOINT") {
      compactionCount += 1;
      lastCheckpointAt = step.created_at || null;
      lastCheckpointStep = typeof step.step_index === "number" ? step.step_index : null;
      currentSegmentPeak = 0;
      continue;
    }

    const hasInput = typeof step.input_tokens === "number" && Number.isFinite(step.input_tokens);
    const hasCache = typeof step.cache_read_tokens === "number" && Number.isFinite(step.cache_read_tokens);
    if (hasInput || hasCache) {
      const inputTokens = hasInput ? step.input_tokens : 0;
      const cacheReadTokens = hasCache ? step.cache_read_tokens : 0;
      const outputTokens =
        typeof step.output_tokens === "number" && Number.isFinite(step.output_tokens)
          ? step.output_tokens
          : 0;
      const contextTokens = inputTokens + cacheReadTokens;

      if (step.model && typeof step.model === "string") {
        model = step.model;
      }
      if (contextTokens > currentSegmentPeak) {
        currentSegmentPeak = contextTokens;
      }
      if (contextTokens > allTimePeak) {
        allTimePeak = contextTokens;
      }

      latest = {
        stepIndex: typeof step.step_index === "number" ? step.step_index : null,
        createdAt: step.created_at || null,
        model: step.model || model || null,
        contextTokens,
        inputTokens,
        cacheReadTokens,
        outputTokens,
      };
    }
  }

  const { limit: contextLimit, source: limitSource } = resolveContextLimit(model, options.customLimit ?? null);
  const contextTokens = latest ? latest.contextTokens : 0;
  const remainingTokens = Math.max(0, contextLimit - contextTokens);
  const usageRatio = contextLimit > 0 ? contextTokens / contextLimit : 0;
  const usagePercent = Math.round(usageRatio * 1000) / 10; // 1 decimal place

  let status = "ok";
  if (usagePercent >= 80) {
    status = "high";
  } else if (usagePercent >= 60) {
    status = "warn";
  }

  return {
    conversationId: options.conversationId || "",
    transcriptPath: options.transcriptPath || "",
    title,
    model,
    contextTokens,
    contextLimit,
    limitSource,
    usagePercent,
    remainingTokens,
    peakContextTokens: currentSegmentPeak,
    allTimePeakContextTokens: allTimePeak,
    compactionCount,
    lastCheckpointStep,
    lastCheckpointAt,
    status,
    stepIndex: latest ? latest.stepIndex : null,
    totalSteps,
    updatedAt: latest?.createdAt || lastTimestamp || null,
    hasTokenData: latest !== null,
  };
}

/**
 * Discover candidate Antigravity brain directories.
 * @param {string | null} explicitAppDataDir
 * @returns {string[]}
 */
export function discoverBrainDirs(explicitAppDataDir = null) {
  const candidates = [];
  if (explicitAppDataDir) {
    const resolved = path.resolve(explicitAppDataDir);
    candidates.push(path.basename(resolved) === "brain" ? resolved : path.join(resolved, "brain"));
  } else if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    const resolved = path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR);
    candidates.push(path.basename(resolved) === "brain" ? resolved : path.join(resolved, "brain"));
  } else {
    const geminiRoot = path.join(os.homedir(), ".gemini");
    for (const appName of APP_DIR_CANDIDATES) {
      candidates.push(path.join(geminiRoot, appName, "brain"));
    }
  }

  const unique = [];
  const seen = new Set();
  for (const dir of candidates) {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        unique.push(dir);
      }
    } catch {
      // Ignore inaccessible directories
    }
  }
  return unique;
}

/**
 * List all conversations that contain a transcript.jsonl, sorted by mtime desc.
 * @param {string[]} brainDirs
 * @returns {Array<{ conversationId: string, transcriptPath: string, mtimeMs: number }>}
 */
export function discoverConversations(brainDirs) {
  const results = [];
  const seenIds = new Set();

  for (const brainDir of brainDirs) {
    let entries;
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transcriptPath = path.join(brainDir, entry.name, TRANSCRIPT_REL_PATH);
      if (!fs.existsSync(transcriptPath)) continue;
      if (seenIds.has(entry.name)) continue;
      try {
        const stat = fs.statSync(transcriptPath);
        seenIds.add(entry.name);
        results.push({
          conversationId: entry.name,
          transcriptPath,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/**
 * Find a conversation by exact ID or unambiguous prefix.
 * @param {Array<{ conversationId: string, transcriptPath: string, mtimeMs: number }>} conversations
 * @param {string} targetId
 */
export function findConversation(conversations, targetId) {
  const needle = targetId.trim().toLowerCase();
  const exact = conversations.find((c) => c.conversationId.toLowerCase() === needle);
  if (exact) return exact;

  const prefixMatches = conversations.filter((c) => c.conversationId.toLowerCase().startsWith(needle));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw new Error(
      `会话 ID 前缀 "${targetId}" 匹配到多个会话: ${prefixMatches.map((c) => c.conversationId).join(", ")}`
    );
  }
  throw new Error(`未找到会话 "${targetId}" 的 transcript.jsonl。`);
}

function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
}

function formatCompactTokens(n) {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    return `${Number.isInteger(val) ? val : val.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    return `${val >= 100 ? Math.round(val) : val.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(n);
}

function renderProgressBar(percent, width = 20) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function statusBadge(status) {
  if (status === "high") return "🔴 紧张";
  if (status === "warn") return "🟡 偏高";
  return "🟢 充裕";
}

function formatTimestamp(isoString) {
  if (!isoString) return "-";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Format a single conversation report for terminal / chat presentation.
 * Focused strictly on context occupancy.
 */
export function formatSingleReport(report) {
  const shortId = report.conversationId ? report.conversationId.slice(0, 8) : "-";
  const pctStr = `${report.usagePercent.toFixed(1)}%`;
  const bar = renderProgressBar(report.usagePercent, 20);
  const limitHint =
    report.limitSource === "custom"
      ? "（自定义上限）"
      : report.limitSource === "default"
        ? "（默认上限，可用 --limit 指定）"
        : "";

  const lines = [
    `上下文占用: ${formatNumber(report.contextTokens)} / ${formatNumber(report.contextLimit)} tokens (${pctStr})${limitHint}`,
    `进度条:     ${bar} ${pctStr}  ${statusBadge(report.status)}`,
    `剩余空间:   ${formatNumber(report.remainingTokens)} tokens`,
  ];

  if (report.compactionCount > 0) {
    lines.push(
      `本段峰值:   ${formatNumber(report.peakContextTokens)} tokens（历史最高 ${formatNumber(report.allTimePeakContextTokens)}，已压缩 ${report.compactionCount} 次）`
    );
  } else {
    lines.push(`当前峰值:   ${formatNumber(report.peakContextTokens)} tokens`);
  }

  const metaParts = [shortId];
  if (report.model) metaParts.push(`模型: ${report.model}`);
  metaParts.push(`步骤: ${report.totalSteps}`);
  if (report.updatedAt) metaParts.push(`更新: ${formatTimestamp(report.updatedAt)}`);
  lines.push(`会话信息:   ${metaParts.join(" | ")}`);

  if (!report.hasTokenData) {
    lines.push("说明:       当前会话尚未记录模型响应的 Token 用量。");
  } else if (report.status === "high") {
    lines.push("提示:       上下文占用已达 80% 以上，建议执行 /compact 压缩上下文。");
  }

  return lines.join("\n");
}

/**
 * Format a concise multi-conversation context occupancy table.
 */
export function formatListReport(reports) {
  if (reports.length === 0) {
    return "未找到包含 transcript.jsonl 的会话记录。";
  }

  const header = "| 会话 | 上下文占用 | 占比 | 状态 | 压缩 | 最近更新 | 主题 |";
  const sep = "| :--- | ---: | ---: | :---: | ---: | :--- | :--- |";
  const rows = reports.map((r) => {
    const shortId = r.conversationId.slice(0, 8);
    const used = `${formatCompactTokens(r.contextTokens)} / ${formatCompactTokens(r.contextLimit)}`;
    const pct = `${r.usagePercent.toFixed(1)}%`;
    const badge = statusBadge(r.status);
    const compact = r.compactionCount > 0 ? `${r.compactionCount}次` : "-";
    const updated = formatTimestamp(r.updatedAt);
    const title = (r.title || "-").replace(/\|/g, "\\|");
    return `| \`${shortId}\` | ${used} | ${pct} | ${badge} | ${compact} | ${updated} | ${title} |`;
  });

  return [header, sep, ...rows].join("\n");
}

function parseCliArgs(argv) {
  const opts = {
    conversation: null,
    transcript: null,
    appDataDir: null,
    limit: null,
    list: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--latest") {
      opts.conversation = null;
    } else if (arg === "-c" || arg === "--conversation") {
      opts.conversation = argv[++i] || null;
    } else if (arg.startsWith("--conversation=")) {
      opts.conversation = arg.slice("--conversation=".length);
    } else if (arg === "-t" || arg === "--transcript") {
      opts.transcript = argv[++i] || null;
    } else if (arg.startsWith("--transcript=")) {
      opts.transcript = arg.slice("--transcript=".length);
    } else if (arg === "--app-data-dir") {
      opts.appDataDir = argv[++i] || null;
    } else if (arg.startsWith("--app-data-dir=")) {
      opts.appDataDir = arg.slice("--app-data-dir=".length);
    } else if (arg === "-l" || arg === "--limit") {
      const val = argv[++i];
      if (!val) throw new Error("Missing value for --limit");
      opts.limit = parseLimitArg(val);
    } else if (arg.startsWith("--limit=")) {
      opts.limit = parseLimitArg(arg.slice("--limit=".length));
    } else if (arg === "--list") {
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        opts.list = Number(next);
        i += 1;
      } else {
        opts.list = 8;
      }
    } else if (arg.startsWith("--list=")) {
      const num = Number(arg.slice("--list=".length));
      if (!Number.isInteger(num) || num <= 0) {
        throw new Error(`Invalid --list count: ${arg}`);
      }
      opts.list = num;
    } else if (!arg.startsWith("-") && !opts.conversation) {
      opts.conversation = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Antigravity Context Usage Inspector

Usage:
  node context-usage.mjs [options] [conversation-id]

Options:
  -c, --conversation <id>   Inspect a specific conversation (full UUID or prefix)
  --latest                  Inspect the most recently updated conversation (default)
  --list [N]                List context occupancy for the latest N conversations (default: 8)
  -l, --limit <tokens>      Override context window limit (e.g. 200k, 1m, 1000000)
  -t, --transcript <path>   Inspect a specific transcript.jsonl file directly
  --app-data-dir <path>     Explicit Antigravity app data directory
  --json                    Output structured JSON
  -h, --help                Show this help message`);
}

function readTranscriptFile(transcriptPath, conversationId, customLimit) {
  const content = fs.readFileSync(transcriptPath, "utf8");
  return parseTranscriptContent(content, {
    conversationId,
    transcriptPath,
    customLimit,
  });
}

function runCli() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.transcript) {
    const resolvedPath = path.resolve(opts.transcript);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Transcript file not found: ${resolvedPath}`);
    }
    const inferredId = path.basename(path.resolve(resolvedPath, "..", "..", ".."));
    const report = readTranscriptFile(resolvedPath, opts.conversation || inferredId, opts.limit);
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatSingleReport(report));
    return;
  }

  const brainDirs = discoverBrainDirs(opts.appDataDir);
  if (brainDirs.length === 0) {
    throw new Error("未找到 Antigravity brain 目录，请通过 --app-data-dir 或 --transcript 指定路径。");
  }

  const conversations = discoverConversations(brainDirs);
  if (conversations.length === 0) {
    throw new Error(`在 ${brainDirs.join(", ")} 下未找到任何会话 transcript.jsonl。`);
  }

  if (opts.list !== null) {
    const selected = conversations.slice(0, opts.list);
    const reports = selected.map((c) => readTranscriptFile(c.transcriptPath, c.conversationId, opts.limit));
    console.log(opts.json ? JSON.stringify(reports, null, 2) : formatListReport(reports));
    return;
  }

  const target = opts.conversation
    ? findConversation(conversations, opts.conversation)
    : conversations[0];
  const report = readTranscriptFile(target.transcriptPath, target.conversationId, opts.limit);
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatSingleReport(report));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runCli();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
