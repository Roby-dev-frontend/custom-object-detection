// One place for the calls the administration page makes.
//
// Same conventions as App.jsx: a relative base, and credentials so the browser
// attaches the session cookie -- without that line fetch sends no cookies and
// every request comes back 401.
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const SEND_COOKIE = { credentials: "same-origin" };

/** Throws an Error carrying the server's own message, so a caller can put it
 *  straight in a toast instead of inventing a vaguer one. */
export async function call(method, path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    ...SEND_COOKIE,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // 204, or a body that is not JSON. Not an error by itself.
  }
  if (!response.ok) {
    const error = new Error(data?.detail || `Errore ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data ?? {};
}

export const get = (path) => call("GET", path);

/** The address of a path on the server, for a plain link (a download). */
export const url = (path) => `${API_BASE}${path}`;

/** Sends one file as the raw body of a PUT, reporting how much has gone.
 *
 *  fetch cannot say how far an upload has got, and a file of tens of megabytes
 *  over a phone's WiFi needs a bar, so this is XMLHttpRequest. Same contract as
 *  call(): resolves with the parsed answer, rejects with an Error carrying the
 *  server's own message and its status.
 *
 *  `onProgress(fraction)` is called while the bytes go; at 1 they are all with
 *  the server, which then spends a while checking them. */
export function upload(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", `${API_BASE}${path}`);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    request.onerror = () => reject(new Error("Impossibile contattare il server."));
    request.onload = () => {
      let data = null;
      try {
        data = JSON.parse(request.responseText);
      } catch {
        // Not JSON: reported by status below.
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(data ?? {});
        return;
      }
      const error = new Error(data?.detail || `Errore ${request.status}`);
      error.status = request.status;
      reject(error);
    };
    request.send(file);
  });
}
