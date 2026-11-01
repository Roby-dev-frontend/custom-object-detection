// Identity for this browser, and the heartbeat that keeps it in the server's
// device list.
//
// The session cookie says WHO is logged in, but every device signs in as the
// same user, so it can never say WHICH. Sharing needs that distinction: without
// it a second page could start publishing over the first, and no page could
// tell whether the camera being shared was its own or someone else's.

const STORAGE_KEY = "camera-client-id";

/** A stable id for this browser. Kept in localStorage so a reload does not
 * appear as a new device and leave a ghost in the list until it times out. */
export function clientId() {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh =
      crypto.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Private browsing can make localStorage throw. A per-load id is worse
    // (the device reappears on every reload) but far better than crashing.
    return `c${Date.now()}${Math.random().toString(16).slice(2)}`;
  }
}

/** Something a person can recognise in the list, e.g. "Chrome su Android".
 * Derived from the user agent: rough, but it only has to tell one of your own
 * devices from another. */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const system =
    /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X/i.test(ua) ? "Mac"
    : /Linux/i.test(ua) ? "Linux"
    : "dispositivo";
  const browser =
    /Edg\//i.test(ua) ? "Edge"
    : /OPR\//i.test(ua) ? "Opera"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Safari\//i.test(ua) ? "Safari"
    : "browser";
  return `${browser} su ${system}`;
}
