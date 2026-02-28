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

export class GameRuntime {
  constructor(mount, options = {}) {
    this.mount = mount;
    this.clock = new THREE.Clock();
    this.mobileEnabled = isLikelyTouchDevice();
    this.hud = new HUD();

    this.contentPack = options.contentPack ?? getContentPack(options.contentPackId);
    this.worldContent = this.contentPack.world;
    this.handContent = this.contentPack.hands;
    this.networkContent = this.contentPack.network;
    this.networkSyncInterval =
      Number(this.networkContent.syncInterval) || GAME_CONSTANTS.REMOTE_SYNC_INTERVAL;
    this.remoteLerpSpeed =
      Number(this.networkContent.remoteLerpSpeed) || GAME_CONSTANTS.REMOTE_LERP_SPEED;
    this.remoteStaleTimeoutMs =
      Number(this.networkContent.staleTimeoutMs) || GAME_CONSTANTS.REMOTE_STALE_TIMEOUT_MS;

    const initialPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.maxPixelRatio = initialPixelRatio;
    this.currentPixelRatio = initialPixelRatio;

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
    this.renderer.shadowMap.autoUpdate = !this.mobileEnabled;
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
    this.centerBillboardGroup = null;
    this.oxArenaGroup = null;
    this.oxArenaTextures = [];
    this.centerBillboardCanvas = null;
    this.centerBillboardContext = null;
    this.centerBillboardTexture = null;
    this.centerBillboardLastSignature = "";
    this.centerBillboardLastCountdown = null;
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
      enabled: true,
      minRatio: this.mobileEnabled
        ? GAME_CONSTANTS.DYNAMIC_RESOLUTION.mobileMinRatio
        : GAME_CONSTANTS.DYNAMIC_RESOLUTION.desktopMinRatio,
      sampleTime: 0,
      frameCount: 0,
      cooldown: 0
    };

    this.fpsState = {
      sampleTime: 0,
      frameCount: 0,
      fps: 0
    };
    this.hudRefreshClock = 0;

    this.socket = null;
    this.socketEndpoint = null;
    this.networkConnected = false;
    this.localPlayerId = null;
    this.queryParams =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams();
    this.localPlayerName = this.formatPlayerName(this.queryParams.get("name") ?? "PLAYER");
    this.pendingPlayerNameSync = false;
    this.remotePlayers = new Map();
    this.remoteSyncClock = 0;
    this.quizState = {
      active: false,
      phase: "idle",
      hostId: null,
      questionIndex: 0,
      totalQuestions: 0,
      lockAt: 0,
      questionText: "",
      survivors: 0,
      myScore: 0
    };
    this.localQuizAlive = true;
    this.chatBubbleLifetimeMs = 4200;
    this.chatLogMaxEntries = RUNTIME_TUNING.CHAT_LOG_MAX_ENTRIES;
    this.chatLogEl = document.getElementById("chat-log");
    this.chatControlsEl = document.getElementById("chat-controls");
    this.chatInputEl = document.getElementById("chat-input");
    this.toolHotbarEl = document.getElementById("tool-hotbar");
    this.chalkColorsEl = document.getElementById("chalk-colors");
    this.chalkColorButtons = [];
    this.toolButtons = [];
    this.chatOpen = false;
    this.lastLocalChatEcho = "";
    this.lastLocalChatEchoAt = 0;
    this.toolUiEl = document.getElementById("tool-ui");
    this.chatUiEl = document.getElementById("chat-ui");
    this.quizControlsEl = document.getElementById("quiz-controls");
    this.quizStartBtnEl = document.getElementById("quiz-start-btn");
    this.quizStopBtnEl = document.getElementById("quiz-stop-btn");
    this.quizNextBtnEl = document.getElementById("quiz-next-btn");
    this.quizLockBtnEl = document.getElementById("quiz-lock-btn");
    this.quizControlsNoteEl = document.getElementById("quiz-controls-note");
    this.hubFlowUiEl = document.getElementById("hub-flow-ui");
    this.hubPhaseTitleEl = document.getElementById("hub-phase-title");
    this.hubPhaseSubtitleEl = document.getElementById("hub-phase-subtitle");
    this.nicknameGateEl = document.getElementById("nickname-gate");
    this.nicknameFormEl = document.getElementById("nickname-form");
    this.nicknameInputEl = document.getElementById("nickname-input");
    this.nicknameErrorEl = document.getElementById("nickname-error");
    this.portalTransitionEl = document.getElementById("portal-transition");
    this.portalTransitionTextEl = document.getElementById("portal-transition-text");
    this.boundaryWarningEl = document.getElementById("boundary-warning");

