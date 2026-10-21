import { bodyLimit } from "hono/body-limit";

/**
 * The largest request body any route accepts. The biggest real one is 4 sentiment texts of 4000 characters: about 96 KB
 * when a client escapes non-ASCII text as \uXXXX (Python's json.dumps does). Routes keep their own, tighter limits on top.
 */
export const MAX_REQUEST_BYTES = 128 * 1024;

/** Refuses bigger bodies before any handler reads them, with or without a Content-Length. */
export const requestSizeLimit = () =>
  bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: (c) => c.json({ error: `request too large (max ${MAX_REQUEST_BYTES / 1024} KB)` }, 413) });
