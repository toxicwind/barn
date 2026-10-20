// Gatehouse stored script probe
const name = input?.name ?? "world";
({ status: "ok", message: `Hello from Gatehouse stored script, ${name}!`, timestamp: Date.now() });
