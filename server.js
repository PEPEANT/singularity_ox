import { createServer } from "http";
import { Server } from "socket.io";
import { BASE_VOID_PACK } from "./src/game/content/packs/base-void/pack.js";
import { verifyRoomJoinToken } from "./src/server/roomToken.js";

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

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function probeExistingServer(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json().catch(() => null);
    return Boolean(payload?.ok && payload?.service === "reclaim-fps-chat");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const ROOM_CODE_PREFIX = "OX";
const ROOM_CODE_RANDOM_LENGTH = 5;
const ENTRY_PARTICIPANT_LIMIT = Math.max(
  1,
  Math.trunc(Number(process.env.ENTRY_PARTICIPANT_LIMIT ?? 50) || 50)
);
const MAX_ROOM_PLAYERS = Math.max(
  ENTRY_PARTICIPANT_LIMIT,
  Math.trunc(Number(process.env.MAX_ROOM_PLAYERS ?? 120) || 120)
);
const MAX_ACTIVE_ROOMS = 24;

const WORKER_SINGLE_ROOM_MODE = process.env.ROOM_WORKER_SINGLE === "1";
const WORKER_ROOM_CODE_RAW = String(process.env.ROOM_CODE ?? "");
const REQUIRE_JOIN_TOKEN = process.env.REQUIRE_JOIN_TOKEN === "1";
const ROOM_JOIN_SECRET = String(process.env.ROOM_JOIN_SECRET ?? "dev-room-secret") || "dev-room-secret";
const ROOM_JOIN_TOKEN_LEEWAY_MS = 8000;
const ROOM_OWNER_KEY = String(process.env.ROOM_OWNER_KEY ?? "").trim();

const SERVER_TICK_RATE = 20;
const SERVER_TICK_INTERVAL_MS = Math.max(30, Math.trunc(1000 / SERVER_TICK_RATE));
const SERVER_DELTA_HEARTBEAT_TICKS = 20;

const AOI_NEAR_RADIUS = 42;
const AOI_MID_RADIUS = 82;
const AOI_FAR_RADIUS = 128;
const AOI_MID_CADENCE = 2;
const AOI_FAR_CADENCE = 4;
const AOI_EDGE_CADENCE = 8;

const DELTA_POS_SCALE = 100;
const DELTA_ROT_SCALE = 1000;

const SERVER_MAX_MOVE_SPEED = 17.5;
const SERVER_MAX_VERTICAL_SPEED = 24;
const SERVER_MAX_ACCELERATION = 46;
const SERVER_MOVEMENT_MARGIN = 0.4;
const SERVER_MAX_TELEPORT_DISTANCE = 18;
const SERVER_CORRECTION_MIN_DISTANCE = 0.22;
const SERVER_CORRECTION_COOLDOWN_MS = 140;

const QUIZ_DEFAULT_LOCK_SECONDS = 15;
const QUIZ_MIN_LOCK_SECONDS = 3;
const QUIZ_MAX_LOCK_SECONDS = 60;
const QUIZ_MAX_QUESTIONS = 50;
const QUIZ_TEXT_MAX_LENGTH = 180;
const QUIZ_EXPLANATION_MAX_LENGTH = 720;
const QUIZ_AUTO_NEXT_DELAY_MS = 3200;
const QUIZ_PREPARE_DELAY_MS = 3000;
const QUIZ_AUTO_START_DELAY_MS = 12000;
const QUIZ_AUTO_RESTART_DELAY_MS = 9000;
const QUIZ_AUTO_START_MIN_PLAYERS = 1;
const QUIZ_END_ON_SINGLE_SURVIVOR = process.env.QUIZ_END_ON_SINGLE_SURVIVOR === "1";
const QUIZ_ZONE_EDGE_MARGIN = 0.5;
const QUIZ_ZONE_CENTER_MARGIN = 0.8;
const DEFAULT_PORTAL_TARGET_URL = sanitizePortalTargetUrl(process.env.PORTAL_TARGET_URL ?? "");

const FALLBACK_QUIZ_QUESTIONS = Object.freeze([
  Object.freeze({
    id: "Q1",
    text: "특이점 갤러리는 디시인사이드의 갤러리 중 하나다.",
    answer: "O"
  }),
  Object.freeze({
    id: "Q2",
    text: "디시인사이드 갤러리 글에는 보통 댓글(리플)을 달 수 있다.",
    answer: "O"
  }),
  Object.freeze({
    id: "Q3",
    text: "디시에서는 글이 추천을 많이 받으면 개념글 같은 형태로 모아지기도 한다.",
    answer: "O"
  }),
  Object.freeze({
    id: "Q4",
    text: "특갤에서는 AI, 특이점, AGI 같은 미래기술 이야기가 자주 나온다.",
    answer: "O"
  }),
  Object.freeze({
    id: "Q5",
    text: "디시에서는 회원만 글을 쓸 수 있고 비회원은 글/댓글 작성이 절대 불가능하다.",
    answer: "X"
  }),
  Object.freeze({
    id: "Q6",
    text: "디시에는 추천뿐 아니라 비추천(비추) 같은 반응도 존재한다.",
    answer: "O"
  }),
  Object.freeze({
    id: "Q7",
    text: "디시 갤러리에서는 닉네임 대신 익명/아이디처럼 보이는 형태로 글이 올라올 수 있다.",
    answer: "O"
  }),
  Object.freeze({
    id: "Q8",
    text: "특갤의 모든 글은 공식적으로 검증된 뉴스/논문만 허용된다.",
    answer: "X"
  }),
  Object.freeze({
    id: "Q9",
    text: "디시 갤러리 문화에는 밈(유행어/드립) 같은 요소가 섞이는 경우가 많다.",
    answer: "O"
  }),
  Object.freeze({
    id: "Q10",
    text: "특갤은 다른 갤과 마찬가지로 분위기와 유행이 시기마다 바뀔 수 있다.",
    answer: "O"
  })
]);

const QUIZ_ARENA_CONFIG = BASE_VOID_PACK?.world?.oxArena ?? {};

function readZoneBounds(zoneConfig, fallbackCenterX) {
  const width = Math.max(8, Number(zoneConfig?.width) || 20);
  const depth = Math.max(8, Number(zoneConfig?.depth) || 20);
  const centerX = Number.isFinite(Number(zoneConfig?.centerX))
    ? Number(zoneConfig.centerX)
    : fallbackCenterX;
  const centerZ = Number.isFinite(Number(zoneConfig?.centerZ)) ? Number(zoneConfig.centerZ) : 0;
  const halfW = width * 0.5;
  const halfD = depth * 0.5;
  return {
    centerX,
    centerZ,
    width,
    depth,
    minX: centerX - halfW,
    maxX: centerX + halfW,
    minZ: centerZ - halfD,
    maxZ: centerZ + halfD
  };
}

const QUIZ_O_ZONE = readZoneBounds(QUIZ_ARENA_CONFIG?.oZone, -17);
const QUIZ_X_ZONE = readZoneBounds(QUIZ_ARENA_CONFIG?.xZone, 17);
const QUIZ_DIVIDER_WIDTH = Math.max(0.6, Number(QUIZ_ARENA_CONFIG?.dividerWidth) || 1.3);
const QUIZ_ACTIVE_MIN_Z = Math.min(QUIZ_O_ZONE.minZ, QUIZ_X_ZONE.minZ);
const QUIZ_ACTIVE_MAX_Z = Math.max(QUIZ_O_ZONE.maxZ, QUIZ_X_ZONE.maxZ);
const QUIZ_CENTER_DEAD_BAND = QUIZ_DIVIDER_WIDTH * 0.5 + QUIZ_ZONE_CENTER_MARGIN;
const ADMISSION_SPAWN_Y = 1.72;
const ADMISSION_SPAWN_CENTER_X = 0;
const ADMISSION_SPAWN_CENTER_Z = 14;
const ADMISSION_SPAWN_RING_START = 2.4;
const ADMISSION_SPAWN_RING_STEP = 2.35;
const ADMISSION_SPAWN_PER_RING = 10;

const rooms = new Map();
let playerCount = 0;

function createQuizState() {
  return {
    active: false,
    phase: "idle",
    autoMode: false,
    autoFinish: true,
    autoStartsAt: 0,
    autoStartTimer: null,
    hostId: null,
    startedAt: 0,
    prepareEndsAt: 0,
    endedAt: 0,
    questionIndex: -1,
    totalQuestions: 0,
    currentQuestion: null,
    questions: [],
    lockSeconds: QUIZ_DEFAULT_LOCK_SECONDS,
    lockAt: 0,
    lockTimer: null,
    nextTimer: null,
    lastResult: null
  };
}

function createRoom(code, persistent = false) {
  return {
    code,
    hostId: null,
    players: new Map(),
    portalTargetUrl: DEFAULT_PORTAL_TARGET_URL,
    entryGate: {
      portalOpen: false,
      openedAt: 0,
      lastAdmissionAt: 0,
      admissionStartsAt: 0,
      admissionTimer: null,
      pendingAdmissionIds: [],
      nextPriorityIds: []
    },
    persistent,
    createdAt: Date.now(),
    quizConfig: {
      questions: FALLBACK_QUIZ_QUESTIONS.map((question, index) => ({
        id: String(question?.id ?? `Q${index + 1}`),
        text: String(question?.text ?? "").slice(0, QUIZ_TEXT_MAX_LENGTH),
        answer: normalizeQuizAnswer(question?.answer) ?? "O",
        explanation: String(question?.explanation ?? "").slice(0, QUIZ_EXPLANATION_MAX_LENGTH)
      })),
      endPolicy: {
        autoFinish: true
      }
    },
    quiz: createQuizState(),
    tick: 0
  };
}

function sanitizeRoomCode(rawCode) {
  const value = String(rawCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 24);
  return value || null;
}

const WORKER_FIXED_ROOM_CODE =
  sanitizeRoomCode(WORKER_ROOM_CODE_RAW) ?? `${ROOM_CODE_PREFIX}-WORKER`;

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    let suffix = "";
    for (let i = 0; i < ROOM_CODE_RANDOM_LENGTH; i += 1) {
      suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    const code = `${ROOM_CODE_PREFIX}-${suffix}`;
    if (!rooms.has(code)) {
      return code;
    }
  }
  return `${ROOM_CODE_PREFIX}-${Date.now().toString(36).toUpperCase()}`;
}

function createMatchRoom(requestedCode = null, persistent = false) {
  const normalized = sanitizeRoomCode(requestedCode);
  const code = normalized && !rooms.has(normalized) ? normalized : createRoomCode();
  const room = createRoom(code, persistent);
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  const normalized = sanitizeRoomCode(code);
  if (!normalized) {
    return null;
  }
  return rooms.get(normalized) ?? null;
}

function validateJoinTokenForWorker(token) {
  const verified = verifyRoomJoinToken(token, ROOM_JOIN_SECRET);
  if (!verified?.ok) {
    return verified;
  }

  const payload = verified.payload ?? {};
  const roomCode = sanitizeRoomCode(payload.roomCode ?? payload.room);
  if (!roomCode || roomCode !== WORKER_FIXED_ROOM_CODE) {
    return { ok: false, error: "token room mismatch" };
  }

  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, error: "token exp missing" };
  }
  if (Date.now() - ROOM_JOIN_TOKEN_LEEWAY_MS > exp) {
    return { ok: false, error: "token expired" };
  }

  return {
    ok: true,
    payload: {
      roomCode,
      name: sanitizeName(payload.name ?? payload.playerName ?? "PLAYER"),
      ownerClaim: payload.owner === true
    }
  };
}

