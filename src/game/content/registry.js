import { BASE_VOID_PACK as BASE_VOID_PACK_SOURCE } from "./packs/base-void/pack.js";
import { normalizeContentPack, validateContentPackShape } from "./schema.js";

function assertPackShape(pack, label = "Content pack", options = {}) {
  const errors = validateContentPackShape(pack, options);
  if (errors.length > 0) {
    throw new Error(`${label} is invalid: ${errors.join("; ")}`);
  }
}

assertPackShape(BASE_VOID_PACK_SOURCE, "Base content pack", { requireSections: true });
const BASE_VOID_PACK = normalizeContentPack(BASE_VOID_PACK_SOURCE, BASE_VOID_PACK_SOURCE);
const contentPackRegistry = new Map([[BASE_VOID_PACK.id, BASE_VOID_PACK]]);

export function registerContentPack(pack) {
  assertPackShape(pack);
  const next = normalizeContentPack(pack, BASE_VOID_PACK);
  contentPackRegistry.set(next.id, next);
  return next;
}

export function getContentPack(id = BASE_VOID_PACK.id) {
  const key = String(id ?? BASE_VOID_PACK.id).trim();
  return contentPackRegistry.get(key) ?? BASE_VOID_PACK;
}

export function listContentPacks() {
  return Array.from(contentPackRegistry.values());
}

export { BASE_VOID_PACK };
