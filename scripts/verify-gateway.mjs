import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { io } from "socket.io-client";

function waitFor(fn, timeoutMs = 12000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, stepMs);
  });
}

async function main() {
  const gatewayPort = 3800 + Math.floor(Math.random() * 300);
  const workerBase = 4400 + Math.floor(Math.random() * 300);
  const gateway = spawn(process.execPath, ["gateway.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      WORKER_PORT_BASE: String(workerBase),
      WORKER_PORT_MAX: String(workerBase + 40)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let gatewayReady = false;
  let gatewayLog = "";
  gateway.stdout.on("data", (chunk) => {
    const text = String(chunk);
    gatewayLog += text;
    if (text.includes("Gateway running on")) {
      gatewayReady = true;
    }
  });
  gateway.stderr.on("data", (chunk) => {
    gatewayLog += String(chunk);
  });

  let gatewaySocket = null;
  let workerSocket = null;
  try {
    await waitFor(() => gatewayReady, 15000);

    gatewaySocket = io(`http://localhost:${gatewayPort}`, {
      transports: ["websocket"],
      timeout: 6000,
      reconnection: false
    });
    await waitFor(() => gatewaySocket.connected, 10000);

    const redirect = await new Promise((resolve) => {
      gatewaySocket.emit("room:quick-join", { name: "VERIFY" }, (response = {}) => {
        resolve(response?.redirect ?? null);
      });
    });
    if (!redirect?.endpoint || !redirect?.token) {
      throw new Error("gateway redirect payload missing");
    }

    workerSocket = io(redirect.endpoint, {
      transports: ["websocket"],
      timeout: 6000,
      reconnection: false,
      auth: {
        token: redirect.token
      }
    });
    await waitFor(() => workerSocket.connected, 10000);

    let sawRoomUpdate = false;
    workerSocket.on("room:update", () => {
      sawRoomUpdate = true;
    });
    workerSocket.emit("room:quick-join", { name: "VERIFY" });
    await waitFor(() => sawRoomUpdate, 8000);

    console.log("[verify:gateway] redirect flow passed");
  } catch (error) {
    console.error("[verify:gateway] failed");
    console.error(String(error?.stack ?? error));
    console.error(gatewayLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    gatewaySocket?.disconnect();
    workerSocket?.disconnect();
    if (!gateway.killed) {
      gateway.kill();
    }
    await sleep(120);
  }
}

main();