function isRoomJoinable(room) {
  if (!room) {
    return false;
  }
  pruneRoomPlayers(room);
  return room.players.size < MAX_ROOM_PLAYERS;
}

function findJoinableRoom(preferredCode = null) {
  if (WORKER_SINGLE_ROOM_MODE) {
    const workerRoom =
      getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
    return isRoomJoinable(workerRoom) ? workerRoom : null;
  }

  const preferred = preferredCode ? getRoom(preferredCode) : null;
  if (preferred && isRoomJoinable(preferred)) {
    return preferred;
  }

  const candidates = [];
  for (const room of rooms.values()) {
    if (!room || room.players.size >= MAX_ROOM_PLAYERS) {
      continue;
    }
    candidates.push(room);
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const deltaPlayers = right.players.size - left.players.size;
    if (deltaPlayers !== 0) {
      return deltaPlayers;
    }
    return left.createdAt - right.createdAt;
  });

  return candidates[0];
}

if (WORKER_SINGLE_ROOM_MODE && !rooms.has(WORKER_FIXED_ROOM_CODE)) {
  createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
}

function getRoomQuiz(room) {
  if (!room || typeof room !== "object") {
    return createQuizState();
  }
  if (!room.quiz || typeof room.quiz !== "object") {
    room.quiz = createQuizState();
  }
  return room.quiz;
}

function getDefaultQuizConfigQuestions() {
  return FALLBACK_QUIZ_QUESTIONS.map((question, index) => ({
    id: String(question?.id ?? `Q${index + 1}`),
    text: String(question?.text ?? "").slice(0, QUIZ_TEXT_MAX_LENGTH) || `Question ${index + 1}`,
    answer: normalizeQuizAnswer(question?.answer) ?? "O",
    explanation: String(question?.explanation ?? "").slice(0, QUIZ_EXPLANATION_MAX_LENGTH)
  }));
}

function ensureRoomQuizConfig(room) {
  if (!room || typeof room !== "object") {
    return {
      questions: getDefaultQuizConfigQuestions(),
      endPolicy: { autoFinish: true }
    };
  }
  if (!room.quizConfig || typeof room.quizConfig !== "object") {
    room.quizConfig = {
      questions: getDefaultQuizConfigQuestions(),
      endPolicy: { autoFinish: true }
    };
  }
  const safeQuestions = sanitizeQuizQuestions(room.quizConfig.questions, {
    fallbackToDefault: true,
    minQuestions: 1,
    maxQuestions: QUIZ_MAX_QUESTIONS
  });
  room.quizConfig.questions = safeQuestions;
  if (!room.quizConfig.endPolicy || typeof room.quizConfig.endPolicy !== "object") {
    room.quizConfig.endPolicy = { autoFinish: true };
  }
  room.quizConfig.endPolicy.autoFinish = room.quizConfig.endPolicy.autoFinish !== false;
  return room.quizConfig;
}

function ensureRoomEntryGate(room) {
  if (!room || typeof room !== "object") {
    return {
      portalOpen: false,
      openedAt: 0,
      lastAdmissionAt: 0,
      admissionStartsAt: 0,
      admissionTimer: null,
      pendingAdmissionIds: [],
      nextPriorityIds: []
    };
  }
  if (!room.entryGate || typeof room.entryGate !== "object") {
    room.entryGate = {
      portalOpen: false,
      openedAt: 0,
      lastAdmissionAt: 0,
      admissionStartsAt: 0,
      admissionTimer: null,
      pendingAdmissionIds: [],
      nextPriorityIds: []
    };
  }
  room.entryGate.portalOpen = room.entryGate.portalOpen === true;
  room.entryGate.openedAt = Math.max(0, Math.trunc(Number(room.entryGate.openedAt) || 0));
  room.entryGate.lastAdmissionAt = Math.max(
    0,
    Math.trunc(Number(room.entryGate.lastAdmissionAt) || 0)
  );
  room.entryGate.admissionStartsAt = Math.max(
    0,
    Math.trunc(Number(room.entryGate.admissionStartsAt) || 0)
  );
  room.entryGate.pendingAdmissionIds = normalizeEntryGateQueueIds(
    room,
    room.entryGate.pendingAdmissionIds
  );
  room.entryGate.nextPriorityIds = normalizeEntryGateQueueIds(room, room.entryGate.nextPriorityIds);
  return room.entryGate;
}

function normalizeEntryGateQueueIds(room, rawIds) {
  const ids = Array.isArray(rawIds) ? rawIds : [];
  if (!room?.players || room.players.size <= 0) {
    return [];
  }
  const next = [];
  const seen = new Set();
  for (const rawId of ids) {
    const id = String(rawId ?? "");
    if (!id || seen.has(id)) {
      continue;
    }
    const player = room.players.get(id);
    if (!player || isPlayerHostModerator(room, player)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  return next;
}

function addNextPriorityPlayer(room, socketId) {
  if (!room || !socketId) {
    return;
  }
  const gate = ensureRoomEntryGate(room);
  const id = String(socketId ?? "");
  const player = room.players.get(id);
  if (!player || isPlayerHostModerator(room, player)) {
    return;
  }
  if (!Array.isArray(gate.nextPriorityIds)) {
    gate.nextPriorityIds = [];
  }
  if (!gate.nextPriorityIds.includes(id)) {
    gate.nextPriorityIds.push(id);
  }
}

function removeNextPriorityPlayer(room, socketId) {
  if (!room || !socketId) {
    return;
  }
  const gate = ensureRoomEntryGate(room);
  const id = String(socketId ?? "");
  if (!Array.isArray(gate.nextPriorityIds) || !id) {
    return;
  }
  gate.nextPriorityIds = gate.nextPriorityIds.filter((entryId) => entryId !== id);
}

function clearEntryAdmissionTimer(room) {
  const gate = ensureRoomEntryGate(room);
  if (gate.admissionTimer) {
    clearTimeout(gate.admissionTimer);
    gate.admissionTimer = null;
  }
  gate.admissionStartsAt = 0;
  gate.pendingAdmissionIds = [];
}

function sanitizeName(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 16);
  return value || "PLAYER";
}

function sanitizePortalTargetUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  try {
    const target = new URL(value);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return "";
    }
    return target.toString();
  } catch {
    return "";
  }
}

function hasOwnerAccess(ownerKeyRaw) {
  if (!ROOM_OWNER_KEY) {
    return false;
  }
  return String(ownerKeyRaw ?? "").trim() === ROOM_OWNER_KEY;
}

function applySocketOwnerAccess(socket, ownerKeyRaw) {
  if (!socket || typeof socket !== "object") {
    return false;
  }
  if (socket.data?.ownerClaim === true) {
    return true;
  }
  if (hasOwnerAccess(ownerKeyRaw)) {
    socket.data.ownerClaim = true;
    return true;
  }
  return false;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function sanitizePlayerState(raw = {}) {
  return {
    x: clampNumber(raw.x, -512, 512, 0),
    y: clampNumber(raw.y, 0, 128, 1.75),
    z: clampNumber(raw.z, -512, 512, 0),
    yaw: clampNumber(raw.yaw, -Math.PI, Math.PI, 0),
    pitch: clampNumber(raw.pitch, -1.55, 1.55, 0),
    updatedAt: Date.now()
  };
}

function createPlayerNetState(initialState = sanitizePlayerState()) {
  return {
    lastAcceptedAt: Date.now(),
    lastSeq: -1,
    warmupSyncs: 0,
    velocity: { x: 0, y: 0, z: 0 },
    rejectedMoves: 0,
    lastCorrectionAt: 0,
    state: {
      x: Number(initialState.x) || 0,
      y: Number(initialState.y) || 1.75,
      z: Number(initialState.z) || 0
    }
  };
}

function ensurePlayerNetState(player) {
  if (!player || typeof player !== "object") {
    return createPlayerNetState();
  }
  if (!player.net || typeof player.net !== "object") {
    player.net = createPlayerNetState(player.state);
  }
  return player.net;
}

function setPlayerAuthoritativeState(player, nextState = {}) {
  if (!player || typeof player !== "object") {
    return;
  }
  const merged = {
    ...(player.state ?? {}),
    ...nextState
  };
  const sanitized = sanitizePlayerState(merged);
  player.state = sanitized;
  const net = ensurePlayerNetState(player);
  net.state = {
    x: Number(sanitized.x) || 0,
    y: Number(sanitized.y) || ADMISSION_SPAWN_Y,
    z: Number(sanitized.z) || 0
  };
  net.velocity = { x: 0, y: 0, z: 0 };
  net.lastAcceptedAt = Date.now();
  net.warmupSyncs = 0;
  net.lastCorrectionAt = 0;
}

function buildAdmissionSpawnPoint(index, total) {
  const safeTotal = Math.max(1, Math.trunc(Number(total) || 1));
  const safeIndex = Math.max(0, Math.trunc(Number(index) || 0));
  const ring = Math.floor(safeIndex / ADMISSION_SPAWN_PER_RING);
  const slot = safeIndex % ADMISSION_SPAWN_PER_RING;
  const slotsInRing = Math.max(
    1,
    Math.min(ADMISSION_SPAWN_PER_RING, safeTotal - ring * ADMISSION_SPAWN_PER_RING)
  );
  const angle = (slot / slotsInRing) * Math.PI * 2;
  const radius = ADMISSION_SPAWN_RING_START + ring * ADMISSION_SPAWN_RING_STEP;
  return {
    x: Number((ADMISSION_SPAWN_CENTER_X + Math.cos(angle) * radius).toFixed(3)),
    y: ADMISSION_SPAWN_Y,
    z: Number((ADMISSION_SPAWN_CENTER_Z + Math.sin(angle) * radius).toFixed(3))
  };
}

function normalizeVec3Magnitude(x, y, z, maxLength) {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= maxLength || maxLength <= 0) {
    return { x, y, z, clamped: false };
  }
  const ratio = maxLength / length;
  return {
    x: x * ratio,
    y: y * ratio,
    z: z * ratio,
    clamped: true
  };
}

