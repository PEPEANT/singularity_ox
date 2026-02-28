import { BASE_VOID_PACK } from "../src/game/content/packs/base-void/pack.js";
import { GAME_CONSTANTS } from "../src/game/config/gameConstants.js";

const errors = [];
const warnings = [];
const notes = [];

function error(message) {
  errors.push(message);
  console.log(`[error] ${message}`);
}

function warn(message) {
  warnings.push(message);
  console.log(`[warn] ${message}`);
}

function note(message) {
  notes.push(message);
  console.log(`[ok] ${message}`);
}

function numberOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function main() {
  const world = BASE_VOID_PACK?.world ?? {};
  const sky = world.sky ?? {};
  const post = world.postProcessing ?? {};
  const ocean = world.ocean ?? {};
  const beach = world.beach ?? {};

  const exposure = numberOr(post.exposure, 1);
  if (exposure > 0.9) {
    warn(`exposure is high (${exposure}). Sky may look overbright.`);
  } else {
    note(`exposure is in safe range (${exposure}).`);
  }

  const bgIntensity = numberOr(sky.textureBackgroundIntensity, 1);
  if (bgIntensity > 0.7) {
    warn(`sky texture background intensity is high (${bgIntensity}).`);
  } else {
    note(`sky background intensity is in safe range (${bgIntensity}).`);
  }

  if (ocean.enabled) {
    const shorelineX = Number(ocean.shorelineX);
    if (!Number.isFinite(shorelineX)) {
      error("ocean.shorelineX must be a finite number.");
    } else if (Math.abs(shorelineX) > GAME_CONSTANTS.WORLD_LIMIT * 0.95) {
      warn(`ocean shorelineX (${shorelineX}) is near world bounds.`);
    } else {
      note(`ocean shorelineX looks valid (${shorelineX}).`);
    }

    const oceanWidth = numberOr(ocean.width, 0);
    if (oceanWidth < 300) {
      warn(`ocean width is very small (${oceanWidth}).`);
    } else {
      note(`ocean width looks valid (${oceanWidth}).`);
    }

    const oceanY = numberOr(ocean.positionY, 0);
    if (oceanY < 0) {
      warn(`ocean.positionY is below ground (${oceanY}). Water can be hidden by ground.`);
    } else {
      note(`ocean height is visible (${oceanY}).`);
    }
  } else {
    warn("ocean is disabled.");
  }

  if (beach.enabled) {
    const beachWidth = numberOr(beach.width, 0);
    if (beachWidth < 80) {
      warn(`beach width is small (${beachWidth}). It may be hard to see.`);
    } else {
      note(`beach width looks valid (${beachWidth}).`);
    }

    const beachY = numberOr(beach.positionY, 0);
    const oceanY = numberOr(ocean.positionY, 0);
    if (beachY <= oceanY) {
      warn(`beach.positionY (${beachY}) <= ocean.positionY (${oceanY}). Beach may sink under water.`);
    } else {
      note(`beach height is above ocean (${beachY} > ${oceanY}).`);
    }

    const beachShore = numberOr(beach.shorelineX, Number.NaN);
    const oceanShore = numberOr(ocean.shorelineX, Number.NaN);
    if (Number.isFinite(beachShore) && Number.isFinite(oceanShore)) {
      const delta = Math.abs(beachShore - oceanShore);
      if (delta > 40) {
        warn(`beach/ocean shoreline mismatch is large (${delta}).`);
      } else {
        note(`beach/ocean shoreline alignment is good (delta ${delta}).`);
      }
    }
  } else {
    warn("beach is disabled.");
  }

  console.log("");
  console.log(
    `world-audit summary: ${errors.length} error(s), ${warnings.length} warning(s), ${notes.length} ok check(s)`
  );
  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
