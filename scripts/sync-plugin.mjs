#!/usr/bin/env node
/**
 * Syncs the plugin bundle from this source repository into
 * ~/.gemini/config/plugins/context-usage (or a custom --target path).
 *
 * On Windows, Antigravity's built-in "node" wrapper can fail with
 * `'ELECTRON_RUN_AS_NODE' is not recognized`, so this installer rewrites
 * `sidecars/context-gauge/sidecar.json` command to `"node.exe"` on win32.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const BUNDLE_ENTRIES = [
  "plugin.json",
  "README.md",
  "LICENSE",
  "assets",
  "skills",
  "sidecars",
];

function parseArgs(argv) {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8"));
  const defaultTarget = path.join(os.homedir(), ".gemini", "config", "plugins", manifest.name || "context-usage");
  const opts = {
    target: defaultTarget,
    dryRun: false,
    uninstall: false,
    platform: process.platform,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target" && argv[i + 1]) {
      opts.target = path.resolve(argv[++i]);
    } else if (arg.startsWith("--target=")) {
      opts.target = path.resolve(arg.slice("--target=".length));
    } else if (arg === "--platform" && argv[i + 1]) {
      opts.platform = argv[++i];
    } else if (arg.startsWith("--platform=")) {
      opts.platform = arg.slice("--platform=".length);
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--uninstall") {
      opts.uninstall = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: node scripts/sync-plugin.mjs [--target <dir>] [--platform <win32|darwin|linux>] [--dry-run] [--uninstall]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function copyRecursive(src, dst, skipRelPaths = new Set(), relBase = "") {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const nextRel = relBase ? `${relBase}/${entry}` : entry;
      copyRecursive(path.join(src, entry), path.join(dst, entry), skipRelPaths, nextRel);
    }
  } else {
    if (skipRelPaths.has(relBase)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

export function writeSidecarManifestForPlatform(targetDir, platform) {
  const srcPath = path.join(REPO_ROOT, "sidecars", "context-gauge", "sidecar.json");
  const dstPath = path.join(targetDir, "sidecars", "context-gauge", "sidecar.json");
  if (!fs.existsSync(srcPath)) return;
  const manifest = JSON.parse(fs.readFileSync(srcPath, "utf8"));
  manifest.command = platform === "win32" ? "node.exe" : "node";
  const nextContent = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.existsSync(dstPath) && fs.readFileSync(dstPath, "utf8") === nextContent) {
    return;
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, nextContent, "utf8");
}

export function syncPlugin(opts) {
  if (opts.uninstall) {
    if (!fs.existsSync(opts.target)) {
      return { action: "noop", target: opts.target };
    }
    if (opts.dryRun) {
      return { action: "dry-run-uninstall", target: opts.target };
    }
    fs.rmSync(opts.target, { recursive: true, force: true });
    return { action: "uninstalled", target: opts.target };
  }

  if (opts.dryRun) {
    return { action: "dry-run-install", target: opts.target, entries: BUNDLE_ENTRIES };
  }

  const skipRel = new Set(["sidecars/context-gauge/sidecar.json"]);
  fs.mkdirSync(opts.target, { recursive: true });
  for (const entry of BUNDLE_ENTRIES) {
    const src = path.join(REPO_ROOT, entry);
    const dst = path.join(opts.target, entry);
    if (!fs.existsSync(src)) continue;
    // Copy in-place so running sidecar processes holding directory CWD locks on Windows do not fail with EPERM.
    copyRecursive(src, dst, skipRel, entry);
  }

  writeSidecarManifestForPlatform(opts.target, opts.platform);
  return { action: "installed", target: opts.target, entries: BUNDLE_ENTRIES, platform: opts.platform };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = syncPlugin(opts);
    if (result.action === "installed") {
      console.log(`Synced Antigravity plugin to: ${result.target}`);
      console.log(`Included: ${result.entries.join(", ")} (sidecar command: ${result.platform === "win32" ? "node.exe" : "node"})`);
    } else if (result.action === "uninstalled") {
      console.log(`Removed plugin directory: ${result.target}`);
    } else if (result.action === "noop") {
      console.log(`Plugin directory does not exist: ${result.target}`);
    } else {
      console.log(`[dry-run] ${result.action} -> ${result.target}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