function applyAuthoritativeMovement(player, proposedState) {
  const net = ensurePlayerNetState(player);
  const now = Date.now();
  const previousState = player?.state ?? sanitizePlayerState();

  const elapsedMs = Math.max(1, now - Number(net.lastAcceptedAt || now));
  const warmupSyncs = Math.max(0, Math.trunc(Number(net.warmupSyncs) || 0));
  const warmupPhase = warmupSyncs < 3;
  const dtFloor = warmupPhase ? 0.35 : 1 / 60;
  const dt = Math.max(dtFloor, Math.min(0.3, elapsedMs / 1000));

  let dx = Number(proposedState.x) - Number(previousState.x);
  let dy = Number(proposedState.y) - Number(previousState.y);
  let dz = Number(proposedState.z) - Number(previousState.z);
  let clamped = false;

  const horizontalDistance = Math.hypot(dx, dz);
  const allowedHorizontalDistance =
    SERVER_MOVEMENT_MARGIN + SERVER_MAX_MOVE_SPEED * dt + 0.5 * SERVER_MAX_ACCELERATION * dt * dt;

  if (horizontalDistance > allowedHorizontalDistance) {
    const ratio = allowedHorizontalDistance / Math.max(horizontalDistance, 0.0001);
    dx *= ratio;
    dz *= ratio;
    clamped = true;
  }

  const allowedVerticalDistance = SERVER_MOVEMENT_MARGIN + SERVER_MAX_VERTICAL_SPEED * dt;
  if (Math.abs(dy) > allowedVerticalDistance) {
    dy = Math.sign(dy) * allowedVerticalDistance;
    clamped = true;
  }

  const constrained = normalizeVec3Magnitude(dx, dy, dz, SERVER_MAX_TELEPORT_DISTANCE);
  if (constrained.clamped) {
    dx = constrained.x;
    dy = constrained.y;
    dz = constrained.z;
    clamped = true;
  }

  const candidateVelocity = {
    x: dx / dt,
    y: dy / dt,
    z: dz / dt
  };

  const accelX = candidateVelocity.x - Number(net.velocity?.x || 0);
  const accelY = candidateVelocity.y - Number(net.velocity?.y || 0);
  const accelZ = candidateVelocity.z - Number(net.velocity?.z || 0);
  const accelMagnitude = Math.hypot(accelX, accelY, accelZ) / dt;
  const maxAllowedAccel = SERVER_MAX_ACCELERATION * 1.8;
  if (accelMagnitude > maxAllowedAccel) {
    const ratio = maxAllowedAccel / Math.max(accelMagnitude, 0.0001);
    candidateVelocity.x = Number(net.velocity?.x || 0) + accelX * ratio;
    candidateVelocity.y = Number(net.velocity?.y || 0) + accelY * ratio;
    candidateVelocity.z = Number(net.velocity?.z || 0) + accelZ * ratio;
    dx = candidateVelocity.x * dt;
    dy = candidateVelocity.y * dt;
    dz = candidateVelocity.z * dt;
    clamped = true;
  }

  const nextState = {
    x: Number((Number(previousState.x) + dx).toFixed(3)),
    y: Number(Math.max(0, Number(previousState.y) + dy).toFixed(3)),
    z: Number((Number(previousState.z) + dz).toFixed(3)),
    yaw: clampNumber(proposedState.yaw, -Math.PI, Math.PI, Number(previousState.yaw) || 0),
    pitch: clampNumber(proposedState.pitch, -1.55, 1.55, Number(previousState.pitch) || 0),
    updatedAt: now
  };

  net.lastAcceptedAt = now;
  net.warmupSyncs = warmupSyncs + 1;
  net.velocity = {
    x: (nextState.x - Number(previousState.x)) / dt,
    y: (nextState.y - Number(previousState.y)) / dt,
    z: (nextState.z - Number(previousState.z)) / dt
  };
  net.state = {
    x: nextState.x,
    y: nextState.y,
    z: nextState.z
  };
  net.rejectedMoves = clamped ? Number(net.rejectedMoves || 0) + 1 : Math.max(0, Number(net.rejectedMoves || 0) - 0.25);

  const correctionDistance = Math.hypot(
    nextState.x - Number(proposedState.x),
    nextState.y - Number(proposedState.y),
    nextState.z - Number(proposedState.z)
  );

  player.state = nextState;
  return {
    nextState,
    clamped,
    correctionDistance
  };
}

function quantizePosition(value) {
  return Math.round((Number(value) || 0) * DELTA_POS_SCALE);
}

function quantizeRotation(value) {
  return Math.round((Number(value) || 0) * DELTA_ROT_SCALE);
}

function getSocketDeltaCache(socket, roomCode) {
  if (!socket) {
    return null;
  }
  if (!socket.data.deltaCache || typeof socket.data.deltaCache !== "object") {
    socket.data.deltaCache = new Map();
  }
  if (!socket.data.deltaCache.has(roomCode)) {
    socket.data.deltaCache.set(roomCode, new Map());
  }
  return socket.data.deltaCache.get(roomCode);
}

function clearSocketDeltaCache(socket, roomCode = null) {
  if (!socket?.data?.deltaCache || typeof socket.data.deltaCache?.clear !== "function") {
    return;
  }
  if (!roomCode) {
    socket.data.deltaCache.clear();
    return;
  }
  socket.data.deltaCache.delete(roomCode);
}

function resolveAoiCadence(distanceSq) {
  const nearSq = AOI_NEAR_RADIUS * AOI_NEAR_RADIUS;
  const midSq = AOI_MID_RADIUS * AOI_MID_RADIUS;
  const farSq = AOI_FAR_RADIUS * AOI_FAR_RADIUS;
  if (distanceSq <= nearSq) {
    return 1;
  }
  if (distanceSq <= midSq) {
    return AOI_MID_CADENCE;
  }
  if (distanceSq <= farSq) {
    return AOI_FAR_CADENCE;
  }
  return AOI_EDGE_CADENCE;
}

function buildPackedRemoteState(player) {
  const state = player?.state ?? {};
  return {
    id: player?.id ?? null,
    n: player?.name ?? "PLAYER",
    a: player?.alive === false ? 0 : 1,
    px: quantizePosition(state.x),
    py: quantizePosition(state.y),
    pz: quantizePosition(state.z),
    yaw: quantizeRotation(state.yaw),
    pitch: quantizeRotation(state.pitch)
  };
}

function emitRoomDeltaSnapshot(room) {
  if (!room || room.players.size <= 1) {
    return;
  }

  room.tick = Number(room.tick || 0) + 1;
  const players = Array.from(room.players.values());

  for (const receiver of players) {
    const socket = io?.sockets?.sockets?.get(receiver.id);
    if (!socket) {
      continue;
    }

    const cache = getSocketDeltaCache(socket, room.code);
    if (!cache) {
      continue;
    }

    const updates = [];
    const removals = [];
    const receiverState = receiver?.state ?? sanitizePlayerState();

    for (const remote of players) {
      if (!remote || remote.id === receiver.id) {
        continue;
      }

      const remoteState = remote.state ?? sanitizePlayerState();
      const dx = Number(remoteState.x) - Number(receiverState.x);
      const dz = Number(remoteState.z) - Number(receiverState.z);
      const distanceSq = dx * dx + dz * dz;
      const cadence = resolveAoiCadence(distanceSq);

      const cached = cache.get(remote.id) ?? null;
      const isHeartbeatDue =
        cached && room.tick - Number(cached.lastTick || 0) >= SERVER_DELTA_HEARTBEAT_TICKS;
      if (cached && !isHeartbeatDue && cadence > 1 && room.tick % cadence !== 0) {
        continue;
      }

      const packed = buildPackedRemoteState(remote);
      const changed =
        !cached ||
        cached.px !== packed.px ||
        cached.py !== packed.py ||
        cached.pz !== packed.pz ||
        cached.yaw !== packed.yaw ||
        cached.pitch !== packed.pitch ||
        cached.n !== packed.n ||
        cached.a !== packed.a;

      if (!changed && !isHeartbeatDue) {
        continue;
      }

      const delta = { id: packed.id };
      if (!cached || cached.n !== packed.n) {
        delta.n = packed.n;
      }
      if (!cached || cached.a !== packed.a) {
        delta.a = packed.a;
      }
      if (!cached || cached.px !== packed.px || cached.py !== packed.py || cached.pz !== packed.pz) {
        delta.p = [packed.px, packed.py, packed.pz];
      }
      if (!cached || cached.yaw !== packed.yaw || cached.pitch !== packed.pitch) {
        delta.r = [packed.yaw, packed.pitch];
      }
      updates.push(delta);
      cache.set(remote.id, {
        ...packed,
        lastTick: room.tick
      });
    }

    for (const cachedId of Array.from(cache.keys())) {
      if (!room.players.has(cachedId)) {
        cache.delete(cachedId);
        removals.push(cachedId);
      }
    }

    if (updates.length > 0 || removals.length > 0) {
      socket.emit("player:delta", {
        room: room.code,
        tick: room.tick,
        updates,
        removes: removals
      });
    }
  }
}

function tickRooms() {
  for (const room of rooms.values()) {
    pruneRoomPlayers(room);
    if (!room || room.players.size === 0) {
      continue;
    }
    emitRoomDeltaSnapshot(room);
  }
}

function normalizeQuizAnswer(rawValue) {
  const value = String(rawValue ?? "")
    .trim()
    .toUpperCase();
  if (["O", "TRUE", "T", "YES", "Y", "1", "LEFT", "L"].includes(value)) {
    return "O";
  }
  if (["X", "FALSE", "F", "NO", "N", "0", "RIGHT", "R"].includes(value)) {
    return "X";
  }
  return null;
}

function sanitizeQuizLockSeconds(rawValue) {
  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds)) {
    return QUIZ_DEFAULT_LOCK_SECONDS;
  }
  return Math.max(QUIZ_MIN_LOCK_SECONDS, Math.min(QUIZ_MAX_LOCK_SECONDS, Math.round(seconds)));
}

function sanitizeQuizQuestion(rawQuestion = {}, index = 0) {
  const answer = normalizeQuizAnswer(rawQuestion.answer ?? rawQuestion.correct ?? rawQuestion.value);
  if (!answer) {
    return null;
  }

  const rawText = String(rawQuestion.text ?? rawQuestion.question ?? rawQuestion.title ?? "")
    .trim()
    .slice(0, QUIZ_TEXT_MAX_LENGTH);
  const text = rawText || `Question ${index + 1}`;

  const idValue = String(rawQuestion.id ?? `Q${index + 1}`)
    .trim()
    .slice(0, 24);
  const id = idValue || `Q${index + 1}`;

  const explanation = String(
    rawQuestion.explanation ?? rawQuestion.commentary ?? rawQuestion.desc ?? ""
  )
    .trim()
    .slice(0, QUIZ_EXPLANATION_MAX_LENGTH);

  return { id, text, answer, explanation };
}

function sanitizeQuizQuestions(
  rawQuestions,
  { fallbackToDefault = true, minQuestions = 1, maxQuestions = QUIZ_MAX_QUESTIONS } = {}
) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return fallbackToDefault ? getDefaultQuizConfigQuestions() : [];
  }

  const questions = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const question = sanitizeQuizQuestion(rawQuestions[index], index);
    if (!question) {
      continue;
    }
    questions.push(question);
    if (questions.length >= Math.max(1, Math.trunc(Number(maxQuestions) || QUIZ_MAX_QUESTIONS))) {
      break;
    }
  }

  if (questions.length < Math.max(0, Math.trunc(Number(minQuestions) || 0))) {
    return fallbackToDefault ? getDefaultQuizConfigQuestions() : [];
  }

  return questions;
}

function isInsideQuizZone(bounds, x, z) {
  const marginX = Math.min(QUIZ_ZONE_EDGE_MARGIN, bounds.width * 0.2);
  const marginZ = Math.min(QUIZ_ZONE_EDGE_MARGIN, bounds.depth * 0.2);
  return (
    x >= bounds.minX + marginX &&
    x <= bounds.maxX - marginX &&
    z >= bounds.minZ + marginZ &&
    z <= bounds.maxZ - marginZ
  );
}

