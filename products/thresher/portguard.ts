/** bedf89a9: pre-start port ownership guard.
 * The 2026-09-17 EADDRINUSE crash came from a duplicate yote binding 25102
 * while a live instance held it. Never crash blind on EADDRINUSE again:
 * probe the port first; if occupied, identify the holder and refuse to
 * start a duplicate. Exit code 3 = "port refused" (distinct from crash=1). */
async function claimPort(port: number): Promise<void> {
  let occupied = false;
  try {
    await new Promise<void>((resolve, reject) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) { s.end(); resolve(); },
          close() { resolve(); },
          error(_s, _e) { reject(_e); },
          data() {},
        },
      });
    });
    occupied = true;
  } catch {
    occupied = false;
  }
  if (!occupied) return;
  let owner = "unknown listener";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const j = (await r.json().catch(() => null)) as any;
      owner =
        j && j.svc === "yote"
          ? `live yote instance (version=${j.version ?? "?"}, port=${j.port ?? "?"})`
          : `http responder (not yote)`;
    } else {
      owner = `http responder status=${r.status}`;
    }
  } catch {
    owner = "non-http listener";
  }
  log(
    `FATAL port-ownership: ${port} already held by ${owner} — refusing duplicate instance (bedf89a9 guard, exit 3)`
  );
  process.exit(3);
}

await claimPort(PORT);

const app = serve({
