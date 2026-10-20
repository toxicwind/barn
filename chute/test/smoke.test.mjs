import { test, expect } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import net from "net";

const CHUTE = path.join(import.meta.dir, "..", "chute.mjs");

function waitExit(p, ms = 3000) {
  return new Promise((resolve) => {
    const kt = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} }, ms);
    p.on("exit", (code, sig) => { clearTimeout(kt); resolve({ code, sig }); });
  });
}

test("--check exits 0 with ready:true", async () => {
  const p = spawn(CHUTE, ["--check"]);
  let out = "";
  p.stdout.on("data", (d) => out += d);
  const { code } = await waitExit(p);
  expect(code).toBe(0);
  expect(JSON.parse(out.trim())).toMatchObject({ ready: true, check: true });
});

test("serves a real connection and spawns child", async () => {
  const port = 25000 + Math.floor(Math.random() * 1000);
  const p = spawn(CHUTE, ["--port", String(port), "--", "cat"]);
  await new Promise((r) => setTimeout(r, 400));
  const sock = net.connect(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  const frame = JSON.stringify({ method: "session/new", params: { mcpServers: { a: { command: "/a" } } } }) + "\n";
  sock.write(frame);
  const echoed = await new Promise((r) => {
    let buf = "";
    sock.on("data", (d) => { buf += d; if (buf.includes("\n")) r(buf); });
    setTimeout(() => r(buf), 1500);
  });
  sock.end();
  try { p.kill("SIGTERM"); } catch (e) {}
  await waitExit(p, 1500);
  const parsed = JSON.parse(echoed.trim());
  expect(Array.isArray(parsed.params.mcpServers)).toBe(true);
  expect(parsed.params.mcpServers[0].name).toBe("a");
});

test("no cmd and no --check exits 2 (EX_USAGE)", async () => {
  const p = spawn(CHUTE, []);
  const { code } = await waitExit(p);
  expect(code).toBe(2);
});