function resolveQuizChoiceFromState(state) {
  const x = Number(state?.x);
  const z = Number(state?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return {
      choice: null,
      reason: "invalid-position",
      x: Number.isFinite(x) ? Number(x.toFixed(3)) : null,
      z: Number.isFinite(z) ? Number(z.toFixed(3)) : null
    };
  }

  const inO = isInsideQuizZone(QUIZ_O_ZONE, x, z);
  const inX = isInsideQuizZone(QUIZ_X_ZONE, x, z);
  if (inO && !inX) {
    return {
      choice: "O",
      reason: "zone-o",
      x: Number(x.toFixed(3)),
      z: Number(z.toFixed(3))
    };
  }
  if (inX && !inO) {
    return {
      choice: "X",
      reason: "zone-x",
      x: Number(x.toFixed(3)),
      z: Number(z.toFixed(3))
    };
  }

  if (Math.abs(x) <= QUIZ_CENTER_DEAD_BAND) {
    return {
      choice: null,
      reason: "center-line",
      x: Number(x.toFixed(3)),
      z: Number(z.toFixed(3))
    };
  }
  if (z < QUIZ_ACTIVE_MIN_Z || z > QUIZ_ACTIVE_MAX_Z) {
    return {
      choice: null,
      reason: "out-of-lane",
      x: Number(x.toFixed(3)),
      z: Number(z.toFixed(3))
    };
  }

  return {
    choice: null,
    reason: "off-zone",
    x: Number(x.toFixed(3)),
    z: Number(z.toFixed(3))
  };
}

function initializePlayerForQuiz(player, resetScore = true) {
  if (!player || typeof player !== "object") {
    return;
  }

  if (resetScore) {
    player.score = 0;
  } else {
    player.score = Number.isFinite(Number(player.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0;
  }
  player.alive = true;
  player.lastChoice = null;
  player.lastChoiceReason = null;
}

function isPlayerHostModerator(room, player) {
  if (!room || !player) {
    return false;
  }
  if (String(player.id ?? "") !== String(room.hostId ?? "")) {
    return false;
  }
  if (!ROOM_OWNER_KEY) {
    return true;
  }
  return player.isOwner === true;
}

function countPlayablePlayers(room) {
  let count = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player.admitted !== true) {
      continue;
    }
    count += 1;
  }
  return count;
}

function countWaitingPlayers(room) {
  let count = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player.admitted === true) {
      continue;
    }
    if (player.awaitingAdmission !== true) {
      continue;
    }
    count += 1;
  }
  return count;
}

function collectWaitingPlayers(room) {
  const waiting = [];
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player.admitted === true) {
      continue;
    }
    if (player.awaitingAdmission !== true) {
      continue;
    }
    waiting.push(player);
  }
  return waiting;
}

function countSpectatorPlayers(room) {
  let count = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player.admitted === true) {
      continue;
    }
    if (player.awaitingAdmission === true) {
      continue;
    }
    count += 1;
  }
  return count;
}

function openEntryGate(room) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }
  const quiz = getRoomQuiz(room);
  if (quiz.active) {
    return { ok: false, error: "quiz already active" };
  }
  const gate = ensureRoomEntryGate(room);
  if (gate.admissionStartsAt > Date.now()) {
    return { ok: false, error: "admission already in progress" };
  }
  if (gate.portalOpen) {
    return { ok: false, error: "lobby already open" };
  }
  gate.portalOpen = true;
  gate.openedAt = Date.now();
  gate.admissionStartsAt = 0;
  gate.pendingAdmissionIds = [];

  for (const player of room.players.values()) {
    if (!player) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      player.admitted = true;
      player.awaitingAdmission = false;
      removeNextPriorityPlayer(room, player.id);
      continue;
    }
    player.admitted = false;
    player.awaitingAdmission = true;
  }

  return {
    ok: true,
    waitingPlayers: countWaitingPlayers(room),
    spectatorPlayers: countSpectatorPlayers(room),
    participantLimit: ENTRY_PARTICIPANT_LIMIT,
    openedAt: gate.openedAt
  };
}

function startEntryAdmission(room) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }
  const quiz = getRoomQuiz(room);
  if (quiz.active) {
    return { ok: false, error: "quiz already active" };
  }
  const gate = ensureRoomEntryGate(room);
  if (!gate.portalOpen) {
    return { ok: false, error: "lobby not open" };
  }
  if (gate.admissionStartsAt > Date.now()) {
    return { ok: false, error: "admission already in progress" };
  }

  const waitingPlayers = collectWaitingPlayers(room);
  if (waitingPlayers.length <= 0) {
    gate.portalOpen = false;
    gate.lastAdmissionAt = Date.now();
    return {
      ok: false,
      error: "no waiting players",
      waitingPlayers: 0,
      spectatorPlayers: countSpectatorPlayers(room),
      admittedPlayers: countPlayablePlayers(room)
    };
  }

  const waitingById = new Map(
    waitingPlayers.map((player) => [String(player?.id ?? ""), player]).filter(([id]) => Boolean(id))
  );
  const priorityIds = normalizeEntryGateQueueIds(room, gate.nextPriorityIds);
  const orderedWaiting = [];
  for (const id of priorityIds) {
    const player = waitingById.get(id);
    if (!player) {
      continue;
    }
    orderedWaiting.push(player);
    waitingById.delete(id);
  }
  const remainingWaiting = Array.from(waitingById.values()).sort((left, right) => {
    const leftJoinedAt = Math.max(0, Math.trunc(Number(left?.joinedAt) || 0));
    const rightJoinedAt = Math.max(0, Math.trunc(Number(right?.joinedAt) || 0));
    if (leftJoinedAt !== rightJoinedAt) {
      return leftJoinedAt - rightJoinedAt;
    }
    return String(left?.name ?? "").localeCompare(String(right?.name ?? ""), "ko");
  });
  orderedWaiting.push(...remainingWaiting);

  const admissionTargets = orderedWaiting.slice(0, ENTRY_PARTICIPANT_LIMIT);
  const overflowTargets = orderedWaiting.slice(ENTRY_PARTICIPANT_LIMIT);
  for (const player of overflowTargets) {
    player.admitted = false;
    player.awaitingAdmission = false;
    player.alive = false;
    player.lastChoice = null;
    player.lastChoiceReason = "spectator";
  }

  const countdownMs = 3000;
  gate.portalOpen = false;
  gate.admissionStartsAt = Date.now() + countdownMs;
  gate.pendingAdmissionIds = admissionTargets.map((player) => String(player?.id ?? "")).filter(Boolean);
  gate.nextPriorityIds = overflowTargets.map((player) => String(player?.id ?? "")).filter(Boolean);
  if (gate.admissionTimer) {
    clearTimeout(gate.admissionTimer);
    gate.admissionTimer = null;
  }
  gate.admissionTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) {
      return;
    }
    const currentGate = ensureRoomEntryGate(currentRoom);
    currentGate.admissionTimer = null;
    const ids = Array.isArray(currentGate.pendingAdmissionIds) ? currentGate.pendingAdmissionIds : [];
    const targets = ids
      .map((id) => currentRoom.players.get(String(id)))
      .filter(Boolean)
      .filter((player) => !isPlayerHostModerator(currentRoom, player));

    for (let index = 0; index < targets.length; index += 1) {
      const player = targets[index];
      const spawn = buildAdmissionSpawnPoint(index, targets.length);
      player.admitted = true;
      player.awaitingAdmission = false;
      player.alive = true;
      player.lastChoice = null;
      player.lastChoiceReason = "admitted";
      setPlayerAuthoritativeState(player, {
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        yaw: 0,
        pitch: 0
      });
      const targetSocket = io.sockets.sockets.get(player.id);
      if (targetSocket) {
        targetSocket.emit("player:correct", {
          state: player.state,
          reason: "entry-admitted"
        });
      }
    }

    currentGate.lastAdmissionAt = Date.now();
    currentGate.admissionStartsAt = 0;
    currentGate.pendingAdmissionIds = [];
    currentGate.nextPriorityIds = normalizeEntryGateQueueIds(currentRoom, currentGate.nextPriorityIds);
    io.to(currentRoom.code).emit("portal:lobby-admitted", {
      admittedCount: targets.length,
      spectatorCount: countSpectatorPlayers(currentRoom),
      priorityPlayers: currentGate.nextPriorityIds.length,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      at: currentGate.lastAdmissionAt
    });
    emitRoomUpdate(currentRoom);
    emitQuizScore(currentRoom, "lobby-admit");
  }, countdownMs);
  gate.admissionTimer.unref?.();

  gate.portalOpen = false;
  gate.lastAdmissionAt = 0;
  return {
    ok: true,
    waitingPlayers: countWaitingPlayers(room),
    admittedCount: admissionTargets.length,
    spectatorCount: overflowTargets.length,
    priorityPlayers: gate.nextPriorityIds.length,
    participantLimit: ENTRY_PARTICIPANT_LIMIT,
    admittedPlayers: countPlayablePlayers(room),
    startsAt: gate.admissionStartsAt,
    countdownMs
  };
}

function clearQuizAutoStartTimer(quiz) {
  if (!quiz || typeof quiz !== "object") {
    return;
  }
  if (quiz.autoStartTimer) {
    clearTimeout(quiz.autoStartTimer);
    quiz.autoStartTimer = null;
  }
  quiz.autoStartsAt = 0;
}

function clearQuizLockTimer(quiz) {
  if (!quiz || typeof quiz !== "object") {
    return;
  }
  clearQuizAutoStartTimer(quiz);
  if (quiz.lockTimer) {
    clearTimeout(quiz.lockTimer);
    quiz.lockTimer = null;
  }
  if (quiz.nextTimer) {
    clearTimeout(quiz.nextTimer);
    quiz.nextTimer = null;
  }
}

function resetQuizState(room) {
  const quiz = getRoomQuiz(room);
  clearQuizLockTimer(quiz);
  clearEntryAdmissionTimer(room);
  quiz.active = false;
  quiz.phase = "idle";
  quiz.autoMode = false;
  quiz.autoFinish = true;
  quiz.autoStartsAt = 0;
  quiz.hostId = room?.hostId ?? null;
  quiz.startedAt = 0;
  quiz.prepareEndsAt = 0;
  quiz.endedAt = 0;
  quiz.questionIndex = -1;
  quiz.totalQuestions = 0;
  quiz.currentQuestion = null;
  quiz.questions = [];
  quiz.lockSeconds = QUIZ_DEFAULT_LOCK_SECONDS;
  quiz.lockAt = 0;
  quiz.lastResult = null;
}

function serializeRoom(room) {
  pruneRoomPlayers(room);
  const gate = ensureRoomEntryGate(room);
  const priorityQueue = normalizeEntryGateQueueIds(room, gate.nextPriorityIds);
  return {
    code: room.code,
    hostId: room.hostId,
    portalTargetUrl: sanitizePortalTargetUrl(room?.portalTargetUrl ?? ""),
    entryGate: {
      portalOpen: gate.portalOpen === true,
      waitingPlayers: countWaitingPlayers(room),
      admittedPlayers: countPlayablePlayers(room),
      spectatorPlayers: countSpectatorPlayers(room),
      priorityPlayers: priorityQueue.length,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      roomCapacity: MAX_ROOM_PLAYERS,
      openedAt: Number(gate.openedAt || 0),
      lastAdmissionAt: Number(gate.lastAdmissionAt || 0),
      admissionStartsAt: Number(gate.admissionStartsAt || 0),
      admissionInProgress: Number(gate.admissionStartsAt || 0) > Date.now()
    },
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      state: player.state ?? null,
      score: Number.isFinite(Number(player.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0,
      alive: Boolean(player.alive),
      admitted: player.admitted !== false,
      queuedForAdmission: player.awaitingAdmission === true,
      spectator: isPlayerHostModerator(room, player),
      lastChoice: player.lastChoice ?? null,
      lastChoiceReason: player.lastChoiceReason ?? null
    }))
  };
}

