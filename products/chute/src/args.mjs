export function parseArgs(argv, env = process.env) {
  let port = parseInt(env.CHUTE_PORT || env.ACP_BRIDGE_PORT || "25111", 10);
  let cmdStart = -1;
  let check = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      const p = parseInt(argv[i + 1], 10);
      if (!Number.isFinite(p) || p < 0 || p > 65535) {
        return { port, cmd: [], check, valid: false, error: "invalid --port" };
      }
      port = p;
      i++;
    } else if (argv[i] === "--check") {
      check = true;
    } else if (argv[i] === "--") {
      cmdStart = i + 1;
      break;
    }
  }

  const cmd = cmdStart > 0 ? argv.slice(cmdStart) : [];
  const valid = check || cmd.length > 0;
  return { port, cmd, check, valid };
}
