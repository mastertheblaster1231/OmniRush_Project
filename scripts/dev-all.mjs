import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const children = [
  spawn(npmCommand, ["run", "dev"], {
    cwd: resolve(root, "backend"),
    stdio: "inherit",
    windowsHide: false,
  }),
  spawn(npmCommand, ["run", "dev"], {
    cwd: resolve(root, "frontend"),
    stdio: "inherit",
    windowsHide: false,
  }),
];

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGINT");
  }
  setTimeout(() => process.exit(exitCode), 500);
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(`[dev] failed to start child process: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0) {
      console.error(`[dev] child exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
      shutdown(code ?? 1);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[dev] frontend: http://localhost:5173/index.html");
console.log("[dev] ocean:    http://localhost:5173/ocean.html");
console.log("[dev] backend:  http://localhost:8000/api/health");
