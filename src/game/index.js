import { GameRuntime } from "./runtime/GameRuntime.js";
import { getContentPack, listContentPacks, registerContentPack } from "./content/registry.js";

export function createGame(mount, options = {}) {
  const contentPack = options.contentPack ?? getContentPack(options.contentPackId);
  return new GameRuntime(mount, {
    ...options,
    contentPack
  });
}

export { GameRuntime, getContentPack, listContentPacks, registerContentPack };