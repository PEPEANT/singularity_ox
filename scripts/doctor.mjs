import { existsSync, readFileSync } from "node:fs";
import http from "node:http";

const failures = [];
const warnings = [];

function pass(message) {
  console.log(`[ok] ${message}`);
}

function fail(message) {
  failures.push(message);
  console.log(`[fail] ${message}`);
}

function warn(message) {
  warnings.push(message);
  console.log(`[warn] ${message}`);
}

function checkFile(path) {
  if (existsSync(path)) {
    pass(`found ${path}`);
    return;
  }
  fail(`missing ${path}`);
}

function checkIndexEntry() {
  const html = readFileSync("index.html", "utf8");
  const main = readFileSync("src/main.js", "utf8");

  if (!html.includes('<script type="module" src="/src/main.js"></script>')) {
    fail("index.html is missing module entry /src/main.js");
  } else {
    pass("index.html module entry is set to /src/main.js");
  }

  if (html.includes('href="/src/styles/main.css"')) {
    fail("index.html must not link /src/styles/main.css directly (use main.js import)");
  } else {
    pass("index.html does not directly link /src/styles/main.css");
  }

  if (!main.includes('import "./styles/main.css";')) {
    fail("src/main.js is missing CSS import ./styles/main.css");
  } else {
    pass("src/main.js imports ./styles/main.css");
  }
}

function pingLocalServer(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
      res.resume();
      resolve(ok);
    });

    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const nodeMajor = Number((process.versions.node ?? "0").split(".")[0]);
  if (Number.isNaN(nodeMajor) || nodeMajor < 18) {
    fail(`Node.js 18+ required (current ${process.versions.node})`);
  } else {
    pass(`Node.js ${process.versions.node}`);
  }

  checkFile("package.json");
  checkFile("scripts/world-audit.mjs");
  checkFile("vite.config.js");
  checkFile("server.js");
  checkFile("src/main.js");
  checkFile("src/styles/main.css");
  checkFile("src/game/index.js");
  checkFile("src/game/runtime/GameRuntime.js");
  checkFile("src/game/runtime/config/runtimeTuning.js");
  checkFile("src/game/ui/HUD.js");
  checkFile("src/game/config/gameConstants.js");
  checkFile("src/game/content/registry.js");
  checkFile("src/game/content/schema.js");
  checkFile("src/game/content/packs/README.md");
  checkFile("src/game/content/packs/baseVoidPack.js");
  checkFile("src/game/content/packs/base-void/pack.js");
  checkFile("src/game/content/packs/template/pack.template.js");
  checkFile("public/assets/graphics/ui/logo.svg");
  checkFile("public/assets/graphics/ui/oss-icons/tabler-pencil.svg");
  checkFile("public/assets/graphics/ui/oss-icons/SOURCE.txt");
  checkFile("public/assets/graphics/world/textures/ground.svg");
  checkFile("public/assets/graphics/world/textures/cc0-grass/grass_color.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-grass/grass_normal_gl.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-grass/grass_roughness.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-grass/grass_ao.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-sand/sand_color.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-sand/sand_normal_gl.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-sand/sand_roughness.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-sand/sand_ao.jpg");
  checkFile("public/assets/graphics/world/textures/cc0-sand/SOURCE.txt");
  checkFile("public/assets/graphics/world/textures/oss-water/waternormals.jpg");
  checkFile("public/assets/graphics/world/textures/oss-water/SOURCE.txt");
  checkFile("public/assets/graphics/world/textures/oss-chalk/disc.png");
  checkFile("public/assets/graphics/world/textures/oss-chalk/SOURCE.txt");
  checkFile("public/assets/graphics/world/sky/oss-sky/venice_sunset_1k.hdr");
  checkFile("public/assets/graphics/world/sky/oss-sky/SOURCE.txt");
  checkIndexEntry();

  const chatUp = await pingLocalServer("http://localhost:3001/health");
  if (chatUp) {
    pass("chat server is reachable on http://localhost:3001/health");
  } else {
    warn("chat server is not running on localhost:3001 (realtime sync will be offline)");
  }

  console.log("");
  console.log("Run sequence:");
  console.log("1) npm install");
  console.log("2) npm run dev:all");
  console.log("3) open http://localhost:5173");

  if (warnings.length > 0) {
    console.log("");
    console.log(`Warnings: ${warnings.length}`);
  }

  if (failures.length > 0) {
    console.log("");
    console.log(`Failures: ${failures.length}`);
    process.exit(1);
  }

  console.log("");
  console.log("Doctor check passed.");
}

main().catch((error) => {
  console.error("[doctor] failed");
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
