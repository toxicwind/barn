import net from "net";
import { spawn } from "child_process";
import { createNormalizer } from "./transform.mjs";
import { log } from "./log.mjs";

export function createChuteServer({ port, cmd }) {
  let seq = 0;

  const server = net.createServer((sock) => {
    const cid = ++seq;
    let child = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (child && !child.killed) {
        try { child.kill("SIGTERM"); } catch (e) {}
      }
      try { sock.destroy(); } catch (e) {}
    };

    try {
      child = spawn(cmd[0], cmd.slice(1), {
        stdio: ["pipe", "pipe", "inherit"],
        env: process.env,
      });
      child.on("error", (e) => { log("#" + cid, "spawn error: " + e.message); cleanup(); });
      child.on("close", () => { if (!closed) sock.end(); });
      sock.on("error", cleanup);
      sock.on("close", cleanup);
      sock.pipe(createNormalizer()).pipe(child.stdin);
      child.stdout.pipe(sock);
    } catch (e) {
      log("#" + cid, "exception: " + e.message);
      cleanup();
    }
  });

  server.on("error", (e) => {
    log("", "server error: " + e.message);
    process.exit(1);
  });

  return {
    server,
    listen() {
      server.listen(port, "127.0.0.1", () => {
        log("", `Listening 127.0.0.1:${server.address().port} -> ${cmd.join(" ")}`);
      });
    },
  };
}
