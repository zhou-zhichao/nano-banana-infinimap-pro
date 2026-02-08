#!/usr/bin/env node
const { spawn } = require("node:child_process");

const nextArg = process.argv[2];
if (!nextArg) {
  console.error("Usage: node scripts/next-with-shell.cjs <dev|build|start> [args...]");
  process.exit(1);
}

if (process.platform === "win32") {
  process.env.SHELL = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
}

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