function summarizeRooms() {
  const summary = [];
  for (const room of rooms.values()) {
    pruneRoomPlayers(room);
    summary.push({
      code: room.code,
      count: room.players.size,
      capacity: MAX_ROOM_PLAYERS,
      hostName: room.players.get(room.hostId)?.name ?? "AUTO",
      quizActive: Boolean(room.quiz?.active),
      createdAt: Number(room.createdAt || 0)
    });
  }

  summary.sort((left, right) => {
    const playersDelta = right.count - left.count;
    if (playersDelta !== 0) {
      return playersDelta;
    }
    return left.createdAt - right.createdAt;
  });

  return summary;
}

function emitRoomList(target = io) {
  target.emit("room:list", summarizeRooms());
}

function emitRoomUpdate(room) {
  io.to(room.code).emit("room:update", serializeRoom(room));
}

function isRoomHost(room, socketId) {
  if (!room || !socketId) {
    return false;
  }
  return String(room.hostId ?? "") === String(socketId);
}

function pickNextHostId(room) {
  if (!room?.players || room.players.size <= 0) {
    return null;
  }
  for (const [socketId, player] of room.players.entries()) {
    if (player?.isOwner === true) {
      return socketId;
    }
  }
  return room.players.keys().next().value ?? null;
}

function updateHost(room) {
  if (room.hostId && room.players.has(room.hostId)) {
    return false;
  }
  const previousHostId = room.hostId;
  room.hostId = pickNextHostId(room);
  return previousHostId !== room.hostId;
}

function buildQuizLeaderboard(room) {
  const players = Array.from(room?.players?.values?.() ?? []);
  const board = players.map((player) => {
    const score = Number.isFinite(Number(player?.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0;
    const spectator = isPlayerHostModerator(room, player) || player?.admitted !== true;
    return {
      id: player?.id,
      name: player?.name,
      score,
      alive: Boolean(player?.alive),
      spectator,
      lastChoice: player?.lastChoice ?? null,
      lastChoiceReason: player?.lastChoiceReason ?? null
    };
  });

  board.sort((left, right) => {
    if (left.spectator !== right.spectator) {
      return Number(left.spectator) - Number(right.spectator);
    }
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.alive !== right.alive) {
      return Number(right.alive) - Number(left.alive);
    }
    return String(left.name ?? "").localeCompare(String(right.name ?? ""));
  });

  return board;
}

function buildQuizRanking(room) {
  const leaderboard = buildQuizLeaderboard(room).filter((entry) => entry?.spectator !== true);
  const ranking = [];
  let previousScore = null;
  let currentRank = 0;

  for (let index = 0; index < leaderboard.length; index += 1) {
    const entry = leaderboard[index];
    const score = Number(entry?.score) || 0;
    if (previousScore === null || score !== previousScore) {
      currentRank = index + 1;
      previousScore = score;
    }
    ranking.push({
      ...entry,
      rank: currentRank
    });
  }

  return ranking;
}

function countQuizSurvivors(room) {
  let survivors = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player?.admitted !== true) {
      continue;
    }
    if (Boolean(player?.alive)) {
      survivors += 1;
    }
  }
  return survivors;
}

function emitQuizScore(room, reason = "update", targetSocket = null) {
  if (!room) {
    return;
  }

  const quiz = getRoomQuiz(room);
  const payload = {
    reason,
    active: Boolean(quiz.active),
    phase: String(quiz.phase ?? "idle"),
    autoMode: quiz.autoMode !== false,
    autoFinish: quiz.autoFinish !== false,
    autoStartsAt: Number(quiz.autoStartsAt ?? 0),
    prepareEndsAt: Number(quiz.prepareEndsAt ?? 0),
    hostId: quiz.hostId ?? room.hostId ?? null,
    questionIndex: Math.max(0, Number(quiz.questionIndex) + 1),
    totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
    lockAt: Number(quiz.lockAt ?? 0),
    survivors: countQuizSurvivors(room),
    leaderboard: buildQuizLeaderboard(room),
    updatedAt: Date.now()
  };

  if (targetSocket) {
    targetSocket.emit("quiz:score", payload);
    return;
  }

  io.to(room.code).emit("quiz:score", payload);
}

function buildQuizStartPayload(quiz) {
  return {
    startedAt: Number(quiz.startedAt ?? Date.now()),
    prepareEndsAt: Number(quiz.prepareEndsAt ?? 0),
    hostId: quiz.hostId ?? null,
    autoMode: quiz.autoMode !== false,
    autoFinish: quiz.autoFinish !== false,
    totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
    lockSeconds: sanitizeQuizLockSeconds(quiz.lockSeconds)
  };
}

function buildQuizQuestionPayload(quiz) {
  const question = quiz.currentQuestion;
  if (!question) {
    return null;
  }

  return {
    id: question.id,
    text: question.text,
    index: Math.max(1, Number(quiz.questionIndex) + 1),
    totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
    lockAt: Number(quiz.lockAt ?? 0)
  };
}

function buildQuizReviewPayload(quiz) {
  const safeQuestions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  const rawQuestionIndex = Number(quiz?.questionIndex);
  const resolvedQuestionIndex = Number.isFinite(rawQuestionIndex) ? Math.trunc(rawQuestionIndex) : -1;
  const answeredCount = Math.max(
    0,
    Math.min(
      safeQuestions.length,
      resolvedQuestionIndex + 1
    )
  );
  const usedQuestions = safeQuestions.slice(0, answeredCount);
  return usedQuestions.map((question, index) => ({
    id: String(question?.id ?? `Q${index + 1}`),
    index: index + 1,
    text: String(question?.text ?? "").slice(0, QUIZ_TEXT_MAX_LENGTH),
    answer: normalizeQuizAnswer(question?.answer) ?? "O",
    explanation: String(question?.explanation ?? "").slice(0, QUIZ_EXPLANATION_MAX_LENGTH)
  }));
}

function buildQuizEndPayload(room, reason = "finished") {
  const quiz = getRoomQuiz(room);
  const ranking = buildQuizRanking(room);
  const winners = ranking.filter((entry) => Number(entry.rank) === 1);

  return {
    reason,
    endedAt: Number(quiz.endedAt || Date.now()),
    questionIndex: Math.max(0, Number(quiz.questionIndex) + 1),
    totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
    winners,
    leaderboard: ranking,
    ranking,
    review: buildQuizReviewPayload(quiz)
  };
}

function buildQuizConfigPayload(room) {
  const config = ensureRoomQuizConfig(room);
  const questions = sanitizeQuizQuestions(config.questions, {
    fallbackToDefault: true,
    minQuestions: 1,
    maxQuestions: QUIZ_MAX_QUESTIONS
  });
  config.questions = questions;
  return {
    questions: questions.map((question, index) => ({
      id: String(question?.id ?? `Q${index + 1}`),
      text: String(question?.text ?? "").slice(0, QUIZ_TEXT_MAX_LENGTH),
      answer: normalizeQuizAnswer(question?.answer) ?? "O",
      explanation: String(question?.explanation ?? "").slice(0, QUIZ_EXPLANATION_MAX_LENGTH)
    })),
    slotCount: questions.length,
    maxQuestions: QUIZ_MAX_QUESTIONS,
    endPolicy: {
      autoFinish: config?.endPolicy?.autoFinish !== false
    }
  };
}

function emitQuizSnapshot(socket, room) {
  if (!socket || !room) {
    return;
  }

  const quiz = getRoomQuiz(room);
  const hasAutoCountdown = Number(quiz.autoStartsAt) > Date.now();
  if (!quiz.active && quiz.phase !== "ended" && !hasAutoCountdown) {
    return;
  }

  if (hasAutoCountdown) {
    socket.emit("quiz:auto-countdown", {
      autoMode: quiz.autoMode !== false,
      startsAt: Number(quiz.autoStartsAt),
      delayMs: Math.max(0, Number(quiz.autoStartsAt) - Date.now()),
      players: countPlayablePlayers(room),
      minPlayers: QUIZ_AUTO_START_MIN_PLAYERS
    });
  }

  if (quiz.startedAt > 0) {
    socket.emit("quiz:start", buildQuizStartPayload(quiz));
  }

  if (quiz.phase === "question") {
    const questionPayload = buildQuizQuestionPayload(quiz);
    if (questionPayload) {
      socket.emit("quiz:question", questionPayload);
    }
  }

  if (quiz.lastResult) {
    socket.emit("quiz:result", quiz.lastResult);
  }

  emitQuizScore(room, "snapshot", socket);

  if (quiz.phase === "ended") {
    socket.emit("quiz:end", buildQuizEndPayload(room, "snapshot"));
  }
}

function scheduleAutoQuizStart(
  room,
  {
    delayMs = QUIZ_AUTO_START_DELAY_MS,
    reason = "auto",
    minPlayers = QUIZ_AUTO_START_MIN_PLAYERS
  } = {}
) {
  if (!room) {
    return;
  }

  const quiz = getRoomQuiz(room);
  if (quiz.autoMode === false) {
    return;
  }
  if (quiz.active) {
    return;
  }
  const playablePlayers = countPlayablePlayers(room);
  if (playablePlayers < minPlayers) {
    clearQuizAutoStartTimer(quiz);
    return;
  }
  if (quiz.autoStartTimer) {
    return;
  }

  const safeDelay = Math.max(2000, Math.trunc(Number(delayMs) || QUIZ_AUTO_START_DELAY_MS));
  quiz.autoStartsAt = Date.now() + safeDelay;

  io.to(room.code).emit("quiz:auto-countdown", {
    autoMode: quiz.autoMode !== false,
    startsAt: quiz.autoStartsAt,
    delayMs: safeDelay,
    reason,
    players: playablePlayers,
    minPlayers
  });
  emitQuizScore(room, "auto-countdown");

  quiz.autoStartTimer = setTimeout(() => {
    quiz.autoStartTimer = null;
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) {
      return;
    }
    const currentQuiz = getRoomQuiz(currentRoom);
    currentQuiz.autoStartsAt = 0;
    if (currentQuiz.autoMode === false || currentQuiz.active) {
      return;
    }
    if (countPlayablePlayers(currentRoom) < minPlayers) {
      return;
    }

    const hostId =
      currentRoom.hostId && currentRoom.players.has(currentRoom.hostId)
        ? currentRoom.hostId
        : pickNextHostId(currentRoom);
    if (!currentQuiz.hostId || !currentRoom.players.has(currentQuiz.hostId)) {
      currentQuiz.hostId = hostId;
    }

    const started = startQuiz(currentRoom, currentQuiz.hostId ?? hostId, {
      lockSeconds: currentQuiz.lockSeconds,
      autoMode: true,
      autoFinish: ensureRoomQuizConfig(currentRoom)?.endPolicy?.autoFinish !== false
    });
    if (!started?.ok) {
      scheduleAutoQuizStart(currentRoom, { delayMs: QUIZ_AUTO_START_DELAY_MS, reason: "auto-retry" });
    }
  }, safeDelay);
}

