import { createServer } from "http";
import { Server } from "socket.io";
import { BASE_VOID_PACK } from "./src/game/content/packs/base-void/pack.js";

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
const MAX_ROOM_PLAYERS = 50;
const MAX_ACTIVE_ROOMS = 24;

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
const SERVER_CORRECTION_MIN_DISTANCE = 0.08;

const QUIZ_DEFAULT_LOCK_SECONDS = 15;
const QUIZ_MIN_LOCK_SECONDS = 3;
const QUIZ_MAX_LOCK_SECONDS = 60;
const QUIZ_MAX_QUESTIONS = 50;
const QUIZ_TEXT_MAX_LENGTH = 180;
const QUIZ_AUTO_NEXT_DELAY_MS = 3200;
const QUIZ_AUTO_START_DELAY_MS = 12000;
const QUIZ_AUTO_RESTART_DELAY_MS = 9000;
const QUIZ_AUTO_START_MIN_PLAYERS = 1;
const QUIZ_ZONE_EDGE_MARGIN = 0.5;
const QUIZ_ZONE_CENTER_MARGIN = 0.8;

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

const rooms = new Map();
let playerCount = 0;

function createQuizState() {
  return {
    active: false,
    phase: "idle",
    autoMode: true,
    autoStartsAt: 0,
    autoStartTimer: null,
    hostId: null,
    startedAt: 0,
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
    persistent,
    createdAt: Date.now(),
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

function isRoomJoinable(room) {
  if (!room) {
    return false;
  }
  pruneRoomPlayers(room);
  return room.players.size < MAX_ROOM_PLAYERS;
}

function findJoinableRoom(preferredCode = null) {
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

function getRoomQuiz(room) {
  if (!room || typeof room !== "object") {
    return createQuizState();
  }
  if (!room.quiz || typeof room.quiz !== "object") {
    room.quiz = createQuizState();
  }
  return room.quiz;
}

function sanitizeName(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 16);
  return value || "PLAYER";
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
  const dt = Math.max(1 / 120, Math.min(0.25, elapsedMs / 1000));

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

  return { id, text, answer };
}

function sanitizeQuizQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return FALLBACK_QUIZ_QUESTIONS.map((question) => ({ ...question }));
  }

  const questions = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const question = sanitizeQuizQuestion(rawQuestions[index], index);
    if (!question) {
      continue;
    }
    questions.push(question);
    if (questions.length >= QUIZ_MAX_QUESTIONS) {
      break;
    }
  }

  if (questions.length === 0) {
    return FALLBACK_QUIZ_QUESTIONS.map((question) => ({ ...question }));
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
  quiz.active = false;
  quiz.phase = "idle";
  quiz.autoMode = true;
  quiz.autoStartsAt = 0;
  quiz.hostId = room?.hostId ?? null;
  quiz.startedAt = 0;
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
  return {
    code: room.code,
    hostId: room.hostId,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      state: player.state ?? null,
      score: Number.isFinite(Number(player.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0,
      alive: Boolean(player.alive),
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

function updateHost(room) {
  if (room.hostId && room.players.has(room.hostId)) {
    return false;
  }
  const previousHostId = room.hostId;
  room.hostId = room.players.keys().next().value ?? null;
  return previousHostId !== room.hostId;
}

function buildQuizLeaderboard(room) {
  const players = Array.from(room?.players?.values?.() ?? []);
  const board = players.map((player) => {
    const score = Number.isFinite(Number(player?.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0;
    return {
      id: player?.id,
      name: player?.name,
      score,
      alive: Boolean(player?.alive),
      lastChoice: player?.lastChoice ?? null,
      lastChoiceReason: player?.lastChoiceReason ?? null
    };
  });

  board.sort((left, right) => {
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

function countQuizSurvivors(room) {
  let survivors = 0;
  for (const player of room?.players?.values?.() ?? []) {
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
    autoStartsAt: Number(quiz.autoStartsAt ?? 0),
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
    hostId: quiz.hostId ?? null,
    autoMode: quiz.autoMode !== false,
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

function buildQuizEndPayload(room, reason = "finished") {
  const quiz = getRoomQuiz(room);
  const leaderboard = buildQuizLeaderboard(room);
  const topScore = leaderboard.length > 0 ? Number(leaderboard[0].score) || 0 : 0;
  const winners =
    topScore > 0
      ? leaderboard.filter((entry) => Number(entry.score) === topScore)
      : leaderboard.filter((entry) => entry.alive);

  return {
    reason,
    endedAt: Number(quiz.endedAt || Date.now()),
    questionIndex: Math.max(0, Number(quiz.questionIndex) + 1),
    totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
    winners,
    leaderboard
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
      players: room.players.size,
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
  if (room.players.size < minPlayers) {
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
    players: room.players.size,
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
    if (currentRoom.players.size < minPlayers) {
      return;
    }

    const hostId =
      currentRoom.hostId && currentRoom.players.has(currentRoom.hostId)
        ? currentRoom.hostId
        : currentRoom.players.keys().next().value ?? null;
    if (!currentQuiz.hostId || !currentRoom.players.has(currentQuiz.hostId)) {
      currentQuiz.hostId = hostId;
    }

    const started = startQuiz(currentRoom, currentQuiz.hostId ?? hostId, {
      lockSeconds: currentQuiz.lockSeconds,
      autoMode: true
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

  if (survivorCount <= 1) {
    finishQuiz(room, survivorCount === 1 ? "winner" : "no-survivor");
    return;
  }

  if (quiz.questionIndex + 1 >= quiz.totalQuestions) {
    finishQuiz(room, "all-questions-complete");
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
    finishQuiz(room, "all-questions-complete");
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

function startQuiz(room, hostSocketId, payload = {}) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }

  const quiz = getRoomQuiz(room);
  clearQuizLockTimer(quiz);

  const questions = sanitizeQuizQuestions(payload.questions);
  const lockSeconds = sanitizeQuizLockSeconds(payload.lockSeconds);
  const autoMode = payload.autoMode !== false;
  const resolvedHostId =
    hostSocketId && room.players.has(hostSocketId)
      ? hostSocketId
      : room.hostId && room.players.has(room.hostId)
        ? room.hostId
        : room.players.keys().next().value ?? null;

  quiz.active = true;
  quiz.phase = "idle";
  quiz.autoMode = autoMode;
  quiz.autoStartsAt = 0;
  quiz.hostId = resolvedHostId;
  quiz.startedAt = Date.now();
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
  }

  const startPayload = buildQuizStartPayload(quiz);
  io.to(room.code).emit("quiz:start", startPayload);
  emitQuizScore(room, "start");

  const first = pushNextQuizQuestion(room, lockSeconds);
  if (!first.ok) {
    return first;
  }

  return {
    ok: true,
    start: startPayload,
    question: first.question
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
    quiz.hostId = room.hostId ?? room.players.keys().next().value ?? null;
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
  if (survivors <= 1) {
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
      changed = true;
    }
  }

  if (changed) {
    updateHost(room);
    reconcileQuizAfterRosterChange(room, "prune");
    if (!room.persistent && room.players.size === 0) {
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
  pruneRoomPlayers(room);
  updateHost(room);
  reconcileQuizAfterRosterChange(room, "leave");

  if (!room.persistent && room.players.size === 0) {
    resetQuizState(room);
    rooms.delete(room.code);
  }

  if (room.players.size > 0) {
    emitRoomUpdate(room);
  }
  emitRoomList();
}

function pickOrCreateRoomForQuickJoin(preferredCode = null) {
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
    ensurePlayerNetState(existing);
    const quiz = getRoomQuiz(room);
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
  const joinAsAlive = !quiz.active;
  const initialState = sanitizePlayerState();

  room.players.set(socket.id, {
    id: socket.id,
    name,
    state: initialState,
    score: 0,
    alive: joinAsAlive,
    lastChoice: null,
    lastChoiceReason: null,
    net: createPlayerNetState(initialState)
  });

  updateHost(room);
  if (!quiz.hostId) {
    quiz.hostId = room.hostId ?? null;
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
      maxActiveRooms: MAX_ACTIVE_ROOMS,
      tickRate: SERVER_TICK_RATE,
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
      maxActiveRooms: MAX_ACTIVE_ROOMS,
      tickRate: SERVER_TICK_RATE,
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
  playerCount += 1;
  socket.data.playerName = `PLAYER_${Math.floor(Math.random() * 9000 + 1000)}`;
  socket.data.roomCode = null;
  socket.data.deltaCache = new Map();

  console.log(`[+] player connected (${playerCount}) ${socket.id}`);

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

    const sanitized = sanitizePlayerState(payload);
    const movementResult = applyAuthoritativeMovement(player, sanitized);
    if (
      movementResult.clamped &&
      movementResult.correctionDistance >= SERVER_CORRECTION_MIN_DISTANCE
    ) {
      const now = Date.now();
      const net = ensurePlayerNetState(player);
      const cooldownElapsed = now - Number(net.lastCorrectionAt || 0);
      if (cooldownElapsed >= 90) {
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

    const started = startQuiz(room, socket.id, { ...payload, autoMode: true });
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

    const quiz = getRoomQuiz(room);
    if (!quiz.active) {
      ack(ackFn, { ok: false, error: "quiz is not active" });
      return;
    }

    quiz.autoMode = true;
    finishQuiz(room, "stopped-by-host");
    ack(ackFn, { ok: true });
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
        autoStartsAt: Number(quiz.autoStartsAt ?? 0),
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

  socket.on("room:list", () => {
    emitRoomList(socket);
  });

  socket.on("room:quick-join", (payload = {}, ackFn) => {
    const preferredCode = sanitizeRoomCode(payload.roomCode ?? payload.code);
    const room = pickOrCreateRoomForQuickJoin(preferredCode);
    if (!room) {
      ack(ackFn, { ok: false, error: "no room capacity available" });
      return;
    }
    ack(ackFn, joinRoom(socket, room, payload.name));
  });

  socket.on("room:create", (payload = {}, ackFn) => {
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
  console.log(
    `Match rooms enabled (${ROOM_CODE_PREFIX}-xxxxx, capacity ${MAX_ROOM_PLAYERS}, max rooms ${MAX_ACTIVE_ROOMS})`
  );
});
