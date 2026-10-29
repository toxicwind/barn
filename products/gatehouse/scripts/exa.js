// Exa web search helper for doorbell code_execution.
// Input: { query: string, numResults?: number, type?: "auto"|"news"|"pdf"|"github" }
// Returns: array of { title, url, published, author, highlights }
(() => {
  const q = input.query;
  if (!q) throw new Error("input.query is required");
  const res = call_tool("exa", "web_search_exa", {
    query: q,
    numResults: input.numResults || 8,
    ...(input.type ? { type: input.type } : {})
  });
  if (!res.ok) throw new Error((res.error && res.error.message) || "exa call failed");
  const text = res.result.content.map(c => c.text || "").join("\n");
  const out = [];
  const re = /Title: (.*?)\nURL: (.*?)(?:\nPublished: (.*?))?(?:\nAuthor: (.*?))?\nHighlights:\n([\s\S]*?)(?=\n\nTitle: |$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ title: m[1], url: m[2], published: m[3] || "N/A", author: m[4] || "N/A", highlights: m[5].trim().slice(0, 1500) });
  }
  if (out.length === 0) return text.slice(0, 6000);
  return out;
})()
