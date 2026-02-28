import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { io } from "socket.io-client";

function waitFor(condition, timeoutMs = 12000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
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

function startGateway({
  port,
  workerBase,
  peers,
  instanceId
}) {
  const child = spawn(process.execPath, ["gateway.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      WORKER_PORT_BASE: String(workerBase),
      WORKER_PORT_MAX: String(workerBase + 40),
      GATEWAY_INSTANCE_ID: instanceId,
      GATEWAY_PEERS: peers.join(",")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let ready = false;
  let log = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    log += text;
    if (text.includes("Gateway running on")) {
      ready = true;
    }
  });
  child.stderr.on("data", (chunk) => {
    log += String(chunk);
  });

  return {
    child,
    isReady: () => ready,
    getLog: () => log
  };
}

async function roomQuickJoin(socket, name) {
  return await new Promise((resolve) => {
    socket.emit("room:quick-join", { name }, (response = {}) => resolve(response));
  });
}

async function roomJoin(socket, roomCode, name) {
  return await new Promise((resolve) => {
    socket.emit("room:join", { code: roomCode, name }, (response = {}) => resolve(response));
  });
}

async function main() {
  const g1Port = 3921;
  const g2Port = 3922;
  const g1Base = 4520;
  const g2Base = 4620;

  const g1 = startGateway({
    port: g1Port,
    workerBase: g1Base,
    peers: [`http://127.0.0.1:${g2Port}`],
    instanceId: "gw-a"
  });
  const g2 = startGateway({
    port: g2Port,
    workerBase: g2Base,
    peers: [`http://127.0.0.1:${g1Port}`],
    instanceId: "gw-b"
  });

  let gatewayA = null;
  let gatewayB = null;
  let workerA = null;
  let workerB = null;

  try {
    await waitFor(() => g1.isReady() && g2.isReady(), 20000);

    gatewayA = io(`http://127.0.0.1:${g1Port}`, {
      transports: ["websocket"],
      timeout: 6000,
      reconnection: false
    });
    gatewayB = io(`http://127.0.0.1:${g2Port}`, {
      transports: ["websocket"],
      timeout: 6000,
      reconnection: false
    });

    await Promise.all([
      waitFor(() => gatewayA.connected, 10000),
      waitFor(() => gatewayB.connected, 10000)
    ]);

    const quickJoin = await roomQuickJoin(gatewayA, "ALPHA");
    if (!quickJoin?.ok || !quickJoin?.redirect?.endpoint || !quickJoin?.redirect?.token) {
      throw new Error("gateway A quick-join did not return redirect");
    }

    const roomCode = String(quickJoin.redirect.roomCode ?? "");
    if (!roomCode) {
      throw new Error("roomCode missing from gateway A redirect");
    }

    workerA = io(quickJoin.redirect.endpoint, {
      transports: ["websocket"],
      timeout: 6000,
      reconnection: false,
      auth: {
        token: quickJoin.redirect.token
      }
    });
    await waitFor(() => workerA.connected, 10000);
    workerA.emit("room:quick-join", { name: "ALPHA" });

    // Allow peer cache to refresh once.
    await sleep(1200);

    const crossJoin = await roomJoin(gatewayB, roomCode, "BETA");
    if (!crossJoin?.ok || !crossJoin?.redirect?.endpoint || !crossJoin?.redirect?.token) {
      throw new Error("gateway B room:join did not return redirect");
    }
    if (String(crossJoin.redirect.roomCode ?? "") !== roomCode) {
      throw new Error("cross-gateway redirect room code mismatch");
    }

    workerB = io(crossJoin.redirect.endpoint, {
      transports: ["websocket"],
      timeout: 6000,
      reconnection: false,
      auth: {
        token: crossJoin.redirect.token
      }
    });
    await waitFor(() => workerB.connected, 10000);

    let roomPlayerCount = 0;
    workerA.on("room:update", (room = {}) => {
      const players = Array.isArray(room?.players) ? room.players.length : 0;
      roomPlayerCount = Math.max(roomPlayerCount, players);
    });
    workerB.emit("room:quick-join", { name: "BETA" });
    await waitFor(() => roomPlayerCount >= 2, 10000);

    console.log("[verify:scaleout] multi-gateway room routing passed");
  } catch (error) {
    console.error("[verify:scaleout] failed");
    console.error(String(error?.stack ?? error));
    console.error("[gw-a log tail]");
    console.error(g1.getLog().slice(-1800));
    console.error("[gw-b log tail]");
    console.error(g2.getLog().slice(-1800));
    process.exitCode = 1;
  } finally {
    gatewayA?.disconnect();
    gatewayB?.disconnect();
    workerA?.disconnect();
    workerB?.disconnect();
    if (!g1.child.killed) {
      g1.child.kill();
    }
    if (!g2.child.killed) {
      g2.child.kill();
    }
    await sleep(180);
  }
}

main();

