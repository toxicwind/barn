/**
 * Lens: Tectonic - Repository health and drift detection
 * @version 2.0.0
 */
module.exports = {
  name: "tectonic",
  description: "Repository health scoring and drift detection",
  analyze(_data, meta = {}) {
    const now = new Date();
    const lastPush = meta.lastPush ? new Date(meta.lastPush) : now;
    const daysSincePush = Math.floor((now - lastPush) / (1000 * 60 * 60 * 24));
    const healthScore = Math.max(0, 100 - daysSincePush * 2);
    const ciThreshold = meta.ciMode ? 50 : 70;
    return {
      lens: "tectonic",
      healthScore,
      driftCount: daysSincePush,
      ciThreshold,
      staleRepos: daysSincePush > 30 ? [meta.repo || "unknown"] : [],
      confidence: 0.75,
      source: meta.path || "unknown",
    };
  },
};