    const hubFlowConfig = this.worldContent?.hubFlow ?? {};
    const bridgeConfig = hubFlowConfig?.bridge ?? {};
    const cityConfig = hubFlowConfig?.city ?? {};
    const portalConfig = hubFlowConfig?.portal ?? {};
    this.hubFlowEnabled = Boolean(hubFlowConfig?.enabled);
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
      throw new Error("Game mount element not found (#app).");
    }

    this._initialized = true;
    this.mount.appendChild(this.renderer.domElement);
    this.scene.add(this.camera);
    this.resolveUiElements();
    this.setupToolState();
    this.setChatOpen(false);

    this.setupWorld();
    this.setupHubFlowWorld();
    this.setupPostProcessing();
    this.bindEvents();
    this.bindHubFlowUiEvents();
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

    this.loop();
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
    const anisotropy = this.mobileEnabled ? Math.min(2, maxAnisotropy) : maxAnisotropy;
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
    this.setupCenterBillboard(world.centerBillboard);
    this.setupOxArenaVisuals(world.oxArena);
    this.setupChalkLayer(world.chalk);
    this.setupBeachLayer(world.beach, world.ocean);
    this.setupOceanLayer(world.ocean);

    const marker = world.originMarker;
    const originMarker = new THREE.Mesh(
      new THREE.CylinderGeometry(
        marker.radiusTop,
        marker.radiusBottom,
        marker.height,
        marker.radialSegments
      ),
      new THREE.MeshStandardMaterial({
        color: marker.material.color,
        roughness: marker.material.roughness,
        metalness: marker.material.metalness,
        emissive: marker.material.emissive,
        emissiveIntensity: marker.material.emissiveIntensity
      })
    );
    originMarker.position.fromArray(marker.position);
    originMarker.castShadow = true;
    this.scene.add(originMarker);
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

  setupHubFlowWorld() {
    this.clearHubFlowWorld();
    if (!this.hubFlowEnabled) {
      return;
    }

    const group = new THREE.Group();

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

    this.hubFlowGroup = group;
    this.portalGroup = portalGroup;
    this.portalRing = portalRing;
    this.portalCore = portalCore;
    this.npcGuideGroup = npcGuide;
    this.mirrorGateGroup = mirrorGate;
    this.mirrorGatePanel = null;
    this.bridgeBoundaryMarker = boundaryMarker;
    this.bridgeBoundaryRing = boundaryRing;
    this.bridgeBoundaryHalo = boundaryHalo;
    this.bridgeBoundaryBeam = boundaryBeam;

    boundaryMarker.add(boundaryRing, boundaryHalo, boundaryBeam);
    group.add(bridgeGroup, cityGroup, npcGuide, mirrorGate, boundaryMarker, portalGroup);
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
    const chalkEnabled = Boolean(this.worldContent?.chalk?.enabled);
    this.toolUiEl?.classList.toggle("hidden", !gameplayEnabled || !chalkEnabled);
    this.chatUiEl?.classList.toggle("hidden", !gameplayEnabled);
    if (!gameplayEnabled) {
      this.setChatOpen(false);
    }
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
        () => Promise.reject(new Error("play failed"))
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

  canMovePlayer() {
    if (this.quizState.active && !this.localQuizAlive) {
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
    return !this.hubFlowEnabled || this.flowStage === "city_live";
  }

  canUsePointerLock() {
    return this.canMovePlayer() && !this.portalTransitioning;
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
          "?portal=https://... 값을 지정해 이동 경로를 설정하세요."
        );
      }
      if (this.portalPhaseClock <= 0) {
        this.portalPhase = "cooldown";
        this.portalPhaseClock = this.portalCooldownSeconds;
      }
    }
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
    ringMaterial.opacity = 0.62;
    coreMaterial.opacity = 0.05;
    this.portalGroup.scale.set(1, 1, 1);
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

  resolvePortalTargetUrl(defaultTarget = "") {
    const queryTarget = String(
      this.queryParams.get("portal") ?? this.queryParams.get("next") ?? ""
    ).trim();
    if (queryTarget) {
      return queryTarget;
    }

    const globalTarget = String(window.__EMPTINES_PORTAL_TARGET ?? "").trim();
    if (globalTarget) {
      return globalTarget;
    }

    const configTarget = String(defaultTarget ?? "").trim();
    return configTarget || null;
  }

  buildPortalTransferUrl() {
    if (!this.portalTargetUrl) {
      return null;
    }

    let target;
    try {
      target = new URL(this.portalTargetUrl, window.location.href);
    } catch {
      return null;
    }

    const returnUrl = `${window.location.origin}${window.location.pathname}`;
    target.searchParams.set("return", returnUrl);
    target.searchParams.set("name", this.localPlayerName);
    if (this.socketEndpoint) {
      target.searchParams.set("server", this.socketEndpoint);
    }
    return target.toString();
  }

  triggerPortalTransfer() {
    if (this.portalTransitioning) {
      return;
    }

    const destination = this.buildPortalTransferUrl();
    if (!destination) {
      this.portalPhase = "cooldown";
      this.portalPhaseClock = this.portalCooldownSeconds;
      this.setFlowHeadline(
        "포탈 링크 누락",
        "?portal=https://... 로 이동 주소를 지정한 뒤 다시 시도하세요."
      );
      return;
    }

    this.portalTransitioning = true;
    this.flowStage = "portal_transfer";
    this.hud.setStatus(this.getStatusText());
    this.syncGameplayUiForFlow();
    this.setPortalTransition(true, "포탈 동기화 중...");

    window.setTimeout(() => {
      window.location.assign(destination);
    }, 780);
  }

  syncPlayerNameIfConnected() {
    const nextName = this.formatPlayerName(this.localPlayerName);
    this.localPlayerName = nextName;
    if (!this.socket || !this.networkConnected) {
      this.pendingPlayerNameSync = true;
      return;
    }

    this.socket.emit("room:quick-join", { name: nextName });
    this.pendingPlayerNameSync = false;
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
      : ["MEGA OX QUIZ", "WAITING FOR HOST"];

    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
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

    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({
        map: panelTexture,
        emissive: 0x3f7fc3,
        emissiveIntensity: Number(config.screenGlow) || 0.34,
        roughness: 0.32,
        metalness: 0.08
      })
    );
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
    this.renderCenterBillboard({
      kicker: "LIVE",
      title: lines[0] ?? "MEGA OX QUIZ",
      lines: lines.slice(1),
      footer: "WAITING FOR HOST"
    });
  }

  renderCenterBillboard(payload = {}) {
    const context = this.centerBillboardContext;
    const canvas = this.centerBillboardCanvas;
    if (!context || !canvas || !this.centerBillboardTexture) {
      return;
    }

    const kicker = String(payload.kicker ?? "LIVE").trim().slice(0, 32);
    const title = String(payload.title ?? "MEGA OX QUIZ").trim().slice(0, 90);
    const footer = String(payload.footer ?? "").trim().slice(0, 80);
    const lineSource = Array.isArray(payload.lines) ? payload.lines : [];
    const lines = lineSource
      .map((line) => String(line ?? "").trim())
      .filter(Boolean)
      .slice(0, 4);
    const signature = `${kicker}|${title}|${footer}|${lines.join("||")}`;
    if (signature === this.centerBillboardLastSignature) {
      return;
    }
    this.centerBillboardLastSignature = signature;

    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#0d141d");
    gradient.addColorStop(0.55, "#151f2d");
    gradient.addColorStop(1, "#0d141d");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.strokeStyle = "rgba(140, 190, 255, 0.6)";
    context.lineWidth = 18;
    context.strokeRect(22, 22, canvas.width - 44, canvas.height - 44);

    context.fillStyle = "#89ccff";
    context.font = "700 48px 'Segoe UI'";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(kicker || "LIVE", canvas.width * 0.5, 82);

    context.fillStyle = "#f3f8ff";
    context.font = "800 60px 'Bahnschrift'";
    this.drawBillboardWrappedText(
      context,
      title || "MEGA OX QUIZ",
      canvas.width * 0.5,
      168,
      canvas.width - 120,
      66,
      2
    );

    const baseY = 282;
    context.fillStyle = "#dbe9ff";
    context.font = "700 42px 'Segoe UI'";
    for (let index = 0; index < lines.length; index += 1) {
      this.drawBillboardWrappedText(
        context,
        lines[index],
        canvas.width * 0.5,
        baseY + index * 60,
        canvas.width - 150,
        48,
        1
      );
    }

    if (footer) {
      context.fillStyle = "#a7c8ee";
      context.font = "600 34px 'Segoe UI'";
      context.fillText(footer, canvas.width * 0.5, canvas.height - 54);
    }

    this.centerBillboardTexture.needsUpdate = true;
  }

  drawBillboardWrappedText(context, rawText, x, y, maxWidth, lineHeight, maxLines = 1) {
    const text = String(rawText ?? "").trim();
    if (!text) {
      return;
    }

    const hasWhitespace = /\s/.test(text);
    const words = hasWhitespace ? text.split(/\s+/) : Array.from(text);
    const lines = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
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

      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(width, depth),
        new THREE.MeshStandardMaterial({
          color: zoneConfig.color ?? 0x3f586f,
          roughness: 0.84,
          metalness: 0.08,
          emissive: zoneConfig.emissive ?? 0x1f2d3b,
          emissiveIntensity: 0.2,
          transparent: true,
          opacity: 0.92
        })
      );
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(centerX, 0.034, centerZ);
      plate.receiveShadow = true;
      plate.renderOrder = 8;
      group.add(plate);
      return { plate, centerX, centerZ, width, depth };
    };

    const oZone = createZonePlate(config.oZone, -34);
    const xZone = createZonePlate(config.xZone, 34);

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

    this.oxArenaGroup = group;
    this.scene.add(this.oxArenaGroup);
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

    const bloomConfig = this.worldContent?.postProcessing?.bloom;
    const bloomEnabled =
      Boolean(bloomConfig?.enabled) && (!this.mobileEnabled || Boolean(bloomConfig?.mobileEnabled));
    if (!bloomEnabled) {
      this.composer = null;
      this.bloomPass = null;
      return;
    }

    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(this.currentPixelRatio);
    composer.setSize(window.innerWidth, window.innerHeight);

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

    window.addEventListener("resize", () => this.onResize());

    window.addEventListener("keydown", (event) => {
      if (this.isTextInputTarget(event.target)) {
        if (event.code === "Escape") {
          this.setChatOpen(false);
          event.target.blur?.();
        }
        return;
      }

      if (
        event.code === RUNTIME_TUNING.CHAT_OPEN_KEY &&
        this.chatInputEl &&
        this.canUseGameplayControls()
      ) {
        event.preventDefault();
        this.focusChatInput();
        return;
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
      this.keys.delete(event.code);
    });

    window.addEventListener("blur", () => {
      this.keys.clear();
      this.chalkDrawingActive = false;
    });

    this.renderer.domElement.addEventListener("click", () => {
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

    window.addEventListener(
      "mousemove",
      (event) => {
        if (!this.pointerLocked && !this.mobileEnabled) {
          return;
        }
        const sensitivityX = this.mobileEnabled ? 0.0018 : 0.0023;
        const sensitivityY = this.mobileEnabled ? 0.0016 : 0.002;
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
      });
      this.chatInputEl.addEventListener("keydown", (event) => {
        if (event.code === "Enter") {
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
        this.setChatOpen(false);
      });
    }

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

    this.quizStartBtnEl?.addEventListener("click", () => {
      this.requestQuizStart();
    });
    this.quizStopBtnEl?.addEventListener("click", () => {
      this.requestQuizStop();
    });
    this.quizNextBtnEl?.addEventListener("click", () => {
      this.requestQuizNext();
    });
    this.quizLockBtnEl?.addEventListener("click", () => {
      this.requestQuizLock();
    });
  }

  resolveUiElements() {
    if (!this.toolUiEl) {
      this.toolUiEl = document.getElementById("tool-ui");
    }
    if (!this.chatUiEl) {
      this.chatUiEl = document.getElementById("chat-ui");
    }
    if (!this.quizControlsEl) {
      this.quizControlsEl = document.getElementById("quiz-controls");
    }
    if (!this.quizStartBtnEl) {
      this.quizStartBtnEl = document.getElementById("quiz-start-btn");
    }
    if (!this.quizStopBtnEl) {
      this.quizStopBtnEl = document.getElementById("quiz-stop-btn");
    }
    if (!this.quizNextBtnEl) {
      this.quizNextBtnEl = document.getElementById("quiz-next-btn");
    }
    if (!this.quizLockBtnEl) {
      this.quizLockBtnEl = document.getElementById("quiz-lock-btn");
    }
    if (!this.quizControlsNoteEl) {
      this.quizControlsNoteEl = document.getElementById("quiz-controls-note");
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
    if (!this.portalTransitionEl) {
      this.portalTransitionEl = document.getElementById("portal-transition");
    }
    if (!this.portalTransitionTextEl) {
      this.portalTransitionTextEl = document.getElementById("portal-transition-text");
    }
    if (!this.boundaryWarningEl) {
      this.boundaryWarningEl = document.getElementById("boundary-warning");
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
    if (!this.toolHotbarEl) {
      this.toolHotbarEl = document.getElementById("tool-hotbar");
    }
    if (!this.chalkColorsEl) {
      this.chalkColorsEl = document.getElementById("chalk-colors");
    }
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

  setChatOpen(open) {
    if (open && !this.canUseGameplayControls()) {
      return;
    }

    this.chatOpen = Boolean(open);
    if (this.chatControlsEl) {
      this.chatControlsEl.classList.toggle("hidden", !this.chatOpen);
    }
    if (this.chatOpen) {
      this.chalkDrawingActive = false;
      this.chalkLastStamp = null;
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

  connectNetwork() {
    const endpoint = this.resolveSocketEndpoint();
    this.socketEndpoint = endpoint;
    if (!endpoint) {
      this.networkConnected = false;
      this.hud.setStatus(this.getStatusText());
      return;
    }

    const socket = io(endpoint, {
      transports: ["websocket", "polling"],
      timeout: 3200,
      reconnection: true,
      reconnectionDelay: 900,
      reconnectionDelayMax: 5000
    });

    this.socket = socket;

    socket.on("connect", () => {
      this.networkConnected = true;
      this.localPlayerId = socket.id;
      this.hud.setStatus(this.getStatusText());
      this.syncPlayerNameIfConnected();
      this.updateQuizControlUi();
    });

    socket.on("disconnect", () => {
      this.networkConnected = false;
      this.localPlayerId = null;
      this.clearRemotePlayers();
      this.resetQuizStateLocal();
      this.hud.setStatus(this.getStatusText());
      this.hud.setPlayers(1);
      this.updateQuizControlUi();
    });

    socket.on("connect_error", () => {
      this.networkConnected = false;
      this.hud.setStatus(this.getStatusText());
      this.updateQuizControlUi();
    });

    socket.on("room:update", (room) => {
      this.handleRoomUpdate(room);
    });

    socket.on("player:sync", (payload) => {
      this.handleRemoteSync(payload);
    });

    socket.on("chat:message", (payload) => {
      this.handleChatMessage(payload);
    });

    socket.on("quiz:start", (payload = {}) => {
      this.handleQuizStart(payload);
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

    socket.on("quiz:end", (payload = {}) => {
      this.handleQuizEnd(payload);
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

  handleRoomUpdate(room) {
    const players = Array.isArray(room?.players) ? room.players : [];
    this.quizState.hostId = room?.hostId ?? this.quizState.hostId;
    const seen = new Set();

    for (const player of players) {
      const id = String(player?.id ?? "");
      if (!id) {
        continue;
      }
      if (id === this.localPlayerId) {
        this.localPlayerName = this.formatPlayerName(player?.name);
        const nextAlive = player?.alive !== false;
        if (this.quizState.active && this.localQuizAlive && !nextAlive) {
          this.appendChatLine("SYSTEM", "You are OUT. Spectator mode.", "system");
          this.keys.clear();
        }
        this.localQuizAlive = nextAlive;
        continue;
      }
      seen.add(id);
      this.upsertRemotePlayer(id, player.state ?? null, player?.name, player?.alive);
    }

    for (const id of this.remotePlayers.keys()) {
      if (!seen.has(id)) {
        this.removeRemotePlayer(id);
      }
    }

    const localPlayer = this.networkConnected ? 1 : 0;
    this.hud.setPlayers(this.remotePlayers.size + localPlayer);
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

  upsertRemotePlayer(id, state, name, alive = null) {
    let remote = this.remotePlayers.get(id);
    if (!remote) {
      const root = new THREE.Group();

      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.2, 0.64, 4, 8),
        new THREE.MeshStandardMaterial({
          color: 0x5f7086,
          roughness: 0.44,
          metalness: 0.06,
          emissive: 0x2d4057,
          emissiveIntensity: 0.18
        })
      );
      body.position.y = 0.92;
      body.castShadow = true;
      body.receiveShadow = true;

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 12, 12),
        new THREE.MeshStandardMaterial({
          color: 0x7e8e9b,
          roughness: 0.36,
          metalness: 0.05,
          emissive: 0x3e4f63,
          emissiveIntensity: 0.2
        })
      );
      head.position.y = 1.62;
      head.castShadow = true;
      head.receiveShadow = true;

      const nameLabel = this.createTextLabel("플레이어", "name");
      nameLabel.position.set(0, 2.12, 0);

      const chatLabel = this.createTextLabel("", "chat");
      chatLabel.position.set(0, 2.5, 0);
      chatLabel.visible = false;

      root.add(body, head, nameLabel, chatLabel);
      root.position.set(0, 0, 0);
      this.scene.add(root);

      remote = {
        mesh: root,
        body,
        head,
        nameLabel,
        chatLabel,
        name: "플레이어",
        alive: true,
        chatExpireAt: 0,
        targetPosition: new THREE.Vector3(0, 0, 0),
        targetYaw: 0,
        lastSeen: performance.now()
      };

      this.remotePlayers.set(id, remote);
    }

    const nextName = this.formatPlayerName(name);
    if (nextName !== remote.name) {
      remote.name = nextName;
      this.setTextLabel(remote.nameLabel, nextName, "name");
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

    if (alive !== null && typeof alive !== "undefined") {
      this.setRemoteAliveVisual(remote, alive !== false);
    }
  }

  setRemoteAliveVisual(remote, alive) {
    if (!remote) {
      return;
    }
    const nextAlive = Boolean(alive);
    if (remote.alive === nextAlive) {
      return;
    }

    remote.alive = nextAlive;
    const meshes = [remote.body, remote.head];
    for (const mesh of meshes) {
      const material = mesh?.material;
      if (!material) {
        continue;
      }
      material.transparent = !nextAlive;
      material.opacity = nextAlive ? 1 : 0.28;
      material.emissiveIntensity = nextAlive ? 0.2 : 0.42;
      material.needsUpdate = true;
    }

    const nameText = nextAlive ? remote.name : `${remote.name} [OUT]`;
    this.setTextLabel(remote.nameLabel, nameText, "name");
  }

  removeRemotePlayer(id) {
    const remote = this.remotePlayers.get(id);
    if (!remote) {
      return;
    }

    this.disposeTextLabel(remote.nameLabel);
    this.disposeTextLabel(remote.chatLabel);
    this.scene.remove(remote.mesh);
    disposeMeshTree(remote.mesh);
    this.remotePlayers.delete(id);
  }

  clearRemotePlayers() {
    for (const id of this.remotePlayers.keys()) {
      this.removeRemotePlayer(id);
    }
  }

  tick(delta) {
    this.updateMovement(delta);
    this.updateHubFlow(delta);
    this.updateChalkDrawing();
    this.updateCloudLayer(delta);
    this.updateOcean(delta);
    this.updateRemotePlayers(delta);
    this.emitLocalSync(delta);
    this.updateDynamicResolution(delta);
    this.updateHud(delta);
  }

  updateMovement(delta) {
    const movementEnabled = this.canMovePlayer();
    const keyForward = movementEnabled
      ? (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) -
        (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0)
      : 0;
    const keyStrafe = movementEnabled
      ? (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) -
        (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0)
      : 0;

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

      if (this.moveVec.lengthSq() > 0.0001) {
        this.moveVec.normalize();
      }

      const moveStep = speed * delta;
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

      if (remote.chatLabel.visible && now >= remote.chatExpireAt) {
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

    this.setTextLabel(remote.chatLabel, text, "chat");
    remote.chatLabel.visible = true;
    remote.chatExpireAt = performance.now() + this.chatBubbleLifetimeMs;
  }

  resetQuizStateLocal() {
    this.quizState.active = false;
    this.quizState.phase = "idle";
    this.quizState.hostId = null;
    this.quizState.questionIndex = 0;
    this.quizState.totalQuestions = 0;
    this.quizState.lockAt = 0;
    this.quizState.questionText = "";
    this.quizState.survivors = 0;
    this.quizState.myScore = 0;
    this.localQuizAlive = true;
    this.centerBillboardLastCountdown = null;
    this.renderCenterBillboard({
      kicker: "LIVE",
      title: "MEGA OX QUIZ",
      lines: ["WAITING FOR HOST"],
      footer: "MAX 50 PLAYERS"
    });
    this.updateQuizControlUi();
  }

  handleQuizStart(payload = {}) {
    this.quizState.active = true;
    this.quizState.phase = "start";
    this.quizState.hostId = payload.hostId ?? null;
    this.quizState.questionIndex = 0;
    this.quizState.totalQuestions = Math.max(0, Math.trunc(Number(payload.totalQuestions) || 0));
    this.quizState.lockAt = 0;
    this.quizState.questionText = "";
    this.localQuizAlive = true;
    this.centerBillboardLastCountdown = null;

    const totalText =
      this.quizState.totalQuestions > 0 ? `${this.quizState.totalQuestions}` : "?";
    this.appendChatLine(
      "SYSTEM",
      `OX quiz started. Total questions: ${totalText}`,
      "system"
    );
    this.renderCenterBillboard({
      kicker: "OX QUIZ 10",
      title: "ROUND START",
      lines: [`TOTAL QUESTIONS ${totalText}`, "MOVE TO O OR X ZONE"],
      footer: "QUESTION LOADING..."
    });
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
    this.quizState.questionText = String(payload.text ?? "").trim().slice(0, 180);
    this.centerBillboardLastCountdown = null;

    const questionText = this.quizState.questionText || "Question opened";
    this.appendChatLine(
      "SYSTEM",
      `Q${this.quizState.questionIndex}/${this.quizState.totalQuestions}: ${questionText}`,
      "system"
    );
    this.syncQuizBillboard(true);
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizLock(payload = {}) {
    this.quizState.phase = "lock";
    this.quizState.lockAt = 0;
    const index = Math.max(
      this.quizState.questionIndex,
      Math.trunc(Number(payload.index) || this.quizState.questionIndex || 0)
    );
    this.quizState.questionIndex = index;
    this.appendChatLine("SYSTEM", `Q${index} locked. Judging...`, "system");
    this.renderCenterBillboard({
      kicker: `Q${index}/${Math.max(this.quizState.totalQuestions, index)}`,
      title: "LOCKED",
      lines: ["NO MORE MOVEMENT", "SERVER JUDGING"],
      footer: "WAIT RESULT"
    });
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizResult(payload = {}) {
    this.quizState.phase = "result";
    const index = Math.max(
      this.quizState.questionIndex,
      Math.trunc(Number(payload.index) || this.quizState.questionIndex || 0)
    );
    this.quizState.questionIndex = index;
    const answer = String(payload.answer ?? "").trim().toUpperCase();
    const survivorCount = Math.max(0, Math.trunc(Number(payload.survivorCount) || 0));
    this.quizState.survivors = survivorCount;

    this.appendChatLine(
      "SYSTEM",
      `Q${index} result: answer=${answer || "?"}, survivors=${survivorCount}`,
      "system"
    );
    this.renderCenterBillboard({
      kicker: `Q${index}/${Math.max(this.quizState.totalQuestions, index)}`,
      title: `ANSWER ${answer || "?"}`,
      lines: [`SURVIVORS ${survivorCount}`, this.localQuizAlive ? "YOU ARE SAFE" : "YOU ARE OUT"],
      footer: "NEXT QUESTION SOON"
    });
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizScore(payload = {}) {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);
    if (hasOwn("active")) {
      this.quizState.active = Boolean(payload.active);
    }
    if (hasOwn("phase")) {
      this.quizState.phase = String(payload.phase ?? "idle");
    }
    this.quizState.hostId = payload.hostId ?? this.quizState.hostId;
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

    const myId = String(this.localPlayerId ?? "");
    const leaderboard = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
    const aliveById = new Map();
    for (const entry of leaderboard) {
      const id = String(entry?.id ?? "");
      if (!id) {
        continue;
      }
      aliveById.set(id, entry?.alive !== false);
    }

    const me = leaderboard.find((entry) => String(entry?.id ?? "") === myId) ?? null;
    if (me) {
      this.quizState.myScore = Math.max(0, Math.trunc(Number(me.score) || 0));
      const nextAlive = me.alive !== false;
      if (this.quizState.active && this.localQuizAlive && !nextAlive) {
        this.appendChatLine("SYSTEM", "You are OUT. Spectator mode.", "system");
        this.keys.clear();
      }
      this.localQuizAlive = nextAlive;
    }

    for (const [remoteId, remote] of this.remotePlayers) {
      if (!aliveById.has(remoteId)) {
        continue;
      }
      this.setRemoteAliveVisual(remote, aliveById.get(remoteId));
    }

    this.syncQuizBillboard();
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  handleQuizEnd(payload = {}) {
    const winners = Array.isArray(payload.winners) ? payload.winners : [];
    if (winners.length > 0) {
      const label = winners
        .slice(0, 3)
        .map((entry) => `${this.formatPlayerName(entry?.name)}(${Math.max(0, Math.trunc(Number(entry?.score) || 0))})`)
        .join(", ");
      this.appendChatLine("SYSTEM", `Quiz finished. Winners: ${label}`, "system");
    } else {
      this.appendChatLine("SYSTEM", "Quiz finished.", "system");
    }

    this.quizState.active = false;
    this.quizState.phase = "ended";
    this.quizState.lockAt = 0;
    this.centerBillboardLastCountdown = null;
    this.renderCenterBillboard({
      kicker: "OX QUIZ 10",
      title: "ROUND END",
      lines: winners.length > 0 ? winners.slice(0, 2).map((w) => this.formatPlayerName(w?.name)) : ["NO WINNER"],
      footer: "WAITING NEXT START"
    });
    this.hud.setStatus(this.getStatusText());
    this.updateQuizControlUi();
  }

  syncQuizBillboard(force = false) {
    if (!this.quizState.active) {
      return;
    }

    if (this.quizState.phase === "question") {
      const seconds = this.getQuizCountdownSeconds();
      this.centerBillboardLastCountdown = seconds;
      this.renderCenterBillboard({
        kicker: `Q${this.quizState.questionIndex}/${Math.max(this.quizState.totalQuestions, this.quizState.questionIndex)}`,
        title: this.quizState.questionText || "QUESTION",
        lines: [
          `TIME LEFT ${seconds}s`,
          this.localQuizAlive ? "STATUS ALIVE" : "STATUS OUT"
        ],
        footer: "MOVE TO O OR X NOW"
      });
      return;
    }

    if (force) {
      this.centerBillboardLastCountdown = null;
    }
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

  composeStatusWithQuiz(baseStatus) {
    const status = String(baseStatus ?? "");
    if (!this.quizState.active && this.quizState.phase !== "ended") {
      return status;
    }

    const questionLabel =
      this.quizState.questionIndex > 0
        ? `Q${this.quizState.questionIndex}/${Math.max(this.quizState.totalQuestions, this.quizState.questionIndex)}`
        : "Q?";

    if (this.quizState.phase === "question") {
      const seconds = this.getQuizCountdownSeconds();
      return `${status} | ${questionLabel} ${seconds}s ${this.localQuizAlive ? "alive" : "OUT"}`;
    }
    if (this.quizState.phase === "lock") {
      return `${status} | ${questionLabel} LOCK ${this.localQuizAlive ? "alive" : "OUT"}`;
    }
    if (this.quizState.phase === "result") {
      return `${status} | ${questionLabel} survivors ${this.quizState.survivors} ${this.localQuizAlive ? "alive" : "OUT"}`;
    }
    if (this.quizState.phase === "ended") {
      return `${status} | quiz ended`;
    }
    if (this.quizState.phase === "start") {
      return `${status} | quiz start`;
    }
    return `${status} | quiz ${this.quizState.phase}`;
  }

  isLocalHost() {
    const hostId = String(this.quizState.hostId ?? "");
    const myId = String(this.localPlayerId ?? "");
    return Boolean(hostId && myId && hostId === myId);
  }

  updateQuizControlUi() {
    this.resolveUiElements();
    const isHost = this.isLocalHost();
    const connected = Boolean(this.networkConnected && this.socket);
    const show = connected && isHost;
    this.quizControlsEl?.classList.toggle("hidden", !show);
    if (!show) {
      return;
    }

    const phase = String(this.quizState.phase ?? "idle");
    const active = Boolean(this.quizState.active);
    this.quizStartBtnEl && (this.quizStartBtnEl.disabled = active);
    this.quizStopBtnEl && (this.quizStopBtnEl.disabled = !active);
    this.quizNextBtnEl && (this.quizNextBtnEl.disabled = !active || phase !== "waiting-next");
    this.quizLockBtnEl && (this.quizLockBtnEl.disabled = !active || phase !== "question");

    if (this.quizControlsNoteEl) {
      this.quizControlsNoteEl.textContent = active
        ? `Phase: ${phase} | Q${Math.max(0, this.quizState.questionIndex)}/${Math.max(0, this.quizState.totalQuestions)}`
        : "Ready. Press START to run OX quiz.";
    }
  }

  requestQuizStart() {
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("SYSTEM", "Cannot start quiz while offline.", "system");
      return;
    }
    this.socket.emit("quiz:start", { lockSeconds: 15 }, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("SYSTEM", `Start failed: ${String(response?.error ?? "unknown")}`, "system");
        return;
      }
      this.appendChatLine("SYSTEM", "Quiz started by host.", "system");
    });
  }

  requestQuizStop() {
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("SYSTEM", "Cannot stop quiz while offline.", "system");
      return;
    }
    this.socket.emit("quiz:stop", {}, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("SYSTEM", `Stop failed: ${String(response?.error ?? "unknown")}`, "system");
        return;
      }
      this.appendChatLine("SYSTEM", "Quiz stopped by host.", "system");
    });
  }

  requestQuizNext() {
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("SYSTEM", "Cannot move next while offline.", "system");
      return;
    }
    this.socket.emit("quiz:next", {}, (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("SYSTEM", `Next failed: ${String(response?.error ?? "unknown")}`, "system");
      }
    });
  }

  requestQuizLock() {
    if (!this.socket || !this.networkConnected) {
      this.appendChatLine("SYSTEM", "Cannot lock while offline.", "system");
      return;
    }
    this.socket.emit("quiz:force-lock", (response = {}) => {
      if (!response?.ok) {
        this.appendChatLine("SYSTEM", `Lock failed: ${String(response?.error ?? "unknown")}`, "system");
      }
    });
  }

  appendChatLine(name, text, type = "remote") {
    this.resolveUiElements();
    if (!this.chatLogEl) {
      return false;
    }

    const line = document.createElement("p");
    line.className = `chat-line ${type}`;

    if (type === "system") {
      line.textContent = String(text ?? "").trim();
    } else {
      const safeName = this.formatPlayerName(name);
      const safeText = String(text ?? "").trim();
      if (!safeText) {
        return false;
      }

      const nameEl = document.createElement("span");
      nameEl.className = "chat-name";
      nameEl.textContent = `${safeName}:`;

      const textEl = document.createElement("span");
      textEl.textContent = safeText;

      line.append(nameEl, textEl);
    }

    this.chatLogEl.appendChild(line);
    while (this.chatLogEl.childElementCount > this.chatLogMaxEntries) {
      this.chatLogEl.firstElementChild?.remove();
    }
    this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    return true;
  }

  sendChatMessage() {
    this.resolveUiElements();
    if (!this.chatInputEl) {
      return;
    }

    const text = String(this.chatInputEl.value ?? "").trim().slice(0, 120);
    if (!text) {
      return;
    }

    const senderName = this.formatPlayerName(this.localPlayerName);
    this.localPlayerName = senderName;
    const appended = this.appendChatLine(senderName, text, "self");
    if (appended) {
      this.lastLocalChatEcho = `${senderName}|${text}`;
      this.lastLocalChatEchoAt = performance.now();
    }

    if (this.socket && this.networkConnected) {
      this.socket.emit("chat:send", {
        name: senderName,
        text
      });
    }

    this.chatInputEl.value = "";
    this.setChatOpen(false);
    this.chatInputEl.blur();
  }

  focusChatInput() {
    this.resolveUiElements();
    if (!this.chatInputEl) {
      return;
    }
    if (!this.canUseGameplayControls()) {
      return;
    }
    this.setChatOpen(true);
    this.keys.clear();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock?.();
    }
    this.chatInputEl.focus();
    this.chatInputEl.select();
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

  createTextLabel(text, kind = "name") {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = kind === "chat" ? 144 : 112;

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
      context.font = kind === "chat" ? "600 40px Bahnschrift" : "700 38px Bahnschrift";
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
  }

  emitLocalSync(delta) {
    if (!this.socket || !this.networkConnected) {
      return;
    }

    this.remoteSyncClock += delta;
    if (this.remoteSyncClock < this.networkSyncInterval) {
      return;
    }
    this.remoteSyncClock = 0;

    this.socket.emit("player:sync", {
      x: this.playerPosition.x,
      y: this.playerPosition.y,
      z: this.playerPosition.z,
      yaw: this.yaw,
      pitch: this.pitch
    });
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

    this.hudRefreshClock += delta;
    if (this.hudRefreshClock < RUNTIME_TUNING.HUD_REFRESH_INTERVAL_SECONDS) {
      return;
    }
    this.hudRefreshClock = 0;
    this.syncQuizBillboard();

    const localPlayer = this.networkConnected ? 1 : 0;
    this.hud.update({
      status: this.getStatusText(),
      players: this.remotePlayers.size + localPlayer,
      x: this.playerPosition.x,
      z: this.playerPosition.z,
      fps: fpsState.fps
    });
  }

  getStatusText() {
    let baseStatus;

    if (this.hubFlowEnabled) {
      if (this.flowStage === "bridge_approach") {
        baseStatus = this.networkConnected ? "online / entering hub" : "offline / entering hub";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "bridge_dialogue") {
        baseStatus = this.networkConnected ? "online / npc briefing" : "offline / npc briefing";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "bridge_name") {
        baseStatus = this.networkConnected ? "online / name check" : "offline / name check";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "bridge_mirror") {
        baseStatus = this.networkConnected ? "online / mirror gate" : "offline / mirror gate";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "city_intro") {
        baseStatus = this.networkConnected ? "online / city transfer" : "offline / city transfer";
        return this.composeStatusWithQuiz(baseStatus);
      }
      if (this.flowStage === "portal_transfer") {
        baseStatus = "portal / transferring";
        return this.composeStatusWithQuiz(baseStatus);
      }
    }

    if (!this.networkConnected) {
      baseStatus = this.socketEndpoint ? "offline" : "offline / server needed";
      return this.composeStatusWithQuiz(baseStatus);
    }

    if (this.pointerLockSupported && !this.pointerLocked && !this.mobileEnabled) {
      baseStatus = "online / click to focus";
      return this.composeStatusWithQuiz(baseStatus);
    }

    baseStatus = "online";
    return this.composeStatusWithQuiz(baseStatus);
  }

  loop() {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.tick(delta);
    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    requestAnimationFrame(() => this.loop());
  }

  updateDynamicResolution(delta) {
    const config = this.dynamicResolution;
    if (!config || !config.enabled || !Number.isFinite(delta) || delta <= 0) {
      return;
    }

    config.sampleTime += delta;
    config.frameCount += 1;
    config.cooldown = Math.max(0, config.cooldown - delta);

    if (config.sampleTime < 0.8) {
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

    if (fps < 50 && this.currentPixelRatio > floorRatio) {
      targetRatio = Math.max(floorRatio, this.currentPixelRatio - 0.1);
      config.cooldown = 0.8;
    } else if (fps > 58 && this.currentPixelRatio < this.maxPixelRatio) {
      targetRatio = Math.min(this.maxPixelRatio, this.currentPixelRatio + 0.05);
      config.cooldown = 1.5;
    } else {
      config.cooldown = 0.4;
    }

    if (Math.abs(targetRatio - this.currentPixelRatio) < 0.01) {
      return;
    }

    this.currentPixelRatio = Number(targetRatio.toFixed(2));
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.currentPixelRatio);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    }
  }

  applyQualityProfile() {
    const shadowEnabled = !this.mobileEnabled;
    this.renderer.shadowMap.enabled = shadowEnabled;
    this.renderer.shadowMap.autoUpdate = shadowEnabled;

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
    this.setupCenterBillboard(this.worldContent.centerBillboard);
    this.setupOxArenaVisuals(this.worldContent.oxArena);
    this.setupBeachLayer(this.worldContent.beach, this.worldContent.ocean);
    this.setupOceanLayer(this.worldContent.ocean);
    this.setupHubFlowWorld();
    this.setupPostProcessing();
  }

  onResize() {
    const wasMobile = this.mobileEnabled;
    this.mobileEnabled = isLikelyTouchDevice();

    if (this.mobileEnabled !== wasMobile) {
      this.applyQualityProfile();
    }

    this.dynamicResolution.minRatio = this.mobileEnabled
      ? GAME_CONSTANTS.DYNAMIC_RESOLUTION.mobileMinRatio
      : GAME_CONSTANTS.DYNAMIC_RESOLUTION.desktopMinRatio;

    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const minPixelRatio = Math.max(0.5, Math.min(this.dynamicResolution.minRatio, this.maxPixelRatio));
    const clampedRatio = THREE.MathUtils.clamp(this.currentPixelRatio, minPixelRatio, this.maxPixelRatio);
    if (Math.abs(clampedRatio - this.currentPixelRatio) > 0.01) {
      this.currentPixelRatio = Number(clampedRatio.toFixed(2));
      this.renderer.setPixelRatio(this.currentPixelRatio);
    }

    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.composer) {
      this.composer.setPixelRatio(this.currentPixelRatio);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    }
  }
}

