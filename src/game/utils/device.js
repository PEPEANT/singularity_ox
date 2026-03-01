export function isLikelyTouchDevice() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const matches = (query) => window.matchMedia?.(query)?.matches ?? false;
  const coarse = matches("(pointer: coarse)");
  const anyCoarse = matches("(any-pointer: coarse)");
  const anyFine = matches("(any-pointer: fine)");
  const hoverNone = matches("(hover: none)");
  const anyHover = matches("(any-hover: hover)");
  const touchPoints = Number(navigator.maxTouchPoints ?? 0);
  const ua = String(navigator.userAgent ?? "").toLowerCase();
  const uaMobile =
    ua.includes("android") ||
    ua.includes("iphone") ||
    ua.includes("ipad") ||
    ua.includes("ipod") ||
    ua.includes("windows phone") ||
    ua.includes("mobile");

  if (uaMobile) {
    return true;
  }

  // Hybrid laptops often expose touch points even when a mouse is active.
  if (anyFine && anyHover) {
    return false;
  }

  if (coarse) {
    return true;
  }

  if (anyCoarse && !anyFine && touchPoints > 0) {
    return true;
  }

  return touchPoints > 0 && hoverNone;
}
