function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }
  if (isPlainObject(value)) {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = deepClone(item);
    }
    return next;
  }
  return value;
}

function deepMerge(baseValue, overrideValue) {
  if (typeof overrideValue === "undefined") {
    return deepClone(baseValue);
  }
  if (Array.isArray(overrideValue)) {
    return deepClone(overrideValue);
  }
  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    const next = {};
    const keys = new Set([...Object.keys(baseValue), ...Object.keys(overrideValue)]);
    for (const key of keys) {
      next[key] = deepMerge(baseValue[key], overrideValue[key]);
    }
    return next;
  }
  return deepClone(overrideValue);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function validateContentPackShape(pack, options = {}) {
  const errors = [];
  const requireSections = Boolean(options.requireSections);
  if (!pack || typeof pack !== "object") {
    return ["pack must be an object"];
  }
  const id = String(pack.id ?? "").trim();
  if (!id) {
    errors.push("id is required");
  }
  if (requireSections && !isPlainObject(pack.world)) {
    errors.push("world object is required");
  }
  if (requireSections && !isPlainObject(pack.hands)) {
    errors.push("hands object is required");
  }
  if (requireSections && !isPlainObject(pack.network)) {
    errors.push("network object is required");
  }
  if ("world" in pack && !isPlainObject(pack.world)) {
    errors.push("world must be an object when provided");
  }
  if ("hands" in pack && !isPlainObject(pack.hands)) {
    errors.push("hands must be an object when provided");
  }
  if ("network" in pack && !isPlainObject(pack.network)) {
    errors.push("network must be an object when provided");
  }
  return errors;
}

export function normalizeContentPack(pack, fallbackPack) {
  const merged = deepMerge(fallbackPack, pack);
  merged.id = String(pack?.id ?? merged.id ?? "").trim();
  merged.name = String(pack?.name ?? merged.name ?? merged.id).trim() || merged.id;
  return deepFreeze(merged);
}
