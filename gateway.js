import { createServer } from "http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "socket.io";
import { createRoomJoinToken } from "./src/server/roomToken.js";

const ROOM_CODE_PREFIX = "OX";
const ROOM_CODE_RANDOM_LENGTH = 5;
const MAX_ROOM_PLAYERS = 50;
const MAX_ACTIVE_WORKERS = Number(process.env.MAX_ACTIVE_WORKERS ?? 24);

const GATEWAY_INSTANCE_INDEX = Math.max(
  0,
  Number(process.env.GATEWAY_INSTANCE_INDEX ?? process.env.NODE_APP_INSTANCE ?? 0)
);
const GATEWAY_INSTANCE_ID =
  String(process.env.GATEWAY_INSTANCE_ID ?? "").trim() ||
  `gw-${GATEWAY_INSTANCE_INDEX}-${process.pid}`;

const GATEWAY_PORT = Number(process.env.PORT ?? process.env.GATEWAY_PORT ?? 3001);
const WORKER_PORT_BASE_RAW = Number(process.env.WORKER_PORT_BASE ?? 4100);
const WORKER_PORT_STRIDE = Math.max(
  32,
  Number(process.env.WORKER_PORT_STRIDE ?? MAX_ACTIVE_WORKERS * 8)
);
const WORKER_PORT_BASE = WORKER_PORT_BASE_RAW + GATEWAY_INSTANCE_INDEX * WORKER_PORT_STRIDE;
const WORKER_PORT_MAX = Number(
  process.env.WORKER_PORT_MAX ?? WORKER_PORT_BASE + Math.max(WORKER_PORT_STRIDE - 1, MAX_ACTIVE_WORKERS * 6)
);

const WORKER_BOOT_TIMEOUT_MS = Number(process.env.WORKER_BOOT_TIMEOUT_MS ?? 12000);
const WORKER_HEALTH_TIMEOUT_MS = Number(process.env.WORKER_HEALTH_TIMEOUT_MS ?? 1200);
const WORKER_IDLE_SHUTDOWN_MS = Number(process.env.WORKER_IDLE_SHUTDOWN_MS ?? 180000);
const WORKER_MAINTENANCE_INTERVAL_MS = Number(process.env.WORKER_MAINTENANCE_INTERVAL_MS ?? 10000);

const JOIN_TOKEN_TTL_MS = Number(process.env.ROOM_JOIN_TOKEN_TTL_MS ?? 5 * 60 * 1000);
const ROOM_JOIN_SECRET = String(process.env.ROOM_JOIN_SECRET ?? "dev-room-secret") || "dev-room-secret";
const ROOM_OWNER_KEY = String(process.env.ROOM_OWNER_KEY ?? "").trim();

const PEER_HEALTH_CACHE_TTL_MS = Number(process.env.PEER_HEALTH_CACHE_TTL_MS ?? 3000);
const GATEWAY_DRAIN_TIMEOUT_MS = Number(process.env.GATEWAY_DRAIN_TIMEOUT_MS ?? 60000);

const PUBLIC_GATEWAY_PROTOCOL = String(process.env.GATEWAY_PUBLIC_PROTOCOL ?? "").trim();
const PUBLIC_GATEWAY_HOST = String(process.env.GATEWAY_PUBLIC_HOST ?? "").trim();
const WORKER_PUBLIC_PROTOCOL = String(process.env.WORKER_PUBLIC_PROTOCOL ?? "").trim();
const WORKER_PUBLIC_HOST = String(process.env.WORKER_PUBLIC_HOST ?? "").trim();

const PEER_ORIGINS = parsePeerOrigins(String(process.env.GATEWAY_PEERS ?? ""));
const SELF_ORIGIN = resolveSelfOrigin();
const CLUSTER_PEERS = PEER_ORIGINS.filter((origin) => origin !== SELF_ORIGIN);

const workers = new Map();
const usedPorts = new Set();
const peerCache = new Map();

let gatewayConnections = 0;
let draining = false;
let drainStartedAt = 0;
let shuttingDown = false;
let shutdownPromise = null;

for (const peer of CLUSTER_PEERS) {
  peerCache.set(peer, {
    instanceId: null,
    draining: false,
    rooms: [],
    updatedAt: 0,
    failedAt: 0
  });
}

