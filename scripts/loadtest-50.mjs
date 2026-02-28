import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { io } from "socket.io-client";

const CLIENTS = Number(process.env.LOAD_CLIENTS ?? 50);
const DURATION_MS = Number(process.env.LOAD_DURATION_MS ?? 12000);
const SYNC_INTERVAL_MS = Number(process.env.LOAD_SYNC_INTERVAL_MS ?? 100);
const CONNECT_TIMEOUT_MS = Number(process.env.LOAD_CONNECT_TIMEOUT_MS ?? 20000);

function waitFor(predicate, timeoutMs = 10000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, stepMs);
  });
}

async function run() {
  const port = 3500 + Math.floor(Math.random() * 2000);
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let ready = false;
  let bootLog = "";
  server.stdout.on("data", (chunk) => {
    const text = String(chunk);
    bootLog += text;
    if (text.includes("Chat server running on")) {
      ready = true;
    }
  });
  server.stderr.on("data", (chunk) => {
    bootLog += String(chunk);
  });

  const clients = [];
  let connected = 0;
  let disconnected = 0;
  let receivedDeltaEvents = 0;
  let receivedDeltaUpdates = 0;
  const startedAt = Date.now();

  try {
    await waitFor(() => ready, 12000);

    for (let i = 0; i < CLIENTS; i += 1) {
      const socket = io(`http://localhost:${port}`, {
        transports: ["websocket"],
        timeout: 6000,
        reconnection: false
      });
      socket.on("connect", () => {
        connected += 1;
      });
      socket.on("disconnect", () => {
        disconnected += 1;
      });
      socket.on("player:delta", (payload = {}) => {
        receivedDeltaEvents += 1;
        const updates = Array.isArray(payload?.updates) ? payload.updates.length : 0;
        receivedDeltaUpdates += updates;
      });
      clients.push(socket);
    }

    await waitFor(() => connected >= CLIENTS, CONNECT_TIMEOUT_MS);

    let tick = 0;
    const emitter = setInterval(() => {
      tick += 1;
      for (let i = 0; i < clients.length; i += 1) {
        const socket = clients[i];
        if (!socket.connected) {
          continue;
        }
        socket.emit("player:sync", {
          x: (i % 10) * 1.5 + (tick % 4) * 0.08,
          y: 1.72,
          z: Math.floor(i / 10) * 1.5,
          yaw: ((tick + i) % 360) * (Math.PI / 180),
          pitch: 0
        });
      }
    }, Math.max(25, SYNC_INTERVAL_MS));

    await sleep(Math.max(4000, DURATION_MS));
    clearInterval(emitter);

    const elapsed = Date.now() - startedAt;
    const updatesPerSecond = elapsed > 0 ? Math.round((receivedDeltaUpdates * 1000) / elapsed) : 0;
    const eventsPerSecond = elapsed > 0 ? Math.round((receivedDeltaEvents * 1000) / elapsed) : 0;

    console.log(
      JSON.stringify(
        {
          ok: true,
          clients: CLIENTS,
          connected,
          disconnected,
          durationMs: DURATION_MS,
          syncIntervalMs: SYNC_INTERVAL_MS,
          receivedDeltaEvents,
          receivedDeltaUpdates,
          deltaEventsPerSecond: eventsPerSecond,
          deltaUpdatesPerSecond: updatesPerSecond
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: String(error?.message ?? error),
          connected,
          disconnected,
          bootLog: bootLog.slice(-1200)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    for (const socket of clients) {
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
    }
    if (!server.killed) {
      server.kill();
    }
    await sleep(120);
  }
}

run();
