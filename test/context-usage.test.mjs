import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  extractPromptTitle,
  formatListReport,
  formatSingleReport,
  parseLimitArg,
  parseTranscriptContent,
  resolveContextLimit,
} from "../skills/context-usage/scripts/context-usage.mjs";
import { createSidecarServer } from "../sidecars/context-gauge/server.mjs";
import { syncPlugin } from "../scripts/sync-plugin.mjs";

describe("parseLimitArg", () => {
  it("parses plain integers and k/m suffixes", () => {
    assert.equal(parseLimitArg("200k"), 200_000);
    assert.equal(parseLimitArg("1M"), 1_000_000);
    assert.equal(parseLimitArg("1.5m"), 1_500_000);
    assert.equal(parseLimitArg("128,000"), 128_000);
    assert.equal(parseLimitArg(256000), 256_000);
  });

  it("rejects invalid values", () => {
    assert.throws(() => parseLimitArg("0"));
    assert.throws(() => parseLimitArg("-100"));
    assert.throws(() => parseLimitArg("abc"));
  });
});

describe("resolveContextLimit", () => {
  it("infers limits by model family and respects custom override", () => {
    assert.deepEqual(resolveContextLimit("gemini-4-neon-high"), { limit: 1_000_000, source: "model" });
    assert.deepEqual(resolveContextLimit("claude-sonnet-4"), { limit: 200_000, source: "model" });
    assert.deepEqual(resolveContextLimit("claude-sonnet-4-1m"), { limit: 1_000_000, source: "model" });
    assert.deepEqual(resolveContextLimit("gpt-4o"), { limit: 128_000, source: "model" });
    assert.deepEqual(resolveContextLimit(""), { limit: 1_000_000, source: "default" });
    assert.deepEqual(resolveContextLimit("gemini-4-neon-high", 256_000), { limit: 256_000, source: "custom" });
  });
});

describe("extractPromptTitle", () => {
  it("strips USER_REQUEST wrapper and trims cleanly", () => {
    const raw = `<USER_REQUEST>\n查看当前会话上下文占用\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>`;
    assert.equal(extractPromptTitle(raw), "查看当前会话上下文占用");
  });
});

describe("parseTranscriptContent", () => {
  it("computes contextTokens as input_tokens + cache_read_tokens and tracks checkpoints", () => {
    const sample = [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-19T08:00:00Z",
        content: "<USER_REQUEST>\n测试上下文计算\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-19T08:00:02Z",
        model: "gemini-4-neon-high",
        input_tokens: 30_000,
        cache_read_tokens: 0,
        output_tokens: 500,
      }),
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-19T08:01:00Z",
        model: "gemini-4-neon-high",
        input_tokens: 5_000,
        cache_read_tokens: 250_000,
        output_tokens: 800,
      }),
      JSON.stringify({
        step_index: 3,
        type: "CHECKPOINT",
        created_at: "2026-11-19T08:02:00Z",
      }),
      JSON.stringify({
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-19T08:02:10Z",
        model: "gemini-4-neon-high",
        input_tokens: 2_500,
        cache_read_tokens: 24_500,
        output_tokens: 300,
      }),
      // Simulated half-written trailing JSON line should be safely ignored
      '{"step_index":5,"type":"PLANNER_RESPO',
    ].join("\n");

    const report = parseTranscriptContent(sample, {
      conversationId: "abcdef12-3456-7890-abcd-ef1234567890",
    });

    assert.equal(report.title, "测试上下文计算");
    assert.equal(report.model, "gemini-4-neon-high");
    assert.equal(report.contextTokens, 27_000);
    assert.equal(report.contextLimit, 1_000_000);
    assert.equal(report.usagePercent, 2.7);
    assert.equal(report.remainingTokens, 973_000);
    assert.equal(report.peakContextTokens, 27_000);
    assert.equal(report.allTimePeakContextTokens, 255_000);
    assert.equal(report.compactionCount, 1);
    assert.equal(report.status, "ok");
    assert.equal(report.hasTokenData, true);

    const formatted = formatSingleReport(report);
    assert.match(formatted, /27,000 \/ 1,000,000 tokens \(2\.7%\)/);
    assert.match(formatted, /已压缩 1 次/);
  });

  it("flags high usage (>= 80%) and suggests /compact", () => {
    const sample = JSON.stringify({
      step_index: 10,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-19T08:10:00Z",
      model: "claude-sonnet-4",
      input_tokens: 10_000,
      cache_read_tokens: 160_000,
      output_tokens: 400,
    });

    const report = parseTranscriptContent(sample, { conversationId: "11112222-aaaa" });
    assert.equal(report.contextTokens, 170_000);
    assert.equal(report.contextLimit, 200_000);
    assert.equal(report.usagePercent, 85);
    assert.equal(report.status, "high");

    const formatted = formatSingleReport(report);
    assert.match(formatted, /\/compact/);

    const listText = formatListReport([report]);
    assert.match(listText, /11112222/);
    assert.match(listText, /85\.0%/);
  });

  it("handles brand-new transcript with no planner steps gracefully", () => {
    const sample = JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      created_at: "2026-11-19T08:00:00Z",
      content: "hello",
    });
    const report = parseTranscriptContent(sample, { conversationId: "00001111" });
    assert.equal(report.contextTokens, 0);
    assert.equal(report.hasTokenData, false);
  });
});

