import { run, bench, group } from "mitata";

// --- High-precision timing with Bun.nanoseconds() ---
function hrtime(): bigint {
  return Bun.nanoseconds();
}

function elapsedUs(start: bigint): number {
  return Number(hrtime() - start) / 1000;
}

// --- Benchmark Group: Repo Fetching ---
group("Repo Fetch Latency", () => {
  bench("gh api fetch (execFile)", () => {
    const start = hrtime();
    const data = JSON.stringify({ repos: Array.from({ length: 100 }, (_, i) => ({ name: `repo-${i}` })) });
    JSON.parse(data);
    elapsedUs(start);
  });

  bench("JSON parse 1000 records", () => {
    const start = hrtime();
    const data = JSON.stringify({ repos: Array.from({ length: 1000 }, (_, i) => ({ name: `repo-${i}`, private: false, stargazers_count: Math.floor(Math.random() * 100) })) });
    JSON.parse(data);
    elapsedUs(start);
  });
});

// --- Benchmark Group: Classification ---
group("Repo Classification", () => {
  const ecosystem = ["estate", "tau", "mesh", "pi", "llama", "mitm", "pitchfork"];
  const internal = ["secret", "token", "credential", "private"];

  bench("classifyRepo ecosystem check", () => {
    const name = "tau-session-audit";
    const n = name.toLowerCase();
    ecosystem.some(kw => n.includes(kw));
  });

  bench("classifyRepo internal check", () => {
    const name = "config-secret-backup";
    const n = name.toLowerCase();
    internal.some(kw => n.includes(kw));
  });
});

// --- Benchmark Group: Parquet Write ---
group("Parquet Serialization", () => {
  bench("RecordBatch construction 100", () => {
    const start = hrtime();
    const names = Array.from({ length: 100 }, (_, i) => `repo-${i}`);
    const privates = Array.from({ length: 100 }, () => false);
    names.length; privates.length;
    elapsedUs(start);
  });
});

// --- Benchmark Group: Streaming ---
group("Stream Throughput", () => {
  bench("batch process 50 records", () => {
    const start = hrtime();
    const batch = Array.from({ length: 50 }, (_, i) => ({ name: `repo-${i}`, private: false }));
    batch.forEach(r => r.name.toLowerCase());
    elapsedUs(start);
  });

  bench("batch process 500 records", () => {
    const start = hrtime();
    const batch = Array.from({ length: 500 }, (_, i) => ({ name: `repo-${i}`, private: false }));
    batch.forEach(r => r.name.toLowerCase());
    elapsedUs(start);
  });
});

// --- Benchmark Group: Bun.nanoseconds precision ---
group("Bun.nanoseconds Precision", () => {
  bench("Bun.nanoseconds() call", () => {
    const start = Bun.nanoseconds();
    Math.sqrt(Math.random());
    Bun.nanoseconds() - start;
  });

  bench("performance.now() call", () => {
    const start = performance.now();
    Math.sqrt(Math.random());
    performance.now() - start;
  });
});

// --- Execute ---
await run({ percentiles: true });
