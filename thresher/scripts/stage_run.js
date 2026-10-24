// Gatehouse Stored Script: stage_run
// Stages run files and metadata into /home/toxic/estate/runs/<run_id>/
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const defaultRunId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

const runId = input?.run_id ?? defaultRunId;
const targetDir = `/home/toxic/estate/runs/${runId}`;

// 1. Ensure run directory exists
const dirRes = call_tool("desktop-commander", "create_directory", { path: targetDir });

// 2. Move or copy files into the run directory
const files = input?.source_files ?? [];
const stagedFiles = [];

for (const item of files) {
  const src = typeof item === "string" ? item : item.source;
  const fileName = typeof item === "string" ? src.split("/").pop() : (item.name ?? src.split("/").pop());
  const dest = `${targetDir}/${fileName}`;

  const op = input?.action === "copy" ? `cp -r "${src}" "${dest}"` : `mv "${src}" "${dest}"`;
  const moveRes = call_tool("desktop-commander", "start_process", { command: op, timeout_ms: 10000 });
  stagedFiles.push({ name: fileName, source: src, destination: dest, ok: moveRes.ok });
}

// 3. Write manifest.json
const manifest = {
  run_id: runId,
  staged_at: now.toISOString(),
  target_dir: targetDir,
  metadata: input?.metadata ?? {},
  staged_files: stagedFiles,
  sync_target: "dropbox:estate-scripts/runs",
  sync_policy: "autonomous_host_runner"
};

const manifestRes = call_tool("desktop-commander", "write_file", {
  path: `${targetDir}/manifest.json`,
  content: JSON.stringify(manifest, null, 2),
  mode: "rewrite",
  origin: "llm"
});

({
  ok: true,
  run_id: runId,
  run_dir: targetDir,
  manifest_created: manifestRes.ok,
  staged_count: stagedFiles.length,
  manifest
});