describe("sidecar HTTP server", () => {
  it("serves UI HTML, /healthz, and /api/usage from a temporary brain dir", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-test-"));
    const convId = "12345678-1111-2222-3333-444455556666";
    const logDir = path.join(tmpRoot, "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          created_at: "2026-11-19T08:00:00Z",
          content: "<USER_REQUEST>\n侧边栏测试会话\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-19T08:00:05Z",
          model: "gemini-4-neon-high",
          input_tokens: 12_000,
          cache_read_tokens: 88_000,
          output_tokens: 400,
        }),
      ].join("\n"),
      "utf8"
    );

    const server = createSidecarServer({ appDataDir: tmpRoot, pollIntervalMs: 500 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
      const healthRes = await fetch(`${base}/healthz`);
      assert.equal(healthRes.status, 200);
      assert.deepEqual(await healthRes.json(), { ok: true });

      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.match(html, /ringProgress/);

      const usageRes = await fetch(`${base}/api/usage?conversationId=${convId}&limit=200k`);
      assert.equal(usageRes.status, 200);
      const payload = await usageRes.json();
      assert.equal(payload.current.conversationId, convId);
      assert.equal(payload.current.contextTokens, 100_000);
      assert.equal(payload.current.contextLimit, 200_000);
      assert.equal(payload.current.usagePercent, 50);
      assert.equal(payload.current.title, "侧边栏测试会话");
      assert.equal(payload.sessions.length, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("syncPlugin installer", () => {
  it("sets sidecar command to node.exe on win32 and node on unix", () => {
    const tmpWin = fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-sync-win-"));
    const tmpUnix = fs.mkdtempSync(path.join(os.tmpdir(), "ag-ctx-sync-unix-"));
    try {
      syncPlugin({ target: tmpWin, platform: "win32", dryRun: false, uninstall: false });
      const winManifest = JSON.parse(
        fs.readFileSync(path.join(tmpWin, "sidecars", "context-gauge", "sidecar.json"), "utf8")
      );
      assert.equal(winManifest.command, "node.exe");

      syncPlugin({ target: tmpUnix, platform: "darwin", dryRun: false, uninstall: false });
      const unixManifest = JSON.parse(
        fs.readFileSync(path.join(tmpUnix, "sidecars", "context-gauge", "sidecar.json"), "utf8")
      );
      assert.equal(unixManifest.command, "node");
    } finally {
      fs.rmSync(tmpWin, { recursive: true, force: true });
      fs.rmSync(tmpUnix, { recursive: true, force: true });
    }
  });
});
