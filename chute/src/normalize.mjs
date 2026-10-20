export function normalizeServer(s) {
  if (!s || typeof s !== "object") {
    return { type: "stdio", name: "", command: "", args: [], env: [] };
  }
  if (typeof s.url === "string" && s.url.length > 0) {
    const out = {
      type: typeof s.type === "string" ? s.type : "http",
      name: typeof s.name === "string" ? s.name : "",
      url: s.url,
    };
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) {
      out.headers = s.headers;
    }
    return out;
  }
  return {
    type: typeof s.type === "string" ? s.type : "stdio",
    name: typeof s.name === "string" ? s.name : "",
    command: typeof s.command === "string" ? s.command : "",
    args: Array.isArray(s.args) ? s.args : [],
    env: Array.isArray(s.env) ? s.env : [],
  };
}

export function normalizeMcpServers(m) {
  if (m === undefined || m === null) return [];
  if (Array.isArray(m)) return m.map(normalizeServer);
  if (typeof m === "object") {
    return Object.entries(m).map(([name, cfg]) =>
      normalizeServer({ ...(cfg || {}), name })
    );
  }
  return [];
}

export function rewriteFrame(msg) {
  if (!msg || typeof msg !== "object") return msg;
  if ((msg.method === "session/new" || msg.method === "session/load") && msg.params) {
    msg.params.mcpServers = normalizeMcpServers(msg.params.mcpServers);
  }
  return msg;
}

export function rewriteLine(line) {
  if (!line.trim()) return line;
  try {
    return JSON.stringify(rewriteFrame(JSON.parse(line)));
  } catch {
    return line;
  }
}
