// Gatehouse Stored Script: list_runs
// Lists recent runs in /home/toxic/estate/runs/
const limit = input?.limit ?? 10;
const listRes = call_tool("desktop-commander", "start_process", {
  command: `ls -1dt /home/toxic/estate/runs/*/ 2>/dev/null | head -n ${limit}`,
  timeout_ms: 5000
});

const runs = [];
if (listRes.ok && listRes.result?.stdout) {
  const lines = listRes.result.stdout.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const clean = line.trim().replace(/\/$/, "");
    const runId = clean.split("/").pop();
    runs.push({ run_id: runId, path: clean });
  }
}

({
  ok: true,
  total_listed: runs.length,
  runs
});
