function setText(el, value) {
  if (!el) {
    return;
  }
  const nextValue = String(value);
  if (el.textContent !== nextValue) {
    el.textContent = nextValue;
  }
}

export class HUD {
  constructor() {
    this.statusEl = document.getElementById("hud-status");
    this.playersEl = document.getElementById("hud-players");
    this.positionEl = document.getElementById("hud-position");
    this.fpsEl = document.getElementById("hud-fps");
    this.enabled = Boolean(this.statusEl || this.playersEl || this.positionEl || this.fpsEl);

    this.cache = {
      status: "",
      players: "",
      position: "",
      fps: ""
    };
  }

  setStatus(status) {
    if (!this.enabled) {
      return;
    }
    const next = String(status ?? "오프라인");
    if (this.cache.status !== next) {
      this.cache.status = next;
      setText(this.statusEl, next);
    }
  }

  setPlayers(count) {
    if (!this.enabled) {
      return;
    }
    const next = String(count ?? 0);
    if (this.cache.players !== next) {
      this.cache.players = next;
      setText(this.playersEl, next);
    }
  }

  setPosition(x, z) {
    if (!this.enabled) {
      return;
    }
    const next = `${Math.round(x ?? 0)}, ${Math.round(z ?? 0)}`;
    if (this.cache.position !== next) {
      this.cache.position = next;
      setText(this.positionEl, next);
    }
  }

  setFps(fps) {
    if (!this.enabled) {
      return;
    }
    const next = String(Math.max(0, Math.round(fps ?? 0)));
    if (this.cache.fps !== next) {
      this.cache.fps = next;
      setText(this.fpsEl, next);
    }
  }

  update(state = {}) {
    if (!this.enabled) {
      return;
    }
    this.setStatus(state.status ?? "오프라인");
    this.setPlayers(state.players ?? 0);
    this.setPosition(state.x ?? 0, state.z ?? 0);
    this.setFps(state.fps ?? 0);
  }
}
