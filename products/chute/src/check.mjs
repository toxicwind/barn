import net from "net";

export function runCheck() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on("error", (e) => resolve({ ready: false, error: e.message }));
    s.listen(0, "127.0.0.1", () => {
      const bound = s.address().port;
      s.close(() => resolve({ ready: true, bound, check: true }));
    });
  });
}
