import { createServer } from "http";
import { Server } from "socket.io";

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

const DEFAULT_ROOM_CODE = "GLOBAL";
const MAX_ROOM_PLAYERS = 50;

const QUIZ_DEFAULT_LOCK_SECONDS = 15;
const QUIZ_MIN_LOCK_SECONDS = 3;
const QUIZ_MAX_LOCK_SECONDS = 60;
const QUIZ_MAX_QUESTIONS = 50;
const QUIZ_TEXT_MAX_LENGTH = 180;
const QUIZ_AUTO_NEXT_DELAY_MS = 3200;
const QUIZ_ZONE_O_MAX_X = -4;
const QUIZ_ZONE_X_MIN_X = 4;

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

const rooms = new Map();
let playerCount = 0;

function createQuizState() {
  return {
    active: false,
    phase: "idle",
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

function createPersistentRoom() {
  return {
    code: DEFAULT_ROOM_CODE,
    hostId: null,
    players: new Map(),
    persistent: true,
    createdAt: Date.now(),
    quiz: createQuizState()
  };
}

function getDefaultRoom() {
  let room = rooms.get(DEFAULT_ROOM_CODE);
  if (!room) {
    room = createPersistentRoom();
    rooms.set(DEFAULT_ROOM_CODE, room);
  }
  return room;
}

getDefaultRoom();

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

function resolveQuizChoiceFromState(state) {
  const x = Number(state?.x);
  if (!Number.isFinite(x)) {
    return null;
  }
  if (x <= QUIZ_ZONE_O_MAX_X) {
    return "O";
  }
  if (x >= QUIZ_ZONE_X_MIN_X) {
    return "X";
  }
  return null;
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
}

function clearQuizLockTimer(quiz) {
  if (!quiz || typeof quiz !== "object") {
    return;
  }
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
      lastChoice: player.lastChoice ?? null
    }))
  };
}

function summarizeRooms() {
  const room = getDefaultRoom();
  pruneRoomPlayers(room);
  return [
    {
      code: room.code,
      count: room.players.size,
      capacity: MAX_ROOM_PLAYERS,
      hostName: room.players.get(room.hostId)?.name ?? "AUTO"
    }
  ];
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
      lastChoice: player?.lastChoice ?? null
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
  if (!quiz.active && quiz.phase !== "ended") {
    return;
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

  for (const player of room.players.values()) {
    if (!player || !player.alive) {
      continue;
    }

    const choice = resolveQuizChoiceFromState(player.state);
    player.lastChoice = choice;

    if (choice === question.answer) {
      player.score = Number.isFinite(Number(player.score)) ? Math.max(0, Math.trunc(Number(player.score))) + 1 : 1;
      correctPlayerIds.push(player.id);
    } else {
      player.alive = false;
      eliminatedPlayerIds.push(player.id);
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
    eliminatedPlayerIds
  };

  quiz.lastResult = resultPayload;
  io.to(room.code).emit("quiz:result", resultPayload);
  emitQuizScore(room, "result");

  if (survivorCount <= 1) {
    finishQuiz(room, survivorCount === 1 ? "winner" : "no-survivor");
    return;
  }

  if (quiz.questionIndex + 1 >= quiz.totalQuestions) {
    finishQuiz(room, "all-questions-complete");
    return;
  }

  quiz.phase = "waiting-next";
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

  quiz.active = true;
  quiz.phase = "idle";
  quiz.hostId = hostSocketId;
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
  if (!quiz.active && quiz.phase !== "ended") {
    return;
  }

  if (room.players.size === 0) {
    resetQuizState(room);
    return;
  }

  if (!quiz.hostId || !room.players.has(quiz.hostId)) {
    quiz.hostId = room.hostId ?? null;
  }

  if (!quiz.active) {
    emitQuizScore(room, reason);
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

  if (!room) {
    emitRoomList();
    return;
  }

  room.players.delete(socket.id);
  pruneRoomPlayers(room);
  updateHost(room);
  reconcileQuizAfterRosterChange(room, "leave");

  if (!room.persistent && room.players.size === 0) {
    rooms.delete(room.code);
  }

  emitRoomUpdate(room);
  emitRoomList();
}

function joinDefaultRoom(socket, nameOverride = null) {
  const room = getDefaultRoom();
  pruneRoomPlayers(room);

  const name = sanitizeName(nameOverride ?? socket.data.playerName);
  socket.data.playerName = name;

  if (socket.data.roomCode === room.code && room.players.has(socket.id)) {
    const existing = room.players.get(socket.id);
    existing.name = name;
    emitRoomUpdate(room);
    emitQuizSnapshot(socket, room);
    return { ok: true, room: serializeRoom(room) };
  }

  leaveCurrentRoom(socket);

  if (room.players.size >= MAX_ROOM_PLAYERS) {
    return {
      ok: false,
      error: `GLOBAL room is full (${MAX_ROOM_PLAYERS})`
    };
  }

  const quiz = getRoomQuiz(room);
  const joinAsAlive = !quiz.active;

  room.players.set(socket.id, {
    id: socket.id,
    name,
    state: sanitizePlayerState(),
    score: 0,
    alive: joinAsAlive,
    lastChoice: null
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
  }

  return { ok: true, room: serializeRoom(room) };
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    const globalRoom = getDefaultRoom();
    const quiz = getRoomQuiz(globalRoom);
    writeJson(res, 200, {
      ok: true,
      service: "reclaim-fps-chat",
      rooms: rooms.size,
      online: playerCount,
      globalPlayers: globalRoom.players.size,
      globalCapacity: MAX_ROOM_PLAYERS,
      quiz: {
        active: Boolean(quiz.active),
        phase: quiz.phase,
        questionIndex: Math.max(0, Number(quiz.questionIndex) + 1),
        totalQuestions: Math.max(0, Number(quiz.totalQuestions) || 0),
        survivors: countQuizSurvivors(globalRoom)
      },
      now: Date.now()
    });
    return;
  }

  if (req.url === "/" || req.url === "/status") {
    writeJson(res, 200, {
      ok: true,
      message: "Emptines realtime sync server is running",
      room: DEFAULT_ROOM_CODE,
      capacity: MAX_ROOM_PLAYERS,
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

io.on("connection", (socket) => {
  playerCount += 1;
  socket.data.playerName = `PLAYER_${Math.floor(Math.random() * 9000 + 1000)}`;
  socket.data.roomCode = null;

  console.log(`[+] player connected (${playerCount}) ${socket.id}`);

  joinDefaultRoom(socket);
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

    const nextState = sanitizePlayerState(payload);
    player.state = nextState;

    socket.to(room.code).emit("player:sync", {
      id: player.id,
      name: player.name,
      state: nextState
    });
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

    const started = startQuiz(room, socket.id, payload);
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
    ack(ackFn, joinDefaultRoom(socket, payload.name));
  });

  socket.on("room:create", (payload = {}, ackFn) => {
    ack(ackFn, joinDefaultRoom(socket, payload.name));
  });

  socket.on("room:join", (payload = {}, ackFn) => {
    ack(ackFn, joinDefaultRoom(socket, payload.name));
  });

  socket.on("room:leave", (ackFn) => {
    ack(ackFn, joinDefaultRoom(socket));
  });

  socket.on("disconnecting", () => {
    leaveCurrentRoom(socket);
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
  console.log(`Persistent room: ${DEFAULT_ROOM_CODE} (capacity ${MAX_ROOM_PLAYERS})`);
});