function parseCorsOrigins(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value || value === "*") {
    return "*";
  }

  const list = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return list.length > 0 ? list : "*";
}

function parsePeerOrigins(raw) {
  return String(raw ?? "")
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);
}

function normalizeOrigin(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    return `http://${normalized}`;
  }
  return normalized;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function ack(ackFn, payload) {
  if (typeof ackFn === "function") {
    ackFn(payload);
  }
}

function sanitizeRoomCode(rawCode) {
  const value = String(rawCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 24);
  return value || null;
}

function sanitizeName(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 16);
  return value || "PLAYER";
}

function hasOwnerAccess(ownerKeyRaw) {
  if (!ROOM_OWNER_KEY) {
    return false;
  }
  return String(ownerKeyRaw ?? "").trim() === ROOM_OWNER_KEY;
}

function isGatewayAcceptingNewMatches() {
  return !draining && !shuttingDown;
}

function resolveSelfOrigin() {
  const protocol = PUBLIC_GATEWAY_PROTOCOL || "http";
  if (PUBLIC_GATEWAY_HOST) {
    return `${protocol}://${PUBLIC_GATEWAY_HOST}`;
  }
  return `http://127.0.0.1:${GATEWAY_PORT}`;
}

function getProtocolForSocket(socket) {
  const forwarded = String(socket?.handshake?.headers?.["x-forwarded-proto"] ?? "").trim();
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  if (PUBLIC_GATEWAY_PROTOCOL) {
    return PUBLIC_GATEWAY_PROTOCOL;
  }
  return "http";
}

function getGatewayHostForSocket(socket) {
  const forwardedHost = String(socket?.handshake?.headers?.["x-forwarded-host"] ?? "").trim();
  const hostHeader = String(socket?.handshake?.headers?.host ?? "").trim();
  const raw = forwardedHost || hostHeader || `localhost:${GATEWAY_PORT}`;
  return raw.split(",")[0].trim();
}

function stripPort(host) {
  if (!host) {
    return host;
  }
  if (host.startsWith("[") && host.includes("]")) {
    const close = host.indexOf("]");
    return host.slice(0, close + 1);
  }
  if (host.includes(":")) {
    return host.slice(0, host.lastIndexOf(":"));
  }
  return host;
}

function resolveWorkerEndpointForSocket(socket, port) {
  const protocol = WORKER_PUBLIC_PROTOCOL || getProtocolForSocket(socket);
  if (WORKER_PUBLIC_HOST) {
    return `${protocol}://${WORKER_PUBLIC_HOST}:${port}`;
  }
  const host = getGatewayHostForSocket(socket);
  const hostOnly = stripPort(host);
  return `${protocol}://${hostOnly}:${port}`;
}

function resolveWorkerEndpointForHealth(port) {
  const protocol = WORKER_PUBLIC_PROTOCOL || PUBLIC_GATEWAY_PROTOCOL || "http";
  if (WORKER_PUBLIC_HOST) {
    return `${protocol}://${WORKER_PUBLIC_HOST}:${port}`;
  }
  if (PUBLIC_GATEWAY_HOST) {
    return `${protocol}://${stripPort(PUBLIC_GATEWAY_HOST)}:${port}`;
  }
  return `http://127.0.0.1:${port}`;
}

function createRoomCode(localReserved = new Set()) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 32; attempt += 1) {
    let suffix = "";
    for (let i = 0; i < ROOM_CODE_RANDOM_LENGTH; i += 1) {
      suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    const code = `${ROOM_CODE_PREFIX}-${suffix}`;
    if (!workers.has(code) && !localReserved.has(code)) {
      return code;
    }
  }
  return `${ROOM_CODE_PREFIX}-${Date.now().toString(36).toUpperCase()}`;
}

function allocateWorkerPort() {
  for (let port = WORKER_PORT_BASE; port <= WORKER_PORT_MAX; port += 1) {
    if (!usedPorts.has(port) && port !== GATEWAY_PORT) {
      return port;
    }
  }
  return null;
}

function getWorkerPlayerCount(workerOrRoom) {
  if (!workerOrRoom) {
    return 0;
  }
  const health = workerOrRoom.lastHealth ?? workerOrRoom;
  const totalPlayers = Number(health.totalPlayers ?? health.count);
  if (Number.isFinite(totalPlayers) && totalPlayers >= 0) {
    return totalPlayers;
  }
  const topRoomPlayers = Number(health?.topRoom?.players);
  if (Number.isFinite(topRoomPlayers) && topRoomPlayers >= 0) {
    return topRoomPlayers;
  }
  return 0;
}

