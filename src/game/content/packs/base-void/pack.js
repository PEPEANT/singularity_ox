import { GAME_CONSTANTS } from "../../../config/gameConstants.js";

export const BASE_VOID_PACK = {
  id: "base-void",
  name: "Base Void",
  world: {
    skyColor: 0xa8d4f5,
    fogDensity: 0.0022,
    fogNear: 110,
    fogFar: 500,
    sky: {
      scale: 450000,
      turbidity: 1.85,
      rayleigh: 2.95,
      mieCoefficient: 0.0028,
      mieDirectionalG: 0.79,
      textureUrl: "",
      textureBackgroundIntensity: 0.2,
      textureEnvironmentIntensity: 0.16
    },
    clouds: {
      enabled: true,
      count: 26,
      area: 2400,
      minHeight: 130,
      maxHeight: 250,
      minScale: 24,
      maxScale: 56,
      color: 0xfdfefe,
      opacity: 0.68,
      driftMin: 0.12,
      driftMax: 0.36,
      minPuffs: 5,
      maxPuffs: 8,
      puffSpread: 1.95,
      puffHeightSpread: 0.16,
      mobileCountScale: 0.55,
      emissive: 0x304a63,
      emissiveIntensity: 0.02
    },
    lights: {
      hemisphere: {
        skyColor: 0xe1efff,
        groundColor: 0xbec7d2,
        intensity: 0.88
      },
      sun: {
        color: 0xffffff,
        intensity: 0.86,
        position: [70, 130, 44],
        shadowMobileSize: 1024,
        shadowDesktopSize: 1536,
        shadowBounds: 300,
        shadowNear: 1,
        shadowFar: 500,
        shadowBias: -0.00018,
        shadowNormalBias: 0.02
      },
      fill: {
        color: 0xe5f2ff,
        intensity: 0.26,
        position: [-72, 56, -32]
      }
    },
    ground: {
      textureUrl: "",
      normalTextureUrl: "",
      roughnessTextureUrl: "",
      aoTextureUrl: "",
      repeatX: 1,
      repeatY: 1,
      size: 260,
      color: 0xb0b5bb,
      roughness: 0.9,
      metalness: 0,
      emissive: 0x383e44,
      emissiveIntensity: 0.06,
      normalScale: [1, 1],
      aoIntensity: 0,
      undersideColor: 0xa4aab0,
      undersideEmissive: 0x33393f,
      undersideEmissiveIntensity: 0.06,
      undersideOffsetY: -0.12
    },
    boundary: {
      enabled: true,
      halfExtent: 132,
      height: 14,
      thickness: 2.2,
      color: 0x6f757d,
      roughness: 0.82,
      metalness: 0.03,
      emissive: 0x20252a,
      emissiveIntensity: 0.09
    },
    floatingArena: {
      enabled: true,
      radiusTop: 142,
      radiusBottom: 166,
      thickness: 30,
      topOffsetY: -0.9,
      rockColor: 0x4c535e,
      rockRoughness: 0.92,
      rockMetalness: 0.04,
      rockEmissive: 0x202933,
      rockEmissiveIntensity: 0.1,
      rimColor: 0x5f6772
    },
    centerBillboard: {
      enabled: true,
      width: 34,
      height: 11,
      centerY: 10.4,
      poleHeight: 10,
      position: [0, 0, 0],
      lines: ["OX QUIZ 10", "MAX 50 PLAYERS"]
    },
    chalk: {
      enabled: true,
      maxMarks: 2800,
      minDistance: 0.17,
      markSizeMin: 0.14,
      markSizeMax: 0.22,
      markHeight: 0.032,
      markOpacity: 0.82,
      colors: ["#f5f7ff", "#ffd86a", "#7ec9ff", "#ff9cc5", "#a9f89f"]
    },
    ocean: {
      enabled: false,
      width: 58,
      depth: 168,
      shorelineX: -28,
      shoreDirection: -1,
      positionX: 0,
      positionY: 0.06,
      positionZ: -52,
      normalTextureUrl: "/assets/graphics/world/textures/oss-water/waternormals.jpg",
      normalRepeatX: 20,
      normalRepeatY: 20,
      color: 0x2f8ed9,
      sunColor: 0xffffff,
      opacity: 1,
      distortionScale: 1.5,
      timeScale: -0.33,
      bobAmplitude: 0,
      bobFrequency: 0.35
    },
    beach: {
      enabled: false,
      textureUrl: "/assets/graphics/world/textures/cc0-sand/sand_color.jpg",
      normalTextureUrl: "/assets/graphics/world/textures/cc0-sand/sand_normal_gl.jpg",
      roughnessTextureUrl: "/assets/graphics/world/textures/cc0-sand/sand_roughness.jpg",
      aoTextureUrl: "/assets/graphics/world/textures/cc0-sand/sand_ao.jpg",
      shorelineX: -28,
      shoreDirection: -1,
      positionX: 0,
      width: 120,
      depth: 168,
      positionY: 0.082,
      positionZ: -52,
      repeatX: 10,
      repeatY: 44,
      color: 0xd9c08a,
      roughness: 0.93,
      metalness: 0,
      normalScale: [0.65, 0.65],
      aoIntensity: 0.32,
      foamWidth: 72,
      foamOpacity: 0.46,
      foamColor: 0xe8f7ff,
      wetBandWidth: 120,
      wetBandOpacity: 0.22,
      wetBandColor: 0xc8a16a
    },
    originMarker: {
      radiusTop: 0.4,
      radiusBottom: 0.4,
      height: 1.6,
      radialSegments: 14,
      position: [0, 0.8, -5],
      material: {
        color: 0x5e6f83,
        roughness: 0.32,
        metalness: 0.1,
        emissive: 0x2a3a52,
        emissiveIntensity: 0.2
      }
    },
    hubFlow: {
      enabled: true,
      introSeconds: 4.8,
      bridge: {
        approachSpawn: [0, GAME_CONSTANTS.PLAYER_HEIGHT, -98],
        spawn: [0, GAME_CONSTANTS.PLAYER_HEIGHT, -86],
        npcPosition: [0, 0, -82],
        npcTriggerRadius: 5,
        mirrorPosition: [0, 1.72, -76],
        mirrorLookSeconds: 1.5,
        cityEntry: [0, GAME_CONSTANTS.PLAYER_HEIGHT, -18],
        boundaryRadius: 3.2,
        width: 10,
        deckColor: 0x4f5660,
        railColor: 0x8fa2b8
      },
      city: {
        spawn: [0, GAME_CONSTANTS.PLAYER_HEIGHT, -8]
      },
      portal: {
        position: [0, 0.08, 22],
        radius: 4.4,
        cooldownSeconds: 60,
        warningSeconds: 16,
        openSeconds: 24,
        targetUrl: ""
      }
    },
    postProcessing: {
      exposure: 0.58,
      bloom: {
        enabled: false,
        mobileEnabled: false,
        strength: 0.05,
        radius: 0.56,
        threshold: 0.96
      }
    }
  },
  hands: {
    skin: {
      color: 0xe4bda0,
      roughness: 0.46,
      metalness: 0.03,
      emissive: 0x6e5040,
      emissiveIntensity: 0.05
    },
    sleeve: {
      color: 0x4e6f8e,
      roughness: 0.62,
      metalness: 0.08,
      emissive: 0x1f3347,
      emissiveIntensity: 0.13
    },
    pose: {
      shoulderX: 0.24,
      shoulderY: -0.2,
      shoulderZ: -0.58,
      elbowY: -0.3,
      elbowZ: -0.45,
      handY: -0.4,
      handZ: -0.33,
      upperArmRoll: 0.42,
      forearmRoll: 0.22,
      bendX: 0.16
    },
    groupRotationX: -0.03,
    swayAmplitude: 0.012,
    swayFrequency: 0.0042
  },
  network: {
    syncInterval: GAME_CONSTANTS.REMOTE_SYNC_INTERVAL,
    remoteLerpSpeed: GAME_CONSTANTS.REMOTE_LERP_SPEED,
    staleTimeoutMs: GAME_CONSTANTS.REMOTE_STALE_TIMEOUT_MS
  }
};
