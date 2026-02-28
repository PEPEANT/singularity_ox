import { spawn } from "node:child_process";

function run(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    env: process.env
  });

  const prefix = `[${name}]`;
  child.stdout?.on("data", (data) => {
    process.stdout.write(`${prefix} ${String(data)}`);
  });
  child.stderr?.on("data", (data) => {
    process.stderr.write(`${prefix} ${String(data)}`);
  });
  child.on("exit", (code) => {
    process.stdout.write(`${prefix} exited (${code ?? "null"})\n`);
    if (!closing && typeof code === "number" && code !== 0) {
      process.stderr.write(`${prefix} failed, shutting down other process.\n`);
      shutdown(code);
    }
  });

  return child;
}

const shell = process.platform === "win32" ? "cmd.exe" : "sh";
const runCmd = (script) =>
  process.platform === "win32"
    ? ["/d", "/s", "/c", script]
    : ["-lc", script];

const client = run("client", shell, runCmd("npm run dev"));
const server = run("server", shell, runCmd("npm run dev:server"));

let closing = false;
let exitCode = 0;
function shutdown(code = 0) {
  if (closing) {
    return;
  }
  closing = true;
  exitCode = code;

  if (!client.killed) {
    client.kill();
  }
  if (!server.killed) {
    server.kill();
  }

  setTimeout(() => process.exit(exitCode), 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
