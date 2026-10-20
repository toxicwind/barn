// Gatehouse Stored Script: view_run
// Inspects a run directory in /home/toxic/estate/runs/
let runId = input?.run_id;

if (!runId) {
  const listRes = call_tool("desktop-commander", "start_process", {
    command: 'ls -1dt /home/toxic/estate/runs/*/ 2>/dev/null | head -n 1',
    timeout_ms: 5000
  });
  if (listRes.ok && listRes.result?.stdout) {
    const latestPath = listRes.result.stdout.trim().replace(/\/$/, "");
    runId = latestPath.split("/").pop();
  }
}

if (!runId) {
  ({ ok: false, error: "No runs found in /home/toxic/estate/runs" });
}

const runDir = `/home/toxic/estate/runs/${runId}`;
const manifestPath = `${runDir}/manifest.json`;

const manifestRead = call_tool("desktop-commander", "read_file", { path: manifestPath });
let manifestData = null;
if (manifestRead.ok && manifestRead.result) {
  try {
    manifestData = JSON.parse(manifestRead.result);
  } catch (e) {
    manifestData = manifestRead.result;
  }
}

const dirRes = call_tool("desktop-commander", "list_directory", { path: runDir, depth: 1, origin: "llm" });

({
  ok: true,
  run_id: runId,
  run_dir: runDir,
  manifest: manifestData,
  directory_contents: dirRes.ok ? dirRes.result : null
});
