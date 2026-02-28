import "./styles/main.css";
import { createGame } from "./game/index.js";

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

function showBootError(message) {
  const root = document.createElement("div");
  root.id = "boot-error";
  root.textContent = message;
  document.body.appendChild(root);
}

function boot() {
  if (!supportsWebGL()) {
    showBootError("이 브라우저에서는 WebGL을 사용할 수 없습니다.");
    return;
  }

  const mount = document.getElementById("app");
  if (!mount) {
    showBootError("#app 마운트 요소를 찾을 수 없습니다.");
    return;
  }

  try {
    const game = createGame(mount, { contentPackId: "base-void" });
    game.init();
    window.__emptinesGame = game;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    showBootError(`시작에 실패했습니다: ${detail}`);
    console.error(error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
