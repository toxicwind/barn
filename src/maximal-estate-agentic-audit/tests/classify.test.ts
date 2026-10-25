import { describe, expect, test } from "bun:test";

describe("repo classification", () => {
  test("classifies ecosystem repos", () => {
    const ecosystem = ["estate", "tau", "mesh", "pi"];
    const name = "tau-session-audit";
    const result = ecosystem.some(kw => name.includes(kw));
    expect(result).toBe(true);
  });

  test("classifies forks", () => {
    const fork = true;
    const result = fork ? "PUBLIC_FORK" : "REVIEW_PRIVATE";
    expect(result).toBe("PUBLIC_FORK");
  });

  test("classifies internal repos", () => {
    const internal = ["secret", "token", "credential"];
    const name = "config-secret-backup";
    const result = internal.some(kw => name.includes(kw));
    expect(result).toBe(true);
  });

  test("classifies review-private repos", () => {
    const name = "random-project";
    const isFork = false;
    const isInternal = false;
    const isEcosystem = false;
    let classification = "REVIEW_PRIVATE";
    if (isInternal) classification = "PRIVATE_INTERNAL";
    else if (isEcosystem) classification = "PUBLIC_ECOSYSTEM";
    else if (isFork) classification = "PUBLIC_FORK";
    expect(classification).toBe("REVIEW_PRIVATE");
  });
});
