export function log(tag, msg) {
  const t = new Date().toISOString();
  const prefix = tag ? `[chute:${tag}]` : "[chute]";
  process.stderr.write(`${t} ${prefix} ${msg}\n`);
}