function scheduleQuizLock(room, lockSeconds) {
  const quiz = getRoomQuiz(room);
  clearQuizLockTimer(quiz);

  const safeLockSeconds = sanitizeQuizLockSeconds(lockSeconds);
  const lockMs = safeLockSeconds * 1000;
  quiz.lockAt = Date.now() + lockMs;
  quiz.lockTimer = setTimeout(() => {
    evaluateQuizQuestion(room);
  }, lockMs);
}

function finishQuiz(room, reason = "finished") {
  if (!room) {
    return;
  }

  const quiz = getRoomQuiz(room);
  if (quiz.phase === "ended") {
    return;
  }

  clearQuizLockTimer(quiz);
  quiz.active = false;
  quiz.phase = "ended";
  quiz.lockAt = 0;
  quiz.prepareEndsAt = 0;
  quiz.endedAt = Date.now();

  const payload = buildQuizEndPayload(room, reason);
  io.to(room.code).emit("quiz:end", payload);
  emitQuizScore(room, "end");
  if (quiz.autoMode !== false) {
    scheduleAutoQuizStart(room, {
      delayMs: QUIZ_AUTO_RESTART_DELAY_MS,
      reason: "auto-restart"
    });
  }
}

function evaluateQuizQuestion(room) {
  if (!room) {
    return;
  }

  const quiz = getRoomQuiz(room);
  if (!quiz.active || quiz.phase !== "question" || !quiz.currentQuestion) {
    return;
  }

  clearQuizLockTimer(quiz);

  const question = quiz.currentQuestion;
  const lockedAt = Date.now();
  quiz.phase = "locked";
  quiz.lockAt = 0;

  io.to(room.code).emit("quiz:lock", {
    id: question.id,
    index: Math.max(1, Number(quiz.questionIndex) + 1),
    totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
    lockedAt
  });

  const correctPlayerIds = [];
  const eliminatedPlayerIds = [];
  const eliminatedPlayers = [];

  for (const player of room.players.values()) {
    if (!player || !player.alive) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      player.lastChoice = null;
      player.lastChoiceReason = "spectator";
      continue;
    }

    const judge = resolveQuizChoiceFromState(player.state);
    player.lastChoice = judge.choice;
    player.lastChoiceReason = judge.reason;

    if (judge.choice === question.answer) {
      player.score = Number.isFinite(Number(player.score)) ? Math.max(0, Math.trunc(Number(player.score))) + 1 : 1;
      correctPlayerIds.push(player.id);
    } else {
      player.alive = false;
      eliminatedPlayerIds.push(player.id);
      eliminatedPlayers.push({
        id: player.id,
        choice: judge.choice,
        reason: judge.reason,
        x: judge.x,
        z: judge.z
      });
    }
  }

  const survivorCount = countQuizSurvivors(room);
  const resultPayload = {
    id: question.id,
    answer: question.answer,
    index: Math.max(1, Number(quiz.questionIndex) + 1),
    totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
    lockedAt,
    survivorCount,
    correctPlayerIds,
    eliminatedPlayerIds,
    eliminatedPlayers
  };

  quiz.lastResult = resultPayload;
  io.to(room.code).emit("quiz:result", resultPayload);
  const autoFinish = quiz.autoFinish !== false;

  if (survivorCount <= 0) {
    if (autoFinish) {
      finishQuiz(room, "no-survivor");
    } else {
      quiz.phase = "waiting-next";
      emitQuizScore(room, "result-no-survivor-manual");
    }
    return;
  }

  const playablePlayers = countPlayablePlayers(room);
  if (survivorCount === 1 && QUIZ_END_ON_SINGLE_SURVIVOR && playablePlayers > 1) {
    if (autoFinish) {
      finishQuiz(room, "winner");
    } else {
      quiz.phase = "waiting-next";
      emitQuizScore(room, "result-winner-manual");
    }
    return;
  }

  if (quiz.questionIndex + 1 >= quiz.totalQuestions) {
    if (autoFinish) {
      finishQuiz(room, "all-questions-complete");
    } else {
      quiz.phase = "waiting-next";
      emitQuizScore(room, "result-all-complete-manual");
    }
    return;
  }

  quiz.phase = "waiting-next";
  emitQuizScore(room, "result");
  scheduleQuizNextQuestion(room);
}

function pushNextQuizQuestion(room, lockSecondsOverride = null) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }

  const quiz = getRoomQuiz(room);
  clearQuizLockTimer(quiz);
  if (!quiz.active) {
    return { ok: false, error: "quiz is not active" };
  }

  if (quiz.phase === "question") {
    return { ok: false, error: "question is already open" };
  }

  const nextIndex = quiz.questionIndex + 1;
  if (nextIndex >= quiz.questions.length) {
    if (quiz.autoFinish !== false) {
      finishQuiz(room, "all-questions-complete");
      return { ok: false, error: "no more questions" };
    }
    quiz.phase = "waiting-next";
    emitQuizScore(room, "manual-no-more-questions");
    return { ok: false, error: "no more questions" };
  }

  const nextQuestion = quiz.questions[nextIndex];
  quiz.questionIndex = nextIndex;
  quiz.currentQuestion = nextQuestion;
  quiz.phase = "question";
  quiz.lastResult = null;

  const lockSeconds = sanitizeQuizLockSeconds(
    lockSecondsOverride == null ? quiz.lockSeconds : lockSecondsOverride
  );
  quiz.lockSeconds = lockSeconds;
  scheduleQuizLock(room, lockSeconds);

  const questionPayload = buildQuizQuestionPayload(quiz);
  if (!questionPayload) {
    return { ok: false, error: "question payload build failed" };
  }

  io.to(room.code).emit("quiz:question", questionPayload);
  emitQuizScore(room, "question");

  return {
    ok: true,
    question: questionPayload
  };
}

function scheduleQuizNextQuestion(room, delayMs = QUIZ_AUTO_NEXT_DELAY_MS) {
  if (!room) {
    return;
  }
  const quiz = getRoomQuiz(room);
  if (!quiz.active || quiz.phase !== "waiting-next") {
    return;
  }
  if (quiz.nextTimer) {
    clearTimeout(quiz.nextTimer);
    quiz.nextTimer = null;
  }

  const safeDelay = Math.max(1200, Math.trunc(Number(delayMs) || QUIZ_AUTO_NEXT_DELAY_MS));
  quiz.nextTimer = setTimeout(() => {
    quiz.nextTimer = null;
    if (!quiz.active || quiz.phase !== "waiting-next") {
      return;
    }
    pushNextQuizQuestion(room, quiz.lockSeconds);
  }, safeDelay);
}

function scheduleQuizFirstQuestion(room, delayMs = QUIZ_PREPARE_DELAY_MS) {
  if (!room) {
    return 0;
  }
  const quiz = getRoomQuiz(room);
  if (!quiz.active || quiz.phase !== "start") {
    return 0;
  }
  if (quiz.nextTimer) {
    clearTimeout(quiz.nextTimer);
    quiz.nextTimer = null;
  }

  const safeDelay = Math.max(1600, Math.trunc(Number(delayMs) || QUIZ_PREPARE_DELAY_MS));
  quiz.prepareEndsAt = Date.now() + safeDelay;
  quiz.nextTimer = setTimeout(() => {
    quiz.nextTimer = null;
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) {
      return;
    }
    const currentQuiz = getRoomQuiz(currentRoom);
    if (!currentQuiz.active || currentQuiz.phase !== "start") {
      return;
    }
    currentQuiz.prepareEndsAt = 0;
    pushNextQuizQuestion(currentRoom, currentQuiz.lockSeconds);
  }, safeDelay);

  return safeDelay;
}

function startQuiz(room, hostSocketId, payload = {}) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }

  const quiz = getRoomQuiz(room);
  if (quiz.active) {
    return { ok: false, error: "quiz already active" };
  }
  clearQuizLockTimer(quiz);
  ensureRoomEntryGate(room);
  const quizConfig = ensureRoomQuizConfig(room);
  const waitingPlayers = countWaitingPlayers(room);
  if (waitingPlayers > 0) {
    return { ok: false, error: "players waiting admission" };
  }
  if (countPlayablePlayers(room) <= 0) {
    return { ok: false, error: "no playable players" };
  }

  const questionSource = Array.isArray(payload?.questions)
    ? payload.questions
    : quizConfig.questions;
  const questions = sanitizeQuizQuestions(questionSource, {
    fallbackToDefault: true,
    minQuestions: 1,
    maxQuestions: QUIZ_MAX_QUESTIONS
  });
  const lockSeconds = sanitizeQuizLockSeconds(payload.lockSeconds);
  const autoMode = payload.autoMode !== false;
  const autoFinish = Object.prototype.hasOwnProperty.call(payload ?? {}, "autoFinish")
    ? payload.autoFinish !== false
    : quizConfig?.endPolicy?.autoFinish !== false;
  const resolvedHostId =
    hostSocketId && room.players.has(hostSocketId)
      ? hostSocketId
      : room.hostId && room.players.has(room.hostId)
        ? room.hostId
        : pickNextHostId(room);

  quiz.active = true;
  quiz.phase = "start";
  quiz.autoMode = autoMode;
  quiz.autoFinish = autoFinish;
  quiz.autoStartsAt = 0;
  quiz.hostId = resolvedHostId;
  quiz.startedAt = Date.now();
  quiz.prepareEndsAt = 0;
  quiz.endedAt = 0;
  quiz.questionIndex = -1;
  quiz.totalQuestions = questions.length;
  quiz.currentQuestion = null;
  quiz.questions = questions;
  quiz.lockSeconds = lockSeconds;
  quiz.lockAt = 0;
  quiz.lastResult = null;

  for (const player of room.players.values()) {
    initializePlayerForQuiz(player, true);
    if (isPlayerHostModerator(room, player)) {
      player.admitted = true;
      player.awaitingAdmission = false;
      player.lastChoiceReason = "spectator";
    } else {
      player.awaitingAdmission = false;
      if (player.admitted === true) {
        player.admitted = true;
      } else {
        player.admitted = false;
        player.alive = false;
        player.lastChoiceReason = "spectator";
      }
    }
  }

  const startPayload = buildQuizStartPayload(quiz);
  const prepareDelay = scheduleQuizFirstQuestion(room, payload.prepareDelayMs);
  const startWithPrepare = {
    ...startPayload,
    prepareEndsAt: Number(quiz.prepareEndsAt || Date.now() + prepareDelay),
    prepareDelayMs: prepareDelay
  };
  io.to(room.code).emit("quiz:start", startWithPrepare);
  emitQuizScore(room, "start");

  return {
    ok: true,
    start: startWithPrepare
  };
}

function reconcileQuizAfterRosterChange(room, reason = "roster-change") {
  if (!room) {
    return;
  }

  const quiz = getRoomQuiz(room);
  if (room.players.size === 0) {
    resetQuizState(room);
    return;
  }

  if (!quiz.hostId || !room.players.has(quiz.hostId)) {
    quiz.hostId = room.hostId ?? pickNextHostId(room);
  }

  if (!quiz.active) {
    emitQuizScore(room, reason);
    if (quiz.autoMode !== false) {
      scheduleAutoQuizStart(room, {
        delayMs: QUIZ_AUTO_START_DELAY_MS,
        reason: `${reason}-auto`
      });
    }
    return;
  }

  const survivors = countQuizSurvivors(room);
  if (survivors <= 0) {
    finishQuiz(room, "player-left");
    return;
  }

  emitQuizScore(room, reason);
}

