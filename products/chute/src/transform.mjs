import { Transform } from "stream";
import { rewriteLine } from "./normalize.mjs";

export function createNormalizer() {
  let pending = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = pending + chunk.toString("utf-8");
      const lines = text.split("\n");
      pending = lines.pop() ?? "";
      const out = lines.map(rewriteLine).join("\n");
      cb(null, out.length ? out + "\n" : "");
    },
    flush(cb) {
      if (pending.length) cb(null, rewriteLine(pending));
      else cb();
    },
  });
}