function isRoomJoinable(room) {
  return getWorkerPlayerCount(room) < MAX_ROOM_PLAYERS;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      return null;
    }
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeLocalWorker(worker) {
  if (!worker || !worker.port) {
    return null;
  }
  const payload = await fetchJsonWithTimeout(
    `http://127.0.0.1:${worker.port}/health`,
    WORKER_HEALTH_TIMEOUT_MS
  );
  return payload?.ok ? payload : null;
}

async function refreshLocalWorkerHealth(worker) {
  if (!worker) {
    return null;
  }
  const health = await probeLocalWorker(worker);
  if (!health) {
    return null;
  }
  worker.lastHealth = health;
  worker.lastHealthAt = Date.now();
  if (getWorkerPlayerCount(worker) > 0) {
    worker.lastOccupiedAt = Date.now();
  }
  return health;
}

function removeLocalWorker(worker) {
  if (!worker) {
    return;
  }
  workers.delete(worker.code);
  usedPorts.delete(worker.port);
}

function stopLocalWorker(worker) {
  if (!worker || worker.stopped) {
    return;
  }
  worker.stopped = true;
  try {
    worker.child.kill();
  } catch {
    // ignore
  }
}

function spawnLocalWorker(roomCode) {
  const existing = workers.get(roomCode);
  if (existing) {
    return existing;
  }
  if (workers.size >= MAX_ACTIVE_WORKERS) {
    return null;
  }

  const port = allocateWorkerPort();
  if (!port) {
    return null;
  }

  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      ROOM_WORKER_SINGLE: "1",
      ROOM_CODE: roomCode,
      REQUIRE_JOIN_TOKEN: "1",
      ROOM_JOIN_SECRET,
      CORS_ORIGIN: process.env.CORS_ORIGIN ?? "*"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const worker = {
    code: roomCode,
    port,
    child,
    endpoint: resolveWorkerEndpointForHealth(port),
    createdAt: Date.now(),
    lastAssignedAt: Date.now(),
    lastOccupiedAt: 0,
    lastHealth: null,
    lastHealthAt: 0,
    ready: false,
    stopped: false,
    readyPromise: null
  };
  workers.set(roomCode, worker);
  usedPorts.add(port);

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[worker:${roomCode}] ${String(chunk)}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[worker:${roomCode}] ${String(chunk)}`);
  });
  child.on("exit", () => {
    worker.stopped = true;
    removeLocalWorker(worker);
  });

  worker.readyPromise = waitForWorkerReady(worker).catch((error) => {
    stopLocalWorker(worker);
    removeLocalWorker(worker);
    throw error;
  });

  return worker;
}

async function waitForWorkerReady(worker) {
  const deadline = Date.now() + WORKER_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!worker || worker.stopped) {
      throw new Error("worker stopped");
    }
    const health = await refreshLocalWorkerHealth(worker);
    if (health) {
      worker.ready = true;
      return worker;
    }
    await sleep(200);
  }
  throw new Error("worker boot timeout");
}

async function ensureWorkerReady(worker) {
  if (!worker) {
    return null;
  }
  if (worker.ready) {
    await refreshLocalWorkerHealth(worker).catch(() => null);
    return worker;
  }
  if (worker.readyPromise) {
    await worker.readyPromise;
  } else {
    worker.readyPromise = waitForWorkerReady(worker);
    await worker.readyPromise;
  }
  return worker;
}

function toRoomSummary(room, source = "local") {
  const count = getWorkerPlayerCount(room);
  const endpoint =
    source === "local"
      ? room.endpoint || resolveWorkerEndpointForHealth(room.port)
      : String(room.endpoint ?? "").trim();
  return {
    code: sanitizeRoomCode(room.code),
    count,
    capacity: Number(room.capacity ?? MAX_ROOM_PLAYERS),
    endpoint,
    ready: room.ready !== false,
    createdAt: Number(room.createdAt ?? Date.now()),
    updatedAt: Number(room.updatedAt ?? room.lastHealthAt ?? Date.now()),
    gatewayId: String(room.gatewayId ?? GATEWAY_INSTANCE_ID),
    gatewayOrigin: String(room.gatewayOrigin ?? SELF_ORIGIN),
    source
  };
}

async function collectLocalRooms({ refresh = true } = {}) {
  const summaries = [];
  for (const worker of workers.values()) {
    if (refresh) {
      await refreshLocalWorkerHealth(worker).catch(() => null);
    }
    summaries.push(toRoomSummary(worker, "local"));
  }
  return summaries;
}

function sortRoomsByPriority(rooms) {
  rooms.sort((left, right) => {
    const playersDelta = Number(right.count || 0) - Number(left.count || 0);
    if (playersDelta !== 0) {
      return playersDelta;
    }
    return Number(left.createdAt || 0) - Number(right.createdAt || 0);
  });
  return rooms;
}

async function refreshPeerHealth(peerOrigin, force = false) {
  const cache = peerCache.get(peerOrigin);
  const now = Date.now();
  if (
    !force &&
    cache &&
    now - Number(cache.updatedAt || 0) < PEER_HEALTH_CACHE_TTL_MS
  ) {
    return cache;
  }

  const payload = await fetchJsonWithTimeout(
    `${peerOrigin}/health?scope=local`,
    WORKER_HEALTH_TIMEOUT_MS + 800
  );
  if (!payload?.ok) {
    if (cache) {
      cache.failedAt = now;
    }
    return cache ?? {
      instanceId: null,
      draining: false,
      rooms: [],
      updatedAt: 0,
      failedAt: now
    };
  }

  const rawRooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const normalizedRooms = rawRooms
    .map((entry) =>
      toRoomSummary(
        {
          ...entry,
          gatewayId: payload.instanceId ?? entry.gatewayId,
          gatewayOrigin: payload.gatewayOrigin ?? entry.gatewayOrigin,
          capacity: entry.capacity ?? payload.capacityPerRoom
        },
        "peer"
      )
    )
    .filter((entry) => Boolean(entry.code && entry.endpoint));

  const nextCache = {
    instanceId: String(payload.instanceId ?? ""),
    draining: payload.draining === true,
    rooms: normalizedRooms,
    updatedAt: now,
    failedAt: 0
  };
  peerCache.set(peerOrigin, nextCache);
  return nextCache;
}

async function refreshAllPeers(force = false) {
  const tasks = [];
  for (const peer of CLUSTER_PEERS) {
    tasks.push(refreshPeerHealth(peer, force));
  }
  await Promise.all(tasks);
}

async function collectClusterRooms({ forcePeerRefresh = false, refreshLocal = true } = {}) {
  const localRooms = await collectLocalRooms({ refresh: refreshLocal });
  if (CLUSTER_PEERS.length === 0) {
    return sortRoomsByPriority(localRooms);
  }

  await refreshAllPeers(forcePeerRefresh);
  const combined = new Map();
  for (const room of localRooms) {
    combined.set(room.code, room);
  }

  for (const peer of CLUSTER_PEERS) {
    const cache = peerCache.get(peer);
    const rooms = Array.isArray(cache?.rooms) ? cache.rooms : [];
    for (const room of rooms) {
      if (!room?.code) {
        continue;
      }
      const existing = combined.get(room.code);
      if (!existing) {
        combined.set(room.code, room);
        continue;
      }

      // Prefer local ownership, otherwise keep the freshest record.
      const existingLocal = existing.source === "local";
      const incomingLocal = room.source === "local";
      if (existingLocal && !incomingLocal) {
        continue;
      }
      if (!existingLocal && incomingLocal) {
        combined.set(room.code, room);
        continue;
      }
      if (Number(room.updatedAt || 0) > Number(existing.updatedAt || 0)) {
        combined.set(room.code, room);
      }
    }
  }

  return sortRoomsByPriority(Array.from(combined.values()));
}

async function findClusterRoomByCode(roomCode) {
  const normalized = sanitizeRoomCode(roomCode);
  if (!normalized) {
    return null;
  }

  const local = workers.get(normalized);
  if (local) {
    await refreshLocalWorkerHealth(local).catch(() => null);
    return toRoomSummary(local, "local");
  }

  if (CLUSTER_PEERS.length === 0) {
    return null;
  }
  const rooms = await collectClusterRooms({ forcePeerRefresh: true, refreshLocal: false });
  return rooms.find((room) => room.code === normalized) ?? null;
}

async function roomCodeExistsInCluster(roomCode) {
  const room = await findClusterRoomByCode(roomCode);
  return Boolean(room);
}

async function generateUniqueRoomCode() {
  const tempReserved = new Set();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = createRoomCode(tempReserved);
    tempReserved.add(code);
    if (!(await roomCodeExistsInCluster(code))) {
      return code;
    }
  }
  return `${ROOM_CODE_PREFIX}-${Date.now().toString(36).toUpperCase()}`;
}

function toAssignmentTarget(room) {
  if (!room) {
    return null;
  }
  const target = {
    code: room.code,
    endpoint: room.endpoint,
    source: room.source ?? "peer",
    count: Number(room.count || 0)
  };
  if (target.source === "local") {
    target.worker = workers.get(room.code) ?? null;
  }
  return target;
}

async function findQuickJoinTarget(preferredCode = null) {
  const preferred = sanitizeRoomCode(preferredCode);
  if (preferred) {
    const exact = await findClusterRoomByCode(preferred);
    if (!exact || !isRoomJoinable(exact)) {
      return null;
    }
    return toAssignmentTarget(exact);
  }

  const rooms = await collectClusterRooms({ forcePeerRefresh: false, refreshLocal: true });
  const joinable = rooms.filter((room) => isRoomJoinable(room));
  if (joinable.length > 0) {
    return toAssignmentTarget(joinable[0]);
  }

  if (!isGatewayAcceptingNewMatches()) {
    return null;
  }

  const newCode = await generateUniqueRoomCode();
  const localWorker = spawnLocalWorker(newCode);
  if (!localWorker) {
    return null;
  }
  await ensureWorkerReady(localWorker);
  await refreshLocalWorkerHealth(localWorker).catch(() => null);
  return toAssignmentTarget(toRoomSummary(localWorker, "local"));
}

function buildRedirectPayload(socket, target, playerName, ownerClaim = false) {
  const roomCode = sanitizeRoomCode(target?.code);
  const endpoint =
    String(target?.endpoint ?? "").trim() ||
    (target?.worker ? resolveWorkerEndpointForSocket(socket, target.worker.port) : "");
  if (!roomCode || !endpoint) {
    return null;
  }

  const expiresAt = Date.now() + JOIN_TOKEN_TTL_MS;
  const token = createRoomJoinToken(
    {
      roomCode,
      name: sanitizeName(playerName),
      owner: ownerClaim === true,
      exp: expiresAt,
      gatewayId: GATEWAY_INSTANCE_ID
    },
    ROOM_JOIN_SECRET
  );

  return {
    roomCode,
    endpoint,
    token,
    expiresAt
  };
}

async function canShutdownNow() {
  let activePlayers = 0;
  for (const worker of workers.values()) {
    await refreshLocalWorkerHealth(worker).catch(() => null);
    const players = getWorkerPlayerCount(worker);
    if (players > 0) {
      activePlayers += players;
    }
  }
  return activePlayers === 0;
}

function closeServer(serverLike) {
  return new Promise((resolve) => {
    if (!serverLike) {
      resolve();
      return;
    }
    try {
      serverLike.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function shutdownGracefully({
  code = 0,
  signal = "SIGTERM",
  immediate = false
} = {}) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    draining = true;
    drainStartedAt = Date.now();

    if (!immediate && signal === "SIGTERM") {
      const deadline = Date.now() + Math.max(4000, GATEWAY_DRAIN_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const drained = await canShutdownNow();
        if (drained) {
          break;
        }
        await sleep(1000);
      }
    }

    for (const worker of Array.from(workers.values())) {
      stopLocalWorker(worker);
      removeLocalWorker(worker);
    }

    clearInterval(workerMaintenanceTimer);
    await closeServer(io);
    await closeServer(httpServer);
    await sleep(120);
    process.exit(code);
  })();

  return shutdownPromise;
}

async function buildHealthPayload(scope = "cluster") {
  const localRooms = await collectLocalRooms({ refresh: true });
  const rooms =
    scope === "local" ? localRooms : await collectClusterRooms({ forcePeerRefresh: true, refreshLocal: false });
  return {
    ok: true,
    service: "reclaim-fps-gateway",
    instanceId: GATEWAY_INSTANCE_ID,
    gatewayOrigin: SELF_ORIGIN,
    gatewayPort: GATEWAY_PORT,
    onlineGatewayConnections: gatewayConnections,
    draining,
    drainStartedAt: draining ? drainStartedAt : 0,
    acceptingNewMatches: isGatewayAcceptingNewMatches(),
    localWorkers: localRooms.length,
    workers: rooms.length,
    maxWorkers: MAX_ACTIVE_WORKERS,
    capacityPerRoom: MAX_ROOM_PLAYERS,
    peers: CLUSTER_PEERS,
    rooms,
    now: Date.now()
  };
}

const httpServer = createServer(async (req, res) => {
  const host = String(req.headers.host ?? `localhost:${GATEWAY_PORT}`);
  const requestUrl = new URL(req.url ?? "/", `http://${host}`);
  const pathname = requestUrl.pathname;
  const scope = String(requestUrl.searchParams.get("scope") ?? "").trim().toLowerCase();

  if (pathname === "/health") {
    writeJson(res, 200, await buildHealthPayload(scope === "local" ? "local" : "cluster"));
    return;
  }

  if (pathname === "/ready") {
    if (!isGatewayAcceptingNewMatches()) {
      writeJson(res, 503, {
        ok: false,
        ready: false,
        draining: true,
        instanceId: GATEWAY_INSTANCE_ID
      });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      ready: true,
      draining: false,
      instanceId: GATEWAY_INSTANCE_ID
    });
    return;
  }

  if (pathname === "/" || pathname === "/status") {
    writeJson(res, 200, {
      ok: true,
      message: "Emptines gateway is running",
      instanceId: GATEWAY_INSTANCE_ID,
      gatewayPort: GATEWAY_PORT,
      workerPortRange: [WORKER_PORT_BASE, WORKER_PORT_MAX],
      maxWorkers: MAX_ACTIVE_WORKERS,
      draining,
      peers: CLUSTER_PEERS,
      health: "/health",
      ready: "/ready"
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const corsOrigin = parseCorsOrigins(process.env.CORS_ORIGIN);
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  pingInterval: 5000,
  pingTimeout: 5000
});

io.on("connection", (socket) => {
  gatewayConnections += 1;
  socket.emit("server:role", {
    role: "gateway",
    instanceId: GATEWAY_INSTANCE_ID,
    draining
  });

  void (async () => {
    socket.emit("room:list", await collectClusterRooms({ forcePeerRefresh: false, refreshLocal: true }));
  })();

  socket.on("room:list", async () => {
    socket.emit("room:list", await collectClusterRooms({ forcePeerRefresh: false, refreshLocal: true }));
  });

  socket.on("room:quick-join", async (payload = {}, ackFn) => {
    if (!isGatewayAcceptingNewMatches()) {
      ack(ackFn, { ok: false, error: "gateway draining" });
      return;
    }

    const playerName = sanitizeName(payload.name);
    const ownerClaim = hasOwnerAccess(payload?.ownerKey);
    const preferredCode = sanitizeRoomCode(payload.roomCode ?? payload.code);
    const target = await findQuickJoinTarget(preferredCode);
    if (!target) {
      ack(ackFn, { ok: false, error: "no room capacity available" });
      return;
    }

    if (target.worker) {
      target.worker.lastAssignedAt = Date.now();
      target.endpoint = resolveWorkerEndpointForSocket(socket, target.worker.port);
    }

    const redirect = buildRedirectPayload(socket, target, playerName, ownerClaim);
    if (!redirect) {
      ack(ackFn, { ok: false, error: "redirect build failed" });
      return;
    }
    ack(ackFn, { ok: true, redirect });
    socket.emit("route:assign", redirect);
  });

  socket.on("room:create", async (payload = {}, ackFn) => {
    if (!isGatewayAcceptingNewMatches()) {
      ack(ackFn, { ok: false, error: "gateway draining" });
      return;
    }

    const requested = sanitizeRoomCode(payload.code ?? payload.roomCode);
    if (requested && (await roomCodeExistsInCluster(requested))) {
      ack(ackFn, { ok: false, error: "room already exists" });
      return;
    }

    const roomCode = requested || (await generateUniqueRoomCode());
    const localWorker = spawnLocalWorker(roomCode);
    if (!localWorker) {
      ack(ackFn, { ok: false, error: "room limit reached" });
      return;
    }

    try {
      await ensureWorkerReady(localWorker);
      await refreshLocalWorkerHealth(localWorker).catch(() => null);
    } catch {
      ack(ackFn, { ok: false, error: "worker boot failed" });
      return;
    }

    localWorker.lastAssignedAt = Date.now();
    const playerName = sanitizeName(payload.name);
    const ownerClaim = hasOwnerAccess(payload?.ownerKey);
    const redirect = buildRedirectPayload(
      socket,
      {
        code: localWorker.code,
        endpoint: resolveWorkerEndpointForSocket(socket, localWorker.port),
        worker: localWorker,
        source: "local"
      },
      playerName,
      ownerClaim
    );
    if (!redirect) {
      ack(ackFn, { ok: false, error: "redirect build failed" });
      return;
    }
    ack(ackFn, { ok: true, redirect });
    socket.emit("route:assign", redirect);
  });

  socket.on("room:join", async (payload = {}, ackFn) => {
    const requested = sanitizeRoomCode(payload.code ?? payload.roomCode);
    if (!requested) {
      ack(ackFn, { ok: false, error: "room code required" });
      return;
    }

    const room = await findClusterRoomByCode(requested);
    if (!room) {
      ack(ackFn, { ok: false, error: "room not found" });
      return;
    }
    if (!isRoomJoinable(room)) {
      ack(ackFn, { ok: false, error: "room full" });
      return;
    }

    const localWorker = room.source === "local" ? workers.get(room.code) : null;
    if (localWorker) {
      localWorker.lastAssignedAt = Date.now();
    }

    const playerName = sanitizeName(payload.name);
    const ownerClaim = hasOwnerAccess(payload?.ownerKey);
    const redirect = buildRedirectPayload(
      socket,
      {
        code: room.code,
        endpoint:
          room.source === "local" && localWorker
            ? resolveWorkerEndpointForSocket(socket, localWorker.port)
            : room.endpoint,
        worker: localWorker,
        source: room.source
      },
      playerName,
      ownerClaim
    );
    if (!redirect) {
      ack(ackFn, { ok: false, error: "redirect build failed" });
      return;
    }
    ack(ackFn, { ok: true, redirect });
    socket.emit("route:assign", redirect);
  });

  socket.on("room:leave", (ackFn) => {
    ack(ackFn, { ok: true, room: null });
  });

  socket.on("disconnect", () => {
    gatewayConnections = Math.max(0, gatewayConnections - 1);
  });
});

const workerMaintenanceTimer = setInterval(async () => {
  if (shuttingDown) {
    return;
  }

  await refreshAllPeers(false).catch(() => null);
  for (const worker of Array.from(workers.values())) {
    await refreshLocalWorkerHealth(worker).catch(() => null);
    const players = getWorkerPlayerCount(worker);
    if (players > 0) {
      worker.lastOccupiedAt = Date.now();
      continue;
    }

    const idleSince = Math.max(worker.lastAssignedAt, worker.lastOccupiedAt, worker.createdAt);
    if (draining || Date.now() - idleSince >= WORKER_IDLE_SHUTDOWN_MS) {
      stopLocalWorker(worker);
      removeLocalWorker(worker);
    }
  }
}, Math.max(3000, WORKER_MAINTENANCE_INTERVAL_MS));
workerMaintenanceTimer.unref?.();

process.on("SIGINT", () => {
  void shutdownGracefully({ code: 0, signal: "SIGINT", immediate: true });
});
process.on("SIGTERM", () => {
  void shutdownGracefully({ code: 0, signal: "SIGTERM", immediate: false });
});

httpServer.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`Gateway port ${GATEWAY_PORT} is in use. Set PORT to a different value.`);
    process.exit(1);
    return;
  }
  console.error("Gateway failed to start:", error);
  process.exit(1);
});

httpServer.listen(GATEWAY_PORT, () => {
  console.log(`Gateway running on http://localhost:${GATEWAY_PORT}`);
  console.log(
    `Instance ${GATEWAY_INSTANCE_ID} | worker ports ${WORKER_PORT_BASE}-${WORKER_PORT_MAX} | max local workers ${MAX_ACTIVE_WORKERS}`
  );
  if (CLUSTER_PEERS.length > 0) {
    console.log(`Cluster peers: ${CLUSTER_PEERS.join(", ")}`);
  }
});