function pruneRoomPlayers(room) {
  if (!room || !io?.sockets?.sockets) {
    return false;
  }

  let changed = false;
  for (const socketId of room.players.keys()) {
    if (!io.sockets.sockets.has(socketId)) {
      room.players.delete(socketId);
      const gate = ensureRoomEntryGate(room);
      gate.pendingAdmissionIds = gate.pendingAdmissionIds.filter((id) => id !== socketId);
      removeNextPriorityPlayer(room, socketId);
      changed = true;
    }
  }

  if (changed) {
    updateHost(room);
    reconcileQuizAfterRosterChange(room, "prune");
    if (!room.persistent && room.players.size === 0) {
      clearEntryAdmissionTimer(room);
      resetQuizState(room);
      rooms.delete(room.code);
    }
  }
  return changed;
}

function ack(ackFn, payload) {
  if (typeof ackFn === "function") {
    ackFn(payload);
  }
}

function leaveCurrentRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) {
    return;
  }

  const room = rooms.get(roomCode);
  socket.leave(roomCode);
  socket.data.roomCode = null;
  clearSocketDeltaCache(socket, roomCode);

  if (!room) {
    emitRoomList();
    return;
  }

  room.players.delete(socket.id);
  const gate = ensureRoomEntryGate(room);
  gate.pendingAdmissionIds = gate.pendingAdmissionIds.filter((id) => id !== socket.id);
  removeNextPriorityPlayer(room, socket.id);
  pruneRoomPlayers(room);
  updateHost(room);
  reconcileQuizAfterRosterChange(room, "leave");

  if (!room.persistent && room.players.size === 0) {
    clearEntryAdmissionTimer(room);
    resetQuizState(room);
    rooms.delete(room.code);
  }

  if (room.players.size > 0) {
    emitRoomUpdate(room);
  }
  emitRoomList();
}

function pickOrCreateRoomForQuickJoin(preferredCode = null) {
  if (WORKER_SINGLE_ROOM_MODE) {
    const workerRoom =
      getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
    if (!isRoomJoinable(workerRoom)) {
      return null;
    }
    return workerRoom;
  }

  const candidate = findJoinableRoom(preferredCode);
  if (candidate) {
    return candidate;
  }
  if (rooms.size >= MAX_ACTIVE_ROOMS) {
    return null;
  }
  return createMatchRoom();
}

