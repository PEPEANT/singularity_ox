import * as THREE from "three";
import { io } from "socket.io-client";
import { Sky } from "three/addons/objects/Sky.js";
import { Water } from "three/addons/objects/Water.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { HUD } from "../ui/HUD.js";
import { GAME_CONSTANTS } from "../config/gameConstants.js";
import { getContentPack } from "../content/registry.js";
import { isLikelyTouchDevice } from "../utils/device.js";
import { lerpAngle } from "../utils/math.js";
import { disposeMeshTree } from "../utils/threeUtils.js";
import { RUNTIME_TUNING } from "./config/runtimeTuning.js";

function parseVec3(raw, fallback) {
  const base = Array.isArray(fallback) ? fallback : [0, 0, 0];
  const value = Array.isArray(raw) ? raw : base;
  return new THREE.Vector3(
    Number(value[0] ?? base[0]) || 0,
    Number(value[1] ?? base[1]) || 0,
    Number(value[2] ?? base[2]) || 0
  );
}

function parseSeconds(raw, fallback, min = 0.1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, value);
}

const NPC_GREETING_VIDEO_URL = new URL("../../../mp4/grok-video.webm", import.meta.url).href;
const BILLBOARD_PRESET_IMAGE_URL = new URL(
  "../../../mp4/Gemini_Generated_Image_3lk4q93lk4q93lk4.png",
  import.meta.url
).href;
const BILLBOARD_PRESET_AUDIO_URL = "/assets/audio/weapons/gunshot_0.mp3";
const BILLBOARD_PLAYLIST_MAX_ITEMS = 40;
function sanitizeBillboardMediaUrl(raw) {
  const value = String(raw ?? "").trim().slice(0, 420);
  if (!value) {
    return "";
  }
  if (value.startsWith("/")) {
    return value;
  }
  try {
    const target = new URL(value, window.location.href);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return "";
    }
    return target.toString().slice(0, 420);
  } catch {
    return "";
  }
}

function inferBillboardVisualTypeFromUrl(rawUrl) {
  const url = String(rawUrl ?? "").trim().toLowerCase();
  if (!url) {
    return "none";
  }
  if (/\.(mp4|webm|mov|m4v)(\?.*)?$/.test(url)) {
    return "video";
  }
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?.*)?$/.test(url)) {
    return "image";
  }
  return "none";
}
const CENTER_BILLBOARD_BASE_WIDTH = 1024;
const CENTER_BILLBOARD_BASE_HEIGHT = 512;
const OPPOSITE_BILLBOARD_BASE_WIDTH = 1280;
const OPPOSITE_BILLBOARD_BASE_HEIGHT = 720;
const DYNAMIC_RESOLUTION_SETTINGS = Object.freeze({
  sampleWindowSeconds: 1.6,
  downshiftFps: 33,
  upshiftFps: 54,
  downshiftStep: 0.04,
  upshiftStep: 0.06,
  downshiftCooldownSeconds: 5.2,
  upshiftCooldownSeconds: 2.4,
  idleCooldownSeconds: 2.2,
  ratioEpsilon: 0.04,
  stableSamplesRequired: 6,
  applyDelaySeconds: 0.65
});
const ROUND_OVERLAY_SETTINGS = Object.freeze({
  prepareDurationSeconds: 3.2,
  endDurationSeconds: 6.6,
  fireworkSpawnIntervalSeconds: 0.26,
  fireworkParticleCountMin: 30,
  fireworkParticleCountMax: 44
});
const MOBILE_RUNTIME_SETTINGS = Object.freeze({
  maxPixelRatio: 1.6,
  minNetworkSyncInterval: 0.12,
  lookSensitivityX: 0.0106,
  lookSensitivityY: 0.0094,
  fovLandscape: 96,
  fovPortrait: 104,
  hudRefreshIntervalSeconds: 0.32,
  roundOverlaySpawnIntervalSeconds: 0.46,
  roundOverlayParticleScale: 0.58
});
const DESKTOP_RUNTIME_SETTINGS = Object.freeze({
  maxPixelRatio: 1.5,
  orientationCorrectionInputLockMs: 260
});
const MOVEMENT_KEY_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "ShiftLeft",
  "ShiftRight"
]);
const QUIZ_CONFIG_DRAFT_STORAGE_PREFIX = "singularity_ox.quiz_config_draft.v1";
const QUIZ_CATEGORY_STORAGE_PREFIX = "singularity_ox.quiz_category.v1";
const QUIZ_CONFIG_DRAFT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 21;
const LAST_ROOM_CODE_STORAGE_KEY = "singularity_ox.last_room_code.v1";
const OWNER_ACCESS_STORAGE_KEY = "singularity_ox.owner_access_key.v1";
const LOBBY_JOIN_ACK_TIMEOUT_MS = 9000;
const LOBBY_JOIN_AUTO_RETRY_LIMIT = 2;
const LOBBY_JOIN_AUTO_RETRY_DELAY_MS = 500;
const QUIZ_MIN_TIME_LIMIT_SECONDS = 15;
const QUIZ_MAX_TIME_LIMIT_SECONDS = 3600;
const QUIZ_DEFAULT_TIME_LIMIT_SECONDS = 30;
const OFFLINE_START_INTERACT_DISTANCE = 4.2;
const OFFLINE_START_PREPARE_DELAY_MS = 10000;
const BILLBOARD_MEDIA_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const CHAT_BUBBLE_MIN_LIFETIME_MS = 9000;
const MOBILE_CHAT_PREVIEW_MIN_LIFETIME_MS = 7000;
const GRAPHICS_QUALITY_STORAGE_KEY = "singularity_ox.graphics_quality.v1";
const UI_VOLUME_STORAGE_KEY = "singularity_ox.ui_volume.v1";
const CHAT_LIVE_MAX_ENTRIES = 24;

export class GameRuntime {
  constructor(mount, options = {}) {
    this.mount = mount;
    this.clock = new THREE.Clock();
    this.mobileEnabled = isLikelyTouchDevice();
    this.mobileModeLocked = this.mobileEnabled;
    this.hud = new HUD();

    this.contentPack = options.contentPack ?? getContentPack(options.contentPackId);
    this.worldContent = this.contentPack.world;
    this.handContent = this.contentPack.hands;
    this.networkContent = this.contentPack.network;
    this.baseNetworkSyncInterval =
      Number(this.networkContent.syncInterval) || GAME_CONSTANTS.REMOTE_SYNC_INTERVAL;
    this.networkSyncInterval = this.mobileEnabled
      ? Math.max(this.baseNetworkSyncInterval, MOBILE_RUNTIME_SETTINGS.minNetworkSyncInterval)
      : this.baseNetworkSyncInterval;
    this.remoteLerpSpeed =
      Number(this.networkContent.remoteLerpSpeed) || GAME_CONSTANTS.REMOTE_LERP_SPEED;
    this.remoteStaleTimeoutMs =
      Number(this.networkContent.staleTimeoutMs) || GAME_CONSTANTS.REMOTE_STALE_TIMEOUT_MS;

    const initialPixelRatioCap = this.mobileEnabled
      ? MOBILE_RUNTIME_SETTINGS.maxPixelRatio
      : DESKTOP_RUNTIME_SETTINGS.maxPixelRatio;
    const initialPixelRatio = Math.min(window.devicePixelRatio || 1, initialPixelRatioCap);
    this.maxPixelRatio = initialPixelRatio;
    this.currentPixelRatio = initialPixelRatio;
    this.graphicsQualityStorageKey = GRAPHICS_QUALITY_STORAGE_KEY;
    this.graphicsQuality = this.loadGraphicsQualityPreference();
    this.uiVolumeStorageKey = UI_VOLUME_STORAGE_KEY;
    this.uiVolume = this.loadUiVolumePreference();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.worldContent.skyColor);
    const fogDensity = Number(this.worldContent.fogDensity) || 0;
    this.scene.fog =
      fogDensity > 0
        ? new THREE.FogExp2(this.worldContent.skyColor, fogDensity)
        : new THREE.Fog(this.worldContent.skyColor, this.worldContent.fogNear, this.worldContent.fogFar);

    this.camera = new THREE.PerspectiveCamera(
      GAME_CONSTANTS.DEFAULT_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      1200
    );
    this.camera.fov = this.resolveTargetCameraFov();
    this.camera.updateProjectionMatrix();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.mobileEnabled,
      powerPreference: "high-performance"
    });
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const rendererExposure = Number(this.worldContent?.postProcessing?.exposure);
    this.renderer.toneMappingExposure = Number.isFinite(rendererExposure) ? rendererExposure : 1.08;
    this.renderer.shadowMap.enabled = !this.mobileEnabled;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = !this.mobileEnabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.textureLoader = new THREE.TextureLoader();

    this.playerPosition = new THREE.Vector3(0, GAME_CONSTANTS.PLAYER_HEIGHT, 0);
    this.verticalVelocity = 0;
    this.onGround = true;
    this.yaw = 0;
    this.pitch = 0;

    this.pointerLocked = false;
    this.pointerLockSupported =
      "pointerLockElement" in document &&
      typeof this.renderer.domElement.requestPointerLock === "function";
    this.fullscreenPending = this.mobileEnabled;
    this.lastFullscreenAttemptAt = 0;

    this.keys = new Set();
    this.moveForwardVec = new THREE.Vector3();
    this.moveRightVec = new THREE.Vector3();
    this.moveVec = new THREE.Vector3();
    this.playerCollisionRadius = RUNTIME_TUNING.PLAYER_COLLISION_RADIUS;
    this.playerBoundsHalfExtent = Math.max(4, GAME_CONSTANTS.WORLD_LIMIT - this.playerCollisionRadius);

    this.skyDome = null;
    this.skyBackgroundTexture = null;
    this.skyEnvironmentTexture = null;
    this.skyTextureRequestId = 0;
    this.skySun = new THREE.Vector3();
    this.cloudLayer = null;
    this.cloudParticles = [];
    this.sunLight = null;
    this.ground = null;
    this.groundUnderside = null;
    this.boundaryGroup = null;
    this.floatingArenaGroup = null;
    this.spectatorStandsGroup = null;
    this.centerBillboardGroup = null;
    this.megaAdScreenGroup = null;
    this.oxArenaGroup = null;
    this.offlineStartMarkerMesh = null;
    this.offlineStartMarkerMaterial = null;
    this.offlineStartMarkerPosition = new THREE.Vector3(0, 0, 0);
    this.offlineStartInteractDistance = OFFLINE_START_INTERACT_DISTANCE;
    this.offlineStartAvailable = false;
    this.offlineStartNearby = false;
    this.offlineStartRequestInFlight = false;
    this.offlineStartHintMessage = "";
    this.offlineStartSelectedCategoryId = "";
    this.offlineStartPreparedQuestions = [];
    this.offlineStartPreparedConfig = null;
    this.oxArenaTextures = [];
    this.worldDecorTextures = [];
    this.centerBillboardCanvas = null;
    this.centerBillboardContext = null;
    this.centerBillboardTexture = null;
    this.centerBillboardScreenMaterial = null;
    this.centerBillboardLastSignature = "";
    this.centerBillboardLastCountdown = null;
    this.megaAdVideoEl = null;
    this.megaAdVideoTexture = null;
    this.megaAdScreenMaterial = null;
    this.megaAdTextCanvas = null;
    this.megaAdTextContext = null;
    this.megaAdTextTexture = null;
    this.megaAdTextLastSignature = "";
    this.billboardMediaState = this.buildDefaultBillboardMediaState();
    this.billboardMediaRuntime = {
      board1: this.buildDefaultBillboardMediaRuntimeEntry(),
      board2: this.buildDefaultBillboardMediaRuntimeEntry()
    };
    this.mediaAudioContext = null;
    this.chalkLayer = null;
    this.chalkStampGeometry = null;
    this.chalkStampTexture = null;
    this.chalkMaterials = new Map();
    this.chalkMarks = [];
    this.chalkPointer = new THREE.Vector2(0, 0);
    this.chalkRaycaster = new THREE.Raycaster();
    this.chalkGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.chalkHitPoint = new THREE.Vector3();
    this.chalkLastStamp = null;
    this.chalkDrawingActive = false;
    this.chalkPalette = [];
    this.selectedChalkColor = "#f5f7ff";
    this.activeTool = "move";
    this.beach = null;
    this.shoreFoam = null;
    this.shoreWetBand = null;
    this.oceanBase = null;
    this.ocean = null;
    this.handView = null;
    this.handSwayAmplitude = Number(this.handContent.swayAmplitude) || 0.012;
    this.handSwayFrequency = Number(this.handContent.swayFrequency) || 0.0042;
    this.composer = null;
    this.bloomPass = null;

    this.dynamicResolution = {
      enabled: this.mobileEnabled,
      minRatio: this.mobileEnabled
        ? GAME_CONSTANTS.DYNAMIC_RESOLUTION.mobileMinRatio
        : GAME_CONSTANTS.DYNAMIC_RESOLUTION.desktopMinRatio,
      sampleTime: 0,
      frameCount: 0,
      cooldown: 0,
      downshiftSamples: 0,
      upshiftSamples: 0,
      pendingRatio: null,
      pendingApplyAt: 0
    };

    this.fpsState = {
      sampleTime: 0,
      frameCount: 0,
      fps: 0
    };
    this.hudRefreshClock = 0;
    this.quizBillboardRefreshClock = 0;
    this.shadowRefreshClock = 0;
    this.shadowRefreshIdleClock = 0;
    this.pendingShadowRefresh = false;
    this.shadowRefreshReference = {
      ready: false,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0
    };
    this.remoteAvatarBodyGeometry = null;
    this.remoteAvatarHeadGeometry = null;
    this.boundLoop = this.loop.bind(this);

    this.socket = null;
    this.socketEndpoint = null;
    this.socketAuth = null;
    this.socketRole = "worker";
    this.redirectInFlight = false;
    this.networkConnected = false;
    this.localPlayerId = null;
    this.queryParams =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams();
    const perfParam = String(
      this.queryParams.get("perf") ?? this.queryParams.get("debug_perf") ?? ""
    ).trim();
    this.performanceDebug = {
      enabled: perfParam === "1" || perfParam.toLowerCase() === "true",
      hitchThresholdMs: 22,
      sections: Object.create(null),
      flags: {
        shadowRefresh: false,
        dynamicResolutionShift: false,
        correctionCount: 0,
        correctionYawPitch: false,
        recentLookInput: false
      },
      lastLogAt: 0
    };
    this.lastLookInputAt = 0;
    this.ownerAccessKey = this.resolveOwnerAccessKey();
    this.ownerAccessEnabled = this.ownerAccessKey.length > 0;
    this.localPlayerName = this.formatPlayerName(this.queryParams.get("name") ?? "플레이어");
    this.pendingPlayerNameSync = false;
    this.remotePlayers = new Map();
    this.remoteSyncClock = 0;
    this.localSyncSeq = 0;
    this.quizState = {
      active: false,
      phase: "idle",
      autoMode: false,
      autoFinish: true,
      autoStartsAt: 0,
      prepareEndsAt: 0,
      hostId: null,
      questionIndex: 0,
      totalQuestions: 0,
      lockAt: 0,
      lockResolveAt: 0,
      questionText: "",
      survivors: 0,
      myScore: 0
    };
    this.localQuizAlive = true;
    this.localSpectatorMode = false;
    this.localEliminationDrop = {
      active: false,
      elapsed: 0,
      velocityY: 0
    };
    this.serverHostSpectator = false;
    this.hostSpectatorOverride = false;
    this.spectatorFollowId = null;
    this.spectatorFollowIndex = -1;
    this.spectatorFollowOffset = new THREE.Vector3(0, 2.5, 6.8);
    this.spectatorViewMode = "third";
    this.spectatorSpawn = new THREE.Vector3(0, GAME_CONSTANTS.PLAYER_HEIGHT, -32);
    const oZoneConfig = this.worldContent?.oxArena?.oZone ?? {};
    const xZoneConfig = this.worldContent?.oxArena?.xZone ?? {};
    const readZone = (zone, fallbackCenterX) => {
      const centerX = Number.isFinite(Number(zone?.centerX)) ? Number(zone.centerX) : fallbackCenterX;
      const centerZ = Number.isFinite(Number(zone?.centerZ)) ? Number(zone.centerZ) : 0;
      const width = Math.max(8, Number(zone?.width) || 20);
      const depth = Math.max(8, Number(zone?.depth) || 20);
      return {
        minX: centerX - width * 0.5,
        maxX: centerX + width * 0.5,
        minZ: centerZ - depth * 0.5,
        maxZ: centerZ + depth * 0.5
      };
    };
    const oZone = readZone(oZoneConfig, -17);
    const xZone = readZone(xZoneConfig, 17);
    const spectatorArenaMargin = 1.1;
    this.spectatorArenaGuard = {
      enabled: true,
      minX: Math.min(oZone.minX, xZone.minX) - spectatorArenaMargin,
      maxX: Math.max(oZone.maxX, xZone.maxX) + spectatorArenaMargin,
      minZ: Math.min(oZone.minZ, xZone.minZ) - spectatorArenaMargin,
      maxZ: Math.max(oZone.maxZ, xZone.maxZ) + spectatorArenaMargin,
      exitPadding: 1.4
    };
    this.spectatorSpawn.set(
      this.spectatorArenaGuard.minX - 8,
      GAME_CONSTANTS.PLAYER_HEIGHT,
      this.spectatorArenaGuard.minZ - 7
    );
    this.oxTrapdoors = {
      o: null,
      x: null
    };
    this.oxTrapdoorAnim = {
      active: false,
      loserSide: null,
      elapsed: 0,
      duration: 1
    };
    const chatConfig = this.worldContent?.chat ?? {};
    this.chatBubbleLifetimeMs = Math.max(
      CHAT_BUBBLE_MIN_LIFETIME_MS,
      Math.trunc(Number(chatConfig.bubbleLifetimeMs) || 0),
      4200
    );
    this.chatLogMaxEntries = RUNTIME_TUNING.CHAT_LOG_MAX_ENTRIES;
    this.chatLogEl = document.getElementById("chat-log");
    this.chatControlsEl = document.getElementById("chat-controls");
    this.chatInputEl = document.getElementById("chat-input");
    this.chatSendBtnEl = document.getElementById("chat-send-btn");
    this.chatHideBtnEl = document.getElementById("chat-hide-btn");
    this.chatCloseBtnEl = document.getElementById("chat-close-btn");
    this.chatLiveFeedEl = document.getElementById("chat-live-feed");
    this.chatLiveLogEl = document.getElementById("chat-live-log");
    this.toolHotbarEl = document.getElementById("tool-hotbar");
    this.chalkColorsEl = document.getElementById("chalk-colors");
    this.chalkColorButtons = [];
    this.toolButtons = [];
    this.chatOpen = false;
    this.lastLocalChatEcho = "";
    this.lastLocalChatEchoAt = 0;
    this.chatSendInFlight = false;
    this.recentChatEventSignatures = new Map();
    this.chatLiveMaxEntries = CHAT_LIVE_MAX_ENTRIES;
    this.settingsPanelOpen = false;
    this.toolUiEl = document.getElementById("tool-ui");
    this.chatUiEl = document.getElementById("chat-ui");
    this.settingsBtnEl = document.getElementById("settings-btn");
    this.settingsPanelEl = document.getElementById("settings-panel");
    this.settingsVolumeSliderEl = document.getElementById("sp-volume");
    this.settingsFullscreenBtnEl = document.getElementById("sp-fullscreen-btn");
    this.settingsQualityBtnEls = Array.from(document.querySelectorAll(".sp-quality-btn[data-quality]"));
    this.orientationLockOverlayEl = document.getElementById("orientation-lock-overlay");
    this.quizControlsEl = document.getElementById("quiz-controls");
    this.quizHostBtnEl = document.getElementById("quiz-host-btn");
    this.quizStartBtnEl = document.getElementById("quiz-start-btn");
    this.quizStopBtnEl = document.getElementById("quiz-stop-btn");
    this.quizConfigBtnEl = document.getElementById("quiz-config-btn");
    this.quizReviewBtnEl = document.getElementById("quiz-review-btn");
    this.quizQuickCategorySelectEl = document.getElementById("quiz-quick-category-select");
    this.quizQuickTimeInputEl = document.getElementById("quiz-quick-time-input");
    this.quizQuickApplyBtnEl = document.getElementById("quiz-quick-apply-btn");
    this.quizCategoryVoteBtnEl = document.getElementById("quiz-category-vote-btn");
    this.portalLobbyOpenBtnEl = document.getElementById("portal-open-btn");
    this.portalLobbyStartBtnEl = document.getElementById("portal-admit-btn");
    this.quizPrevBtnEl = document.getElementById("quiz-prev-btn");
    this.quizNextBtnEl = document.getElementById("quiz-next-btn");
    this.quizLockBtnEl = document.getElementById("quiz-lock-btn");
    this.moderationPanelToggleBtnEl = document.getElementById("moderation-panel-toggle-btn");
    this.moderationPanelEl = document.getElementById("moderation-panel");
    this.moderationPlayerSelectEl = document.getElementById("moderation-player-select");
    this.moderationKickBtnEl = document.getElementById("moderation-kick-btn");
    this.moderationMuteBtnEl = document.getElementById("moderation-mute-btn");
    this.moderationUnmuteBtnEl = document.getElementById("moderation-unmute-btn");
    this.quizControlsNoteEl = document.getElementById("quiz-controls-note");
    this.portalTargetInputEl = document.getElementById("portal-target-input");
    this.portalTargetSaveBtnEl = document.getElementById("portal-target-save-btn");
    this.hubFlowUiEl = document.getElementById("hub-flow-ui");
    this.hubPhaseTitleEl = document.getElementById("hub-phase-title");
    this.hubPhaseSubtitleEl = document.getElementById("hub-phase-subtitle");
    this.nicknameGateEl = document.getElementById("nickname-gate");
    this.nicknameFormEl = document.getElementById("nickname-form");
    this.nicknameInputEl = document.getElementById("nickname-input");
    this.nicknameErrorEl = document.getElementById("nickname-error");
    this.lobbyScreenEl = document.getElementById("lobby-screen");
    this.lobbyFormEl = document.getElementById("lobby-form");
    this.lobbyNameInputEl = document.getElementById("lobby-name-input");
    this.lobbyJoinBtnEl = document.getElementById("lobby-join-btn");
    this.lobbyStatusEl = document.getElementById("lobby-status");
    this.lobbyRoomCountEl = document.getElementById("lobby-room-count");
    this.lobbyPlayerCountEl = document.getElementById("lobby-player-count");
    this.lobbyTopRoomEl = document.getElementById("lobby-top-room");
    this.lobbySlotParticipantsEl = document.getElementById("lobby-slot-participants");
    this.lobbySlotSpectatorsEl = document.getElementById("lobby-slot-spectators");
    this.portalTransitionEl = document.getElementById("portal-transition");
    this.portalTransitionTextEl = document.getElementById("portal-transition-text");
    this.quizConfigModalEl = document.getElementById("quiz-config-modal");
    this.quizConfigCloseBtnEl = document.getElementById("quiz-config-close-btn");
    this.quizConfigSaveBtnEl = document.getElementById("quiz-config-save-btn");
    this.quizConfigResetBtnEl = document.getElementById("quiz-config-reset-btn");
    this.quizCategoryTukgalLoadBtnEl = document.getElementById("quiz-category-tukgal-load-btn");
    this.quizCategoryTukgalSaveBtnEl = document.getElementById("quiz-category-tukgal-save-btn");
    this.quizCategoryHistoryLoadBtnEl = document.getElementById("quiz-category-history-load-btn");
    this.quizCategoryHistorySaveBtnEl = document.getElementById("quiz-category-history-save-btn");
    this.quizCategoryHistoryEasyLoadBtnEl = document.getElementById("quiz-category-history-easy-load-btn");
    this.quizCategoryHistoryEasySaveBtnEl = document.getElementById("quiz-category-history-easy-save-btn");
    this.quizCategoryGeneralLoadBtnEl = document.getElementById("quiz-category-general-load-btn");
    this.quizCategoryGeneralSaveBtnEl = document.getElementById("quiz-category-general-save-btn");
    this.quizCategoryChokaguyaLoadBtnEl = document.getElementById("quiz-category-chokaguya-load-btn");
    this.quizCategoryChokaguyaSaveBtnEl = document.getElementById("quiz-category-chokaguya-save-btn");
    this.quizSlotCountInputEl = document.getElementById("quiz-slot-count-input");
    this.quizTimeUnifyInputEl = document.getElementById("quiz-time-unify-input");
    this.quizTimeUnifyApplyBtnEl = document.getElementById("quiz-time-unify-apply-btn");
    this.quizAutoFinishInputEl = document.getElementById("quiz-auto-finish-input");
    this.quizOppositeBillboardInputEl = document.getElementById("quiz-opposite-billboard-input");
    this.quizQuestionListEl = document.getElementById("quiz-question-list");
    this.quizConfigStatusEl = document.getElementById("quiz-config-status");
    this.billboardTargetSelectEl = document.getElementById("billboard-target-select");
    this.billboardMediaPresetSelectEl = document.getElementById("billboard-media-preset-select");
    this.billboardMediaFileInputEl = document.getElementById("billboard-media-file-input");
    this.billboardMediaUrlInputEl = document.getElementById("billboard-media-url-input");
    this.billboardMediaApplyBtnEl = document.getElementById("billboard-media-apply-btn");
    this.billboardMediaPlayBtnEl = document.getElementById("billboard-media-play-btn");
    this.billboardMediaPauseBtnEl = document.getElementById("billboard-media-pause-btn");
    this.billboardMediaClearBtnEl = document.getElementById("billboard-media-clear-btn");
    this.billboardPlaylistInputEl = document.getElementById("billboard-playlist-input");
    this.billboardPlaylistLoadBtnEl = document.getElementById("billboard-playlist-load-btn");
    this.billboardPlaylistPlayBtnEl = document.getElementById("billboard-playlist-play-btn");
    this.billboardPlaylistPauseBtnEl = document.getElementById("billboard-playlist-pause-btn");
    this.billboardPlaylistPrevBtnEl = document.getElementById("billboard-playlist-prev-btn");
    this.billboardPlaylistNextBtnEl = document.getElementById("billboard-playlist-next-btn");
    this.billboardPlaylistAutoInputEl = document.getElementById("billboard-playlist-auto-input");
    this.billboardPlaylistIndexSelectEl = document.getElementById("billboard-playlist-index-select");
    this.billboardPlaylistSelectBtnEl = document.getElementById("billboard-playlist-select-btn");
    this.billboardPlaylistOptionsSignature = "";
    this.billboardMediaUploadInFlight = false;
    this.quizReviewModalEl = document.getElementById("quiz-review-modal");
    this.quizReviewCloseBtnEl = document.getElementById("quiz-review-close-btn");
    this.quizReviewPrevBtnEl = document.getElementById("quiz-review-prev-btn");
    this.quizReviewNextBtnEl = document.getElementById("quiz-review-next-btn");
    this.quizReviewIndexEl = document.getElementById("quiz-review-index");
    this.quizReviewQuestionEl = document.getElementById("quiz-review-question");
    this.quizReviewAnswerEl = document.getElementById("quiz-review-answer");
    this.quizReviewExplanationEl = document.getElementById("quiz-review-explanation");
    this.boundaryWarningEl = document.getElementById("boundary-warning");
    this.roundOverlayEl = document.getElementById("round-overlay");
    this.roundOverlayCanvasEl = document.getElementById("round-overlay-canvas");
    this.roundOverlayTitleEl = document.getElementById("round-overlay-title");
    this.roundOverlaySubtitleEl = document.getElementById("round-overlay-subtitle");
    this.entryWaitOverlayEl = document.getElementById("entry-wait-overlay");
    this.entryWaitTextEl = document.getElementById("entry-wait-text");
    this.categoryVoteOverlayEl = document.getElementById("category-vote-overlay");
    this.categoryVoteTitleEl = document.getElementById("category-vote-title");
    this.categoryVoteTimerEl = document.getElementById("category-vote-timer");
    this.categoryVoteStatusEl = document.getElementById("category-vote-status");
    this.categoryVoteOptionsEl = document.getElementById("category-vote-options");
    this.offlineStartHintEl = document.getElementById("offline-start-hint");
    this.offlineStartHintTextEl = document.getElementById("offline-start-hint-text");
    this.offlineStartTriggerBtnEl = document.getElementById("offline-start-trigger-btn");
    this.offlineStartModalEl = document.getElementById("offline-start-modal");
    this.offlineStartCloseBtnEl = document.getElementById("offline-start-close-btn");
    this.offlineStartSelectedCategoryEl = document.getElementById("offline-start-selected-category");
    this.offlineStartQuestionSelectEl = document.getElementById("offline-start-question-select");
    this.offlineStartQuestionStartBtnEl = document.getElementById("offline-start-question-start-btn");
    this.offlineStartStatusEl = document.getElementById("offline-start-status");
    this.offlineStartCategoryBtnEls = Array.from(
      document.querySelectorAll(".offline-start-category-btn")
    );
    this.playerRosterPanelEl = document.getElementById("player-roster-panel");
    this.rosterCountEl = document.getElementById("roster-count");
    this.rosterSubtitleEl = document.getElementById("roster-subtitle");
    this.rosterListEl = document.getElementById("roster-list");
    this.mobileControlsEl = document.getElementById("mobile-controls");
    this.mobileMovePadEl = document.getElementById("mobile-move-pad");
    this.mobileMoveThumbEl = document.getElementById("mobile-move-thumb");
    this.mobileJumpBtnEl = document.getElementById("mobile-jump-btn");
    this.mobileRunBtnEl = document.getElementById("mobile-run-btn");
    this.mobileRosterBtnEl = document.getElementById("mobile-roster-btn");
    this.mobileChatToggleBtnEl = document.getElementById("mobile-chat-toggle-btn");
    this.mobileChatPreviewEl = document.getElementById("mobile-chat-preview");
    this.mobileLookPadEl = document.getElementById("mobile-look-pad");
    this.roundOverlayCtx = this.roundOverlayCanvasEl?.getContext?.("2d") ?? null;
    this.roundOverlayVisible = false;
    this.roundOverlayFireworks = false;
    this.roundOverlayTimer = 0;
    this.roundOverlaySpawnClock = 0;
    this.roundOverlayParticles = [];
    this.roomRoster = [];
    this.rosterVisibleByTab = false;
    this.rosterPinned = false;
    this.localAdmissionWaiting = false;
    this.entryGateState = {
      portalOpen: false,
      waitingPlayers: 0,
      admittedPlayers: 0,
      spectatorPlayers: 0,
      priorityPlayers: 0,
      participantLimit: 50,
      roomCapacity: 120,
      openedAt: 0,
      lastAdmissionAt: 0,
      admissionStartsAt: 0,
      admissionInProgress: false
    };
    this.mobileHeldKeys = new Set();
    this.mobileMovePointerId = null;
    this.mobileMoveTouchId = null;
    this.mobileMoveVectorX = 0;
    this.mobileMoveVectorY = 0;
    this.mobileMovePadCenterX = 0;
    this.mobileMovePadCenterY = 0;
    this.mobileMovePadMaxDistance = 1;
    this.mobileLookPointerId = null;
    this.mobileLookLastX = 0;
    this.mobileLookLastY = 0;
    this.mobileLookDeltaX = 0;
    this.mobileLookDeltaY = 0;
    this.mobileChatPanelVisible = !this.mobileEnabled;
    this.mobileChatPreviewHideTimer = null;
    this.mobileChatPreviewEntries = [];
    this.mobileChatUnreadCount = 0;
    this.mobileEventsBound = false;
    this.mobileHoldResetters = [];
    this.mobileKeyboardInsetPx = 0;
    this.mobileKeyboardInsetTimer = null;
    this.moderationPanelOpen = false;
    this.moderationOptionsSignature = "";
    this.lastHudAdmissionCountdown = null;
    this.disconnectedByKick = false;
    this.quizConfig = this.buildDefaultQuizConfig(10);
    this.quizOppositeBillboardEnabled =
      this.quizConfig?.endPolicy?.showOppositeBillboard !== false;
    this.quizOppositeBillboardResultVisible = false;
    this.quizConfigLoading = false;
    this.quizConfigSaving = false;
    this.currentRoomCode = "";
    this.quizConfigDraftSaveTimer = null;
    this.quizConfigDraftRestoreAttempted = false;
    this.quizReviewItems = [];
    this.quizReviewIndex = 0;
    this.categoryVoteState = null;
    this.categoryVoteAppliedResultKey = "";
    this.categoryVoteAnnouncedStateKey = "";

    const hubFlowConfig = this.worldContent?.hubFlow ?? {};
    const bridgeConfig = hubFlowConfig?.bridge ?? {};
    const cityConfig = hubFlowConfig?.city ?? {};
    const portalConfig = hubFlowConfig?.portal ?? {};
    this.hubFlowEnabled = Boolean(hubFlowConfig?.enabled);
    this.lobbyEnabled = !this.hubFlowEnabled;
    this.lobbyVisible = false;
    this.lobbyNameConfirmed = false;
    this.lobbyJoinInFlight = false;
    this.lobbyJoinRequestSeq = 0;
    this.lobbyJoinAutoRetryRemaining = 0;
    this.lobbyLastRooms = [];
    this.gatewayParticipantLimit = 50;
    this.flowStage = this.hubFlowEnabled ? "bridge_approach" : "city_live";
    this.flowClock = 0;
    this.hubIntroDuration = parseSeconds(hubFlowConfig?.introSeconds, 4.8, 0.8);
    this.bridgeApproachSpawn = parseVec3(
      bridgeConfig?.approachSpawn,
      [0, GAME_CONSTANTS.PLAYER_HEIGHT, -98]
    );
    this.bridgeSpawn = parseVec3(
      bridgeConfig?.spawn,
      [0, GAME_CONSTANTS.PLAYER_HEIGHT, -86]
    );
    this.bridgeNpcPosition = parseVec3(bridgeConfig?.npcPosition, [0, 0, -82]);
    this.bridgeNpcTriggerRadius = Math.max(2.5, Number(bridgeConfig?.npcTriggerRadius) || 5);
    this.bridgeMirrorPosition = parseVec3(bridgeConfig?.mirrorPosition, [0, 1.72, -76]);
    this.bridgeMirrorLookSeconds = parseSeconds(bridgeConfig?.mirrorLookSeconds, 1.5, 0.4);
    this.mirrorLookClock = 0;
    this.bridgeCityEntry = parseVec3(
      bridgeConfig?.cityEntry,
      [0, GAME_CONSTANTS.PLAYER_HEIGHT, -18]
    );
    this.bridgeBoundaryRadius = Math.max(1.4, Number(bridgeConfig?.boundaryRadius) || 3.2);
    this.citySpawn = parseVec3(
      cityConfig?.spawn,
      [0, GAME_CONSTANTS.PLAYER_HEIGHT, -8]
    );
    this.bridgeWidth = Math.max(4, Number(bridgeConfig?.width) || 10);
    this.bridgeDeckColor = bridgeConfig?.deckColor ?? 0x4f5660;
    this.bridgeRailColor = bridgeConfig?.railColor ?? 0x8fa2b8;
    this.portalFloorPosition = parseVec3(portalConfig?.position, [0, 0.08, 22]);
    this.portalRadius = Math.max(2.2, Number(portalConfig?.radius) || 4.4);
    this.portalCooldownSeconds = parseSeconds(portalConfig?.cooldownSeconds, 60, 8);
    this.portalWarningSeconds = parseSeconds(portalConfig?.warningSeconds, 16, 4);
    this.portalOpenSeconds = parseSeconds(portalConfig?.openSeconds, 24, 5);
    this.portalAlwaysOpen = portalConfig?.alwaysOpen === true;
    this.portalConfiguredTargetUrl = this.resolveConfiguredPortalTargetUrl(portalConfig?.targetUrl ?? "");
    this.portalTargetUrl = this.resolvePortalTargetUrl(portalConfig?.targetUrl ?? "");
    this.portalPhase = this.hubFlowEnabled ? "cooldown" : "idle";
    this.portalPhaseClock = this.portalCooldownSeconds;
    this.portalTransitioning = false;
    this.portalPulseClock = 0;
    this.waterDeltaSmoothed = 1 / 60;
    this.boundaryReturnDelaySeconds = 1.8;
    this.boundaryReturnNoticeSeconds = 1.2;
    this.boundaryHardLimitPadding = 18;
    this.boundaryOutClock = 0;
    this.boundaryNoticeClock = 0;
    this.lastSafePosition = new THREE.Vector3(0, GAME_CONSTANTS.PLAYER_HEIGHT, 0);
    this.hubFlowGroup = null;
    this.portalGroup = null;
    this.portalRing = null;
    this.portalCore = null;
    this.npcGuideGroup = null;
    this.npcGreetingScreen = null;
    this.npcGreetingVideoEl = null;
    this.npcGreetingVideoTexture = null;
    this.npcGreetingPlayed = false;
    this.mirrorGateGroup = null;
    this.mirrorGatePanel = null;
    this.bridgeBoundaryMarker = null;
    this.bridgeBoundaryRing = null;
    this.bridgeBoundaryHalo = null;
    this.bridgeBoundaryBeam = null;
    this.bridgeBoundaryDingClock = 0;
    this.bridgeBoundaryDingTriggered = false;
    this.hubFlowUiBound = false;
    this.cityIntroStart = new THREE.Vector3();
    this.cityIntroEnd = new THREE.Vector3();
    this.tempVecA = new THREE.Vector3();
    this.tempVecB = new THREE.Vector3();
    this.serverCorrectionTarget = new THREE.Vector3();
    this.flowHeadlineCache = {
      title: "",
      subtitle: ""
    };

    this._initialized = false;
  }

  init() {
    if (this._initialized) {
      return;
    }
    if (!this.mount) {
      throw new Error("게임 마운트 요소를 찾을 수 없습니다 (#app).");
    }

    this._initialized = true;
    this.mount.appendChild(this.renderer.domElement);
    this.scene.add(this.camera);
    this.resolveUiElements();
    this.setupToolState();
    this.setGraphicsQuality(this.graphicsQuality, { persist: false });
    this.setUiVolume(this.uiVolume, { persist: false });
    this.setChatOpen(false);
    this.applyPortalTarget(this.portalTargetUrl, { announce: false });
    this.refreshRosterPanel();
    this.syncRosterVisibility();
    this.updateMobileControlUi();
    this.syncSettingsPanelUi();
    if (this.mobileEnabled) {
      this.requestAppFullscreen();
    }

    this.setupWorld();
    this.applyGraphicsQualityOverrides();
    this.setupHubFlowWorld();
    this.setupPostProcessing();
    this.bindEvents();
    this.bindHubFlowUiEvents();
    this.setupLobbyUi();
    this.connectNetwork();

    this.camera.rotation.order = "YXZ";
    this.applyInitialFlowSpawn();
    this.camera.position.copy(this.playerPosition);
    this.lastSafePosition.copy(this.playerPosition);
    this.syncGameplayUiForFlow();
    this.updateQuizControlUi();

    this.hud.update({
      status: this.getStatusText(),
      players: 1,
      x: this.playerPosition.x,
      z: this.playerPosition.z,
      fps: 0
    });

    this.boundLoop();
  }

  setupWorld() {
    const world = this.worldContent;
    const lights = world.lights;
    const sunConfig = lights.sun;

    const hemi = new THREE.HemisphereLight(
      lights.hemisphere.skyColor,
      lights.hemisphere.groundColor,
      lights.hemisphere.intensity
    );
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(sunConfig.color, sunConfig.intensity);
    sun.position.fromArray(sunConfig.position);
    sun.castShadow = !this.mobileEnabled;
    sun.shadow.mapSize.set(
      this.mobileEnabled ? sunConfig.shadowMobileSize : sunConfig.shadowDesktopSize,
      this.mobileEnabled ? sunConfig.shadowMobileSize : sunConfig.shadowDesktopSize
    );
    sun.shadow.camera.left = -sunConfig.shadowBounds;
    sun.shadow.camera.right = sunConfig.shadowBounds;
    sun.shadow.camera.top = sunConfig.shadowBounds;
    sun.shadow.camera.bottom = -sunConfig.shadowBounds;
    sun.shadow.camera.near = sunConfig.shadowNear;
    sun.shadow.camera.far = sunConfig.shadowFar;
    sun.shadow.bias = sunConfig.shadowBias;
    sun.shadow.normalBias = sunConfig.shadowNormalBias;
    this.scene.add(sun);
    this.sunLight = sun;

    const fill = new THREE.DirectionalLight(lights.fill.color, lights.fill.intensity);
    fill.position.fromArray(lights.fill.position);
    this.scene.add(fill);

    this.setupSky(sun.position.clone().normalize());
    this.setupCloudLayer();

    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const anisotropy = this.mobileEnabled ? Math.min(4, maxAnisotropy) : maxAnisotropy;
    const ground = world.ground;
    const configureGroundTexture = (texture, colorSpace = null) => {
      if (!texture) {
        return null;
      }
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(ground.repeatX, ground.repeatY);
      if (colorSpace) {
        texture.colorSpace = colorSpace;
      }
      texture.anisotropy = anisotropy;
      return texture;
    };

    const loadGroundTexture = (url, colorSpace = null) => {
      if (!url) {
        return null;
      }
      return configureGroundTexture(this.textureLoader.load(url), colorSpace);
    };

    const groundMap = loadGroundTexture(ground.textureUrl, THREE.SRGBColorSpace);
    const groundNormalMap = loadGroundTexture(ground.normalTextureUrl);
    const groundRoughnessMap = loadGroundTexture(ground.roughnessTextureUrl);
    const groundAoMap = loadGroundTexture(ground.aoTextureUrl);

    const groundGeometry = new THREE.PlaneGeometry(ground.size, ground.size, 1, 1);
    const uv = groundGeometry.getAttribute("uv");
    if (uv) {
      groundGeometry.setAttribute("uv2", new THREE.Float32BufferAttribute(Array.from(uv.array), 2));
    }

    const normalScale = Array.isArray(ground.normalScale)
      ? new THREE.Vector2(
          Number(ground.normalScale[0]) || 1,
          Number(ground.normalScale[1]) || Number(ground.normalScale[0]) || 1
        )
      : new THREE.Vector2(1, 1);
    this.ground = new THREE.Mesh(
      groundGeometry,
      new THREE.MeshStandardMaterial({
        color: ground.color,
        map: groundMap ?? null,
        normalMap: groundNormalMap ?? null,
        normalScale,
        roughnessMap: groundRoughnessMap ?? null,
        aoMap: groundAoMap ?? null,
        aoMapIntensity: Number(ground.aoIntensity) || 0.5,
        roughness: ground.roughness,
        metalness: ground.metalness,
        side: THREE.FrontSide,
        emissive: ground.emissive,
        emissiveIntensity: ground.emissiveIntensity
      })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.groundUnderside = new THREE.Mesh(
      groundGeometry.clone(),
      new THREE.MeshStandardMaterial({
        color: ground.undersideColor ?? ground.color,
        map: groundMap ?? null,
        roughness: 1,
        metalness: 0,
        side: THREE.BackSide,
        emissive: ground.undersideEmissive ?? ground.emissive,
        emissiveIntensity:
          Number(ground.undersideEmissiveIntensity) || Math.max(0.2, Number(ground.emissiveIntensity))
      })
    );
    this.groundUnderside.rotation.x = -Math.PI / 2;
    this.groundUnderside.position.y = Number(ground.undersideOffsetY) || -0.1;
    this.groundUnderside.receiveShadow = false;
    this.scene.add(this.groundUnderside);

    this.setupBoundaryWalls(world.boundary);
    this.setupFloatingArena(world.floatingArena, world.ground);
    this.setupSpectatorStands(world.spectatorStands, world.boundary);
    this.setupCenterBillboard(world.centerBillboard);
    this.setupMegaAdScreen(world.megaAdScreen);
    this.setupOxArenaVisuals(world.oxArena);
    this.setupChalkLayer(world.chalk);
    this.setupBeachLayer(world.beach, world.ocean);
    this.setupOceanLayer(world.ocean);

    this.setupOfflineStartPillar(world.originMarker);
  }

  setupOfflineStartPillar(marker = {}) {
    const radiusTop = Math.max(0.15, Number(marker?.radiusTop) || 0.4);
    const radiusBottom = Math.max(0.15, Number(marker?.radiusBottom) || radiusTop);
    const height = Math.max(0.6, Number(marker?.height) || 1.6);
    const radialSegments = Math.max(8, Math.trunc(Number(marker?.radialSegments) || 14));
    const position = Array.isArray(marker?.position) ? marker.position : [0, height * 0.5, -5];
    const baseMaterial = marker?.material ?? {};

    const material = new THREE.MeshStandardMaterial({
      color: baseMaterial.color ?? 0x5e6f83,
      roughness: Number(baseMaterial.roughness) || 0.32,
      metalness: Number(baseMaterial.metalness) || 0.1,
      emissive: baseMaterial.emissive ?? 0x2a3a52,
      emissiveIntensity: Math.max(0.05, Number(baseMaterial.emissiveIntensity) || 0.2)
    });
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments),
      material
    );
    mesh.position.set(
      Number(position[0]) || 0,
      Number(position[1]) || height * 0.5,
      Number(position[2]) || 0
    );
    mesh.castShadow = !this.mobileEnabled;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    this.offlineStartMarkerMesh = mesh;
    this.offlineStartMarkerMaterial = material;
    this.offlineStartMarkerPosition.copy(mesh.position);
  }

  hasHostControllerPresent() {
    return Boolean(String(this.quizState.hostId ?? "").trim());
  }

  canUseOfflineStartTrigger() {
    if (!this.networkConnected || !this.socket) {
      return false;
    }
    if (this.isLobbyBlockingGameplay() || this.localAdmissionWaiting) {
      return false;
    }
    if (this.hasHostControllerPresent()) {
      return false;
    }
    if (this.quizState.active) {
      return false;
    }
    return true;
  }

  getOfflineStartUnavailableReason() {
    if (this.hasHostControllerPresent()) {
      return "호스트가 접속 중이라 호스트 없는 시작을 사용할 수 없습니다.";
    }
    if (!this.networkConnected || !this.socket) {
      return "서버 연결을 확인해 주세요.";
    }
    if (this.isLobbyBlockingGameplay()) {
      return "입장 화면을 닫고 중앙 원기둥으로 이동해 주세요.";
    }
    if (this.localAdmissionWaiting) {
      return "입장 처리 중입니다. 잠시 후 다시 시도해 주세요.";
    }
    if (this.quizState.active) {
      return "퀴즈 진행 중에는 사용할 수 없습니다.";
    }
    return "지금은 사용할 수 없습니다.";
  }

  updateOfflineStartHintUi() {
    this.resolveUiElements();
    if (!this.offlineStartHintEl || !this.offlineStartHintTextEl || !this.offlineStartTriggerBtnEl) {
      return;
    }

    const canUse = this.offlineStartAvailable;
    const nearby = this.offlineStartNearby;
    const modalOpen = this.isOfflineStartModalOpen();
    const shouldShow = !modalOpen && nearby && !this.isLobbyBlockingGameplay();
    this.offlineStartHintEl.classList.toggle("hidden", !shouldShow);
    if (!shouldShow) {
      return;
    }

    const hintText = canUse
      ? "중앙 버튼 사용 가능: E 키 또는 버튼을 눌러 카테고리를 선택하세요."
      : this.getOfflineStartUnavailableReason();
    let displayHintText = hintText;
    if (this.offlineStartRequestInFlight) {
      displayHintText = "현재 카테고리 OX를 10초 준비 후 시작하는 중입니다.";
    } else if (canUse) {
      displayHintText = "현재 카테고리 OX를 10초 뒤 시작합니다. E 키 또는 버튼을 누르세요.";
    }
    if (this.offlineStartHintMessage !== displayHintText) {
      this.offlineStartHintMessage = displayHintText;
      this.offlineStartHintTextEl.textContent = displayHintText;
    }
    this.offlineStartTriggerBtnEl.textContent = this.offlineStartRequestInFlight
      ? "시작 요청 중..."
      : "현재 카테고리 시작";
    this.offlineStartTriggerBtnEl.disabled = !canUse || this.offlineStartRequestInFlight;
  }

  updateOfflineStartPillar(delta) {
    if (!this.offlineStartMarkerMesh || !this.offlineStartMarkerMaterial) {
      return;
    }

    const canUse = this.canUseOfflineStartTrigger();
    const distanceXZ = Math.hypot(
      this.playerPosition.x - this.offlineStartMarkerPosition.x,
      this.playerPosition.z - this.offlineStartMarkerPosition.z
    );
    const nearby = distanceXZ <= this.offlineStartInteractDistance;

    this.offlineStartAvailable = canUse;
    this.offlineStartNearby = nearby;

    const targetColor = canUse ? 0x5e6f83 : 0x4d535c;
    const targetEmissive = canUse ? 0x2f5d7a : 0x23262b;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
    const baseIntensity = canUse ? (nearby ? 0.26 + pulse * 0.16 : 0.18) : 0.08;
    const alpha = THREE.MathUtils.clamp(1 - Math.exp(-Math.max(0.001, delta) * 8), 0, 1);

    this.offlineStartMarkerMaterial.color.setHex(targetColor);
    this.offlineStartMarkerMaterial.emissive.setHex(targetEmissive);
    this.offlineStartMarkerMaterial.emissiveIntensity = THREE.MathUtils.lerp(
      Number(this.offlineStartMarkerMaterial.emissiveIntensity) || 0,
      baseIntensity,
      alpha
    );

    this.updateOfflineStartHintUi();
  }

  isOfflineStartModalOpen() {
    return Boolean(this.offlineStartModalEl && !this.offlineStartModalEl.classList.contains("hidden"));
  }

  setOfflineStartStatus(text, isError = false) {
    if (!this.offlineStartStatusEl) {
      return;
    }
    this.offlineStartStatusEl.textContent = String(text ?? "").trim();
    this.offlineStartStatusEl.classList.toggle("error", Boolean(isError));
  }

  openOfflineStartModal() {
    this.resolveUiElements();
    if (!this.offlineStartModalEl) {
      return;
    }
    this.keys.clear();
    this.releaseMobileInputs();
    if (document.pointerLockElement === this.renderer?.domElement) {
      document.exitPointerLock?.();
    }
    this.offlineStartModalEl.classList.remove("hidden");
    this.offlineStartSelectedCategoryId = "";
    this.offlineStartPreparedQuestions = [];
    this.offlineStartPreparedConfig = null;
    this.renderOfflineStartQuestionOptions();
    this.setOfflineStartStatus("카테고리를 선택하세요.");
    this.updateOfflineStartHintUi();
  }

  closeOfflineStartModal() {
    if (!this.offlineStartModalEl) {
      return;
    }
    this.offlineStartModalEl.classList.add("hidden");
    this.offlineStartRequestInFlight = false;
    this.setOfflineStartCategoryButtonsDisabled(false);
    this.setOfflineStartQuestionControlsDisabled(true);
    this.offlineStartSelectedCategoryId = "";
    this.offlineStartPreparedQuestions = [];
    this.offlineStartPreparedConfig = null;
    this.renderOfflineStartQuestionOptions();
    this.updateOfflineStartHintUi();
  }

  setOfflineStartCategoryButtonsDisabled(disabled) {
    for (const button of this.offlineStartCategoryBtnEls) {
      if (button) {
        button.disabled = Boolean(disabled);
      }
    }
  }

  setOfflineStartQuestionControlsDisabled(disabled) {
    if (this.offlineStartQuestionSelectEl) {
      this.offlineStartQuestionSelectEl.disabled = Boolean(disabled);
    }
    if (this.offlineStartQuestionStartBtnEl) {
      this.offlineStartQuestionStartBtnEl.disabled = Boolean(disabled);
    }
  }

  normalizeCategoryVotePayload(payload = null) {
    const id = String(payload?.id ?? "").trim();
    const active = payload?.active === true || String(payload?.status ?? "") === "active";
    const status = active ? "active" : String(payload?.status ?? "") === "finished" ? "finished" : "";
    if (!id || !status) {
      return null;
    }
    const options = Array.isArray(payload?.options)
      ? payload.options
          .map((option) => {
            const optionId = String(option?.id ?? "").trim();
            if (!optionId) {
              return null;
            }
            return {
              id: optionId,
              label: String(option?.label ?? optionId).trim() || optionId,
              difficulty: String(option?.difficulty ?? "").trim(),
              categoryName: String(option?.categoryName ?? option?.label ?? optionId).trim() || optionId,
              votes:
                option?.votes == null
                  ? null
                  : Math.max(0, Math.trunc(Number(option?.votes) || 0)),
              winner: option?.winner === true
            };
          })
          .filter(Boolean)
      : [];
    const winnerPayload = payload?.winner && typeof payload.winner === "object" ? payload.winner : null;
    return {
      id,
      status,
      active,
      title: String(payload?.title ?? "카테고리 투표").trim() || "카테고리 투표",
      subtitle: String(payload?.subtitle ?? "").trim(),
      startedAt: Math.max(0, Math.trunc(Number(payload?.startedAt) || 0)),
      endsAt: Math.max(0, Math.trunc(Number(payload?.endsAt) || 0)),
      finishedAt: Math.max(0, Math.trunc(Number(payload?.finishedAt) || 0)),
      durationMs: Math.max(0, Math.trunc(Number(payload?.durationMs) || 0)),
      eligibleVoters: Math.max(0, Math.trunc(Number(payload?.eligibleVoters) || 0)),
      votesCast: Math.max(0, Math.trunc(Number(payload?.votesCast) || 0)),
      canVote: payload?.canVote === true,
      myVote: String(payload?.myVote ?? "").trim() || "",
      finishReason: String(payload?.finishReason ?? "").trim() || "",
      options,
      winner: winnerPayload
        ? {
            id: String(winnerPayload?.id ?? "").trim(),
            label: String(winnerPayload?.label ?? "").trim(),
            difficulty: String(winnerPayload?.difficulty ?? "").trim(),
            categoryName:
              String(winnerPayload?.categoryName ?? winnerPayload?.label ?? "").trim() || "",
            votes: Math.max(0, Math.trunc(Number(winnerPayload?.votes) || 0))
          }
        : null
    };
  }

  getCategoryVoteCountdownSeconds(vote = this.categoryVoteState) {
    const endsAt = Math.max(0, Math.trunc(Number(vote?.endsAt) || 0));
    if (endsAt <= 0) {
      return 0;
    }
    return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  }

  updateCategoryVoteTimerUi() {
    this.resolveUiElements();
    const vote = this.categoryVoteState;
    if (!this.categoryVoteTimerEl) {
      return;
    }
    if (!vote) {
      this.categoryVoteTimerEl.textContent = "남은 시간 0초";
      return;
    }
    if (vote.active) {
      this.categoryVoteTimerEl.textContent = `남은 시간 ${this.getCategoryVoteCountdownSeconds(vote)}초`;
      return;
    }
    this.tryApplyCategoryVoteWinner(vote);
    this.categoryVoteTimerEl.textContent = vote?.winner?.label ? "투표 종료" : "선택 없음";
  }

  renderCategoryVoteOverlay() {
    this.resolveUiElements();
    const vote = this.categoryVoteState;
    const shouldShow = Boolean(vote);
    this.categoryVoteOverlayEl?.classList.toggle("hidden", !shouldShow);
    this.categoryVoteOverlayEl?.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    if (!shouldShow || !vote) {
      if (this.categoryVoteOptionsEl) {
        this.categoryVoteOptionsEl.replaceChildren();
      }
      return;
    }
    if (this.categoryVoteTitleEl) {
      this.categoryVoteTitleEl.textContent = vote.title;
    }
    if (this.categoryVoteStatusEl) {
      if (vote.active) {
        this.categoryVoteStatusEl.textContent = `${vote.subtitle} 현재 ${vote.votesCast}/${vote.eligibleVoters}명 참여`;
      } else if (vote.winner?.label) {
        this.categoryVoteStatusEl.textContent = `${vote.winner.label} 선택 (${vote.winner.votes}표). 현재 문항 설정에 반영됩니다.`;
      } else {
        this.categoryVoteStatusEl.textContent = "투표가 종료되었습니다. 현재 카테고리 설정을 유지합니다.";
      }
    }
    this.updateCategoryVoteTimerUi();
    if (!this.categoryVoteOptionsEl) {
      return;
    }
    this.categoryVoteOptionsEl.replaceChildren();
    for (const option of vote.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "category-vote-option";
      button.dataset.optionId = option.id;
      if (option.id === vote.myVote) {
        button.classList.add("selected");
      }
      if (option.winner) {
        button.classList.add("winner");
      }
      button.disabled = !vote.active || !vote.canVote;

      const label = document.createElement("span");
      label.className = "category-vote-option-label";
      label.textContent = option.label;
      button.appendChild(label);

      const meta = document.createElement("span");
      meta.className = "category-vote-option-meta";
      meta.textContent = vote.active
        ? option.id === vote.myVote
          ? `${option.difficulty} · 투표 완료`
          : option.difficulty
        : option.difficulty;
      button.appendChild(meta);

      if (!vote.active && option.votes != null) {
        const count = document.createElement("span");
        count.className = "category-vote-option-votes";
        count.textContent = `${option.votes}표`;
        button.appendChild(count);
      }

      this.categoryVoteOptionsEl.appendChild(button);
    }
  }

  handleCategoryVoteStateChange(previousVote, nextVote) {
    const previousId = String(previousVote?.id ?? "").trim();
    const nextId = String(nextVote?.id ?? "").trim();
    if (!nextVote) {
      this.categoryVoteAnnouncedStateKey = "";
      return;
    }
    if (nextVote.active) {
      const announceKey = `${nextId}:active`;
      if (this.categoryVoteAnnouncedStateKey !== announceKey) {
        this.categoryVoteAnnouncedStateKey = announceKey;
        this.appendChatLine("시스템", "카테고리 투표가 시작되었습니다. 원하는 카테고리를 선택하세요.", "system");
      }
      return;
    }
    const resultKey = `${nextId}:${nextVote?.winner?.id ?? "none"}:${nextVote.finishedAt}`;
    if (this.categoryVoteAnnouncedStateKey !== resultKey) {
      this.categoryVoteAnnouncedStateKey = resultKey;
      this.appendChatLine(
        "시스템",
        nextVote?.winner?.label
          ? `카테고리 투표 종료: ${nextVote.winner.label} (${nextVote.winner.votes}표)`
          : "카테고리 투표 종료: 득표가 없어 현재 카테고리를 유지합니다.",
        "system"
      );
    }
    if (previousId !== nextId || previousVote?.status !== nextVote.status) {
      this.tryApplyCategoryVoteWinner(nextVote);
    }
  }

  getOfflineStartCategoryLabel(categoryId) {
    const id = String(categoryId ?? "").trim();
    if (id === "tukgal") {
      return "특갤";
    }
    if (id === "history") {
      return "역사상식";
    }
    if (id === "history-easy") {
      return "역사기초";
    }
    if (id === "general") {
      return "일반상식";
    }
    if (id === "chokaguya") {
      return "초카구야";
    }
    return id || "-";
  }

  renderOfflineStartQuestionOptions() {
    this.resolveUiElements();
    if (this.offlineStartSelectedCategoryEl) {
      const label = this.getOfflineStartCategoryLabel(this.offlineStartSelectedCategoryId);
      this.offlineStartSelectedCategoryEl.textContent = `선택 카테고리: ${label}`;
    }
    if (!this.offlineStartQuestionSelectEl) {
      return;
    }

    const questions = Array.isArray(this.offlineStartPreparedQuestions)
      ? this.offlineStartPreparedQuestions
      : [];
    this.offlineStartQuestionSelectEl.replaceChildren();
    if (questions.length <= 0) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "카테고리 선택 후 문항을 고르세요";
      this.offlineStartQuestionSelectEl.appendChild(emptyOption);
      this.offlineStartQuestionSelectEl.value = "";
      this.setOfflineStartQuestionControlsDisabled(true);
      return;
    }

    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const option = document.createElement("option");
      option.value = String(index);
      const text = String(question?.text ?? "").trim();
      const preview = text.length > 60 ? `${text.slice(0, 60)}...` : text || `문항 ${index + 1}`;
      option.textContent = `${index + 1}. ${preview}`;
      this.offlineStartQuestionSelectEl.appendChild(option);
    }
    this.offlineStartQuestionSelectEl.value = "0";
    this.setOfflineStartQuestionControlsDisabled(this.offlineStartRequestInFlight);
  }

  triggerOfflineCategoryLoad(categoryId) {
    this.resolveUiElements();
    const id = String(categoryId ?? "").trim();
    let button = null;
    if (id === "tukgal") {
      button = this.quizCategoryTukgalLoadBtnEl ?? null;
    } else if (id === "history") {
      button = this.quizCategoryHistoryLoadBtnEl ?? null;
    } else if (id === "history-easy") {
      button = this.quizCategoryHistoryEasyLoadBtnEl ?? null;
    } else if (id === "general") {
      button = this.quizCategoryGeneralLoadBtnEl ?? null;
    } else if (id === "chokaguya") {
      button = this.quizCategoryChokaguyaLoadBtnEl ?? null;
    }
    if (!button) {
      return false;
    }
    const previousDisabled = button.disabled === true;
    if (previousDisabled) {
      button.disabled = false;
    }
    button.click();
    if (previousDisabled) {
      button.disabled = true;
    }
    return true;
  }

  prepareOfflineStartCategory(categoryId) {
    if (!this.socket || !this.networkConnected) {
      this.setOfflineStartStatus("오프라인 시작 실패: 서버 연결을 확인하세요.", true);
      return;
    }
    if (!this.canUseOfflineStartTrigger()) {
      this.setOfflineStartStatus(this.getOfflineStartUnavailableReason(), true);
      return;
    }
    if (this.offlineStartRequestInFlight) {
      return;
    }
    if (!this.triggerOfflineCategoryLoad(categoryId)) {
      this.setOfflineStartStatus("카테고리 선택이 올바르지 않습니다.", true);
      return;
    }

    const selectedConfig = this.normalizeQuizConfigPayload(this.quizConfig ?? {});
    const questions = Array.isArray(selectedConfig?.questions) ? selectedConfig.questions : [];
    if (questions.length <= 0) {
      this.offlineStartSelectedCategoryId = String(categoryId ?? "").trim();
      this.offlineStartPreparedQuestions = [];
      this.offlineStartPreparedConfig = null;
      this.renderOfflineStartQuestionOptions();
      this.setOfflineStartStatus("선택한 카테고리에 문항이 없습니다.", true);
      return;
    }

    this.offlineStartSelectedCategoryId = String(categoryId ?? "").trim();
    this.offlineStartPreparedQuestions = questions;
    this.offlineStartPreparedConfig = selectedConfig;
    this.renderOfflineStartQuestionOptions();
    this.setOfflineStartStatus("문항 1개를 선택한 뒤 시작 버튼을 누르세요.");
  }

  requestOfflineStartSelectedQuestion() {
    if (!this.socket || !this.networkConnected) {
      this.setOfflineStartStatus("오프라인 시작 실패: 서버 연결을 확인하세요.", true);
      return;
    }
    if (!this.canUseOfflineStartTrigger()) {
      this.setOfflineStartStatus(this.getOfflineStartUnavailableReason(), true);
      return;
    }
    if (this.offlineStartRequestInFlight) {
      return;
    }
    const questions = Array.isArray(this.offlineStartPreparedQuestions)
      ? this.offlineStartPreparedQuestions
      : [];
    if (questions.length <= 0) {
      this.setOfflineStartStatus("먼저 카테고리를 선택하고 문항을 고르세요.", true);
      return;
    }

    const selectedIndex = Math.trunc(Number(this.offlineStartQuestionSelectEl?.value ?? 0));
    if (!Number.isFinite(selectedIndex) || selectedIndex < 0 || selectedIndex >= questions.length) {
      this.setOfflineStartStatus("시작할 문항을 선택하세요.", true);
      return;
    }
    const selectedQuestion = questions[selectedIndex];
    if (!selectedQuestion || typeof selectedQuestion !== "object") {
      this.setOfflineStartStatus("문항 데이터가 올바르지 않습니다.", true);
      return;
    }
    const selectedConfig =
      this.offlineStartPreparedConfig ?? this.normalizeQuizConfigPayload(this.quizConfig ?? {});

    this.offlineStartRequestInFlight = true;
    this.setOfflineStartCategoryButtonsDisabled(true);
    this.setOfflineStartQuestionControlsDisabled(true);
    this.offlineStartTriggerBtnEl && (this.offlineStartTriggerBtnEl.disabled = true);
    this.setOfflineStartStatus("시작 요청 중...");

    this.socket.emit(
      "quiz:offline-start",
      {
        category: this.offlineStartSelectedCategoryId.slice(0, 24),
        questions: [selectedQuestion],
        autoFinish: selectedConfig?.endPolicy?.autoFinish !== false,
        prepareDelayMs: OFFLINE_START_PREPARE_DELAY_MS
      },
      (response = {}) => {
        this.offlineStartRequestInFlight = false;
        this.setOfflineStartCategoryButtonsDisabled(false);
        this.setOfflineStartQuestionControlsDisabled(false);
        if (!response?.ok) {
          this.setOfflineStartStatus(
            `시작 실패: ${this.translateQuizError(response?.error ?? "unknown")}`,
            true
          );
          return;
        }
        this.quizConfig = selectedConfig;
        this.persistQuizConfigDraft({ immediate: true, updateState: true });
        this.appendChatLine("시스템", "선택한 1문항으로 오프라인 OX를 시작했습니다.", "system");
        this.closeOfflineStartModal();
      }
    );
  }

  requestOfflineStartCurrentCategory() {
    if (!this.socket || !this.networkConnected) {
      const message = "오프라인 시작 실패: 서버 연결을 확인하세요.";
      this.setOfflineStartStatus(message, true);
      this.appendChatLine("시스템", message, "system");
      return;
    }
    if (!this.canUseOfflineStartTrigger()) {
      const reason = this.getOfflineStartUnavailableReason();
      this.setOfflineStartStatus(reason, true);
      this.appendChatLine("시스템", reason, "system");
      return;
    }
    if (this.offlineStartRequestInFlight) {
      return;
    }

    const selectedConfig = this.normalizeQuizConfigPayload(this.quizConfig ?? {});
    const questions = Array.isArray(selectedConfig?.questions) ? selectedConfig.questions : [];
    if (questions.length <= 0) {
      const message = "현재 카테고리에 시작할 문항이 없습니다.";
      this.setOfflineStartStatus(message, true);
      this.appendChatLine("시스템", message, "system");
      return;
    }

    this.offlineStartRequestInFlight = true;
    this.setOfflineStartStatus("현재 카테고리 시작을 요청하는 중입니다.");
    this.updateOfflineStartHintUi();

    this.socket.emit(
      "quiz:offline-start",
      {
        questions,
        autoFinish: selectedConfig?.endPolicy?.autoFinish !== false,
        prepareDelayMs: OFFLINE_START_PREPARE_DELAY_MS
      },
      (response = {}) => {
        this.offlineStartRequestInFlight = false;
        this.updateOfflineStartHintUi();
        if (!response?.ok) {
          const message = `시작 실패: ${this.translateQuizError(response?.error ?? "unknown")}`;
          this.setOfflineStartStatus(message, true);
          this.appendChatLine("시스템", message, "system");
          return;
        }

        this.quizConfig = selectedConfig;
        this.persistQuizConfigDraft({ immediate: true, updateState: true });
        this.setOfflineStartStatus("현재 카테고리 OX가 10초 준비 후 시작됩니다.");
        this.appendChatLine(
          "시스템",
          `현재 카테고리 ${questions.length}문항 OX를 10초 준비 후 시작합니다.`,
          "system"
        );
        if (this.isOfflineStartModalOpen()) {
          this.closeOfflineStartModal();
        }
      }
    );
  }

  tryOpenOfflineStartFromWorld() {
    if (this.offlineStartNearby !== true) {
      return false;
    }
    if (!this.canUseOfflineStartTrigger()) {
      const reason = this.getOfflineStartUnavailableReason();
      this.setOfflineStartStatus(reason, true);
      this.appendChatLine("시스템", reason, "system");
      return true;
    }
    this.requestOfflineStartCurrentCategory();
    return true;
  }

  requestSocketReconnect() {
    if (!this.socket || this.networkConnected || this.redirectInFlight || this.disconnectedByKick) {
      return;
    }
    if (typeof this.socket.connect !== "function") {
      return;
    }
    try {
      this.socket.connect();
    } catch {
      // Keep the built-in reconnection loop as fallback.
    }
  }

  clearHubFlowWorld() {
    if (this.npcGreetingVideoEl) {
      this.npcGreetingVideoEl.onended = null;
      this.npcGreetingVideoEl.onerror = null;
      this.npcGreetingVideoEl.pause();
      this.npcGreetingVideoEl.removeAttribute("src");
      this.npcGreetingVideoEl.load();
      this.npcGreetingVideoEl = null;
    }
    if (this.npcGreetingVideoTexture) {
      this.npcGreetingVideoTexture.dispose();
      this.npcGreetingVideoTexture = null;
    }
    this.npcGreetingScreen = null;
    this.npcGreetingPlayed = false;

    if (!this.hubFlowGroup) {
      return;
    }
    this.scene.remove(this.hubFlowGroup);
    disposeMeshTree(this.hubFlowGroup);
    this.hubFlowGroup = null;
    this.portalGroup = null;
    this.portalRing = null;
    this.portalCore = null;
    this.npcGuideGroup = null;
    this.npcGreetingScreen = null;
    this.mirrorGateGroup = null;
    this.mirrorGatePanel = null;
    this.bridgeBoundaryMarker = null;
    this.bridgeBoundaryRing = null;
    this.bridgeBoundaryHalo = null;
    this.bridgeBoundaryBeam = null;
  }

  createPortalVisualGroup() {
    const portalGroup = new THREE.Group();
    portalGroup.position.copy(this.portalFloorPosition);
    portalGroup.position.y = 0;

    const portalBase = new THREE.Mesh(
      new THREE.TorusGeometry(this.portalRadius * 0.92, 0.24, 18, this.mobileEnabled ? 28 : 56),
      new THREE.MeshStandardMaterial({
        color: 0x406484,
        roughness: 0.24,
        metalness: 0.44,
        emissive: 0x1e3d5a,
        emissiveIntensity: 0.2
      })
    );
    portalBase.rotation.x = Math.PI / 2;
    portalBase.position.y = 0.2;
    portalGroup.add(portalBase);

    const portalRing = new THREE.Mesh(
      new THREE.TorusGeometry(this.portalRadius, 0.34, 26, this.mobileEnabled ? 44 : 72),
      new THREE.MeshStandardMaterial({
        color: 0x77dcff,
        roughness: 0.14,
        metalness: 0.4,
        emissive: 0x4ac8ff,
        emissiveIntensity: 0.18,
        transparent: true,
        opacity: 0.64
      })
    );
    portalRing.position.y = 2.45;
    portalGroup.add(portalRing);

    const portalCore = new THREE.Mesh(
      new THREE.CircleGeometry(this.portalRadius * 0.84, this.mobileEnabled ? 28 : 50),
      new THREE.MeshBasicMaterial({
        color: 0x9cf4ff,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    portalCore.position.y = 2.45;
    portalGroup.add(portalCore);

    return { portalGroup, portalRing, portalCore };
  }

  setupHubFlowWorld() {
    this.clearHubFlowWorld();
    const group = new THREE.Group();
    const { portalGroup, portalRing, portalCore } = this.createPortalVisualGroup();
    this.hubFlowGroup = group;
    this.portalGroup = portalGroup;
    this.portalRing = portalRing;
    this.portalCore = portalCore;
    group.add(portalGroup);

    if (!this.hubFlowEnabled) {
      this.scene.add(group);
      this.updatePortalVisual();
      return;
    }

    const bridgeDirection = new THREE.Vector3(
      this.bridgeCityEntry.x - this.bridgeSpawn.x,
      0,
      this.bridgeCityEntry.z - this.bridgeSpawn.z
    );
    let bridgeLength = bridgeDirection.length();
    if (bridgeLength < 22) {
      bridgeLength = 66;
      bridgeDirection.set(0, 0, 1);
    } else {
      bridgeDirection.normalize();
    }

    const bridgeYaw = Math.atan2(bridgeDirection.x, bridgeDirection.z);
    const bridgeCenter = new THREE.Vector3(
      (this.bridgeSpawn.x + this.bridgeCityEntry.x) * 0.5,
      0.15,
      (this.bridgeSpawn.z + this.bridgeCityEntry.z) * 0.5
    );
    const bridgeDeckLength = bridgeLength + 30;
    const bridgeGroup = new THREE.Group();
    bridgeGroup.position.copy(bridgeCenter);
    bridgeGroup.rotation.y = bridgeYaw;

    const bridgeDeckMaterial = new THREE.MeshStandardMaterial({
      color: this.bridgeDeckColor,
      roughness: 0.7,
      metalness: 0.12,
      emissive: 0x171d23,
      emissiveIntensity: 0.1
    });
    const bridgeDeck = new THREE.Mesh(
      new THREE.BoxGeometry(this.bridgeWidth, 0.32, bridgeDeckLength),
      bridgeDeckMaterial
    );
    bridgeDeck.castShadow = !this.mobileEnabled;
    bridgeDeck.receiveShadow = true;
    bridgeGroup.add(bridgeDeck);

    const cityGroup = new THREE.Group();
    cityGroup.position.set(this.citySpawn.x, 0, this.citySpawn.z + 4);

    const plaza = new THREE.Mesh(
      new THREE.CylinderGeometry(34, 34, 0.22, this.mobileEnabled ? 26 : 42),
      new THREE.MeshStandardMaterial({
        color: 0x39434d,
        roughness: 0.82,
        metalness: 0.05,
        emissive: 0x1b242f,
        emissiveIntensity: 0.11
      })
    );
    plaza.position.y = 0.11;
    plaza.receiveShadow = true;
    cityGroup.add(plaza);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(24.5, 0.38, 20, this.mobileEnabled ? 44 : 80),
      new THREE.MeshStandardMaterial({
        color: 0x81a8ce,
        roughness: 0.3,
        metalness: 0.54,
        emissive: 0x34506d,
        emissiveIntensity: 0.22
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.24;
    cityGroup.add(ring);

    const towerPositions = [
      [-22, 6.4, -10],
      [22, 7.8, -8],
      [-18, 9.2, 17],
      [19, 8.8, 15],
      [0, 11.6, -24],
      [0, 8.6, 22],
      [-25, 6.8, 2],
      [25, 7.1, 3]
    ];
    const towerMaterial = new THREE.MeshStandardMaterial({
      color: 0x5f758f,
      roughness: 0.56,
      metalness: 0.28,
      emissive: 0x273a52,
      emissiveIntensity: 0.3
    });
    for (const [x, h, z] of towerPositions) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(4.6, h, 4.6), towerMaterial);
      tower.position.set(x, h * 0.5, z);
      tower.castShadow = !this.mobileEnabled;
      tower.receiveShadow = true;
      cityGroup.add(tower);
    }

    const skylineMaterial = new THREE.MeshStandardMaterial({
      color: 0x4b5f74,
      roughness: 0.62,
      metalness: 0.18,
      emissive: 0x1c2b3b,
      emissiveIntensity: 0.2
    });
    const skylineCapMaterial = new THREE.MeshStandardMaterial({
      color: 0x86a9c8,
      roughness: 0.28,
      metalness: 0.45,
      emissive: 0x35516b,
      emissiveIntensity: 0.28
    });
    // Clone the plaza tower pattern into a larger skyline ring so it reads from mid-distance.
    for (let i = 0; i < towerPositions.length; i += 1) {
      const [x, h, z] = towerPositions[i];
      const megaX = x * 2.7;
      const megaZ = z * 2.7;
      const megaHeight = Math.max(30, h * 4.2 + (i % 3) * 4.5);
      const footprint = 8.4 + (i % 2) * 1.8;

      const megaTower = new THREE.Mesh(
        new THREE.BoxGeometry(footprint, megaHeight, footprint),
        skylineMaterial
      );
      megaTower.position.set(megaX, megaHeight * 0.5, megaZ);
      megaTower.castShadow = !this.mobileEnabled;
      megaTower.receiveShadow = true;
      cityGroup.add(megaTower);

      const towerCap = new THREE.Mesh(
        new THREE.CylinderGeometry(footprint * 0.26, footprint * 0.32, 1.7, this.mobileEnabled ? 9 : 14),
        skylineCapMaterial
      );
      towerCap.position.set(megaX, megaHeight + 0.86, megaZ);
      towerCap.castShadow = !this.mobileEnabled;
      towerCap.receiveShadow = true;
      cityGroup.add(towerCap);
    }

    const npcGuide = new THREE.Group();
    npcGuide.position.set(this.bridgeNpcPosition.x, 0, this.bridgeNpcPosition.z);

    const npcBody = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 0.86, 4, 8),
      new THREE.MeshStandardMaterial({
        color: 0x516578,
        roughness: 0.44,
        metalness: 0.18,
        emissive: 0x2a4159,
        emissiveIntensity: 0.26
      })
    );
    npcBody.position.y = 0.92;
    npcBody.castShadow = !this.mobileEnabled;
    npcBody.receiveShadow = true;

    const npcHead = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 14, 14),
      new THREE.MeshStandardMaterial({
        color: 0x84a4c2,
        roughness: 0.3,
        metalness: 0.18,
        emissive: 0x3d6184,
        emissiveIntensity: 0.32
      })
    );
    npcHead.position.y = 1.65;
    npcHead.castShadow = !this.mobileEnabled;
    npcHead.receiveShadow = true;

    const npcPad = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1.18, this.mobileEnabled ? 24 : 36),
      new THREE.MeshBasicMaterial({
        color: 0x9ad6ff,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    npcPad.rotation.x = -Math.PI / 2;
    npcPad.position.y = 0.04;

    const npcHoloFloor = new THREE.Mesh(
      new THREE.CircleGeometry(2.12, this.mobileEnabled ? 28 : 48),
      new THREE.MeshBasicMaterial({
        color: 0x67dfff,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    npcHoloFloor.rotation.x = -Math.PI / 2;
    npcHoloFloor.position.y = 0.028;

    const npcHoloRing = new THREE.Mesh(
      new THREE.RingGeometry(1.34, 2.18, this.mobileEnabled ? 28 : 52),
      new THREE.MeshBasicMaterial({
        color: 0x9cefff,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    npcHoloRing.rotation.x = -Math.PI / 2;
    npcHoloRing.position.y = 0.032;

    const npcHoloBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.56, 1.16, 2.34, this.mobileEnabled ? 12 : 18, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x6ad7ff,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    npcHoloBeam.position.y = 1.2;

    const npcHoloFrame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.56, 2.52)),
      new THREE.LineBasicMaterial({
        color: 0xa2f0ff,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending
      })
    );
    npcHoloFrame.position.set(0, 1.48, -0.45);
    npcHoloFrame.rotation.y = Math.PI;
    npcHoloFrame.renderOrder = 13;
    npcHoloFrame.frustumCulled = false;

    npcGuide.add(npcHoloFloor, npcHoloRing, npcHoloBeam, npcBody, npcHead, npcPad, npcHoloFrame);
    const npcGreetingScreen = this.createNpcGreetingScreen();
    npcGuide.add(npcGreetingScreen);

    const mirrorGate = new THREE.Group();
    mirrorGate.position.set(this.bridgeMirrorPosition.x, 0, this.bridgeMirrorPosition.z);
    mirrorGate.visible = false;

    const shrinePillarMaterial = new THREE.MeshStandardMaterial({
      color: 0x8f3a2d,
      roughness: 0.56,
      metalness: 0.1,
      emissive: 0x361611,
      emissiveIntensity: 0.11
    });
    const shrineBeamMaterial = new THREE.MeshStandardMaterial({
      color: 0x25445f,
      roughness: 0.5,
      metalness: 0.18,
      emissive: 0x112435,
      emissiveIntensity: 0.12
    });
    const shrineTileMaterial = new THREE.MeshStandardMaterial({
      color: 0x3d4a5a,
      roughness: 0.44,
      metalness: 0.2,
      emissive: 0x1a2430,
      emissiveIntensity: 0.1
    });
    const shrineStoneMaterial = new THREE.MeshStandardMaterial({
      color: 0x8b9098,
      roughness: 0.76,
      metalness: 0.04
    });

    const shrineLeftPost = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 4.9, 0.52),
      shrinePillarMaterial
    );
    shrineLeftPost.position.set(-1.72, 2.45, 0);
    shrineLeftPost.castShadow = !this.mobileEnabled;
    shrineLeftPost.receiveShadow = true;

    const shrineRightPost = shrineLeftPost.clone();
    shrineRightPost.position.x = 1.72;

    const shrineLeftBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.56, 0.26, this.mobileEnabled ? 12 : 18),
      shrineStoneMaterial
    );
    shrineLeftBase.position.set(-1.72, 0.13, 0);
    shrineLeftBase.castShadow = !this.mobileEnabled;
    shrineLeftBase.receiveShadow = true;

    const shrineRightBase = shrineLeftBase.clone();
    shrineRightBase.position.x = 1.72;

    const shrineTopBeam = new THREE.Mesh(
      new THREE.BoxGeometry(5.12, 0.34, 0.56),
      shrinePillarMaterial
    );
    shrineTopBeam.position.set(0, 3.72, 0);
    shrineTopBeam.castShadow = !this.mobileEnabled;
    shrineTopBeam.receiveShadow = true;

    const shrineMiddleBeam = new THREE.Mesh(
      new THREE.BoxGeometry(4.46, 0.28, 0.44),
      shrineBeamMaterial
    );
    shrineMiddleBeam.position.set(0, 3.26, 0);
    shrineMiddleBeam.castShadow = !this.mobileEnabled;
    shrineMiddleBeam.receiveShadow = true;

    const shrineLowerBeam = new THREE.Mesh(
      new THREE.BoxGeometry(3.86, 0.24, 0.34),
      shrineBeamMaterial
    );
    shrineLowerBeam.position.set(0, 2.5, 0);
    shrineLowerBeam.castShadow = !this.mobileEnabled;
    shrineLowerBeam.receiveShadow = true;

    const shrineRoofCore = new THREE.Mesh(
      new THREE.BoxGeometry(5.36, 0.18, 1.38),
      shrineTileMaterial
    );
    shrineRoofCore.position.set(0, 4.02, 0);
    shrineRoofCore.castShadow = !this.mobileEnabled;
    shrineRoofCore.receiveShadow = true;

    const shrineRoofFront = new THREE.Mesh(
      new THREE.BoxGeometry(5.64, 0.16, 0.46),
      shrineTileMaterial
    );
    shrineRoofFront.position.set(0, 3.94, 0.72);
    shrineRoofFront.rotation.x = 0.22;
    shrineRoofFront.castShadow = !this.mobileEnabled;
    shrineRoofFront.receiveShadow = true;

    const shrineRoofBack = shrineRoofFront.clone();
    shrineRoofBack.position.z = -0.72;
    shrineRoofBack.rotation.x = -0.22;

    const shrineRoofRidge = new THREE.Mesh(
      new THREE.BoxGeometry(4.96, 0.16, 0.34),
      shrineTileMaterial
    );
    shrineRoofRidge.position.set(0, 4.18, 0);
    shrineRoofRidge.castShadow = !this.mobileEnabled;
    shrineRoofRidge.receiveShadow = true;

    const shrinePlaque = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.88, 0.1),
      new THREE.MeshStandardMaterial({
        color: 0xe8dbc1,
        roughness: 0.36,
        metalness: 0.12,
        emissive: 0x4d442f,
        emissiveIntensity: 0.08
      })
    );
    shrinePlaque.position.set(0, 3.02, 0.28);
    shrinePlaque.castShadow = !this.mobileEnabled;
    shrinePlaque.receiveShadow = true;

    const shrineAura = new THREE.Mesh(
      new THREE.RingGeometry(1.34, 1.95, this.mobileEnabled ? 28 : 44),
      new THREE.MeshBasicMaterial({
        color: 0xb6f0ff,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    shrineAura.rotation.x = -Math.PI / 2;
    shrineAura.position.y = 0.06;

    const mirrorPad = new THREE.Mesh(
      new THREE.RingGeometry(1.52, 2.18, this.mobileEnabled ? 24 : 36),
      new THREE.MeshBasicMaterial({
        color: 0x7df0ff,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    mirrorPad.rotation.x = -Math.PI / 2;
    mirrorPad.position.y = 0.04;

    mirrorGate.add(
      shrineLeftBase,
      shrineRightBase,
      shrineLeftPost,
      shrineRightPost,
      shrineTopBeam,
      shrineMiddleBeam,
      shrineLowerBeam,
      shrineRoofCore,
      shrineRoofFront,
      shrineRoofBack,
      shrineRoofRidge,
      shrinePlaque,
      shrineAura,
      mirrorPad
    );

    const boundaryMarker = new THREE.Group();
    boundaryMarker.position.set(this.bridgeCityEntry.x, 0, this.bridgeCityEntry.z);
    const boundaryPortalRadius = Math.max(2.2, this.bridgeWidth * 0.34);

    const boundaryRing = new THREE.Mesh(
      new THREE.TorusGeometry(boundaryPortalRadius, 0.22, 22, this.mobileEnabled ? 36 : 68),
      new THREE.MeshStandardMaterial({
        color: 0x84dcff,
        roughness: 0.14,
        metalness: 0.46,
        emissive: 0x49bfff,
        emissiveIntensity: 0.48,
        transparent: true,
        opacity: 0.82
      })
    );
    boundaryRing.position.y = 2.06;

    const boundaryHalo = new THREE.Mesh(
      new THREE.CircleGeometry(boundaryPortalRadius * 0.82, this.mobileEnabled ? 26 : 52),
      new THREE.MeshBasicMaterial({
        color: 0xaaf2ff,
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    boundaryHalo.position.y = 2.06;

    const boundaryBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.12, 1.18, this.mobileEnabled ? 10 : 16),
      new THREE.MeshBasicMaterial({
        color: 0x7fe6ff,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    boundaryBeam.position.y = 0.62;

    this.npcGuideGroup = npcGuide;
    this.mirrorGateGroup = mirrorGate;
    this.mirrorGatePanel = null;
    this.bridgeBoundaryMarker = boundaryMarker;
    this.bridgeBoundaryRing = boundaryRing;
    this.bridgeBoundaryHalo = boundaryHalo;
    this.bridgeBoundaryBeam = boundaryBeam;

    boundaryMarker.add(boundaryRing, boundaryHalo, boundaryBeam);
    group.add(bridgeGroup, cityGroup, npcGuide, mirrorGate, boundaryMarker);
    this.scene.add(group);
    this.setMirrorGateVisible(this.flowStage === "bridge_mirror");
    this.updateBridgeBoundaryMarker(0);
    this.updatePortalVisual();
  }

  applyInitialFlowSpawn() {
    if (!this.hubFlowEnabled) {
      this.flowStage = "city_live";
      this.hubFlowUiEl?.classList.add("hidden");
      this.hideNicknameGate();
      if (this.portalTargetUrl) {
        const portalFrontSpawn = this.getPortalFrontSpawnPoint();
        this.playerPosition.copy(portalFrontSpawn);
        this.yaw = this.getLookYaw(this.playerPosition, this.portalFloorPosition);
        this.pitch = -0.03;
      }
      this.lastSafePosition.copy(this.playerPosition);
      return;
    }

    this.flowStage = "bridge_approach";
    this.flowClock = 0;
    this.mirrorLookClock = 0;
    this.bridgeBoundaryDingClock = 0;
    this.bridgeBoundaryDingTriggered = false;
    this.portalPhase = "cooldown";
    this.portalPhaseClock = this.portalCooldownSeconds;
    this.playerPosition.copy(this.bridgeApproachSpawn);
    this.yaw = this.getLookYaw(this.bridgeApproachSpawn, this.bridgeNpcPosition);
    this.pitch = -0.03;
    this.setFlowHeadline(
      "다리 입구",
      "검문소 안내원 쪽으로 이동하세요."
    );
    this.hud.setStatus(this.getStatusText());
    this.hideNicknameGate();
    this.setMirrorGateVisible(false);
    this.lastSafePosition.copy(this.playerPosition);
  }

  bindHubFlowUiEvents() {
    if (this.hubFlowUiBound || !this.hubFlowEnabled || !this.nicknameFormEl) {
      return;
    }
    this.hubFlowUiBound = true;

    this.nicknameFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      this.confirmBridgeName();
    });
  }

  setupLobbyUi() {
    if (!this.lobbyEnabled) {
      return;
    }

    this.showLobbyScreen("닉네임을 입력한 뒤 입장 버튼을 눌러주세요.");
    if (this.lobbyNameInputEl) {
      const suggestedName =
        /^PLAYER(?:_\d+)?$/i.test(this.localPlayerName) || /^플레이어(?:_\d+)?$/i.test(this.localPlayerName)
          ? ""
          : this.localPlayerName;
      this.lobbyNameInputEl.value = suggestedName;
      window.setTimeout(() => {
        this.lobbyNameInputEl?.focus();
        this.lobbyNameInputEl?.select();
      }, 20);
    }
  }

  isLobbyBlockingGameplay() {
    return Boolean(this.lobbyEnabled && this.lobbyVisible);
  }

  showLobbyScreen(statusText = "") {
    if (!this.lobbyEnabled || !this.lobbyScreenEl) {
      return;
    }
    this.lobbyVisible = true;
    this.lobbyScreenEl.classList.remove("hidden");
    if (this.lobbyJoinBtnEl) {
      this.lobbyJoinBtnEl.disabled = this.lobbyJoinInFlight;
    }
    this.setLobbyStatus(statusText || "닉네임 입력 후 입장하세요.");
    this.syncGameplayUiForFlow();
    this.updateQuizControlUi();
  }

  hideLobbyScreen() {
    if (!this.lobbyEnabled || !this.lobbyScreenEl) {
      return;
    }
    this.lobbyVisible = false;
    this.lobbyScreenEl.classList.add("hidden");
    this.setLobbyStatus("");
    this.syncGameplayUiForFlow();
    this.updateQuizControlUi();
  }

  setLobbyStatus(text, isError = false) {
    if (!this.lobbyStatusEl) {
      return;
    }
    const message = String(text ?? "").trim();
    this.lobbyStatusEl.textContent = message || "닉네임 입력 후 입장하세요.";
    this.lobbyStatusEl.classList.toggle("error", Boolean(isError));
  }

  handleLobbyRoomList(payload) {
    if (!this.lobbyEnabled) {
      return;
    }
    const rooms = Array.isArray(payload) ? payload : [];
    this.lobbyLastRooms = rooms;
    const totalPlayers = rooms.reduce((sum, room) => sum + Math.max(0, Math.trunc(Number(room?.count) || 0)), 0);
    if (this.lobbyRoomCountEl) {
      this.lobbyRoomCountEl.textContent = String(rooms.length);
    }
    if (this.lobbyPlayerCountEl) {
      this.lobbyPlayerCountEl.textContent = String(totalPlayers);
    }
    if (this.lobbyTopRoomEl) {
      const topRoom = rooms
        .slice()
        .sort((left, right) => Math.max(0, Number(right?.count) || 0) - Math.max(0, Number(left?.count) || 0))[0];
      if (topRoom) {
        const code = String(topRoom?.code ?? "OX");
        const count = Math.max(0, Math.trunc(Number(topRoom?.count) || 0));
        const capacity = Math.max(1, Math.trunc(Number(topRoom?.capacity) || 120));
        this.lobbyTopRoomEl.textContent = `대표 방 ${code} · ${count}/${capacity}`;
        const participantLimit = this.gatewayParticipantLimit;
        const participantCount = Math.min(count, participantLimit);
        const spectatorCount = Math.max(0, count - participantCount);
        const spectatorCapacity = Math.max(0, capacity - participantLimit);
        if (this.lobbySlotParticipantsEl) {
          this.lobbySlotParticipantsEl.textContent =
            `참가 슬롯 ${participantCount}/${participantLimit}`;
        }
        if (this.lobbySlotSpectatorsEl) {
          this.lobbySlotSpectatorsEl.textContent =
            `관전자 슬롯 ${spectatorCount}/${spectatorCapacity}`;
        }
      } else {
        this.lobbyTopRoomEl.textContent = "현재 빈 방에서 시작됩니다.";
        if (this.lobbySlotParticipantsEl) {
          this.lobbySlotParticipantsEl.textContent = `참가 슬롯 0/${this.gatewayParticipantLimit}`;
        }
        if (this.lobbySlotSpectatorsEl) {
          const spectatorCap = Math.max(0, 120 - this.gatewayParticipantLimit);
          this.lobbySlotSpectatorsEl.textContent = `관전자 슬롯 0/${spectatorCap}`;
        }
      }
    }
  }

  requestLobbyJoin() {
    if (!this.lobbyEnabled) {
      return;
    }

    const rawName = String(this.lobbyNameInputEl?.value ?? this.localPlayerName ?? "").trim();
    const nextName = rawName || this.createGuestPlayerName();

    this.localPlayerName = this.formatPlayerName(nextName);
    if (this.lobbyNameInputEl) {
      this.lobbyNameInputEl.value = this.localPlayerName;
    }
    this.lobbyNameConfirmed = true;
    this.lobbyJoinAutoRetryRemaining = LOBBY_JOIN_AUTO_RETRY_LIMIT;
    this.pendingPlayerNameSync = true;
    this.setLobbyStatus("Preparing matchmaking connection...");

    if (!this.socket) {
      this.connectNetwork({
        endpoint: this.socketEndpoint ?? this.resolveSocketEndpoint() ?? "",
        auth: this.socketAuth
      });
    } else if (!this.networkConnected && typeof this.socket.connect === "function") {
      try {
        this.socket.connect();
      } catch {
        // Keep join pending and rely on built-in reconnection flow.
      }
    }

    this.syncPlayerNameIfConnected();
  }

  showNicknameGate() {
    if (!this.nicknameGateEl) {
      return;
    }
    this.nicknameGateEl.classList.remove("hidden");
    this.setNicknameError("");
    if (this.nicknameInputEl) {
      const nextName =
        /^PLAYER(?:_\d+)?$/i.test(this.localPlayerName) || /^플레이어(?:_\d+)?$/i.test(this.localPlayerName)
          ? ""
          : this.localPlayerName;
      this.nicknameInputEl.value = nextName;
      window.setTimeout(() => {
        this.nicknameInputEl?.focus();
        this.nicknameInputEl?.select();
      }, 10);
    }
  }

  hideNicknameGate() {
    this.nicknameGateEl?.classList.add("hidden");
    this.setNicknameError("");
  }

  setNicknameError(message) {
    if (!this.nicknameErrorEl) {
      return;
    }
    const text = String(message ?? "").trim();
    this.nicknameErrorEl.textContent = text;
    this.nicknameErrorEl.classList.toggle("hidden", !text);
  }

  confirmBridgeName() {
    if (!this.hubFlowEnabled || this.flowStage !== "bridge_name") {
      return;
    }

    const raw = String(this.nicknameInputEl?.value ?? "").trim();
    if (raw.length < 2) {
      this.setNicknameError("호출명은 최소 2자 이상이어야 합니다.");
      return;
    }

    const nextName = this.formatPlayerName(raw);
    this.localPlayerName = nextName;
    this.pendingPlayerNameSync = true;
    this.syncPlayerNameIfConnected();

    this.hideNicknameGate();
    this.flowStage = "bridge_mirror";
    this.mirrorLookClock = 0;
    this.flowClock = 0;
    this.keys.clear();
    this.chalkDrawingActive = false;
    this.chalkLastStamp = null;
    this.setMirrorGateVisible(true);
    this.yaw = this.getLookYaw(this.playerPosition, this.bridgeMirrorPosition);
    this.setFlowHeadline("입구 확인", "사찰 입구를 바라보면 이동 승인이 완료됩니다.");
    this.hud.setStatus(this.getStatusText());
    this.syncGameplayUiForFlow();
  }

  syncGameplayUiForFlow() {
    const gameplayEnabled = !this.hubFlowEnabled || this.flowStage === "city_live";
    const lobbyBlocked = this.isLobbyBlockingGameplay();
    const admissionBlocked = this.localAdmissionWaiting;
    const chalkEnabled = Boolean(this.worldContent?.chalk?.enabled);
    this.toolUiEl?.classList.toggle(
      "hidden",
      !gameplayEnabled || !chalkEnabled || lobbyBlocked || admissionBlocked
    );
    this.chatUiEl?.classList.toggle("hidden", !gameplayEnabled || lobbyBlocked || admissionBlocked);
    if (!gameplayEnabled || lobbyBlocked || admissionBlocked) {
      this.setChatOpen(false);
    }
    this.updateEntryWaitOverlay();
    this.updateMobileControlUi();
  }

  updateEntryWaitOverlay() {
    const shouldShow = Boolean(this.localAdmissionWaiting && !this.isLobbyBlockingGameplay());
    this.entryWaitOverlayEl?.classList.toggle("hidden", !shouldShow);
    this.entryWaitOverlayEl?.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    if (this.entryWaitTextEl) {
      const waiting = Math.max(0, Math.trunc(Number(this.entryGateState?.waitingPlayers) || 0));
      const participantLimit = Math.max(
        1,
        Math.trunc(Number(this.entryGateState?.participantLimit) || 50)
      );
      const spectatorPlayers = Math.max(
        0,
        Math.trunc(Number(this.entryGateState?.spectatorPlayers) || 0)
      );
      const priorityPlayers = Math.max(
        0,
        Math.trunc(Number(this.entryGateState?.priorityPlayers) || 0)
      );
      const countdownSeconds = this.getAdmissionCountdownSeconds();
      const admissionInProgress =
        this.entryGateState?.admissionInProgress === true || countdownSeconds > 0;
      let nextText;
      if (admissionInProgress) {
        nextText =
          countdownSeconds > 0
            ? `입장 카운트다운 ${countdownSeconds}초... 곧 경기장으로 이동합니다.`
            : "입장 처리 중입니다. 잠시만 기다려주세요.";
      } else if (this.entryGateState?.portalOpen) {
        nextText =
          waiting > 0
            ? `포탈 대기실: 선착순 ${participantLimit}명 참가, 이후 관전 전환 (대기열 ${waiting}명)`
            : `포탈 대기실: 선착순 ${participantLimit}명 참가, 이후 관전 전환`;
      } else {
        nextText =
          spectatorPlayers > 0 || priorityPlayers > 0
            ? `관전자 대기 중입니다. 현재 관전 ${spectatorPlayers}명, 다음 판 우선 ${priorityPlayers}명`
            : "입장 대기 중입니다. 진행자의 포탈 열기/입장 시작을 기다려주세요.";
      }
      if (this.entryWaitTextEl.textContent !== nextText) {
        this.entryWaitTextEl.textContent = nextText;
      }
    }
    if (shouldShow && document.pointerLockElement === this.renderer?.domElement) {
      document.exitPointerLock?.();
    }
  }

  getAdmissionCountdownMs(nowMs = Date.now()) {
    const startsAt = Math.max(0, Math.trunc(Number(this.entryGateState?.admissionStartsAt) || 0));
    if (startsAt <= 0) {
      return 0;
    }
    const now = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    return Math.max(0, startsAt - now);
  }

  getAdmissionCountdownSeconds(nowMs = Date.now()) {
    const remainMs = this.getAdmissionCountdownMs(nowMs);
    if (remainMs <= 0) {
      return 0;
    }
    return Math.max(1, Math.ceil(remainMs / 1000));
  }

  setMirrorGateVisible(visible) {
    if (this.mirrorGateGroup) {
      this.mirrorGateGroup.visible = Boolean(visible);
    }
  }

  openBridgeNameGate() {
    if (!this.hubFlowEnabled || this.flowStage !== "bridge_dialogue") {
      return;
    }
    this.flowStage = "bridge_name";
    this.keys.clear();
    this.chalkDrawingActive = false;
    this.chalkLastStamp = null;
    this.showNicknameGate();
    this.setFlowHeadline("검문소 등록", "안내원 앞에서 호출명을 등록하세요.");
    this.hud.setStatus(this.getStatusText());
  }

  createNpcGreetingScreen() {
    const video = document.createElement("video");
    video.src = NPC_GREETING_VIDEO_URL;
    video.preload = "auto";
    video.loop = false;
    video.muted = false;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");

    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;

    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1.42, 2.38),
      new THREE.MeshBasicMaterial({
        map: videoTexture,
        transparent: true,
        alphaTest: 0.02,
        depthWrite: false
      })
    );
    screen.position.set(0, 1.48, -0.42);
    screen.rotation.y = Math.PI;
    screen.renderOrder = 12;
    screen.frustumCulled = false;
    video.onended = () => {
      this.openBridgeNameGate();
    };
    video.onerror = () => {
      this.openBridgeNameGate();
    };

    this.npcGreetingVideoEl = video;
    this.npcGreetingVideoTexture = videoTexture;
    this.npcGreetingScreen = screen;
    this.npcGreetingPlayed = false;
    this.applyUiVolumeToMedia();
    return screen;
  }

  playNpcGreeting() {
    if (!this.npcGreetingVideoEl) {
      this.openBridgeNameGate();
      return;
    }
    if (this.npcGreetingPlayed) {
      this.openBridgeNameGate();
      return;
    }

    const video = this.npcGreetingVideoEl;
    const tryPlay = () =>
      video.play().then(
        () => {
          this.npcGreetingPlayed = true;
        },
        () => Promise.reject(new Error("재생 실패"))
      );

    video.currentTime = 0;
    tryPlay().catch(() => {
      video.muted = true;
      video.currentTime = 0;
      video.play().then(
        () => {
          this.npcGreetingPlayed = true;
        },
        () => {
          this.npcGreetingPlayed = false;
          this.openBridgeNameGate();
        }
      );
    });
  }

  getNpcDistance() {
    const dx = this.playerPosition.x - this.bridgeNpcPosition.x;
    const dz = this.playerPosition.z - this.bridgeNpcPosition.z;
    return Math.hypot(dx, dz);
  }

  evaluateGateFocus() {
    const dx = this.playerPosition.x - this.bridgeMirrorPosition.x;
    const dz = this.playerPosition.z - this.bridgeMirrorPosition.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 5.2) {
      return 0;
    }

    this.tempVecA.set(this.bridgeMirrorPosition.x, this.bridgeMirrorPosition.y, this.bridgeMirrorPosition.z);
    this.tempVecA.sub(this.camera.position).normalize();
    this.camera.getWorldDirection(this.tempVecB);
    const alignment = this.tempVecA.dot(this.tempVecB);
    return THREE.MathUtils.clamp((alignment - 0.86) / 0.14, 0, 1);
  }

  triggerBridgeBoundaryDing() {
    this.bridgeBoundaryDingClock = 0.72;
    this.bridgeBoundaryDingTriggered = true;
  }

  updateBridgeBoundaryMarker(delta) {
    if (!this.bridgeBoundaryMarker || !this.bridgeBoundaryRing || !this.bridgeBoundaryHalo || !this.bridgeBoundaryBeam) {
      return;
    }

    this.bridgeBoundaryDingClock = Math.max(0, this.bridgeBoundaryDingClock - delta);
    const dingAlpha = THREE.MathUtils.clamp(this.bridgeBoundaryDingClock / 0.72, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(this.portalPulseClock * 5.2);

    const ringMaterial = this.bridgeBoundaryRing.material;
    const haloMaterial = this.bridgeBoundaryHalo.material;
    const beamMaterial = this.bridgeBoundaryBeam.material;

    ringMaterial.emissiveIntensity = 0.42 + pulse * 0.42 + dingAlpha * 1.08;
    ringMaterial.opacity = 0.72 + pulse * 0.1 + dingAlpha * 0.2;
    haloMaterial.opacity = 0.16 + pulse * 0.22 + dingAlpha * 0.34;
    beamMaterial.opacity = 0.2 + pulse * 0.16 + dingAlpha * 0.28;

    const scale = 1 + dingAlpha * 0.18;
    this.bridgeBoundaryMarker.scale.set(scale, 1 + dingAlpha * 0.08, scale);
  }

  setFlowHeadline(title, subtitle) {
    if (this.hubFlowUiEl) {
      this.hubFlowUiEl.classList.remove("hidden");
    }
    const nextTitle = String(title ?? "").trim();
    const nextSubtitle = String(subtitle ?? "").trim();
    if (this.hubPhaseTitleEl) {
      if (this.flowHeadlineCache.title !== nextTitle) {
        this.hubPhaseTitleEl.textContent = nextTitle;
      }
    }
    if (this.hubPhaseSubtitleEl) {
      if (this.flowHeadlineCache.subtitle !== nextSubtitle) {
        this.hubPhaseSubtitleEl.textContent = nextSubtitle;
      }
    }
    this.flowHeadlineCache.title = nextTitle;
    this.flowHeadlineCache.subtitle = nextSubtitle;
  }

  getLookYaw(from, to) {
    const dx = Number(to?.x ?? 0) - Number(from?.x ?? 0);
    const dz = Number(to?.z ?? 0) - Number(from?.z ?? 0);
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) {
      return this.yaw;
    }
    return Math.atan2(-dx, -dz);
  }

  resolveTargetCameraFov() {
    if (!this.mobileEnabled) {
      return GAME_CONSTANTS.DEFAULT_FOV;
    }
    const width = typeof window !== "undefined" ? Number(window.innerWidth) || 0 : 0;
    const height = typeof window !== "undefined" ? Number(window.innerHeight) || 0 : 0;
    const aspect = width > 0 && height > 0 ? width / height : 1;
    return aspect < 1 ? MOBILE_RUNTIME_SETTINGS.fovPortrait : MOBILE_RUNTIME_SETTINGS.fovLandscape;
  }

  isMobilePortraitLocked() {
    if (!this.mobileEnabled || typeof window === "undefined") {
      return false;
    }
    const width = Number(window.innerWidth) || 0;
    const height = Number(window.innerHeight) || 0;
    if (width <= 0 || height <= 0) {
      return false;
    }
    return height > width;
  }

  syncOrientationLockUi() {
    this.resolveUiElements();
    const locked = this.isMobilePortraitLocked();
    this.orientationLockOverlayEl?.classList.toggle("hidden", !locked);
    this.orientationLockOverlayEl?.setAttribute("aria-hidden", locked ? "false" : "true");
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle("mobile-orientation-lock", locked);
    }
    return locked;
  }

  tryLockLandscapeOrientation() {
    if (!this.mobileEnabled || typeof screen === "undefined") {
      return;
    }
    const orientation = screen.orientation;
    if (!orientation || typeof orientation.lock !== "function") {
      return;
    }
    orientation.lock("landscape").catch(() => {});
  }

  canMovePlayer() {
    if (this.isMobilePortraitLocked()) {
      return false;
    }
    if (this.isOfflineStartModalOpen()) {
      return false;
    }
    if (this.isLobbyBlockingGameplay()) {
      return false;
    }
    if (this.localAdmissionWaiting) {
      return false;
    }
    const quizPhase = String(this.quizState.phase ?? "");
    if (
      this.quizState.active &&
      this.localQuizAlive &&
      !this.localSpectatorMode &&
      (quizPhase === "lock" || quizPhase === "locked")
    ) {
      return false;
    }
    if (this.quizState.active && !this.localQuizAlive && !this.localSpectatorMode) {
      return false;
    }
    if (!this.hubFlowEnabled) {
      return true;
    }
    return (
      this.flowStage === "bridge_approach" ||
      this.flowStage === "bridge_mirror" ||
      this.flowStage === "city_live"
    );
  }

  canUseGameplayControls() {
    if (this.isMobilePortraitLocked()) {
      return false;
    }
    if (this.isOfflineStartModalOpen()) {
      return false;
    }
    return (
      !this.isLobbyBlockingGameplay() &&
      !this.localAdmissionWaiting &&
      (!this.hubFlowEnabled || this.flowStage === "city_live")
    );
  }

  canUsePointerLock() {
    return this.canMovePlayer() && !this.portalTransitioning;
  }

  getFullscreenElement() {
    if (typeof document === "undefined") {
      return null;
    }
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  }

  isFullscreenActive() {
    return Boolean(this.getFullscreenElement());
  }

  isFullscreenSupported() {
    if (typeof document === "undefined") {
      return false;
    }
    const root = document.documentElement;
    return Boolean(root?.requestFullscreen || root?.webkitRequestFullscreen);
  }

  toggleFullscreenFromInteraction() {
    if (!this.isFullscreenSupported() || typeof document === "undefined") {
      return;
    }
    if (this.isFullscreenActive()) {
      const exitFn = document.exitFullscreen ?? document.webkitExitFullscreen;
      if (typeof exitFn !== "function") {
        return;
      }
      try {
        const maybePromise = exitFn.call(document);
        if (maybePromise && typeof maybePromise.catch === "function") {
          maybePromise.catch(() => {});
        }
      } catch {
        // ignore
      }
      return;
    }

    const root = document.documentElement;
    if (!root) {
      return;
    }
    const requestFn = root.requestFullscreen ?? root.webkitRequestFullscreen;
    if (typeof requestFn !== "function") {
      return;
    }
    try {
      const maybePromise = requestFn.call(root, { navigationUI: "hide" });
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  requestAppFullscreen({ fromGesture = false } = {}) {
    if (!this.mobileEnabled || !this.isFullscreenSupported()) {
      return;
    }
    if (this.isFullscreenActive()) {
      this.fullscreenPending = false;
      return;
    }

    const now = performance.now();
    if (!fromGesture && now - this.lastFullscreenAttemptAt < 1200) {
      return;
    }
    this.lastFullscreenAttemptAt = now;

    const root = document.documentElement;
    try {
      if (typeof root.requestFullscreen === "function") {
        let maybePromise = null;
        try {
          maybePromise = root.requestFullscreen({ navigationUI: "hide" });
        } catch {
          maybePromise = root.requestFullscreen();
        }
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise
            .then(() => {
              this.fullscreenPending = false;
              this.tryLockLandscapeOrientation();
            })
            .catch(() => {
              this.fullscreenPending = true;
            });
        }
        return;
      }
      if (typeof root.webkitRequestFullscreen === "function") {
        root.webkitRequestFullscreen();
        this.fullscreenPending = !this.isFullscreenActive();
        this.tryLockLandscapeOrientation();
      }
    } catch {
      this.fullscreenPending = true;
    }
  }

  startLocalEliminationDrop(reasonLabel = "오답 구역") {
    if (this.localSpectatorMode || this.localEliminationDrop.active) {
      return;
    }
    this.localEliminationDrop.active = true;
    this.localEliminationDrop.elapsed = 0;
    this.localEliminationDrop.velocityY = -1.4;
    this.spectatorFollowId = null;
    this.spectatorFollowIndex = -1;
    this.verticalVelocity = -1.4;
    this.keys.clear();
    this.releaseMobileInputs();
    this.appendChatLine(
      "시스템",
      `탈락했습니다 (${String(reasonLabel)}). 관전자 구역으로 이동합니다...`,
      "system"
    );
  }

  finishLocalEliminationDrop() {
    this.localEliminationDrop.active = false;
    this.localEliminationDrop.elapsed = 0;
    this.localEliminationDrop.velocityY = 0;
    this.localSpectatorMode = true;
    this.spectatorViewMode = "third";
    this.verticalVelocity = 0;
    this.playerPosition.copy(this.spectatorSpawn);
    this.enforceSpectatorArenaGuard();
    this.yaw = this.getLookYaw(this.playerPosition, this.tempVecA.set(0, GAME_CONSTANTS.PLAYER_HEIGHT, 0));
    this.pitch = -0.08;
    this.playerPosition.y = GAME_CONSTANTS.PLAYER_HEIGHT;
    this.onGround = true;
    this.lastSafePosition.set(this.playerPosition.x, GAME_CONSTANTS.PLAYER_HEIGHT, this.playerPosition.z);
    this.showSpectatorControlHint();
    this.appendChatLine(
      "시스템",
      "관전 모드: WASD 이동, SPACE/CTRL 상하 이동, V로 생존자 관전 전환",
      "system"
    );
  }

  enterHostSpectatorMode() {
    if (this.localSpectatorMode) {
      return;
    }
    this.localSpectatorMode = true;
    this.localEliminationDrop.active = false;
    this.localEliminationDrop.elapsed = 0;
    this.localEliminationDrop.velocityY = 0;
    this.spectatorViewMode = "third";
    this.spectatorFollowId = null;
    this.spectatorFollowIndex = -1;
    this.verticalVelocity = 0;
    this.playerPosition.y = GAME_CONSTANTS.PLAYER_HEIGHT;
    this.enforceSpectatorArenaGuard();
    this.onGround = true;
    this.showSpectatorControlHint();
    this.appendChatLine(
      "시스템",
      "진행자 관전 모드가 활성화되었습니다. 진행자는 탈락하지 않습니다.",
      "system"
    );
  }

  ensureLocalGameplayPosition() {
    this.localSpectatorMode = false;
    this.localEliminationDrop.active = false;
    this.localEliminationDrop.elapsed = 0;
    this.localEliminationDrop.velocityY = 0;
    this.spectatorViewMode = "third";
    this.spectatorFollowId = null;
    this.spectatorFollowIndex = -1;
    this.verticalVelocity = 0;
    this.onGround = true;
    if (this.hubFlowEnabled) {
      this.playerPosition.copy(this.citySpawn);
    } else {
      this.playerPosition.set(0, GAME_CONSTANTS.PLAYER_HEIGHT, 0);
    }
    this.lastSafePosition.set(this.playerPosition.x, GAME_CONSTANTS.PLAYER_HEIGHT, this.playerPosition.z);
  }

  getAutoStartCountdownSeconds() {
    const startsAt = Number(this.quizState.autoStartsAt) || 0;
    if (startsAt <= 0) {
      return 0;
    }
    return Math.max(0, Math.ceil((startsAt - Date.now()) / 1000));
  }

  showSpectatorControlHint() {
    if (!this.localSpectatorMode) {
      return;
    }
    this.appendChatLine(
      "시스템",
      "관전자 조작: V 생존자 전환, C 1인칭/3인칭 전환, X 관전 해제(자유 관전)",
      "system"
    );
    if (this.isLocalHost() && this.serverHostSpectator) {
      this.appendChatLine(
        "SYSTEM",
        "Host-only: press Z to fully release host spectator mode.",
        "system"
      );
    }
  }

  clearSpectatorFollowTarget(announce = true) {
    const hadTarget = Boolean(this.spectatorFollowId);
    this.spectatorFollowId = null;
    this.spectatorFollowIndex = -1;
    this.spectatorViewMode = "third";
    if (announce && hadTarget) {
      this.appendChatLine("시스템", "관전 해제: 자유 관전 모드로 전환합니다.", "system");
    }
    return hadTarget;
  }

  toggleSpectatorViewMode() {
    if (!this.localSpectatorMode) {
      return;
    }
    if (!this.spectatorFollowId) {
      this.appendChatLine(
        "시스템",
        "시점 전환은 생존자 추적 중에만 가능합니다. 먼저 V로 대상을 선택하세요.",
        "system"
      );
      return;
    }
    this.spectatorViewMode = this.spectatorViewMode === "first" ? "third" : "first";
    const viewLabel = this.spectatorViewMode === "first" ? "1인칭" : "3인칭";
    this.appendChatLine("시스템", `관전 시점을 ${viewLabel}으로 전환했습니다.`, "system");
  }

  toggleHostSpectatorModeOverride() {
    if (!this.isLocalHost()) {
      this.appendChatLine("SYSTEM", "Host only.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("SYSTEM", "Network connection is required.", "system");
      return;
    }

    const nextParticipating = !this.hostSpectatorOverride;
    this.socket.emit(
      "host:set-participating",
      { participating: nextParticipating },
      (response = {}) => {
        if (!response?.ok) {
          this.appendChatLine(
            "SYSTEM",
            `Host spectator toggle failed: ${this.translateQuizError(response?.error)}`,
            "system"
          );
          return;
        }

        const participating = response?.participating === true;
        this.hostSpectatorOverride = participating;
        this.serverHostSpectator = response?.spectator === true;

        if (participating) {
          this.localSpectatorMode = false;
          this.localEliminationDrop.active = false;
          this.localEliminationDrop.elapsed = 0;
          this.localEliminationDrop.velocityY = 0;
          this.spectatorViewMode = "third";
          this.spectatorFollowId = null;
          this.spectatorFollowIndex = -1;
          this.verticalVelocity = 0;
          this.playerPosition.y = GAME_CONSTANTS.PLAYER_HEIGHT;
          this.onGround = true;
          this.lastSafePosition.set(
            this.playerPosition.x,
            GAME_CONSTANTS.PLAYER_HEIGHT,
            this.playerPosition.z
          );
          this.appendChatLine(
            "SYSTEM",
            "Host spectator mode fully released. Press Z again to restore.",
            "system"
          );
          this.emitImmediateLocalSync("host-spectator-release");
          return;
        }

        this.appendChatLine("SYSTEM", "Host spectator mode restored.", "system");
        if (this.quizState.active && this.serverHostSpectator) {
          this.enterHostSpectatorMode();
        }
      }
    );
  }

  cycleSpectatorTarget() {
    if (!this.localSpectatorMode) {
      return;
    }
    const candidates = Array.from(this.remotePlayers.entries()).filter(
      ([, remote]) => Boolean(remote?.alive)
    );
    if (candidates.length === 0) {
      this.clearSpectatorFollowTarget(false);
      this.appendChatLine("시스템", "관전할 생존자가 없습니다.", "system");
      return;
    }

    const currentIndex = candidates.findIndex(([id]) => id === this.spectatorFollowId);
    if (currentIndex < 0) {
      this.spectatorFollowIndex = 0;
      this.spectatorFollowId = candidates[0][0];
    } else {
      const nextIndex = currentIndex + 1;
      if (nextIndex >= candidates.length) {
        this.clearSpectatorFollowTarget(false);
        this.appendChatLine("시스템", "자유 관전 모드로 전환합니다.", "system");
        return;
      }
      this.spectatorFollowIndex = nextIndex;
      this.spectatorFollowId = candidates[nextIndex][0];
    }

    const target = this.remotePlayers.get(this.spectatorFollowId);
    const targetName = this.formatPlayerName(target?.name);
    this.showSpectatorControlHint();
    this.appendChatLine("시스템", `${targetName} 관전 중`, "system");
  }

  enforceSpectatorArenaGuard() {
    if (!this.localSpectatorMode) {
      return false;
    }
    const guard = this.spectatorArenaGuard;
    if (!guard?.enabled) {
      return false;
    }

    const x = Number(this.playerPosition.x) || 0;
    const z = Number(this.playerPosition.z) || 0;
    if (x < guard.minX || x > guard.maxX || z < guard.minZ || z > guard.maxZ) {
      return false;
    }

    const distanceLeft = Math.abs(x - guard.minX);
    const distanceRight = Math.abs(guard.maxX - x);
    const distanceBack = Math.abs(z - guard.minZ);
    const distanceFront = Math.abs(guard.maxZ - z);
    const minDistance = Math.min(distanceLeft, distanceRight, distanceBack, distanceFront);
    const pad = Number(guard.exitPadding) || 1.4;

    if (minDistance === distanceLeft) {
      this.playerPosition.x = guard.minX - pad;
    } else if (minDistance === distanceRight) {
      this.playerPosition.x = guard.maxX + pad;
    } else if (minDistance === distanceBack) {
      this.playerPosition.z = guard.minZ - pad;
    } else {
      this.playerPosition.z = guard.maxZ + pad;
    }
    return true;
  }

  updateLocalEliminationDrop(delta) {
    if (!this.localEliminationDrop.active) {
      return false;
    }
    this.localEliminationDrop.elapsed += delta;
    this.localEliminationDrop.velocityY += GAME_CONSTANTS.PLAYER_GRAVITY * 1.35 * delta;
    this.playerPosition.y += this.localEliminationDrop.velocityY * delta;
    if (this.playerPosition.y <= -18 || this.localEliminationDrop.elapsed >= 3.4) {
      this.finishLocalEliminationDrop();
    }
    this.camera.position.copy(this.playerPosition);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    return true;
  }

  updateSpectatorMovement(delta) {
    if (!this.localSpectatorMode) {
      return false;
    }
    if (this.spectatorFollowId) {
      const target = this.remotePlayers.get(this.spectatorFollowId);
      if (target?.alive) {
        const followPos = target.mesh.position;
        const targetYaw = Number(target.mesh?.rotation?.y);
        const followYaw = Number.isFinite(targetYaw)
          ? targetYaw
          : this.getLookYaw(this.playerPosition, followPos);
        const sinYaw = Math.sin(followYaw);
        const cosYaw = Math.cos(followYaw);
        const alpha = THREE.MathUtils.clamp(1 - Math.exp(-8 * delta), 0, 1);
        if (this.spectatorViewMode === "first") {
          const eyeDistance = 0.26;
          const eyeHeight = GAME_CONSTANTS.PLAYER_HEIGHT * 0.94;
          this.tempVecA.set(
            followPos.x - sinYaw * eyeDistance,
            followPos.y + eyeHeight,
            followPos.z - cosYaw * eyeDistance
          );
          this.playerPosition.lerp(this.tempVecA, alpha);
          const worldLimit = this.getBoundaryHardLimit();
          this.playerPosition.x = THREE.MathUtils.clamp(this.playerPosition.x, -worldLimit, worldLimit);
          this.playerPosition.z = THREE.MathUtils.clamp(this.playerPosition.z, -worldLimit, worldLimit);
          this.yaw = lerpAngle(this.yaw, followYaw, alpha);
          this.pitch = THREE.MathUtils.lerp(this.pitch, -0.02, alpha);
          this.camera.position.copy(this.playerPosition);
          this.camera.rotation.y = this.yaw;
          this.camera.rotation.x = this.pitch;
          return true;
        }

        const offset = this.spectatorFollowOffset;
        this.tempVecA.set(
          followPos.x + sinYaw * offset.z,
          followPos.y + offset.y,
          followPos.z + cosYaw * offset.z
        );
        this.playerPosition.lerp(this.tempVecA, alpha);
        const worldLimit = this.getBoundaryHardLimit();
        this.playerPosition.x = THREE.MathUtils.clamp(this.playerPosition.x, -worldLimit, worldLimit);
        this.playerPosition.z = THREE.MathUtils.clamp(this.playerPosition.z, -worldLimit, worldLimit);
        const lookYaw = this.getLookYaw(this.playerPosition, followPos);
        this.yaw = lerpAngle(this.yaw, lookYaw, alpha);
        this.pitch = THREE.MathUtils.lerp(this.pitch, -0.18, alpha);
        this.camera.position.copy(this.playerPosition);
        this.camera.rotation.y = this.yaw;
        this.camera.rotation.x = this.pitch;
        return true;
      }
      this.clearSpectatorFollowTarget(true);
    }

    const keyboardForward =
      (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) -
      (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0);
    const keyboardStrafe =
      (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) -
      (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);
    const mobileForward = this.mobileEnabled ? -this.mobileMoveVectorY : 0;
    const mobileStrafe = this.mobileEnabled ? this.mobileMoveVectorX : 0;
    const keyForward = THREE.MathUtils.clamp(keyboardForward + mobileForward, -1, 1);
    const keyStrafe = THREE.MathUtils.clamp(keyboardStrafe + mobileStrafe, -1, 1);

    const sprinting = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const speed = (sprinting ? GAME_CONSTANTS.PLAYER_SPRINT : GAME_CONSTANTS.PLAYER_SPEED) * 1.25;

    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    if (keyForward !== 0 || keyStrafe !== 0) {
      this.moveForwardVec.set(-sinYaw, 0, -cosYaw);
      this.moveRightVec.set(cosYaw, 0, -sinYaw);
      this.moveVec
        .set(0, 0, 0)
        .addScaledVector(this.moveForwardVec, keyForward)
        .addScaledVector(this.moveRightVec, keyStrafe);
      const inputMagnitude = Math.min(1, this.moveVec.length());
      if (this.moveVec.lengthSq() > 0.0001) {
        this.moveVec.normalize();
      }
      const moveStep = speed * delta * inputMagnitude;
      this.playerPosition.x += this.moveVec.x * moveStep;
      this.playerPosition.z += this.moveVec.z * moveStep;
    }

    if (this.keys.has("Space") && this.onGround) {
      this.verticalVelocity = GAME_CONSTANTS.JUMP_FORCE;
      this.onGround = false;
    }
    this.verticalVelocity += GAME_CONSTANTS.PLAYER_GRAVITY * delta;
    this.playerPosition.y += this.verticalVelocity * delta;
    if (this.playerPosition.y <= GAME_CONSTANTS.PLAYER_HEIGHT) {
      this.playerPosition.y = GAME_CONSTANTS.PLAYER_HEIGHT;
      this.verticalVelocity = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    const worldLimit = this.getBoundaryHardLimit();
    this.playerPosition.x = THREE.MathUtils.clamp(this.playerPosition.x, -worldLimit, worldLimit);
    this.playerPosition.z = THREE.MathUtils.clamp(this.playerPosition.z, -worldLimit, worldLimit);
    this.enforceSpectatorArenaGuard();
    this.lastSafePosition.set(this.playerPosition.x, GAME_CONSTANTS.PLAYER_HEIGHT, this.playerPosition.z);

    this.camera.position.copy(this.playerPosition);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    return true;
  }

  updateHubFlow(delta) {
    if (!this.hubFlowEnabled) {
      return;
    }

    this.portalPulseClock += delta;
    this.updateBridgeBoundaryMarker(delta);

    if (this.flowStage === "bridge_approach") {
      const half = Math.max(1.8, this.bridgeWidth * 0.5 - 0.72);
      this.playerPosition.x = THREE.MathUtils.clamp(
        this.playerPosition.x,
        this.bridgeSpawn.x - half,
        this.bridgeSpawn.x + half
      );
      const npcDistance = this.getNpcDistance();
      this.setFlowHeadline(
        "다리 입구",
        `검문소 안내원까지 ${Math.max(0, Math.ceil(npcDistance))}m`
      );
      this.updatePortalVisual();
      if (npcDistance <= this.bridgeNpcTriggerRadius) {
        this.flowStage = "bridge_dialogue";
        this.keys.clear();
        this.chalkDrawingActive = false;
        this.chalkLastStamp = null;
        if (document.pointerLockElement === this.renderer.domElement) {
          document.exitPointerLock?.();
        }
        this.playNpcGreeting();
        this.setFlowHeadline("검문소 안내", "안내원 인사말 수신 중...");
        this.hud.setStatus(this.getStatusText());
      }
      return;
    }

    if (this.flowStage === "bridge_dialogue") {
      this.updatePortalVisual();
      return;
    }

    if (this.flowStage === "bridge_name") {
      this.updatePortalVisual();
      return;
    }

    if (this.flowStage === "bridge_mirror") {
      const half = Math.max(1.8, this.bridgeWidth * 0.5 - 0.72);
      this.playerPosition.x = THREE.MathUtils.clamp(
        this.playerPosition.x,
        this.bridgeSpawn.x - half,
        this.bridgeSpawn.x + half
      );
      const focus = this.evaluateGateFocus();
      if (focus > 0.35) {
        this.mirrorLookClock = Math.min(
          this.bridgeMirrorLookSeconds,
          this.mirrorLookClock + delta * focus
        );
      } else {
        this.mirrorLookClock = Math.max(0, this.mirrorLookClock - delta * 0.7);
      }
      const progress = THREE.MathUtils.clamp(
        this.mirrorLookClock / this.bridgeMirrorLookSeconds,
        0,
        1
      );
      this.setFlowHeadline(
        "입구 확인",
        `입구 동기화 진행률 ${Math.round(progress * 100)}%`
      );
      this.updatePortalVisual();
      if (progress >= 1) {
        this.cityIntroStart.copy(this.playerPosition);
        this.cityIntroEnd.copy(this.citySpawn);
        this.flowStage = "city_intro";
        this.flowClock = 0;
        this.bridgeBoundaryDingTriggered = false;
        this.bridgeBoundaryDingClock = 0;
        this.keys.clear();
        this.setMirrorGateVisible(false);
        if (document.pointerLockElement === this.renderer.domElement) {
          document.exitPointerLock?.();
        }
        this.setFlowHeadline("이동 시퀀스", "도시 게이트를 여는 중...");
        this.hud.setStatus(this.getStatusText());
      }
      return;
    }

    if (this.flowStage === "city_intro") {
      this.flowClock += delta;
      const alpha = THREE.MathUtils.clamp(this.flowClock / this.hubIntroDuration, 0, 1);
      this.playerPosition.lerpVectors(this.cityIntroStart, this.cityIntroEnd, alpha);
      const secondsLeft = Math.max(0, Math.ceil(this.hubIntroDuration - this.flowClock));
      this.setFlowHeadline("이동 시퀀스", `${secondsLeft}초 후 도시 게이트 개방`);
      if (!this.bridgeBoundaryDingTriggered) {
        const dx = this.playerPosition.x - this.bridgeCityEntry.x;
        const dz = this.playerPosition.z - this.bridgeCityEntry.z;
        if (dx * dx + dz * dz <= this.bridgeBoundaryRadius * this.bridgeBoundaryRadius) {
          this.triggerBridgeBoundaryDing();
        }
      }
      this.updatePortalVisual();
      if (alpha >= 1) {
        this.flowStage = "city_live";
        this.flowClock = 0;
        this.playerPosition.copy(this.citySpawn);
        this.lastSafePosition.copy(this.playerPosition);
        this.yaw = this.getLookYaw(this.citySpawn, this.portalFloorPosition);
        this.pitch = -0.02;
        this.hud.setStatus(this.getStatusText());
        this.syncGameplayUiForFlow();
      }
      return;
    }

    if (this.flowStage !== "city_live") {
      return;
    }

    this.updatePortalPhase(delta);
    this.updatePortalVisual();
    if (this.portalPhase === "open" && !this.portalTransitioning && this.isPlayerInPortalZone()) {
      this.triggerPortalTransfer();
    }
  }

  updatePortalPhase(delta) {
    if (this.portalAlwaysOpen) {
      this.portalPhase = "open";
      if (this.portalTargetUrl) {
        this.setFlowHeadline("포탈 가동", "항상 활성화됨: 즉시 진입 가능합니다.");
      } else {
        this.setFlowHeadline("포탈 가동 / 대상 없음", "포탈 링크를 설정해야 이동할 수 있습니다.");
      }
      return;
    }

    this.portalPhaseClock = Math.max(0, this.portalPhaseClock - delta);
    if (this.portalPhase === "cooldown") {
      this.setFlowHeadline("도시 운영 중", `다음 포탈 이벤트까지 ${Math.ceil(this.portalPhaseClock)}초`);
      if (this.portalPhaseClock <= 0) {
        this.portalPhase = "warning";
        this.portalPhaseClock = this.portalWarningSeconds;
      }
      return;
    }

    if (this.portalPhase === "warning") {
      this.setFlowHeadline("이상 징후 감지", `${Math.ceil(this.portalPhaseClock)}초 후 포탈 개방`);
      if (this.portalPhaseClock <= 0) {
        this.portalPhase = "open";
        this.portalPhaseClock = this.portalOpenSeconds;
      }
      return;
    }

    if (this.portalPhase === "open") {
      if (this.portalTargetUrl) {
        this.setFlowHeadline(
          "포탈 개방",
          `지금 게이트에 진입하세요 (남은 시간 ${Math.ceil(this.portalPhaseClock)}초)`
        );
      } else {
        this.setFlowHeadline(
          "포탈 개방 / 대상 없음",
          "방장이 포탈 링크를 설정해야 이동할 수 있습니다."
        );
      }
      if (this.portalPhaseClock <= 0) {
        this.portalPhase = "cooldown";
        this.portalPhaseClock = this.portalCooldownSeconds;
      }
    }
  }

  updateLobbyPortal(delta) {
    if (this.hubFlowEnabled) {
      return;
    }
    this.portalPulseClock += delta;
    const activeTargetUrl = this.resolveActivePortalTargetUrl(
      this.portalTargetUrl,
      this.portalConfiguredTargetUrl
    );
    const portalLinked =
      Boolean(activeTargetUrl) &&
      (this.portalAlwaysOpen === true ||
        this.entryGateState?.portalOpen === true ||
        this.isLobbyReturnPortalTarget(activeTargetUrl));
    this.portalPhase = portalLinked ? "open" : "idle";
    this.updatePortalVisual();
    if (portalLinked && !this.portalTransitioning && this.isPlayerInPortalZone()) {
      this.triggerPortalTransfer();
    }
  }

  getPortalFrontSpawnPoint() {
    const portalX = Number(this.portalFloorPosition?.x) || 0;
    const portalZ = Number(this.portalFloorPosition?.z) || 0;
    const spawnOffset = Math.max(2.6, (Number(this.portalRadius) || 4.4) + 1.2);
    return new THREE.Vector3(portalX, GAME_CONSTANTS.PLAYER_HEIGHT, portalZ - spawnOffset);
  }

  updatePortalVisual() {
    if (!this.portalRing || !this.portalCore || !this.portalGroup) {
      return;
    }

    const ringMaterial = this.portalRing.material;
    const coreMaterial = this.portalCore.material;
    if (!ringMaterial || !coreMaterial) {
      return;
    }

    const pulse = 0.5 + 0.5 * Math.sin(this.portalPulseClock * 6.4);
    if (this.portalPhase === "open") {
      ringMaterial.emissiveIntensity = 0.9 + pulse * 0.85;
      ringMaterial.opacity = 0.9;
      coreMaterial.opacity = 0.3 + pulse * 0.34;
      this.portalGroup.scale.set(1 + pulse * 0.05, 1 + pulse * 0.05, 1 + pulse * 0.05);
      return;
    }

    if (this.portalPhase === "warning") {
      ringMaterial.emissiveIntensity = 0.42 + pulse * 0.48;
      ringMaterial.opacity = 0.78;
      coreMaterial.opacity = 0.12 + pulse * 0.16;
      this.portalGroup.scale.set(1, 1, 1);
      return;
    }

    ringMaterial.emissiveIntensity = 0.14;
    ringMaterial.opacity = 0.46;
    coreMaterial.opacity = 0.08;
    this.portalGroup.scale.set(0.98, 0.98, 0.98);
  }

  isPlayerInPortalZone() {
    const dx = this.playerPosition.x - this.portalFloorPosition.x;
    const dz = this.playerPosition.z - this.portalFloorPosition.z;
    const distanceSquared = dx * dx + dz * dz;
    const triggerRadius = this.portalRadius * 0.78;
    return distanceSquared <= triggerRadius * triggerRadius;
  }

  setPortalTransition(active, text = "") {
    if (this.portalTransitionTextEl && text) {
      this.portalTransitionTextEl.textContent = String(text);
    }
    this.portalTransitionEl?.classList.toggle("on", Boolean(active));
  }

  setBoundaryWarning(active, text = "") {
    if (!this.boundaryWarningEl) {
      return;
    }
    if (text) {
      this.boundaryWarningEl.textContent = String(text);
    }
    this.boundaryWarningEl.classList.toggle("on", Boolean(active));
  }

  getBoundarySoftLimit() {
    return Math.max(4, Number(this.playerBoundsHalfExtent) || GAME_CONSTANTS.WORLD_LIMIT);
  }

  getBoundaryHardLimit() {
    return this.getBoundarySoftLimit() + this.boundaryHardLimitPadding;
  }

  canUseBoundaryGuard() {
    if (this.portalTransitioning) {
      return false;
    }
    if (!this.canMovePlayer()) {
      return false;
    }
    if (!this.hubFlowEnabled) {
      return true;
    }
    return this.flowStage !== "city_intro" && this.flowStage !== "portal_transfer";
  }

  updateBoundaryGuard(delta) {
    if (!this.canUseBoundaryGuard()) {
      this.boundaryOutClock = 0;
      if (this.boundaryNoticeClock > 0) {
        this.boundaryNoticeClock = Math.max(0, this.boundaryNoticeClock - delta);
        if (this.boundaryNoticeClock <= 0) {
          this.setBoundaryWarning(false);
        }
      } else {
        this.setBoundaryWarning(false);
      }
      return;
    }

    const softLimit = this.getBoundarySoftLimit();
    const outsideBounds =
      Math.abs(this.playerPosition.x) > softLimit || Math.abs(this.playerPosition.z) > softLimit;

    if (!outsideBounds) {
      this.lastSafePosition.copy(this.playerPosition);
      this.boundaryOutClock = 0;
      if (this.boundaryNoticeClock > 0) {
        this.boundaryNoticeClock = Math.max(0, this.boundaryNoticeClock - delta);
        if (this.boundaryNoticeClock <= 0) {
          this.setBoundaryWarning(false);
        }
      } else {
        this.setBoundaryWarning(false);
      }
      return;
    }

    this.boundaryOutClock += delta;
    const secondsLeft = Math.max(0, Math.ceil(this.boundaryReturnDelaySeconds - this.boundaryOutClock));
    this.setBoundaryWarning(
      true,
      `맵 경계를 벗어나셨습니다. ${secondsLeft}초 후 안전 지점으로 복귀합니다.`
    );

    if (this.boundaryOutClock < this.boundaryReturnDelaySeconds) {
      return;
    }

    if (this.lastSafePosition.lengthSq() <= 0.0001) {
      this.lastSafePosition.set(0, GAME_CONSTANTS.PLAYER_HEIGHT, 0);
    }
    this.playerPosition.copy(this.lastSafePosition);
    this.playerPosition.y = GAME_CONSTANTS.PLAYER_HEIGHT;
    this.verticalVelocity = 0;
    this.onGround = true;
    this.keys.clear();
    this.boundaryOutClock = 0;
    this.boundaryNoticeClock = this.boundaryReturnNoticeSeconds;
    this.setBoundaryWarning(true, "맵 경계를 벗어나셨습니다. 안전 지점으로 복귀했습니다.");
  }

  normalizePortalTargetUrl(rawTarget = "") {
    const text = String(rawTarget ?? "").trim();
    if (!text) {
      return null;
    }
    try {
      const target = new URL(text, window.location.href);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return null;
      }
      const zoneHint = this.normalizePortalZoneHint(
        target.searchParams.get("zone") ?? target.searchParams.get("z") ?? "",
        ""
      );
      const pathname = String(target.pathname ?? "").trim();
      if (zoneHint && (!pathname || pathname === "/")) {
        target.pathname = "/";
        target.search = "";
        target.hash = "";
        target.searchParams.set("zone", zoneHint);
      }
      return target.toString();
    } catch {
      return null;
    }
  }

  normalizePortalZoneHint(rawValue, fallback = "") {
    const value = String(rawValue ?? "")
      .trim()
      .toLowerCase();
    if (value === "lobby" || value === "fps" || value === "ox") {
      return value;
    }
    if (value.startsWith("lobby")) {
      return "lobby";
    }
    if (value.startsWith("fps")) {
      return "fps";
    }
    if (value.startsWith("ox")) {
      return "ox";
    }
    const fallbackValue = String(fallback ?? "")
      .trim()
      .toLowerCase();
    if (fallbackValue === "lobby" || fallbackValue === "fps" || fallbackValue === "ox") {
      return fallbackValue;
    }
    return "";
  }

  getPortalReturnMarker(params = this.queryParams) {
    if (!params || typeof params.get !== "function") {
      return "";
    }
    return String(params.get("returnPortal") ?? params.get("portalReturn") ?? "")
      .trim()
      .toLowerCase();
  }

  getPortalLocationSignature(rawTarget = "") {
    const normalized = this.normalizePortalTargetUrl(rawTarget);
    if (!normalized) {
      return null;
    }
    try {
      const target = new URL(normalized, window.location.href);
      const zone = String(target.searchParams.get("zone") ?? target.searchParams.get("z") ?? "")
        .trim()
        .toLowerCase();
      const room = String(target.searchParams.get("room") ?? target.searchParams.get("code") ?? "")
        .trim()
        .toUpperCase();
      return `${target.origin}${target.pathname}|${zone}|${room}|${target.hash}`;
    } catch {
      return null;
    }
  }

  isSelfPortalTargetUrl(targetUrl = "") {
    if (typeof window === "undefined") {
      return false;
    }
    const currentSignature = this.getPortalLocationSignature(window.location.href);
    const targetSignature = this.getPortalLocationSignature(targetUrl);
    if (!currentSignature || !targetSignature) {
      return false;
    }
    return currentSignature === targetSignature;
  }

  resolveConfiguredPortalTargetUrl(defaultTarget = "") {
    const globalTarget = this.normalizePortalTargetUrl(window.__EMPTINES_PORTAL_TARGET ?? "");
    if (globalTarget && !this.isSelfPortalTargetUrl(globalTarget)) {
      return globalTarget;
    }

    const configuredTarget = this.normalizePortalTargetUrl(defaultTarget ?? "");
    if (configuredTarget && !this.isSelfPortalTargetUrl(configuredTarget)) {
      return configuredTarget;
    }

    return null;
  }

  resolveActivePortalTargetUrl(targetUrl = "", fallbackTarget = this.portalConfiguredTargetUrl) {
    const rawText = String(targetUrl ?? "").trim();
    if (!rawText) {
      return null;
    }

    const normalized = this.normalizePortalTargetUrl(rawText);
    if (normalized && !this.isSelfPortalTargetUrl(normalized)) {
      return normalized;
    }

    const fallback = this.normalizePortalTargetUrl(fallbackTarget ?? "");
    if (fallback && !this.isSelfPortalTargetUrl(fallback)) {
      return fallback;
    }

    return null;
  }

  resolvePortalTargetUrl(defaultTarget = "") {
    const queryTarget = this.normalizePortalTargetUrl(
      this.queryParams.get("portal") ?? this.queryParams.get("next") ?? ""
    );
    if (queryTarget && !this.isSelfPortalTargetUrl(queryTarget)) {
      return queryTarget;
    }

    const configuredTarget = this.resolveConfiguredPortalTargetUrl(defaultTarget);
    if (this.getPortalReturnMarker() === "ox" && configuredTarget) {
      return configuredTarget;
    }

    const queryReturnTarget = this.normalizePortalTargetUrl(
      this.queryParams.get("returnUrl") ?? this.queryParams.get("return") ?? ""
    );
    // Ignore nested return URLs that resolve back to the same OX view.
    if (queryReturnTarget && !this.isSelfPortalTargetUrl(queryReturnTarget)) {
      return queryReturnTarget;
    }

    return configuredTarget;
  }

  extractOwnerAccessKeyFromRawUrl(rawUrl = "") {
    const text = String(rawUrl ?? "").trim();
    if (!text || typeof window === "undefined") {
      return "";
    }
    try {
      const parsed = new URL(text, window.location.href);
      return String(
        parsed.searchParams.get("owner") ??
          parsed.searchParams.get("owner_key") ??
          parsed.searchParams.get("hostKey") ??
          parsed.searchParams.get("host_key") ??
          ""
      ).trim();
    } catch {
      return "";
    }
  }

  readOwnerAccessKeyFromParams(params = this.queryParams) {
    if (!params || typeof params.get !== "function") {
      return "";
    }
    const directKey = String(
      params.get("owner") ??
        params.get("owner_key") ??
        params.get("hostKey") ??
        params.get("host_key") ??
        ""
    ).trim();
    if (directKey) {
      return directKey;
    }

    const nestedCandidates = [
      params.get("returnUrl"),
      params.get("return"),
      params.get("portal"),
      params.get("next")
    ];
    for (const candidate of nestedCandidates) {
      const nestedKey = this.extractOwnerAccessKeyFromRawUrl(candidate);
      if (nestedKey) {
        return nestedKey;
      }
    }
    return "";
  }

  loadPersistedOwnerAccessKey() {
    if (typeof window === "undefined") {
      return "";
    }
    try {
      return String(window.sessionStorage?.getItem?.(OWNER_ACCESS_STORAGE_KEY) ?? "").trim();
    } catch {
      return "";
    }
  }

  persistOwnerAccessKey(ownerKeyRaw = "") {
    if (typeof window === "undefined") {
      return;
    }
    const ownerKey = String(ownerKeyRaw ?? "").trim();
    try {
      if (ownerKey) {
        window.sessionStorage?.setItem?.(OWNER_ACCESS_STORAGE_KEY, ownerKey);
      } else {
        window.sessionStorage?.removeItem?.(OWNER_ACCESS_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures (private mode, blocked storage).
    }
  }

  resolveOwnerAccessKey() {
    const ownerKeyFromQuery = this.readOwnerAccessKeyFromParams(this.queryParams);
    if (ownerKeyFromQuery) {
      this.persistOwnerAccessKey(ownerKeyFromQuery);
      return ownerKeyFromQuery;
    }
    return this.loadPersistedOwnerAccessKey();
  }

  applyOwnerAccessToSearchParams(searchParams) {
    if (!searchParams || typeof searchParams.set !== "function") {
      return;
    }
    const hostFlagRaw = String(
      this.queryParams?.get?.("host") ?? this.queryParams?.get?.("isHost") ?? ""
    )
      .trim()
      .toLowerCase();
    const hostFlagEnabled = hostFlagRaw === "1" || hostFlagRaw === "true" || hostFlagRaw === "yes";
    const ownerKey = String(this.ownerAccessKey ?? "").trim();
    if (!hostFlagEnabled && !ownerKey) {
      return;
    }
    searchParams.set("host", "1");
    if (ownerKey) {
      searchParams.set("hostKey", ownerKey);
    }
  }

  buildPortalTransferUrl() {
    const activeTargetUrl = this.resolveActivePortalTargetUrl(
      this.portalTargetUrl,
      this.portalConfiguredTargetUrl
    );
    if (!activeTargetUrl) {
      return null;
    }

    let target;
    try {
      target = new URL(activeTargetUrl, window.location.href);
    } catch {
      return null;
    }

    target.searchParams.set("returnPortal", "ox");
    target.searchParams.set("from", "ox");
    target.searchParams.set("name", this.localPlayerName);
    this.applyOwnerAccessToSearchParams(target.searchParams);
    if (this.socketEndpoint) {
      target.searchParams.set("server", this.socketEndpoint);
    }
    return target.toString();
  }

  isLobbyReturnPortalTarget(targetUrl = this.portalTargetUrl) {
    const activeTargetUrl = this.resolveActivePortalTargetUrl(
      targetUrl,
      this.portalConfiguredTargetUrl
    );
    if (!activeTargetUrl) {
      return false;
    }
    try {
      const parsed = new URL(activeTargetUrl, window.location.href);
      const zone = String(parsed.searchParams.get("zone") ?? parsed.searchParams.get("z") ?? "")
        .trim()
        .toLowerCase();
      return zone === "lobby";
    } catch {
      return false;
    }
  }

  isPortalTransferAllowed() {
    const activeTargetUrl = this.resolveActivePortalTargetUrl(
      this.portalTargetUrl,
      this.portalConfiguredTargetUrl
    );
    if (!activeTargetUrl) {
      return false;
    }
    if (this.portalAlwaysOpen) {
      return true;
    }
    if (this.hubFlowEnabled) {
      return this.portalPhase === "open";
    }
    if (this.isLobbyReturnPortalTarget(activeTargetUrl)) {
      return true;
    }
    return this.entryGateState?.portalOpen === true;
  }

  triggerPortalTransfer() {
    if (this.portalTransitioning) {
      return;
    }
    if (!this.isPortalTransferAllowed()) {
      this.appendChatLine("SYSTEM", "Portal is closed. Wait for host to open it.", "system");
      return;
    }

    const destination = this.buildPortalTransferUrl();
    if (!destination) {
      this.portalPhase = "cooldown";
      this.portalPhaseClock = this.portalCooldownSeconds;
      this.setFlowHeadline(
        "포탈 링크 누락",
        "방장이 유효한 포탈 링크를 설정한 뒤 다시 시도하세요."
      );
      return;
    }

    this.portalTransitioning = true;
    this.flowStage = "portal_transfer";
    this.hud.setStatus(this.getStatusText());
    this.syncGameplayUiForFlow();
    this.setPortalTransition(true, "포탈 연결 중...");

    const redirectToPortal = () => {
      window.location.assign(destination);
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(redirectToPortal);
      });
    } else {
      window.setTimeout(redirectToPortal, 0);
    }
  }

  syncPlayerNameIfConnected() {
    const nextName = this.formatPlayerName(this.localPlayerName);
    this.localPlayerName = nextName;
    if (this.lobbyEnabled && !this.lobbyNameConfirmed) {
      this.pendingPlayerNameSync = true;
      return;
    }

    if (!this.socket || !this.networkConnected) {
      this.pendingPlayerNameSync = true;
      return;
    }

    if (this.redirectInFlight || this.lobbyJoinInFlight) {
      return;
    }

    if (this.lobbyEnabled) {
      this.lobbyJoinInFlight = true;
      if (this.lobbyJoinBtnEl) {
        this.lobbyJoinBtnEl.disabled = true;
      }
      this.setLobbyStatus("매칭 요청을 전송하는 중...");
    }

    const joinPayload = { name: nextName };
    const preferredRoomCode = this.getPreferredRoomCodeForJoin();
    if (preferredRoomCode) {
      joinPayload.roomCode = preferredRoomCode;
    }
    if (this.ownerAccessEnabled) {
      joinPayload.ownerKey = this.ownerAccessKey;
    }

    const joinRequestSeq = this.lobbyEnabled ? this.lobbyJoinRequestSeq + 1 : 0;
    if (this.lobbyEnabled) {
      this.lobbyJoinRequestSeq = joinRequestSeq;
    }

    let resolved = false;
    const finishJoinRequest = () => {
      if (resolved) {
        return false;
      }
      if (this.lobbyEnabled && this.lobbyJoinRequestSeq !== joinRequestSeq) {
        return false;
      }
      resolved = true;
      if (this.lobbyEnabled) {
        this.lobbyJoinInFlight = false;
        if (this.lobbyJoinBtnEl) {
          this.lobbyJoinBtnEl.disabled = false;
        }
      }
      return true;
    };

    const joinAckTimeout = this.lobbyEnabled
      ? window.setTimeout(() => {
          if (!finishJoinRequest()) {
            return;
          }
          this.pendingPlayerNameSync = true;
          if (this.lobbyJoinAutoRetryRemaining > 0 && this.networkConnected) {
            this.lobbyJoinAutoRetryRemaining -= 1;
            this.setLobbyStatus("Join response delayed. Retrying automatically...");
            window.setTimeout(() => {
              if (this.pendingPlayerNameSync && !this.redirectInFlight) {
                this.syncPlayerNameIfConnected();
              }
            }, LOBBY_JOIN_AUTO_RETRY_DELAY_MS);
            return;
          }
          this.setLobbyStatus("Join response delayed. Please press Join again.", true);
        }, LOBBY_JOIN_ACK_TIMEOUT_MS)
      : null;

    this.socket.emit("room:quick-join", joinPayload, (response = {}) => {
      if (joinAckTimeout !== null) {
        window.clearTimeout(joinAckTimeout);
      }
      if (!finishJoinRequest()) {
        return;
      }
      if (!response?.ok) {
        if (this.lobbyEnabled) {
          this.lobbyJoinAutoRetryRemaining = 0;
          const message = this.translateQuizError(response?.error || "입장 실패");
          this.setLobbyStatus(`입장 실패: ${message}`, true);
        }
        return;
      }
      this.lobbyJoinAutoRetryRemaining = 0;

      if (response?.redirect) {
        if (this.lobbyEnabled) {
          this.setLobbyStatus("매치 서버로 이동 중...");
        }
        this.applyRouteRedirect(response.redirect);
      } else if (this.lobbyEnabled && this.socketRole !== "gateway") {
        this.hideLobbyScreen();
      }
    });
    this.pendingPlayerNameSync = false;
  }

  getPreferredRoomCodeForJoin() {
    const directCode = String(
      this.currentRoomCode || this.socketAuth?.roomCode || this.queryParams?.get?.("room") || ""
    )
      .trim()
      .toUpperCase();
    if (directCode) {
      return directCode;
    }
    if (typeof window === "undefined" || !window.localStorage) {
      return "";
    }
    try {
      return String(window.localStorage.getItem(LAST_ROOM_CODE_STORAGE_KEY) ?? "")
        .trim()
        .toUpperCase();
    } catch {
      return "";
    }
  }

  persistPreferredRoomCode(rawCode) {
    const roomCode = String(rawCode ?? "")
      .trim()
      .toUpperCase();
    if (!roomCode || typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      window.localStorage.setItem(LAST_ROOM_CODE_STORAGE_KEY, roomCode);
    } catch {
      // ignore storage write failures
    }
  }

  setupSky(sunDirection) {
    if (this.skyDome) {
      this.scene.remove(this.skyDome);
      disposeMeshTree(this.skyDome);
      this.skyDome = null;
    }

    const skyConfig = this.worldContent.sky;
    if (skyConfig?.textureUrl) {
      this.setupSkyTexture(skyConfig, sunDirection);
      return;
    }

    this.clearSkyTexture();
    const sky = new Sky();
    sky.scale.setScalar(skyConfig.scale);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = skyConfig.turbidity;
    uniforms.rayleigh.value = skyConfig.rayleigh;
    uniforms.mieCoefficient.value = skyConfig.mieCoefficient;
    uniforms.mieDirectionalG.value = skyConfig.mieDirectionalG;

    this.skySun.copy(sunDirection).multiplyScalar(skyConfig.scale);
    uniforms.sunPosition.value.copy(this.skySun);

    this.skyDome = sky;
    this.scene.add(this.skyDome);
  }

  setupSkyTexture(skyConfig, sunDirection) {
    this.skyTextureRequestId += 1;
    const requestId = this.skyTextureRequestId;
    this.clearSkyTexture();

    const url = String(skyConfig?.textureUrl ?? "").trim();
    if (!url) {
      this.setupSky(sunDirection);
      return;
    }

    const loader = new RGBELoader();
    loader.load(
      url,
      (hdrTexture) => {
        if (requestId !== this.skyTextureRequestId) {
          hdrTexture.dispose?.();
          return;
        }
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const envRT = pmrem.fromEquirectangular(hdrTexture);
        pmrem.dispose();
        hdrTexture.dispose?.();

        const backgroundIntensity = Number(skyConfig.textureBackgroundIntensity);
        this.skyBackgroundTexture = envRT.texture;
        this.skyEnvironmentTexture = envRT.texture;

        this.scene.background = this.skyBackgroundTexture;
        this.scene.environment = this.skyEnvironmentTexture;
        if (Number.isFinite(backgroundIntensity)) {
          this.scene.backgroundIntensity = backgroundIntensity;
        }
        this.scene.backgroundBlurriness = 0.2;
        const environmentIntensity = Number(skyConfig.textureEnvironmentIntensity);
        this.scene.environmentIntensity = Number.isFinite(environmentIntensity)
          ? environmentIntensity
          : 1;
      },
      undefined,
      () => {
        if (requestId !== this.skyTextureRequestId) {
          return;
        }
        this.clearSkyTexture();
        const sky = new Sky();
        sky.scale.setScalar(skyConfig.scale);
        const uniforms = sky.material.uniforms;
        uniforms.turbidity.value = skyConfig.turbidity;
        uniforms.rayleigh.value = skyConfig.rayleigh;
        uniforms.mieCoefficient.value = skyConfig.mieCoefficient;
        uniforms.mieDirectionalG.value = skyConfig.mieDirectionalG;
        this.skySun.copy(sunDirection).multiplyScalar(skyConfig.scale);
        uniforms.sunPosition.value.copy(this.skySun);
        this.skyDome = sky;
        this.scene.add(this.skyDome);
      }
    );
  }

  clearSkyTexture() {
    if (this.scene.background === this.skyBackgroundTexture) {
      this.scene.background = new THREE.Color(this.worldContent.skyColor);
      this.scene.backgroundIntensity = 1;
      this.scene.backgroundBlurriness = 0;
    }
    if (this.scene.environment === this.skyEnvironmentTexture) {
      this.scene.environment = null;
      this.scene.environmentIntensity = 1;
    }
    if (this.skyBackgroundTexture && this.skyBackgroundTexture === this.skyEnvironmentTexture) {
      this.skyBackgroundTexture.dispose?.();
    } else {
      this.skyBackgroundTexture?.dispose?.();
      this.skyEnvironmentTexture?.dispose?.();
    }
    this.skyBackgroundTexture = null;
    this.skyEnvironmentTexture = null;
  }

  setupCloudLayer() {
    if (this.cloudLayer) {
      this.scene.remove(this.cloudLayer);
      disposeMeshTree(this.cloudLayer);
      this.cloudLayer = null;
    }
    this.cloudParticles.length = 0;

    const cloudConfig = this.worldContent.clouds;
    if (!cloudConfig?.enabled) {
      return;
    }

    const group = new THREE.Group();
    const puffGeometry = new THREE.SphereGeometry(
      1,
      this.mobileEnabled ? 8 : 10,
      this.mobileEnabled ? 6 : 8
    );
    const puffMaterial = new THREE.MeshStandardMaterial({
      color: cloudConfig.color,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0,
      emissive: cloudConfig.emissive ?? 0x0,
      emissiveIntensity: Number(cloudConfig.emissiveIntensity) || 0,
      transparent: true,
      opacity: cloudConfig.opacity,
      depthWrite: false
    });

    const baseCount = Math.max(1, Math.trunc(cloudConfig.count));
    const mobileCountScale = Number(cloudConfig.mobileCountScale) || 0.55;
    const count = this.mobileEnabled
      ? Math.max(6, Math.round(baseCount * mobileCountScale))
      : baseCount;
    const area = Math.max(RUNTIME_TUNING.CLOUD_MIN_AREA, Number(cloudConfig.area) || 9000);
    const halfArea = area * 0.5;
    const minScale = Number(cloudConfig.minScale) || 28;
    const maxScale = Number(cloudConfig.maxScale) || 66;
    const minHeight = Number(cloudConfig.minHeight) || 120;
    const maxHeight = Number(cloudConfig.maxHeight) || 260;
    const driftMin = Number(cloudConfig.driftMin) || 0.4;
    const driftMax = Number(cloudConfig.driftMax) || 1.1;
    const minPuffs = Math.max(3, Math.trunc(Number(cloudConfig.minPuffs) || 5));
    const maxPuffs = Math.max(minPuffs, Math.trunc(Number(cloudConfig.maxPuffs) || 8));
    const puffSpread = Math.max(0.8, Number(cloudConfig.puffSpread) || 1.8);
    const puffHeightSpread = Math.max(0.04, Number(cloudConfig.puffHeightSpread) || 0.18);

    for (let i = 0; i < count; i += 1) {
      const cloud = new THREE.Group();
      const puffCount = minPuffs + Math.floor(Math.random() * (maxPuffs - minPuffs + 1));

      for (let p = 0; p < puffCount; p += 1) {
        const puff = new THREE.Mesh(puffGeometry, puffMaterial);
        const angle = (p / puffCount) * Math.PI * 2 + Math.random() * 0.7;
        const radial = (0.35 + Math.random() * 0.9) * puffSpread;
        const offsetX = Math.cos(angle) * radial + (Math.random() - 0.5) * 0.45;
        const offsetY = (Math.random() - 0.5) * puffHeightSpread;
        const offsetZ = Math.sin(angle) * radial * 0.56 + (Math.random() - 0.5) * 0.34;
        puff.position.set(offsetX, offsetY, offsetZ);
        puff.scale.set(
          0.9 + Math.random() * 0.58,
          0.34 + Math.random() * 0.22,
          0.68 + Math.random() * 0.52
        );
        cloud.add(puff);
      }

      const cloudScale = minScale + Math.random() * Math.max(1, maxScale - minScale);
      cloud.scale.set(cloudScale, cloudScale * 0.3, cloudScale * 0.82);
      cloud.rotation.y = Math.random() * Math.PI * 2;
      cloud.position.set(
        (Math.random() * 2 - 1) * halfArea,
        minHeight + Math.random() * Math.max(1, maxHeight - minHeight),
        (Math.random() * 2 - 1) * halfArea
      );

      group.add(cloud);

      const driftSpeed = driftMin + Math.random() * Math.max(0.05, driftMax - driftMin);
      const driftAngle = Math.random() * Math.PI * 2;
      this.cloudParticles.push({
        mesh: cloud,
        driftX: Math.cos(driftAngle) * driftSpeed,
        driftZ: Math.sin(driftAngle) * driftSpeed,
        halfArea
      });
    }

    this.cloudLayer = group;
    this.scene.add(this.cloudLayer);
  }

  updateCloudLayer(delta) {
    if (this.cloudParticles.length === 0) {
      return;
    }

    for (const cloud of this.cloudParticles) {
      cloud.mesh.position.x += cloud.driftX * delta;
      cloud.mesh.position.z += cloud.driftZ * delta;

      if (cloud.mesh.position.x > cloud.halfArea) {
        cloud.mesh.position.x = -cloud.halfArea;
      } else if (cloud.mesh.position.x < -cloud.halfArea) {
        cloud.mesh.position.x = cloud.halfArea;
      }

      if (cloud.mesh.position.z > cloud.halfArea) {
        cloud.mesh.position.z = -cloud.halfArea;
      } else if (cloud.mesh.position.z < -cloud.halfArea) {
        cloud.mesh.position.z = cloud.halfArea;
      }
    }
  }

  clearBoundaryWalls() {
    if (!this.boundaryGroup) {
      return;
    }
    this.scene.remove(this.boundaryGroup);
    disposeMeshTree(this.boundaryGroup);
    this.boundaryGroup = null;
  }

  setupBoundaryWalls(config = {}) {
    this.clearBoundaryWalls();
    if (!config?.enabled) {
      const groundSize = Number(this.worldContent?.ground?.size);
      const fallbackHalfExtent =
        Number.isFinite(groundSize) && groundSize > 20
          ? groundSize * 0.5 - this.playerCollisionRadius
          : GAME_CONSTANTS.WORLD_LIMIT - this.playerCollisionRadius;
      this.playerBoundsHalfExtent = Math.max(4, fallbackHalfExtent);
      return;
    }

    const halfExtent = Math.max(20, Number(config.halfExtent) || GAME_CONSTANTS.WORLD_LIMIT);
    const height = Math.max(4, Number(config.height) || 14);
    const thickness = Math.max(0.4, Number(config.thickness) || 2.2);
    this.playerBoundsHalfExtent = Math.max(4, halfExtent - thickness - this.playerCollisionRadius);
    const span = halfExtent * 2 + thickness * 2;

    const material = new THREE.MeshStandardMaterial({
      color: config.color ?? 0x6f757d,
      roughness: Number(config.roughness) || 0.82,
      metalness: Number(config.metalness) || 0.03,
      emissive: config.emissive ?? 0x20252a,
      emissiveIntensity: Number(config.emissiveIntensity) || 0.09
    });

    const wallXGeometry = new THREE.BoxGeometry(thickness, height, span);
    const wallZGeometry = new THREE.BoxGeometry(span, height, thickness);
    const group = new THREE.Group();

    const createWall = (geometry, x, y, z) => {
      const wall = new THREE.Mesh(geometry, material);
      wall.position.set(x, y, z);
      wall.castShadow = !this.mobileEnabled;
      wall.receiveShadow = true;
      wall.frustumCulled = false;
      return wall;
    };

    const y = height * 0.5;
    group.add(
      createWall(wallXGeometry, halfExtent + thickness * 0.5, y, 0),
      createWall(wallXGeometry, -halfExtent - thickness * 0.5, y, 0),
      createWall(wallZGeometry, 0, y, halfExtent + thickness * 0.5),
      createWall(wallZGeometry, 0, y, -halfExtent - thickness * 0.5)
    );

    group.renderOrder = 5;
    this.boundaryGroup = group;
    this.scene.add(this.boundaryGroup);
  }

  clearFloatingArena() {
    if (!this.floatingArenaGroup) {
      return;
    }
    this.scene.remove(this.floatingArenaGroup);
    disposeMeshTree(this.floatingArenaGroup);
    this.floatingArenaGroup = null;
  }

  setupFloatingArena(config = {}, groundConfig = {}) {
    this.clearFloatingArena();
    if (!config?.enabled) {
      return;
    }

    const boundaryHalfExtent = Number(this.worldContent?.boundary?.halfExtent);
    const groundSize = Number(groundConfig?.size);
    const fallbackRadius =
      Number.isFinite(boundaryHalfExtent) && boundaryHalfExtent > 0
        ? boundaryHalfExtent + 8
        : Number.isFinite(groundSize) && groundSize > 40
          ? groundSize * 0.62
          : 84;

    const radiusTop = Math.max(22, Number(config.radiusTop) || fallbackRadius);
    const radiusBottom = Math.max(radiusTop + 2, Number(config.radiusBottom) || radiusTop + 10);
    const thickness = Math.max(8, Number(config.thickness) || 18);
    const topOffsetY = Number.isFinite(Number(config.topOffsetY)) ? Number(config.topOffsetY) : -0.8;
    const segmentCount = this.mobileEnabled ? 20 : 34;

    const rockMaterial = new THREE.MeshStandardMaterial({
      color: config.rockColor ?? 0x4c535e,
      roughness: Number(config.rockRoughness) || 0.92,
      metalness: Number(config.rockMetalness) || 0.04,
      emissive: config.rockEmissive ?? 0x202933,
      emissiveIntensity: Number(config.rockEmissiveIntensity) || 0.1
    });

    const group = new THREE.Group();

    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(radiusTop, radiusBottom, thickness, segmentCount, 1),
      rockMaterial
    );
    slab.position.y = topOffsetY - thickness * 0.5;
    slab.castShadow = !this.mobileEnabled;
    slab.receiveShadow = true;
    slab.frustumCulled = false;
    group.add(slab);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(radiusTop * 0.96, 1.25, 14, this.mobileEnabled ? 36 : 68),
      new THREE.MeshStandardMaterial({
        color: config.rimColor ?? 0x5f6772,
        roughness: 0.82,
        metalness: 0.08,
        emissive: 0x283140,
        emissiveIntensity: 0.12
      })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = topOffsetY - 0.2;
    rim.castShadow = !this.mobileEnabled;
    rim.receiveShadow = true;
    group.add(rim);

    const shardCount = this.mobileEnabled ? 8 : 14;
    for (let index = 0; index < shardCount; index += 1) {
      const angle = (index / shardCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
      const shardHeight = thickness * (0.42 + Math.random() * 0.74);
      const shardRadius = radiusTop * (0.66 + Math.random() * 0.26);
      const shard = new THREE.Mesh(
        new THREE.ConeGeometry(
          0.9 + Math.random() * 1.5,
          shardHeight,
          this.mobileEnabled ? 6 : 8
        ),
        rockMaterial
      );
      shard.position.set(
        Math.cos(angle) * shardRadius,
        topOffsetY - thickness * 0.68 - shardHeight * 0.42,
        Math.sin(angle) * shardRadius
      );
      shard.rotation.x = (Math.random() - 0.5) * 0.36;
      shard.rotation.z = (Math.random() - 0.5) * 0.36;
      shard.castShadow = !this.mobileEnabled;
      shard.receiveShadow = true;
      group.add(shard);
    }

    this.floatingArenaGroup = group;
    this.scene.add(this.floatingArenaGroup);
  }

  clearSpectatorStands() {
    if (this.spectatorStandsGroup) {
      this.scene.remove(this.spectatorStandsGroup);
      disposeMeshTree(this.spectatorStandsGroup);
      this.spectatorStandsGroup = null;
    }
    for (const texture of this.worldDecorTextures) {
      texture?.dispose?.();
    }
    this.worldDecorTextures.length = 0;
  }

  setupSpectatorStands(config = {}, boundaryConfig = {}) {
    this.clearSpectatorStands();
    if (!config?.enabled) {
      return;
    }

    const halfExtent = Math.max(26, Number(boundaryConfig?.halfExtent) || 62);
    const boundaryThickness = Math.max(0.4, Number(boundaryConfig?.thickness) || 1.6);
    const tiers = Math.max(1, Math.min(4, Math.floor(Number(config.tiers) || 3)));
    const tierHeight = Math.max(0.8, Number(config.tierHeight) || 1.2);
    const tierGap = Math.max(0, Number(config.tierGap) || 0.18);
    const requestedTierDepth = Math.max(1.6, Number(config.tierDepth) || 3.8);
    const inset = Math.max(1.2, Number(config.inset) || 2.2);
    const maxDepthPerTier = Math.max(1.6, (halfExtent - inset - 6) / tiers);
    const tierDepth = Math.min(requestedTierDepth, maxDepthPerTier);
    const baseY = Number.isFinite(Number(config.baseY)) ? Number(config.baseY) : 0.22;

    const group = new THREE.Group();
    const standMaterial = new THREE.MeshStandardMaterial({
      color: config.color ?? 0x6a727e,
      roughness: Number(config.roughness) || 0.8,
      metalness: Number(config.metalness) || 0.06,
      emissive: config.emissive ?? 0x242d37,
      emissiveIntensity: Number(config.emissiveIntensity) || 0.12
    });

    const createStandBlock = (width, height, depth, x, y, z) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, depth),
        standMaterial
      );
      mesh.position.set(x, y, z);
      mesh.castShadow = !this.mobileEnabled;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    for (let tier = 0; tier < tiers; tier += 1) {
      const edgeOffset = inset + tier * tierDepth;
      const span = Math.max(12, halfExtent * 2 - (boundaryThickness + edgeOffset) * 2);
      const y = baseY + tier * (tierHeight + tierGap) + tierHeight * 0.5;
      const northZ = -halfExtent + boundaryThickness + edgeOffset + tierDepth * 0.5;
      const southZ = halfExtent - boundaryThickness - edgeOffset - tierDepth * 0.5;
      const westX = -halfExtent + boundaryThickness + edgeOffset + tierDepth * 0.5;
      const eastX = halfExtent - boundaryThickness - edgeOffset - tierDepth * 0.5;

      createStandBlock(span, tierHeight, tierDepth, 0, y, northZ);
      createStandBlock(span, tierHeight, tierDepth, 0, y, southZ);
      createStandBlock(tierDepth, tierHeight, span, westX, y, 0);
      createStandBlock(tierDepth, tierHeight, span, eastX, y, 0);
    }

    const adConfig = config.ads ?? {};
    if (adConfig?.enabled) {
      const textureUrl = String(adConfig.textureUrl ?? "").trim();
      let adTexture = null;
      if (textureUrl) {
        try {
          adTexture = this.textureLoader.load(textureUrl);
          adTexture.colorSpace = THREE.SRGBColorSpace;
          adTexture.minFilter = THREE.LinearFilter;
          adTexture.magFilter = THREE.LinearFilter;
          adTexture.generateMipmaps = true;
          this.worldDecorTextures.push(adTexture);
        } catch {
          adTexture = null;
        }
      }

      const panelWidth = Math.max(2.6, Number(adConfig.boardWidth) || 8.4);
      const panelHeight = Math.max(1.2, Number(adConfig.boardHeight) || 2.6);
      const panelDepth = Math.max(0.08, Number(adConfig.boardDepth) || 0.22);
      const panelGap = Math.max(0.2, Number(adConfig.gap) || 1.2);
      const panelY = Math.max(0.6, Number(adConfig.y) || 1.2);
      const frontInset = Math.max(1.4, Number(adConfig.frontInset) || 2.2);
      const frameThickness = Math.max(0.05, Number(adConfig.frameThickness) || 0.24);
      const frameMaterial = new THREE.MeshStandardMaterial({
        color: adConfig.frameColor ?? 0x111821,
        roughness: 0.72,
        metalness: 0.16,
        emissive: 0x0f151f,
        emissiveIntensity: 0.2
      });
      const panelMaterial = new THREE.MeshStandardMaterial({
        color: adTexture ? 0xffffff : 0x8a97a3,
        map: adTexture ?? null,
        roughness: 0.42,
        metalness: 0.1,
        emissive: 0x122131,
        emissiveIntensity: adTexture ? 0.18 : 0.1
      });

      const placePanels = (span, callback) => {
        const count = Math.max(1, Math.floor((span + panelGap) / (panelWidth + panelGap)));
        const used = count * panelWidth + (count - 1) * panelGap;
        const start = -used * 0.5 + panelWidth * 0.5;
        for (let index = 0; index < count; index += 1) {
          const offset = start + index * (panelWidth + panelGap);
          callback(offset);
        }
      };

      const spanX = Math.max(12, halfExtent * 2 - (boundaryThickness + frontInset + 2) * 2);
      const spanZ = Math.max(12, halfExtent * 2 - (boundaryThickness + frontInset + 2) * 2);
      const northZ = -halfExtent + boundaryThickness + frontInset;
      const southZ = halfExtent - boundaryThickness - frontInset;
      const westX = -halfExtent + boundaryThickness + frontInset;
      const eastX = halfExtent - boundaryThickness - frontInset;

      const createPanel = (x, y, z, rotationY = 0) => {
        const frame = new THREE.Mesh(
          new THREE.BoxGeometry(panelWidth + 0.38, panelHeight + 0.38, frameThickness),
          frameMaterial
        );
        frame.position.set(x, y, z);
        frame.rotation.y = rotationY;
        frame.castShadow = !this.mobileEnabled;
        frame.receiveShadow = true;
        group.add(frame);

        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(panelWidth, panelHeight),
          panelMaterial
        );
        panel.position.set(
          x + Math.sin(rotationY) * 0.015,
          y,
          z + Math.cos(rotationY) * 0.015
        );
        panel.rotation.y = rotationY;
        panel.renderOrder = 9;
        group.add(panel);
      };

      placePanels(spanX, (offsetX) => {
        createPanel(offsetX, panelY, northZ, 0);
        createPanel(offsetX, panelY, southZ, Math.PI);
      });
      placePanels(spanZ, (offsetZ) => {
        createPanel(westX, panelY, offsetZ, Math.PI * 0.5);
        createPanel(eastX, panelY, offsetZ, -Math.PI * 0.5);
      });
    }

    this.spectatorStandsGroup = group;
    this.scene.add(this.spectatorStandsGroup);
  }

  buildDefaultBillboardMediaEntry() {
    return {
      visualType: "none",
      visualUrl: "",
      audioUrl: "",
      playbackPlaying: true,
      playbackOffsetSeconds: 0,
      playbackSyncAt: 0,
      playlist: [],
      playlistIndex: 0,
      playlistEnabled: false,
      playlistAutoAdvance: true,
      playlistPlaying: true
    };
  }

  buildDefaultBillboardMediaState() {
    return {
      board1: this.buildDefaultBillboardMediaEntry(),
      board2: this.buildDefaultBillboardMediaEntry()
    };
  }

  buildDefaultBillboardMediaRuntimeEntry() {
    return {
      texture: null,
      videoEl: null,
      audioEl: null,
      sourceTag: "",
      videoEndedHandler: null,
      videoFrameCanvas: null,
      videoFrameContext: null,
      videoFrameClock: 0,
      videoFrameInterval: 0,
      audioFx: {
        video: null,
        audio: null
      }
    };
  }

  getBillboardVideoOptimizationProfile(boardKey = "board1") {
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    const baseWidth = boardKey === "board2" ? OPPOSITE_BILLBOARD_BASE_WIDTH : CENTER_BILLBOARD_BASE_WIDTH;
    const baseHeight = boardKey === "board2" ? OPPOSITE_BILLBOARD_BASE_HEIGHT : CENTER_BILLBOARD_BASE_HEIGHT;

    let scale = 1;
    let fps = 30;
    if (this.mobileEnabled) {
      scale = 0.42;
      fps = 15;
    } else if (quality === "low") {
      scale = 0.5;
      fps = 18;
    } else if (quality === "medium") {
      scale = 0.7;
      fps = 24;
    }

    return {
      useProxy: this.mobileEnabled || quality !== "high",
      width: Math.max(256, Math.round(baseWidth * scale)),
      height: Math.max(144, Math.round(baseHeight * scale)),
      frameInterval: 1 / Math.max(12, fps)
    };
  }

  normalizeBillboardPlaylistItem(rawItem = {}, fallbackItem = null) {
    const fallback =
      fallbackItem && typeof fallbackItem === "object"
        ? fallbackItem
        : { visualType: "video", visualUrl: "", audioUrl: "" };
    const entry =
      typeof rawItem === "string"
        ? { visualType: "video", visualUrl: rawItem, audioUrl: "" }
        : rawItem && typeof rawItem === "object"
          ? rawItem
          : {};
    const visualUrl = sanitizeBillboardMediaUrl(entry.visualUrl ?? entry.url ?? fallback.visualUrl ?? "");
    if (!visualUrl) {
      return { visualType: "none", visualUrl: "", audioUrl: "" };
    }
    const requestedType = String(entry.visualType ?? entry.type ?? fallback.visualType ?? "video")
      .trim()
      .toLowerCase();
    const inferredType = inferBillboardVisualTypeFromUrl(visualUrl);
    const visualType =
      requestedType === "video" || requestedType === "image"
        ? requestedType
        : inferredType === "video" || inferredType === "image"
          ? inferredType
          : "video";
    const audioUrl = sanitizeBillboardMediaUrl(entry.audioUrl ?? entry.audio ?? fallback.audioUrl ?? "");
    return { visualType, visualUrl, audioUrl };
  }

  normalizeBillboardPlaylist(rawPlaylist = [], fallbackPlaylist = []) {
    const source = Array.isArray(rawPlaylist) ? rawPlaylist : [];
    const fallback = Array.isArray(fallbackPlaylist) ? fallbackPlaylist : [];
    const next = [];
    for (let index = 0; index < source.length; index += 1) {
      if (next.length >= BILLBOARD_PLAYLIST_MAX_ITEMS) {
        break;
      }
      const item = this.normalizeBillboardPlaylistItem(source[index], fallback[index]);
      if (!item.visualUrl || item.visualType === "none") {
        continue;
      }
      next.push(item);
    }
    return next;
  }

  normalizeBillboardMediaEntry(rawEntry = {}, fallbackEntry = null, boardKey = "board1") {
    const allowPlaylist = String(boardKey ?? "")
      .trim()
      .toLowerCase() === "board2";
    const fallback =
      fallbackEntry && typeof fallbackEntry === "object"
        ? fallbackEntry
        : this.buildDefaultBillboardMediaEntry();
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
    const requestedType = String(entry.visualType ?? entry.type ?? fallback.visualType ?? "none")
      .trim()
      .toLowerCase();
    const visualType = requestedType === "video" || requestedType === "image" ? requestedType : "none";
    const visualUrl = sanitizeBillboardMediaUrl(entry.visualUrl ?? entry.url ?? fallback.visualUrl ?? "");
    const audioUrl = sanitizeBillboardMediaUrl(entry.audioUrl ?? entry.audio ?? fallback.audioUrl ?? "");
    const playbackPlaying = (entry.playbackPlaying ?? fallback.playbackPlaying ?? true) !== false;
    const rawPlaybackOffset = Number(
      entry.playbackOffsetSeconds ?? entry.offsetSeconds ?? fallback.playbackOffsetSeconds ?? 0
    );
    const playbackOffsetSeconds = Number.isFinite(rawPlaybackOffset)
      ? Math.max(0, rawPlaybackOffset)
      : 0;
    const rawPlaybackSyncAt = Number(entry.playbackSyncAt ?? entry.syncAt ?? fallback.playbackSyncAt ?? 0);
    const playbackSyncAt = Number.isFinite(rawPlaybackSyncAt) ? Math.max(0, Math.trunc(rawPlaybackSyncAt)) : 0;
    const fallbackPlaylist = allowPlaylist ? this.normalizeBillboardPlaylist(fallback.playlist ?? []) : [];
    const playlist = allowPlaylist
      ? this.normalizeBillboardPlaylist(entry.playlist ?? fallbackPlaylist, fallbackPlaylist)
      : [];
    const rawPlaylistIndex = Number(entry.playlistIndex ?? entry.index ?? fallback.playlistIndex ?? 0);
    let playlistIndex = Number.isFinite(rawPlaylistIndex) ? Math.trunc(rawPlaylistIndex) : 0;
    if (playlist.length > 0) {
      playlistIndex = ((playlistIndex % playlist.length) + playlist.length) % playlist.length;
    } else {
      playlistIndex = 0;
    }
    const playlistEnabled =
      allowPlaylist &&
      (entry.playlistEnabled ?? fallback.playlistEnabled ?? false) === true &&
      playlist.length > 0;
    const playlistAutoAdvance = allowPlaylist
      ? (entry.playlistAutoAdvance ?? fallback.playlistAutoAdvance ?? true) !== false
      : true;
    const playlistPlaying = allowPlaylist
      ? (entry.playlistPlaying ?? fallback.playlistPlaying ?? true) !== false
      : true;
    if (playlistEnabled && playlist.length > 0) {
      const active = playlist[playlistIndex] ?? { visualType: "none", visualUrl: "", audioUrl: "" };
      return {
        visualType: active.visualType,
        visualUrl: active.visualUrl,
        audioUrl: active.audioUrl,
        playbackPlaying,
        playbackOffsetSeconds,
        playbackSyncAt,
        playlist,
        playlistIndex,
        playlistEnabled: true,
        playlistAutoAdvance,
        playlistPlaying
      };
    }
    if (visualType === "none" || !visualUrl) {
      return {
        visualType: "none",
        visualUrl: "",
        audioUrl,
        playbackPlaying,
        playbackOffsetSeconds: 0,
        playbackSyncAt: 0,
        playlist,
        playlistIndex,
        playlistEnabled: false,
        playlistAutoAdvance,
        playlistPlaying
      };
    }
    return {
      visualType,
      visualUrl,
      audioUrl,
      playbackPlaying,
      playbackOffsetSeconds,
      playbackSyncAt,
      playlist,
      playlistIndex,
      playlistEnabled: false,
      playlistAutoAdvance,
      playlistPlaying
    };
  }

  normalizeBillboardMediaState(rawState = {}) {
    const source = rawState && typeof rawState === "object" ? rawState : {};
    const fallback = this.billboardMediaState ?? this.buildDefaultBillboardMediaState();
    return {
      board1: this.normalizeBillboardMediaEntry(source.board1, fallback.board1, "board1"),
      board2: this.normalizeBillboardMediaEntry(source.board2, fallback.board2, "board2")
    };
  }

  buildBillboardMediaEntrySignature(entry = {}) {
    const playlist = Array.isArray(entry?.playlist) ? entry.playlist : [];
    const playlistSignature = playlist
      .map(
        (item) =>
          `${String(item?.visualType ?? "none")}:${String(item?.visualUrl ?? "")}:${String(item?.audioUrl ?? "")}`
      )
      .join("||");
    return [
      String(entry?.visualType ?? "none"),
      String(entry?.visualUrl ?? ""),
      String(entry?.audioUrl ?? ""),
      entry?.playbackPlaying !== false ? "1" : "0",
      Number(Number(entry?.playbackOffsetSeconds) || 0).toFixed(2),
      String(Math.max(0, Math.trunc(Number(entry?.playbackSyncAt) || 0))),
      entry?.playlistEnabled === true ? "1" : "0",
      entry?.playlistAutoAdvance !== false ? "1" : "0",
      entry?.playlistPlaying !== false ? "1" : "0",
      String(Math.max(0, Math.trunc(Number(entry?.playlistIndex) || 0))),
      playlistSignature
    ].join("~");
  }

  buildBillboardMediaChannelSignature(entry = {}) {
    return [
      String(entry?.visualType ?? "none"),
      String(entry?.visualUrl ?? ""),
      String(entry?.audioUrl ?? "")
    ].join("~");
  }

  getBillboardRuntimePlaybackOffsetSeconds(boardKey = "board1") {
    const runtime = this.billboardMediaRuntime?.[boardKey];
    if (!runtime) {
      return 0;
    }
    const videoTime = Number(runtime.videoEl?.currentTime);
    if (Number.isFinite(videoTime) && videoTime >= 0) {
      return videoTime;
    }
    const audioTime = Number(runtime.audioEl?.currentTime);
    if (Number.isFinite(audioTime) && audioTime >= 0) {
      return audioTime;
    }
    return 0;
  }

  getBillboardSyncedMediaTime(entry = {}, mediaEl = null) {
    let targetTime = Math.max(0, Number(entry?.playbackOffsetSeconds) || 0);
    const playbackPlaying = entry?.playbackPlaying !== false;
    const playbackSyncAt = Math.max(0, Math.trunc(Number(entry?.playbackSyncAt) || 0));
    if (playbackPlaying && playbackSyncAt > 0) {
      targetTime += Math.max(0, Date.now() - playbackSyncAt) / 1000;
    }
    const duration = Number(mediaEl?.duration);
    if (!Number.isFinite(duration) || duration <= 0.01) {
      return targetTime;
    }
    const loops = mediaEl?.loop === true;
    if (loops) {
      return ((targetTime % duration) + duration) % duration;
    }
    return THREE.MathUtils.clamp(targetTime, 0, Math.max(0, duration - 0.05));
  }

  syncBillboardMediaElementTime(entry = {}, mediaEl = null) {
    if (!mediaEl || mediaEl.readyState < 1) {
      return;
    }
    const targetTime = this.getBillboardSyncedMediaTime(entry, mediaEl);
    const currentTime = Number(mediaEl.currentTime);
    if (!Number.isFinite(currentTime) || Math.abs(currentTime - targetTime) > 0.35) {
      try {
        mediaEl.currentTime = targetTime;
      } catch {
        // Ignore seek failures for not-yet-seekable streams.
      }
    }
  }

  updateBillboardMediaPlaybackState(boardKey, entry = {}) {
    const runtime = this.billboardMediaRuntime?.[boardKey];
    if (!runtime) {
      return;
    }
    const playlist = Array.isArray(entry?.playlist) ? entry.playlist : [];
    const playlistEnabled = boardKey === "board2" && entry?.playlistEnabled === true && playlist.length > 0;
    const playlistAutoAdvance = playlistEnabled && entry?.playlistAutoAdvance === true;
    const playbackPlaying = entry?.playbackPlaying !== false;
    const playlistPlaying = !playlistEnabled || entry?.playlistPlaying !== false;
    const shouldPlay = playbackPlaying && playlistPlaying;
    const useEndedAdvance = shouldPlay && playlistAutoAdvance && playlist.length > 1;

    if (runtime.videoEl) {
      runtime.videoEl.loop = !useEndedAdvance;
      this.syncBillboardMediaElementTime(entry, runtime.videoEl);
      if (useEndedAdvance) {
        if (!runtime.videoEndedHandler) {
          runtime.videoEndedHandler = () => {
            this.requestBillboardPlaylistAdvanceFromEnded();
          };
          runtime.videoEl.addEventListener("ended", runtime.videoEndedHandler);
        }
      } else if (runtime.videoEndedHandler) {
        runtime.videoEl.removeEventListener("ended", runtime.videoEndedHandler);
        runtime.videoEndedHandler = null;
      }
      this.resumeMediaAudioContext();
      if (shouldPlay) {
        runtime.videoEl.play().catch(() => {});
      } else {
        runtime.videoEl.pause();
      }
    } else {
      runtime.videoEndedHandler = null;
    }

    if (runtime.audioEl) {
      this.syncBillboardMediaElementTime(entry, runtime.audioEl);
      this.resumeMediaAudioContext();
      if (shouldPlay) {
        runtime.audioEl.play().catch(() => {});
      } else {
        runtime.audioEl.pause();
      }
    }
  }

  getMediaAudioContext() {
    if (this.mediaAudioContext) {
      return this.mediaAudioContext;
    }
    if (typeof window === "undefined") {
      return null;
    }
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (typeof AudioContextCtor !== "function") {
      return null;
    }
    try {
      this.mediaAudioContext = new AudioContextCtor();
    } catch {
      this.mediaAudioContext = null;
    }
    return this.mediaAudioContext;
  }

  resumeMediaAudioContext() {
    const context = this.getMediaAudioContext();
    if (!context || context.state !== "suspended") {
      return;
    }
    context.resume().catch(() => {});
  }

  disconnectBillboardAudioFxNodes(fx = null) {
    if (!fx) {
      return;
    }
    try {
      fx.source?.disconnect?.();
    } catch {}
    try {
      fx.dryGain?.disconnect?.();
    } catch {}
    try {
      fx.delay?.disconnect?.();
    } catch {}
    try {
      fx.wetGain?.disconnect?.();
    } catch {}
    try {
      fx.feedbackGain?.disconnect?.();
    } catch {}
  }

  attachBillboardAudioFx(boardKey, channelKey, mediaEl) {
    const runtime = this.billboardMediaRuntime?.[boardKey];
    if (!runtime || !mediaEl) {
      return;
    }
    const context = this.getMediaAudioContext();
    if (!context) {
      return;
    }

    const existingFx = runtime.audioFx?.[channelKey] ?? null;
    if (existingFx?.element === mediaEl) {
      return;
    }
    if (existingFx) {
      this.disconnectBillboardAudioFxNodes(existingFx);
      runtime.audioFx[channelKey] = null;
    }

    try {
      const source = context.createMediaElementSource(mediaEl);
      const dryGain = context.createGain();
      const wetGain = context.createGain();
      const delay = context.createDelay(0.5);
      const feedbackGain = context.createGain();

      dryGain.connect(context.destination);
      source.connect(dryGain);
      source.connect(delay);
      delay.connect(wetGain);
      wetGain.connect(context.destination);
      delay.connect(feedbackGain);
      feedbackGain.connect(delay);

      delay.delayTime.value = 0.18;
      wetGain.gain.value = 0.14;
      feedbackGain.gain.value = 0.2;

      runtime.audioFx[channelKey] = {
        element: mediaEl,
        source,
        dryGain,
        wetGain,
        delay,
        feedbackGain
      };
    } catch {
      runtime.audioFx[channelKey] = null;
    }
  }

  updateBillboardVideoProxyTexture(boardKey, delta) {
    const runtime = this.billboardMediaRuntime?.[boardKey];
    if (!runtime?.videoEl || !runtime?.videoFrameCanvas || !runtime?.videoFrameContext || !runtime?.texture) {
      return;
    }
    runtime.videoFrameClock += Math.max(0, Number(delta) || 0);
    if (runtime.videoFrameClock < runtime.videoFrameInterval) {
      return;
    }
    runtime.videoFrameClock = 0;
    if (runtime.videoEl.readyState < 2) {
      return;
    }
    runtime.videoFrameContext.drawImage(
      runtime.videoEl,
      0,
      0,
      runtime.videoFrameCanvas.width,
      runtime.videoFrameCanvas.height
    );
    runtime.texture.needsUpdate = true;
  }

  updateBillboardVideoTextures(delta) {
    this.updateBillboardVideoProxyTexture("board1", delta);
    this.updateBillboardVideoProxyTexture("board2", delta);
  }

  releaseBillboardMediaChannel(boardKey) {
    const runtime = this.billboardMediaRuntime?.[boardKey];
    if (!runtime) {
      return;
    }
    for (const channelKey of ["video", "audio"]) {
      const fx = runtime.audioFx?.[channelKey] ?? null;
      if (fx) {
        this.disconnectBillboardAudioFxNodes(fx);
        runtime.audioFx[channelKey] = null;
      }
    }
    if (runtime.videoEl && runtime.videoEndedHandler) {
      runtime.videoEl.removeEventListener("ended", runtime.videoEndedHandler);
    }
    runtime.videoEndedHandler = null;
    if (runtime.videoEl) {
      runtime.videoEl.pause();
      runtime.videoEl.removeAttribute("src");
      runtime.videoEl.load();
      runtime.videoEl = null;
    }
    if (runtime.audioEl) {
      runtime.audioEl.pause();
      runtime.audioEl.removeAttribute("src");
      runtime.audioEl.load();
      runtime.audioEl = null;
    }
    if (runtime.texture) {
      runtime.texture.dispose?.();
      runtime.texture = null;
    }
    runtime.videoFrameCanvas = null;
    runtime.videoFrameContext = null;
    runtime.videoFrameClock = 0;
    runtime.videoFrameInterval = 0;
    runtime.sourceTag = "";
  }

  applyCenterBillboardMode() {
    const material = this.centerBillboardScreenMaterial;
    const fallbackTexture = this.centerBillboardTexture;
    if (!material || !fallbackTexture) {
      return;
    }
    const mediaTexture = this.billboardMediaRuntime?.board1?.texture ?? null;
    const nextMap = mediaTexture ?? fallbackTexture;
    if (material.map !== nextMap) {
      material.map = nextMap;
      material.needsUpdate = true;
    }
  }

  requestBillboardPlaylistAdvanceFromEnded() {
    if (!this.socket || !this.networkConnected || !this.ownerAccessEnabled || !this.isLocalHost()) {
      return;
    }
    const board2 = this.normalizeBillboardMediaEntry(this.billboardMediaState?.board2 ?? {}, null, "board2");
    const playlist = Array.isArray(board2?.playlist) ? board2.playlist : [];
    if (!(board2?.playlistEnabled === true && board2?.playlistAutoAdvance === true) || playlist.length <= 1) {
      return;
    }
    const nextIndex = (Math.max(0, Math.trunc(Number(board2?.playlistIndex) || 0)) + 1) % playlist.length;
    const payload = {
      target: "board2",
      media: this.normalizeBillboardMediaEntry(
        {
          ...board2,
          playlist,
          playlistIndex: nextIndex,
          playlistEnabled: true,
          playlistPlaying: true,
          playbackPlaying: true,
          playbackOffsetSeconds: 0,
          playbackSyncAt: Date.now()
        },
        board2,
        "board2"
      )
    };
    this.sendBillboardMediaPayload(payload, { silentSuccess: true, silentFailure: true });
  }

  setupBillboardMediaChannel(boardKey, entry) {
    this.releaseBillboardMediaChannel(boardKey);
    const runtime = this.billboardMediaRuntime?.[boardKey];
    if (!runtime) {
      return;
    }

    const visualType = String(entry?.visualType ?? "none");
    const visualUrl = sanitizeBillboardMediaUrl(entry?.visualUrl ?? "");
    const audioUrl = sanitizeBillboardMediaUrl(entry?.audioUrl ?? "");

    if (visualType === "video" && visualUrl) {
      const video = document.createElement("video");
      video.src = visualUrl;
      video.preload = this.mobileEnabled ? "metadata" : "auto";
      video.loop = true;
      video.muted = Boolean(audioUrl);
      video.playsInline = true;
      video.autoplay = false;
      video.crossOrigin = "anonymous";
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      runtime.videoEl = video;
      const optimization = this.getBillboardVideoOptimizationProfile(boardKey);
      if (optimization.useProxy) {
        const canvas = document.createElement("canvas");
        canvas.width = optimization.width;
        canvas.height = optimization.height;
        const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
        if (context) {
          context.fillStyle = "#000";
          context.fillRect(0, 0, canvas.width, canvas.height);
          const canvasTexture = new THREE.CanvasTexture(canvas);
          canvasTexture.colorSpace = THREE.SRGBColorSpace;
          canvasTexture.minFilter = THREE.LinearFilter;
          canvasTexture.magFilter = THREE.LinearFilter;
          canvasTexture.generateMipmaps = false;
          runtime.videoFrameCanvas = canvas;
          runtime.videoFrameContext = context;
          runtime.videoFrameClock = optimization.frameInterval;
          runtime.videoFrameInterval = optimization.frameInterval;
          runtime.texture = canvasTexture;
          runtime.sourceTag = `video-proxy:${visualUrl}`;
        }
      }
      if (!runtime.texture) {
        const videoTexture = new THREE.VideoTexture(video);
        videoTexture.colorSpace = THREE.SRGBColorSpace;
        videoTexture.minFilter = THREE.LinearFilter;
        videoTexture.magFilter = THREE.LinearFilter;
        videoTexture.generateMipmaps = false;
        runtime.texture = videoTexture;
        runtime.sourceTag = `video:${visualUrl}`;
      }
      this.attachBillboardAudioFx(boardKey, "video", video);
    } else if (visualType === "image" && visualUrl) {
      const texture = this.textureLoader.load(
        visualUrl,
        () => {
          this.applyCenterBillboardMode();
          this.applyOppositeBillboardMode();
        },
        undefined,
        () => {}
      );
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      runtime.texture = texture;
      runtime.sourceTag = `image:${visualUrl}`;
    }

    if (audioUrl) {
      const audio = document.createElement("audio");
      audio.src = audioUrl;
      audio.loop = true;
      audio.preload = "auto";
      audio.crossOrigin = "anonymous";
      runtime.audioEl = audio;
      this.attachBillboardAudioFx(boardKey, "audio", audio);
    }

    this.applyUiVolumeToMedia();
    this.updateBillboardMediaPlaybackState(boardKey, entry);
  }

  applyBillboardMediaState(rawState = {}) {
    const previous = this.billboardMediaState ?? this.buildDefaultBillboardMediaState();
    const next = this.normalizeBillboardMediaState(rawState);
    this.billboardMediaState = next;

    for (const boardKey of ["board1", "board2"]) {
      const prevEntry = previous?.[boardKey] ?? {};
      const nextEntry = next?.[boardKey] ?? {};
      const sourceChanged =
        this.buildBillboardMediaChannelSignature(prevEntry) !==
        this.buildBillboardMediaChannelSignature(nextEntry);
      const changed =
        this.buildBillboardMediaEntrySignature(prevEntry) !== this.buildBillboardMediaEntrySignature(nextEntry);
      if (sourceChanged) {
        this.setupBillboardMediaChannel(boardKey, nextEntry);
      } else if (changed) {
        this.updateBillboardMediaPlaybackState(boardKey, nextEntry);
      }
    }
    this.applyCenterBillboardMode();
    this.applyOppositeBillboardMode();
    this.refreshBillboardPlaylistUi();
  }

  refreshBillboardMediaForQualityChange() {
    for (const boardKey of ["board1", "board2"]) {
      const entry = this.billboardMediaState?.[boardKey] ?? null;
      if (!entry || String(entry.visualType ?? "none") !== "video") {
        continue;
      }
      this.setupBillboardMediaChannel(boardKey, entry);
    }
    this.applyCenterBillboardMode();
    this.applyOppositeBillboardMode();
  }

  getSelectedBillboardBoardKey() {
    const target = String(this.billboardTargetSelectEl?.value ?? "board1").trim().toLowerCase();
    return target === "board2" ? "board2" : "board1";
  }

  buildBillboardMediaPayloadForBoard(boardKey = "board1", media = {}) {
    const board = boardKey === "board2" ? "board2" : "board1";
    const syncAt = Date.now();
    const visualType = String(media?.visualType ?? "none").trim().toLowerCase();
    const visualUrl = sanitizeBillboardMediaUrl(media?.visualUrl ?? "");
    const audioUrl = sanitizeBillboardMediaUrl(media?.audioUrl ?? "");
    return {
      target: board,
      media: {
        visualType: visualType === "image" || visualType === "video" ? visualType : "none",
        visualUrl,
        audioUrl,
        playbackPlaying: visualType !== "none" || Boolean(audioUrl),
        playbackOffsetSeconds: 0,
        playbackSyncAt: visualType !== "none" || audioUrl ? syncAt : 0,
        playlistEnabled: false,
        playlistPlaying: false
      }
    };
  }

  clearSelectedBillboardMediaFile() {
    if (this.billboardMediaFileInputEl) {
      this.billboardMediaFileInputEl.value = "";
    }
  }

  getSelectedBillboardMediaFile() {
    const fileList = this.billboardMediaFileInputEl?.files;
    if (!fileList || fileList.length <= 0) {
      return null;
    }
    return fileList[0] ?? null;
  }

  isSupportedBillboardAudioUrl(rawUrl = "", fallbackName = "") {
    const target = String(rawUrl || fallbackName || "").trim().toLowerCase();
    return /\.(mp3|wav|ogg|m4a)(\?.*)?$/.test(target);
  }

  buildBillboardMediaPayloadFromUploadedFile(uploadUrl = "", file = null) {
    const resolvedUrl = sanitizeBillboardMediaUrl(uploadUrl);
    if (!resolvedUrl) {
      return null;
    }
    const board = this.getSelectedBillboardBoardKey();
    const fileType = String(file?.type ?? "").trim().toLowerCase();
    const fileName = String(file?.name ?? "").trim();
    if (fileType.startsWith("audio/") || this.isSupportedBillboardAudioUrl(resolvedUrl, fileName)) {
      return this.buildBillboardMediaPayloadForBoard(board, {
        visualType: "none",
        visualUrl: "",
        audioUrl: resolvedUrl
      });
    }
    const visualType = fileType.startsWith("image/")
      ? "image"
      : fileType.startsWith("video/")
        ? "video"
        : inferBillboardVisualTypeFromUrl(fileName || resolvedUrl);
    if (visualType !== "image" && visualType !== "video") {
      return null;
    }
    return this.buildBillboardMediaPayloadForBoard(board, {
      visualType,
      visualUrl: resolvedUrl,
      audioUrl: ""
    });
  }

  async uploadBillboardMediaFile(file) {
    if (!(file instanceof File)) {
      return "";
    }
    const endpoint = new URL("/uploads/billboard", window.location.href).toString();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": String(file.type ?? "").trim() || "application/octet-stream",
        "x-owner-key": String(this.ownerAccessKey ?? "").trim(),
        "x-upload-filename": encodeURIComponent(String(file.name ?? "billboard-media.bin"))
      },
      body: file
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(String(payload?.error ?? `upload-failed-${response.status}`));
    }
    return sanitizeBillboardMediaUrl(payload?.url ?? "");
  }

  async handleBillboardMediaFileUpload(selectedFile) {
    if (!(selectedFile instanceof File)) {
      return;
    }
    if (!this.canControlBillboardMedia()) {
      return;
    }
    if (this.billboardMediaUploadInFlight) {
      return;
    }
    if (selectedFile.size > BILLBOARD_MEDIA_UPLOAD_MAX_BYTES) {
      this.appendChatLine(
        "System",
        `Selected media file is too large. Limit: ${Math.round(BILLBOARD_MEDIA_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`,
        "system"
      );
      return;
    }
    this.billboardMediaUploadInFlight = true;
    this.updateQuizControlUi();
    try {
      const uploadUrl = await this.uploadBillboardMediaFile(selectedFile);
      const uploadedPayload = this.buildBillboardMediaPayloadFromUploadedFile(uploadUrl, selectedFile);
      if (!uploadedPayload) {
        this.appendChatLine("System", "Only mp4/webm/png/jpg/webp/mp3 files are supported.", "system");
        return;
      }
      this.sendBillboardMediaPayload(uploadedPayload, {
        successMessage: "Billboard media uploaded and applied."
      });
      this.clearSelectedBillboardMediaFile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "upload failed");
      this.appendChatLine("System", `Billboard upload failed: ${message}`, "system");
    } finally {
      this.billboardMediaUploadInFlight = false;
      this.updateQuizControlUi();
    }
  }

  buildBillboardMediaPayloadFromUi(clearOnly = false) {
    const board = this.getSelectedBillboardBoardKey();
    const syncAt = Date.now();
    if (clearOnly) {
      return {
        target: board,
        media: {
          visualType: "none",
          visualUrl: "",
          audioUrl: "",
          playbackPlaying: false,
          playbackOffsetSeconds: 0,
          playbackSyncAt: 0,
          playlistEnabled: false,
          playlistPlaying: false
        }
      };
    }

    const customUrl = sanitizeBillboardMediaUrl(this.billboardMediaUrlInputEl?.value ?? "");
    const preset = String(this.billboardMediaPresetSelectEl?.value ?? "none").trim().toLowerCase();
    if (customUrl) {
      const lower = customUrl.toLowerCase();
      if (/\.(mp3|wav|ogg|m4a)(\?.*)?$/.test(lower)) {
        return {
          target: board,
          media: {
            visualType: "none",
            visualUrl: "",
            audioUrl: customUrl,
            playbackPlaying: true,
            playbackOffsetSeconds: 0,
            playbackSyncAt: syncAt,
            playlistEnabled: false,
            playlistPlaying: false
          }
        };
      }
      const visualType = inferBillboardVisualTypeFromUrl(customUrl);
      if (visualType === "none") {
        return null;
      }
      return {
        target: board,
        media: {
          visualType,
          visualUrl: customUrl,
          audioUrl: "",
          playbackPlaying: true,
          playbackOffsetSeconds: 0,
          playbackSyncAt: syncAt,
          playlistEnabled: false,
          playlistPlaying: false
        }
      };
    }

    if (preset === "gemini-image") {
      return {
        target: board,
        media: {
          visualType: "image",
          visualUrl: BILLBOARD_PRESET_IMAGE_URL,
          audioUrl: "",
          playbackPlaying: true,
          playbackOffsetSeconds: 0,
          playbackSyncAt: syncAt,
          playlistEnabled: false,
          playlistPlaying: false
        }
      };
    }
    if (preset === "sample-video") {
      return {
        target: board,
        media: {
          visualType: "video",
          visualUrl: NPC_GREETING_VIDEO_URL,
          audioUrl: "",
          playbackPlaying: true,
          playbackOffsetSeconds: 0,
          playbackSyncAt: syncAt,
          playlistEnabled: false,
          playlistPlaying: false
        }
      };
    }
    if (preset === "sample-mp3") {
      return {
        target: board,
        media: {
          visualType: "none",
          visualUrl: "",
          audioUrl: BILLBOARD_PRESET_AUDIO_URL,
          playbackPlaying: true,
          playbackOffsetSeconds: 0,
          playbackSyncAt: syncAt,
          playlistEnabled: false,
          playlistPlaying: false
        }
      };
    }
    return {
      target: board,
      media: {
        visualType: "none",
        visualUrl: "",
        audioUrl: "",
        playbackPlaying: false,
        playbackOffsetSeconds: 0,
        playbackSyncAt: 0,
        playlistEnabled: false,
        playlistPlaying: false
      }
    };
  }

  requestBillboardMediaApply(clearOnly = false) {
    if (clearOnly) {
      this.clearSelectedBillboardMediaFile();
      const clearPayload = this.buildBillboardMediaPayloadFromUi(true);
      this.sendBillboardMediaPayload(clearPayload, {
        successMessage: "Billboard media cleared."
      });
      return;
    }

    const selectedFile = this.getSelectedBillboardMediaFile();
    if (selectedFile) {
      void this.handleBillboardMediaFileUpload(selectedFile);
      return;
    }

    const nextPayload = this.buildBillboardMediaPayloadFromUi(clearOnly);
    if (!nextPayload) {
      this.appendChatLine("System", "Only supported media URLs can be applied (mp4/webm/png/jpg/mp3).", "system");
      return;
    }
    this.sendBillboardMediaPayload(nextPayload, {
      successMessage: "Billboard media applied."
    });
    return;

    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 전광판 제어 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 전광판을 제어할 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 전광판 미디어를 제어할 수 있습니다.", "system");
      return;
    }

    const payload = this.buildBillboardMediaPayloadFromUi(clearOnly);
    if (!payload) {
      this.appendChatLine("시스템", "지원되는 미디어 URL(mp4/webm/png/jpg/mp3)만 사용할 수 있습니다.", "system");
      return;
    }
    this.socket.emit("billboard:media:set", payload, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `전광판 반영 실패: ${this.translateQuizError(response?.error)}`, "system");
        return;
      }
      if (response?.media) {
        this.applyBillboardMediaState(response.media);
      }
      this.appendChatLine("시스템", "전광판 미디어를 반영했습니다.", "system");
    });
  }

  requestBillboardMediaPlaybackControl(action = "play") {
    const command = String(action ?? "").trim().toLowerCase();
    const target = String(this.billboardTargetSelectEl?.value ?? "board1").trim().toLowerCase();
    const boardKey = target === "board2" ? "board2" : "board1";
    const current = this.normalizeBillboardMediaEntry(this.billboardMediaState?.[boardKey] ?? {}, null, boardKey);

    if (boardKey === "board2" && current?.playlistEnabled === true && Array.isArray(current?.playlist) && current.playlist.length > 0) {
      this.requestBillboardPlaylistControl(command);
      return;
    }

    const hasPlayableMedia =
      (String(current?.visualType ?? "none") === "video" && Boolean(String(current?.visualUrl ?? ""))) ||
      Boolean(String(current?.audioUrl ?? ""));
    if (!hasPlayableMedia) {
      this.appendChatLine("System", "Apply a video or audio source before using playback controls.", "system");
      return;
    }

    const shouldPlay = command !== "pause";
    const payload = {
      target: boardKey,
      media: this.normalizeBillboardMediaEntry(
        {
          ...current,
          playbackPlaying: shouldPlay,
          playbackOffsetSeconds: this.getBillboardRuntimePlaybackOffsetSeconds(boardKey),
          playbackSyncAt: Date.now()
        },
        current,
        boardKey
      )
    };
    this.sendBillboardMediaPayload(payload, {
      successMessage: shouldPlay ? "Billboard playback started." : "Billboard playback paused."
    });
  }

  canControlBillboardMedia({ silent = false } = {}) {
    if (!this.ownerAccessEnabled) {
      if (!silent) {
        this.appendChatLine("System", "Owner key is required for billboard controls.", "system");
      }
      return false;
    }
    if (!this.socket || !this.networkConnected) {
      if (!silent) {
        this.appendChatLine("System", "You must be connected to control billboard media.", "system");
      }
      return false;
    }
    if (!this.isLocalHost()) {
      if (!silent) {
        this.appendChatLine("System", "Only the current host can control billboard media.", "system");
      }
      return false;
    }
    return true;
  }

  sendBillboardMediaPayload(payload, options = {}) {
    const { successMessage = "Billboard media updated.", silentSuccess = false, silentFailure = false } =
      options ?? {};
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (!this.canControlBillboardMedia({ silent: silentFailure })) {
      return;
    }
    this.socket.emit("billboard:media:set", payload, (response = {}) => {
      if (!response?.ok) {
        if (!silentFailure) {
          this.appendChatLine("System", `Billboard update failed: ${this.translateQuizError(response?.error)}`, "system");
        }
        return;
      }
      if (response?.media) {
        this.applyBillboardMediaState(response.media);
      }
      if (!silentSuccess && successMessage) {
        this.appendChatLine("System", successMessage, "system");
      }
    });
  }

  parseBillboardPlaylistFromInput(rawText = "") {
    const text = String(rawText ?? "");
    const lines = text
      .split(/\r?\n/g)
      .map((line) => sanitizeBillboardMediaUrl(line))
      .filter(Boolean);
    const playlist = [];
    for (const url of lines) {
      if (playlist.length >= BILLBOARD_PLAYLIST_MAX_ITEMS) {
        break;
      }
      const visualType = inferBillboardVisualTypeFromUrl(url);
      if (visualType !== "video") {
        continue;
      }
      playlist.push({ visualType: "video", visualUrl: url, audioUrl: "" });
    }
    return playlist;
  }

  buildBoard2PlaylistMediaOverride(overrides = {}) {
    const current = this.normalizeBillboardMediaEntry(this.billboardMediaState?.board2 ?? {}, null, "board2");
    return this.normalizeBillboardMediaEntry(
      {
        ...current,
        ...overrides
      },
      current,
      "board2"
    );
  }

  requestBillboardPlaylistLoad() {
    const playlist = this.parseBillboardPlaylistFromInput(this.billboardPlaylistInputEl?.value ?? "");
    if (playlist.length <= 0) {
      this.appendChatLine("System", "Enter at least one MP4 URL (one per line).", "system");
      return;
    }
    const autoAdvance = this.billboardPlaylistAutoInputEl?.checked !== false;
    const payload = {
      target: "board2",
      media: this.buildBoard2PlaylistMediaOverride({
        playlist,
        playlistIndex: 0,
        playlistEnabled: true,
        playlistAutoAdvance: autoAdvance,
        playlistPlaying: true,
        playbackPlaying: true,
        playbackOffsetSeconds: 0,
        playbackSyncAt: Date.now()
      })
    };
    this.sendBillboardMediaPayload(payload, {
      successMessage: `Rear billboard playlist loaded (${playlist.length} videos).`
    });
  }

  requestBillboardPlaylistAutoAdvanceUpdate() {
    const current = this.normalizeBillboardMediaEntry(this.billboardMediaState?.board2 ?? {}, null, "board2");
    const playlist = Array.isArray(current?.playlist) ? current.playlist : [];
    if (playlist.length <= 0) {
      this.refreshBillboardPlaylistUi();
      return;
    }
    if (!this.canControlBillboardMedia({ silent: true })) {
      this.refreshBillboardPlaylistUi();
      return;
    }
    const autoAdvance = this.billboardPlaylistAutoInputEl?.checked !== false;
    const payload = {
      target: "board2",
      media: this.buildBoard2PlaylistMediaOverride({
        playlist,
        playlistAutoAdvance: autoAdvance
      })
    };
    this.sendBillboardMediaPayload(payload, {
      silentSuccess: true,
      silentFailure: true
    });
  }

  requestBillboardPlaylistControl(action, options = {}) {
    const command = String(action ?? "").trim().toLowerCase();
    const { silentSuccess = false, silentFailure = false } = options ?? {};
    const current = this.normalizeBillboardMediaEntry(this.billboardMediaState?.board2 ?? {}, null, "board2");
    const playlist = Array.isArray(current?.playlist) ? current.playlist : [];
    if (playlist.length <= 0) {
      if (!silentFailure) {
        this.appendChatLine("System", "Rear billboard playlist is empty.", "system");
      }
      return;
    }

    let nextIndex = Math.max(0, Math.trunc(Number(current?.playlistIndex) || 0));
    let nextPlaying = current?.playlistPlaying !== false;
    let nextEnabled = current?.playlistEnabled === true;
    const autoAdvance = this.billboardPlaylistAutoInputEl?.checked !== false;
    let nextPlaybackPlaying = current?.playbackPlaying !== false;
    let nextPlaybackOffsetSeconds = this.getBillboardRuntimePlaybackOffsetSeconds("board2");
    let nextPlaybackSyncAt = Date.now();

    if (command === "play") {
      nextEnabled = true;
      nextPlaying = true;
      nextPlaybackPlaying = true;
    } else if (command === "pause") {
      nextEnabled = true;
      nextPlaying = false;
      nextPlaybackPlaying = false;
    } else if (command === "next") {
      nextIndex = (nextIndex + 1) % playlist.length;
      nextEnabled = true;
      nextPlaying = true;
      nextPlaybackPlaying = true;
      nextPlaybackOffsetSeconds = 0;
    } else if (command === "prev") {
      nextIndex = (nextIndex - 1 + playlist.length) % playlist.length;
      nextEnabled = true;
      nextPlaying = true;
      nextPlaybackPlaying = true;
      nextPlaybackOffsetSeconds = 0;
    } else if (command === "select") {
      const requestedIndex = Math.trunc(Number(this.billboardPlaylistIndexSelectEl?.value));
      if (!Number.isFinite(requestedIndex) || requestedIndex < 0 || requestedIndex >= playlist.length) {
        if (!silentFailure) {
          this.appendChatLine("System", "Selected playlist index is invalid.", "system");
        }
        return;
      }
      nextIndex = requestedIndex;
      nextEnabled = true;
      nextPlaying = true;
      nextPlaybackPlaying = true;
      nextPlaybackOffsetSeconds = 0;
    } else {
      if (!silentFailure) {
        this.appendChatLine("System", "Unknown playlist command.", "system");
      }
      return;
    }

    const payload = {
      target: "board2",
      media: this.buildBoard2PlaylistMediaOverride({
        playlist,
        playlistIndex: nextIndex,
        playlistEnabled: nextEnabled,
        playlistAutoAdvance: autoAdvance,
        playlistPlaying: nextPlaying,
        playbackPlaying: nextPlaybackPlaying,
        playbackOffsetSeconds: nextPlaybackOffsetSeconds,
        playbackSyncAt: nextPlaybackSyncAt
      })
    };
    const successMessageMap = {
      play: "Rear billboard playback started.",
      pause: "Rear billboard playback paused.",
      next: "Moved to next rear billboard video.",
      prev: "Moved to previous rear billboard video.",
      select: "Selected rear billboard video has started."
    };
    this.sendBillboardMediaPayload(payload, {
      successMessage: successMessageMap[command] ?? "Rear billboard playback updated.",
      silentSuccess,
      silentFailure
    });
  }

  refreshBillboardPlaylistUi() {
    this.resolveUiElements();
    const select = this.billboardPlaylistIndexSelectEl;
    if (!select) {
      return;
    }
    const board2 = this.normalizeBillboardMediaEntry(this.billboardMediaState?.board2 ?? {}, null, "board2");
    const playlist = Array.isArray(board2?.playlist) ? board2.playlist : [];
    const playlistIndex = Math.max(0, Math.trunc(Number(board2?.playlistIndex) || 0));
    const signature = `${playlistIndex}|${board2?.playlistPlaying === false ? 0 : 1}|${
      board2?.playlistAutoAdvance === false ? 0 : 1
    }|${playlist
      .map((item) => String(item?.visualUrl ?? ""))
      .join("|")}`;
    if (signature === this.billboardPlaylistOptionsSignature) {
      return;
    }
    this.billboardPlaylistOptionsSignature = signature;
    select.replaceChildren();
    if (playlist.length <= 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "목록 비어 있음";
      select.appendChild(option);
      select.value = "";
    } else {
      for (let index = 0; index < playlist.length; index += 1) {
        const item = playlist[index];
        const option = document.createElement("option");
        option.value = String(index);
        const rawUrl = String(item?.visualUrl ?? "");
        let shortLabel = rawUrl;
        try {
          const parsed = new URL(rawUrl, window.location.href);
          const pathPart = parsed.pathname
            .split("/")
            .filter(Boolean)
            .pop();
          shortLabel = pathPart || parsed.host || rawUrl;
        } catch {}
        if (shortLabel.length > 38) {
          shortLabel = `${shortLabel.slice(0, 35)}...`;
        }
        option.textContent = `${index + 1}. ${shortLabel}`;
        select.appendChild(option);
      }
      select.value = String(Math.min(playlistIndex, playlist.length - 1));
    }
    if (this.billboardPlaylistAutoInputEl) {
      this.billboardPlaylistAutoInputEl.checked = board2?.playlistAutoAdvance !== false;
    }
  }

  clearMegaAdScreen() {
    if (this.megaAdVideoEl) {
      this.megaAdVideoEl.pause();
      this.megaAdVideoEl.removeAttribute("src");
      this.megaAdVideoEl.load();
      this.megaAdVideoEl = null;
    }
    if (this.megaAdVideoTexture) {
      this.megaAdVideoTexture.dispose?.();
      this.megaAdVideoTexture = null;
    }
    if (this.megaAdTextTexture) {
      this.megaAdTextTexture.dispose?.();
      this.megaAdTextTexture = null;
    }
    this.megaAdTextCanvas = null;
    this.megaAdTextContext = null;
    this.megaAdTextLastSignature = "";
    this.megaAdScreenMaterial = null;
    if (!this.megaAdScreenGroup) {
      return;
    }
    this.scene.remove(this.megaAdScreenGroup);
    disposeMeshTree(this.megaAdScreenGroup);
    this.megaAdScreenGroup = null;
  }

  kickMegaAdVideoPlayback() {
    const video = this.megaAdVideoEl;
    if (!video) {
      return;
    }
    if (!video.paused) {
      return;
    }
    video.play().catch(() => {});
  }

  setupMegaAdScreen(config = {}) {
    this.clearMegaAdScreen();
    if (!config?.enabled) {
      return;
    }

    const width = Math.max(18, Number(config.width) || 42);
    const height = Math.max(10, Number(config.height) || 18);
    const centerY = Math.max(8, Number(config.centerY) || 16);
    const poleHeight = Math.max(8, Number(config.poleHeight) || centerY);
    const heading = Number(config.heading) || 0;
    const position = parseVec3(config.position, [0, 0, -56]);

    const group = new THREE.Group();
    group.position.set(position.x, position.y, position.z);
    group.rotation.y = heading;

    const frameMaterial = new THREE.MeshStandardMaterial({
      color: config.frameColor ?? 0x1e2630,
      roughness: 0.52,
      metalness: 0.38,
      emissive: config.frameEmissive ?? 0x101820,
      emissiveIntensity: Number(config.frameEmissiveIntensity) || 0.24
    });
    const supportMaterial = new THREE.MeshStandardMaterial({
      color: config.supportColor ?? 0x37414d,
      roughness: 0.74,
      metalness: 0.22,
      emissive: 0x161f29,
      emissiveIntensity: 0.12
    });

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(width + 2.2, height + 2.2, 1.28),
      frameMaterial
    );
    frame.position.y = centerY;
    frame.castShadow = !this.mobileEnabled;
    frame.receiveShadow = true;
    group.add(frame);

    const configuredUrl = String(config.videoUrl ?? "").trim();
    const allowMobileVideo = config.mobileVideoEnabled === true;
    const useVideoTexture = Boolean(configuredUrl) && (!this.mobileEnabled || allowMobileVideo);
    let video = null;
    let videoTexture = null;
    if (useVideoTexture) {
      video = document.createElement("video");
      video.src = configuredUrl;
      video.preload = this.mobileEnabled ? "metadata" : "auto";
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.crossOrigin = "anonymous";
      video.disablePictureInPicture = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.setAttribute("disablePictureInPicture", "");

      videoTexture = new THREE.VideoTexture(video);
      videoTexture.colorSpace = THREE.SRGBColorSpace;
      videoTexture.minFilter = THREE.LinearFilter;
      videoTexture.magFilter = THREE.LinearFilter;
      videoTexture.generateMipmaps = false;
    }

    const textCanvas = document.createElement("canvas");
    const textScale = this.mobileEnabled ? 0.5 : 0.72;
    textCanvas.width = Math.max(640, Math.round(OPPOSITE_BILLBOARD_BASE_WIDTH * textScale));
    textCanvas.height = Math.max(360, Math.round(OPPOSITE_BILLBOARD_BASE_HEIGHT * textScale));
    const textContext = textCanvas.getContext("2d");

    const textTexture = new THREE.CanvasTexture(textCanvas);
    textTexture.colorSpace = THREE.SRGBColorSpace;
    textTexture.minFilter = THREE.LinearFilter;
    textTexture.magFilter = THREE.LinearFilter;
    textTexture.generateMipmaps = false;

    const screenMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: useVideoTexture ? videoTexture : textTexture,
      roughness: 0.2,
      metalness: 0.06,
      emissive: 0x3a5f84,
      emissiveIntensity: Number(config.screenGlow) || 0.24
    });

    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      screenMaterial
    );
    screen.position.set(0, centerY, 0.7);
    group.add(screen);

    const backCase = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.76, height + 0.76, 1.06),
      new THREE.MeshStandardMaterial({
        color: 0x141c26,
        roughness: 0.78,
        metalness: 0.22
      })
    );
    backCase.position.set(0, centerY, -0.34);
    backCase.castShadow = !this.mobileEnabled;
    backCase.receiveShadow = true;
    group.add(backCase);

    const braceYTop = centerY + height * 0.5 + 0.62;
    const braceYBottom = centerY - height * 0.5 - 0.62;
    const topBrace = new THREE.Mesh(
      new THREE.BoxGeometry(width + 3.6, 0.62, 0.72),
      supportMaterial
    );
    topBrace.position.set(0, braceYTop, -0.44);
    topBrace.castShadow = !this.mobileEnabled;
    topBrace.receiveShadow = true;
    group.add(topBrace);
    const bottomBrace = topBrace.clone();
    bottomBrace.position.y = braceYBottom;
    group.add(bottomBrace);

    const poleOffsetX = width * 0.36;
    const poleThickness = 1.4;
    const poleMaterial = new THREE.MeshStandardMaterial({
      color: config.poleColor ?? 0x4f5a67,
      roughness: 0.72,
      metalness: 0.24,
      emissive: 0x1a2734,
      emissiveIntensity: 0.12
    });
    const leftPole = new THREE.Mesh(
      new THREE.BoxGeometry(poleThickness, poleHeight, poleThickness),
      poleMaterial
    );
    leftPole.position.set(-poleOffsetX, poleHeight * 0.5, -0.5);
    leftPole.castShadow = !this.mobileEnabled;
    leftPole.receiveShadow = true;
    group.add(leftPole);
    const rightPole = leftPole.clone();
    rightPole.position.x = poleOffsetX;
    group.add(rightPole);

    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(width * 0.18, width * 0.22, 0.6, this.mobileEnabled ? 16 : 28),
      new THREE.MeshStandardMaterial({
        color: 0x4d5866,
        roughness: 0.84,
        metalness: 0.12,
        emissive: 0x1a232e,
        emissiveIntensity: 0.08
      })
    );
    platform.position.set(0, 0.3, -0.5);
    platform.receiveShadow = true;
    group.add(platform);

    this.megaAdVideoEl = video;
    this.megaAdVideoTexture = videoTexture;
    this.megaAdTextCanvas = textCanvas;
    this.megaAdTextContext = textContext;
    this.megaAdTextTexture = textTexture;
    this.megaAdScreenMaterial = screenMaterial;
    this.megaAdScreenGroup = group;
    this.scene.add(this.megaAdScreenGroup);
    this.applyUiVolumeToMedia();

    this.applyOppositeBillboardMode();

    const attemptPlay = () => {
      video?.play().catch(() => {});
    };
    if (video) {
      video.addEventListener("canplay", attemptPlay, { once: true });
      attemptPlay();
    }
  }

  applyOppositeBillboardMode() {
    if (!this.megaAdScreenMaterial) {
      return;
    }

    const mediaTexture = this.billboardMediaRuntime?.board2?.texture ?? null;
    const nextMap = mediaTexture ?? this.megaAdTextTexture;
    if (this.megaAdScreenMaterial.map !== nextMap) {
      this.megaAdScreenMaterial.map = nextMap ?? null;
      this.megaAdScreenMaterial.needsUpdate = true;
    }

    this.megaAdVideoEl?.pause?.();
  }

  setOppositeBillboardResultVisible(visible) {
    this.quizOppositeBillboardResultVisible = Boolean(visible);
    this.applyOppositeBillboardMode();
  }

  renderOppositeBillboard(payload = {}, force = false) {
    const context = this.megaAdTextContext;
    const canvas = this.megaAdTextCanvas;
    const texture = this.megaAdTextTexture;
    if (!context || !canvas || !texture) {
      this.applyOppositeBillboardMode();
      return;
    }

    const kicker = String(payload.kicker ?? "실시간").trim().slice(0, 44);
    const title = String(payload.title ?? "메가 OX 퀴즈").trim().slice(0, 120);
    const footer = String(payload.footer ?? "").trim().slice(0, 120);
    const lineSource = Array.isArray(payload.lines) ? payload.lines : [];
    const lines = lineSource
      .map((line) => String(line ?? "").trim())
      .filter(Boolean)
      .slice(0, 5);

    const signature = `${kicker}|${title}|${footer}|${lines.join("||")}`;
    if (!force && signature === this.megaAdTextLastSignature) {
      this.applyOppositeBillboardMode();
      return;
    }
    this.megaAdTextLastSignature = signature;

    const scaleX = canvas.width / OPPOSITE_BILLBOARD_BASE_WIDTH;
    const scaleY = canvas.height / OPPOSITE_BILLBOARD_BASE_HEIGHT;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    const gradient = context.createLinearGradient(0, 0, 0, OPPOSITE_BILLBOARD_BASE_HEIGHT);
    gradient.addColorStop(0, "#101722");
    gradient.addColorStop(0.55, "#152132");
    gradient.addColorStop(1, "#0f1722");
    context.fillStyle = gradient;
    context.fillRect(0, 0, OPPOSITE_BILLBOARD_BASE_WIDTH, OPPOSITE_BILLBOARD_BASE_HEIGHT);

    context.strokeStyle = "rgba(138, 196, 255, 0.62)";
    context.lineWidth = 20;
    context.strokeRect(26, 26, OPPOSITE_BILLBOARD_BASE_WIDTH - 52, OPPOSITE_BILLBOARD_BASE_HEIGHT - 52);

    context.fillStyle = "#8fd1ff";
    context.font = "700 52px 'Segoe UI'";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(kicker || "실시간", OPPOSITE_BILLBOARD_BASE_WIDTH * 0.5, 102);

    context.fillStyle = "#f2f8ff";
    context.font = "800 78px 'Bahnschrift'";
    this.drawBillboardWrappedText(
      context,
      title || "메가 OX 퀴즈",
      OPPOSITE_BILLBOARD_BASE_WIDTH * 0.5,
      206,
      OPPOSITE_BILLBOARD_BASE_WIDTH - 180,
      74,
      2
    );

    const baseY = 372;
    context.fillStyle = "#d9e9ff";
    context.font = "700 46px 'Segoe UI'";
    for (let index = 0; index < lines.length; index += 1) {
      this.drawBillboardWrappedText(
        context,
        lines[index],
        OPPOSITE_BILLBOARD_BASE_WIDTH * 0.5,
        baseY + index * 92,
        OPPOSITE_BILLBOARD_BASE_WIDTH - 210,
        54,
        2
      );
    }

    if (footer) {
      context.fillStyle = "#add0f0";
      context.font = "600 36px 'Segoe UI'";
      context.fillText(footer, OPPOSITE_BILLBOARD_BASE_WIDTH * 0.5, OPPOSITE_BILLBOARD_BASE_HEIGHT - 56);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);

    texture.needsUpdate = true;
    this.applyOppositeBillboardMode();
  }

  getQuizAliveCountEstimate() {
    const rosterAlive = this.roomRoster.reduce((count, entry) => {
      if (!entry || entry.spectator === true || entry.admitted === false) {
        return count;
      }
      return count + (entry.alive !== false ? 1 : 0);
    }, 0);
    if (rosterAlive > 0) {
      return rosterAlive;
    }
    const survivorCount = Math.max(0, Math.trunc(Number(this.quizState?.survivors) || 0));
    if (survivorCount > 0) {
      return survivorCount;
    }
    return Math.max(0, Math.trunc(Number(this.entryGateState?.admittedPlayers) || 0));
  }

  buildQuizProgressBillboardPayload() {
    const active = Boolean(this.quizState.active);
    const phase = String(this.quizState.phase ?? "idle");
    const phaseKor = this.formatQuizPhase(phase);
    const questionIndex = Math.max(0, Math.trunc(Number(this.quizState.questionIndex) || 0));
    const totalQuestions = Math.max(0, Math.trunc(Number(this.quizState.totalQuestions) || 0));
    const roundLabel = totalQuestions > 0 ? `${questionIndex}/${totalQuestions}` : `${questionIndex}/?`;
    const admittedFromGate = Math.max(0, Math.trunc(Number(this.entryGateState?.admittedPlayers) || 0));
    const spectatorFromGate = Math.max(0, Math.trunc(Number(this.entryGateState?.spectatorPlayers) || 0));
    const totalFromGate = admittedFromGate + spectatorFromGate;
    const roster = Array.isArray(this.roomRoster) ? this.roomRoster : [];
    const rosterNonHost = roster.filter((entry) => entry && entry.isHost !== true);
    const totalFromRoster = rosterNonHost.length;
    const spectatorFromRoster = rosterNonHost.reduce(
      (count, entry) => count + (entry?.spectator === true ? 1 : 0),
      0
    );
    const aliveFromRoster = rosterNonHost.reduce((count, entry) => {
      if (entry?.spectator === true) {
        return count;
      }
      return count + (entry?.alive !== false ? 1 : 0);
    }, 0);
    const hasGateCounts = totalFromGate > 0;
    const totalCount = hasGateCounts ? totalFromGate : totalFromRoster;
    const spectatorCount = hasGateCounts ? spectatorFromGate : spectatorFromRoster;

    let aliveCount;
    if (hasGateCounts) {
      const survivorCount = Math.max(0, Math.trunc(Number(this.quizState?.survivors) || 0));
      if (!active) {
        aliveCount = admittedFromGate;
      } else if (
        (phase === "start" || phase === "question" || phase === "lock" || phase === "waiting-next") &&
        survivorCount <= 0
      ) {
        aliveCount = admittedFromGate;
      } else {
        aliveCount = Math.min(admittedFromGate, survivorCount);
      }
    } else {
      aliveCount = aliveFromRoster;
    }
    const eliminatedCount = Math.max(0, totalCount - spectatorCount - Math.max(0, aliveCount));

    const payload = {
      kicker: "진행 현황",
      title: `라운드 ${roundLabel} · ${phaseKor}`,
      lines: [
        `전체 ${totalCount}명`,
        `생존 ${aliveCount}명`,
        `탈락 ${eliminatedCount}명`,
        `관전 ${spectatorCount}명`
      ],
      footer: ""
    };

    if (!active) {
      const autoSeconds = this.getAutoStartCountdownSeconds();
      if (phase === "ended") {
        payload.kicker = "라운드 종료";
        payload.title = "다음 라운드 준비";
      } else if (autoSeconds > 0) {
        payload.kicker = "자동 시작";
        payload.title = `라운드 ${roundLabel} · ${autoSeconds}초 후 시작`;
      } else {
        payload.kicker = "대기";
        payload.title = "입장/시작 대기";
      }
      return payload;
    }

    if (phase === "start") {
      const seconds = this.getQuizPrepareSeconds();
      payload.title = `라운드 ${roundLabel} · 시작 준비 ${seconds}초`;
      return payload;
    }

    if (phase === "question") {
      const seconds = this.getQuizCountdownSeconds();
      payload.title = `라운드 ${roundLabel} · 제한 시간 ${seconds}초`;
      return payload;
    }

    if (phase === "lock" || phase === "waiting-next" || phase === "result") {
      return payload;
    }

    return payload;
  }

  renderQuizProgressBillboard(force = false) {
    this.renderOppositeBillboard(this.buildQuizProgressBillboardPayload(), force);
  }

  clearCenterBillboard() {
    if (this.centerBillboardGroup) {
      this.scene.remove(this.centerBillboardGroup);
      disposeMeshTree(this.centerBillboardGroup);
      this.centerBillboardGroup = null;
    }
    if (this.centerBillboardTexture) {
      this.centerBillboardTexture.dispose();
    }
    this.centerBillboardTexture = null;
    this.centerBillboardScreenMaterial = null;
    this.centerBillboardCanvas = null;
    this.centerBillboardContext = null;
    this.centerBillboardLastSignature = "";
    this.centerBillboardLastCountdown = null;
  }

  setupCenterBillboard(config = {}) {
    this.clearCenterBillboard();
    if (!config?.enabled) {
      return;
    }

    const width = Math.max(10, Number(config.width) || 26);
    const height = Math.max(4, Number(config.height) || 9);
    const position = parseVec3(config.position, [0, 0, 0]);
    const heading = Number(config.heading) || 0;
    const boardCenterY = Math.max(3.2, Number(config.centerY) || 8.6);
    const poleHeight = Math.max(4, Number(config.poleHeight) || boardCenterY - 0.25);
    const lines = Array.isArray(config.lines) && config.lines.length > 0
      ? config.lines
      : ["메가 OX 퀴즈", "진행 대기 중"];

    const canvas = document.createElement("canvas");
    const billboardScale = this.mobileEnabled ? 0.5 : 0.75;
    canvas.width = Math.max(512, Math.round(CENTER_BILLBOARD_BASE_WIDTH * billboardScale));
    canvas.height = Math.max(256, Math.round(CENTER_BILLBOARD_BASE_HEIGHT * billboardScale));
    const context = canvas.getContext("2d");
    this.centerBillboardCanvas = canvas;
    this.centerBillboardContext = context;

    const panelTexture = new THREE.CanvasTexture(canvas);
    panelTexture.colorSpace = THREE.SRGBColorSpace;
    panelTexture.minFilter = THREE.LinearFilter;
    panelTexture.magFilter = THREE.LinearFilter;
    panelTexture.generateMipmaps = false;
    this.centerBillboardTexture = panelTexture;

    const group = new THREE.Group();
    group.position.set(position.x, position.y, position.z);
    group.rotation.y = heading;

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.9, height + 0.9, 0.52),
      new THREE.MeshStandardMaterial({
        color: config.frameColor ?? 0x2e3640,
        roughness: 0.54,
        metalness: 0.42,
        emissive: 0x101722,
        emissiveIntensity: 0.2
      })
    );
    frame.position.y = boardCenterY;
    frame.castShadow = !this.mobileEnabled;
    frame.receiveShadow = true;
    group.add(frame);

    const screenMaterial = new THREE.MeshStandardMaterial({
      map: panelTexture,
      emissive: 0x3f7fc3,
      emissiveIntensity: Number(config.screenGlow) || 0.34,
      roughness: 0.32,
      metalness: 0.08
    });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, height), screenMaterial);
    screen.position.y = boardCenterY;
    screen.position.z = 0.28;
    group.add(screen);

    const screenBack = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.32, height + 0.32, 0.28),
      new THREE.MeshStandardMaterial({
        color: 0x161d27,
        roughness: 0.8,
        metalness: 0.22
      })
    );
    screenBack.position.y = boardCenterY;
    screenBack.position.z = -0.32;
    screenBack.castShadow = !this.mobileEnabled;
    screenBack.receiveShadow = true;
    group.add(screenBack);

    const poleMaterial = new THREE.MeshStandardMaterial({
      color: config.poleColor ?? 0x606a76,
      roughness: 0.76,
      metalness: 0.3,
      emissive: 0x1f2a36,
      emissiveIntensity: 0.12
    });
    const poleOffsetX = width * 0.34;
    const poleTopY = poleHeight * 0.5;
    const leftPole = new THREE.Mesh(new THREE.BoxGeometry(0.92, poleHeight, 0.92), poleMaterial);
    leftPole.position.set(-poleOffsetX, poleTopY, -0.26);
    leftPole.castShadow = !this.mobileEnabled;
    leftPole.receiveShadow = true;
    group.add(leftPole);
    const rightPole = new THREE.Mesh(new THREE.BoxGeometry(0.92, poleHeight, 0.92), poleMaterial);
    rightPole.position.set(poleOffsetX, poleTopY, -0.26);
    rightPole.castShadow = !this.mobileEnabled;
    rightPole.receiveShadow = true;
    group.add(rightPole);

    const basePad = new THREE.Mesh(
      new THREE.CylinderGeometry(width * 0.2, width * 0.22, 0.4, this.mobileEnabled ? 16 : 26),
      new THREE.MeshStandardMaterial({
        color: 0x505a66,
        roughness: 0.86,
        metalness: 0.1,
        emissive: 0x1b232d,
        emissiveIntensity: 0.08
      })
    );
    basePad.position.set(0, 0.2, -0.18);
    basePad.receiveShadow = true;
    group.add(basePad);

    this.centerBillboardGroup = group;
    this.scene.add(this.centerBillboardGroup);
    this.centerBillboardScreenMaterial = screenMaterial;
    this.renderCenterBillboard({
      kicker: "실시간",
      title: lines[0] ?? "메가 OX 퀴즈",
      lines: lines.slice(1),
      footer: "진행자 대기 중"
    });
    this.applyCenterBillboardMode();
  }

  renderCenterBillboard(payload = {}) {
    const context = this.centerBillboardContext;
    const canvas = this.centerBillboardCanvas;
    if (!context || !canvas || !this.centerBillboardTexture) {
      return;
    }

    const layout = String(payload.layout ?? "default").trim().toLowerCase();
    const explanationLayout = layout === "explanation";
    const kicker = String(payload.kicker ?? "실시간").trim().slice(0, 32);
    const title = String(payload.title ?? "메가 OX 퀴즈").trim().slice(0, 90);
    const footer = String(payload.footer ?? "").trim().slice(0, 80);
    const lineSource = Array.isArray(payload.lines) ? payload.lines : [];
    const lines = lineSource
      .map((line) => String(line ?? "").trim())
      .filter(Boolean)
      .slice(0, explanationLayout ? 1 : 4);
    const explanationText = String(payload.explanation ?? lines[0] ?? "").trim().slice(0, 720);
    const signature = `${layout}|${kicker}|${title}|${footer}|${lines.join("||")}|${explanationText}`;
    if (signature === this.centerBillboardLastSignature) {
      return;
    }
    this.centerBillboardLastSignature = signature;

    const scaleX = canvas.width / CENTER_BILLBOARD_BASE_WIDTH;
    const scaleY = canvas.height / CENTER_BILLBOARD_BASE_HEIGHT;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    const gradient = context.createLinearGradient(0, 0, 0, CENTER_BILLBOARD_BASE_HEIGHT);
    gradient.addColorStop(0, "#0d141d");
    gradient.addColorStop(0.55, "#151f2d");
    gradient.addColorStop(1, "#0d141d");
    context.fillStyle = gradient;
    context.fillRect(0, 0, CENTER_BILLBOARD_BASE_WIDTH, CENTER_BILLBOARD_BASE_HEIGHT);

    context.strokeStyle = "rgba(140, 190, 255, 0.6)";
    context.lineWidth = 18;
    context.strokeRect(22, 22, CENTER_BILLBOARD_BASE_WIDTH - 44, CENTER_BILLBOARD_BASE_HEIGHT - 44);

    context.fillStyle = "#89ccff";
    context.font = "700 48px 'Segoe UI'";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(kicker || "실시간", CENTER_BILLBOARD_BASE_WIDTH * 0.5, 82);

    context.fillStyle = "#f3f8ff";
    context.font = explanationLayout ? "800 54px 'Bahnschrift'" : "800 60px 'Bahnschrift'";
    this.drawBillboardWrappedText(
      context,
      title || "메가 OX 퀴즈",
      CENTER_BILLBOARD_BASE_WIDTH * 0.5,
      explanationLayout ? 150 : 168,
      CENTER_BILLBOARD_BASE_WIDTH - 120,
      explanationLayout ? 56 : 66,
      2
    );

    if (explanationLayout) {
      context.fillStyle = "#dbe9ff";
      context.font = "700 34px 'Segoe UI'";
      this.drawBillboardWrappedText(
        context,
        explanationText || "해설이 없습니다.",
        CENTER_BILLBOARD_BASE_WIDTH * 0.5,
        304,
        CENTER_BILLBOARD_BASE_WIDTH - 126,
        42,
        6
      );
    } else {
      const baseY = 282;
      context.fillStyle = "#dbe9ff";
      context.font = "700 42px 'Segoe UI'";
      for (let index = 0; index < lines.length; index += 1) {
        this.drawBillboardWrappedText(
          context,
          lines[index],
          CENTER_BILLBOARD_BASE_WIDTH * 0.5,
          baseY + index * 60,
          CENTER_BILLBOARD_BASE_WIDTH - 150,
          48,
          1
        );
      }
    }

    if (footer) {
      context.fillStyle = "#a7c8ee";
      context.font = "600 34px 'Segoe UI'";
      context.fillText(footer, CENTER_BILLBOARD_BASE_WIDTH * 0.5, CENTER_BILLBOARD_BASE_HEIGHT - 54);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);

    this.centerBillboardTexture.needsUpdate = true;
  }
  drawBillboardWrappedText(context, rawText, x, y, maxWidth, lineHeight, maxLines = 1) {
    const text = String(rawText ?? "").trim();
    if (!text) {
      return;
    }

    const hasWhitespace = /\s/.test(text);
    const words = hasWhitespace ? text.split(/\s+/) : Array.from(text);
    const joiner = hasWhitespace ? " " : "";
    const lines = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current}${joiner}${word}` : word;
      if (context.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else if (current) {
        lines.push(current);
        current = word;
      } else {
        lines.push(candidate);
        current = "";
      }
      if (lines.length >= maxLines) {
        break;
      }
    }
    if (current && lines.length < maxLines) {
      lines.push(current);
    }
    if (lines.length === 0) {
      lines.push(text.slice(0, 40));
    }

    const trimmed = lines.slice(0, maxLines);
    const startY = y - ((trimmed.length - 1) * lineHeight) / 2;
    for (let index = 0; index < trimmed.length; index += 1) {
      context.fillText(trimmed[index], x, startY + index * lineHeight);
    }
  }

  clearOxArenaVisuals() {
    if (this.oxArenaGroup) {
      this.scene.remove(this.oxArenaGroup);
      disposeMeshTree(this.oxArenaGroup);
      this.oxArenaGroup = null;
    }
    for (const texture of this.oxArenaTextures) {
      texture?.dispose?.();
    }
    this.oxArenaTextures.length = 0;
    this.oxTrapdoors.o = null;
    this.oxTrapdoors.x = null;
    this.oxTrapdoorAnim.active = false;
    this.oxTrapdoorAnim.loserSide = null;
    this.oxTrapdoorAnim.elapsed = 0;
  }

  createArenaTextMesh(text, options = {}) {
    const width = Math.max(6, Number(options.width) || 18);
    const height = Math.max(6, Number(options.height) || 18);
    const fontSize = Math.max(24, Number(options.fontSize) || 236);
    const textColor = options.textColor ?? "#f5f9ff";
    const strokeColor = options.strokeColor ?? "rgba(12, 22, 34, 0.7)";
    const shadowColor = options.shadowColor ?? "rgba(5, 8, 13, 0.5)";

    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `800 ${fontSize}px 'Bahnschrift'`;
    context.fillStyle = textColor;
    context.strokeStyle = strokeColor;
    context.lineWidth = Math.max(10, fontSize * 0.08);
    context.shadowColor = shadowColor;
    context.shadowBlur = Math.max(8, fontSize * 0.09);
    context.shadowOffsetY = Math.max(4, fontSize * 0.04);
    context.strokeText(String(text ?? "").slice(0, 24), canvas.width * 0.5, canvas.height * 0.5);
    context.fillText(String(text ?? "").slice(0, 24), canvas.width * 0.5, canvas.height * 0.5);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.oxArenaTextures.push(texture);

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: true
      })
    );
    mesh.renderOrder = 9;
    return mesh;
  }

  setupOxArenaVisuals(config = {}) {
    this.clearOxArenaVisuals();
    if (!config?.enabled) {
      return;
    }

    const group = new THREE.Group();
    const textY = Math.max(0.04, Number(config.textY) || 0.08);

    const createZonePlate = (zoneConfig = {}, fallbackCenterX = 0) => {
      const width = Math.max(20, Number(zoneConfig.width) || 62);
      const depth = Math.max(30, Number(zoneConfig.depth) || 110);
      const centerX = Number.isFinite(Number(zoneConfig.centerX)) ? Number(zoneConfig.centerX) : fallbackCenterX;
      const centerZ = Number.isFinite(Number(zoneConfig.centerZ)) ? Number(zoneConfig.centerZ) : 0;

      const trapdoor = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.96, 0.22, depth * 0.96),
        new THREE.MeshStandardMaterial({
          color: zoneConfig.trapdoorColor ?? zoneConfig.color ?? 0x3f586f,
          roughness: 0.76,
          metalness: 0.08,
          emissive: zoneConfig.trapdoorEmissive ?? zoneConfig.emissive ?? 0x1f2d3b,
          emissiveIntensity: 0.14
        })
      );
      trapdoor.position.set(centerX, -0.03, centerZ);
      trapdoor.receiveShadow = true;
      trapdoor.castShadow = !this.mobileEnabled;
      group.add(trapdoor);

      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(width, depth),
        new THREE.MeshStandardMaterial({
          color: zoneConfig.color ?? 0x3f586f,
          roughness: 0.84,
          metalness: 0.08,
          emissive: zoneConfig.emissive ?? 0x1f2d3b,
          emissiveIntensity: 0.2,
          transparent: true,
          opacity: 0.96
        })
      );
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(centerX, 0.07, centerZ);
      plate.receiveShadow = true;
      plate.renderOrder = 8;
      group.add(plate);

      const pit = new THREE.Mesh(
        new THREE.PlaneGeometry(width * 0.92, depth * 0.92),
        new THREE.MeshBasicMaterial({
          color: 0x08101a,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide
        })
      );
      pit.rotation.x = -Math.PI / 2;
      pit.position.set(centerX, -8.8, centerZ);
      pit.visible = false;
      group.add(pit);

      return { plate, trapdoor, pit, centerX, centerZ, width, depth };
    };

    const oZone = createZonePlate(config.oZone, -34);
    const xZone = createZonePlate(config.xZone, 34);

    this.oxTrapdoors.o = {
      mesh: oZone.trapdoor,
      pit: oZone.pit,
      closedY: oZone.trapdoor.position.y
    };
    this.oxTrapdoors.x = {
      mesh: xZone.trapdoor,
      pit: xZone.pit,
      closedY: xZone.trapdoor.position.y
    };
    this.oxTrapdoorAnim.active = false;
    this.oxTrapdoorAnim.loserSide = null;
    this.oxTrapdoorAnim.elapsed = 0;

    const dividerWidth = Math.max(0.8, Number(config.dividerWidth) || 2.2);
    const dividerDepth = Math.max(Math.max(oZone.depth, xZone.depth), Number(config.dividerDepth) || 112);
    const dividerHeight = Math.max(0.08, Number(config.dividerHeight) || 0.22);
    const divider = new THREE.Mesh(
      new THREE.BoxGeometry(dividerWidth, dividerHeight, dividerDepth),
      new THREE.MeshStandardMaterial({
        color: config.dividerColor ?? 0x1f252d,
        roughness: 0.64,
        metalness: 0.28,
        emissive: 0x0f1319,
        emissiveIntensity: 0.18
      })
    );
    divider.position.set(0, dividerHeight * 0.5 + 0.025, 0);
    divider.castShadow = !this.mobileEnabled;
    divider.receiveShadow = true;
    group.add(divider);

    const oLetter = this.createArenaTextMesh("O", {
      width: Math.max(10, oZone.width * 0.56),
      height: Math.max(10, oZone.width * 0.56),
      fontSize: 520,
      textColor: "#e9fff5",
      strokeColor: "rgba(14, 59, 38, 0.9)"
    });
    if (oLetter) {
      oLetter.rotation.x = -Math.PI / 2;
      oLetter.position.set(oZone.centerX, textY, oZone.centerZ);
      group.add(oLetter);
    }

    const xLetter = this.createArenaTextMesh("X", {
      width: Math.max(10, xZone.width * 0.56),
      height: Math.max(10, xZone.width * 0.56),
      fontSize: 520,
      textColor: "#ffeef0",
      strokeColor: "rgba(78, 20, 26, 0.9)"
    });
    if (xLetter) {
      xLetter.rotation.x = -Math.PI / 2;
      xLetter.position.set(xZone.centerX, textY, xZone.centerZ);
      group.add(xLetter);
    }

    const zoneMinX = Math.min(
      oZone.centerX - oZone.width * 0.5,
      xZone.centerX - xZone.width * 0.5
    );
    const zoneMaxX = Math.max(
      oZone.centerX + oZone.width * 0.5,
      xZone.centerX + xZone.width * 0.5
    );
    const zoneSpanX = zoneMaxX - zoneMinX;

    const backWallConfig = config.backWall ?? {};
    const backWallEnabled = backWallConfig?.enabled !== false;
    let backWallMetrics = null;
    if (backWallEnabled) {
      const maxDepth = Math.max(oZone.depth, xZone.depth, dividerDepth);
      const wallWidth = Math.max(18, Number(backWallConfig.width) || zoneSpanX + 12);
      const wallHeight = Math.max(6, Number(backWallConfig.height) || 16);
      const wallThickness = Math.max(0.5, Number(backWallConfig.thickness) || 1.5);
      const wallCenterX = Number.isFinite(Number(backWallConfig.centerX))
        ? Number(backWallConfig.centerX)
        : 0;
      const wallCenterY = Number.isFinite(Number(backWallConfig.centerY))
        ? Number(backWallConfig.centerY)
        : wallHeight * 0.5;
      const wallCenterZ = Number.isFinite(Number(backWallConfig.centerZ))
        ? Number(backWallConfig.centerZ)
        : -(maxDepth * 0.5 + wallThickness * 0.5 + 3.2);

      const backWall = new THREE.Mesh(
        new THREE.BoxGeometry(wallWidth, wallHeight, wallThickness),
        new THREE.MeshStandardMaterial({
          color: backWallConfig.color ?? 0x56606c,
          roughness: Number(backWallConfig.roughness) || 0.86,
          metalness: Number(backWallConfig.metalness) || 0.06,
          emissive: backWallConfig.emissive ?? 0x1d2631,
          emissiveIntensity: Number(backWallConfig.emissiveIntensity) || 0.12
        })
      );
      backWall.position.set(wallCenterX, wallCenterY, wallCenterZ);
      backWall.castShadow = !this.mobileEnabled;
      backWall.receiveShadow = true;
      group.add(backWall);

      backWallMetrics = {
        width: wallWidth,
        height: wallHeight,
        thickness: wallThickness,
        centerX: wallCenterX,
        centerY: wallCenterY,
        centerZ: wallCenterZ
      };
    }

    const adsConfig = config.ads ?? {};
    if (backWallMetrics && adsConfig?.enabled) {
      const columns = Math.max(1, Math.min(8, Math.floor(Number(adsConfig.columns) || 4)));
      const rows = Math.max(1, Math.min(4, Math.floor(Number(adsConfig.rows) || 2)));
      const marginX = Math.max(0, Number(adsConfig.marginX) || 2.8);
      const gapXRaw = Math.max(0.25, Number(adsConfig.gapX) || 1.2);
      const gapY = Math.max(0.2, Number(adsConfig.gapY) || 1.1);
      const usableWidth = Math.max(6, backWallMetrics.width - marginX * 2);
      const gapXCap =
        columns > 1
          ? Math.max(0.05, (usableWidth - columns * 2.4) / (columns - 1))
          : gapXRaw;
      const gapX = Math.min(gapXRaw, gapXCap);
      const boardWidthBase = Number(adsConfig.boardWidth);
      const boardWidthFit = (usableWidth - gapX * (columns - 1)) / columns;
      const boardWidth = Math.max(
        2.6,
        Number.isFinite(boardWidthBase) ? boardWidthBase : boardWidthFit
      );
      const maxBoardWidth = Math.max(2.6, boardWidthFit);
      const finalBoardWidth = Math.min(boardWidth, maxBoardWidth);

      const boardHeightBase = Number(adsConfig.boardHeight);
      const usableHeight = Math.max(4.2, backWallMetrics.height * 0.72);
      const boardHeightFit = (usableHeight - gapY * (rows - 1)) / rows;
      const boardHeight = Math.max(
        1.8,
        Number.isFinite(boardHeightBase) ? boardHeightBase : boardHeightFit
      );
      const maxBoardHeight = Math.max(1.8, boardHeightFit);
      const finalBoardHeight = Math.min(boardHeight, maxBoardHeight);
      const centerY = Number.isFinite(Number(adsConfig.centerY))
        ? Number(adsConfig.centerY)
        : backWallMetrics.centerY + backWallMetrics.height * 0.13;
      const centerX = Number.isFinite(Number(adsConfig.centerX))
        ? Number(adsConfig.centerX)
        : backWallMetrics.centerX;
      const offsetZ = Math.max(0.04, Number(adsConfig.offsetZ) || 0.08);
      const boardZ = backWallMetrics.centerZ + backWallMetrics.thickness * 0.5 + offsetZ;
      const frameThickness = Math.max(0.06, Number(adsConfig.frameThickness) || 0.2);

      const textureUrl = String(adsConfig.textureUrl ?? "").trim();
      let adTexture = null;
      if (textureUrl) {
        try {
          adTexture = this.textureLoader.load(textureUrl);
          adTexture.colorSpace = THREE.SRGBColorSpace;
          adTexture.minFilter = THREE.LinearFilter;
          adTexture.magFilter = THREE.LinearFilter;
          adTexture.generateMipmaps = true;
          this.oxArenaTextures.push(adTexture);
        } catch (error) {
          adTexture = null;
        }
      }

      const frameMaterial = new THREE.MeshStandardMaterial({
        color: adsConfig.frameColor ?? 0x1b222b,
        roughness: 0.78,
        metalness: 0.14,
        emissive: 0x10151c,
        emissiveIntensity: 0.12
      });
      const panelMaterial = new THREE.MeshStandardMaterial({
        color: adTexture ? 0xffffff : 0x8c98a4,
        map: adTexture ?? null,
        roughness: 0.44,
        metalness: 0.08,
        emissive: 0x1a2735,
        emissiveIntensity: adTexture ? 0.18 : 0.08
      });

      const startX = centerX - ((columns - 1) * (finalBoardWidth + gapX)) * 0.5;
      const startY = centerY + ((rows - 1) * (finalBoardHeight + gapY)) * 0.5;

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x = startX + column * (finalBoardWidth + gapX);
          const y = startY - row * (finalBoardHeight + gapY);

          const frame = new THREE.Mesh(
            new THREE.BoxGeometry(
              finalBoardWidth + 0.42,
              finalBoardHeight + 0.42,
              frameThickness
            ),
            frameMaterial
          );
          frame.position.set(x, y, boardZ - frameThickness * 0.5);
          frame.castShadow = !this.mobileEnabled;
          frame.receiveShadow = true;
          group.add(frame);

          const panel = new THREE.Mesh(
            new THREE.PlaneGeometry(finalBoardWidth, finalBoardHeight),
            panelMaterial
          );
          panel.position.set(x, y, boardZ + 0.012);
          panel.castShadow = false;
          panel.receiveShadow = false;
          panel.renderOrder = 9;
          group.add(panel);
        }
      }
    }

    this.oxArenaGroup = group;
    this.scene.add(this.oxArenaGroup);
  }

  resetTrapdoors() {
    const entries = [this.oxTrapdoors.o, this.oxTrapdoors.x];
    for (const entry of entries) {
      if (!entry?.mesh) {
        continue;
      }
      entry.mesh.visible = true;
      entry.mesh.position.y = entry.closedY;
      entry.mesh.rotation.x = 0;
      if (entry.pit) {
        entry.pit.visible = false;
        const pitMaterial = entry.pit.material;
        if (pitMaterial) {
          pitMaterial.opacity = 0.22;
        }
      }
    }
    this.oxTrapdoorAnim.active = false;
    this.oxTrapdoorAnim.loserSide = null;
    this.oxTrapdoorAnim.elapsed = 0;
  }

  triggerTrapdoorForAnswer(answer) {
    const normalized = String(answer ?? "").trim().toUpperCase();
    const loserSide = normalized === "O" ? "x" : normalized === "X" ? "o" : null;
    if (!loserSide) {
      return;
    }
    const loser = this.oxTrapdoors[loserSide];
    if (!loser?.mesh) {
      return;
    }
    this.resetTrapdoors();
    if (loser.pit) {
      loser.pit.visible = true;
    }
    this.oxTrapdoorAnim.active = true;
    this.oxTrapdoorAnim.loserSide = loserSide;
    this.oxTrapdoorAnim.elapsed = 0;
    this.oxTrapdoorAnim.duration = 1.05;
  }

  updateTrapdoorAnimation(delta) {
    if (!this.oxTrapdoorAnim.active) {
      return;
    }
    const side = this.oxTrapdoorAnim.loserSide;
    const loser = side ? this.oxTrapdoors[side] : null;
    if (!loser?.mesh) {
      this.oxTrapdoorAnim.active = false;
      return;
    }

    this.oxTrapdoorAnim.elapsed += delta;
    const t = THREE.MathUtils.clamp(
      this.oxTrapdoorAnim.elapsed / Math.max(0.2, this.oxTrapdoorAnim.duration),
      0,
      1
    );
    const eased = 1 - Math.pow(1 - t, 3);
    loser.mesh.position.y = loser.closedY - eased * 11.5;
    loser.mesh.rotation.x = -eased * 0.28;
    if (loser.pit?.material) {
      loser.pit.material.opacity = 0.22 + eased * 0.56;
    }
    if (t >= 1) {
      this.oxTrapdoorAnim.active = false;
    }
  }

  clearChalkLayer() {
    if (this.chalkLayer) {
      this.scene.remove(this.chalkLayer);
      this.chalkLayer.clear();
      this.chalkLayer = null;
    }
    for (const material of this.chalkMaterials.values()) {
      material.dispose?.();
    }
    this.chalkMaterials.clear();
    this.chalkStampGeometry?.dispose?.();
    this.chalkStampGeometry = null;
    this.chalkStampTexture?.dispose?.();
    this.chalkStampTexture = null;
    this.chalkMarks.length = 0;
    this.chalkDrawingActive = false;
    this.chalkLastStamp = null;
  }

  setupChalkLayer(config = {}) {
    this.clearChalkLayer();
    if (!config?.enabled) {
      return;
    }

    this.chalkLayer = new THREE.Group();
    this.chalkLayer.renderOrder = 6;
    this.scene.add(this.chalkLayer);

    const textureUrl = String(
      config.textureUrl ?? "/assets/graphics/world/textures/oss-chalk/disc.png"
    ).trim();
    if (textureUrl) {
      this.chalkStampTexture = this.textureLoader.load(textureUrl);
      this.chalkStampTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.chalkStampTexture.wrapT = THREE.ClampToEdgeWrapping;
    }
    this.chalkStampGeometry = new THREE.CircleGeometry(1, this.mobileEnabled ? 10 : 14);
  }

  getChalkMaterial(color, opacity) {
    const key = `${String(color).toLowerCase()}|${Number(opacity).toFixed(2)}`;
    if (this.chalkMaterials.has(key)) {
      return this.chalkMaterials.get(key);
    }
    const material = new THREE.MeshBasicMaterial({
      color,
      alphaMap: this.chalkStampTexture ?? null,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -1
    });
    material.toneMapped = false;
    this.chalkMaterials.set(key, material);
    return material;
  }

  canDrawChalk() {
    if (!this.canUseGameplayControls()) {
      return false;
    }
    if (this.activeTool !== "chalk") {
      return false;
    }
    if (!this.worldContent?.chalk?.enabled || !this.chalkLayer || !this.chalkStampGeometry) {
      return false;
    }
    if (this.chatOpen) {
      return false;
    }
    if (!this.mobileEnabled && !this.pointerLocked) {
      return false;
    }
    return true;
  }

  tryDrawChalkMark() {
    if (!this.canDrawChalk()) {
      return false;
    }

    this.chalkRaycaster.setFromCamera(this.chalkPointer, this.camera);
    if (!this.chalkRaycaster.ray.intersectPlane(this.chalkGroundPlane, this.chalkHitPoint)) {
      return false;
    }

    const limit = this.playerBoundsHalfExtent;
    if (Math.abs(this.chalkHitPoint.x) > limit || Math.abs(this.chalkHitPoint.z) > limit) {
      return false;
    }

    const chalkConfig = this.worldContent?.chalk ?? {};
    const minDistance = Math.max(
      0.02,
      Number(chalkConfig.minDistance) || RUNTIME_TUNING.CHALK_MIN_STAMP_DISTANCE
    );
    if (
      this.chalkLastStamp &&
      this.chalkLastStamp.distanceToSquared(this.chalkHitPoint) < minDistance * minDistance
    ) {
      return false;
    }

    const sizeMin = Math.max(
      0.04,
      Number(chalkConfig.markSizeMin) || RUNTIME_TUNING.CHALK_MARK_SIZE_MIN
    );
    const sizeMax = Math.max(
      sizeMin,
      Number(chalkConfig.markSizeMax) || RUNTIME_TUNING.CHALK_MARK_SIZE_MAX
    );
    const size = sizeMin + Math.random() * Math.max(0.001, sizeMax - sizeMin);

    const markHeight =
      Number(chalkConfig.markHeight) || RUNTIME_TUNING.CHALK_MARK_HEIGHT;
    const markOpacity = THREE.MathUtils.clamp(
      Number(chalkConfig.markOpacity) || RUNTIME_TUNING.CHALK_MARK_OPACITY,
      0.1,
      1
    );

    const mark = new THREE.Mesh(
      this.chalkStampGeometry,
      this.getChalkMaterial(this.selectedChalkColor, markOpacity)
    );
    mark.rotation.x = -Math.PI / 2;
    mark.rotation.z = Math.random() * Math.PI * 2;
    mark.position.set(
      this.chalkHitPoint.x,
      markHeight + Math.random() * 0.0015,
      this.chalkHitPoint.z
    );
    mark.scale.set(size, size, 1);
    mark.frustumCulled = false;
    mark.renderOrder = 6;

    this.chalkLayer.add(mark);
    this.chalkMarks.push(mark);

    const maxMarks = Math.max(
      40,
      Number(chalkConfig.maxMarks) || RUNTIME_TUNING.CHALK_MAX_MARKS
    );
    while (this.chalkMarks.length > maxMarks) {
      const oldest = this.chalkMarks.shift();
      if (oldest) {
        this.chalkLayer.remove(oldest);
      }
    }

    if (!this.chalkLastStamp) {
      this.chalkLastStamp = new THREE.Vector3();
    }
    this.chalkLastStamp.copy(this.chalkHitPoint);
    return true;
  }

  updateChalkDrawing() {
    if (!this.chalkDrawingActive) {
      return;
    }
    this.tryDrawChalkMark();
  }

  clearBeachLayer() {
    if (this.beach) {
      this.scene.remove(this.beach);
      this.beach.geometry?.dispose?.();
      this.beach.material?.map?.dispose?.();
      this.beach.material?.normalMap?.dispose?.();
      this.beach.material?.roughnessMap?.dispose?.();
      this.beach.material?.aoMap?.dispose?.();
      this.beach.material?.dispose?.();
      this.beach = null;
    }
    if (this.shoreFoam) {
      this.scene.remove(this.shoreFoam);
      this.shoreFoam.geometry?.dispose?.();
      this.shoreFoam.material?.dispose?.();
      this.shoreFoam = null;
    }
    if (this.shoreWetBand) {
      this.scene.remove(this.shoreWetBand);
      this.shoreWetBand.geometry?.dispose?.();
      this.shoreWetBand.material?.dispose?.();
      this.shoreWetBand = null;
    }
  }

  setupBeachLayer(config = {}, oceanConfig = {}) {
    this.clearBeachLayer();
    if (!config?.enabled) {
      return;
    }

    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const anisotropy = this.mobileEnabled ? Math.min(2, maxAnisotropy) : Math.min(8, maxAnisotropy);
    const loadTiledTexture = (url, repeatX, repeatY, colorSpace = null) => {
      if (!url) {
        return null;
      }
      const texture = this.textureLoader.load(url);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeatX, repeatY);
      texture.anisotropy = anisotropy;
      if (colorSpace) {
        texture.colorSpace = colorSpace;
      }
      return texture;
    };

    const width = Math.max(40, Number(config.width) || 7800);
    const depth = Math.max(60, Number(config.depth) || 220000);
    const shoreDirectionRaw = Number(config.shoreDirection ?? oceanConfig.shoreDirection ?? 1);
    const shoreDirection = shoreDirectionRaw < 0 ? -1 : 1;
    const shorelineCandidate = Number(config.shorelineX ?? oceanConfig.shorelineX);
    const explicitCenterX = Number(config.positionX);
    const hasCenterX = Number.isFinite(explicitCenterX);
    const beachCenterX = hasCenterX
      ? explicitCenterX
      : Number.isFinite(shorelineCandidate)
        ? shorelineCandidate - shoreDirection * width * 0.5
        : 12000 - shoreDirection * width * 0.5;
    const shorelineX = Number.isFinite(shorelineCandidate)
      ? shorelineCandidate
      : beachCenterX + shoreDirection * width * 0.5;
    const explicitZ = Number(config.positionZ ?? oceanConfig.positionZ);
    const beachZ = Number.isFinite(explicitZ) ? explicitZ : 0;
    const repeatX = Number(config.repeatX) || 56;
    const repeatY = Number(config.repeatY) || 950;

    const beachMap = loadTiledTexture(config.textureUrl, repeatX, repeatY, THREE.SRGBColorSpace);
    const beachNormal = loadTiledTexture(config.normalTextureUrl, repeatX, repeatY);
    const beachRoughness = loadTiledTexture(config.roughnessTextureUrl, repeatX, repeatY);
    const beachAo = loadTiledTexture(config.aoTextureUrl, repeatX, repeatY);

    const beachGeometry = new THREE.PlaneGeometry(width, depth, 1, 1);
    const uv = beachGeometry.getAttribute("uv");
    if (uv) {
      beachGeometry.setAttribute("uv2", new THREE.Float32BufferAttribute(Array.from(uv.array), 2));
    }

    const normalScale = Array.isArray(config.normalScale)
      ? new THREE.Vector2(
          Number(config.normalScale[0]) || 1,
          Number(config.normalScale[1]) || Number(config.normalScale[0]) || 1
        )
      : new THREE.Vector2(1, 1);

    const beach = new THREE.Mesh(
      beachGeometry,
      new THREE.MeshStandardMaterial({
        color: config.color ?? 0xd9c08a,
        map: beachMap ?? null,
        normalMap: beachNormal ?? null,
        normalScale,
        roughnessMap: beachRoughness ?? null,
        aoMap: beachAo ?? null,
        aoMapIntensity: Number(config.aoIntensity) || 0.32,
        roughness: Number(config.roughness) || 0.93,
        metalness: Number(config.metalness) || 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        side: THREE.FrontSide
      })
    );
    beach.rotation.x = -Math.PI / 2;
    beach.position.set(
      beachCenterX,
      Number(config.positionY) || 0.025,
      beachZ
    );
    beach.receiveShadow = true;
    beach.renderOrder = 4;
    beach.frustumCulled = false;
    this.beach = beach;
    this.scene.add(this.beach);

    const foamWidth = Math.max(40, Number(config.foamWidth) || 220);
    const foam = new THREE.Mesh(
      new THREE.PlaneGeometry(foamWidth, depth, 1, 1),
      new THREE.MeshBasicMaterial({
        color: config.foamColor ?? 0xe8f7ff,
        transparent: true,
        opacity: Number(config.foamOpacity) || 0.46,
        depthWrite: false,
        depthTest: false
      })
    );
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(
      shorelineX + shoreDirection * foamWidth * 0.4,
      beach.position.y + 0.015,
      beachZ
    );
    foam.userData.baseOpacity = foam.material.opacity;
    foam.userData.elapsed = 0;
    foam.material.toneMapped = false;
    foam.renderOrder = 7;
    foam.frustumCulled = false;
    this.shoreFoam = foam;
    this.scene.add(this.shoreFoam);

    const wetBandWidth = Math.max(60, Number(config.wetBandWidth) || 190);
    const wetBand = new THREE.Mesh(
      new THREE.PlaneGeometry(wetBandWidth, depth, 1, 1),
      new THREE.MeshBasicMaterial({
        color: config.wetBandColor ?? 0xc8a16a,
        transparent: true,
        opacity: Number(config.wetBandOpacity) || 0.28,
        depthWrite: false,
        depthTest: false
      })
    );
    wetBand.rotation.x = -Math.PI / 2;
    wetBand.position.set(
      shorelineX - shoreDirection * wetBandWidth * 0.32,
      beach.position.y + 0.01,
      beachZ
    );
    wetBand.userData.baseOpacity = wetBand.material.opacity;
    wetBand.userData.elapsed = 0;
    wetBand.material.toneMapped = false;
    wetBand.renderOrder = 6;
    wetBand.frustumCulled = false;
    this.shoreWetBand = wetBand;
    this.scene.add(this.shoreWetBand);
  }

  clearOceanLayer() {
    if (this.oceanBase) {
      this.scene.remove(this.oceanBase);
      this.oceanBase.geometry?.dispose?.();
      this.oceanBase.material?.dispose?.();
      this.oceanBase = null;
    }
    if (!this.ocean) {
      return;
    }
    const normalSampler = this.ocean.material?.uniforms?.normalSampler?.value;
    normalSampler?.dispose?.();
    this.scene.remove(this.ocean);
    this.ocean.geometry?.dispose?.();
    this.ocean.material?.dispose?.();
    this.ocean = null;
  }

  setupOceanLayer(config = {}) {
    this.clearOceanLayer();
    if (!config?.enabled) {
      return;
    }

    const width = Math.max(40, Number(config.width) || 120000);
    const depth = Math.max(60, Number(config.depth) || 220000);
    const shoreDirectionRaw = Number(config.shoreDirection ?? 1);
    const shoreDirection = shoreDirectionRaw < 0 ? -1 : 1;
    const shorelineX = Number(config.shorelineX);
    const explicitCenterX = Number(config.positionX);
    const centerX = Number.isFinite(explicitCenterX)
      ? explicitCenterX
      : Number.isFinite(shorelineX)
        ? shorelineX + shoreDirection * width * 0.5
        : 60000;
    const explicitZ = Number(config.positionZ);
    const centerZ = Number.isFinite(explicitZ) ? explicitZ : 0;
    const normalMapUrl =
      String(config.normalTextureUrl ?? "").trim() ||
      "/assets/graphics/world/textures/oss-water/waternormals.jpg";
    const normalMap = this.textureLoader.load(normalMapUrl);
    normalMap.wrapS = THREE.RepeatWrapping;
    normalMap.wrapT = THREE.RepeatWrapping;
    normalMap.repeat.set(Number(config.normalRepeatX) || 20, Number(config.normalRepeatY) || 20);
    normalMap.anisotropy = this.mobileEnabled ? 2 : 4;

    const water = new Water(new THREE.PlaneGeometry(width, depth), {
      textureWidth: this.mobileEnabled ? 512 : 1024,
      textureHeight: this.mobileEnabled ? 512 : 1024,
      waterNormals: normalMap,
      sunDirection: this.sunLight
        ? this.sunLight.position.clone().normalize()
        : new THREE.Vector3(0.4, 0.8, 0.2),
      sunColor: config.sunColor ?? 0xffffff,
      waterColor: config.color ?? 0x2f8ed9,
      distortionScale: Number(config.distortionScale) || 2.2,
      fog: Boolean(this.scene.fog),
      alpha: THREE.MathUtils.clamp(Number(config.opacity) || 0.92, 0.75, 1),
      side: THREE.FrontSide
    });

    water.rotation.x = -Math.PI / 2;
    water.position.set(
      centerX,
      Number(config.positionY) || 0.05,
      centerZ
    );
    water.receiveShadow = false;
    water.renderOrder = 3;
    water.frustumCulled = false;
    water.material.depthWrite = false;
    water.material.depthTest = true;
    water.userData.timeScale = Number(config.timeScale) || 0.33;
    water.userData.basePositionY = water.position.y;
    water.userData.bobAmplitude = Number(config.bobAmplitude) || 0.05;
    water.userData.bobFrequency = Number(config.bobFrequency) || 0.45;
    water.userData.elapsed = 0;
    water.userData.shorelineX = Number.isFinite(shorelineX)
      ? shorelineX
      : centerX - shoreDirection * width * 0.5;

    const oceanBase = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({
        color: config.color ?? 0x2f8ed9
      })
    );
    oceanBase.rotation.x = -Math.PI / 2;
    oceanBase.position.copy(water.position);
    oceanBase.position.y -= 0.018;
    oceanBase.renderOrder = 2;
    oceanBase.material.toneMapped = false;
    oceanBase.frustumCulled = false;
    this.oceanBase = oceanBase;
    this.scene.add(this.oceanBase);

    this.ocean = water;
    this.scene.add(this.ocean);
  }

  updateOcean(delta) {
    if (!this.ocean) {
      return;
    }
    const uniforms = this.ocean.material?.uniforms;
    if (!uniforms?.time) {
      return;
    }
    const deltaClamped = THREE.MathUtils.clamp(delta, 1 / 180, 1 / 24);
    this.waterDeltaSmoothed = THREE.MathUtils.lerp(this.waterDeltaSmoothed, deltaClamped, 0.18);
    const waterDelta = this.waterDeltaSmoothed;
    const timeScale = Number(this.ocean.userData.timeScale) || 0.33;
    uniforms.time.value += waterDelta * timeScale;

    this.ocean.userData.elapsed = (Number(this.ocean.userData.elapsed) || 0) + waterDelta;
    const amplitude = Number(this.ocean.userData.bobAmplitude) || 0;
    const frequency = Number(this.ocean.userData.bobFrequency) || 0;
    const baseY = Number(this.ocean.userData.basePositionY) || 0;
    if (amplitude > 0 && frequency > 0) {
      this.ocean.position.y = baseY + Math.sin(this.ocean.userData.elapsed * frequency) * amplitude;
    }

    if (this.shoreFoam?.material) {
      this.shoreFoam.userData.elapsed =
        (Number(this.shoreFoam.userData.elapsed) || 0) + waterDelta;
      const pulse = 0.85 + Math.sin(this.shoreFoam.userData.elapsed * 1.4) * 0.15;
      const baseOpacity = Number(this.shoreFoam.userData.baseOpacity) || 0.42;
      this.shoreFoam.material.opacity = THREE.MathUtils.clamp(baseOpacity * pulse, 0.08, 0.95);
      this.shoreFoam.position.y = Math.max(this.ocean.position.y + 0.015, (this.beach?.position.y ?? 0) + 0.01);
    }
    if (this.shoreWetBand?.material) {
      this.shoreWetBand.userData.elapsed =
        (Number(this.shoreWetBand.userData.elapsed) || 0) + waterDelta;
      const pulse = 0.9 + Math.sin(this.shoreWetBand.userData.elapsed * 0.7) * 0.1;
      const baseOpacity = Number(this.shoreWetBand.userData.baseOpacity) || 0.28;
      this.shoreWetBand.material.opacity = THREE.MathUtils.clamp(baseOpacity * pulse, 0.06, 0.8);
      this.shoreWetBand.position.y = Math.max(
        this.ocean.position.y + 0.008,
        (this.beach?.position.y ?? 0) + 0.004
      );
    }
  }

  setupPostProcessing() {
    if (this.composer && typeof this.composer.dispose === "function") {
      this.composer.dispose();
    }

    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    const bloomConfig = this.worldContent?.postProcessing?.bloom;
    const bloomAllowedByQuality = quality !== "low";
    const bloomEnabled =
      bloomAllowedByQuality &&
      Boolean(bloomConfig?.enabled) &&
      (!this.mobileEnabled || Boolean(bloomConfig?.mobileEnabled));
    if (!bloomEnabled) {
      this.composer = null;
      this.bloomPass = null;
      return;
    }

    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(this.currentPixelRatio);

    const renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(renderPass);

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      Number(bloomConfig.strength) || 0.22,
      Number(bloomConfig.radius) || 0.62,
      Number(bloomConfig.threshold) || 0.86
    );
    composer.addPass(bloom);

    this.composer = composer;
    this.bloomPass = bloom;
    this.applyGraphicsPostProcessingProfile();
  }

  setupHands() {
    const hands = this.handContent;
    const pose = hands.pose ?? {};
    const shoulderX = Number(pose.shoulderX ?? 0.24);
    const shoulderY = Number(pose.shoulderY ?? -0.2);
    const shoulderZ = Number(pose.shoulderZ ?? -0.58);
    const elbowY = Number(pose.elbowY ?? -0.3);
    const elbowZ = Number(pose.elbowZ ?? -0.45);
    const handY = Number(pose.handY ?? -0.4);
    const handZ = Number(pose.handZ ?? -0.33);
    const upperArmRoll = Number(pose.upperArmRoll ?? 0.42);
    const forearmRoll = Number(pose.forearmRoll ?? 0.22);
    const bendX = Number(pose.bendX ?? 0.16);

    const group = new THREE.Group();

    const skin = new THREE.MeshStandardMaterial({
      color: hands.skin.color,
      roughness: hands.skin.roughness,
      metalness: hands.skin.metalness,
      emissive: hands.skin.emissive,
      emissiveIntensity: hands.skin.emissiveIntensity
    });

    const sleeve = new THREE.MeshStandardMaterial({
      color: hands.sleeve.color,
      roughness: hands.sleeve.roughness,
      metalness: hands.sleeve.metalness,
      emissive: hands.sleeve.emissive,
      emissiveIntensity: hands.sleeve.emissiveIntensity
    });

    const upperArmGeometry = new THREE.CapsuleGeometry(0.055, 0.2, 6, 10);
    const forearmGeometry = new THREE.CapsuleGeometry(0.05, 0.2, 6, 10);
    const palmGeometry = new THREE.SphereGeometry(0.078, 10, 8);
    const fingerGeometry = new THREE.CapsuleGeometry(0.016, 0.07, 4, 6);
    const thumbGeometry = new THREE.CapsuleGeometry(0.02, 0.075, 4, 6);

    const buildArm = (side) => {
      const upperArm = new THREE.Mesh(upperArmGeometry, sleeve);
      upperArm.position.set(side * shoulderX, shoulderY, shoulderZ);
      upperArm.rotation.x = bendX;
      upperArm.rotation.z = -side * upperArmRoll;
      upperArm.castShadow = true;

      const forearm = new THREE.Mesh(forearmGeometry, sleeve);
      forearm.position.set(side * (shoulderX + 0.03), elbowY, elbowZ);
      forearm.rotation.x = bendX + 0.05;
      forearm.rotation.z = -side * forearmRoll;
      forearm.castShadow = true;

      const palm = new THREE.Mesh(palmGeometry, skin);
      palm.position.set(side * (shoulderX + 0.05), handY, handZ);
      palm.scale.set(1.12, 0.76, 1.26);
      palm.rotation.x = bendX + 0.09;
      palm.castShadow = true;

      const thumb = new THREE.Mesh(thumbGeometry, skin);
      thumb.position.set(side * (shoulderX + 0.1), handY - 0.005, handZ - 0.01);
      thumb.rotation.x = 0.52;
      thumb.rotation.z = -side * 0.86;
      thumb.castShadow = true;

      const fingerOffsets = [
        [0.03, 0.026],
        [0.012, 0.04],
        [-0.008, 0.048]
      ];
      const fingers = fingerOffsets.map((offset) => {
        const finger = new THREE.Mesh(fingerGeometry, skin);
        finger.position.set(
          side * (shoulderX + offset[0]),
          handY - 0.022,
          handZ + offset[1]
        );
        finger.rotation.x = 0.36;
        finger.rotation.z = -side * 0.15;
        finger.castShadow = true;
        return finger;
      });

      group.add(upperArm, forearm, palm, thumb, ...fingers);
    };

    buildArm(1);
    buildArm(-1);
    group.position.set(0, 0, 0);
    group.rotation.x = hands.groupRotationX;

    this.handView = group;
    this.camera.add(this.handView);
  }

  bindEvents() {
    this.resolveUiElements();

    window.addEventListener("resize", () => {
      this.onResize();
      this.scheduleMobileKeyboardInsetSync(24);
    });
    if (window.visualViewport) {
      const handleViewportChange = () => {
        this.scheduleMobileKeyboardInsetSync(0);
      };
      window.visualViewport.addEventListener("resize", handleViewportChange, { passive: true });
      window.visualViewport.addEventListener("scroll", handleViewportChange, { passive: true });
    }
    window.addEventListener(
      "pointerdown",
      (event) => {
        const pointerType = String(event?.pointerType ?? "").toLowerCase();
        if (pointerType !== "touch" && pointerType !== "pen") {
          return;
        }
        this.requestAppFullscreen({ fromGesture: true });
        this.tryLockLandscapeOrientation();
        this.mobileModeLocked = true;
        if (!this.mobileEnabled) {
          this.mobileEnabled = true;
          this.onResize();
        } else {
          this.bindMobileControlEvents();
          this.updateMobileControlUi();
        }
      },
      { passive: true }
    );

    window.addEventListener("keydown", (event) => {
      this.kickMegaAdVideoPlayback();
      this.resumeMediaAudioContext();
      if (this.isTextInputTarget(event.target)) {
        if (event.code === "Escape") {
          this.setChatOpen(false);
          event.target.blur?.();
        }
        return;
      }
      if (event.code === "Escape" && this.settingsPanelOpen) {
        event.preventDefault();
        this.setSettingsPanelOpen(false);
        return;
      }
      if (event.code === "Escape" && this.isOfflineStartModalOpen()) {
        event.preventDefault();
        this.closeOfflineStartModal();
        return;
      }
      if (event.code === "KeyE" && !event.repeat && !this.isOfflineStartModalOpen()) {
        const handled = this.tryOpenOfflineStartFromWorld();
        if (handled) {
          event.preventDefault();
          return;
        }
      }

      if (event.code === "Tab") {
        event.preventDefault();
        this.setRosterTabVisible(true);
        return;
      }

      if (
        (event.code === RUNTIME_TUNING.CHAT_OPEN_KEY || event.code === "Enter") &&
        this.chatInputEl &&
        !this.chatOpen &&
        this.canUseGameplayControls()
      ) {
        event.preventDefault();
        this.focusChatInput();
        return;
      }

      if (event.code === "KeyV" && this.localSpectatorMode) {
        event.preventDefault();
        this.cycleSpectatorTarget();
        return;
      }

      if (event.code === "KeyC" && this.localSpectatorMode) {
        event.preventDefault();
        this.toggleSpectatorViewMode();
        return;
      }

      if (event.code === "KeyX" && this.localSpectatorMode) {
        event.preventDefault();
        const released = this.clearSpectatorFollowTarget(true);
        if (!released) {
          this.appendChatLine("시스템", "이미 자유 관전 모드입니다.", "system");
        }
        return;
      }

      if (event.code === "KeyZ" && this.isLocalHost()) {
        event.preventDefault();
        this.toggleHostSpectatorModeOverride();
        return;
      }

      if (MOVEMENT_KEY_CODES.has(event.code)) {
        event.preventDefault();
      }

      if (!this.canMovePlayer()) {
        return;
      }

      if (event.code === "KeyB" && this.canUseGameplayControls()) {
        event.preventDefault();
        this.setActiveTool(this.activeTool === "chalk" ? "move" : "chalk");
        return;
      }

      const colorIndex = this.canUseGameplayControls() ? this.getColorDigitIndex(event.code) : -1;
      if (colorIndex >= 0) {
        this.setChalkColorByIndex(colorIndex);
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
      }

      this.keys.add(event.code);
      if (event.code === "Space" && this.onGround) {
        this.verticalVelocity = GAME_CONSTANTS.JUMP_FORCE;
        this.onGround = false;
      }
    });

    window.addEventListener("keyup", (event) => {
      if (this.isTextInputTarget(event.target)) {
        return;
      }
      if (event.code === "Tab") {
        event.preventDefault();
        this.setRosterTabVisible(false);
        return;
      }
      if (MOVEMENT_KEY_CODES.has(event.code)) {
        event.preventDefault();
      }
      this.keys.delete(event.code);
    });

    window.addEventListener("blur", () => {
      this.keys.clear();
      this.releaseMobileInputs();
      this.setRosterTabVisible(false);
      this.chalkDrawingActive = false;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") {
        this.resumeMediaAudioContext();
        this.requestSocketReconnect();
        return;
      }
      this.keys.clear();
      this.releaseMobileInputs();
      this.setRosterTabVisible(false);
      this.chalkDrawingActive = false;
      this.chalkLastStamp = null;
    });
    window.addEventListener("pagehide", () => {
      this.keys.clear();
      this.releaseMobileInputs();
      this.setRosterTabVisible(false);
      this.chalkDrawingActive = false;
      this.chalkLastStamp = null;
    });
    window.addEventListener("pageshow", () => {
      this.resumeMediaAudioContext();
      this.requestSocketReconnect();
    });
    window.addEventListener("online", () => {
      this.requestSocketReconnect();
    });

    this.renderer.domElement.addEventListener("click", (event) => {
      this.kickMegaAdVideoPlayback();
      this.resumeMediaAudioContext();
      if (this.offlineStartNearby === true) {
        const handled = this.tryOpenOfflineStartFromWorld();
        if (handled) {
          event?.preventDefault?.();
          return;
        }
      }
      this.tryPointerLock();
    });
    this.renderer.domElement.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !this.canDrawChalk()) {
        return;
      }
      this.chalkDrawingActive = true;
      this.chalkLastStamp = null;
      this.tryDrawChalkMark();
    });
    window.addEventListener("mouseup", (event) => {
      if (event.button !== 0) {
        return;
      }
      this.chalkDrawingActive = false;
      this.chalkLastStamp = null;
    });

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
      this.hud.setStatus(this.getStatusText());
      if (!this.pointerLocked) {
        this.chalkDrawingActive = false;
        this.chalkLastStamp = null;
      }
    });

    const handleFullscreenChange = () => {
      const active = this.isFullscreenActive();
      this.fullscreenPending = this.mobileEnabled && !active;
      if (this.fullscreenPending) {
        window.setTimeout(() => this.requestAppFullscreen(), 120);
      }
      this.syncSettingsPanelUi();
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    window.addEventListener(
      "mousemove",
      (event) => {
        if (!this.pointerLocked) {
          return;
        }
        const sensitivityX = 0.0023;
        const sensitivityY = 0.002;
        if (Math.abs(event.movementX) > 0.001 || Math.abs(event.movementY) > 0.001) {
          this.lastLookInputAt = performance.now();
        }
        this.yaw -= event.movementX * sensitivityX;
        this.pitch -= event.movementY * sensitivityY;
        this.pitch = THREE.MathUtils.clamp(this.pitch, -1.52, 1.52);
      },
      { passive: true }
    );

    if (this.chatInputEl) {
      this.chatInputEl.addEventListener("focus", () => {
        this.keys.clear();
        this.setChatOpen(true);
        this.scheduleMobileKeyboardInsetSync(0);
        this.scheduleMobileKeyboardInsetSync(180);
      });
      this.chatInputEl.addEventListener("keydown", (event) => {
        if (event.code === "Enter") {
          if (event.repeat) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          this.sendChatMessage();
          return;
        }
        if (event.code === "Escape") {
          event.preventDefault();
          this.setChatOpen(false);
          this.chatInputEl.blur();
        }
      });
      this.chatInputEl.addEventListener("blur", () => {
        this.scheduleMobileKeyboardInsetSync(80);
        if (!this.mobileEnabled) {
          this.setChatOpen(false);
          return;
        }
        // On mobile, let tap/click handlers run first (e.g. send button) before collapsing the panel.
        window.setTimeout(() => {
          if (!this.mobileEnabled || this.chatSendInFlight) {
            return;
          }
          const activeEl = document.activeElement;
          const interactingWithChatButton =
            activeEl === this.chatSendBtnEl || activeEl === this.chatHideBtnEl || activeEl === this.chatCloseBtnEl;
          if (interactingWithChatButton) {
            return;
          }
          this.setChatOpen(false);
          this.mobileChatPanelVisible = false;
          this.applyMobileChatUi();
        }, 0);
      });
    }
    this.chatLogEl?.addEventListener("click", () => {
      if (this.mobileEnabled && !this.mobileChatPanelVisible) {
        return;
      }
      if (!this.chatOpen && this.canUseGameplayControls()) {
        this.focusChatInput();
      }
    });
    this.chatUiEl?.addEventListener("click", (event) => {
      if (this.chatOpen || !this.canUseGameplayControls()) {
        return;
      }
      const clickedControl = event?.target?.closest?.("#chat-close-btn, #chat-hide-btn, #chat-send-btn");
      if (clickedControl) {
        return;
      }
      this.focusChatInput();
    });
    const closeChatUi = () => {
      if (this.mobileEnabled) {
        this.hideMobileChatPanel();
        return;
      }
      this.setChatOpen(false);
      this.chatInputEl?.blur?.();
    };
    this.chatSendBtnEl?.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.mobileEnabled) {
          return;
        }
        event.preventDefault();
        this.sendChatMessage();
      },
      { passive: false }
    );
    this.chatSendBtnEl?.addEventListener("click", (event) => {
      event.preventDefault();
      if (this.mobileEnabled) {
        return;
      }
      this.sendChatMessage();
    });
    this.chatHideBtnEl?.addEventListener("click", (event) => {
      event.preventDefault();
      closeChatUi();
    });
    this.chatCloseBtnEl?.addEventListener("click", (event) => {
      event.preventDefault();
      closeChatUi();
    });
    this.settingsBtnEl?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setSettingsPanelOpen(!this.settingsPanelOpen);
    });
    this.settingsFullscreenBtnEl?.addEventListener("click", (event) => {
      event.preventDefault();
      this.toggleFullscreenFromInteraction();
      this.setSettingsPanelOpen(false);
    });
    this.settingsVolumeSliderEl?.addEventListener("input", () => {
      this.setUiVolume(this.settingsVolumeSliderEl.value, { persist: true });
    });
    for (const qualityBtn of this.settingsQualityBtnEls) {
      qualityBtn?.addEventListener("click", (event) => {
        event.preventDefault();
        const quality = String(qualityBtn?.dataset?.quality ?? "");
        this.setGraphicsQuality(quality, { persist: true });
      });
    }
    document.addEventListener("pointerdown", (event) => {
      if (!this.settingsPanelOpen) {
        return;
      }
      const target = event?.target instanceof Node ? event.target : null;
      if (!target) {
        this.setSettingsPanelOpen(false);
        return;
      }
      const clickedButton = this.settingsBtnEl?.contains?.(target);
      const clickedPanel = this.settingsPanelEl?.contains?.(target);
      if (!clickedButton && !clickedPanel) {
        this.setSettingsPanelOpen(false);
      }
    });

    if (this.toolHotbarEl) {
      this.toolHotbarEl.addEventListener("click", (event) => {
        const button = event.target?.closest?.(".tool-slot[data-tool]");
        if (!button) {
          return;
        }
        this.setActiveTool(String(button.dataset.tool || "move"));
      });
    }

    if (this.chalkColorsEl) {
      this.chalkColorsEl.addEventListener("click", (event) => {
        const button = event.target?.closest?.(".chalk-color[data-color]");
        if (!button) {
          return;
        }
        this.setChalkColor(String(button.dataset.color || this.selectedChalkColor));
      });
    }

    this.quizHostBtnEl?.addEventListener("click", () => {
      this.requestHostClaim();
    });
    this.quizStartBtnEl?.addEventListener("click", () => {
      this.requestQuizStart();
    });
    this.quizStopBtnEl?.addEventListener("click", () => {
      this.requestQuizStop();
    });
    this.quizConfigBtnEl?.addEventListener("click", () => {
      this.openQuizConfigModal();
    });
    this.quizReviewBtnEl?.addEventListener("click", () => {
      this.openQuizReviewModal();
    });
    this.offlineStartTriggerBtnEl?.addEventListener("click", (event) => {
      event.preventDefault();
      this.tryOpenOfflineStartFromWorld();
    });
    this.offlineStartCloseBtnEl?.addEventListener("click", () => {
      this.closeOfflineStartModal();
    });
    this.offlineStartModalEl?.addEventListener("click", (event) => {
      if (event.target === this.offlineStartModalEl) {
        this.closeOfflineStartModal();
      }
    });
    this.offlineStartQuestionStartBtnEl?.addEventListener("click", () => {
      this.requestOfflineStartSelectedQuestion();
    });
    for (const categoryBtn of this.offlineStartCategoryBtnEls) {
      categoryBtn?.addEventListener("click", () => {
        const categoryId = String(categoryBtn?.dataset?.category ?? "").trim();
        this.prepareOfflineStartCategory(categoryId);
      });
    }
    this.portalLobbyOpenBtnEl?.addEventListener("click", () => {
      this.requestPortalLobbyOpen();
    });
    this.portalLobbyStartBtnEl?.addEventListener("click", () => {
      this.requestPortalLobbyStart();
    });
    this.quizPrevBtnEl?.addEventListener("click", () => {
      this.requestQuizPrev();
    });
    this.quizNextBtnEl?.addEventListener("click", () => {
      this.requestQuizNext();
    });
    this.quizLockBtnEl?.addEventListener("click", () => {
      this.requestQuizLock();
    });
    this.moderationPanelToggleBtnEl?.addEventListener("click", () => {
      this.toggleModerationPanel();
    });
    this.moderationPlayerSelectEl?.addEventListener("change", () => {
      this.updateQuizControlUi();
    });
    this.moderationKickBtnEl?.addEventListener("click", () => {
      this.requestHostKickPlayer();
    });
    this.moderationMuteBtnEl?.addEventListener("click", () => {
      this.requestHostSetChatMuted(true);
    });
    this.moderationUnmuteBtnEl?.addEventListener("click", () => {
      this.requestHostSetChatMuted(false);
    });
    this.portalTargetSaveBtnEl?.addEventListener("click", () => {
      this.requestPortalTargetSave();
    });
    this.quizConfigCloseBtnEl?.addEventListener("click", () => {
      this.closeQuizConfigModal();
    });
    this.quizConfigSaveBtnEl?.addEventListener("click", () => {
      this.requestQuizConfigSave();
    });
    this.quizConfigResetBtnEl?.addEventListener("click", () => {
      this.resetQuizConfigEditor();
    });
    this.quizCategoryTukgalLoadBtnEl?.addEventListener("click", () => {
      this.loadQuizCategory("특갤");
    });
    this.quizCategoryTukgalSaveBtnEl?.addEventListener("click", () => {
      this.saveQuizCategory("특갤");
    });
    this.quizCategoryHistoryLoadBtnEl?.addEventListener("click", () => {
      this.loadQuizCategory("역사상식");
    });
    this.quizCategoryHistorySaveBtnEl?.addEventListener("click", () => {
      this.saveQuizCategory("역사상식");
    });
    this.quizCategoryHistoryEasyLoadBtnEl?.addEventListener("click", () => {
      this.loadQuizCategory("역사기초");
    });
    this.quizCategoryHistoryEasySaveBtnEl?.addEventListener("click", () => {
      this.saveQuizCategory("역사기초");
    });
    this.quizCategoryGeneralLoadBtnEl?.addEventListener("click", () => {
      this.loadQuizCategory("일반상식");
    });
    this.quizCategoryGeneralSaveBtnEl?.addEventListener("click", () => {
      this.saveQuizCategory("일반상식");
    });
    this.quizCategoryChokaguyaLoadBtnEl?.addEventListener("click", () => {
      this.loadQuizCategory("초카구야");
    });
    this.quizCategoryChokaguyaSaveBtnEl?.addEventListener("click", () => {
      this.saveQuizCategory("초카구야");
    });
    this.quizQuickApplyBtnEl?.addEventListener("click", () => {
      this.requestQuickQuizSetupApply();
    });
    this.quizCategoryVoteBtnEl?.addEventListener("click", () => {
      this.requestCategoryVoteStart();
    });
    this.categoryVoteOptionsEl?.addEventListener("click", (event) => {
      const optionButton = event.target?.closest?.(".category-vote-option[data-option-id]");
      if (!optionButton) {
        return;
      }
      const optionId = String(optionButton.dataset.optionId ?? "").trim();
      this.requestCategoryVoteCast(optionId);
    });
    this.billboardMediaApplyBtnEl?.addEventListener("click", () => {
      this.requestBillboardMediaApply(false);
    });
    this.billboardMediaPlayBtnEl?.addEventListener("click", () => {
      this.requestBillboardMediaPlaybackControl("play");
    });
    this.billboardMediaPauseBtnEl?.addEventListener("click", () => {
      this.requestBillboardMediaPlaybackControl("pause");
    });
    this.billboardMediaClearBtnEl?.addEventListener("click", () => {
      this.requestBillboardMediaApply(true);
    });
    this.billboardPlaylistLoadBtnEl?.addEventListener("click", () => {
      this.requestBillboardPlaylistLoad();
    });
    this.billboardPlaylistPlayBtnEl?.addEventListener("click", () => {
      this.requestBillboardPlaylistControl("play");
    });
    this.billboardPlaylistPauseBtnEl?.addEventListener("click", () => {
      this.requestBillboardPlaylistControl("pause");
    });
    this.billboardPlaylistPrevBtnEl?.addEventListener("click", () => {
      this.requestBillboardPlaylistControl("prev");
    });
    this.billboardPlaylistNextBtnEl?.addEventListener("click", () => {
      this.requestBillboardPlaylistControl("next");
    });
    this.billboardPlaylistSelectBtnEl?.addEventListener("click", () => {
      this.requestBillboardPlaylistControl("select");
    });
    this.billboardPlaylistAutoInputEl?.addEventListener("change", () => {
      this.requestBillboardPlaylistAutoAdvanceUpdate();
    });
    this.quizSlotCountInputEl?.addEventListener("change", () => {
      this.applyQuizSlotCountChange();
    });
    this.quizSlotCountInputEl?.addEventListener("input", () => {
      this.applyQuizSlotCountChange();
    });
    this.quizTimeUnifyInputEl?.addEventListener("change", () => {
      const normalized = this.normalizeQuizTimeLimitSeconds(
        this.quizTimeUnifyInputEl?.value,
        QUIZ_DEFAULT_TIME_LIMIT_SECONDS
      );
      this.quizTimeUnifyInputEl.value = String(normalized);
    });
    this.quizTimeUnifyApplyBtnEl?.addEventListener("click", () => {
      this.applyQuizTimeLimitToAllQuestions();
    });
    this.quizQuestionListEl?.addEventListener("input", () => {
      this.persistQuizConfigDraft({ immediate: false, updateState: true });
    });
    this.quizQuestionListEl?.addEventListener("change", () => {
      this.persistQuizConfigDraft({ immediate: false, updateState: true });
    });
    this.quizAutoFinishInputEl?.addEventListener("change", () => {
      this.persistQuizConfigDraft({ immediate: false, updateState: true });
    });
    this.quizOppositeBillboardInputEl?.addEventListener("change", () => {
      this.persistQuizConfigDraft({ immediate: false, updateState: true });
    });
    this.quizReviewCloseBtnEl?.addEventListener("click", () => {
      this.closeQuizReviewModal();
    });
    this.quizReviewPrevBtnEl?.addEventListener("click", () => {
      this.moveQuizReview(-1);
    });
    this.quizReviewNextBtnEl?.addEventListener("click", () => {
      this.moveQuizReview(1);
    });
    this.lobbyFormEl?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.requestLobbyJoin();
    });
    this.bindMobileControlEvents();
    this.updateMobileControlUi();
  }

  resolveUiElements() {
    if (!this.toolUiEl) {
      this.toolUiEl = document.getElementById("tool-ui");
    }
    if (!this.chatUiEl) {
      this.chatUiEl = document.getElementById("chat-ui");
    }
    if (!this.settingsBtnEl) {
      this.settingsBtnEl = document.getElementById("settings-btn");
    }
    if (!this.settingsPanelEl) {
      this.settingsPanelEl = document.getElementById("settings-panel");
    }
    if (!this.settingsVolumeSliderEl) {
      this.settingsVolumeSliderEl = document.getElementById("sp-volume");
    }
    if (!this.settingsFullscreenBtnEl) {
      this.settingsFullscreenBtnEl = document.getElementById("sp-fullscreen-btn");
    }
    if (!this.orientationLockOverlayEl) {
      this.orientationLockOverlayEl = document.getElementById("orientation-lock-overlay");
    }
    if (!this.quizControlsEl) {
      this.quizControlsEl = document.getElementById("quiz-controls");
    }
    if (!this.quizHostBtnEl) {
      this.quizHostBtnEl = document.getElementById("quiz-host-btn");
    }
    if (!this.quizStartBtnEl) {
      this.quizStartBtnEl = document.getElementById("quiz-start-btn");
    }
    if (!this.quizStopBtnEl) {
      this.quizStopBtnEl = document.getElementById("quiz-stop-btn");
    }
    if (!this.quizConfigBtnEl) {
      this.quizConfigBtnEl = document.getElementById("quiz-config-btn");
    }
    if (!this.quizReviewBtnEl) {
      this.quizReviewBtnEl = document.getElementById("quiz-review-btn");
    }
    if (!this.quizQuickCategorySelectEl) {
      this.quizQuickCategorySelectEl = document.getElementById("quiz-quick-category-select");
    }
    if (!this.quizQuickTimeInputEl) {
      this.quizQuickTimeInputEl = document.getElementById("quiz-quick-time-input");
    }
    if (!this.quizQuickApplyBtnEl) {
      this.quizQuickApplyBtnEl = document.getElementById("quiz-quick-apply-btn");
    }
    if (!this.quizCategoryVoteBtnEl) {
      this.quizCategoryVoteBtnEl = document.getElementById("quiz-category-vote-btn");
    }
    if (!this.portalLobbyOpenBtnEl) {
      this.portalLobbyOpenBtnEl = document.getElementById("portal-open-btn");
    }
    if (!this.portalLobbyStartBtnEl) {
      this.portalLobbyStartBtnEl = document.getElementById("portal-admit-btn");
    }
    if (!this.quizPrevBtnEl) {
      this.quizPrevBtnEl = document.getElementById("quiz-prev-btn");
    }
    if (!this.quizNextBtnEl) {
      this.quizNextBtnEl = document.getElementById("quiz-next-btn");
    }
    if (!this.quizLockBtnEl) {
      this.quizLockBtnEl = document.getElementById("quiz-lock-btn");
    }
    if (!this.moderationPanelToggleBtnEl) {
      this.moderationPanelToggleBtnEl = document.getElementById("moderation-panel-toggle-btn");
    }
    if (!this.moderationPanelEl) {
      this.moderationPanelEl = document.getElementById("moderation-panel");
    }
    if (!this.moderationPlayerSelectEl) {
      this.moderationPlayerSelectEl = document.getElementById("moderation-player-select");
    }
    if (!this.moderationKickBtnEl) {
      this.moderationKickBtnEl = document.getElementById("moderation-kick-btn");
    }
    if (!this.moderationMuteBtnEl) {
      this.moderationMuteBtnEl = document.getElementById("moderation-mute-btn");
    }
    if (!this.moderationUnmuteBtnEl) {
      this.moderationUnmuteBtnEl = document.getElementById("moderation-unmute-btn");
    }
    if (!this.quizControlsNoteEl) {
      this.quizControlsNoteEl = document.getElementById("quiz-controls-note");
    }
    if (!this.portalTargetInputEl) {
      this.portalTargetInputEl = document.getElementById("portal-target-input");
    }
    if (!this.portalTargetSaveBtnEl) {
      this.portalTargetSaveBtnEl = document.getElementById("portal-target-save-btn");
    }
    if (!this.hubFlowUiEl) {
      this.hubFlowUiEl = document.getElementById("hub-flow-ui");
    }
    if (!this.hubPhaseTitleEl) {
      this.hubPhaseTitleEl = document.getElementById("hub-phase-title");
    }
    if (!this.hubPhaseSubtitleEl) {
      this.hubPhaseSubtitleEl = document.getElementById("hub-phase-subtitle");
    }
    if (!this.nicknameGateEl) {
      this.nicknameGateEl = document.getElementById("nickname-gate");
    }
    if (!this.nicknameFormEl) {
      this.nicknameFormEl = document.getElementById("nickname-form");
    }
    if (!this.nicknameInputEl) {
      this.nicknameInputEl = document.getElementById("nickname-input");
    }
    if (!this.nicknameErrorEl) {
      this.nicknameErrorEl = document.getElementById("nickname-error");
    }
    if (!this.lobbyScreenEl) {
      this.lobbyScreenEl = document.getElementById("lobby-screen");
    }
    if (!this.lobbyFormEl) {
      this.lobbyFormEl = document.getElementById("lobby-form");
    }
    if (!this.lobbyNameInputEl) {
      this.lobbyNameInputEl = document.getElementById("lobby-name-input");
    }
    if (!this.lobbyJoinBtnEl) {
      this.lobbyJoinBtnEl = document.getElementById("lobby-join-btn");
    }
    if (!this.lobbyStatusEl) {
      this.lobbyStatusEl = document.getElementById("lobby-status");
    }
    if (!this.lobbyRoomCountEl) {
      this.lobbyRoomCountEl = document.getElementById("lobby-room-count");
    }
    if (!this.lobbyPlayerCountEl) {
      this.lobbyPlayerCountEl = document.getElementById("lobby-player-count");
    }
    if (!this.lobbyTopRoomEl) {
      this.lobbyTopRoomEl = document.getElementById("lobby-top-room");
    }
    if (!this.lobbySlotParticipantsEl) {
      this.lobbySlotParticipantsEl = document.getElementById("lobby-slot-participants");
    }
    if (!this.lobbySlotSpectatorsEl) {
      this.lobbySlotSpectatorsEl = document.getElementById("lobby-slot-spectators");
    }
    if (!this.portalTransitionEl) {
      this.portalTransitionEl = document.getElementById("portal-transition");
    }
    if (!this.portalTransitionTextEl) {
      this.portalTransitionTextEl = document.getElementById("portal-transition-text");
    }
    if (!this.quizConfigModalEl) {
      this.quizConfigModalEl = document.getElementById("quiz-config-modal");
    }
    if (!this.quizConfigCloseBtnEl) {
      this.quizConfigCloseBtnEl = document.getElementById("quiz-config-close-btn");
    }
    if (!this.quizConfigSaveBtnEl) {
      this.quizConfigSaveBtnEl = document.getElementById("quiz-config-save-btn");
    }
    if (!this.quizConfigResetBtnEl) {
      this.quizConfigResetBtnEl = document.getElementById("quiz-config-reset-btn");
    }
    if (!this.quizCategoryTukgalLoadBtnEl) {
      this.quizCategoryTukgalLoadBtnEl = document.getElementById("quiz-category-tukgal-load-btn");
    }
    if (!this.quizCategoryTukgalSaveBtnEl) {
      this.quizCategoryTukgalSaveBtnEl = document.getElementById("quiz-category-tukgal-save-btn");
    }
    if (!this.quizCategoryHistoryLoadBtnEl) {
      this.quizCategoryHistoryLoadBtnEl = document.getElementById("quiz-category-history-load-btn");
    }
    if (!this.quizCategoryHistorySaveBtnEl) {
      this.quizCategoryHistorySaveBtnEl = document.getElementById("quiz-category-history-save-btn");
    }
    if (!this.quizCategoryHistoryEasyLoadBtnEl) {
      this.quizCategoryHistoryEasyLoadBtnEl = document.getElementById("quiz-category-history-easy-load-btn");
    }
    if (!this.quizCategoryHistoryEasySaveBtnEl) {
      this.quizCategoryHistoryEasySaveBtnEl = document.getElementById("quiz-category-history-easy-save-btn");
    }
    if (!this.quizCategoryGeneralLoadBtnEl) {
      this.quizCategoryGeneralLoadBtnEl = document.getElementById("quiz-category-general-load-btn");
    }
    if (!this.quizCategoryGeneralSaveBtnEl) {
      this.quizCategoryGeneralSaveBtnEl = document.getElementById("quiz-category-general-save-btn");
    }
    if (!this.quizCategoryChokaguyaLoadBtnEl) {
      this.quizCategoryChokaguyaLoadBtnEl = document.getElementById("quiz-category-chokaguya-load-btn");
    }
    if (!this.quizCategoryChokaguyaSaveBtnEl) {
      this.quizCategoryChokaguyaSaveBtnEl = document.getElementById("quiz-category-chokaguya-save-btn");
    }
    if (!this.quizSlotCountInputEl) {
      this.quizSlotCountInputEl = document.getElementById("quiz-slot-count-input");
    }
    if (!this.quizTimeUnifyInputEl) {
      this.quizTimeUnifyInputEl = document.getElementById("quiz-time-unify-input");
    }
    if (!this.quizTimeUnifyApplyBtnEl) {
      this.quizTimeUnifyApplyBtnEl = document.getElementById("quiz-time-unify-apply-btn");
    }
    if (!this.quizAutoFinishInputEl) {
      this.quizAutoFinishInputEl = document.getElementById("quiz-auto-finish-input");
    }
    if (!this.quizOppositeBillboardInputEl) {
      this.quizOppositeBillboardInputEl = document.getElementById("quiz-opposite-billboard-input");
    }
    if (!this.quizQuestionListEl) {
      this.quizQuestionListEl = document.getElementById("quiz-question-list");
    }
    if (!this.quizConfigStatusEl) {
      this.quizConfigStatusEl = document.getElementById("quiz-config-status");
    }
    if (!this.billboardTargetSelectEl) {
      this.billboardTargetSelectEl = document.getElementById("billboard-target-select");
    }
    if (!this.billboardMediaPresetSelectEl) {
      this.billboardMediaPresetSelectEl = document.getElementById("billboard-media-preset-select");
    }
    if (!this.billboardMediaFileInputEl) {
      this.billboardMediaFileInputEl = document.getElementById("billboard-media-file-input");
    }
    if (!this.billboardMediaUrlInputEl) {
      this.billboardMediaUrlInputEl = document.getElementById("billboard-media-url-input");
    }
    if (!this.billboardMediaApplyBtnEl) {
      this.billboardMediaApplyBtnEl = document.getElementById("billboard-media-apply-btn");
    }
    if (!this.billboardMediaPlayBtnEl) {
      this.billboardMediaPlayBtnEl = document.getElementById("billboard-media-play-btn");
    }
    if (!this.billboardMediaPauseBtnEl) {
      this.billboardMediaPauseBtnEl = document.getElementById("billboard-media-pause-btn");
    }
    if (!this.billboardMediaClearBtnEl) {
      this.billboardMediaClearBtnEl = document.getElementById("billboard-media-clear-btn");
    }
    if (!this.billboardPlaylistInputEl) {
      this.billboardPlaylistInputEl = document.getElementById("billboard-playlist-input");
    }
    if (!this.billboardPlaylistLoadBtnEl) {
      this.billboardPlaylistLoadBtnEl = document.getElementById("billboard-playlist-load-btn");
    }
    if (!this.billboardPlaylistPlayBtnEl) {
      this.billboardPlaylistPlayBtnEl = document.getElementById("billboard-playlist-play-btn");
    }
    if (!this.billboardPlaylistPauseBtnEl) {
      this.billboardPlaylistPauseBtnEl = document.getElementById("billboard-playlist-pause-btn");
    }
    if (!this.billboardPlaylistPrevBtnEl) {
      this.billboardPlaylistPrevBtnEl = document.getElementById("billboard-playlist-prev-btn");
    }
    if (!this.billboardPlaylistNextBtnEl) {
      this.billboardPlaylistNextBtnEl = document.getElementById("billboard-playlist-next-btn");
    }
    if (!this.billboardPlaylistAutoInputEl) {
      this.billboardPlaylistAutoInputEl = document.getElementById("billboard-playlist-auto-input");
    }
    if (!this.billboardPlaylistIndexSelectEl) {
      this.billboardPlaylistIndexSelectEl = document.getElementById("billboard-playlist-index-select");
    }
    if (!this.billboardPlaylistSelectBtnEl) {
      this.billboardPlaylistSelectBtnEl = document.getElementById("billboard-playlist-select-btn");
    }
    if (!this.quizReviewModalEl) {
      this.quizReviewModalEl = document.getElementById("quiz-review-modal");
    }
    if (!this.quizReviewCloseBtnEl) {
      this.quizReviewCloseBtnEl = document.getElementById("quiz-review-close-btn");
    }
    if (!this.quizReviewPrevBtnEl) {
      this.quizReviewPrevBtnEl = document.getElementById("quiz-review-prev-btn");
    }
    if (!this.quizReviewNextBtnEl) {
      this.quizReviewNextBtnEl = document.getElementById("quiz-review-next-btn");
    }
    if (!this.quizReviewIndexEl) {
      this.quizReviewIndexEl = document.getElementById("quiz-review-index");
    }
    if (!this.quizReviewQuestionEl) {
      this.quizReviewQuestionEl = document.getElementById("quiz-review-question");
    }
    if (!this.quizReviewAnswerEl) {
      this.quizReviewAnswerEl = document.getElementById("quiz-review-answer");
    }
    if (!this.quizReviewExplanationEl) {
      this.quizReviewExplanationEl = document.getElementById("quiz-review-explanation");
    }
    if (!this.boundaryWarningEl) {
      this.boundaryWarningEl = document.getElementById("boundary-warning");
    }
    if (!this.roundOverlayEl) {
      this.roundOverlayEl = document.getElementById("round-overlay");
    }
    if (!this.roundOverlayCanvasEl) {
      this.roundOverlayCanvasEl = document.getElementById("round-overlay-canvas");
      this.roundOverlayCtx = this.roundOverlayCanvasEl?.getContext?.("2d") ?? null;
    }
    if (!this.roundOverlayTitleEl) {
      this.roundOverlayTitleEl = document.getElementById("round-overlay-title");
    }
    if (!this.roundOverlaySubtitleEl) {
      this.roundOverlaySubtitleEl = document.getElementById("round-overlay-subtitle");
    }
    if (!this.entryWaitOverlayEl) {
      this.entryWaitOverlayEl = document.getElementById("entry-wait-overlay");
    }
    if (!this.entryWaitTextEl) {
      this.entryWaitTextEl = document.getElementById("entry-wait-text");
    }
    if (!this.categoryVoteOverlayEl) {
      this.categoryVoteOverlayEl = document.getElementById("category-vote-overlay");
    }
    if (!this.categoryVoteTitleEl) {
      this.categoryVoteTitleEl = document.getElementById("category-vote-title");
    }
    if (!this.categoryVoteTimerEl) {
      this.categoryVoteTimerEl = document.getElementById("category-vote-timer");
    }
    if (!this.categoryVoteStatusEl) {
      this.categoryVoteStatusEl = document.getElementById("category-vote-status");
    }
    if (!this.categoryVoteOptionsEl) {
      this.categoryVoteOptionsEl = document.getElementById("category-vote-options");
    }
    if (!this.offlineStartHintEl) {
      this.offlineStartHintEl = document.getElementById("offline-start-hint");
    }
    if (!this.offlineStartHintTextEl) {
      this.offlineStartHintTextEl = document.getElementById("offline-start-hint-text");
    }
    if (!this.offlineStartTriggerBtnEl) {
      this.offlineStartTriggerBtnEl = document.getElementById("offline-start-trigger-btn");
    }
    if (!this.offlineStartModalEl) {
      this.offlineStartModalEl = document.getElementById("offline-start-modal");
    }
    if (!this.offlineStartCloseBtnEl) {
      this.offlineStartCloseBtnEl = document.getElementById("offline-start-close-btn");
    }
    if (!this.offlineStartSelectedCategoryEl) {
      this.offlineStartSelectedCategoryEl = document.getElementById("offline-start-selected-category");
    }
    if (!this.offlineStartQuestionSelectEl) {
      this.offlineStartQuestionSelectEl = document.getElementById("offline-start-question-select");
    }
    if (!this.offlineStartQuestionStartBtnEl) {
      this.offlineStartQuestionStartBtnEl = document.getElementById("offline-start-question-start-btn");
    }
    if (!this.offlineStartStatusEl) {
      this.offlineStartStatusEl = document.getElementById("offline-start-status");
    }
    if (!Array.isArray(this.offlineStartCategoryBtnEls) || this.offlineStartCategoryBtnEls.length <= 0) {
      this.offlineStartCategoryBtnEls = Array.from(
        document.querySelectorAll(".offline-start-category-btn")
      );
    }
    if (!this.playerRosterPanelEl) {
      this.playerRosterPanelEl = document.getElementById("player-roster-panel");
    }
    if (!this.rosterCountEl) {
      this.rosterCountEl = document.getElementById("roster-count");
    }
    if (!this.rosterSubtitleEl) {
      this.rosterSubtitleEl = document.getElementById("roster-subtitle");
    }
    if (!this.rosterListEl) {
      this.rosterListEl = document.getElementById("roster-list");
    }
    if (!this.mobileControlsEl) {
      this.mobileControlsEl = document.getElementById("mobile-controls");
    }
    if (!this.mobileMovePadEl) {
      this.mobileMovePadEl = document.getElementById("mobile-move-pad");
    }
    if (!this.mobileMoveThumbEl) {
      this.mobileMoveThumbEl = document.getElementById("mobile-move-thumb");
    }
    if (!this.mobileJumpBtnEl) {
      this.mobileJumpBtnEl = document.getElementById("mobile-jump-btn");
    }
    if (!this.mobileRunBtnEl) {
      this.mobileRunBtnEl = document.getElementById("mobile-run-btn");
    }
    if (!this.mobileRosterBtnEl) {
      this.mobileRosterBtnEl = document.getElementById("mobile-roster-btn");
    }
    if (!this.mobileChatToggleBtnEl) {
      this.mobileChatToggleBtnEl = document.getElementById("mobile-chat-toggle-btn");
    }
    if (!this.mobileChatPreviewEl) {
      this.mobileChatPreviewEl = document.getElementById("mobile-chat-preview");
    }
    if (!this.mobileLookPadEl) {
      this.mobileLookPadEl = document.getElementById("mobile-look-pad");
    }
    if (!this.chatLogEl) {
      this.chatLogEl = document.getElementById("chat-log");
    }
    if (!this.chatControlsEl) {
      this.chatControlsEl = document.getElementById("chat-controls");
    }
    if (!this.chatInputEl) {
      this.chatInputEl = document.getElementById("chat-input");
    }
    if (!this.chatSendBtnEl) {
      this.chatSendBtnEl = document.getElementById("chat-send-btn");
    }
    if (!this.chatHideBtnEl) {
      this.chatHideBtnEl = document.getElementById("chat-hide-btn");
    }
    if (!this.chatCloseBtnEl) {
      this.chatCloseBtnEl = document.getElementById("chat-close-btn");
    }
    if (!this.chatLiveFeedEl) {
      this.chatLiveFeedEl = document.getElementById("chat-live-feed");
    }
    if (!this.chatLiveLogEl) {
      this.chatLiveLogEl = document.getElementById("chat-live-log");
    }
    if (!this.toolHotbarEl) {
      this.toolHotbarEl = document.getElementById("tool-hotbar");
    }
    if (!this.chalkColorsEl) {
      this.chalkColorsEl = document.getElementById("chalk-colors");
    }
    this.settingsQualityBtnEls = Array.from(document.querySelectorAll(".sp-quality-btn[data-quality]"));
    this.chalkColorButtons = Array.from(document.querySelectorAll(".chalk-color[data-color]"));
    this.toolButtons = Array.from(document.querySelectorAll(".tool-slot[data-tool]"));
  }

  setupToolState() {
    const chalkConfig = this.worldContent?.chalk ?? {};
    const fallbackColors = ["#f5f7ff", "#ffd86a", "#7ec9ff", "#ff9cc5", "#a9f89f"];
    const configColors = Array.isArray(chalkConfig.colors) ? chalkConfig.colors : [];
    const sourceColors = configColors.length > 0 ? configColors : fallbackColors;
    this.chalkPalette = sourceColors
      .map((color) => {
        try {
          return `#${new THREE.Color(color).getHexString()}`;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (this.chalkPalette.length === 0) {
      this.chalkPalette = [...fallbackColors];
    }
    this.selectedChalkColor = this.chalkPalette[0] ?? fallbackColors[0];
    this.buildChalkPaletteButtons();
    this.setActiveTool("move");
    this.setChalkColor(this.selectedChalkColor);
  }

  buildChalkPaletteButtons() {
    if (!this.chalkColorsEl) {
      return;
    }

    this.chalkColorsEl.innerHTML = "";
    for (let index = 0; index < this.chalkPalette.length; index += 1) {
      const normalized = this.chalkPalette[index];

      const button = document.createElement("button");
      button.type = "button";
      button.className = "chalk-color";
      button.dataset.color = normalized;
      button.style.setProperty("--swatch", normalized);
      button.title = `${index + 1} ${normalized.toUpperCase()}`;
      this.chalkColorsEl.appendChild(button);
    }

    this.chalkColorButtons = Array.from(
      this.chalkColorsEl.querySelectorAll(".chalk-color[data-color]")
    );
  }

  getFallbackRosterEntries() {
    const entries = [];
    const localId = String(this.localPlayerId ?? "local");
    const localName = this.formatPlayerName(this.localPlayerName);
    entries.push({
      id: localId,
      name: localName,
      alive: this.localQuizAlive !== false,
      admitted: !this.localAdmissionWaiting,
      queuedForAdmission: this.localAdmissionWaiting,
      chatMuted: false,
      score: Math.max(0, Math.trunc(Number(this.quizState.myScore) || 0)),
      isHost: String(this.quizState.hostId ?? "") === String(this.localPlayerId ?? ""),
      spectator: Boolean(this.localSpectatorMode && this.isLocalHost()),
      isMe: true
    });

    for (const [id, remote] of this.remotePlayers.entries()) {
      const name = this.formatPlayerName(remote?.name);
      entries.push({
        id: String(id),
        name,
        alive: remote?.alive !== false,
        admitted: remote?.admitted !== false,
        queuedForAdmission: false,
        chatMuted: false,
        score: 0,
        isHost: String(this.quizState.hostId ?? "") === String(id),
        spectator: remote?.spectator === true,
        isMe: false
      });
    }
    return entries;
  }

  setRosterTabVisible(visible) {
    this.rosterVisibleByTab = Boolean(visible);
    if (this.rosterVisibleByTab) {
      this.refreshRosterPanel();
    }
    this.syncRosterVisibility();
  }

  setRosterPinned(visible) {
    this.rosterPinned = Boolean(visible);
    if (this.rosterPinned) {
      this.refreshRosterPanel();
    }
    this.syncRosterVisibility();
  }

  toggleRosterPinned() {
    this.setRosterPinned(!this.rosterPinned);
  }

  syncRosterVisibility() {
    const visible = this.rosterVisibleByTab || this.rosterPinned;
    this.playerRosterPanelEl?.classList.toggle("hidden", !visible);
    if (this.mobileRosterBtnEl) {
      this.mobileRosterBtnEl.classList.toggle("active", this.rosterPinned);
      this.mobileRosterBtnEl.textContent = this.rosterPinned ? "닫기" : "인원";
    }
    const mobileRosterFocus = this.mobileEnabled && visible;
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle("mobile-roster-focus", mobileRosterFocus);
    }
    if (mobileRosterFocus) {
      this.releaseMobileInputs();
      this.mobileLookPointerId = null;
      this.mobileLookPadEl?.classList.remove("active");
    }
  }

  refreshRosterPanel(players = null) {
    this.resolveUiElements();
    if (Array.isArray(players)) {
      this.roomRoster = players
        .map((player) => {
          const id = String(player?.id ?? "");
          if (!id) {
            return null;
          }
          const score = Math.max(0, Math.trunc(Number(player?.score) || 0));
          return {
            id,
            name: this.formatPlayerName(player?.name),
            alive: player?.alive !== false,
            admitted: player?.admitted !== false,
            queuedForAdmission: player?.queuedForAdmission === true,
            chatMuted: player?.chatMuted === true,
            score,
            isHost: id === String(this.quizState.hostId ?? ""),
            spectator: player?.spectator === true,
            isMe: id === String(this.localPlayerId ?? "")
          };
        })
        .filter(Boolean);
    }

    const source = this.roomRoster.length > 0 ? this.roomRoster : this.getFallbackRosterEntries();
    const roster = source.slice().sort((left, right) => {
      if (left.isHost !== right.isHost) {
        return Number(right.isHost) - Number(left.isHost);
      }
      if (left.admitted !== right.admitted) {
        return Number(right.admitted) - Number(left.admitted);
      }
      if (left.alive !== right.alive) {
        return Number(right.alive) - Number(left.alive);
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(left.name ?? "").localeCompare(String(right.name ?? ""), "ko");
    });
    const participantLimit = Math.max(
      1,
      Math.trunc(Number(this.entryGateState?.participantLimit) || 50)
    );
    const roomCapacity = Math.max(
      participantLimit,
      Math.trunc(Number(this.entryGateState?.roomCapacity) || participantLimit)
    );
    const spectatorCapacity = Math.max(0, roomCapacity - participantLimit);
    const hosts = roster.filter((entry) => entry.isHost);
    const participants = roster.filter((entry) => !entry.isHost && entry.admitted === true);
    const queuedSpectators = roster.filter(
      (entry) => !entry.isHost && entry.admitted !== true && entry.queuedForAdmission === true
    );
    const idleSpectators = roster.filter(
      (entry) => !entry.isHost && entry.admitted !== true && entry.queuedForAdmission !== true
    );
    const spectators = [...queuedSpectators, ...idleSpectators];

    if (this.rosterCountEl) {
      this.rosterCountEl.textContent =
        `참가 ${participants.length}/${participantLimit} · 관전 ${spectators.length} · 총 ${roster.length}`;
    }
    if (this.rosterSubtitleEl) {
      const priorityPlayers = Math.max(
        0,
        Math.trunc(Number(this.entryGateState?.priorityPlayers) || 0)
      );
      const mobileHint = this.mobileEnabled ? "인원 버튼으로 고정/닫기" : "Tab 키를 누르는 동안 표시됩니다.";
      this.rosterSubtitleEl.textContent =
        priorityPlayers > 0 ? `${mobileHint} · 다음 판 우선 ${priorityPlayers}명` : mobileHint;
    }
    if (!this.rosterListEl) {
      return;
    }
    if (!this.rosterVisibleByTab && !this.rosterPinned) {
      return;
    }

    if (roster.length === 0) {
      const empty = document.createElement("div");
      empty.className = "roster-empty";
      empty.textContent = "현재 접속 인원이 없습니다.";
      this.rosterListEl.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    if (hosts.length > 0) {
      const hostLine = document.createElement("div");
      hostLine.className = "roster-host-line";
      hostLine.textContent = `진행자: ${hosts
        .map((entry) => (entry.isMe ? `${entry.name} (나)` : entry.name))
        .join(", ")}`;
      fragment.appendChild(hostLine);
    }

    const createSlotSection = (title, entries, slotCount, kind = "participant") => {
      const totalSlots = Math.max(0, Math.trunc(Number(slotCount) || 0), entries.length);
      const section = document.createElement("section");
      section.className = `roster-slot-section ${kind}`;

      const head = document.createElement("div");
      head.className = "roster-slot-head";
      const titleEl = document.createElement("span");
      titleEl.className = "roster-slot-title";
      titleEl.textContent = title;
      const countEl = document.createElement("span");
      countEl.className = "roster-slot-count";
      countEl.textContent = `${entries.length}/${totalSlots}`;
      head.append(titleEl, countEl);

      const grid = document.createElement("div");
      grid.className = "roster-slot-grid";

      for (let index = 0; index < totalSlots; index += 1) {
        const entry = entries[index] ?? null;
        const slot = document.createElement("div");
        slot.className = "roster-slot";
        if (entry) {
          slot.classList.add("filled");
        }
        if (entry?.isMe) {
          slot.classList.add("me");
        }
        if (entry?.queuedForAdmission === true) {
          slot.classList.add("queued");
        }
        if (entry?.chatMuted === true) {
          slot.classList.add("muted");
        }

        const slotIndexEl = document.createElement("span");
        slotIndexEl.className = "roster-slot-index";
        slotIndexEl.textContent = String(index + 1);

        const slotNameEl = document.createElement("span");
        slotNameEl.className = "roster-slot-name";
        slotNameEl.textContent = entry ? (entry.isMe ? `${entry.name} (나)` : entry.name) : "-";

        const slotStateEl = document.createElement("span");
        slotStateEl.className = "roster-slot-state";
        if (!entry) {
          slotStateEl.textContent = "";
        } else if (kind === "participant") {
          if (entry.chatMuted === true) {
            slotStateEl.textContent = entry.alive ? `${entry.score}점 · 채금` : "탈락 · 채금";
          } else {
            slotStateEl.textContent = entry.alive ? `${entry.score}점` : "탈락";
          }
        } else if (entry.queuedForAdmission === true) {
          slotStateEl.textContent = entry.chatMuted === true ? "우선 · 채금" : "우선";
        } else {
          slotStateEl.textContent = entry.chatMuted === true ? "관전 · 채금" : "관전";
        }

        slot.append(slotIndexEl, slotNameEl, slotStateEl);
        grid.appendChild(slot);
      }

      section.append(head, grid);
      return section;
    };

    fragment.appendChild(
      createSlotSection("참가 슬롯", participants, participantLimit, "participant")
    );
    const spectatorSlotCount = Math.max(spectatorCapacity, spectators.length);
    if (spectatorSlotCount > 0) {
      fragment.appendChild(
        createSlotSection("관전자 슬롯", spectators, spectatorSlotCount, "spectator")
      );
    }

    this.rosterListEl.replaceChildren(fragment);
  }

  updateMobileControlUi() {
    this.resolveUiElements();
    const orientationLocked = this.syncOrientationLockUi();
    const showMobileUi =
      this.mobileEnabled && !orientationLocked && !this.isLobbyBlockingGameplay() && !this.localAdmissionWaiting;
    // Keep chat access visible on mobile, even when gameplay controls are hidden.
    const showChatButton = this.mobileEnabled && !orientationLocked;
    const showMobileContainer = showMobileUi || showChatButton;
    const canUseMobileChat = this.mobileEnabled && !this.isMobilePortraitLocked();
    const mobileActionPadEl = this.mobileControlsEl?.querySelector?.("#mobile-action-pad") ?? null;
    this.mobileControlsEl?.classList.toggle("hidden", !showMobileContainer);
    this.mobileMovePadEl?.classList.toggle("hidden", !showMobileUi);
    mobileActionPadEl?.classList.toggle("hidden", !showMobileUi);
    this.mobileChatToggleBtnEl?.classList.toggle("hidden", !showChatButton);
    this.mobileLookPadEl?.classList.toggle("hidden", !showMobileUi);
    if (!this.mobileEnabled) {
      this.mobileChatPanelVisible = true;
    }
    if (!canUseMobileChat) {
      this.mobileChatPanelVisible = false;
      this.setChatOpen(false);
      this.hideMobileChatPreview();
      this.setSettingsPanelOpen(false);
    }
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle("mobile-mode", showMobileUi);
    }
    if (!showMobileUi) {
      this.releaseMobileInputs();
      this.mobileLookPointerId = null;
      this.mobileLookPadEl?.classList.remove("active");
      this.hideMobileChatPreview();
      this.setMobileKeyboardInset(0);
      if (typeof document !== "undefined" && document.body) {
        document.body.classList.remove("mobile-chat-focus");
        document.body.classList.remove("mobile-roster-focus");
      }
      if (!this.rosterVisibleByTab) {
        this.setRosterPinned(false);
      }
    }
    this.applyMobileChatUi();
    this.syncSettingsPanelUi();
    this.syncChatLiveUi();
  }

  setMobileKeyboardInset(insetPx) {
    const nextInset = Math.max(0, Math.trunc(Number(insetPx) || 0));
    this.mobileKeyboardInsetPx = nextInset;
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement?.style?.setProperty("--mobile-keyboard-inset", `${nextInset}px`);
  }

  scheduleMobileKeyboardInsetSync(delayMs = 0) {
    if (typeof window === "undefined") {
      return;
    }
    if (this.mobileKeyboardInsetTimer) {
      window.clearTimeout(this.mobileKeyboardInsetTimer);
      this.mobileKeyboardInsetTimer = null;
    }
    const delay = Math.max(0, Math.trunc(Number(delayMs) || 0));
    this.mobileKeyboardInsetTimer = window.setTimeout(() => {
      this.mobileKeyboardInsetTimer = null;
      this.syncMobileKeyboardInset();
    }, delay);
  }

  syncMobileKeyboardInset() {
    if (!this.mobileEnabled || !this.chatOpen || this.isMobilePortraitLocked()) {
      this.setMobileKeyboardInset(0);
      return;
    }

    let inset = 0;
    if (typeof window !== "undefined") {
      const visualViewport = window.visualViewport;
      if (visualViewport) {
        const layoutHeight = Math.max(
          Number(window.innerHeight) || 0,
          Number(document?.documentElement?.clientHeight) || 0
        );
        const viewportGap =
          layoutHeight - (Number(visualViewport.height) || 0) - (Number(visualViewport.offsetTop) || 0);
        inset = Math.max(0, Math.trunc(viewportGap));
      }
    }

    // Ignore tiny viewport jitter from browser chrome.
    if (inset < 56) {
      inset = 0;
    }
    this.setMobileKeyboardInset(inset);
    if (inset > 0 && this.chatLogEl) {
      this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    }
  }

  applyMobileChatUi() {
    this.resolveUiElements();
    const canUseMobileChat = this.mobileEnabled && !this.isMobilePortraitLocked();
    const showChatPanel = !this.mobileEnabled || (canUseMobileChat && this.mobileChatPanelVisible);
    if (this.mobileEnabled && showChatPanel) {
      this.mobileChatUnreadCount = 0;
      this.hideMobileChatPreview();
    }
    this.chatUiEl?.classList.toggle("mobile-chat-hidden", this.mobileEnabled && !showChatPanel);
    let mobileChatFocus = false;
    if (typeof document !== "undefined" && document.body) {
      mobileChatFocus = this.mobileEnabled && this.chatOpen && canUseMobileChat;
      document.body.classList.toggle("mobile-chat-focus", mobileChatFocus);
      if (mobileChatFocus) {
        this.releaseMobileInputs();
        if (this.chatLogEl) {
          this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
        }
      }
    }
    if (mobileChatFocus) {
      this.scheduleMobileKeyboardInsetSync(0);
      this.scheduleMobileKeyboardInsetSync(180);
    } else {
      this.setMobileKeyboardInset(0);
    }
    this.updateMobileChatToggleButton(canUseMobileChat, showChatPanel);
    this.syncChatLiveUi();
  }

  updateMobileChatToggleButton(canUseMobileChat, showChatPanel) {
    if (!this.mobileChatToggleBtnEl) {
      return;
    }
    this.mobileChatToggleBtnEl.disabled = !canUseMobileChat;
    this.mobileChatToggleBtnEl.classList.toggle("active", this.mobileEnabled && showChatPanel);
    const unread = Math.max(0, Math.trunc(this.mobileChatUnreadCount));
    if (this.mobileEnabled && !showChatPanel && unread > 0) {
      this.mobileChatToggleBtnEl.dataset.unread = String(Math.min(99, unread));
    } else {
      delete this.mobileChatToggleBtnEl.dataset.unread;
    }
    if (!this.mobileEnabled || !canUseMobileChat) {
      this.mobileChatToggleBtnEl.textContent = "\uCC44\uD305";
      return;
    }
    if (showChatPanel) {
      this.mobileChatToggleBtnEl.textContent =
        this.chatOpen ? "\uB2EB\uAE30" : "\uC785\uB825";
      return;
    }
    this.mobileChatToggleBtnEl.textContent =
      unread > 0
        ? "\uCC44\uD305 " + Math.min(99, unread)
        : "\uCC44\uD305";
  }

  toggleMobileChatPanel() {
    if (!this.mobileEnabled || this.isMobilePortraitLocked()) {
      return;
    }
    if (this.mobileChatPanelVisible) {
      if (!this.chatOpen) {
        this.focusChatInput();
        return;
      }
      this.hideMobileChatPanel();
      return;
    }
    this.mobileChatPanelVisible = true;
    this.applyMobileChatUi();
    this.focusChatInput();
  }

  hideMobileChatPanel() {
    if (this.mobileEnabled) {
      this.mobileChatPanelVisible = false;
    }
    this.setChatOpen(false);
    this.chatInputEl?.blur?.();
    this.applyMobileChatUi();
  }

  renderMobileChatPreviewEntries() {
    if (!this.mobileChatPreviewEl) {
      return;
    }
    if (!Array.isArray(this.mobileChatPreviewEntries) || this.mobileChatPreviewEntries.length <= 0) {
      this.mobileChatPreviewEl.replaceChildren();
      this.mobileChatPreviewEl.classList.add("hidden");
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const text of this.mobileChatPreviewEntries) {
      const line = document.createElement("p");
      line.className = "mobile-chat-preview-line";
      line.textContent = String(text ?? "").trim();
      fragment.appendChild(line);
    }
    this.mobileChatPreviewEl.replaceChildren(fragment);
    this.mobileChatPreviewEl.classList.remove("hidden");
  }

  showMobileChatPreview(rawText) {
    if (!this.mobileEnabled) {
      return;
    }
    if (this.mobileChatPanelVisible) {
      return;
    }
    this.resolveUiElements();
    if (!this.mobileChatPreviewEl) {
      return;
    }
    const text = String(rawText ?? "").trim().slice(0, 120);
    if (!text) {
      return;
    }
    this.mobileChatPreviewEntries.push(text);
    if (this.mobileChatPreviewEntries.length > 4) {
      this.mobileChatPreviewEntries.shift();
    }
    this.renderMobileChatPreviewEntries();
    if (this.mobileChatPreviewHideTimer) {
      window.clearTimeout(this.mobileChatPreviewHideTimer);
    }
    const configuredLifetimeMs = Math.max(
      0,
      Math.trunc(Number(this.worldContent?.chat?.previewLifetimeMs) || 0)
    );
    const previewLifetimeMs = Math.max(MOBILE_CHAT_PREVIEW_MIN_LIFETIME_MS, configuredLifetimeMs);
    this.mobileChatPreviewHideTimer = window.setTimeout(() => {
      this.mobileChatPreviewHideTimer = null;
      this.mobileChatPreviewEntries.length = 0;
      this.mobileChatPreviewEl?.replaceChildren?.();
      this.mobileChatPreviewEl?.classList?.add("hidden");
    }, previewLifetimeMs);
  }

  hideMobileChatPreview() {
    if (this.mobileChatPreviewHideTimer) {
      window.clearTimeout(this.mobileChatPreviewHideTimer);
      this.mobileChatPreviewHideTimer = null;
    }
    this.mobileChatPreviewEntries.length = 0;
    this.mobileChatPreviewEl?.replaceChildren?.();
    this.mobileChatPreviewEl?.classList?.add("hidden");
  }

  notifyMobileIncomingChat(rawPreviewText) {
    const canUseMobileChat = this.mobileEnabled && this.canUseGameplayControls();
    if (!canUseMobileChat || this.mobileChatPanelVisible) {
      return;
    }
    this.mobileChatUnreadCount = Math.min(999, this.mobileChatUnreadCount + 1);
    this.updateMobileChatToggleButton(canUseMobileChat, false);
    this.showMobileChatPreview(rawPreviewText);
  }

  isAcceptedMobilePointer(event) {
    if (!event) {
      return false;
    }
    const pointerType = String(event.pointerType ?? "").toLowerCase();
    if (pointerType === "touch" || pointerType === "pen") {
      return true;
    }
    // 일부 모바일 웹뷰는 touch를 mouse/empty로 보고합니다.
    return this.mobileEnabled && (pointerType === "mouse" || pointerType.length === 0);
  }

  setMobileMoveVector(rawX, rawY) {
    this.mobileMoveVectorX = THREE.MathUtils.clamp(Number(rawX) || 0, -1, 1);
    this.mobileMoveVectorY = THREE.MathUtils.clamp(Number(rawY) || 0, -1, 1);
  }

  updateMobileMoveThumb(offsetX = 0, offsetY = 0) {
    if (!this.mobileMoveThumbEl) {
      return;
    }
    const x = Number(offsetX) || 0;
    const y = Number(offsetY) || 0;
    this.mobileMoveThumbEl.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px))`;
  }

  resetMobileMovePad() {
    this.mobileMovePointerId = null;
    this.mobileMoveTouchId = null;
    this.setMobileMoveVector(0, 0);
    this.mobileMovePadEl?.classList?.remove("active");
    this.updateMobileMoveThumb(0, 0);
  }

  refreshMobileMovePadMetrics() {
    if (!this.mobileMovePadEl) {
      return false;
    }
    const rect = this.mobileMovePadEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const thumbSize = this.mobileMoveThumbEl?.offsetWidth || 56;
    this.mobileMovePadCenterX = rect.left + rect.width * 0.5;
    this.mobileMovePadCenterY = rect.top + rect.height * 0.5;
    this.mobileMovePadMaxDistance = Math.max(14, rect.width * 0.5 - thumbSize * 0.5 - 4);
    return this.mobileMovePadMaxDistance > 0;
  }

  setMobileKeyState(keyCode, active) {
    const key = String(keyCode ?? "");
    if (!key) {
      return;
    }
    if (!active) {
      this.mobileHeldKeys.delete(key);
      this.keys.delete(key);
      return;
    }
    this.mobileHeldKeys.add(key);
    this.keys.add(key);
    if (key === "Space" && this.onGround && this.canMovePlayer()) {
      this.verticalVelocity = GAME_CONSTANTS.JUMP_FORCE;
      this.onGround = false;
    }
  }

  releaseMobileInputs() {
    for (const reset of this.mobileHoldResetters) {
      if (typeof reset === "function") {
        reset();
      }
    }
    for (const key of this.mobileHeldKeys) {
      this.keys.delete(key);
    }
    this.mobileHeldKeys.clear();
    this.resetMobileMovePad();
    this.mobileJumpBtnEl?.classList?.remove("active");
    this.mobileRunBtnEl?.classList?.remove("active");
    this.mobileLookPointerId = null;
    this.mobileLookDeltaX = 0;
    this.mobileLookDeltaY = 0;
    this.mobileLookPadEl?.classList?.remove("active");
  }

  bindMobileControlEvents() {
    if (this.mobileEventsBound) {
      return;
    }
    this.mobileEventsBound = true;
    this.bindMobileMovePadEvents();
    this.bindMobileHoldButton(this.mobileJumpBtnEl, "Space");
    this.bindMobileHoldButton(this.mobileRunBtnEl, "ShiftLeft");

    this.mobileRosterBtnEl?.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        this.toggleRosterPinned();
      },
      { passive: false }
    );
    this.mobileChatToggleBtnEl?.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        this.toggleMobileChatPanel();
      },
      { passive: false }
    );

    this.bindMobileLookPadEvents();
  }

  bindMobileMovePadEvents() {
    if (!this.mobileMovePadEl) {
      return;
    }

    const supportsPointerEvents =
      typeof window !== "undefined" && typeof window.PointerEvent !== "undefined";

    const calcMoveState = (clientX, clientY) => {
      if (!this.mobileMovePadEl) {
        return;
      }
      if (this.mobileMovePadMaxDistance <= 0.001 && !this.refreshMobileMovePadMetrics()) {
        return;
      }
      const maxDistance = this.mobileMovePadMaxDistance;
      let dx = Number(clientX) - this.mobileMovePadCenterX;
      let dy = Number(clientY) - this.mobileMovePadCenterY;
      const distance = Math.hypot(dx, dy);
      if (distance > maxDistance && distance > 0.001) {
        const ratio = maxDistance / distance;
        dx *= ratio;
        dy *= ratio;
      }
      const normalizeWithBoost = (value) => {
        const magnitude = Math.min(1, Math.abs(Number(value) || 0));
        return Math.sign(value) * Math.sqrt(magnitude);
      };
      this.setMobileMoveVector(
        normalizeWithBoost(dx / maxDistance),
        normalizeWithBoost(dy / maxDistance)
      );
      this.updateMobileMoveThumb(dx, dy);
    };

    const activatePad = (clientX, clientY, pointerId = null, touchId = null) => {
      if (!this.mobileEnabled || !this.canMovePlayer()) {
        return;
      }
      if (pointerId !== null) {
        this.mobileMovePointerId = pointerId;
      }
      if (touchId !== null) {
        this.mobileMoveTouchId = touchId;
      }
      this.mobileMovePadEl?.classList?.add("active");
      this.refreshMobileMovePadMetrics();
      calcMoveState(clientX, clientY);
    };

    const deactivatePad = () => {
      this.resetMobileMovePad();
    };

    this.mobileMovePadEl.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.isAcceptedMobilePointer(event)) {
          return;
        }
        if (this.mobileMovePointerId !== null) {
          return;
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        if (typeof this.mobileMovePadEl.setPointerCapture === "function") {
          try {
            this.mobileMovePadEl.setPointerCapture(event.pointerId);
          } catch {
            // ignore
          }
        }
        activatePad(event.clientX, event.clientY, event.pointerId, null);
      },
      { passive: false }
    );

    document.addEventListener(
      "pointermove",
      (event) => {
        if (
          !this.isAcceptedMobilePointer(event) ||
          this.mobileMovePointerId === null ||
          event.pointerId !== this.mobileMovePointerId
        ) {
          return;
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        calcMoveState(event.clientX, event.clientY);
      },
      { passive: false }
    );

    const endPointerMovePad = (event) => {
      if (this.mobileMovePointerId === null) {
        return;
      }
      const hasPointerId = Number.isFinite(Number(event?.pointerId));
      if (
        event &&
        hasPointerId &&
        event.pointerId !== this.mobileMovePointerId
      ) {
        return;
      }
      if (event?.cancelable) {
        event.preventDefault();
      }
      const releaseId = this.mobileMovePointerId;
      if (
        releaseId !== null &&
        this.mobileMovePadEl &&
        typeof this.mobileMovePadEl.hasPointerCapture === "function" &&
        this.mobileMovePadEl.hasPointerCapture(releaseId)
      ) {
        try {
          this.mobileMovePadEl.releasePointerCapture(releaseId);
        } catch {
          // ignore
        }
      }
      deactivatePad();
    };

    document.addEventListener("pointerup", endPointerMovePad, { passive: false });
    document.addEventListener("pointercancel", endPointerMovePad, { passive: false });
    this.mobileMovePadEl.addEventListener("lostpointercapture", endPointerMovePad, {
      passive: false
    });

    if (!supportsPointerEvents) {
      this.mobileMovePadEl.addEventListener(
        "touchstart",
        (event) => {
          const touch = event.changedTouches?.[0];
          if (!touch || this.mobileMoveTouchId !== null) {
            return;
          }
          if (event.cancelable) {
            event.preventDefault();
          }
          activatePad(touch.clientX, touch.clientY, null, touch.identifier);
        },
        { passive: false }
      );

      document.addEventListener(
        "touchmove",
        (event) => {
          if (this.mobileMoveTouchId === null) {
            return;
          }
          const touch = Array.from(event.changedTouches ?? []).find(
            (entry) => entry.identifier === this.mobileMoveTouchId
          );
          if (!touch) {
            return;
          }
          if (event.cancelable) {
            event.preventDefault();
          }
          calcMoveState(touch.clientX, touch.clientY);
        },
        { passive: false }
      );

      const endTouchMovePad = (event) => {
        if (this.mobileMoveTouchId === null) {
          return;
        }
        const matched = Array.from(event?.changedTouches ?? []).some(
          (entry) => entry.identifier === this.mobileMoveTouchId
        );
        if (!matched) {
          return;
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        deactivatePad();
      };

      document.addEventListener("touchend", endTouchMovePad, { passive: false });
      document.addEventListener("touchcancel", endTouchMovePad, { passive: false });
    }

    this.mobileHoldResetters.push(() => deactivatePad());
  }

  bindMobileHoldButton(button, keyCode) {
    if (!button || !keyCode) {
      return;
    }

    let activePointerId = null;
    let touchActive = false;
    const supportsPointerEvents =
      typeof window !== "undefined" && typeof window.PointerEvent !== "undefined";

    const activate = (event) => {
      if (!this.isAcceptedMobilePointer(event)) {
        return;
      }
      if (!this.mobileEnabled || !this.canMovePlayer()) {
        return;
      }
      if (activePointerId !== null) {
        return;
      }
      if (event.cancelable) {
        event.preventDefault();
      }
      activePointerId = event.pointerId;
      if (typeof button.setPointerCapture === "function") {
        try {
          button.setPointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
      button.classList.add("active");
      this.setMobileKeyState(keyCode, true);
    };

    const deactivate = (event) => {
      if (activePointerId === null) {
        return;
      }
      const hasPointerId = Number.isFinite(Number(event?.pointerId));
      if (
        event &&
        hasPointerId &&
        event.pointerId !== activePointerId
      ) {
        return;
      }
      if (event?.cancelable) {
        event.preventDefault();
      }
      const releaseId = activePointerId;
      if (typeof button.hasPointerCapture === "function" && button.hasPointerCapture(releaseId)) {
        try {
          button.releasePointerCapture(releaseId);
        } catch {
          // ignore
        }
      }
      activePointerId = null;
      button.classList.remove("active");
      this.setMobileKeyState(keyCode, false);
    };

    const activateTouch = (event) => {
      if (supportsPointerEvents) {
        return;
      }
      if (!this.mobileEnabled || !this.canMovePlayer()) {
        return;
      }
      if (touchActive) {
        return;
      }
      if (event.cancelable) {
        event.preventDefault();
      }
      touchActive = true;
      button.classList.add("active");
      this.setMobileKeyState(keyCode, true);
    };

    const deactivateTouch = (event) => {
      if (supportsPointerEvents || !touchActive) {
        return;
      }
      if (event?.cancelable) {
        event.preventDefault();
      }
      touchActive = false;
      button.classList.remove("active");
      this.setMobileKeyState(keyCode, false);
    };

    button.addEventListener("pointerdown", activate, { passive: false });
    button.addEventListener("pointerup", deactivate, { passive: false });
    button.addEventListener("pointercancel", deactivate, { passive: false });
    button.addEventListener("lostpointercapture", deactivate, { passive: false });
    window.addEventListener("pointerup", deactivate, { passive: false });
    window.addEventListener("pointercancel", deactivate, { passive: false });
    if (!supportsPointerEvents) {
      button.addEventListener("touchstart", activateTouch, { passive: false });
      button.addEventListener("touchend", deactivateTouch, { passive: false });
      button.addEventListener("touchcancel", deactivateTouch, { passive: false });
      window.addEventListener("touchend", deactivateTouch, { passive: false });
      window.addEventListener("touchcancel", deactivateTouch, { passive: false });
    }
    this.mobileHoldResetters.push(() => {
      deactivate(null);
      deactivateTouch(null);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }

  bindMobileLookPadEvents() {
    if (!this.mobileLookPadEl) {
      return;
    }

    const supportsPointerEvents =
      typeof window !== "undefined" && typeof window.PointerEvent !== "undefined";

    const finishLookDrag = (event = null) => {
      const hasPointerId = Number.isFinite(Number(event?.pointerId));
      if (
        event &&
        this.mobileLookPointerId !== null &&
        hasPointerId &&
        event.pointerId !== this.mobileLookPointerId
      ) {
        return;
      }
      if (event?.cancelable) {
        event.preventDefault();
      }
      const releaseId = this.mobileLookPointerId;
      this.mobileLookPointerId = null;
      if (
        releaseId !== null &&
        typeof this.mobileLookPadEl.hasPointerCapture === "function" &&
        this.mobileLookPadEl.hasPointerCapture(releaseId)
      ) {
        try {
          this.mobileLookPadEl.releasePointerCapture(releaseId);
        } catch {
          // ignore
        }
      }
      this.mobileLookPadEl?.classList.remove("active");
    };

    this.mobileLookPadEl.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.isAcceptedMobilePointer(event)) {
          return;
        }
        if (!this.mobileEnabled || !this.canMovePlayer()) {
          return;
        }
        if (this.mobileLookPointerId !== null) {
          return;
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        this.mobileLookPointerId = event.pointerId;
        this.mobileLookLastX = event.clientX;
        this.mobileLookLastY = event.clientY;
        this.mobileLookPadEl?.classList.add("active");
        if (typeof this.mobileLookPadEl.setPointerCapture === "function") {
          try {
            this.mobileLookPadEl.setPointerCapture(event.pointerId);
          } catch {
            // ignore
          }
        }
      },
      { passive: false }
    );

    document.addEventListener(
      "pointermove",
      (event) => {
        if (
          !this.isAcceptedMobilePointer(event) ||
          !this.mobileEnabled ||
          this.mobileLookPointerId === null ||
          event.pointerId !== this.mobileLookPointerId
        ) {
          return;
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        const deltaX = event.clientX - this.mobileLookLastX;
        const deltaY = event.clientY - this.mobileLookLastY;
        this.mobileLookLastX = event.clientX;
        this.mobileLookLastY = event.clientY;
        this.queueMobileLookDelta(deltaX, deltaY);
      },
      { passive: false }
    );

    document.addEventListener("pointerup", finishLookDrag, { passive: false });
    document.addEventListener("pointercancel", finishLookDrag, { passive: false });
    this.mobileLookPadEl.addEventListener("lostpointercapture", finishLookDrag, { passive: false });
    this.mobileLookPadEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    if (!supportsPointerEvents) {
      this.mobileLookPadEl.addEventListener(
        "touchstart",
        (event) => {
          const touch = event.changedTouches?.[0];
          if (!touch || !this.mobileEnabled || !this.canMovePlayer()) {
            return;
          }
          if (event.cancelable) {
            event.preventDefault();
          }
          this.mobileLookPointerId = touch.identifier;
          this.mobileLookLastX = touch.clientX;
          this.mobileLookLastY = touch.clientY;
          this.mobileLookPadEl?.classList.add("active");
        },
        { passive: false }
      );

      document.addEventListener(
        "touchmove",
        (event) => {
          if (!this.mobileEnabled || this.mobileLookPointerId === null) {
            return;
          }
          const touch = Array.from(event.changedTouches ?? []).find(
            (entry) => entry.identifier === this.mobileLookPointerId
          );
          if (!touch) {
            return;
          }
          if (event.cancelable) {
            event.preventDefault();
          }
          const deltaX = touch.clientX - this.mobileLookLastX;
          const deltaY = touch.clientY - this.mobileLookLastY;
          this.mobileLookLastX = touch.clientX;
          this.mobileLookLastY = touch.clientY;
          this.queueMobileLookDelta(deltaX, deltaY);
        },
        { passive: false }
      );

      const finishTouchLookDrag = (event) => {
        if (this.mobileLookPointerId === null) {
          return;
        }
        const matched = Array.from(event?.changedTouches ?? []).some(
          (entry) => entry.identifier === this.mobileLookPointerId
        );
        if (!matched) {
          return;
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        this.mobileLookPointerId = null;
        this.mobileLookPadEl?.classList.remove("active");
      };

      document.addEventListener("touchend", finishTouchLookDrag, { passive: false });
      document.addEventListener("touchcancel", finishTouchLookDrag, { passive: false });
    }
  }

  queueMobileLookDelta(deltaX, deltaY) {
    if (!this.mobileEnabled) {
      return;
    }
    const x = Number(deltaX) || 0;
    const y = Number(deltaY) || 0;
    if (Math.abs(x) > 0.001 || Math.abs(y) > 0.001) {
      this.lastLookInputAt = performance.now();
    }
    this.mobileLookDeltaX += x;
    this.mobileLookDeltaY += y;
  }

  applyMobileLookDelta() {
    if (!this.mobileEnabled) {
      this.mobileLookDeltaX = 0;
      this.mobileLookDeltaY = 0;
      return;
    }
    const deltaX = this.mobileLookDeltaX;
    const deltaY = this.mobileLookDeltaY;
    this.mobileLookDeltaX = 0;
    this.mobileLookDeltaY = 0;
    if (Math.abs(deltaX) < 0.001 && Math.abs(deltaY) < 0.001) {
      return;
    }
    this.yaw -= deltaX * MOBILE_RUNTIME_SETTINGS.lookSensitivityX;
    this.pitch -= deltaY * MOBILE_RUNTIME_SETTINGS.lookSensitivityY;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.52, 1.52);
  }

  setChatOpen(open) {
    if (open && this.isMobilePortraitLocked()) {
      return;
    }

    this.chatOpen = Boolean(open);
    if (this.mobileEnabled && this.chatOpen) {
      this.mobileChatPanelVisible = true;
    }
    if (this.chatUiEl) {
      this.chatUiEl.classList.toggle("collapsed", !this.chatOpen);
      this.chatUiEl.classList.toggle("mobile-fullscreen", this.mobileEnabled && this.chatOpen);
    }
    if (this.chatControlsEl) {
      this.chatControlsEl.classList.toggle("hidden", !this.chatOpen);
    }
    if (this.chatOpen) {
      this.chalkDrawingActive = false;
      this.chalkLastStamp = null;
      if (this.chatLogEl) {
        this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
      }
    }
    this.applyMobileChatUi();
    this.syncSettingsPanelUi();
    if (this.mobileEnabled) {
      if (this.chatOpen) {
        this.scheduleMobileKeyboardInsetSync(0);
        this.scheduleMobileKeyboardInsetSync(180);
      } else {
        this.setMobileKeyboardInset(0);
      }
    }
  }

  setSettingsPanelOpen(open) {
    this.settingsPanelOpen = Boolean(open);
    this.syncSettingsPanelUi();
  }

  syncSettingsPanelUi() {
    this.resolveUiElements();
    const visible = !this.isMobilePortraitLocked();
    if (!visible) {
      this.settingsPanelOpen = false;
    }
    if (this.settingsBtnEl) {
      this.settingsBtnEl.classList.toggle("hidden", !visible);
      this.settingsBtnEl.setAttribute("aria-expanded", this.settingsPanelOpen ? "true" : "false");
    }
    if (this.settingsPanelEl) {
      this.settingsPanelEl.classList.toggle("hidden", !visible || !this.settingsPanelOpen);
    }
    if (this.settingsFullscreenBtnEl) {
      const fullscreenSupported = this.isFullscreenSupported();
      this.settingsFullscreenBtnEl.disabled = !fullscreenSupported;
      this.settingsFullscreenBtnEl.classList.toggle("hidden", !fullscreenSupported);
      if (fullscreenSupported) {
        this.settingsFullscreenBtnEl.textContent = this.isFullscreenActive()
          ? "전체화면 끄기"
          : "전체화면 켜기";
      }
    }
    if (this.settingsVolumeSliderEl) {
      const nextValue = this.normalizeUiVolume(this.uiVolume).toFixed(2);
      if (String(this.settingsVolumeSliderEl.value) !== nextValue) {
        this.settingsVolumeSliderEl.value = nextValue;
      }
    }
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    for (const button of this.settingsQualityBtnEls) {
      const buttonQuality = String(button?.dataset?.quality ?? "").trim().toLowerCase();
      button.classList.toggle("active", buttonQuality === quality);
    }
  }

  normalizeGraphicsQuality(rawQuality) {
    const quality = String(rawQuality ?? "").trim().toLowerCase();
    if (quality === "low" || quality === "high") {
      return quality;
    }
    return "medium";
  }

  loadGraphicsQualityPreference() {
    try {
      return this.normalizeGraphicsQuality(localStorage.getItem(this.graphicsQualityStorageKey));
    } catch {
      return "medium";
    }
  }

  saveGraphicsQualityPreference() {
    try {
      localStorage.setItem(this.graphicsQualityStorageKey, this.graphicsQuality);
    } catch {
      // ignore
    }
  }

  setGraphicsQuality(rawQuality, { persist = true } = {}) {
    const nextQuality = this.normalizeGraphicsQuality(rawQuality);
    const changed = nextQuality !== this.graphicsQuality;
    this.graphicsQuality = nextQuality;
    if (persist) {
      this.saveGraphicsQualityPreference();
    }
    this.applyGraphicsQualityOverrides();
    if (changed) {
      this.setupPostProcessing();
    }
    this.applyGraphicsPostProcessingProfile();
    if (changed) {
      this.refreshBillboardMediaForQualityChange();
    }
    this.syncSettingsPanelUi();
    if (changed && this._initialized) {
      this.appendChatLine("SYSTEM", this.buildGraphicsQualityStatusLabel(), "system", {
        mobilePreview: false
      });
    }
  }

  buildGraphicsQualityStatusLabel() {
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality).toUpperCase();
    const pixelRatio = Number(this.currentPixelRatio || 0).toFixed(2);
    const dynamic = this.dynamicResolution?.enabled ? "ON" : "OFF";
    const shadow = this.renderer?.shadowMap?.enabled ? "ON" : "OFF";
    const shadowSize = Number(this.sunLight?.shadow?.mapSize?.x || 0);
    const bloom = this.bloomPass ? "ON" : "OFF";
    const bloomStrength = this.bloomPass ? Number(this.bloomPass.strength || 0).toFixed(2) : "0.00";
    return `Graphics ${quality} | PR ${pixelRatio} | DR ${dynamic} | Shadow ${shadow} ${shadowSize} | Bloom ${bloom} ${bloomStrength}`;
  }

  applyGraphicsQualityOverrides() {
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    this.graphicsQuality = quality;

    const devicePixelRatio = window.devicePixelRatio || 1;
    let maxRatioCap = this.mobileEnabled
      ? MOBILE_RUNTIME_SETTINGS.maxPixelRatio
      : DESKTOP_RUNTIME_SETTINGS.maxPixelRatio;
    let dynamicEnabled = this.mobileEnabled;
    let minRatio = this.mobileEnabled
      ? GAME_CONSTANTS.DYNAMIC_RESOLUTION.mobileMinRatio
      : GAME_CONSTANTS.DYNAMIC_RESOLUTION.desktopMinRatio;

    if (quality === "low") {
      dynamicEnabled = true;
      minRatio = this.mobileEnabled ? 0.5 : 0.62;
      maxRatioCap = this.mobileEnabled ? 0.95 : 1.0;
    } else if (quality === "high") {
      dynamicEnabled = false;
      minRatio = this.mobileEnabled ? 0.82 : GAME_CONSTANTS.DYNAMIC_RESOLUTION.desktopMinRatio;
      maxRatioCap = this.mobileEnabled ? 1.8 : 1.9;
    }

    this.dynamicResolution.enabled = dynamicEnabled;
    this.dynamicResolution.minRatio = THREE.MathUtils.clamp(minRatio, 0.45, 1);
    this.dynamicResolution.sampleTime = 0;
    this.dynamicResolution.frameCount = 0;
    this.dynamicResolution.downshiftSamples = 0;
    this.dynamicResolution.upshiftSamples = 0;
    this.dynamicResolution.cooldown = 0;
    this.dynamicResolution.pendingRatio = null;
    this.dynamicResolution.pendingApplyAt = 0;

    this.maxPixelRatio = Math.min(devicePixelRatio, Math.max(0.7, maxRatioCap));
    const minPixelRatio = Math.max(0.45, Math.min(this.dynamicResolution.minRatio, this.maxPixelRatio));

    let nextPixelRatio = this.currentPixelRatio;
    if (quality === "high") {
      nextPixelRatio = this.maxPixelRatio;
    } else if (quality === "low") {
      nextPixelRatio = minPixelRatio;
    } else {
      const mediumRatioFactor = this.mobileEnabled ? 0.86 : 0.92;
      nextPixelRatio = Math.max(minPixelRatio, this.maxPixelRatio * mediumRatioFactor);
    }
    nextPixelRatio = THREE.MathUtils.clamp(nextPixelRatio, minPixelRatio, this.maxPixelRatio);
    const roundedRatio = Number(nextPixelRatio.toFixed(2));
    if (Math.abs(roundedRatio - this.currentPixelRatio) > 0.01) {
      this.currentPixelRatio = roundedRatio;
      this.applyPixelRatio(this.currentPixelRatio);
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      if (this.composer) {
        this.composer.setSize(window.innerWidth, window.innerHeight);
      }
    }

    const shadowEnabled = !this.mobileEnabled && quality !== "low";
    this.renderer.shadowMap.enabled = shadowEnabled;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = shadowEnabled;
    if (this.sunLight) {
      this.sunLight.castShadow = shadowEnabled;
      const sunConfig = this.worldContent?.lights?.sun ?? {};
      const baseDesktopSize = Number(sunConfig.shadowDesktopSize) || 2048;
      const baseMobileSize = Number(sunConfig.shadowMobileSize) || 1024;
      let shadowMapSize = this.mobileEnabled ? baseMobileSize : baseDesktopSize;
      if (quality === "low") {
        shadowMapSize = Math.max(512, Math.round(shadowMapSize * 0.5));
      } else if (quality === "high" && !this.mobileEnabled) {
        shadowMapSize = Math.min(4096, Math.round(shadowMapSize * 1.2));
      }
      if (
        this.sunLight.shadow.mapSize.x !== shadowMapSize ||
        this.sunLight.shadow.mapSize.y !== shadowMapSize
      ) {
        this.sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
        this.sunLight.shadow.needsUpdate = true;
      }
    }
  }

  applyGraphicsPostProcessingProfile() {
    if (!this.bloomPass) {
      return;
    }
    const bloomConfig = this.worldContent?.postProcessing?.bloom ?? {};
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    const baseStrength = Number(bloomConfig.strength) || 0.22;
    const baseRadius = Number(bloomConfig.radius) || 0.62;
    const baseThreshold = Number(bloomConfig.threshold) || 0.86;

    let strength = baseStrength;
    let radius = baseRadius;
    let threshold = baseThreshold;

    if (quality === "medium") {
      strength = baseStrength * 0.92;
      radius = baseRadius * 0.96;
      threshold = Math.min(0.95, baseThreshold + 0.02);
    } else if (quality === "high") {
      strength = baseStrength * 1.24;
      radius = baseRadius * 1.08;
      threshold = Math.max(0.72, baseThreshold - 0.06);
    }

    this.bloomPass.strength = strength;
    this.bloomPass.radius = radius;
    this.bloomPass.threshold = threshold;
  }

  normalizeUiVolume(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      return 0.7;
    }
    return THREE.MathUtils.clamp(value, 0, 1);
  }

  loadUiVolumePreference() {
    try {
      return this.normalizeUiVolume(localStorage.getItem(this.uiVolumeStorageKey));
    } catch {
      return 0.7;
    }
  }

  saveUiVolumePreference() {
    try {
      localStorage.setItem(this.uiVolumeStorageKey, String(this.uiVolume));
    } catch {
      // ignore
    }
  }

  setUiVolume(rawValue, { persist = true } = {}) {
    this.uiVolume = this.normalizeUiVolume(rawValue);
    if (persist) {
      this.saveUiVolumePreference();
    }
    this.applyUiVolumeToMedia();
    this.syncSettingsPanelUi();
  }

  applyUiVolumeToMedia() {
    const volume = this.normalizeUiVolume(this.uiVolume);
    if (this.npcGreetingVideoEl) {
      this.npcGreetingVideoEl.volume = volume;
    }
    if (this.megaAdVideoEl) {
      this.megaAdVideoEl.volume = volume;
    }
    for (const boardKey of ["board1", "board2"]) {
      const runtime = this.billboardMediaRuntime?.[boardKey];
      if (!runtime) {
        continue;
      }
      if (runtime.videoEl) {
        runtime.videoEl.volume = runtime.audioFx?.video ? 1 : volume;
      }
      if (runtime.audioEl) {
        runtime.audioEl.volume = runtime.audioFx?.audio ? 1 : volume;
      }
      for (const channelKey of ["video", "audio"]) {
        const fx = runtime.audioFx?.[channelKey] ?? null;
        if (!fx) {
          continue;
        }
        fx.dryGain.gain.value = volume;
        fx.wetGain.gain.value = volume * 0.18;
      }
    }
  }

  updateChatLiveAnchorPosition() {
    if (!this.chatLiveFeedEl || typeof window === "undefined") {
      return;
    }
    const viewportHeight = Math.max(1, Number(window.innerHeight) || 1);
    const isVisibleRect = (element) => {
      if (!element || element.classList?.contains?.("hidden")) {
        return null;
      }
      const rect = element.getBoundingClientRect?.();
      if (!rect || !Number.isFinite(rect.top) || rect.height <= 0) {
        return null;
      }
      return rect;
    };

    const anchorRect = this.mobileEnabled
      ? isVisibleRect(this.mobileControlsEl)
      : isVisibleRect(this.chatUiEl);
    if (anchorRect) {
      const anchoredBottom = Math.max(18, Math.round(viewportHeight - anchorRect.top + 8));
      this.chatLiveFeedEl.style.bottom = `${anchoredBottom}px`;
      return;
    }
    this.chatLiveFeedEl.style.bottom = this.mobileEnabled ? "174px" : "148px";
  }

  syncChatLiveUi() {
    this.resolveUiElements();
    if (!this.chatLiveFeedEl) {
      return;
    }
    const portraitBlocked = this.isMobilePortraitLocked();
    const visible = !portraitBlocked && !(this.mobileEnabled && this.chatOpen);
    this.chatLiveFeedEl.classList.toggle("hidden", !visible);
    if (visible) {
      this.updateChatLiveAnchorPosition();
    }
  }

  setActiveTool(tool) {
    const nextTool = tool === "chalk" ? "chalk" : "move";
    this.activeTool = nextTool;
    for (const button of this.toolButtons) {
      const isActive = String(button?.dataset?.tool ?? "") === nextTool;
      button.classList.toggle("active", isActive);
    }
    if (this.chalkColorsEl) {
      this.chalkColorsEl.classList.toggle("hidden", nextTool !== "chalk");
    }
    if (nextTool !== "chalk") {
      this.chalkDrawingActive = false;
      this.chalkLastStamp = null;
    }
  }

  getColorDigitIndex(code) {
    if (!code || !code.startsWith("Digit")) {
      return -1;
    }
    const digit = Number(code.slice(5));
    if (!Number.isInteger(digit) || digit < 1) {
      return -1;
    }
    return digit - 1;
  }

  setChalkColorByIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.chalkPalette.length) {
      return;
    }
    this.setActiveTool("chalk");
    this.setChalkColor(this.chalkPalette[index]);
  }

  setChalkColor(rawColor) {
    let normalized = "#f5f7ff";
    try {
      normalized = `#${new THREE.Color(rawColor).getHexString()}`;
    } catch {
      return;
    }
    this.selectedChalkColor = normalized;
    for (const button of this.chalkColorButtons) {
      const buttonColor = String(button?.dataset?.color ?? "").toLowerCase();
      button.classList.toggle("active", buttonColor === normalized.toLowerCase());
    }
  }

  tryPointerLock() {
    if (!this.canUsePointerLock()) {
      return;
    }
    if (!this.pointerLockSupported || this.pointerLocked) {
      return;
    }
    const maybePromise = this.renderer.domElement.requestPointerLock();
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {
        this.hud.setStatus(this.getStatusText());
      });
    }
  }

  connectNetwork(options = {}) {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    const endpoint = String(options.endpoint ?? this.resolveSocketEndpoint() ?? "").trim();
    this.socketEndpoint = endpoint || null;
    this.socketAuth = options.auth ?? null;
    if (!endpoint) {
      this.networkConnected = false;
      this.hud.setStatus(this.getStatusText());
      if (this.lobbyEnabled) {
        this.showLobbyScreen("서버 주소를 찾지 못했습니다. ?server=http://주소:포트 로 접속하세요.");
      }
      return;
    }

    const ioOptions = {
      transports: ["websocket", "polling"],
      timeout: 10000,
      reconnection: true,
      reconnectionDelay: 900,
      reconnectionDelayMax: 5000
    };
    if (this.socketAuth && typeof this.socketAuth === "object") {
      ioOptions.auth = this.socketAuth;
    }

    const socket = io(endpoint, ioOptions);
    this.socket = socket;
    this.attachSocketHandlers(socket);
  }

  attachSocketHandlers(socket) {
    socket.on("connect", () => {
      this.networkConnected = true;
      this.disconnectedByKick = false;
      this.localPlayerId = socket.id;
      this.hud.setStatus(this.getStatusText());
      this.refreshRosterPanel();
      if (this.lobbyEnabled) {
        this.setLobbyStatus(
          this.lobbyNameConfirmed ? "매치 서버 연결 중..." : "닉네임을 입력한 뒤 입장하세요."
        );
        socket.emit("room:list");
      }
      this.syncPlayerNameIfConnected();
      this.updateQuizControlUi();
    });

    socket.on("disconnect", () => {
      this.networkConnected = false;
      this.chatSendInFlight = false;
      this.localPlayerId = null;
      this.keys.clear();
      this.releaseMobileInputs();
      this.clearRemotePlayers();
      this.roomRoster = [];
      this.localAdmissionWaiting = false;
      this.entryGateState = {
        portalOpen: false,
        waitingPlayers: 0,
        admittedPlayers: 0,
        spectatorPlayers: 0,
        priorityPlayers: 0,
        participantLimit: 50,
        roomCapacity: 120,
        openedAt: 0,
        lastAdmissionAt: 0,
        admissionStartsAt: 0,
        admissionInProgress: false
      };
      this.resetQuizStateLocal();
      this.hud.setStatus(this.getStatusText());
      this.hud.setPlayers(1);
      this.setRosterTabVisible(false);
      this.setRosterPinned(false);
      this.refreshRosterPanel();
      this.syncGameplayUiForFlow();
      this.closeQuizConfigModal();
      this.closeQuizReviewModal();
      if (this.lobbyEnabled) {
        this.lobbyJoinInFlight = false;
        this.showLobbyScreen(
          this.disconnectedByKick
            ? "진행자에 의해 강퇴되었습니다. 다시 입장하려면 새로고침하세요."
            : "연결이 끊겼습니다. 재연결 중..."
        );
      }
      this.updateQuizControlUi();
    });

    socket.on("connect_error", () => {
      this.networkConnected = false;
      this.chatSendInFlight = false;
      this.keys.clear();
      this.releaseMobileInputs();
      this.roomRoster = [];
      this.localAdmissionWaiting = false;
      this.entryGateState = {
        portalOpen: false,
        waitingPlayers: 0,
        admittedPlayers: 0,
        spectatorPlayers: 0,
        priorityPlayers: 0,
        participantLimit: 50,
        roomCapacity: 120,
        openedAt: 0,
        lastAdmissionAt: 0,
        admissionStartsAt: 0,
        admissionInProgress: false
      };
      this.hud.setStatus(this.getStatusText());
      this.refreshRosterPanel();
      this.syncGameplayUiForFlow();
      this.closeQuizConfigModal();
      if (this.lobbyEnabled) {
        this.lobbyJoinInFlight = false;
        this.showLobbyScreen("서버 연결에 실패했습니다. 잠시 후 다시 시도하세요.");
      }
      this.updateQuizControlUi();
    });

    socket.on("server:role", (payload = {}) => {
      this.handleServerRole(payload);
    });

    socket.on("route:assign", (payload = {}) => {
      this.handleRouteAssign(payload);
    });

    socket.on("auth:error", (payload = {}) => {
      const reason = String(payload?.reason ?? "인증 실패");
      this.appendChatLine("시스템", `접속 인증 실패: ${reason}`, "system");
    });

    socket.on("room:update", (room) => {
      this.handleRoomUpdate(room);
    });

    socket.on("room:list", (payload = []) => {
      this.handleLobbyRoomList(payload);
    });

    socket.on("portal:target:update", (payload = {}) => {
      this.handlePortalTargetUpdate(payload);
    });

    socket.on("portal:lobby-admitted", (payload = {}) => {
      this.handlePortalLobbyAdmitted(payload);
    });

    socket.on("player:sync", (payload) => {
      this.handleRemoteSync(payload);
    });

    socket.on("player:delta", (payload = {}) => {
      this.handleRemoteDelta(payload);
    });

    socket.on("player:correct", (payload = {}) => {
      this.handleServerCorrection(payload);
    });

    socket.on("chat:message", (payload) => {
      this.handleChatMessage(payload);
    });
    socket.on("chat:history", (payload = {}) => {
      this.handleChatHistory(payload);
    });
    socket.on("chat:blocked", (payload = {}) => {
      this.handleChatBlocked(payload);
    });
    socket.on("host:kicked", (payload = {}) => {
      this.handleHostKicked(payload);
    });
    socket.on("host:chat-muted", (payload = {}) => {
      this.handleHostChatMuted(payload);
    });

    socket.on("quiz:start", (payload = {}) => {
      this.handleQuizStart(payload);
    });

    socket.on("quiz:auto-countdown", (payload = {}) => {
      this.handleQuizAutoCountdown(payload);
    });

    socket.on("quiz:question", (payload = {}) => {
      this.handleQuizQuestion(payload);
    });

    socket.on("quiz:lock", (payload = {}) => {
      this.handleQuizLock(payload);
    });

    socket.on("quiz:result", (payload = {}) => {
      this.handleQuizResult(payload);
    });

    socket.on("quiz:score", (payload = {}) => {
      this.handleQuizScore(payload);
    });

    socket.on("quiz:config:update", (payload = {}) => {
      this.handleQuizConfigUpdate(payload);
    });

    socket.on("quiz:end", (payload = {}) => {
      this.handleQuizEnd(payload);
    });

    socket.on("quiz:reset", (payload = {}) => {
      this.handleQuizReset(payload);
    });
  }

  resolveSocketEndpoint() {
    if (typeof window === "undefined") {
      return null;
    }

    const envEndpoint = String(
      import.meta.env?.VITE_SOCKET_ENDPOINT ?? import.meta.env?.VITE_CHAT_SERVER ?? ""
    ).trim();
    if (envEndpoint) {
      return envEndpoint;
    }

    const query = new URLSearchParams(window.location.search);
    const queryEndpoint = String(
      query.get("server") ?? query.get("socket") ?? query.get("ws") ?? ""
    ).trim();
    if (queryEndpoint) {
      return queryEndpoint;
    }

    const globalEndpoint = String(window.__EMPTINES_SOCKET_ENDPOINT ?? "").trim();
    if (globalEndpoint) {
      return globalEndpoint;
    }

    const { protocol, hostname } = window.location;
    if (protocol === "file:") {
      return "http://localhost:3001";
    }

    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${protocol}//${hostname}:3001`;
    }

    if (hostname.endsWith("github.io")) {
      return null;
    }

    return `${protocol}//${hostname}`;
  }

  handleServerRole(payload = {}) {
    this.socketRole = String(payload?.role ?? "worker");
    if (this.socketRole === "gateway") {
      const limit = Math.trunc(Number(payload?.participantLimit) || 0);
      if (limit > 0) {
        this.gatewayParticipantLimit = limit;
      }
      this.hud.setStatus("게이트웨이 연결 중...");
      if (this.lobbyEnabled) {
        this.showLobbyScreen(
          this.lobbyNameConfirmed
            ? "매치 서버를 찾는 중..."
            : "닉네임을 입력한 뒤 입장 버튼을 눌러주세요."
        );
        this.socket?.emit?.("room:list");
      }
      return;
    }
    if (this.lobbyEnabled && this.socketRole === "worker" && this.lobbyNameConfirmed) {
      this.setLobbyStatus("게임 서버에 연결되었습니다. 입장 마무리 중...");
    }
  }

  handleRouteAssign(payload = {}) {
    this.applyRouteRedirect(payload);
  }

  applyRouteRedirect(redirect = {}) {
    const endpoint = String(redirect?.endpoint ?? "").trim();
    const token = String(redirect?.token ?? "").trim();
    if (!endpoint || !token) {
      return;
    }
    if (this.redirectInFlight) {
      return;
    }

    const current = String(this.socketEndpoint ?? "").trim();
    const isSameEndpoint = endpoint === current;
    if (isSameEndpoint && this.socketRole !== "gateway") {
      return;
    }

    this.redirectInFlight = true;
    this.hud.setStatus("매치 서버로 이동 중...");
    if (this.lobbyEnabled) {
      this.setLobbyStatus("매치 서버로 이동 중...");
    }

    const auth = {
      token,
      roomCode: String(redirect?.roomCode ?? "").trim(),
      name: this.formatPlayerName(this.localPlayerName)
    };

    window.setTimeout(() => {
      this.socketRole = "worker";
      this.connectNetwork({ endpoint, auth });
      this.redirectInFlight = false;
    }, 60);
  }

  handleRoomUpdate(room) {
    const players = Array.isArray(room?.players) ? room.players : [];
    this.currentRoomCode = String(room?.code ?? this.currentRoomCode ?? "")
      .trim()
      .toUpperCase();
    if (this.currentRoomCode) {
      this.persistPreferredRoomCode(this.currentRoomCode);
    }
    const previousHostId = String(this.quizState.hostId ?? "");
    const wasPortalOpen = this.entryGateState?.portalOpen === true;
    const wasAdmissionInProgress =
      this.entryGateState?.admissionInProgress === true || this.getAdmissionCountdownSeconds() > 0;
    if (room && Object.prototype.hasOwnProperty.call(room, "hostId")) {
      this.quizState.hostId = room.hostId ?? null;
    }
    const gate = room?.entryGate ?? {};
    const admissionStartsAt = Math.max(0, Math.trunc(Number(gate?.admissionStartsAt) || 0));
    this.entryGateState = {
      portalOpen: gate?.portalOpen === true,
      waitingPlayers: Math.max(0, Math.trunc(Number(gate?.waitingPlayers) || 0)),
      admittedPlayers: Math.max(0, Math.trunc(Number(gate?.admittedPlayers) || 0)),
      spectatorPlayers: Math.max(0, Math.trunc(Number(gate?.spectatorPlayers) || 0)),
      priorityPlayers: Math.max(0, Math.trunc(Number(gate?.priorityPlayers) || 0)),
      participantLimit: Math.max(1, Math.trunc(Number(gate?.participantLimit) || 50)),
      roomCapacity: Math.max(
        1,
        Math.trunc(
          Number(gate?.roomCapacity) || Math.max(1, Math.trunc(Number(gate?.participantLimit) || 50))
        )
      ),
      openedAt: Math.max(0, Math.trunc(Number(gate?.openedAt) || 0)),
      lastAdmissionAt: Math.max(0, Math.trunc(Number(gate?.lastAdmissionAt) || 0)),
      admissionStartsAt,
      admissionInProgress: gate?.admissionInProgress === true || admissionStartsAt > Date.now()
    };
    const nowPortalOpen = this.entryGateState?.portalOpen === true;
    if (typeof room?.portalTargetUrl === "string") {
      this.applyPortalTarget(room.portalTargetUrl, { announce: false });
    }
    if (room && Object.prototype.hasOwnProperty.call(room, "billboardMedia")) {
      this.applyBillboardMediaState(room.billboardMedia ?? {});
    }
    const previousCategoryVote = this.categoryVoteState;
    this.categoryVoteState = this.normalizeCategoryVotePayload(room?.categoryVote);
    this.renderCategoryVoteOverlay();
    this.handleCategoryVoteStateChange(previousCategoryVote, this.categoryVoteState);
    const seen = new Set();
    let localSeen = false;
    let localHostSpectator = false;
    let localQueuedForAdmission = false;
    let localAdmitted = true;
    const wasAdmissionWaiting = this.localAdmissionWaiting;

    for (const player of players) {
      const id = String(player?.id ?? "");
      if (!id) {
        continue;
      }
      if (id === this.localPlayerId) {
        localSeen = true;
        this.localPlayerName = this.formatPlayerName(player?.name);
        const isHostSpectator = player?.spectator === true;
        const admitted = player?.admitted !== false;
        const hasQueueFlag = Object.prototype.hasOwnProperty.call(player ?? {}, "queuedForAdmission");
        const queuedForAdmission = hasQueueFlag ? player?.queuedForAdmission === true : !admitted;
        localHostSpectator = isHostSpectator;
        this.serverHostSpectator = isHostSpectator;
        this.hostSpectatorOverride = this.isLocalHost() && !isHostSpectator;
        localQueuedForAdmission = queuedForAdmission;
        localAdmitted = admitted;
        this.localAdmissionWaiting = !isHostSpectator && !admitted && queuedForAdmission;
        if (isHostSpectator) {
          this.localQuizAlive = true;
          if (this.quizState.active && !this.hostSpectatorOverride) {
            this.enterHostSpectatorMode();
          }
          continue;
        }
        if (!admitted && !this.localAdmissionWaiting) {
          this.localQuizAlive = false;
          if (this.quizState.active && !this.localSpectatorMode) {
            this.finishLocalEliminationDrop();
          }
          continue;
        }
        let nextAlive = player?.alive !== false;
        if (this.quizState.active && this.localQuizAlive && !nextAlive) {
          this.startLocalEliminationDrop("server-eliminated");
        } else if (
          nextAlive &&
          !this.localQuizAlive &&
          this.quizState.active &&
          this.quizState.phase !== "start"
        ) {
          nextAlive = false;
        } else if (
          nextAlive &&
          !this.localQuizAlive &&
          (!this.quizState.active || this.quizState.phase === "start")
        ) {
          this.localSpectatorMode = false;
          this.localEliminationDrop.active = false;
          this.localEliminationDrop.elapsed = 0;
          this.localEliminationDrop.velocityY = 0;
          this.spectatorFollowId = null;
          this.spectatorFollowIndex = -1;
        }
        this.localQuizAlive = nextAlive;
        continue;
      }
      seen.add(id);
      this.upsertRemotePlayer(
        id,
        player.state ?? null,
        player?.name,
        player?.alive,
        player?.spectator === true,
        player?.admitted !== false
      );
    }

    for (const id of this.remotePlayers.keys()) {
      if (!seen.has(id)) {
        this.removeRemotePlayer(id);
      }
    }

    const localPlayer = this.networkConnected ? 1 : 0;
    this.hud.setPlayers(this.remotePlayers.size + localPlayer);
    const nextHostId = String(this.quizState.hostId ?? "");
    if (previousHostId && previousHostId !== nextHostId) {
      if (!nextHostId) {
        this.appendChatLine(
          "시스템",
          "진행자 권한이 비어 있습니다. 오너가 호스팅 권한을 다시 가져와야 합니다.",
          "system"
        );
      } else {
        const nextHostPlayer = players.find(
          (entry) => String(entry?.id ?? "") === nextHostId
        );
        const nextHostName = this.formatPlayerName(nextHostPlayer?.name ?? "진행자");
        this.appendChatLine("시스템", `진행자가 ${nextHostName}(으)로 변경되었습니다.`, "system");
      }
    }
    if (
      this.lobbyEnabled &&
      localSeen &&
      this.lobbyNameConfirmed &&
      this.socketRole !== "gateway" &&
      !this.redirectInFlight
    ) {
      this.hideLobbyScreen();
    }
    const nowAdmissionInProgress =
      this.entryGateState?.admissionInProgress === true || this.getAdmissionCountdownSeconds() > 0;
    if (!wasAdmissionInProgress && nowAdmissionInProgress) {
      const countdownSeconds = this.getAdmissionCountdownSeconds();
      this.appendChatLine(
        "시스템",
        countdownSeconds > 0
          ? `입장 카운트다운이 시작되었습니다. ${countdownSeconds}초 후 이동합니다.`
          : "입장 처리를 시작합니다.",
        "system"
      );
    }
    if (wasAdmissionWaiting && !this.localAdmissionWaiting) {
      if (!localAdmitted && !localHostSpectator && !localQueuedForAdmission) {
        this.appendChatLine(
          "시스템",
          "참가 슬롯이 가득 차 관전 모드로 전환되었습니다. 다음 판 우선권이 적용됩니다.",
          "system"
        );
      } else {
        this.appendChatLine("시스템", "입장이 시작되었습니다. 경기장으로 진입합니다.", "system");
      }
    }
    if (!wasAdmissionWaiting && this.localAdmissionWaiting) {
      this.appendChatLine("시스템", "현재 포탈 대기실 상태입니다. 진행자를 기다려주세요.", "system");
    }
    if (localSeen && wasPortalOpen !== nowPortalOpen) {
      this.appendChatLine(
        "SYSTEM",
        nowPortalOpen
          ? "Portal link is OPEN. You can move through the gate."
          : "Portal link is CLOSED. Lobby connection is disconnected.",
        "system"
      );
    }
    this.syncGameplayUiForFlow();
    this.refreshRosterPanel(players);
    this.updateQuizControlUi();
  }

  handleRemoteSync(payload) {
    const id = String(payload?.id ?? "");
    if (!id || id === this.localPlayerId) {
      return;
    }

    this.upsertRemotePlayer(id, payload.state ?? null, payload?.name);
    const localPlayer = this.networkConnected ? 1 : 0;
    this.hud.setPlayers(this.remotePlayers.size + localPlayer);
  }

  decodeDeltaState(delta = {}) {
    const state = {};
    if (Array.isArray(delta.p) && delta.p.length >= 3) {
      state.x = Number(delta.p[0] || 0) / 100;
      state.y = Number(delta.p[1] || 0) / 100;
      state.z = Number(delta.p[2] || 0) / 100;
    }
    if (Array.isArray(delta.r) && delta.r.length >= 2) {
      state.yaw = Number(delta.r[0] || 0) / 1000;
      state.pitch = Number(delta.r[1] || 0) / 1000;
    }
    return Object.keys(state).length > 0 ? state : null;
  }

  handleRemoteDelta(payload = {}) {
    const updates = Array.isArray(payload?.updates) ? payload.updates : [];
    for (const update of updates) {
      const id = String(update?.id ?? "");
      if (!id || id === this.localPlayerId) {
        continue;
      }
      const state = this.decodeDeltaState(update);
      const nextAlive =
        Object.prototype.hasOwnProperty.call(update, "a") ? Number(update.a) !== 0 : null;
      this.upsertRemotePlayer(id, state, update?.n, nextAlive);
    }

    const removes = Array.isArray(payload?.removes) ? payload.removes : [];
    for (const entry of removes) {
      const id = String(entry ?? "");
      if (!id || id === this.localPlayerId) {
        continue;
      }
      this.removeRemotePlayer(id);
    }

    const localPlayer = this.networkConnected ? 1 : 0;
    this.hud.setPlayers(this.remotePlayers.size + localPlayer);
  }

  handleServerCorrection(payload = {}) {
    const state = payload?.state;
    if (!state) {
      return;
    }
    if (this.performanceDebug?.enabled) {
      this.performanceDebug.flags.correctionCount += 1;
    }

    const nextX = Number(state.x);
    const nextY = Number(state.y);
    const nextZ = Number(state.z);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY) || !Number.isFinite(nextZ)) {
      return;
    }

    const distance = Math.hypot(
      nextX - this.playerPosition.x,
      nextY - this.playerPosition.y,
      nextZ - this.playerPosition.z
    );
    const correctionIgnoreDistance = this.mobileEnabled ? 0.12 : 0.32;
    if (distance < correctionIgnoreDistance) {
      return;
    }

    if (distance >= 2.6) {
      this.playerPosition.set(nextX, nextY, nextZ);
    } else {
      const blend = this.mobileEnabled
        ? THREE.MathUtils.clamp(0.1 + (distance / 2.6) * 0.25, 0.1, 0.35)
        : THREE.MathUtils.clamp(0.05 + (distance / 2.6) * 0.16, 0.05, 0.21);
      this.playerPosition.lerp(this.serverCorrectionTarget.set(nextX, nextY, nextZ), blend);
    }
    let correctedYawOrPitch = false;
    const recentLookInput =
      !this.mobileEnabled &&
      this.pointerLocked &&
      performance.now() - this.lastLookInputAt <
        DESKTOP_RUNTIME_SETTINGS.orientationCorrectionInputLockMs;
    const movingInput = this.hasLocalMovementIntent();
    const blockOrientationCorrection =
      !this.mobileEnabled &&
      this.pointerLocked &&
      (recentLookInput || movingInput) &&
      distance < 3.4;
    if (!blockOrientationCorrection && Number.isFinite(Number(state.yaw))) {
      const nextYaw = Number(state.yaw);
      const yawBlend = distance >= 2.6 ? 1 : this.mobileEnabled ? 0.33 : 0.24;
      this.yaw = lerpAngle(this.yaw, nextYaw, yawBlend);
      correctedYawOrPitch = true;
    }
    if (!blockOrientationCorrection && Number.isFinite(Number(state.pitch))) {
      const nextPitch = Number(state.pitch);
      const pitchBlend = distance >= 2.6 ? 1 : this.mobileEnabled ? 0.28 : 0.2;
      this.pitch = THREE.MathUtils.lerp(this.pitch, nextPitch, pitchBlend);
      correctedYawOrPitch = true;
    }
    if (correctedYawOrPitch) {
      this.markPerformanceFlag("correctionYawPitch");
    }
    this.camera.position.copy(this.playerPosition);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  upsertRemotePlayer(id, state, name, alive = null, spectator = null, admitted = null) {
    let remote = this.remotePlayers.get(id);
    if (!remote) {
      const root = new THREE.Group();
      const geometries = this.getRemoteAvatarGeometries();
      const canCastShadow = !this.mobileEnabled && this.renderer.shadowMap.enabled;
      const defaultRemoteName = this.formatPlayerName("PLAYER");

      const body = new THREE.Mesh(
        geometries.body,
        this.createRemoteAvatarMaterial("body")
      );
      body.position.y = 0.92;
      body.castShadow = canCastShadow;
      body.receiveShadow = canCastShadow;

      const head = new THREE.Mesh(
        geometries.head,
        this.createRemoteAvatarMaterial("head")
      );
      head.position.y = 1.62;
      head.castShadow = canCastShadow;
      head.receiveShadow = canCastShadow;

      const nameLabel = this.createTextLabel(defaultRemoteName, "name");
      nameLabel.position.set(0, 2.12, 0);

      root.add(body, head, nameLabel);
      root.position.set(0, 0, 0);
      this.scene.add(root);

      remote = {
        mesh: root,
        body,
        head,
        nameLabel,
        chatLabel: null,
        name: defaultRemoteName,
        alive: true,
        spectator: false,
        admitted: true,
        chatExpireAt: 0,
        targetPosition: new THREE.Vector3(0, 0, 0),
        targetYaw: 0,
        lastSeen: performance.now()
      };

      this.remotePlayers.set(id, remote);
    }

    if (typeof name !== "undefined" && name !== null) {
      const nextName = this.formatPlayerName(name);
      if (nextName !== remote.name) {
        remote.name = nextName;
        this.setTextLabel(remote.nameLabel, nextName, "name");
      }
    }

    if (state) {
      remote.targetPosition.set(
        Number(state.x) || 0,
        Math.max(
          0,
          (Number(state.y) || GAME_CONSTANTS.PLAYER_HEIGHT) - GAME_CONSTANTS.PLAYER_HEIGHT
        ),
        Number(state.z) || 0
      );
      remote.targetYaw = Number(state.yaw) || 0;
      remote.lastSeen = performance.now();
    }

    const hasAlive = alive !== null && typeof alive !== "undefined";
    const hasSpectator = spectator !== null && typeof spectator !== "undefined";
    const hasAdmitted = admitted !== null && typeof admitted !== "undefined";
    if (hasAdmitted) {
      remote.admitted = admitted === true;
    }
    if (hasAlive || hasSpectator) {
      this.setRemoteAliveVisual(
        remote,
        hasAlive ? alive !== false : remote.alive,
        hasSpectator ? spectator === true : remote.spectator === true
      );
    }

    remote.lastSeen = performance.now();
  }

  setRemoteAliveVisual(remote, alive, spectator = false) {
    if (!remote) {
      return;
    }
    const nextAlive = Boolean(alive);
    const nextSpectator = Boolean(spectator);
    if (remote.alive === nextAlive && remote.spectator === nextSpectator) {
      return;
    }

    remote.alive = nextAlive;
    remote.spectator = nextSpectator;
    const meshes = [remote.body, remote.head];
    for (const mesh of meshes) {
      const material = mesh?.material;
      if (!material) {
        continue;
      }
      material.transparent = !nextAlive || nextSpectator;
      material.opacity = nextSpectator ? 0.8 : nextAlive ? 1 : 0.28;
      material.emissiveIntensity = nextSpectator ? 0.26 : nextAlive ? 0.2 : 0.42;
      material.needsUpdate = true;
    }

    let nameText = remote.name;
    if (nextSpectator) {
      nameText = `${remote.name} [진행자]`;
    } else if (!nextAlive) {
      nameText = `${remote.name} [탈락]`;
    }
    this.setTextLabel(remote.nameLabel, nameText, "name");
  }

  removeRemotePlayer(id) {
    const remote = this.remotePlayers.get(id);
    if (!remote) {
      return;
    }

    this.disposeTextLabel(remote.nameLabel);
    this.disposeTextLabel(remote.chatLabel);
    remote.body?.material?.dispose?.();
    remote.head?.material?.dispose?.();
    this.scene.remove(remote.mesh);
    this.remotePlayers.delete(id);
  }

  clearRemotePlayers() {
    for (const id of this.remotePlayers.keys()) {
      this.removeRemotePlayer(id);
    }
  }

  tick(delta) {
    this.beginPerformanceFrame();
    this.measurePerformanceSection("mobileLook", () => this.applyMobileLookDelta());
    this.measurePerformanceSection("movement", () => this.updateMovement(delta));
    this.measurePerformanceSection("trapdoor", () => this.updateTrapdoorAnimation(delta));
    this.measurePerformanceSection("hubFlow", () => this.updateHubFlow(delta));
    this.measurePerformanceSection("lobbyPortal", () => this.updateLobbyPortal(delta));
    this.measurePerformanceSection("offlineStart", () => this.updateOfflineStartPillar(delta));
    this.measurePerformanceSection("chalk", () => this.updateChalkDrawing());
    this.measurePerformanceSection("clouds", () => this.updateCloudLayer(delta));
    this.measurePerformanceSection("ocean", () => this.updateOcean(delta));
    this.measurePerformanceSection("remotePlayers", () => this.updateRemotePlayers(delta));
    this.measurePerformanceSection("emitSync", () => this.emitLocalSync(delta));
    this.measurePerformanceSection("dynamicResolution", () => this.updateDynamicResolution(delta));
    this.measurePerformanceSection("shadowRefresh", () => this.updateShadowMapRefresh(delta));
    this.measurePerformanceSection("billboard", () => {
      this.updateBillboardVideoTextures(delta);
      this.updateQuizBillboardPulse(delta);
    });
    this.measurePerformanceSection("hud", () => this.updateHud(delta));
    this.measurePerformanceSection("roundOverlay", () => this.updateRoundOverlay(delta));
    this.measurePerformanceSection("categoryVote", () => this.updateCategoryVoteTimerUi());
  }

  hasLocalMovementIntent() {
    const keyboardMove =
      this.keys.has("KeyW") ||
      this.keys.has("ArrowUp") ||
      this.keys.has("KeyS") ||
      this.keys.has("ArrowDown") ||
      this.keys.has("KeyA") ||
      this.keys.has("ArrowLeft") ||
      this.keys.has("KeyD") ||
      this.keys.has("ArrowRight");
    if (keyboardMove) {
      return true;
    }
    if (!this.mobileEnabled) {
      return false;
    }
    return Math.abs(this.mobileMoveVectorX) > 0.06 || Math.abs(this.mobileMoveVectorY) > 0.06;
  }

  updateMovement(delta) {
    if (this.updateLocalEliminationDrop(delta)) {
      return;
    }
    if (this.updateSpectatorMovement(delta)) {
      return;
    }

    const movementEnabled = this.canMovePlayer();
    const keyboardForward = movementEnabled
      ? (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) -
        (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0)
      : 0;
    const keyboardStrafe = movementEnabled
      ? (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) -
        (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0)
      : 0;
    const mobileForward = movementEnabled && this.mobileEnabled ? -this.mobileMoveVectorY : 0;
    const mobileStrafe = movementEnabled && this.mobileEnabled ? this.mobileMoveVectorX : 0;
    const keyForward = THREE.MathUtils.clamp(keyboardForward + mobileForward, -1, 1);
    const keyStrafe = THREE.MathUtils.clamp(keyboardStrafe + mobileStrafe, -1, 1);

    const sprinting =
      movementEnabled && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"));
    const speed = sprinting ? GAME_CONSTANTS.PLAYER_SPRINT : GAME_CONSTANTS.PLAYER_SPEED;

    if (keyForward !== 0 || keyStrafe !== 0) {
      const sinYaw = Math.sin(this.yaw);
      const cosYaw = Math.cos(this.yaw);

      this.moveForwardVec.set(-sinYaw, 0, -cosYaw);
      this.moveRightVec.set(cosYaw, 0, -sinYaw);

      this.moveVec
        .set(0, 0, 0)
        .addScaledVector(this.moveForwardVec, keyForward)
        .addScaledVector(this.moveRightVec, keyStrafe);

      const inputMagnitude = Math.min(1, this.moveVec.length());
      if (this.moveVec.lengthSq() > 0.0001) {
        this.moveVec.normalize();
      }

      const moveStep = speed * delta * inputMagnitude;
      const worldLimit = this.getBoundaryHardLimit();
      this.playerPosition.x = THREE.MathUtils.clamp(
        this.playerPosition.x + this.moveVec.x * moveStep,
        -worldLimit,
        worldLimit
      );
      this.playerPosition.z = THREE.MathUtils.clamp(
        this.playerPosition.z + this.moveVec.z * moveStep,
        -worldLimit,
        worldLimit
      );
    }

    this.verticalVelocity += GAME_CONSTANTS.PLAYER_GRAVITY * delta;
    this.playerPosition.y += this.verticalVelocity * delta;

    if (this.playerPosition.y <= GAME_CONSTANTS.PLAYER_HEIGHT) {
      this.playerPosition.y = GAME_CONSTANTS.PLAYER_HEIGHT;
      this.verticalVelocity = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    this.updateBoundaryGuard(delta);
    this.camera.position.copy(this.playerPosition);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  updateRemotePlayers(delta) {
    const alpha = THREE.MathUtils.clamp(1 - Math.exp(-this.remoteLerpSpeed * delta), 0, 1);
    const now = performance.now();

    for (const [id, remote] of this.remotePlayers) {
      remote.mesh.position.lerp(remote.targetPosition, alpha);
      remote.mesh.rotation.y = lerpAngle(remote.mesh.rotation.y, remote.targetYaw, alpha);

      if (remote.chatLabel?.visible && now >= remote.chatExpireAt) {
        remote.chatLabel.visible = false;
      }

      if (now - remote.lastSeen > this.remoteStaleTimeoutMs) {
        this.removeRemotePlayer(id);
      }
    }
  }

  handleChatMessage(payload) {
    const text = String(payload?.text ?? "").trim().slice(0, 120);
    if (!text) {
      return;
    }

    const senderId = String(payload?.id ?? "");
    const senderName = this.formatPlayerName(payload?.name);
    const eventSignature = `${senderId || senderName}|${text}`;
    const now = performance.now();
    const previousSeenAt = Number(this.recentChatEventSignatures.get(eventSignature) || 0);
    if (previousSeenAt > 0 && now - previousSeenAt < 450) {
      return;
    }
    this.recentChatEventSignatures.set(eventSignature, now);
    if (this.recentChatEventSignatures.size > 80) {
      for (const [signature, seenAt] of this.recentChatEventSignatures) {
        if (now - Number(seenAt || 0) > 5000) {
          this.recentChatEventSignatures.delete(signature);
        }
      }
    }
    const signature = `${senderName}|${text}`;

    if (senderId && senderId === this.localPlayerId) {
      this.localPlayerName = senderName;
      const elapsed = performance.now() - this.lastLocalChatEchoAt;
      const isRecentEcho =
        this.lastLocalChatEcho === signature && elapsed < RUNTIME_TUNING.CHAT_ECHO_DEDUP_MS;
      if (!isRecentEcho) {
        this.appendChatLine(senderName, text, "self");
      }
      this.lastLocalChatEcho = "";
      this.lastLocalChatEchoAt = 0;
      return;
    }

    this.appendChatLine(senderName, text, "remote");

    let remote = null;
    if (senderId) {
      this.upsertRemotePlayer(senderId, null, senderName);
      remote = this.remotePlayers.get(senderId) ?? null;
    } else {
      remote = this.findRemotePlayerByName(senderName);
    }
    if (!remote) {
      return;
    }

    if (senderName !== remote.name) {
      remote.name = senderName;
      this.setTextLabel(remote.nameLabel, senderName, "name");
    }

    const chatLabel = this.ensureRemoteChatLabel(remote);
    if (!chatLabel) {
      return;
    }
    this.setTextLabel(chatLabel, text, "chat");
    chatLabel.visible = true;
    remote.chatExpireAt = performance.now() + this.chatBubbleLifetimeMs;
  }

  handleChatHistory(payload = {}) {
    this.resolveUiElements();
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const replace = payload?.replace !== false;
    if (replace) {
      this.chatLogEl?.replaceChildren?.();
      this.chatLiveLogEl?.replaceChildren?.();
      this.recentChatEventSignatures.clear();
      this.lastLocalChatEcho = "";
      this.lastLocalChatEchoAt = 0;
    }
    if (entries.length <= 0) {
      return;
    }

    const myId = String(this.localPlayerId ?? "");
    for (const entry of entries) {
      const typeRaw = String(entry?.type ?? "remote").trim().toLowerCase();
      const text = String(entry?.text ?? "").trim().slice(0, 120);
      if (!text) {
        continue;
      }
      if (typeRaw === "system") {
        this.appendChatLine("시스템", text, "system", {
          mobilePreview: false,
          scroll: false,
          liveFeed: false
        });
        continue;
      }
      const senderId = String(entry?.id ?? "");
      const senderName = this.formatPlayerName(entry?.name);
      const lineType = senderId && senderId === myId ? "self" : "remote";
      this.appendChatLine(senderName, text, lineType, {
        mobilePreview: false,
        scroll: false,
        liveFeed: false
      });
    }
    if (this.chatLogEl) {
      this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    }
  }

  handleChatBlocked(payload = {}) {
    const reason = this.translateQuizError(payload?.reason ?? payload?.code ?? "chat blocked");
    this.appendChatLine("시스템", `채팅이 차단되었습니다: ${reason}`, "system");
  }

  handleHostKicked() {
    this.disconnectedByKick = true;
    this.appendChatLine("시스템", "진행자에 의해 강퇴되었습니다.", "system");
    if (!this.socket) {
      return;
    }
    try {
      if (this.socket.io?.opts) {
        this.socket.io.opts.reconnection = false;
      }
    } catch {
      // ignore
    }
    this.socket.disconnect();
  }

  handleHostChatMuted(payload = {}) {
    const muted = payload?.muted === true;
    this.appendChatLine(
      "시스템",
      muted
        ? "진행자가 채팅을 금지했습니다."
        : "진행자가 채팅 금지를 해제했습니다.",
      "system"
    );
    if (muted) {
      this.setChatOpen(false);
      this.chatInputEl?.blur?.();
    }
  }

  resetQuizStateLocal() {
    this.quizState.active = false;
    this.quizState.phase = "idle";
    this.quizState.autoMode = false;
    this.quizState.autoFinish = true;
    this.quizState.autoStartsAt = 0;
    this.quizState.prepareEndsAt = 0;
    this.quizState.hostId = null;
    this.quizState.questionIndex = 0;
    this.quizState.totalQuestions = 0;
    this.quizState.lockAt = 0;
    this.quizState.lockResolveAt = 0;
    this.quizState.questionText = "";
    this.quizState.survivors = 0;
    this.quizState.myScore = 0;
    this.serverHostSpectator = false;
    this.hostSpectatorOverride = false;
    this.localQuizAlive = true;
    this.localSpectatorMode = false;
    this.localEliminationDrop.active = false;
    this.localEliminationDrop.elapsed = 0;
    this.localEliminationDrop.velocityY = 0;
    this.spectatorFollowId = null;
    this.spectatorFollowIndex = -1;
    this.resetTrapdoors();
    this.centerBillboardLastCountdown = null;
    this.hideRoundOverlay();
    this.closeOfflineStartModal();
    this.closeQuizReviewModal();
    this.setOppositeBillboardResultVisible(false);
    this.renderCenterBillboard({
      layout: "explanation",
      kicker: "문제 전광판",
      title: "문항 대기 중",
      explanation: "문항이 시작되면 이 전광판에 문제가 표시됩니다.",
      footer: ""
    });
    this.renderQuizProgressBillboard(true);
    this.updateQuizControlUi();
  }

  handleQuizAutoCountdown(payload = {}) {
    this.quizState.autoMode = payload.autoMode !== false;
    this.quizState.autoStartsAt = Math.max(
      0,
      Math.trunc(
        Number(payload.startsAt) || (Date.now() + Math.max(0, Math.trunc(Number(payload.delayMs) || 0)))
      )
    );
    if (this.quizState.active) {
      return;
    }
    this.setOppositeBillboardResultVisible(false);
    const seconds = this.getAutoStartCountdownSeconds();
    if (seconds > 0) {
      this.appendChatLine(
        "시스템",
        `게임이 곧 시작됩니다 (${seconds}초 전, ${Math.max(0, Math.trunc(Number(payload.players) || 0))}/${Math.max(1, Math.trunc(Number(payload.minPlayers) || 1))})`,
        "system"
      );
      this.renderCenterBillboard({
        layout: "explanation",
        kicker: "문제 전광판",
        title: "문항 대기 중",
        explanation: `${seconds}초 후 게임이 시작됩니다. 첫 문항이 열리면 이 전광판에 문제가 표시됩니다.`,
        footer: ""
      });
      this.renderQuizProgressBillboard(true);
      this.hud.setStatus(this.getStatusText());
    }
  }

  handleQuizStart(payload = {}) {
    this.quizState.active = true;
    this.quizState.phase = "start";
    this.quizState.autoMode = payload.autoMode !== false;
    this.quizState.autoFinish = payload.autoFinish !== false;
    this.quizState.autoStartsAt = 0;
    this.quizState.prepareEndsAt = Math.max(
      0,
      Math.trunc(
        Number(payload.prepareEndsAt) || (Date.now() + Math.max(0, Math.trunc(Number(payload.prepareDelayMs) || 0)))
      )
    );
    this.quizState.hostId = payload.hostId ?? null;
    this.quizState.questionIndex = 0;
    this.quizState.totalQuestions = Math.max(0, Math.trunc(Number(payload.totalQuestions) || 0));
    this.quizState.lockAt = 0;
    this.quizState.lockResolveAt = 0;
    this.quizState.questionText = "";
    this.localQuizAlive = true;
    this.closeQuizReviewModal();
    this.setQuizReviewItems([]);
    this.ensureLocalGameplayPosition();
    this.resetTrapdoors();
    this.centerBillboardLastCountdown = null;
    this.closeOfflineStartModal();
    this.setOppositeBillboardResultVisible(false);

    const totalText =
      this.quizState.totalQuestions > 0 ? `${this.quizState.totalQuestions}` : "?";
    const prepareSeconds =
      this.quizState.prepareEndsAt > 0
        ? Math.max(1, Math.ceil((this.quizState.prepareEndsAt - Date.now()) / 1000))
        : Math.ceil(ROUND_OVERLAY_SETTINGS.prepareDurationSeconds);
    this.appendChatLine(
      "시스템",
      `게임이 곧 시작됩니다. 총 문제 수: ${totalText} (약 ${prepareSeconds}초 후 시작)`,
      "system"
    );
    this.showRoundOverlay({
      title: "게임이 곧 시작됩니다",
      subtitle: `${prepareSeconds}초 후 첫 문항이 열립니다.`,
      fireworks: false,
      durationSeconds: Math.max(prepareSeconds, 2.2)
    });
    this.renderCenterBillboard({
      layout: "explanation",
      kicker: "문제 전광판",
      title: "문항 대기 중",
      explanation: `총 ${totalText}문항이 곧 시작됩니다. 문항 시작 시 문제가 이 전광판에 표시됩니다.`,
      footer: ""
    });
    this.renderQuizProgressBillboard(true);
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizQuestion(payload = {}) {
    this.quizState.active = true;
    this.quizState.phase = "question";
    this.quizState.questionIndex = Math.max(1, Math.trunc(Number(payload.index) || 1));
    this.quizState.totalQuestions = Math.max(
      this.quizState.questionIndex,
      Math.trunc(Number(payload.totalQuestions) || this.quizState.totalQuestions || 1)
    );
    this.quizState.lockAt = Math.max(0, Math.trunc(Number(payload.lockAt) || 0));
    this.quizState.lockResolveAt = 0;
    this.quizState.questionText = String(payload.text ?? "").trim().slice(0, 180);
    this.quizState.autoStartsAt = 0;
    this.quizState.prepareEndsAt = 0;
    this.resetTrapdoors();
    this.hideRoundOverlay();
    this.centerBillboardLastCountdown = null;
    this.setOppositeBillboardResultVisible(false);

    const questionText = this.quizState.questionText || "문제가 열렸습니다";
    this.appendChatLine(
      "시스템",
      `문항 ${this.quizState.questionIndex}/${this.quizState.totalQuestions}: ${questionText}`,
      "system"
    );
    this.syncQuizBillboard(true);
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizLock(payload = {}) {
    this.quizState.phase = "lock";
    this.quizState.lockAt = 0;
    this.quizState.lockResolveAt = Math.max(0, Math.trunc(Number(payload.resolveAt) || 0));
    this.setOppositeBillboardResultVisible(false);
    const index = Math.max(
      this.quizState.questionIndex,
      Math.trunc(Number(payload.index) || this.quizState.questionIndex || 0)
    );
    this.quizState.questionIndex = index;
    if (this.localQuizAlive && !this.localSpectatorMode) {
      this.keys.clear();
      this.releaseMobileInputs();
      this.emitImmediateLocalSync("quiz-lock");
    }
    this.appendChatLine("시스템", `문항 ${index} 잠금. 판정 중...`, "system");
    this.renderCenterBillboard({
      layout: "explanation",
      kicker: "문제 전광판",
      title: `문항 ${index} 잠금`,
      explanation: this.quizState.questionText || "현재 문항을 판정 중입니다.",
      footer: ""
    });
    this.renderQuizProgressBillboard(true);
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizResult(payload = {}) {
    this.quizState.phase = "result";
    this.quizState.lockResolveAt = 0;
    const index = Math.max(
      this.quizState.questionIndex,
      Math.trunc(Number(payload.index) || this.quizState.questionIndex || 0)
    );
    this.quizState.questionIndex = index;
    const answer = String(payload.answer ?? "").trim().toUpperCase();
    this.triggerTrapdoorForAnswer(answer);
    const survivorCount = Math.max(0, Math.trunc(Number(payload.survivorCount) || 0));
    this.quizState.survivors = survivorCount;

    const myId = String(this.localPlayerId ?? "");
    const eliminatedIds = Array.isArray(payload.eliminatedPlayerIds)
      ? payload.eliminatedPlayerIds.map((entry) => String(entry))
      : [];
    const eliminatedSet = new Set(eliminatedIds);
    const eliminatedPlayers = Array.isArray(payload.eliminatedPlayers) ? payload.eliminatedPlayers : [];
    const myElimination =
      eliminatedPlayers.find((entry) => String(entry?.id ?? "") === myId) ??
      (eliminatedSet.has(myId) ? { reason: "오답 구역" } : null);
    if (myElimination && !this.localSpectatorMode) {
      this.localQuizAlive = false;
      this.startLocalEliminationDrop(myElimination.reason ?? "오답 구역");
    }

    this.appendChatLine(
      "시스템",
      `문항 ${index} 결과: 정답=${answer || "?"}, 생존=${survivorCount}`,
      "system"
    );
    this.renderCenterBillboard({
      layout: "explanation",
      kicker: `문항 ${index} 문제`,
      title: `정답 ${answer || "?"}`,
      explanation: this.quizState.questionText || "문항 텍스트가 없습니다.",
      footer: ""
    });
    this.setOppositeBillboardResultVisible(false);
    this.renderQuizProgressBillboard(true);
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizScore(payload = {}) {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);
    const prevPhase = String(this.quizState.phase ?? "idle");
    if (hasOwn("active")) {
      this.quizState.active = Boolean(payload.active);
    }
    if (hasOwn("phase")) {
      this.quizState.phase = String(payload.phase ?? "idle");
      if (this.quizState.phase !== "result") {
        this.setOppositeBillboardResultVisible(false);
      }
    }
    if (
      prevPhase !== this.quizState.phase &&
      (this.quizState.phase === "lock" || this.quizState.phase === "locked") &&
      this.localQuizAlive &&
      !this.localSpectatorMode
    ) {
      this.keys.clear();
      this.releaseMobileInputs();
      this.emitImmediateLocalSync("quiz-score-lock");
    }
    if (hasOwn("autoMode")) {
      this.quizState.autoMode = payload.autoMode !== false;
    }
    if (hasOwn("autoFinish")) {
      this.quizState.autoFinish = payload.autoFinish !== false;
    }
    if (hasOwn("autoStartsAt")) {
      this.quizState.autoStartsAt = Math.max(0, Math.trunc(Number(payload.autoStartsAt) || 0));
    }
    if (hasOwn("prepareEndsAt")) {
      this.quizState.prepareEndsAt = Math.max(0, Math.trunc(Number(payload.prepareEndsAt) || 0));
    }
    if (hasOwn("hostId")) {
      this.quizState.hostId = payload.hostId ?? null;
    }
    this.quizState.questionIndex = Math.max(
      this.quizState.questionIndex,
      Math.trunc(Number(payload.questionIndex) || this.quizState.questionIndex || 0)
    );
    this.quizState.totalQuestions = Math.max(
      this.quizState.totalQuestions,
      Math.trunc(Number(payload.totalQuestions) || this.quizState.totalQuestions || 0)
    );
    this.quizState.survivors = Math.max(0, Math.trunc(Number(payload.survivors) || 0));
    this.quizState.lockAt = Math.max(0, Math.trunc(Number(payload.lockAt) || this.quizState.lockAt || 0));
    this.quizState.lockResolveAt = Math.max(
      0,
      Math.trunc(Number(payload.lockResolveAt) || this.quizState.lockResolveAt || 0)
    );

    const myId = String(this.localPlayerId ?? "");
    const leaderboard = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
    if (leaderboard.length > 0) {
      const previousRosterById = new Map(
        this.roomRoster.map((entry) => [String(entry?.id ?? ""), entry])
      );
      this.roomRoster = leaderboard
        .map((entry) => {
          const id = String(entry?.id ?? "");
          if (!id) {
            return null;
          }
          const prev = previousRosterById.get(id) ?? null;
          return {
            id,
            name: this.formatPlayerName(entry?.name),
            alive: entry?.alive !== false,
            admitted: prev?.admitted !== false,
            score: Math.max(0, Math.trunc(Number(entry?.score) || 0)),
            isHost: id === String(this.quizState.hostId ?? ""),
            spectator: entry?.spectator === true,
            isMe: id === myId
          };
        })
        .filter(Boolean);
    }
    const stateById = new Map();
    for (const entry of leaderboard) {
      const id = String(entry?.id ?? "");
      if (!id) {
        continue;
      }
      stateById.set(id, {
        alive: entry?.alive !== false,
        spectator: entry?.spectator === true
      });
    }

    const me = leaderboard.find((entry) => String(entry?.id ?? "") === myId) ?? null;
    if (me) {
      this.quizState.myScore = Math.max(0, Math.trunc(Number(me.score) || 0));
      const isHostSpectator = me?.spectator === true;
      this.serverHostSpectator = isHostSpectator;
      this.hostSpectatorOverride = this.isLocalHost() && !isHostSpectator;
      if (isHostSpectator) {
        this.localQuizAlive = true;
        if (this.quizState.active && !this.hostSpectatorOverride) {
          this.enterHostSpectatorMode();
        }
      } else {
        const nextAlive = me.alive !== false;
        if (this.quizState.active && this.localQuizAlive && !nextAlive) {
          this.startLocalEliminationDrop("점수판 동기화");
        } else if (
          nextAlive &&
          !this.localQuizAlive &&
          (!this.quizState.active || this.quizState.phase === "start")
        ) {
          this.localSpectatorMode = false;
          this.localEliminationDrop.active = false;
          this.localEliminationDrop.elapsed = 0;
          this.localEliminationDrop.velocityY = 0;
          this.spectatorFollowId = null;
          this.spectatorFollowIndex = -1;
        }
        this.localQuizAlive = nextAlive;
      }
    }

    for (const [remoteId, remote] of this.remotePlayers) {
      if (!stateById.has(remoteId)) {
        continue;
      }
      const next = stateById.get(remoteId);
      this.setRemoteAliveVisual(remote, next?.alive !== false, next?.spectator === true);
    }

    this.refreshRosterPanel();
    this.syncQuizBillboard();
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizReset(payload = {}) {
    const hasHostId = Object.prototype.hasOwnProperty.call(payload ?? {}, "hostId");
    const nextHostId = hasHostId ? payload.hostId ?? null : this.quizState.hostId ?? null;
    this.resetQuizStateLocal();
    this.quizState.hostId = nextHostId;
    this.setOfflineStartStatus("");
    this.appendChatLine(
      "시스템",
      "호스트가 접속하여 오프라인 진행이 초기화되었습니다. 대기 상태로 전환합니다.",
      "system"
    );
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizEnd(payload = {}) {
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, "hostId")) {
      this.quizState.hostId = payload.hostId ?? this.quizState.hostId ?? null;
    }
    const payloadHostId = String(payload?.hostId ?? "");
    const myId = String(this.localPlayerId ?? "");
    const isHost = Boolean(
      myId &&
        ((payloadHostId && payloadHostId === myId) ||
          String(this.quizState.hostId ?? "") === myId)
    );
    const rankingSource = Array.isArray(payload.ranking)
      ? payload.ranking
      : Array.isArray(payload.leaderboard)
        ? payload.leaderboard
        : [];
    const ranking = rankingSource
      .map((entry, index) => {
        const rankValue = Math.max(1, Math.trunc(Number(entry?.rank) || index + 1));
        return {
          rank: rankValue,
          name: this.formatPlayerName(entry?.name),
          score: Math.max(0, Math.trunc(Number(entry?.score) || 0))
        };
      })
      .sort((left, right) => left.rank - right.rank);

    if (ranking.length > 0) {
      const rankingLabel = ranking
        .slice(0, 5)
        .map((entry) => `${entry.rank}위 ${entry.name}(${entry.score}점)`)
        .join(", ");
      this.appendChatLine("시스템", `게임 종료. 최종 순위: ${rankingLabel}`, "system");
    } else {
      this.appendChatLine("시스템", "퀴즈가 종료되었습니다.", "system");
    }

    this.quizState.active = false;
    this.quizState.phase = "ended";
    this.quizState.lockAt = 0;
    this.quizState.lockResolveAt = 0;
    this.quizState.prepareEndsAt = 0;
    this.centerBillboardLastCountdown = null;
    this.setOppositeBillboardResultVisible(false);
    this.setQuizReviewItems(payload?.review);

    if (isHost) {
      this.hideRoundOverlay();
      this.renderCenterBillboard({
        layout: "explanation",
        kicker: "문제 전광판",
        title: "라운드 종료",
        explanation: "이번 라운드가 종료되었습니다. 다음 라운드 시작 시 새 문항이 표시됩니다.",
        footer: ""
      });
    } else {
      this.showRoundOverlay({
        title: "게임이 종료되었습니다",
        subtitle:
          ranking.length > 0
            ? ranking
                .slice(0, 3)
                .map((entry) => `${entry.rank}위 ${entry.name} ${entry.score}점`)
                .join(" | ")
            : "최종 순위를 계산할 수 없습니다.",
        fireworks: true,
        durationSeconds: ROUND_OVERLAY_SETTINGS.endDurationSeconds
      });
      this.renderCenterBillboard({
        layout: "explanation",
        kicker: "문제 전광판",
        title: "라운드 종료",
        explanation: "이번 라운드가 종료되었습니다. 호스트가 다음 라운드를 시작하면 새 문항이 표시됩니다.",
        footer: ""
      });
    }

    this.renderQuizProgressBillboard(true);
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
    if (!isHost && this.quizReviewItems.length > 0) {
      window.setTimeout(() => {
        if (this.quizState.phase === "ended" && this.quizReviewItems.length > 0) {
          this.openQuizReviewModal();
        }
      }, 900);
    }
  }
  syncQuizBillboard(force = false) {
    const renderQuestionPanel = (title, questionText) => {
      this.renderCenterBillboard({
        layout: "explanation",
        kicker: "문제 전광판",
        title,
        explanation: String(questionText ?? "").trim() || "문항 텍스트가 없습니다.",
        footer: ""
      });
    };

    if (!this.quizState.active) {
      const autoSeconds = this.getAutoStartCountdownSeconds();
      if (autoSeconds > 0) {
        this.centerBillboardLastCountdown = autoSeconds;
        renderQuestionPanel(
          "문항 대기 중",
          `${autoSeconds}초 후 라운드가 시작됩니다.`
        );
      } else if (force || this.centerBillboardLastCountdown !== null) {
        this.centerBillboardLastCountdown = null;
        renderQuestionPanel("문항 대기 중", "문항이 시작되면 문제가 표시됩니다.");
      }
      this.renderQuizProgressBillboard(force || autoSeconds > 0);
      return;
    }

    if (this.quizState.phase === "start") {
      const seconds = this.getQuizPrepareSeconds();
      this.centerBillboardLastCountdown = seconds;
      renderQuestionPanel("문항 대기 중", `${seconds}초 후 첫 문항이 열립니다.`);
      this.renderQuizProgressBillboard(force || seconds > 0);
      return;
    }

    if (this.quizState.phase === "question") {
      const seconds = this.getQuizCountdownSeconds();
      const index = Math.max(1, this.quizState.questionIndex);
      const total = Math.max(this.quizState.totalQuestions, index);
      const question = this.quizState.questionText || "문항 텍스트가 없습니다.";
      this.centerBillboardLastCountdown = seconds;
      renderQuestionPanel(`문항 ${index}/${total}`, `${question}\n남은 시간 ${seconds}초`);
      this.renderQuizProgressBillboard(force || seconds > 0);
      return;
    }

    if (this.quizState.phase === "lock") {
      const index = Math.max(1, this.quizState.questionIndex);
      const total = Math.max(this.quizState.totalQuestions, index);
      this.centerBillboardLastCountdown = null;
      renderQuestionPanel(`문항 ${index}/${total} 잠금`, this.quizState.questionText || "문항 판정 중");
      this.renderQuizProgressBillboard(true);
      return;
    }

    if (this.quizState.phase === "waiting-next") {
      this.centerBillboardLastCountdown = null;
      renderQuestionPanel("다음 문항 대기", "곧 다음 문항이 표시됩니다.");
      this.renderQuizProgressBillboard(true);
      return;
    }

    if (force) {
      this.centerBillboardLastCountdown = null;
    }
    this.renderQuizProgressBillboard(force);
  }

  getQuizCountdownSeconds() {
    if (!this.quizState.active || this.quizState.phase !== "question") {
      return 0;
    }
    const lockAt = Number(this.quizState.lockAt) || 0;
    if (lockAt <= 0) {
      return 0;
    }
    return Math.max(0, Math.ceil((lockAt - Date.now()) / 1000));
  }

  getQuizPrepareSeconds() {
    if (!this.quizState.active || this.quizState.phase !== "start") {
      return 0;
    }
    const prepareEndsAt = Number(this.quizState.prepareEndsAt) || 0;
    if (prepareEndsAt <= 0) {
      return Math.ceil(ROUND_OVERLAY_SETTINGS.prepareDurationSeconds);
    }
    return Math.max(0, Math.ceil((prepareEndsAt - Date.now()) / 1000));
  }

  composeStatusWithQuiz(baseStatus) {
    const status = String(baseStatus ?? "");
    if (!this.quizState.active && this.quizState.phase !== "ended") {
      const autoSeconds = this.getAutoStartCountdownSeconds();
      if (autoSeconds > 0) {
        return `${status} | 자동 시작 ${autoSeconds}초`;
      }
      return status;
    }

    const questionLabel =
      this.quizState.questionIndex > 0
        ? `문항 ${this.quizState.questionIndex}/${Math.max(this.quizState.totalQuestions, this.quizState.questionIndex)}`
        : "문항 ?";

    if (this.quizState.phase === "question") {
      const seconds = this.getQuizCountdownSeconds();
      return `${status} | ${questionLabel} ${seconds}초 ${this.localQuizAlive ? "생존" : "탈락"}`;
    }
    if (this.quizState.phase === "lock") {
      return `${status} | ${questionLabel} 잠금 ${this.localQuizAlive ? "생존" : "탈락"}`;
    }
    if (this.quizState.phase === "result") {
      return `${status} | ${questionLabel} 생존자 ${this.quizState.survivors}명 ${this.localQuizAlive ? "생존" : "탈락"}`;
    }
    if (this.quizState.phase === "ended") {
      return `${status} | 퀴즈 종료`;
    }
    if (this.quizState.phase === "start") {
      const seconds = this.getQuizPrepareSeconds();
      return `${status} | 시작 준비 ${seconds}초`;
    }
    return `${status} | 퀴즈 ${this.formatQuizPhase(this.quizState.phase)}`;
  }

  isLocalHost() {
    const hostId = String(this.quizState.hostId ?? "");
    const myId = String(this.localPlayerId ?? "");
    return Boolean(hostId && myId && hostId === myId);
  }

  translateQuizError(rawError) {
    const code = String(rawError ?? "").trim().toLowerCase();
    const table = {
      "not in room": "방에 참여한 상태가 아닙니다.",
      "host only": "방장만 사용할 수 있습니다.",
      "host present": "호스트가 접속 중이라 오프라인 시작을 사용할 수 없습니다.",
      "quiz is not active": "진행 중인 퀴즈가 없습니다.",
      "question is not open": "열린 문제가 없습니다.",
      "question is already open": "이미 문제가 열려 있습니다.",
      "no previous question": "더 이전 문제는 없습니다.",
      "quiz already active": "이미 퀴즈가 진행 중입니다.",
      "no more questions": "남은 문제가 없습니다.",
      "room missing": "방 정보를 찾을 수 없습니다.",
      "gateway draining": "게이트웨이가 점검 중입니다.",
      "redirect build failed": "서버 라우팅 구성에 실패했습니다.",
      "no room capacity available": "현재 수용 가능한 방이 없습니다.",
      "no playable players": "참가 플레이어가 없어 시작할 수 없습니다.",
      "players waiting admission": "대기실 인원이 아직 입장하지 않았습니다. 입장 시작을 먼저 눌러주세요.",
      "category vote active": "카테고리 투표가 진행 중입니다. 투표가 끝난 뒤 시작할 수 있습니다.",
      "category vote already active": "이미 카테고리 투표가 진행 중입니다.",
      "category vote not active": "진행 중인 카테고리 투표가 없습니다.",
      "invalid category vote option": "선택한 카테고리가 올바르지 않습니다.",
      "lobby already open": "이미 포탈 대기실이 열려 있습니다.",
      "lobby not open": "포탈 대기실이 열려 있지 않습니다.",
      "admission already in progress": "이미 입장 카운트다운이 진행 중입니다.",
      "no waiting players": "현재 입장 대기 인원이 없습니다.",
      "invalid question config": "문항 설정 형식이 올바르지 않습니다.",
      unauthorized: "권한이 없습니다.",
      "invalid portal target": "포탈 링크 형식이 잘못되었습니다. http(s) 주소만 허용됩니다.",
      "invalid billboard target": "전광판 대상이 올바르지 않습니다.",
      "invalid billboard media": "전광판 미디어 형식이 올바르지 않습니다.",
      "chat muted": "채팅이 금지된 상태입니다.",
      "chat-muted": "채팅이 금지된 상태입니다.",
      "chat blocked": "채팅이 제한된 상태입니다.",
      "empty message": "빈 메시지는 전송할 수 없습니다.",
      "player not found": "대상 플레이어를 찾을 수 없습니다.",
      "target required": "대상 플레이어를 선택하세요.",
      "cannot target self": "자기 자신은 제재할 수 없습니다.",
      "all-questions-complete": "모든 문제가 종료되었습니다.",
      unknown: "알 수 없음"
    };
    return table[code] ?? String(rawError ?? "알 수 없음");
  }

  formatQuizPhase(rawPhase) {
    const phase = String(rawPhase ?? "idle");
    const phaseKorMap = {
      idle: "대기",
      start: "시작",
      question: "문제",
      lock: "잠금",
      locked: "잠금",
      result: "결과",
      "waiting-next": "다음 대기",
      ended: "종료"
    };
    return phaseKorMap[phase] ?? phase;
  }

  normalizeQuizAnswerChoice(raw) {
    const value = String(raw ?? "")
      .trim()
      .toUpperCase();
    return value === "X" ? "X" : "O";
  }

  normalizeQuizTimeLimitSeconds(raw, fallback = QUIZ_DEFAULT_TIME_LIMIT_SECONDS) {
    const fallbackSeconds = Math.max(
      QUIZ_MIN_TIME_LIMIT_SECONDS,
      Math.min(QUIZ_MAX_TIME_LIMIT_SECONDS, Math.trunc(Number(fallback) || QUIZ_DEFAULT_TIME_LIMIT_SECONDS))
    );
    const seconds = Math.trunc(Number(raw));
    if (!Number.isFinite(seconds)) {
      return fallbackSeconds;
    }
    return Math.max(QUIZ_MIN_TIME_LIMIT_SECONDS, Math.min(QUIZ_MAX_TIME_LIMIT_SECONDS, seconds));
  }

  createDefaultQuizQuestion(index = 0) {
    const order = Math.max(0, Math.trunc(Number(index) || 0)) + 1;
    return {
      id: `Q${order}`,
      text: `문항 ${order}`,
      answer: "O",
      explanation: "",
      timeLimitSeconds: QUIZ_DEFAULT_TIME_LIMIT_SECONDS
    };
  }

  buildDefaultQuizConfig(slotCount = 10) {
    const count = Math.max(1, Math.min(50, Math.trunc(Number(slotCount) || 10)));
    const questions = [];
    for (let i = 0; i < count; i += 1) {
      questions.push(this.createDefaultQuizQuestion(i));
    }
    return {
      maxQuestions: 50,
      questions,
      endPolicy: {
        autoFinish: true,
        showOppositeBillboard: true
      }
    };
  }

  normalizeQuizConfigPayload(payload = {}) {
    const sourceQuestions = Array.isArray(payload?.questions) ? payload.questions : [];
    const maxQuestions = Math.max(
      1,
      Math.min(50, Math.trunc(Number(payload?.maxQuestions) || this.quizConfig?.maxQuestions || 50))
    );
    const questions = sourceQuestions
      .map((entry, index) => {
        const text = String(entry?.text ?? "")
          .trim()
          .slice(0, 180);
        const fallbackTimeLimit = this.normalizeQuizTimeLimitSeconds(
          this.quizConfig?.questions?.[index]?.timeLimitSeconds,
          QUIZ_DEFAULT_TIME_LIMIT_SECONDS
        );
        return {
          id: String(entry?.id ?? `Q${index + 1}`)
            .trim()
            .slice(0, 24) || `Q${index + 1}`,
          text: text || `문항 ${index + 1}`,
          answer: this.normalizeQuizAnswerChoice(entry?.answer),
          explanation: String(entry?.explanation ?? "")
            .trim()
            .slice(0, 720),
          timeLimitSeconds: this.normalizeQuizTimeLimitSeconds(
            entry?.timeLimitSeconds ?? entry?.lockSeconds,
            fallbackTimeLimit
          )
        };
      })
      .slice(0, maxQuestions);
    const finalQuestions = questions.length > 0 ? questions : this.buildDefaultQuizConfig(10).questions;
    const sourceEndPolicy =
      payload?.endPolicy && typeof payload.endPolicy === "object" ? payload.endPolicy : null;
    const hasShowOppositeBillboard =
      sourceEndPolicy &&
      Object.prototype.hasOwnProperty.call(sourceEndPolicy, "showOppositeBillboard");
    const hasTopLevelShowOppositeBillboard = Object.prototype.hasOwnProperty.call(
      payload ?? {},
      "showOppositeBillboard"
    );
    const fallbackShowOppositeBillboard =
      this.quizConfig?.endPolicy?.showOppositeBillboard !== false;
    return {
      maxQuestions,
      questions: finalQuestions,
      endPolicy: {
        autoFinish: sourceEndPolicy?.autoFinish !== false,
        showOppositeBillboard: hasShowOppositeBillboard
          ? sourceEndPolicy.showOppositeBillboard !== false
          : hasTopLevelShowOppositeBillboard
            ? payload.showOppositeBillboard !== false
            : fallbackShowOppositeBillboard
      }
    };
  }

  getQuizConfigDraftRoomCode() {
    const roomCode = String(
      this.currentRoomCode ||
        this.socketAuth?.roomCode ||
        this.queryParams?.get?.("room") ||
        ""
    )
      .trim()
      .toUpperCase();
    return roomCode;
  }

  getQuizConfigDraftStorageKey() {
    const roomCode = this.getQuizConfigDraftRoomCode();
    if (!roomCode) {
      return "";
    }
    return `${QUIZ_CONFIG_DRAFT_STORAGE_PREFIX}.${roomCode}`;
  }

  readQuizConfigDraft() {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    const key = this.getQuizConfigDraftStorageKey();
    if (!key) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      const updatedAt = Number(parsed?.updatedAt || 0);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
        return null;
      }
      if (Date.now() - updatedAt > QUIZ_CONFIG_DRAFT_MAX_AGE_MS) {
        window.localStorage.removeItem(key);
        return null;
      }
      const config = this.normalizeQuizConfigPayload(parsed?.config ?? {});
      return {
        updatedAt,
        config
      };
    } catch {
      return null;
    }
  }

  writeQuizConfigDraft(config = null) {
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }
    const key = this.getQuizConfigDraftStorageKey();
    if (!key) {
      return false;
    }
    const safeConfig = this.normalizeQuizConfigPayload(config ?? this.quizConfig ?? {});
    const payload = {
      version: 1,
      roomCode: this.getQuizConfigDraftRoomCode(),
      updatedAt: Date.now(),
      config: safeConfig
    };
    try {
      window.localStorage.setItem(key, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  buildQuizConfigFromEditor() {
    const maxQuestions = Math.max(1, Math.min(50, Math.trunc(Number(this.quizConfig?.maxQuestions) || 50)));
    const targetCount = Math.max(
      1,
      Math.min(maxQuestions, Math.trunc(Number(this.quizSlotCountInputEl?.value) || 1))
    );
    const editorQuestions = this.collectQuizConfigQuestionsFromEditor();
    const nextQuestions = editorQuestions.slice(0, targetCount);
    while (nextQuestions.length < targetCount) {
      nextQuestions.push(this.createDefaultQuizQuestion(nextQuestions.length));
    }
    return this.normalizeQuizConfigPayload({
      maxQuestions,
      questions: nextQuestions,
      endPolicy: {
        autoFinish: this.quizAutoFinishInputEl?.checked !== false,
        showOppositeBillboard: this.quizOppositeBillboardInputEl?.checked !== false
      }
    });
  }

  persistQuizConfigDraft({ immediate = false, updateState = true } = {}) {
    if (this.quizConfigDraftSaveTimer) {
      window.clearTimeout(this.quizConfigDraftSaveTimer);
      this.quizConfigDraftSaveTimer = null;
    }
    if (!immediate) {
      this.quizConfigDraftSaveTimer = window.setTimeout(() => {
        this.quizConfigDraftSaveTimer = null;
        this.persistQuizConfigDraft({ immediate: true, updateState: true });
      }, 220);
      return;
    }
    if (this.quizConfigModalEl?.classList.contains("hidden")) {
      return;
    }
    const nextConfig = this.buildQuizConfigFromEditor();
    if (updateState) {
      this.quizConfig = nextConfig;
    }
    this.writeQuizConfigDraft(nextConfig);
  }

  restoreQuizConfigDraftIfAvailable() {
    if (this.quizConfigDraftRestoreAttempted) {
      return false;
    }
    this.quizConfigDraftRestoreAttempted = true;
    const draft = this.readQuizConfigDraft();
    if (!draft?.config) {
      return false;
    }
    this.quizConfig = draft.config;
    this.renderQuizConfigEditor();
    this.setQuizConfigStatus("임시저장 문항을 복구했습니다. 저장 버튼으로 서버에 반영하세요.");
    return true;
  }

  setQuizConfigStatus(message, isError = false) {
    if (!this.quizConfigStatusEl) {
      return;
    }
    const text = String(message ?? "").trim();
    this.quizConfigStatusEl.textContent = text || "문항과 정답/해설을 편집하세요.";
    this.quizConfigStatusEl.classList.toggle("error", Boolean(isError));
  }

  collectQuizConfigQuestionsFromEditor() {
    if (!this.quizQuestionListEl) {
      return [];
    }
    const rows = Array.from(this.quizQuestionListEl.querySelectorAll(".quiz-question-row"));
    return rows
      .map((row, index) => {
        const textEl = row.querySelector(".quiz-question-text");
        const answerEl = row.querySelector(".quiz-question-answer");
        const explanationEl = row.querySelector(".quiz-question-explanation");
        const timeLimitEl = row.querySelector(".quiz-question-time");
        const fallbackTimeLimit = this.normalizeQuizTimeLimitSeconds(
          this.quizConfig?.questions?.[index]?.timeLimitSeconds,
          QUIZ_DEFAULT_TIME_LIMIT_SECONDS
        );
        const text = String(textEl?.value ?? "")
          .trim()
          .slice(0, 180);
        return {
          id: `Q${index + 1}`,
          text: text || `문항 ${index + 1}`,
          answer: this.normalizeQuizAnswerChoice(answerEl?.value),
          explanation: String(explanationEl?.value ?? "")
            .trim()
            .slice(0, 720),
          timeLimitSeconds: this.normalizeQuizTimeLimitSeconds(timeLimitEl?.value, fallbackTimeLimit)
        };
      });
  }

  renderQuizConfigEditor() {
    this.resolveUiElements();
    if (!this.quizQuestionListEl) {
      return;
    }
    const questions = Array.isArray(this.quizConfig?.questions) ? this.quizConfig.questions : [];
    const maxQuestions = Math.max(1, Math.min(50, Math.trunc(Number(this.quizConfig?.maxQuestions) || 50)));
    const safeQuestions = questions.slice(0, maxQuestions);
    if (safeQuestions.length <= 0) {
      safeQuestions.push(this.createDefaultQuizQuestion(0));
    }
    this.quizConfig.questions = safeQuestions;
    this.quizConfig.maxQuestions = maxQuestions;

    if (this.quizSlotCountInputEl) {
      this.quizSlotCountInputEl.max = String(maxQuestions);
      this.quizSlotCountInputEl.value = String(safeQuestions.length);
    }
    if (this.quizTimeUnifyInputEl) {
      const unifiedSeconds = this.normalizeQuizTimeLimitSeconds(
        safeQuestions[0]?.timeLimitSeconds,
        QUIZ_DEFAULT_TIME_LIMIT_SECONDS
      );
      this.quizTimeUnifyInputEl.min = String(QUIZ_MIN_TIME_LIMIT_SECONDS);
      this.quizTimeUnifyInputEl.max = String(QUIZ_MAX_TIME_LIMIT_SECONDS);
      this.quizTimeUnifyInputEl.step = "1";
      this.quizTimeUnifyInputEl.value = String(unifiedSeconds);
    }
    if (this.quizAutoFinishInputEl) {
      this.quizAutoFinishInputEl.checked = this.quizConfig?.endPolicy?.autoFinish !== false;
    }
    if (this.quizOppositeBillboardInputEl) {
      this.quizOppositeBillboardInputEl.checked =
        this.quizConfig?.endPolicy?.showOppositeBillboard !== false;
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < safeQuestions.length; index += 1) {
      const question = safeQuestions[index];
      const row = document.createElement("div");
      row.className = "quiz-question-row";
      row.dataset.index = String(index);

      const order = document.createElement("div");
      order.className = "quiz-question-order";
      order.textContent = String(index + 1);

      const fields = document.createElement("div");
      fields.className = "quiz-question-fields";

      const textInput = document.createElement("input");
      textInput.className = "quiz-question-text";
      textInput.type = "text";
      textInput.maxLength = 180;
      textInput.placeholder = `문항 ${index + 1}`;
      textInput.value = String(question?.text ?? "").slice(0, 180);

      const explanationInput = document.createElement("textarea");
      explanationInput.className = "quiz-question-explanation";
      explanationInput.maxLength = 720;
      explanationInput.placeholder = "해설 (게임 종료 후 표시)";
      explanationInput.value = String(question?.explanation ?? "").slice(0, 720);

      fields.append(textInput, explanationInput);

      const answerSelect = document.createElement("select");
      answerSelect.className = "quiz-question-answer";
      const optionO = document.createElement("option");
      optionO.value = "O";
      optionO.textContent = "정답 O";
      const optionX = document.createElement("option");
      optionX.value = "X";
      optionX.textContent = "정답 X";
      answerSelect.append(optionO, optionX);
      answerSelect.value = this.normalizeQuizAnswerChoice(question?.answer);
      const side = document.createElement("div");
      side.className = "quiz-question-side";
      const timeLimitWrap = document.createElement("label");
      timeLimitWrap.className = "quiz-question-time-wrap";
      timeLimitWrap.textContent = "시간(초)";
      const timeLimitInput = document.createElement("input");
      timeLimitInput.className = "quiz-question-time";
      timeLimitInput.type = "number";
      timeLimitInput.min = String(QUIZ_MIN_TIME_LIMIT_SECONDS);
      timeLimitInput.max = String(QUIZ_MAX_TIME_LIMIT_SECONDS);
      timeLimitInput.step = "1";
      timeLimitInput.value = String(
        this.normalizeQuizTimeLimitSeconds(question?.timeLimitSeconds, QUIZ_DEFAULT_TIME_LIMIT_SECONDS)
      );
      timeLimitWrap.appendChild(timeLimitInput);
      side.append(answerSelect, timeLimitWrap);

      row.append(order, fields, side);
      fragment.appendChild(row);
    }
    this.quizQuestionListEl.replaceChildren(fragment);
  }

  applyQuizSlotCountChange() {
    const maxQuestions = Math.max(1, Math.min(50, Math.trunc(Number(this.quizConfig?.maxQuestions) || 50)));
    const raw = Number(this.quizSlotCountInputEl?.value ?? this.quizConfig?.questions?.length ?? 10);
    const targetCount = Math.max(1, Math.min(maxQuestions, Math.trunc(raw || 1)));
    const currentQuestions = this.collectQuizConfigQuestionsFromEditor();
    const nextQuestions = currentQuestions.slice(0, targetCount);
    while (nextQuestions.length < targetCount) {
      nextQuestions.push(this.createDefaultQuizQuestion(nextQuestions.length));
    }
    this.quizConfig.questions = nextQuestions;
    this.renderQuizConfigEditor();
    this.persistQuizConfigDraft({ immediate: false, updateState: true });
    this.setQuizConfigStatus(`문항 슬롯을 ${targetCount}개로 맞췄습니다.`);
  }

  applyQuizTimeLimitToAllQuestions() {
    this.resolveUiElements();
    if (!this.quizQuestionListEl) {
      return;
    }
    const rows = Array.from(this.quizQuestionListEl.querySelectorAll(".quiz-question-row"));
    if (rows.length <= 0) {
      this.setQuizConfigStatus("통일할 문항이 없습니다.", true);
      return;
    }
    const fallbackSeconds = this.normalizeQuizTimeLimitSeconds(
      this.quizConfig?.questions?.[0]?.timeLimitSeconds,
      QUIZ_DEFAULT_TIME_LIMIT_SECONDS
    );
    const targetSeconds = this.normalizeQuizTimeLimitSeconds(
      this.quizTimeUnifyInputEl?.value,
      fallbackSeconds
    );
    if (this.quizTimeUnifyInputEl) {
      this.quizTimeUnifyInputEl.value = String(targetSeconds);
    }
    rows.forEach((row) => {
      const timeLimitInput = row.querySelector(".quiz-question-time");
      if (timeLimitInput) {
        timeLimitInput.value = String(targetSeconds);
      }
    });
    this.persistQuizConfigDraft({ immediate: false, updateState: true });
    this.setQuizConfigStatus(`모든 문항 시간을 ${targetSeconds}초로 통일했습니다.`);
  }

  resetQuizConfigEditor() {
    const slotCount = Math.max(
      1,
      Math.min(50, Math.trunc(Number(this.quizSlotCountInputEl?.value) || 10))
    );
    this.quizConfig = this.buildDefaultQuizConfig(slotCount);
    this.renderQuizConfigEditor();
    this.persistQuizConfigDraft({ immediate: true, updateState: true });
    this.setQuizConfigStatus("기본 문항 템플릿으로 초기화했습니다.");
  }

  getQuizCategoryStorageKey(name) {
    const safe = String(name ?? "").trim().replace(/\s+/g, "_").slice(0, 32);
    if (!safe) {
      return "";
    }
    return `${QUIZ_CATEGORY_STORAGE_PREFIX}.${safe}`;
  }

  saveQuizCategory(name) {
    if (typeof window === "undefined" || !window.localStorage) {
      this.setQuizConfigStatus("저장 실패: 로컬 스토리지를 사용할 수 없습니다.", true);
      return;
    }
    const key = this.getQuizCategoryStorageKey(name);
    if (!key) {
      return;
    }
    const questions = this.collectQuizConfigQuestionsFromEditor();
    if (questions.length <= 0) {
      this.setQuizConfigStatus("저장할 문항이 없습니다.", true);
      return;
    }
    const payload = {
      version: 1,
      name: String(name),
      savedAt: Date.now(),
      questions
    };
    try {
      window.localStorage.setItem(key, JSON.stringify(payload));
      this.setQuizConfigStatus(`'${name}' 카테고리에 ${questions.length}개 문항을 저장했습니다.`);
    } catch {
      this.setQuizConfigStatus("저장 실패: 스토리지 용량 초과.", true);
    }
  }

  loadQuizCategory(name) {
    if (typeof window === "undefined" || !window.localStorage) {
      this.setQuizConfigStatus("불러오기 실패: 로컬 스토리지를 사용할 수 없습니다.", true);
      return;
    }
    const key = this.getQuizCategoryStorageKey(name);
    if (!key) {
      return;
    }
    let questions = [];
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const payload = JSON.parse(raw);
        questions = Array.isArray(payload?.questions) ? payload.questions : [];
      }
    } catch {
      // ignore corrupted data — fall through to builtin
    }
    if (questions.length <= 0) {
      const builtin = this.getQuizCategoryBuiltinPreset(name);
      if (builtin && builtin.length > 0) {
        questions = builtin;
      } else {
        this.setQuizConfigStatus(`'${name}' 카테고리에 저장된 문항이 없습니다.`, true);
        return;
      }
    }
    const builtinEndPolicy = this.getQuizCategoryBuiltinEndPolicy(name);
    const normalized = this.normalizeQuizConfigPayload({
      maxQuestions: 50,
      questions,
      endPolicy:
        builtinEndPolicy ?? this.quizConfig?.endPolicy ?? { autoFinish: true, showOppositeBillboard: true }
    });
    this.quizConfig = normalized;
    this.renderQuizConfigEditor();
    this.persistQuizConfigDraft({ immediate: true, updateState: true });
    this.setQuizConfigStatus(`'${name}' 카테고리 ${questions.length}개 문항을 불러왔습니다. 저장 버튼으로 서버에 반영하세요.`);
  }

  applyQuickQuizSetup(categoryName, targetSeconds, { saveToServer = true } = {}) {
    this.resolveUiElements();
    const resolvedCategoryName = String(categoryName ?? "").trim();
    if (!resolvedCategoryName) {
      return false;
    }
    const fallbackSeconds = this.normalizeQuizTimeLimitSeconds(
      this.quizConfig?.questions?.[0]?.timeLimitSeconds,
      QUIZ_DEFAULT_TIME_LIMIT_SECONDS
    );
    const resolvedSeconds = this.normalizeQuizTimeLimitSeconds(targetSeconds, fallbackSeconds);
    if (this.quizQuickCategorySelectEl) {
      const optionExists = Array.from(this.quizQuickCategorySelectEl.options).some(
        (option) => String(option?.value ?? "").trim() === resolvedCategoryName
      );
      if (optionExists) {
        this.quizQuickCategorySelectEl.value = resolvedCategoryName;
      }
    }
    this.loadQuizCategory(resolvedCategoryName);
    if (this.quizTimeUnifyInputEl) {
      this.quizTimeUnifyInputEl.value = String(resolvedSeconds);
    }
    if (this.quizQuickTimeInputEl) {
      this.quizQuickTimeInputEl.value = String(resolvedSeconds);
    }
    this.applyQuizTimeLimitToAllQuestions();
    if (saveToServer) {
      this.requestQuizConfigSave();
    }
    return true;
  }

  requestQuickQuizSetupApply() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 문항 설정 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 문항 설정을 적용할 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 시작 전 카테고리/시간을 적용할 수 있습니다.", "system");
      return;
    }
    if (this.quizState.active || this.entryGateState?.admissionInProgress === true || this.quizConfigSaving) {
      return;
    }

    this.resolveUiElements();
    const categoryName = String(this.quizQuickCategorySelectEl?.value ?? "특갤").trim() || "특갤";
    const fallbackSeconds = this.normalizeQuizTimeLimitSeconds(
      this.quizConfig?.questions?.[0]?.timeLimitSeconds,
      QUIZ_DEFAULT_TIME_LIMIT_SECONDS
    );
    const targetSeconds = this.normalizeQuizTimeLimitSeconds(
      this.quizQuickTimeInputEl?.value,
      fallbackSeconds
    );

    this.applyQuickQuizSetup(categoryName, targetSeconds, { saveToServer: true });
  }

  tryApplyCategoryVoteWinner(vote = this.categoryVoteState) {
    const resultKey = `${vote?.id ?? ""}:${vote?.winner?.id ?? "none"}:${vote?.finishedAt ?? 0}`;
    if (!resultKey || resultKey === "::0" || this.categoryVoteAppliedResultKey === resultKey) {
      return;
    }
    if (!vote?.winner?.categoryName) {
      this.categoryVoteAppliedResultKey = resultKey;
      return;
    }
    if (!this.ownerAccessEnabled || !this.isLocalHost() || !this.socket || !this.networkConnected) {
      return;
    }
    if (this.quizState.active || this.quizConfigSaving) {
      return;
    }
    const targetSeconds = this.normalizeQuizTimeLimitSeconds(
      this.quizQuickTimeInputEl?.value,
      this.quizConfig?.questions?.[0]?.timeLimitSeconds ?? QUIZ_DEFAULT_TIME_LIMIT_SECONDS
    );
    this.categoryVoteAppliedResultKey = resultKey;
    if (this.applyQuickQuizSetup(vote.winner.categoryName, targetSeconds, { saveToServer: true })) {
      this.appendChatLine(
        "시스템",
        `카테고리 투표 결과 '${vote.winner.label}'를 현재 문항 설정에 반영했습니다.`,
        "system"
      );
    }
  }

  requestCategoryVoteStart() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 카테고리 투표 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 카테고리 투표를 시작할 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 카테고리 투표를 시작할 수 있습니다.", "system");
      return;
    }
    if (this.quizState.active || this.categoryVoteState?.active) {
      return;
    }
    this.socket.emit("quiz:category-vote:start", (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `투표 시작 실패: ${this.translateQuizError(response?.error)}`, "system");
        return;
      }
      if (response?.vote) {
        this.categoryVoteState = this.normalizeCategoryVotePayload(response.vote);
        this.renderCategoryVoteOverlay();
      }
    });
  }

  requestCategoryVoteCast(optionId) {
    const targetOptionId = String(optionId ?? "").trim();
    if (!targetOptionId || !this.socket || !this.networkConnected || !this.categoryVoteState?.active) {
      return;
    }
    this.socket.emit("quiz:category-vote:cast", { optionId: targetOptionId }, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `투표 반영 실패: ${this.translateQuizError(response?.error)}`, "system");
        return;
      }
      if (response?.vote) {
        this.categoryVoteState = this.normalizeCategoryVotePayload(response.vote);
        this.renderCategoryVoteOverlay();
      }
    });
  }

  getQuizCategoryBuiltinEndPolicy(name) {
    if (name !== "초카구야") {
      return null;
    }
    return {
      autoFinish: true,
      showOppositeBillboard: true
    };
  }

  getQuizCategoryBuiltinPreset(name) {
    if (name === "역사기초") {
      return [
        {
          text: "한글을 만든 사람은 세종대왕이다.",
          answer: "O",
          explanation: "세종대왕이 1443년 훈민정음을 창제했다.",
          timeLimitSeconds: 30
        },
        {
          text: "고구려·백제·신라 세 나라를 합쳐 삼국이라고 한다.",
          answer: "O",
          explanation: "삼국시대는 한반도와 만주 일대를 배경으로 전개됐다.",
          timeLimitSeconds: 30
        },
        {
          text: "삼국 통일을 이룬 나라는 고구려이다.",
          answer: "X",
          explanation: "676년 신라가 당나라를 몰아내고 삼국통일을 완성했다.",
          timeLimitSeconds: 30
        },
        {
          text: "조선을 건국한 사람은 이성계이다.",
          answer: "O",
          explanation: "1392년 이성계(태조)가 고려를 무너뜨리고 조선을 세웠다.",
          timeLimitSeconds: 30
        },
        {
          text: "임진왜란을 일으킨 나라는 일본이다.",
          answer: "O",
          explanation: "1592년 도요토미 히데요시의 명령으로 일본이 조선을 침략했다.",
          timeLimitSeconds: 30
        },
        {
          text: "이순신 장군은 임진왜란 때 거북선으로 왜군을 무찔렀다.",
          answer: "O",
          explanation: "거북선은 세계 최초의 철갑 전선 중 하나로 왜군을 공포에 떨게 했다.",
          timeLimitSeconds: 30
        },
        {
          text: "고려의 수도는 한양(서울)이었다.",
          answer: "X",
          explanation: "고려의 수도는 개성(개경)이다. 한양은 조선의 수도다.",
          timeLimitSeconds: 30
        },
        {
          text: "신라의 수도는 경주이다.",
          answer: "O",
          explanation: "경주는 약 1000년간 신라의 수도였다.",
          timeLimitSeconds: 30
        },
        {
          text: "단군왕검은 고조선을 세웠다.",
          answer: "O",
          explanation: "기원전 2333년 단군왕검이 아사달에 도읍을 정하고 고조선을 세웠다.",
          timeLimitSeconds: 30
        },
        {
          text: "3·1 운동은 1919년에 일어났다.",
          answer: "O",
          explanation: "1919년 3월 1일 독립선언서 낭독과 함께 전국적 만세 운동이 펼쳐졌다.",
          timeLimitSeconds: 30
        },
        {
          text: "광복절은 매년 8월 15일이다.",
          answer: "O",
          explanation: "1945년 8월 15일 일본의 항복으로 한국이 독립을 되찾은 날이다.",
          timeLimitSeconds: 30
        },
        {
          text: "훈민정음을 만든 왕은 태종이다.",
          answer: "X",
          explanation: "훈민정음은 조선 4대 왕 세종대왕이 창제했다.",
          timeLimitSeconds: 30
        },
        {
          text: "독립운동가 안중근은 이토 히로부미를 저격했다.",
          answer: "O",
          explanation: "1909년 안중근 의사가 하얼빈 역에서 이토 히로부미를 사살했다.",
          timeLimitSeconds: 30
        },
        {
          text: "대한민국은 1948년에 건국되었다.",
          answer: "O",
          explanation: "1948년 8월 15일 대한민국 정부가 수립되었다.",
          timeLimitSeconds: 30
        },
        {
          text: "고려는 불교를 국교로 삼았다.",
          answer: "O",
          explanation: "고려는 불교를 장려해 팔만대장경을 제작하는 등 불교 문화가 꽃을 피웠다.",
          timeLimitSeconds: 30
        },
        {
          text: "한국전쟁(6·25)은 1950년에 시작되었다.",
          answer: "O",
          explanation: "1950년 6월 25일 북한이 남침하면서 한국전쟁이 시작됐다.",
          timeLimitSeconds: 30
        },
        {
          text: "조선 시대 최고 교육기관은 성균관이다.",
          answer: "O",
          explanation: "성균관은 고려~조선 시대 최고 국립 교육기관으로 유교 경전을 가르쳤다.",
          timeLimitSeconds: 30
        },
        {
          text: "백제의 마지막 수도는 사비(현재의 부여)이다.",
          answer: "O",
          explanation: "538년 성왕이 웅진에서 사비로 수도를 옮겼고, 660년 멸망했다.",
          timeLimitSeconds: 30
        },
        {
          text: "고조선의 건국 이념은 홍익인간이다.",
          answer: "O",
          explanation: "'널리 인간을 이롭게 한다'는 홍익인간 정신이 고조선의 건국 이념이다.",
          timeLimitSeconds: 30
        },
        {
          text: "임시정부를 이끈 독립운동가는 김구이다.",
          answer: "O",
          explanation: "김구는 대한민국 임시정부 주석으로 독립운동을 이끌었다.",
          timeLimitSeconds: 30
        },
        {
          text: "조선 시대 전통 화폐 이름은 엽전이다.",
          answer: "O",
          explanation: "엽전(葉錢)은 조선 시대부터 근대까지 사용된 구리·청동 주화이다.",
          timeLimitSeconds: 30
        }
      ];
    }
    if (name === "일반상식") {
      return [
        {
          text: "호주의 수도는 시드니이다.",
          answer: "X",
          explanation: "호주의 수도는 시드니가 아니라 캔버라다.",
          timeLimitSeconds: 30
        },
        {
          text: "지구에서 가장 넓은 대양은 태평양이다.",
          answer: "O",
          explanation: "태평양은 지구 표면의 약 3분의 1을 덮는 가장 큰 대양이다.",
          timeLimitSeconds: 30
        },
        {
          text: "빛년(light-year)은 시간을 뜻하는 단위다.",
          answer: "X",
          explanation: "빛년은 빛이 1년 동안 이동한 거리를 뜻하는 거리 단위다.",
          timeLimitSeconds: 30
        },
        {
          text: "대한민국의 화폐 단위는 원(Won)이다.",
          answer: "O",
          explanation: "대한민국 법정통화의 기본 단위는 원이다.",
          timeLimitSeconds: 30
        },
        {
          text: "브라질의 수도는 리우데자네이루이다.",
          answer: "X",
          explanation: "브라질의 수도는 브라질리아다. 리우데자네이루는 대표적인 대도시다.",
          timeLimitSeconds: 30
        },
        {
          text: "표준 대기압 기준에서 물은 섭씨 100도에서 끓는다.",
          answer: "O",
          explanation: "해수면 기준 1기압에서 물의 끓는점은 100도다.",
          timeLimitSeconds: 30
        },
        {
          text: "만리장성은 달에서 맨눈으로 쉽게 보인다.",
          answer: "X",
          explanation: "달에서 만리장성을 맨눈으로 본다는 말은 잘못 알려진 상식이다.",
          timeLimitSeconds: 30
        },
        {
          text: "인간의 몸에는 보통 206개의 뼈가 있다.",
          answer: "O",
          explanation: "성인 기준으로 일반적으로 206개의 뼈를 가진다.",
          timeLimitSeconds: 30
        },
        {
          text: "UN 본부는 스위스 제네바에 있다.",
          answer: "X",
          explanation: "유엔 본부는 미국 뉴욕에 있다. 제네바에는 유엔 유럽본부가 있다.",
          timeLimitSeconds: 30
        },
        {
          text: "인플레이션은 전반적인 물가 수준이 오르는 현상을 뜻한다.",
          answer: "O",
          explanation: "인플레이션은 화폐가치 하락과 함께 전반적인 물가가 지속적으로 상승하는 현상이다.",
          timeLimitSeconds: 30
        },
        {
          text: "컴퓨터의 RAM은 전원이 꺼져도 내용이 그대로 보존되는 저장장치다.",
          answer: "X",
          explanation: "RAM은 휘발성 메모리라 전원이 꺼지면 저장 내용이 사라진다.",
          timeLimitSeconds: 30
        },
        {
          text: "에베레스트산은 네팔과 중국(티베트) 국경에 있다.",
          answer: "O",
          explanation: "에베레스트는 네팔과 중국 티베트 자치구의 경계선에 위치한다.",
          timeLimitSeconds: 30
        },
        {
          text: "대한민국의 국회는 단원제이다.",
          answer: "O",
          explanation: "대한민국 국회는 상원과 하원으로 나뉘지 않는 단원제다.",
          timeLimitSeconds: 30
        },
        {
          text: "지구는 태양을 한 바퀴 도는 데 약 24시간이 걸린다.",
          answer: "X",
          explanation: "약 24시간은 지구 자전 주기이고, 공전 주기는 약 365일이다.",
          timeLimitSeconds: 30
        },
        {
          text: "바이러스는 항생제로 치료하는 것이 일반적이다.",
          answer: "X",
          explanation: "항생제는 세균 감염에 쓰이며, 바이러스성 질환에는 보통 직접 효과가 없다.",
          timeLimitSeconds: 30
        },
        {
          text: "인터넷 주소에서 '.kr'은 대한민국 국가 도메인이다.",
          answer: "O",
          explanation: "'.kr'은 한국을 뜻하는 국가 코드 최상위 도메인(ccTLD)이다.",
          timeLimitSeconds: 30
        },
        {
          text: "아르헨티나의 수도는 부에노스아이레스이다.",
          answer: "O",
          explanation: "부에노스아이레스는 아르헨티나의 수도이자 최대 도시다.",
          timeLimitSeconds: 30
        },
        {
          text: "금성은 태양계에서 태양과 가장 가까운 행성이다.",
          answer: "X",
          explanation: "태양과 가장 가까운 행성은 수성이다.",
          timeLimitSeconds: 30
        },
        {
          text: "1바이트는 8비트다.",
          answer: "O",
          explanation: "현대 컴퓨팅에서 1바이트는 일반적으로 8비트를 뜻한다.",
          timeLimitSeconds: 30
        },
        {
          text: "GDP는 한 나라에서 일정 기간 생산된 최종 재화와 서비스의 가치를 뜻한다.",
          answer: "O",
          explanation: "GDP(국내총생산)는 한 국가 경제 규모를 보여주는 대표 지표다.",
          timeLimitSeconds: 30
        }
      ];
    }
    if (name === "초카구야") {
      return [
        {
          text: "이 작품은 '스튜디오 지브리'가 만든 신작이다.",
          answer: "X",
          explanation:
            "제작/애니메이션 제작은 스튜디오 콜로리도 + 스튜디오 크로마토로 소개됨.",
          timeLimitSeconds: 30
        },
        {
          text: "감독은 야마시타 신고(山下清悟)이며, 장편 감독 데뷔작이다.",
          answer: "O",
          explanation: "넷플릭스 공식 발표에서 '첫 장편 감독 작품'으로 소개됨.",
          timeLimitSeconds: 30
        },
        {
          text: "이 작품 공식 사이트 주소는 'cho-kaguyahime.com'이다.",
          answer: "O",
          explanation: "넷플릭스 애니 영화 공식 사이트로 운영 중.",
          timeLimitSeconds: 30
        },
        {
          text: "그 아기를 보고 그냥 지나치고 집에 안 데려간다.",
          answer: "X",
          explanation: "'버릴 수 없어 집으로 데려간다'로 명시됨.",
          timeLimitSeconds: 30
        },
        {
          text: "그 아기는 며칠 만에 이로하 또래로 급성장한다.",
          answer: "O",
          explanation: "'급속 성장해 또래가 된다'가 공식 줄거리 핵심.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하는 도쿄의 17세 여고생이며, 알바와 학업을 동시에 돌린다.",
          answer: "O",
          explanation: "17세 고교생 + 파트타임/학업 병행으로 소개됨.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하가 숨 돌릴 때 보는 건, 인기 스트리머 '야치요' 방송이다.",
          answer: "O",
          explanation: "'인기 스트리머 야치요를 보며 평온을 찾는다'로 소개됨.",
          timeLimitSeconds: 30
        },
        {
          text: "야치요는 온라인 가상공간 '츠쿠요미(ツクヨミ)'의 관리자다.",
          answer: "O",
          explanation: "야치요가 Tsukuyomi의 administrator(관리자)로 설명됨.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하는 츠쿠요미에 직접 접속은 안 하고, 야치요 방송만 시청한다.",
          answer: "X",
          explanation: "이로하가 츠쿠요미에 '자주 가는(frequents)' 것으로 서술됨.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하는 츠쿠요미에서 배틀 게임을 하며 약간의 돈도 번다.",
          answer: "O",
          explanation: "'배틀 게임으로 소소하게 돈을 번다'가 공식 시놉시스에 있음.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하는 츠쿠요미에서 라이버로 방송해 후원금으로 학비를 번다.",
          answer: "X",
          explanation: "이로하는 시청/배틀 게임 중심으로 묘사되며 방송 수익 설정은 없음.",
          timeLimitSeconds: 30
        },
        {
          text: "카구야는 '달에서 온' 소녀로 소개된다.",
          answer: "O",
          explanation: "캐릭터 소개에 '달에서 온 소녀'로 명시됨.",
          timeLimitSeconds: 30
        },
        {
          text: "카구야는 재미를 찾아 츠쿠요미에서 라이버 활동을 시작한다.",
          answer: "O",
          explanation: "공식 캐릭터 프로필에 그대로 적혀 있음.",
          timeLimitSeconds: 30
        },
        {
          text: "카구야는 얌전하고 말 잘 들어서, 이로하가 전혀 고생하지 않는다.",
          answer: "X",
          explanation: "자기중심적 성격으로 이로하를 끌고 가는 구도로 소개됨.",
          timeLimitSeconds: 30
        },
        {
          text: "카구야의 강한 부탁 때문에, 이로하는 카구야의 방송을 돕게 된다.",
          answer: "O",
          explanation: "'카구야의 요청으로 이로하가 스트리밍을 도와준다'고 설명됨.",
          timeLimitSeconds: 30
        },
        {
          text: "둘의 역할은 대체로 이로하=프로듀서·작곡, 카구야=라이버·가수 구도다.",
          answer: "O",
          explanation: "공식 요약에 producer/songwriter 와 streamer/singer 구도로 정리됨.",
          timeLimitSeconds: 30
        },
        {
          text: "둘이 노리는 큰 목표는 야치요와 함께 무대(콜라보)를 할 기회다.",
          answer: "O",
          explanation: "야치요와 공연/콜라보가 목표로 소개됨.",
          timeLimitSeconds: 30
        },
        {
          text: "그 기회는 현실 오프라인 체육관 토너먼트에서만 얻을 수 있다.",
          answer: "X",
          explanation: "핵심 무대는 가상공간 츠쿠요미로 설명됨.",
          timeLimitSeconds: 30
        },
        {
          text: "이야기에는 카구야를 다시 달로 데려가려는 불길한 힘/존재가 다가온다.",
          answer: "O",
          explanation: "'카구야를 달로 데려가려는 세력'이 주요 위협으로 제시됨.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하는 학교에선 모범생처럼 보이지만, 생활비·학비를 스스로 번다.",
          answer: "O",
          explanation: "공식 캐릭터 소개에 그대로 반영된 설정임.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하는 작곡이 가능한 음악 경험자지만, 어떤 이유로 한동안 그만뒀다.",
          answer: "O",
          explanation: "공식 프로필에 작곡 가능 + 중단 배경이 명시됨.",
          timeLimitSeconds: 30
        },
        {
          text: "팬들/등장인물은 이로하를 '이로P(いろP)'라고 부르기도 한다.",
          answer: "O",
          explanation: "공식 MV 관련 기사에서 이로P(彩葉의 애칭) 언급이 있음.",
          timeLimitSeconds: 30
        },
        {
          text: "이로하(酒寄彩葉)의 일본어 성우는 나가세 안나(永瀬アンナ)다.",
          answer: "O",
          explanation: "공식 캐스팅 표기에 해당 성우로 소개됨.",
          timeLimitSeconds: 30
        }
      ];
    }
    if (name === "역사상식") {
      return [
        {
          text: "고려를 건국한 인물은 왕건이다.",
          answer: "O",
          explanation: "918년 왕건이 궁예를 몰아내고 고려를 건국했다.",
          timeLimitSeconds: 30
        },
        {
          text: "세종대왕이 훈민정음을 창제한 해는 1443년이다.",
          answer: "O",
          explanation: "1443년 창제, 1446년 반포. 창제와 반포는 구분해야 한다.",
          timeLimitSeconds: 30
        },
        {
          text: "임진왜란이 발생한 해는 1592년이다.",
          answer: "O",
          explanation: "1592년 일본이 조선을 침략하며 임진왜란이 시작되었다.",
          timeLimitSeconds: 30
        },
        {
          text: "조선을 건국한 인물은 이성계이다.",
          answer: "O",
          explanation: "1392년 이성계가 고려를 무너뜨리고 조선을 건국했다.",
          timeLimitSeconds: 30
        },
        {
          text: "삼국 통일을 이룬 나라는 고구려이다.",
          answer: "X",
          explanation: "676년 신라가 당나라 세력을 몰아내고 삼국통일을 완성했다.",
          timeLimitSeconds: 30
        },
        {
          text: "조선의 수도는 처음부터 끝까지 한양(서울)이었다.",
          answer: "X",
          explanation: "태종 때 잠시 개성으로 환도했다가 다시 한양으로 돌아왔다.",
          timeLimitSeconds: 30
        },
        {
          text: "을사조약(1905)으로 조선은 외교권을 박탈당했다.",
          answer: "O",
          explanation: "일본이 대한제국의 외교권을 강제로 빼앗은 조약이다.",
          timeLimitSeconds: 30
        },
        {
          text: "강화도 조약(1876)은 조선이 일본과 맺은 최초의 근대 조약이다.",
          answer: "O",
          explanation: "불평등 조약으로 조선의 문호를 강제 개방시켰다.",
          timeLimitSeconds: 30
        },
        {
          text: "고조선을 세운 시조는 동명성왕이다.",
          answer: "X",
          explanation: "고조선의 시조는 단군왕검이다. 동명성왕은 고구려의 시조다.",
          timeLimitSeconds: 30
        },
        {
          text: "병자호란에서 조선 인조는 청나라에 항복하였다.",
          answer: "O",
          explanation: "1637년 인조가 삼전도에서 청 태종에게 항복의 예를 올렸다.",
          timeLimitSeconds: 30
        },
        {
          text: "광개토대왕은 신라의 왕이다.",
          answer: "X",
          explanation: "광개토대왕은 고구려 19대 왕으로, 영토를 크게 확장했다.",
          timeLimitSeconds: 30
        },
        {
          text: "3·1 운동은 1919년에 일어났다.",
          answer: "O",
          explanation: "1919년 3월 1일 독립선언서 낭독과 함께 전국적 독립운동이 시작됐다.",
          timeLimitSeconds: 30
        },
        {
          text: "대한민국 임시정부가 수립된 곳은 베이징이다.",
          answer: "X",
          explanation: "1919년 중국 상하이에서 수립되었다.",
          timeLimitSeconds: 30
        },
        {
          text: "동학농민운동(갑오농민전쟁)이 일어난 해는 1894년이다.",
          answer: "O",
          explanation: "1894년 전봉준을 중심으로 반봉건·반외세 운동이 전개되었다.",
          timeLimitSeconds: 30
        },
        {
          text: "고려의 팔만대장경은 해인사에 보관되어 있다.",
          answer: "O",
          explanation: "경남 합천 해인사 장경판전에 보관 중이며, 유네스코 세계유산이다.",
          timeLimitSeconds: 30
        },
        {
          text: "훈민정음 해례본은 유네스코 세계기록유산에 등재되어 있다.",
          answer: "O",
          explanation: "1997년 유네스코 세계기록유산으로 등재되었다.",
          timeLimitSeconds: 30
        },
        {
          text: "조선 시대 최초의 사화는 무오사화(1498)이다.",
          answer: "O",
          explanation: "연산군 때 김일손의 사초가 문제가 되어 사림파가 탄압받은 사건이다.",
          timeLimitSeconds: 30
        },
        {
          text: "국채보상운동(1907)은 국민이 자발적으로 일본 차관을 갚자는 운동이었다.",
          answer: "O",
          explanation: "대구에서 시작되어 전국으로 확산된 국민 모금 운동이다.",
          timeLimitSeconds: 30
        },
        {
          text: "신라의 마지막 왕은 경애왕이다.",
          answer: "X",
          explanation: "신라의 마지막 왕은 경순왕(56대)이다. 경애왕은 55대 왕이다.",
          timeLimitSeconds: 30
        },
        {
          text: "이순신 장군의 명량해전은 1597년에 치러졌다.",
          answer: "O",
          explanation: "12척의 배로 133척의 왜선을 물리친 세계 해전사의 기적이다.",
          timeLimitSeconds: 30
        },
        {
          text: "6·25 전쟁은 미국이 먼저 남한을 침공하며 시작되었다.",
          answer: "X",
          explanation: "1950년 6월 25일 북한이 38선을 넘어 남침하며 전쟁이 시작되었다.",
          timeLimitSeconds: 30
        }
      ];
    }
    if (name !== "특갤") {
      return null;
    }
    return [
      {
        text: "특이점(Singularity)은 기존의 기준값과 법칙으로 예측 모델이 더 이상 적용되지 않는 상이한 지점을 의미한다.",
        answer: "O",
        explanation: "기술 변화가 급격히 변해 인간 삶의 기준을 바꿔버릴 수밖에 없는 지점."
      },
      {
        text: "LLM은 그럴듯한 거짓말(환각)을 할 수 있다.",
        answer: "O",
        explanation: "대형 언어 모델은 사실이 아닌 내용을 그럴듯하게 생성하는 환각(Hallucination) 현상이 알려져 있다."
      },
      {
        text: "머스크는 우리가 이미 특이점에 진입했다고 봤다.",
        answer: "O",
        explanation: "머스크가 \"이미 진입\" 취지 발언을 여러 차례 했다."
      },
      {
        text: "세계 경제는 성장하고 있지만, 그것은 개발도상국엔 해당되지 않는다.",
        answer: "X",
        explanation: "극빈층 감소 예시 등 개도국도 경제적 개선이 있었다 → 문장 부정."
      },
      {
        text: "「특이점이 온다」 마이너 갤러리 개설일은 2019-08-02이다.",
        answer: "X",
        explanation: "2019-08-01이라고 명시."
      },
      {
        text: "오늘날 신경과학은 다양한 자료를 바탕으로 뇌 모델을 만들고 시뮬레이션하고 있다.",
        answer: "O",
        explanation: "스캔/연결 모델/실험 등으로 모델링·검증 흐름 존재."
      },
      {
        text: "UBI는 더 큰 수준의 고소득(생활 여유 포함)을 보장하자는 담론으로 쓰이기도 한다.",
        answer: "X",
        explanation: "그건 UBI가 아니라 UHI(Universal High Income) 쪽 개념."
      },
      {
        text: "1945년 4월 19일자 글에서 고든 무어가 \"직접 전자공학의 미래…\"라고 했다.",
        answer: "X",
        explanation: "책 163p 참고 메모 기준 — 그 인용/구성이 맞지 않는다는 취지."
      },
      {
        text: "머스크는 2028년 말 AI가 최강 인간 지능을 능가한다고 했다.",
        answer: "X",
        explanation: "2025말~2026년 내로 발언이 수정됨 → 원문장 X."
      },
      {
        text: "\"뒤를 멀리 돌아볼수록 앞을 더 멀리 내다볼 수 있다.\" -칼 세이건-",
        answer: "X",
        explanation: "이 명언은 윈스턴 처칠의 것으로 정정해둠 → '칼 세이건' 표기는 X."
      },
      {
        text: "지금 여러분과 함께 플레이하는 이 공간엔 AI가 있다.",
        answer: "X",
        explanation: "아직 구현 못함."
      },
      {
        text: "특이점 OX 대기방 가상 캐릭터 이름은 \"차연\"이다.",
        answer: "O",
        explanation: "데리다의 '차연(Différance)' 개념에서 따온 이름."
      },
      {
        text: "머슴닷컴(Mersoom) 업로드 일시는 2026년 1월 31일이다.",
        answer: "X",
        explanation: "실제 업로드는 2026.02.01 12:44:41."
      },
      {
        text: "유전 알고리즘은 사업현장에 아직 동원되지 못했다.",
        answer: "X",
        explanation: "이미 대기업·플랫폼 등에서 쓰이고 있고, 오픈소스+클라우드로 확산 중."
      },
      {
        text: "CIM은 최적화·물류 능률화에서 점차 AI 기법을 확대하고 있다.",
        answer: "O",
        explanation: "CIM+AI 결합이 확대되는 흐름은 실제로 존재한다."
      },
      {
        text: "\"과학은 조직된 삶, 지혜는 조직된 지식\"이라고 칸트가 말했다.",
        answer: "X",
        explanation: "정확한 문구는 반대 — '과학은 조직된 지식, 지혜는 조직된 삶'."
      },
      {
        text: "제작자는 이 게임을 만드는 데 일주일이 걸렸다.",
        answer: "X",
        explanation: "3일 만에 만들었다 → X."
      },
      {
        text: "Hawking–Penrose 특이점 정리의 개념이 의식의 물리적 기초가 된다.",
        answer: "X",
        explanation: "커넥톰은 wiring diagram일 뿐, 작동 원리가 아님 → 직결은 X."
      },
      {
        text: "실온 초전도체에서 위상 보호가 불가능하므로 대규모 양자컴퓨터는 물리적으로 불가능하다.",
        answer: "X",
        explanation: "단정이 너무 큼. 연구는 계속 진행 중 → X."
      },
      {
        text: "0 이상 999 이하 정수 중 숫자 9가 포함된 수는 271개이다.",
        answer: "O",
        explanation: "9가 없는 수: 각 자리에 0~8 → 9³ = 729개. 1000 - 729 = 271."
      },
      {
        text: "\"이 문장은 거짓이다\"는 O 또는 X로 판정할 수 있다.",
        answer: "X",
        explanation: "라이어(Liar) 패러독스 — 참도 거짓도 될 수 없어 판정 불가."
      },
      {
        text: "이 게임의 가상 인물 '자연'은 포스트모더니즘→해체주의 흐름에서 파생된 인물이다.",
        answer: "O",
        explanation: "ㅇㅇ"
      },
      {
        text: "이전 수복 최종 업데이트 버전은 V7.9이다.",
        answer: "X",
        explanation: "V7.1로 정리됨 → V7.9는 X."
      },
      {
        text: "조건을 만족하는 경우의 수는 32,760개이다.",
        answer: "O",
        explanation: "O(맞음)"
      },
      {
        text: "오픈소스는 무조건 상업적 사용이 금지된다.",
        answer: "X",
        explanation: "라이선스에 따라 MIT·Apache 등은 상업적 사용을 허용한다."
      },
      {
        text: "AI 생성 결과물도 저작권·라이선스 문제가 생길 수 있다.",
        answer: "O",
        explanation: "학습 데이터 및 생성 결과물의 저작권 귀속은 법적으로 논의 중."
      },
      {
        text: "GitHub Pages는 정적 웹페이지 배포에 쓰인다.",
        answer: "O",
        explanation: "HTML/CSS/JS 정적 파일을 무료로 호스팅할 수 있다."
      },
      {
        text: "확률 50%인 사건을 10번 반복하면 반드시 5번 성공한다.",
        answer: "X",
        explanation: "기댓값이 5번이지, 5번이 보장되지는 않는다."
      },
      {
        text: "\"A이면 B\"에서 A가 거짓일 때 명제 전체는 참이 될 수 있다.",
        answer: "O",
        explanation: "전건이 거짓이면 명제 전체는 항상 참(vacuous truth)."
      },
      {
        text: "정수 '0'은 짝수다.",
        answer: "O",
        explanation: "2의 배수 정의상 짝수. 0 = 2 × 0."
      },
      {
        text: "Git은 변경 이력을 저장하는 버전관리 시스템이다.",
        answer: "O",
        explanation: "분산형 버전관리 시스템(DVCS)으로 파일의 변경 이력을 추적한다."
      }
    ];
  }

  openQuizConfigModal() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 문항 설정 권한이 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 문항 설정을 열 수 있습니다.", "system");
      return;
    }
    this.resolveUiElements();
    this.quizConfigDraftRestoreAttempted = false;
    this.quizConfigModalEl?.classList.remove("hidden");
    this.fetchQuizConfig();
  }

  closeQuizConfigModal() {
    this.persistQuizConfigDraft({ immediate: true, updateState: true });
    this.quizConfigModalEl?.classList.add("hidden");
  }

  fetchQuizConfig() {
    if (!this.socket || !this.networkConnected) {
      this.setQuizConfigStatus("오프라인 상태에서는 문항 설정을 불러올 수 없습니다.", true);
      return;
    }
    if (this.quizConfigLoading) {
      return;
    }
    this.quizConfigLoading = true;
    this.setQuizConfigStatus("설정 불러오는 중...");
    this.socket.emit("quiz:config:get", (response = {}) => {
      this.quizConfigLoading = false;
      if (!response?.ok) {
        this.setQuizConfigStatus(`불러오기 실패: ${this.translateQuizError(response?.error)}`, true);
        return;
      }
      this.handleQuizConfigUpdate(response?.config ?? {});
      this.setQuizConfigStatus("문항 설정을 불러왔습니다.");
    });
  }

  requestQuizConfigSave() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 문항 저장 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.setQuizConfigStatus("오프라인 상태에서는 저장할 수 없습니다.", true);
      return;
    }
    if (!this.isLocalHost()) {
      this.setQuizConfigStatus("방장만 문항 설정을 저장할 수 있습니다.", true);
      return;
    }
    if (this.quizConfigSaving) {
      return;
    }

    const questions = this.collectQuizConfigQuestionsFromEditor();
    if (questions.length <= 0) {
      this.setQuizConfigStatus("최소 1개 이상의 문항이 필요합니다.", true);
      return;
    }
    const autoFinish = this.quizAutoFinishInputEl?.checked !== false;
    const showOppositeBillboard =
      this.quizOppositeBillboardInputEl?.checked !== false;
    const payload = {
      questions,
      endPolicy: {
        autoFinish,
        showOppositeBillboard
      }
    };
    this.quizConfigSaving = true;
    this.setQuizConfigStatus("문항 설정 저장 중...");
    this.socket.emit("quiz:config:set", payload, (response = {}) => {
      this.quizConfigSaving = false;
      if (!response?.ok) {
        this.setQuizConfigStatus(`저장 실패: ${this.translateQuizError(response?.error)}`, true);
        return;
      }
      this.handleQuizConfigUpdate(response?.config ?? {});
      this.setQuizConfigStatus("문항/종료 설정 저장 완료");
      this.appendChatLine("시스템", "문항/종료 설정이 저장되었습니다.", "system");
      this.writeQuizConfigDraft(this.quizConfig);
    });
  }

  handleQuizConfigUpdate(payload = {}) {
    this.quizConfig = this.normalizeQuizConfigPayload(payload);
    this.quizState.autoFinish = this.quizConfig?.endPolicy?.autoFinish !== false;
    this.quizOppositeBillboardEnabled =
      this.quizConfig?.endPolicy?.showOppositeBillboard !== false;
    if (!this.quizOppositeBillboardEnabled) {
      this.quizOppositeBillboardResultVisible = false;
    }
    if (this.quizQuickTimeInputEl) {
      const nextSeconds = this.normalizeQuizTimeLimitSeconds(
        this.quizConfig?.questions?.[0]?.timeLimitSeconds,
        QUIZ_DEFAULT_TIME_LIMIT_SECONDS
      );
      this.quizQuickTimeInputEl.value = String(nextSeconds);
    }
    this.applyOppositeBillboardMode();
    if (!this.quizConfigModalEl?.classList.contains("hidden")) {
      this.renderQuizConfigEditor();
      this.restoreQuizConfigDraftIfAvailable();
    }
    this.updateQuizControlUi();
  }

  setQuizReviewItems(items = []) {
    const rows = Array.isArray(items) ? items : [];
    this.quizReviewItems = rows
      .map((entry, index) => ({
        index: Math.max(1, Math.trunc(Number(entry?.index) || index + 1)),
        text: String(entry?.text ?? "").trim().slice(0, 180),
        answer: this.normalizeQuizAnswerChoice(entry?.answer),
        explanation: String(entry?.explanation ?? "").trim().slice(0, 720)
      }))
      .filter((entry) => entry.text.length > 0);
    this.quizReviewIndex = 0;
    this.renderQuizReview();
  }

  renderQuizReview() {
    const total = this.quizReviewItems.length;
    const safeIndex = Math.max(0, Math.min(total - 1, this.quizReviewIndex));
    this.quizReviewIndex = safeIndex;
    const current = total > 0 ? this.quizReviewItems[safeIndex] : null;
    if (this.quizReviewIndexEl) {
      this.quizReviewIndexEl.textContent = total > 0 ? `${safeIndex + 1} / ${total}` : "0 / 0";
    }
    if (this.quizReviewQuestionEl) {
      this.quizReviewQuestionEl.textContent = current
        ? `문항 ${current.index}. ${current.text}`
        : "해설 데이터가 없습니다.";
    }
    if (this.quizReviewAnswerEl) {
      this.quizReviewAnswerEl.textContent = `정답: ${current?.answer ?? "-"}`;
    }
    if (this.quizReviewExplanationEl) {
      this.quizReviewExplanationEl.textContent = `해설: ${current?.explanation || "등록된 해설이 없습니다."}`;
    }
    if (this.quizReviewPrevBtnEl) {
      this.quizReviewPrevBtnEl.disabled = total <= 0 || safeIndex <= 0;
    }
    if (this.quizReviewNextBtnEl) {
      this.quizReviewNextBtnEl.disabled = total <= 0 || safeIndex >= total - 1;
    }
  }

  openQuizReviewModal() {
    this.resolveUiElements();
    if (!Array.isArray(this.quizReviewItems) || this.quizReviewItems.length <= 0) {
      this.appendChatLine("시스템", "표시할 해설 데이터가 없습니다.", "system");
      return;
    }
    this.quizReviewModalEl?.classList.remove("hidden");
    this.renderQuizReview();
  }

  closeQuizReviewModal() {
    this.quizReviewModalEl?.classList.add("hidden");
  }

  moveQuizReview(delta = 0) {
    const total = this.quizReviewItems.length;
    if (total <= 0) {
      return;
    }
    const next = Math.max(0, Math.min(total - 1, this.quizReviewIndex + Math.trunc(Number(delta) || 0)));
    this.quizReviewIndex = next;
    this.renderQuizReview();
  }

  setModerationPanelOpen(open) {
    this.resolveUiElements();
    this.moderationPanelOpen = Boolean(open);
    this.moderationPanelEl?.classList.toggle("hidden", !this.moderationPanelOpen);
    if (this.moderationPanelToggleBtnEl) {
      this.moderationPanelToggleBtnEl.textContent = this.moderationPanelOpen
        ? "관리 패널 닫기"
        : "관리 패널 열기";
    }
  }

  toggleModerationPanel() {
    if (!this.ownerAccessEnabled || !this.isLocalHost() || !this.networkConnected) {
      return;
    }
    this.setModerationPanelOpen(!this.moderationPanelOpen);
    this.updateQuizControlUi();
  }

  getModerationCandidates() {
    const source = Array.isArray(this.roomRoster) ? this.roomRoster : [];
    return source.filter((entry) => entry && !entry.isMe);
  }

  findModerationTargetById(targetId) {
    const id = String(targetId ?? "");
    if (!id) {
      return null;
    }
    return this.getModerationCandidates().find((entry) => String(entry?.id ?? "") === id) ?? null;
  }

  refreshModerationTargetOptions() {
    if (!this.moderationPlayerSelectEl) {
      return;
    }
    const previousValue = String(this.moderationPlayerSelectEl.value ?? "");
    const candidates = this.getModerationCandidates();
    const signature = candidates
      .map(
        (entry) =>
          `${String(entry?.id ?? "")}:${String(entry?.name ?? "")}:${entry?.chatMuted === true ? 1 : 0}`
      )
      .join("|");
    if (signature === this.moderationOptionsSignature) {
      if (candidates.length > 0) {
        const hasPrevious = candidates.some((entry) => String(entry?.id ?? "") === previousValue);
        const nextValue = hasPrevious ? previousValue : String(candidates[0]?.id ?? "");
        if (this.moderationPlayerSelectEl.value !== nextValue) {
          this.moderationPlayerSelectEl.value = nextValue;
        }
      } else if (this.moderationPlayerSelectEl.value !== "") {
        this.moderationPlayerSelectEl.value = "";
      }
      return;
    }
    this.moderationOptionsSignature = signature;
    this.moderationPlayerSelectEl.replaceChildren();

    if (candidates.length <= 0) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "대상 없음";
      this.moderationPlayerSelectEl.appendChild(emptyOption);
      this.moderationPlayerSelectEl.value = "";
      return;
    }

    for (const entry of candidates) {
      const option = document.createElement("option");
      option.value = String(entry?.id ?? "");
      const muteLabel = entry?.chatMuted === true ? " [채금]" : "";
      option.textContent = `${entry?.name ?? "플레이어"}${muteLabel}`;
      this.moderationPlayerSelectEl.appendChild(option);
    }

    const hasPrevious = candidates.some((entry) => String(entry?.id ?? "") === previousValue);
    this.moderationPlayerSelectEl.value = hasPrevious
      ? previousValue
      : String(candidates[0]?.id ?? "");
  }

  updateQuizControlUi() {
    this.resolveUiElements();
    const isHost = this.isLocalHost();
    const connected = Boolean(this.networkConnected && this.socket);
    const show = connected && !this.isLobbyBlockingGameplay() && this.ownerAccessEnabled;
    this.quizControlsEl?.classList.toggle("hidden", !show);
    if (!show) {
      this.setModerationPanelOpen(false);
      return;
    }

    const phase = String(this.quizState.phase ?? "idle");
    const active = Boolean(this.quizState.active);
    const portalOpen = this.entryGateState?.portalOpen === true;
    const waitingPlayers = Math.max(0, Math.trunc(Number(this.entryGateState?.waitingPlayers) || 0));
    const participantLimit = Math.max(
      1,
      Math.trunc(Number(this.entryGateState?.participantLimit) || 50)
    );
    const spectatorPlayers = Math.max(
      0,
      Math.trunc(Number(this.entryGateState?.spectatorPlayers) || 0)
    );
    const priorityPlayers = Math.max(
      0,
      Math.trunc(Number(this.entryGateState?.priorityPlayers) || 0)
    );
    const countdownSeconds = this.getAdmissionCountdownSeconds();
    const admissionInProgress =
      this.entryGateState?.admissionInProgress === true || countdownSeconds > 0;
    const categoryVoteActive = this.categoryVoteState?.active === true;
    if (this.quizHostBtnEl) {
      const canClaimHost = this.ownerAccessEnabled;
      this.quizHostBtnEl.classList.toggle("hidden", !canClaimHost || isHost);
      this.quizHostBtnEl.disabled = !canClaimHost || isHost;
    }
    const canControl = isHost;
    if (canControl && this.moderationPanelOpen) {
      this.refreshModerationTargetOptions();
    }
    if (this.moderationPanelToggleBtnEl) {
      this.moderationPanelToggleBtnEl.classList.toggle("hidden", !canControl);
      this.moderationPanelToggleBtnEl.disabled = !canControl;
    }
    if (!canControl && this.moderationPanelOpen) {
      this.setModerationPanelOpen(false);
    } else {
      this.setModerationPanelOpen(this.moderationPanelOpen);
    }
    const selectedModerationId = String(this.moderationPlayerSelectEl?.value ?? "");
    const selectedModerationTarget = this.findModerationTargetById(selectedModerationId);
    const hasModerationTarget = Boolean(selectedModerationTarget);
    const canUseModeration = canControl && this.moderationPanelOpen && hasModerationTarget;
    if (this.moderationPlayerSelectEl) {
      this.moderationPlayerSelectEl.disabled = !canControl || !this.moderationPanelOpen;
    }
    if (this.moderationKickBtnEl) {
      this.moderationKickBtnEl.disabled = !canUseModeration;
    }
    if (this.moderationMuteBtnEl) {
      this.moderationMuteBtnEl.disabled =
        !canUseModeration || selectedModerationTarget?.chatMuted === true;
    }
    if (this.moderationUnmuteBtnEl) {
      this.moderationUnmuteBtnEl.disabled =
        !canUseModeration || selectedModerationTarget?.chatMuted !== true;
    }
    this.quizStartBtnEl &&
      (this.quizStartBtnEl.disabled =
        !canControl || active || waitingPlayers > 0 || admissionInProgress || categoryVoteActive);
    this.quizStopBtnEl && (this.quizStopBtnEl.disabled = !canControl || !active);
    if (this.quizConfigBtnEl) {
      this.quizConfigBtnEl.disabled =
        !canControl ||
        active ||
        admissionInProgress ||
        categoryVoteActive ||
        this.quizConfigLoading ||
        this.quizConfigSaving;
    }
    if (this.quizQuickCategorySelectEl) {
      this.quizQuickCategorySelectEl.disabled =
        !canControl ||
        active ||
        admissionInProgress ||
        categoryVoteActive ||
        this.quizConfigLoading ||
        this.quizConfigSaving;
    }
    if (this.quizQuickTimeInputEl) {
      this.quizQuickTimeInputEl.disabled =
        !canControl ||
        active ||
        admissionInProgress ||
        categoryVoteActive ||
        this.quizConfigLoading ||
        this.quizConfigSaving;
    }
    if (this.quizQuickApplyBtnEl) {
      this.quizQuickApplyBtnEl.disabled =
        !canControl ||
        active ||
        admissionInProgress ||
        categoryVoteActive ||
        this.quizConfigLoading ||
        this.quizConfigSaving;
    }
    if (this.quizCategoryVoteBtnEl) {
      this.quizCategoryVoteBtnEl.disabled =
        !canControl ||
        active ||
        admissionInProgress ||
        categoryVoteActive ||
        this.quizConfigLoading ||
        this.quizConfigSaving;
    }
    if (this.quizReviewBtnEl) {
      this.quizReviewBtnEl.disabled = this.quizReviewItems.length <= 0;
    }
    if (this.portalLobbyOpenBtnEl) {
      this.portalLobbyOpenBtnEl.disabled = !canControl || active || portalOpen || admissionInProgress;
    }
    if (this.portalLobbyStartBtnEl) {
      this.portalLobbyStartBtnEl.disabled =
        !canControl || active || admissionInProgress || !portalOpen || waitingPlayers <= 0;
      if (admissionInProgress) {
        this.portalLobbyStartBtnEl.textContent =
          countdownSeconds > 0 ? `입장 중 (${countdownSeconds})` : "입장 중";
      } else {
        const projectedParticipants = Math.min(waitingPlayers, participantLimit);
        this.portalLobbyStartBtnEl.textContent =
          waitingPlayers > 0
            ? `입장 시작 (${projectedParticipants}/${waitingPlayers})`
            : "입장 시작";
      }
    }
    this.quizNextBtnEl &&
      (this.quizNextBtnEl.disabled = !canControl || !active || phase !== "waiting-next");
    this.quizPrevBtnEl &&
      (this.quizPrevBtnEl.disabled = !canControl || !active || Math.max(0, this.quizState.questionIndex) <= 1);
    this.quizLockBtnEl &&
      (this.quizLockBtnEl.disabled = !canControl || !active || phase !== "question");
    this.portalTargetInputEl && (this.portalTargetInputEl.disabled = !canControl);
    this.portalTargetSaveBtnEl && (this.portalTargetSaveBtnEl.disabled = !canControl);
    this.billboardTargetSelectEl && (this.billboardTargetSelectEl.disabled = !canControl);
    this.billboardMediaPresetSelectEl && (this.billboardMediaPresetSelectEl.disabled = !canControl);
    this.billboardMediaFileInputEl &&
      (this.billboardMediaFileInputEl.disabled = !canControl || this.billboardMediaUploadInFlight);
    this.billboardMediaUrlInputEl && (this.billboardMediaUrlInputEl.disabled = !canControl);
    this.billboardMediaApplyBtnEl &&
      (this.billboardMediaApplyBtnEl.disabled = !canControl || this.billboardMediaUploadInFlight);
    this.billboardMediaPlayBtnEl && (this.billboardMediaPlayBtnEl.disabled = !canControl);
    this.billboardMediaPauseBtnEl && (this.billboardMediaPauseBtnEl.disabled = !canControl);
    this.billboardMediaClearBtnEl && (this.billboardMediaClearBtnEl.disabled = !canControl);
    this.billboardPlaylistInputEl && (this.billboardPlaylistInputEl.disabled = !canControl);
    this.billboardPlaylistLoadBtnEl && (this.billboardPlaylistLoadBtnEl.disabled = !canControl);
    this.billboardPlaylistPlayBtnEl && (this.billboardPlaylistPlayBtnEl.disabled = !canControl);
    this.billboardPlaylistPauseBtnEl && (this.billboardPlaylistPauseBtnEl.disabled = !canControl);
    this.billboardPlaylistPrevBtnEl && (this.billboardPlaylistPrevBtnEl.disabled = !canControl);
    this.billboardPlaylistNextBtnEl && (this.billboardPlaylistNextBtnEl.disabled = !canControl);
    this.billboardPlaylistAutoInputEl && (this.billboardPlaylistAutoInputEl.disabled = !canControl);
    this.billboardPlaylistIndexSelectEl && (this.billboardPlaylistIndexSelectEl.disabled = !canControl);
    this.billboardPlaylistSelectBtnEl && (this.billboardPlaylistSelectBtnEl.disabled = !canControl);
    this.refreshBillboardPlaylistUi();

    if (this.quizControlsNoteEl) {
      if (!isHost) {
        this.quizControlsNoteEl.textContent = this.ownerAccessEnabled
          ? "오너 토큰 보유 시 호스팅 권한을 요청할 수 있습니다."
          : "방장 권한이 있는 사용자만 퀴즈/포탈을 제어할 수 있습니다.";
        return;
      }
      const phaseKor = this.formatQuizPhase(phase);
      if (active) {
        this.quizControlsNoteEl.textContent = `모드: 수동(호스팅) | 단계: ${phaseKor} | 문항 ${Math.max(0, this.quizState.questionIndex)}/${Math.max(0, this.quizState.totalQuestions)} | 종료 ${this.quizState.autoFinish ? "자동" : "수동"}`;
      } else {
        if (categoryVoteActive) {
          const voteSeconds = this.getCategoryVoteCountdownSeconds();
          this.quizControlsNoteEl.textContent =
            `모드: 수동(호스팅) | 카테고리 투표 진행 중 ${voteSeconds}초 | 참여 ${this.categoryVoteState?.votesCast ?? 0}/${this.categoryVoteState?.eligibleVoters ?? 0}`;
        } else if (admissionInProgress) {
          this.quizControlsNoteEl.textContent =
            countdownSeconds > 0
              ? `모드: 수동(호스팅) | 입장 카운트다운 ${countdownSeconds}초`
              : "모드: 수동(호스팅) | 입장 처리 중";
        } else if (portalOpen) {
          this.quizControlsNoteEl.textContent =
            `모드: 수동(호스팅) | 포탈 대기실 오픈 (선착순 ${participantLimit}명 / 대기열 ${waitingPlayers}명)`;
        } else {
          this.quizControlsNoteEl.textContent =
            `모드: 수동(호스팅) | 참가 ${participantLimit}명 + 관전 ${spectatorPlayers}명 (우선권 ${priorityPlayers}명)`;
        }
      }
    }
  }

  requestHostClaim() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 호스팅 권한을 요청할 수 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 호스팅을 받을 수 없습니다.", "system");
      return;
    }

    this.socket.emit("room:claim-host", (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `호스팅 실패: ${this.translateQuizError(response?.error)}`, "system");
        return;
      }
      this.quizState.hostId = String(response?.hostId ?? this.localPlayerId ?? "");
      this.appendChatLine("시스템", "호스팅 권한을 획득했습니다.", "system");
      this.fetchQuizConfig();
      this.updateQuizControlUi();
    });
  }

  requestPortalLobbyOpen() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 포탈 열기 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 포탈을 열 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 포탈을 열 수 있습니다.", "system");
      return;
    }

    this.socket.emit("portal:lobby-open", (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine(
          "시스템",
          `포탈 열기 실패: ${this.translateQuizError(response?.error)}`,
          "system"
        );
        return;
      }
      const waiting = Math.max(0, Math.trunc(Number(response?.waitingPlayers) || 0));
      const limit = Math.max(
        1,
        Math.trunc(
          Number(response?.participantLimit) || Number(this.entryGateState?.participantLimit) || 50
        )
      );
      this.appendChatLine(
        "시스템",
        `포탈 대기실 오픈: 선착순 ${limit}명 참가, 현재 대기열 ${waiting}명`,
        "system"
      );
    });
  }

  requestPortalLobbyStart() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 입장 시작 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 입장을 시작할 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 입장을 시작할 수 있습니다.", "system");
      return;
    }

    this.socket.emit("portal:lobby-start", (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine(
          "시스템",
          `입장 시작 실패: ${this.translateQuizError(response?.error)}`,
          "system"
        );
        return;
      }
      const admitted = Math.max(0, Math.trunc(Number(response?.admittedCount) || 0));
      const spectators = Math.max(0, Math.trunc(Number(response?.spectatorCount) || 0));
      const priority = Math.max(0, Math.trunc(Number(response?.priorityPlayers) || 0));
      const limit = Math.max(
        1,
        Math.trunc(
          Number(response?.participantLimit) || Number(this.entryGateState?.participantLimit) || 50
        )
      );
      const countdownMs = Math.max(0, Math.trunc(Number(response?.countdownMs) || 0));
      const countdownSeconds = Math.max(1, Math.ceil(countdownMs / 1000));
      this.appendChatLine(
        "시스템",
        `입장 카운트다운 ${countdownSeconds}초 시작 (참가 ${admitted}/${limit}, 관전 ${spectators}, 우선 ${priority})`,
        "system"
      );
    });
  }

  requestQuizStart() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 시작 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 시작할 수 없습니다.", "system");
      return;
    }
    this.socket.emit(
      "quiz:start",
      {
        autoFinish: this.quizConfig?.endPolicy?.autoFinish !== false
      },
      (response = {}) => {
        if (!response?.ok) {
          this.appendChatLine("시스템", `시작 실패: ${this.translateQuizError(response?.error)}`, "system");
          return;
        }
        this.appendChatLine("시스템", "방장이 퀴즈를 시작했습니다.", "system");
      }
    );
  }

  requestQuizStop() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 중지 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 중지할 수 없습니다.", "system");
      return;
    }
    this.socket.emit("quiz:stop", {}, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `중지 실패: ${this.translateQuizError(response?.error)}`, "system");
        return;
      }
      this.appendChatLine("시스템", "방장이 퀴즈를 중지했습니다.", "system");
    });
  }

  requestQuizPrev() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 이전 문제 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 이전 문제로 이동할 수 없습니다.", "system");
      return;
    }
    this.socket.emit("quiz:prev", {}, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `이전 문제 실패: ${this.translateQuizError(response?.error)}`, "system");
        return;
      }
      const rewindTo = Math.max(1, Math.trunc(Number(response?.rewindTo) || 1));
      this.appendChatLine(
        "시스템",
        `이전 문제로 되돌렸습니다. 점수를 초기화하고 문항 ${rewindTo}부터 다시 시작합니다.`,
        "system"
      );
    });
  }

  requestQuizNext() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 다음 문제 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 다음 문제로 넘어갈 수 없습니다.", "system");
      return;
    }
    this.socket.emit("quiz:next", {}, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `다음 문제 실패: ${this.translateQuizError(response?.error)}`, "system");
      }
    });
  }

  requestQuizLock() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 잠금 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 잠글 수 없습니다.", "system");
      return;
    }
    this.socket.emit("quiz:force-lock", (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("시스템", `잠금 실패: ${this.translateQuizError(response?.error)}`, "system");
      }
    });
  }

  requestPortalTargetSave() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 포탈 링크 변경 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 포탈 링크를 저장할 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 포탈 링크를 변경할 수 있습니다.", "system");
      return;
    }

    const rawTarget = String(this.portalTargetInputEl?.value ?? "").trim();
    this.socket.emit("portal:set-target", { targetUrl: rawTarget }, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine(
          "시스템",
          `포탈 링크 저장 실패: ${this.translateQuizError(response?.error)}`,
          "system"
        );
        return;
      }
      this.applyPortalTarget(response?.targetUrl ?? "", { announce: false });
      this.appendChatLine(
        "시스템",
        rawTarget ? "포탈 링크가 갱신되었습니다." : "포탈 링크가 비워졌습니다.",
        "system"
      );
    });
  }

  requestHostKickPlayer() {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 강퇴 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 강퇴할 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 강퇴할 수 있습니다.", "system");
      return;
    }
    const targetId = String(this.moderationPlayerSelectEl?.value ?? "").trim();
    const target = this.findModerationTargetById(targetId);
    if (!target) {
      this.appendChatLine("시스템", "강퇴할 플레이어를 먼저 선택하세요.", "system");
      return;
    }
    this.socket.emit("host:kick-player", { targetId }, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine(
          "시스템",
          `강퇴 실패: ${this.translateQuizError(response?.error)}`,
          "system"
        );
        return;
      }
      this.appendChatLine(
        "시스템",
        `${this.formatPlayerName(response?.targetName ?? target.name)} 플레이어를 강퇴했습니다.`,
        "system"
      );
    });
  }

  requestHostSetChatMuted(nextMuted) {
    if (!this.ownerAccessEnabled) {
      this.appendChatLine("시스템", "오너 토큰이 없어 채팅 제재 권한이 없습니다.", "system");
      return;
    }
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 채팅 제재를 변경할 수 없습니다.", "system");
      return;
    }
    if (!this.isLocalHost()) {
      this.appendChatLine("시스템", "방장만 채팅 제재를 변경할 수 있습니다.", "system");
      return;
    }
    const targetId = String(this.moderationPlayerSelectEl?.value ?? "").trim();
    const target = this.findModerationTargetById(targetId);
    if (!target) {
      this.appendChatLine("시스템", "대상 플레이어를 먼저 선택하세요.", "system");
      return;
    }
    const muted = nextMuted !== false;
    this.socket.emit("host:set-chat-muted", { targetId, muted }, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine(
          "시스템",
          `채팅 제재 변경 실패: ${this.translateQuizError(response?.error)}`,
          "system"
        );
        return;
      }
      const targetName = this.formatPlayerName(response?.targetName ?? target.name);
      this.appendChatLine(
        "시스템",
        muted
          ? `${targetName} 플레이어의 채팅을 금지했습니다.`
          : `${targetName} 플레이어의 채팅 금지를 해제했습니다.`,
        "system"
      );
    });
  }

  handlePortalTargetUpdate(payload = {}) {
    const targetUrl = String(payload?.targetUrl ?? "").trim();
    const updatedBy = String(payload?.updatedBy ?? "");
    this.applyPortalTarget(targetUrl, { announce: false });
    if (!targetUrl) {
      this.appendChatLine("시스템", "방장이 포탈 링크를 비웠습니다.", "system");
      return;
    }
    if (updatedBy && updatedBy === String(this.localPlayerId ?? "")) {
      return;
    }
    this.appendChatLine("시스템", "방장이 포탈 링크를 변경했습니다.", "system");
  }

  handlePortalLobbyAdmitted(payload = {}) {
    const admittedCount = Math.max(0, Math.trunc(Number(payload?.admittedCount) || 0));
    const spectatorCount = Math.max(0, Math.trunc(Number(payload?.spectatorCount) || 0));
    const priorityPlayers = Math.max(0, Math.trunc(Number(payload?.priorityPlayers) || 0));
    const participantLimit = Math.max(
      1,
      Math.trunc(Number(payload?.participantLimit) || Number(this.entryGateState?.participantLimit) || 50)
    );
    if (admittedCount <= 0) {
      this.appendChatLine("시스템", "입장 처리 완료: 이동한 인원이 없습니다.", "system");
    } else {
      this.appendChatLine(
        "시스템",
        `입장 완료: 참가 ${admittedCount}/${participantLimit}, 관전 ${spectatorCount}, 다음 판 우선 ${priorityPlayers}`,
        "system"
      );
    }
    this.updateEntryWaitOverlay();
    this.updateQuizControlUi();
  }

  applyPortalTarget(targetUrl, { announce = false } = {}) {
    const normalized = this.resolveActivePortalTargetUrl(targetUrl ?? "", this.portalConfiguredTargetUrl);
    this.portalTargetUrl = normalized;
    if (this.portalTargetInputEl) {
      const nextValue = this.portalTargetUrl ?? "";
      if (this.portalTargetInputEl.value !== nextValue) {
        this.portalTargetInputEl.value = nextValue;
      }
    }
    if (announce) {
      this.appendChatLine(
        "시스템",
        this.portalTargetUrl ? "포탈 링크가 설정되었습니다." : "포탈 링크가 해제되었습니다.",
        "system"
      );
    }
  }

  resizeRoundOverlayCanvas() {
    if (!this.roundOverlayCanvasEl || !this.roundOverlayCtx) {
      return;
    }
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const targetWidth = Math.round(width * dpr);
    const targetHeight = Math.round(height * dpr);
    if (
      this.roundOverlayCanvasEl.width === targetWidth &&
      this.roundOverlayCanvasEl.height === targetHeight
    ) {
      return;
    }
    this.roundOverlayCanvasEl.width = targetWidth;
    this.roundOverlayCanvasEl.height = targetHeight;
    this.roundOverlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  showRoundOverlay({
    title = "",
    subtitle = "",
    fireworks = false,
    durationSeconds = ROUND_OVERLAY_SETTINGS.endDurationSeconds
  } = {}) {
    this.resolveUiElements();
    if (!this.roundOverlayEl) {
      return;
    }
    if (this.roundOverlayTitleEl) {
      this.roundOverlayTitleEl.textContent = String(title ?? "").trim();
    }
    if (this.roundOverlaySubtitleEl) {
      this.roundOverlaySubtitleEl.textContent = String(subtitle ?? "").trim();
    }
    this.roundOverlayVisible = true;
    this.roundOverlayFireworks = Boolean(fireworks);
    this.roundOverlayTimer = Math.max(0.6, Number(durationSeconds) || 0);
    this.roundOverlaySpawnClock = 0;
    this.roundOverlayParticles.length = 0;
    this.roundOverlayEl.classList.add("on");
    this.roundOverlayEl.setAttribute("aria-hidden", "false");
    this.roundOverlayEl.dataset.mode = this.roundOverlayFireworks ? "end" : "prepare";
    this.resizeRoundOverlayCanvas();
    if (this.roundOverlayCtx) {
      this.roundOverlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  hideRoundOverlay() {
    this.roundOverlayVisible = false;
    this.roundOverlayFireworks = false;
    this.roundOverlayTimer = 0;
    this.roundOverlaySpawnClock = 0;
    this.roundOverlayParticles.length = 0;
    if (!this.roundOverlayEl) {
      return;
    }
    this.roundOverlayEl.classList.remove("on");
    this.roundOverlayEl.setAttribute("aria-hidden", "true");
    this.roundOverlayEl.dataset.mode = "";
    if (this.roundOverlayCtx) {
      this.roundOverlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  spawnRoundFireworkBurst() {
    if (!this.roundOverlayCtx) {
      return;
    }
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const originX = THREE.MathUtils.lerp(width * 0.14, width * 0.86, Math.random());
    const originY = THREE.MathUtils.lerp(height * 0.16, height * 0.52, Math.random());
    let count = THREE.MathUtils.randInt(
      ROUND_OVERLAY_SETTINGS.fireworkParticleCountMin,
      ROUND_OVERLAY_SETTINGS.fireworkParticleCountMax
    );
    if (this.mobileEnabled) {
      count = Math.max(14, Math.round(count * MOBILE_RUNTIME_SETTINGS.roundOverlayParticleScale));
    }
    const hue = Math.floor(Math.random() * 360);
    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count + Math.random() * 0.2;
      const speed = THREE.MathUtils.lerp(86, 240, Math.random());
      const life = THREE.MathUtils.lerp(0.8, 1.6, Math.random());
      this.roundOverlayParticles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        size: THREE.MathUtils.lerp(1.6, 3.2, Math.random()),
        hue: (hue + THREE.MathUtils.randInt(-18, 24) + 360) % 360
      });
    }
  }

  updateRoundOverlay(delta) {
    if (!this.roundOverlayVisible || !this.roundOverlayEl) {
      return;
    }

    this.roundOverlayTimer -= delta;
    if (this.roundOverlayTimer <= 0) {
      this.hideRoundOverlay();
      return;
    }

    if (!this.roundOverlayFireworks || !this.roundOverlayCtx) {
      return;
    }
    this.resizeRoundOverlayCanvas();
    const ctx = this.roundOverlayCtx;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    ctx.clearRect(0, 0, width, height);

    this.roundOverlaySpawnClock += delta;
    const spawnInterval = this.mobileEnabled
      ? MOBILE_RUNTIME_SETTINGS.roundOverlaySpawnIntervalSeconds
      : ROUND_OVERLAY_SETTINGS.fireworkSpawnIntervalSeconds;
    if (this.roundOverlaySpawnClock >= spawnInterval) {
      this.roundOverlaySpawnClock = 0;
      this.spawnRoundFireworkBurst();
    }

    for (let index = this.roundOverlayParticles.length - 1; index >= 0; index -= 1) {
      const particle = this.roundOverlayParticles[index];
      particle.life -= delta;
      if (particle.life <= 0) {
        this.roundOverlayParticles.splice(index, 1);
        continue;
      }
      particle.vy += 132 * delta;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      const alpha = THREE.MathUtils.clamp(particle.life / particle.maxLife, 0, 1);
      ctx.fillStyle = `hsla(${particle.hue}, 96%, 68%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  appendChatLine(name, text, type = "remote", options = {}) {
    this.resolveUiElements();
    const hasMainLog = Boolean(this.chatLogEl);
    const hasLiveLog = Boolean(this.chatLiveLogEl);
    if (!hasMainLog && !hasLiveLog) {
      return false;
    }
    const allowMobilePreview = options?.mobilePreview !== false;
    const autoScroll = options?.scroll !== false;
    const allowLiveFeed = options?.liveFeed !== false;

    const nearBottom = hasMainLog
      ? this.chatLogEl.scrollHeight - this.chatLogEl.scrollTop - this.chatLogEl.clientHeight < 20
      : false;

    const line = document.createElement("p");
    line.className = `chat-line ${type}`;
    let mobilePreviewText = "";
    let isRemoteChatLine = false;

    if (type === "system") {
      line.textContent = String(text ?? "").trim();
    } else {
      const safeName = this.formatPlayerName(name);
      const safeText = String(text ?? "").trim();
      if (!safeText) {
        return false;
      }
      mobilePreviewText = type === "self" ? `나: ${safeText}` : `${safeName}: ${safeText}`;
      isRemoteChatLine = type === "remote";

      const nameEl = document.createElement("span");
      nameEl.className = "chat-name";
      nameEl.textContent = `${safeName}:`;

      const textEl = document.createElement("span");
      textEl.textContent = safeText;

      line.append(nameEl, textEl);
    }

    let appended = false;
    if (hasMainLog) {
      this.chatLogEl.appendChild(line);
      while (this.chatLogEl.childElementCount > this.chatLogMaxEntries) {
        this.chatLogEl.firstElementChild?.remove();
      }
      if (autoScroll || nearBottom || type === "self" || !this.chatOpen) {
        this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
      }
      appended = true;
    }
    if (allowLiveFeed && hasLiveLog) {
      const liveLine = line.cloneNode(true);
      this.chatLiveLogEl.appendChild(liveLine);
      while (this.chatLiveLogEl.childElementCount > this.chatLiveMaxEntries) {
        this.chatLiveLogEl.firstElementChild?.remove();
      }
      this.chatLiveLogEl.scrollTop = this.chatLiveLogEl.scrollHeight;
      appended = true;
      window.setTimeout(() => {
        liveLine.style.transition = "opacity 0.55s ease";
        liveLine.style.opacity = "0";
        window.setTimeout(() => liveLine.remove(), 560);
      }, 7000);
    }
    if (allowMobilePreview && this.mobileEnabled && mobilePreviewText) {
      if (isRemoteChatLine) {
        this.notifyMobileIncomingChat(mobilePreviewText);
      } else {
        this.showMobileChatPreview(mobilePreviewText);
      }
    }
    this.syncChatLiveUi();
    return appended;
  }

  sendChatMessage() {
    this.resolveUiElements();
    if (!this.chatInputEl) {
      return;
    }
    if (this.chatSendInFlight) {
      return;
    }

    const text = String(this.chatInputEl.value ?? "").trim().slice(0, 120);
    if (!text) {
      return;
    }

    const senderName = this.formatPlayerName(this.localPlayerName);
    this.localPlayerName = senderName;
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("시스템", "오프라인 상태에서는 채팅을 보낼 수 없습니다.", "system");
      return;
    }
    const localEchoSignature = `${senderName}|${text}`;
    this.lastLocalChatEcho = localEchoSignature;
    this.lastLocalChatEchoAt = performance.now();

    this.chatSendInFlight = true;
    this.chatInputEl.value = "";

    this.socket.emit(
      "chat:send",
      {
        name: senderName,
        text
      },
      (response = {}) => {
        this.chatSendInFlight = false;
        if (!response?.ok) {
          if (this.lastLocalChatEcho === localEchoSignature) {
            this.lastLocalChatEcho = "";
            this.lastLocalChatEchoAt = 0;
          }
          if (this.chatInputEl && !this.chatInputEl.value) {
            this.chatInputEl.value = text;
          }
          this.appendChatLine(
            "시스템",
            `채팅 전송 실패: ${this.translateQuizError(response?.error)}`,
            "system"
          );
          return;
        }
        if (this.mobileEnabled) {
          this.appendChatLine(senderName, text, "self");
          // Keep panel open for continued chatting; refocus input.
          if (this.mobileChatPanelVisible && this.chatInputEl) {
            this.chatInputEl.focus();
          }
        } else {
          this.appendChatLine(senderName, text, "self");
          this.setChatOpen(false);
          this.chatInputEl.blur();
        }
      }
    );
  }

  focusChatInput() {
    this.resolveUiElements();
    if (!this.chatInputEl) {
      return;
    }
    if (this.isMobilePortraitLocked()) {
      return;
    }
    this.setSettingsPanelOpen(false);
    this.setChatOpen(true);
    this.keys.clear();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock?.();
    }
    this.chatInputEl.focus();
    this.chatInputEl.select();
    this.scheduleMobileKeyboardInsetSync(0);
    this.scheduleMobileKeyboardInsetSync(220);
  }

  isTextInputTarget(target) {
    if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tagName = target.tagName;
    return tagName === "INPUT" || tagName === "TEXTAREA";
  }

  findRemotePlayerByName(name) {
    const targetName = this.formatPlayerName(name);
    for (const remote of this.remotePlayers.values()) {
      if (remote.name === targetName) {
        return remote;
      }
    }
    return null;
  }

  createGuestPlayerName() {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    return `GUEST_${suffix}`;
  }

  formatPlayerName(rawName) {
    const name = String(rawName ?? "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 16);
    if (!name) {
      return "플레이어";
    }
    if (/^PLAYER(?:_\d+)?$/i.test(name)) {
      return name.replace(/^PLAYER/i, "플레이어");
    }
    return name;
  }

  getRemoteAvatarGeometries() {
    if (!this.remoteAvatarBodyGeometry) {
      this.remoteAvatarBodyGeometry = new THREE.CapsuleGeometry(
        0.2,
        0.64,
        this.mobileEnabled ? 2 : 4,
        this.mobileEnabled ? 6 : 8
      );
    }
    if (!this.remoteAvatarHeadGeometry) {
      this.remoteAvatarHeadGeometry = new THREE.SphereGeometry(
        0.22,
        this.mobileEnabled ? 8 : 12,
        this.mobileEnabled ? 8 : 12
      );
    }
    return {
      body: this.remoteAvatarBodyGeometry,
      head: this.remoteAvatarHeadGeometry
    };
  }

  createRemoteAvatarMaterial(kind = "body") {
    const palette =
      kind === "head"
        ? {
            color: 0x7e8e9b,
            roughness: 0.36,
            metalness: 0.05,
            emissive: 0x3e4f63,
            emissiveIntensity: 0.2
          }
        : {
            color: 0x5f7086,
            roughness: 0.44,
            metalness: 0.06,
            emissive: 0x2d4057,
            emissiveIntensity: 0.18
          };
    if (this.mobileEnabled) {
      return new THREE.MeshLambertMaterial({
        color: palette.color,
        emissive: palette.emissive,
        emissiveIntensity: palette.emissiveIntensity
      });
    }
    return new THREE.MeshStandardMaterial(palette);
  }

  ensureRemoteChatLabel(remote) {
    if (!remote) {
      return null;
    }
    if (remote.chatLabel) {
      return remote.chatLabel;
    }
    const chatLabel = this.createTextLabel("", "chat");
    chatLabel.position.set(0, 2.5, 0);
    chatLabel.visible = false;
    remote.mesh?.add(chatLabel);
    remote.chatLabel = chatLabel;
    return chatLabel;
  }

  createTextLabel(text, kind = "name") {
    const canvas = document.createElement("canvas");
    if (this.mobileEnabled) {
      canvas.width = kind === "chat" ? 384 : 320;
      canvas.height = kind === "chat" ? 112 : 92;
    } else {
      canvas.width = 512;
      canvas.height = kind === "chat" ? 144 : 112;
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    material.toneMapped = false;

    const label = new THREE.Sprite(material);
    label.renderOrder = 40;
    label.userData = {
      canvas,
      context: canvas.getContext("2d"),
      text: "",
      kind
    };

    this.setTextLabel(label, text, kind);
    return label;
  }

  setTextLabel(label, rawText, kind = "name") {
    const context = label?.userData?.context;
    const canvas = label?.userData?.canvas;
    if (!context || !canvas) {
      return;
    }

    const maxLength = kind === "chat" ? 120 : 16;
    const fallback = kind === "name" ? "플레이어" : "";
    const text = String(rawText ?? "").trim().slice(0, maxLength) || fallback;
    if (label.userData.text === text) {
      return;
    }

    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);

    if (text) {
      if (kind === "chat") {
        context.fillStyle = "rgba(10, 24, 40, 0.84)";
        context.strokeStyle = "rgba(178, 216, 252, 0.92)";
        context.lineWidth = 6;
      } else {
        context.fillStyle = "rgba(6, 18, 32, 0.86)";
        context.strokeStyle = "rgba(173, 233, 255, 0.88)";
        context.lineWidth = 5;
      }

      this.drawRoundedRect(context, 12, 12, width - 24, height - 24, 22);
      context.fill();
      context.stroke();

      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = kind === "chat" ? "#f0f8ff" : "#e8f8ff";
      if (this.mobileEnabled) {
        context.font = kind === "chat" ? "600 32px Bahnschrift" : "700 30px Bahnschrift";
      } else {
        context.font = kind === "chat" ? "600 40px Bahnschrift" : "700 38px Bahnschrift";
      }
      context.fillText(text, width * 0.5, height * 0.53);
    }

    const minScaleX = kind === "chat" ? 2.2 : 1.5;
    const maxScaleX = kind === "chat" ? 5.2 : 3.3;
    const scaleX = THREE.MathUtils.clamp(
      minScaleX + text.length * (kind === "chat" ? 0.05 : 0.075),
      minScaleX,
      maxScaleX
    );
    label.scale.set(scaleX, kind === "chat" ? 0.58 : 0.4, 1);

    label.userData.text = text;
    label.material.map.needsUpdate = true;
  }

  drawRoundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width * 0.5, height * 0.5);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  disposeTextLabel(label) {
    const map = label?.material?.map;
    map?.dispose?.();
    label?.material?.dispose?.();
  }

  emitImmediateLocalSync(tag = "manual") {
    if (!this.socket || !this.networkConnected) {
      return false;
    }
    const safeTag = String(tag ?? "").trim().slice(0, 24);
    this.localSyncSeq = (this.localSyncSeq + 1) % 2147483647;
    this.socket.emit("player:sync", {
      x: this.playerPosition.x,
      y: this.playerPosition.y,
      z: this.playerPosition.z,
      yaw: this.yaw,
      pitch: this.pitch,
      s: this.localSyncSeq,
      t: safeTag || "manual"
    });
    this.remoteSyncClock = 0;
    return true;
  }

  emitLocalSync(delta) {
    if (!this.socket || !this.networkConnected) {
      return;
    }
    this.remoteSyncClock += delta;
    if (this.remoteSyncClock < this.networkSyncInterval) {
      return;
    }
    this.emitImmediateLocalSync("interval");
  }

  updateShadowMapRefresh(delta) {
    if (!this.renderer.shadowMap.enabled || this.renderer.shadowMap.autoUpdate) {
      return;
    }

    this.shadowRefreshClock += delta;
    const reference = this.shadowRefreshReference;
    if (!reference?.ready) {
      reference.ready = true;
      reference.x = this.playerPosition.x;
      reference.y = this.playerPosition.y;
      reference.z = this.playerPosition.z;
      reference.yaw = this.yaw;
      reference.pitch = this.pitch;
    }

    const dx = this.playerPosition.x - reference.x;
    const dy = this.playerPosition.y - reference.y;
    const dz = this.playerPosition.z - reference.z;
    const moveDistanceSq = dx * dx + dy * dy + dz * dz;
    const yawDelta = Math.abs(Math.atan2(Math.sin(this.yaw - reference.yaw), Math.cos(this.yaw - reference.yaw)));
    const pitchDelta = Math.abs(this.pitch - reference.pitch);
    const recentLookInput =
      !this.mobileEnabled &&
      this.pointerLocked &&
      performance.now() - this.lastLookInputAt <
        DESKTOP_RUNTIME_SETTINGS.orientationCorrectionInputLockMs;
    const movedEnough = moveDistanceSq >= 0.2;
    const turnedEnough = !recentLookInput && (yawDelta >= 0.05 || pitchDelta >= 0.034);
    if (movedEnough || turnedEnough) {
      this.pendingShadowRefresh = true;
      this.shadowRefreshIdleClock = 0;
      reference.x = this.playerPosition.x;
      reference.y = this.playerPosition.y;
      reference.z = this.playerPosition.z;
      reference.yaw = this.yaw;
      reference.pitch = this.pitch;
      return;
    }

    if (!this.pendingShadowRefresh) {
      return;
    }

    this.shadowRefreshIdleClock += delta;
    if (this.shadowRefreshIdleClock < RUNTIME_TUNING.SHADOW_UPDATE_SETTLE_SECONDS) {
      return;
    }
    if (this.shadowRefreshClock < RUNTIME_TUNING.SHADOW_UPDATE_INTERVAL_SECONDS) {
      return;
    }

    this.shadowRefreshClock = 0;
    this.shadowRefreshIdleClock = 0;
    this.pendingShadowRefresh = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.markPerformanceFlag("shadowRefresh");
  }

  updateQuizBillboardPulse(delta) {
    this.quizBillboardRefreshClock += delta;
    if (this.quizBillboardRefreshClock < RUNTIME_TUNING.QUIZ_BILLBOARD_REFRESH_INTERVAL_SECONDS) {
      return;
    }
    this.quizBillboardRefreshClock = 0;
    this.syncQuizBillboard();
  }

  updateHud(delta) {
    if (!this.hud.enabled) {
      return;
    }

    const fpsState = this.fpsState;
    fpsState.sampleTime += delta;
    fpsState.frameCount += 1;

    if (fpsState.sampleTime >= RUNTIME_TUNING.HUD_FPS_SAMPLE_SECONDS) {
      fpsState.fps = fpsState.frameCount / fpsState.sampleTime;
      fpsState.sampleTime = 0;
      fpsState.frameCount = 0;
    }

    const hudRefreshInterval = this.mobileEnabled
      ? Math.max(
          RUNTIME_TUNING.HUD_REFRESH_INTERVAL_SECONDS,
          MOBILE_RUNTIME_SETTINGS.hudRefreshIntervalSeconds
        )
      : RUNTIME_TUNING.HUD_REFRESH_INTERVAL_SECONDS;
    this.hudRefreshClock += delta;
    if (this.hudRefreshClock < hudRefreshInterval) {
      return;
    }
    this.hudRefreshClock = 0;

    const localPlayer = this.networkConnected ? 1 : 0;
    this.hud.update({
      status: this.getStatusText(),
      players: this.remotePlayers.size + localPlayer,
      x: this.playerPosition.x,
      z: this.playerPosition.z,
      fps: fpsState.fps
    });
    const countdownSeconds = this.getAdmissionCountdownSeconds();
    if (this.localAdmissionWaiting || countdownSeconds > 0) {
      this.updateEntryWaitOverlay();
    }
    if (countdownSeconds > 0) {
      if (this.lastHudAdmissionCountdown !== countdownSeconds) {
        this.lastHudAdmissionCountdown = countdownSeconds;
        this.updateQuizControlUi();
      }
    } else if (this.lastHudAdmissionCountdown !== null) {
      this.lastHudAdmissionCountdown = null;
      this.updateQuizControlUi();
    }
  }

  getStatusText() {
    let baseStatus;

    if (this.isLobbyBlockingGameplay()) {
      if (!this.networkConnected) {
        baseStatus = "로비 / 연결 대기";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (!this.lobbyNameConfirmed) {
        baseStatus = "로비 / 닉네임 입력";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.redirectInFlight || this.socketRole === "gateway") {
        baseStatus = "로비 / 매치 서버 연결 중";
        return this.composeStatusWithQuiz(baseStatus);
      }
      baseStatus = "로비 / 입장 준비";
      return this.composeStatusWithQuiz(baseStatus);
    }

    if (this.localAdmissionWaiting) {
      const countdownSeconds = this.getAdmissionCountdownSeconds();
      if (this.entryGateState?.admissionInProgress === true || countdownSeconds > 0) {
        baseStatus =
          countdownSeconds > 0
            ? `대기실 / 입장 카운트다운 ${countdownSeconds}초`
            : "대기실 / 입장 처리 중";
      } else {
        baseStatus = this.entryGateState?.portalOpen ? "대기실 / 입장 대기" : "대기실 / 진행자 대기";
      }
      return this.composeStatusWithQuiz(baseStatus);
    }

    if (this.hubFlowEnabled) {
      if (this.flowStage === "bridge_approach") {
        baseStatus = this.networkConnected ? "온라인 / 허브 진입 중" : "오프라인 / 허브 진입 중";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "bridge_dialogue") {
        baseStatus = this.networkConnected ? "온라인 / 안내 진행 중" : "오프라인 / 안내 진행 중";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "bridge_name") {
        baseStatus = this.networkConnected ? "온라인 / 이름 확인" : "오프라인 / 이름 확인";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "bridge_mirror") {
        baseStatus = this.networkConnected ? "온라인 / 미러 게이트" : "오프라인 / 미러 게이트";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "city_intro") {
        baseStatus = this.networkConnected ? "온라인 / 도시 이동 중" : "오프라인 / 도시 이동 중";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "portal_transfer") {
        baseStatus = "포탈 / 이동 중";
        return this.composeStatusWithQuiz(baseStatus);
      }
    }

    if (!this.networkConnected) {
      baseStatus = this.socketEndpoint ? "오프라인" : "오프라인 / 서버 필요";
      return this.composeStatusWithQuiz(baseStatus);
    }

    if (this.pointerLockSupported && !this.pointerLocked && !this.mobileEnabled) {
      baseStatus = "온라인 / 클릭해서 포커스";
      return this.composeStatusWithQuiz(baseStatus);
    }

    baseStatus = "온라인";
    return this.composeStatusWithQuiz(baseStatus);
  }

  beginPerformanceFrame() {
    if (!this.performanceDebug?.enabled) {
      return;
    }
    this.performanceDebug.sections = Object.create(null);
    this.performanceDebug.flags.shadowRefresh = false;
    this.performanceDebug.flags.dynamicResolutionShift = false;
    this.performanceDebug.flags.correctionCount = 0;
    this.performanceDebug.flags.correctionYawPitch = false;
    this.performanceDebug.flags.recentLookInput =
      performance.now() - this.lastLookInputAt <
      DESKTOP_RUNTIME_SETTINGS.orientationCorrectionInputLockMs;
  }

  measurePerformanceSection(name, callback) {
    if (typeof callback !== "function") {
      return undefined;
    }
    if (!this.performanceDebug?.enabled) {
      return callback();
    }
    const key = String(name || "unknown");
    const start = performance.now();
    const result = callback();
    const elapsed = performance.now() - start;
    const previous = Number(this.performanceDebug.sections[key]) || 0;
    this.performanceDebug.sections[key] = previous + elapsed;
    return result;
  }

  markPerformanceFlag(flagKey, value = true) {
    if (!this.performanceDebug?.enabled) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(this.performanceDebug.flags, flagKey)) {
      return;
    }
    this.performanceDebug.flags[flagKey] = value;
  }

  reportPerformanceHitch(frameMs, renderMs) {
    if (!this.performanceDebug?.enabled) {
      return;
    }
    if (!Number.isFinite(frameMs) || frameMs < this.performanceDebug.hitchThresholdMs) {
      return;
    }
    const now = performance.now();
    if (now - this.performanceDebug.lastLogAt < 120) {
      return;
    }
    this.performanceDebug.lastLogAt = now;

    const sections = Object.entries(this.performanceDebug.sections)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 4)
      .map(([name, ms]) => `${name}=${Number(ms).toFixed(2)}ms`)
      .join(" ");
    const flags = this.performanceDebug.flags;
    const activeFlags = [
      flags.shadowRefresh ? "shadowRefresh" : "",
      flags.dynamicResolutionShift ? "dynamicResolutionShift" : "",
      flags.correctionYawPitch ? "serverYawPitchCorrection" : "",
      flags.recentLookInput ? "recentLookInput" : "",
      flags.correctionCount > 0 ? `serverCorrectionCount=${flags.correctionCount}` : ""
    ]
      .filter(Boolean)
      .join(" ");
    const sectionLabel = sections || "sections=n/a";
    const flagLabel = activeFlags || "flags=n/a";
    console.warn(
      `[perf] hitch ${frameMs.toFixed(2)}ms render=${renderMs.toFixed(2)}ms ${sectionLabel} ${flagLabel}`
    );
  }

  loop() {
    const frameStart = performance.now();
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.tick(delta);
    const renderStart = performance.now();
    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    const renderMs = performance.now() - renderStart;
    const frameMs = performance.now() - frameStart;
    this.reportPerformanceHitch(frameMs, renderMs);
    requestAnimationFrame(this.boundLoop);
  }

  applyPixelRatio(ratio) {
    this.renderer.setPixelRatio(ratio);
    if (this.composer) {
      this.composer.setPixelRatio(ratio);
    }
  }

  updateDynamicResolution(delta) {
    const config = this.dynamicResolution;
    if (!config || !config.enabled || !Number.isFinite(delta) || delta <= 0) {
      return;
    }

    config.sampleTime += delta;
    config.frameCount += 1;
    config.cooldown = Math.max(0, config.cooldown - delta);

    if (config.sampleTime < DYNAMIC_RESOLUTION_SETTINGS.sampleWindowSeconds) {
      return;
    }

    const fps = config.frameCount / config.sampleTime;
    config.sampleTime = 0;
    config.frameCount = 0;

    if (config.cooldown > 0) {
      return;
    }

    const floorRatio = Math.max(0.5, Math.min(config.minRatio, this.maxPixelRatio));
    let targetRatio = this.currentPixelRatio;

    if (fps < DYNAMIC_RESOLUTION_SETTINGS.downshiftFps && this.currentPixelRatio > floorRatio) {
      config.downshiftSamples += 1;
      config.upshiftSamples = 0;
      if (config.downshiftSamples >= DYNAMIC_RESOLUTION_SETTINGS.stableSamplesRequired) {
        targetRatio = Math.max(
          floorRatio,
          this.currentPixelRatio - DYNAMIC_RESOLUTION_SETTINGS.downshiftStep
        );
        config.downshiftSamples = 0;
        config.cooldown = DYNAMIC_RESOLUTION_SETTINGS.downshiftCooldownSeconds;
      } else {
        config.cooldown = DYNAMIC_RESOLUTION_SETTINGS.idleCooldownSeconds;
      }
    } else if (fps > DYNAMIC_RESOLUTION_SETTINGS.upshiftFps && this.currentPixelRatio < this.maxPixelRatio) {
      config.upshiftSamples += 1;
      config.downshiftSamples = 0;
      if (config.upshiftSamples >= DYNAMIC_RESOLUTION_SETTINGS.stableSamplesRequired) {
        targetRatio = Math.min(
          this.maxPixelRatio,
          this.currentPixelRatio + DYNAMIC_RESOLUTION_SETTINGS.upshiftStep
        );
        config.upshiftSamples = 0;
        config.cooldown = DYNAMIC_RESOLUTION_SETTINGS.upshiftCooldownSeconds;
      } else {
        config.cooldown = DYNAMIC_RESOLUTION_SETTINGS.idleCooldownSeconds;
      }
    } else {
      config.downshiftSamples = 0;
      config.upshiftSamples = 0;
      config.cooldown = DYNAMIC_RESOLUTION_SETTINGS.idleCooldownSeconds;
    }

    if (Math.abs(targetRatio - this.currentPixelRatio) < DYNAMIC_RESOLUTION_SETTINGS.ratioEpsilon) {
      config.pendingRatio = null;
      config.pendingApplyAt = 0;
      return;
    }

    const roundedTargetRatio = Number(targetRatio.toFixed(2));
    const now = performance.now();
    if (
      !Number.isFinite(config.pendingRatio) ||
      Math.abs(roundedTargetRatio - config.pendingRatio) >= DYNAMIC_RESOLUTION_SETTINGS.ratioEpsilon
    ) {
      config.pendingRatio = roundedTargetRatio;
      config.pendingApplyAt = now + DYNAMIC_RESOLUTION_SETTINGS.applyDelaySeconds * 1000;
      return;
    }
    if (now < config.pendingApplyAt) {
      return;
    }

    this.currentPixelRatio = roundedTargetRatio;
    this.applyPixelRatio(this.currentPixelRatio);
    config.pendingRatio = null;
    config.pendingApplyAt = 0;
    this.markPerformanceFlag("dynamicResolutionShift");
  }

  applyQualityProfile() {
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    const shadowEnabled = !this.mobileEnabled && quality !== "low";
    this.renderer.shadowMap.enabled = shadowEnabled;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = shadowEnabled;
    this.shadowRefreshClock = 0;
    this.shadowRefreshIdleClock = 0;
    this.pendingShadowRefresh = false;
    if (this.shadowRefreshReference) {
      this.shadowRefreshReference.ready = false;
    }

    if (this.sunLight) {
      const sunConfig = this.worldContent.lights.sun;
      this.sunLight.castShadow = shadowEnabled;
      const shadowMapSize = this.mobileEnabled
        ? sunConfig.shadowMobileSize
        : sunConfig.shadowDesktopSize;
      if (
        this.sunLight.shadow.mapSize.x !== shadowMapSize ||
        this.sunLight.shadow.mapSize.y !== shadowMapSize
      ) {
        this.sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
        this.sunLight.shadow.needsUpdate = true;
      }
    }

    this.setupCloudLayer();
    this.setupBoundaryWalls(this.worldContent.boundary);
    this.setupFloatingArena(this.worldContent.floatingArena, this.worldContent.ground);
    this.setupSpectatorStands(this.worldContent.spectatorStands, this.worldContent.boundary);
    this.setupCenterBillboard(this.worldContent.centerBillboard);
    this.setupMegaAdScreen(this.worldContent.megaAdScreen);
    this.setupOxArenaVisuals(this.worldContent.oxArena);
    this.setupBeachLayer(this.worldContent.beach, this.worldContent.ocean);
    this.setupOceanLayer(this.worldContent.ocean);
    this.setupHubFlowWorld();
    this.setupPostProcessing();
  }

  onResize() {
    const wasMobile = this.mobileEnabled;
    const detectedMobile = isLikelyTouchDevice();
    this.mobileEnabled = this.mobileModeLocked || detectedMobile;
    if (this.mobileEnabled) {
      this.mobileModeLocked = true;
    }

    if (this.mobileEnabled !== wasMobile) {
      this.applyQualityProfile();
      if (this.mobileEnabled) {
        this.mobileChatPanelVisible = false;
        this.setChatOpen(false);
        this.bindMobileControlEvents();
      } else {
        this.mobileChatPanelVisible = true;
      }
    }

    this.networkSyncInterval = this.mobileEnabled
      ? Math.max(this.baseNetworkSyncInterval, MOBILE_RUNTIME_SETTINGS.minNetworkSyncInterval)
      : this.baseNetworkSyncInterval;
    this.applyGraphicsQualityOverrides();
    this.applyGraphicsPostProcessingProfile();

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    this.camera.fov = this.resolveTargetCameraFov();
    this.camera.aspect = viewportWidth / viewportHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(viewportWidth, viewportHeight, false);
    if (this.composer) {
      this.composer.setSize(viewportWidth, viewportHeight);
    }
    if (this.mobileEnabled && this.fullscreenPending) {
      this.requestAppFullscreen();
    }
    this.resizeRoundOverlayCanvas();
    this.updateMobileControlUi();
    if (this.mobileEnabled) {
      this.refreshMobileMovePadMetrics();
    }
    this.scheduleMobileKeyboardInsetSync(0);
  }
}