function joinRoom(socket, room, nameOverride = null) {
  if (!room) {
    return {
      ok: false,
      error: "no available room"
    };
  }

  pruneRoomPlayers(room);

  const name = sanitizeName(nameOverride ?? socket.data.playerName);
  socket.data.playerName = name;

  if (socket.data.roomCode === room.code && room.players.has(socket.id)) {
    const existing = room.players.get(socket.id);
    existing.name = name;
    existing.isOwner = existing.isOwner === true || socket.data.ownerClaim === true;
    existing.joinedAt = Math.max(0, Math.trunc(Number(existing.joinedAt) || Date.now()));
    ensurePlayerNetState(existing);
    if (socket.data.ownerClaim === true && room.hostId !== socket.id) {
      room.hostId = socket.id;
      const quizState = getRoomQuiz(room);
      quizState.hostId = socket.id;
      emitRoomUpdate(room);
      emitQuizScore(room, "owner-claim");
    }
    const quiz = getRoomQuiz(room);
    const gate = ensureRoomEntryGate(room);
    if (isPlayerHostModerator(room, existing)) {
      existing.admitted = true;
      existing.awaitingAdmission = false;
      removeNextPriorityPlayer(room, existing.id);
    } else if (quiz.active) {
      existing.admitted = false;
      existing.awaitingAdmission = false;
      addNextPriorityPlayer(room, existing.id);
    } else if (gate.admissionStartsAt > Date.now()) {
      existing.admitted = false;
      existing.awaitingAdmission = false;
      addNextPriorityPlayer(room, existing.id);
    } else if (gate.portalOpen) {
      existing.admitted = false;
      existing.awaitingAdmission = true;
    } else if (existing.admitted === false) {
      existing.awaitingAdmission = false;
      addNextPriorityPlayer(room, existing.id);
    } else {
      existing.admitted = true;
      existing.awaitingAdmission = false;
      removeNextPriorityPlayer(room, existing.id);
    }
    if (!quiz.active && quiz.autoMode !== false) {
      scheduleAutoQuizStart(room, {
        delayMs: QUIZ_AUTO_START_DELAY_MS,
        reason: "rejoin-auto"
      });
    }
    emitRoomUpdate(room);
    emitQuizSnapshot(socket, room);
    return { ok: true, room: serializeRoom(room) };
  }

  leaveCurrentRoom(socket);

  if (room.players.size >= MAX_ROOM_PLAYERS) {
    return {
      ok: false,
      error: `${room.code} room is full (${MAX_ROOM_PLAYERS})`
    };
  }

  const quiz = getRoomQuiz(room);
  const gate = ensureRoomEntryGate(room);
  const joinAsAlive = !quiz.active;
  const initialState = sanitizePlayerState();

  room.players.set(socket.id, {
    id: socket.id,
    name,
    state: initialState,
    score: 0,
    alive: joinAsAlive,
    admitted: true,
    awaitingAdmission: false,
    isOwner: socket.data.ownerClaim === true,
    joinedAt: Date.now(),
    lastChoice: null,
    lastChoiceReason: null,
    net: createPlayerNetState(initialState)
  });

  if (socket.data.ownerClaim === true) {
    room.hostId = socket.id;
  } else {
    updateHost(room);
  }
  if (!quiz.hostId || socket.data.ownerClaim === true) {
    quiz.hostId = room.hostId ?? socket.id;
  }

  const joined = room.players.get(socket.id);
  if (joined) {
    if (isPlayerHostModerator(room, joined)) {
      joined.admitted = true;
      joined.awaitingAdmission = false;
      removeNextPriorityPlayer(room, joined.id);
    } else if (quiz.active) {
      joined.admitted = false;
      joined.awaitingAdmission = false;
      addNextPriorityPlayer(room, joined.id);
    } else if (gate.admissionStartsAt > Date.now()) {
      joined.admitted = false;
      joined.awaitingAdmission = false;
      addNextPriorityPlayer(room, joined.id);
    } else if (gate.portalOpen) {
      joined.admitted = false;
      joined.awaitingAdmission = true;
    } else {
      joined.admitted = true;
      joined.awaitingAdmission = false;
      removeNextPriorityPlayer(room, joined.id);
    }
  }

  socket.join(room.code);
  socket.data.roomCode = room.code;

  emitRoomUpdate(room);
  emitRoomList();
  emitQuizSnapshot(socket, room);
  if (quiz.active || quiz.phase === "ended") {
    emitQuizScore(room, "join");
  } else if (quiz.autoMode !== false) {
    scheduleAutoQuizStart(room, {
      delayMs: QUIZ_AUTO_START_DELAY_MS,
      reason: "join-auto"
    });
  }

  return { ok: true, room: serializeRoom(room) };
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    const roomsSummary = summarizeRooms();
    const totalPlayers = roomsSummary.reduce((sum, room) => sum + Number(room.count || 0), 0);
    const activeQuizRooms = roomsSummary.filter((room) => room.quizActive).length;
    const topRoom = roomsSummary[0] ?? null;
    const topRoomQuiz = topRoom ? getRoomQuiz(getRoom(topRoom.code)) : null;
    writeJson(res, 200, {
      ok: true,
      service: "reclaim-fps-chat",
      rooms: roomsSummary.length,
      online: playerCount,
      totalPlayers,
      activeQuizRooms,
      capacityPerRoom: MAX_ROOM_PLAYERS,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      maxActiveRooms: MAX_ACTIVE_ROOMS,
      tickRate: SERVER_TICK_RATE,
      workerSingleRoomMode: WORKER_SINGLE_ROOM_MODE,
      workerRoomCode: WORKER_SINGLE_ROOM_MODE ? WORKER_FIXED_ROOM_CODE : null,
      topRoom: topRoom
        ? {
            code: topRoom.code,
            players: topRoom.count,
            capacity: topRoom.capacity,
            hostName: topRoom.hostName,
            quiz: topRoomQuiz
              ? {
                  active: Boolean(topRoomQuiz.active),
                  phase: topRoomQuiz.phase,
                  autoMode: topRoomQuiz.autoMode !== false,
                  autoStartsAt: Number(topRoomQuiz.autoStartsAt ?? 0),
                  questionIndex: Math.max(0, Number(topRoomQuiz.questionIndex) + 1),
                  totalQuestions: Math.max(0, Number(topRoomQuiz.totalQuestions) || 0)
                }
              : null
          }
        : null,
      now: Date.now()
    });
    return;
  }

  if (req.url === "/" || req.url === "/status") {
    writeJson(res, 200, {
      ok: true,
      message: "Emptines realtime sync server is running",
      roomPrefix: ROOM_CODE_PREFIX,
      capacityPerRoom: MAX_ROOM_PLAYERS,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      maxActiveRooms: MAX_ACTIVE_ROOMS,
      tickRate: SERVER_TICK_RATE,
      workerSingleRoomMode: WORKER_SINGLE_ROOM_MODE,
      workerRoomCode: WORKER_SINGLE_ROOM_MODE ? WORKER_FIXED_ROOM_CODE : null,
      health: "/health"
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

const roomTickInterval = setInterval(() => {
  tickRooms();
}, SERVER_TICK_INTERVAL_MS);
roomTickInterval.unref?.();

io.on("connection", (socket) => {
  socket.data.playerName = `PLAYER_${Math.floor(Math.random() * 9000 + 1000)}`;
  socket.data.roomCode = null;
  socket.data.deltaCache = new Map();
  socket.data.ownerClaim = false;

  if (WORKER_SINGLE_ROOM_MODE && REQUIRE_JOIN_TOKEN) {
    const token = String(
      socket.handshake?.auth?.token ??
        socket.handshake?.query?.token ??
        socket.handshake?.headers?.["x-room-token"] ??
        ""
    ).trim();
    const verified = validateJoinTokenForWorker(token);
    if (!verified?.ok) {
      socket.emit("auth:error", {
        code: "invalid-room-token",
        reason: verified?.error ?? "invalid token"
      });
      socket.disconnect(true);
      return;
    }
    socket.data.playerName = sanitizeName(verified.payload?.name ?? socket.data.playerName);
    socket.data.ownerClaim = Boolean(verified.payload?.ownerClaim);
  }

  playerCount += 1;

  console.log(`[+] player connected (${playerCount}) ${socket.id}`);

  socket.emit("server:role", {
    role: "worker",
    singleRoomMode: WORKER_SINGLE_ROOM_MODE,
    roomCode: WORKER_SINGLE_ROOM_MODE ? WORKER_FIXED_ROOM_CODE : null
  });

  const initialRoom = pickOrCreateRoomForQuickJoin();
  if (initialRoom) {
    joinRoom(socket, initialRoom);
  }
  emitRoomList(socket);

  socket.on("chat:send", ({ name, text }) => {
    const safeName = sanitizeName(name ?? socket.data.playerName);
    const safeText = String(text ?? "").trim().slice(0, 200);
    if (!safeText) {
      return;
    }

    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return;
    }

    socket.data.playerName = safeName;
    player.name = safeName;
    io.to(room.code).emit("chat:message", {
      id: socket.id,
      name: safeName,
      text: safeText
    });
    emitRoomUpdate(room);
  });

  socket.on("player:sync", (payload = {}) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return;
    }

    const net = ensurePlayerNetState(player);
    const seq = Number(payload?.s);
    if (Number.isFinite(seq)) {
      const safeSeq = Math.trunc(seq);
      const previousSeq = Number(net.lastSeq);
      if (Number.isFinite(previousSeq) && previousSeq >= 0) {
        // Drop stale/out-of-order sync packets to reduce correction jitter.
        if (safeSeq <= previousSeq && previousSeq - safeSeq < 1_000_000) {
          return;
        }
      }
      net.lastSeq = safeSeq;
    }

    const sanitized = sanitizePlayerState(payload);
    const movementResult = applyAuthoritativeMovement(player, sanitized);
    if (
      movementResult.clamped &&
      movementResult.correctionDistance >= SERVER_CORRECTION_MIN_DISTANCE
    ) {
      const now = Date.now();
      const cooldownElapsed = now - Number(net.lastCorrectionAt || 0);
      if (cooldownElapsed >= SERVER_CORRECTION_COOLDOWN_MS) {
        net.lastCorrectionAt = now;
        socket.emit("player:correct", {
          state: movementResult.nextState,
          reason: "server-authoritative"
        });
      }
    }
  });

  socket.on("quiz:start", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const started = startQuiz(room, socket.id, {
      ...payload,
      autoMode: false,
      prepareDelayMs: payload?.prepareDelayMs
    });
    ack(ackFn, started);
  });

  socket.on("quiz:next", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const result = pushNextQuizQuestion(room, payload.lockSeconds);
    ack(ackFn, result);
  });

  socket.on("quiz:force-lock", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const quiz = getRoomQuiz(room);
    if (!quiz.active || quiz.phase !== "question") {
      ack(ackFn, { ok: false, error: "question is not open" });
      return;
    }

    evaluateQuizQuestion(room);
    ack(ackFn, { ok: true });
  });

  socket.on("quiz:stop", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const quiz = getRoomQuiz(room);
    if (!quiz.active) {
      ack(ackFn, { ok: false, error: "quiz is not active" });
      return;
    }

    quiz.autoMode = false;
    finishQuiz(room, "stopped-by-host");
    ack(ackFn, { ok: true });
  });

  socket.on("room:claim-host", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const previousHostId = room.hostId ?? null;
    room.hostId = socket.id;
    const quiz = getRoomQuiz(room);
    quiz.hostId = socket.id;

    emitRoomUpdate(room);
    emitQuizScore(room, "host-claim");
    ack(ackFn, {
      ok: true,
      hostId: socket.id,
      changed: String(previousHostId ?? "") !== String(socket.id)
    });
  });

  socket.on("quiz:state", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    const quiz = getRoomQuiz(room);
    ack(ackFn, {
      ok: true,
      quiz: {
        active: Boolean(quiz.active),
        phase: quiz.phase,
        autoMode: quiz.autoMode !== false,
        autoFinish: quiz.autoFinish !== false,
        autoStartsAt: Number(quiz.autoStartsAt ?? 0),
        prepareEndsAt: Number(quiz.prepareEndsAt ?? 0),
        hostId: quiz.hostId ?? room.hostId ?? null,
        questionIndex: Math.max(0, Number(quiz.questionIndex) + 1),
        totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
        lockAt: Number(quiz.lockAt ?? 0),
        currentQuestion: buildQuizQuestionPayload(quiz),
        lastResult: quiz.lastResult ?? null,
        endedAt: Number(quiz.endedAt ?? 0)
      },
      scoreboard: {
        survivors: countQuizSurvivors(room),
        leaderboard: buildQuizLeaderboard(room)
      }
    });
  });

  socket.on("quiz:config:get", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    ack(ackFn, {
      ok: true,
      config: buildQuizConfigPayload(room)
    });
  });

  socket.on("quiz:config:set", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const quiz = getRoomQuiz(room);
    if (quiz.active) {
      ack(ackFn, { ok: false, error: "quiz already active" });
      return;
    }

    const config = ensureRoomQuizConfig(room);
    const rawQuestions = Array.isArray(payload?.questions) ? payload.questions : null;
    if (rawQuestions) {
      const sanitized = sanitizeQuizQuestions(rawQuestions, {
        fallbackToDefault: false,
        minQuestions: 1,
        maxQuestions: QUIZ_MAX_QUESTIONS
      });
      if (!Array.isArray(sanitized) || sanitized.length <= 0) {
        ack(ackFn, { ok: false, error: "invalid question config" });
        return;
      }
      config.questions = sanitized;
    }

    if (payload?.endPolicy && typeof payload.endPolicy === "object") {
      config.endPolicy.autoFinish = payload.endPolicy.autoFinish !== false;
    } else if (Object.prototype.hasOwnProperty.call(payload ?? {}, "autoFinish")) {
      config.endPolicy.autoFinish = payload.autoFinish !== false;
    }
    config.endPolicy.autoFinish = config.endPolicy.autoFinish !== false;
    quiz.autoFinish = config.endPolicy.autoFinish;

    const response = {
      ok: true,
      config: buildQuizConfigPayload(room)
    };
    io.to(room.code).emit("quiz:config:update", response.config);
    emitQuizScore(room, "config-update");
    ack(ackFn, response);
  });

  socket.on("room:list", () => {
    emitRoomList(socket);
  });

  socket.on("room:quick-join", (payload = {}, ackFn) => {
    applySocketOwnerAccess(socket, payload?.ownerKey);
    if (WORKER_SINGLE_ROOM_MODE) {
      const workerRoom =
        getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
      if (!workerRoom || workerRoom.players.size >= MAX_ROOM_PLAYERS) {
        ack(ackFn, { ok: false, error: "room full" });
        return;
      }
      ack(ackFn, joinRoom(socket, workerRoom, payload.name));
      return;
    }

    const preferredCode = sanitizeRoomCode(payload.roomCode ?? payload.code);
    const room = pickOrCreateRoomForQuickJoin(preferredCode);
    if (!room) {
      ack(ackFn, { ok: false, error: "no room capacity available" });
      return;
    }
    ack(ackFn, joinRoom(socket, room, payload.name));
  });

  socket.on("room:create", (payload = {}, ackFn) => {
    applySocketOwnerAccess(socket, payload?.ownerKey);
    if (WORKER_SINGLE_ROOM_MODE) {
      ack(ackFn, { ok: false, error: "create disabled in worker mode" });
      return;
    }

    if (rooms.size >= MAX_ACTIVE_ROOMS) {
      ack(ackFn, { ok: false, error: "room limit reached" });
      return;
    }
    const requestedCode = sanitizeRoomCode(payload.code ?? payload.roomCode);
    if (requestedCode && rooms.has(requestedCode)) {
      ack(ackFn, { ok: false, error: "room already exists" });
      return;
    }
    const room = createMatchRoom(requestedCode);
    ack(ackFn, joinRoom(socket, room, payload.name));
  });

  socket.on("room:join", (payload = {}, ackFn) => {
    applySocketOwnerAccess(socket, payload?.ownerKey);
    if (WORKER_SINGLE_ROOM_MODE) {
      const requested = sanitizeRoomCode(payload.code ?? payload.roomCode);
      if (requested && requested !== WORKER_FIXED_ROOM_CODE) {
        ack(ackFn, { ok: false, error: "room mismatch" });
        return;
      }
      const workerRoom =
        getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
      if (!workerRoom || workerRoom.players.size >= MAX_ROOM_PLAYERS) {
        ack(ackFn, { ok: false, error: "room full" });
        return;
      }
      ack(ackFn, joinRoom(socket, workerRoom, payload.name));
      return;
    }

    const code = sanitizeRoomCode(payload.code ?? payload.roomCode);
    if (!code) {
      ack(ackFn, { ok: false, error: "room code required" });
      return;
    }
    const room = getRoom(code);
    if (!room) {
      ack(ackFn, { ok: false, error: "room not found" });
      return;
    }
    ack(ackFn, joinRoom(socket, room, payload.name));
  });

  socket.on("portal:lobby-open", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const opened = openEntryGate(room);
    if (!opened?.ok) {
      ack(ackFn, opened);
      return;
    }

    emitRoomUpdate(room);
    emitQuizScore(room, "lobby-open");
    ack(ackFn, opened);
  });

  socket.on("portal:lobby-start", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const admitted = startEntryAdmission(room);
    if (!admitted?.ok) {
      emitRoomUpdate(room);
      ack(ackFn, admitted);
      return;
    }

    emitRoomUpdate(room);
    emitQuizScore(room, "lobby-admit-countdown");
    ack(ackFn, admitted);
  });

  socket.on("portal:set-target", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const rawTargetUrl = String(payload?.targetUrl ?? "").trim();
    const nextTargetUrl = sanitizePortalTargetUrl(rawTargetUrl);
    if (rawTargetUrl && !nextTargetUrl) {
      ack(ackFn, { ok: false, error: "invalid portal target" });
      return;
    }
    room.portalTargetUrl = nextTargetUrl;
    const updatePayload = {
      targetUrl: nextTargetUrl,
      updatedBy: socket.id,
      updatedAt: Date.now()
    };

    io.to(room.code).emit("portal:target:update", updatePayload);
    emitRoomUpdate(room);
    ack(ackFn, { ok: true, ...updatePayload });
  });

  socket.on("room:leave", (ackFn) => {
    leaveCurrentRoom(socket);
    ack(ackFn, { ok: true, room: null });
  });

  socket.on("disconnecting", () => {
    leaveCurrentRoom(socket);
    clearSocketDeltaCache(socket);
  });

  socket.on("disconnect", () => {
    playerCount = Math.max(0, playerCount - 1);
    console.log(`[-] player disconnected (${playerCount}) ${socket.id}`);
  });
});

const PORT = Number(process.env.PORT ?? 3001);
httpServer.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    void (async () => {
      const existingServer = await probeExistingServer(PORT);
      if (existingServer) {
        console.log(`Port ${PORT} is already in use. Existing sync server is running.`);
        process.exit(0);
      }

      console.error(`Port ${PORT} is in use by another process. Free the port or set a different PORT.`);
      process.exit(1);
    })();
    return;
  }

  console.error("Sync server failed to start:", error);
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
  if (WORKER_SINGLE_ROOM_MODE) {
    console.log(
      `Room worker mode (${WORKER_FIXED_ROOM_CODE}, capacity ${MAX_ROOM_PLAYERS}, participant limit ${ENTRY_PARTICIPANT_LIMIT}, token ${
        REQUIRE_JOIN_TOKEN ? "required" : "optional"
      })`
    );
    return;
  }
  console.log(
    `Match rooms enabled (${ROOM_CODE_PREFIX}-xxxxx, capacity ${MAX_ROOM_PLAYERS}, participant limit ${ENTRY_PARTICIPANT_LIMIT}, max rooms ${MAX_ACTIVE_ROOMS})`
  );
});


