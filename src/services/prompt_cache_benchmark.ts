const BASE_URL = process.env.LLM_BASE_URL || "http://127.0.0.1:28080/v1";
const url = `${BASE_URL}/chat/completions`;
const targetModel = process.env.MODEL_ID || "beellama/qwen-flash";

const baseText = "The quick brown fox jumps over the lazy dog. ".repeat(100);
const longContext = baseText.repeat(4);
const prompt = `System: Analyze the following text carefully.\n\n${longContext}\n\nUser: Summarize the main theme of the fox story in one sentence.`;

console.log("=== PROMPT CACHE BENCHMARK ===");
console.log(`Endpoint: ${url}`);
console.log(`Model: ${targetModel}`);
console.log(`Payload Size: ${prompt.length} characters (~4000 tokens)`);

console.log("\n--- Turn 1: Sending prompt (Uncached) ---");
const t0 = performance.now();
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: targetModel,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 50,
  }),
});
const t1 = performance.now();

if (res.ok) {
  const data: any = await res.json();
  const completionTokens = data.usage?.completion_tokens || 0;
  const promptTokens = data.usage?.prompt_tokens || 0;
  const promptMs = data.timings?.prompt_ms || t1 - t0;

  console.log(`Status: OK`);
  console.log(`Total Time: ${((t1 - t0) / 1000).toFixed(3)} seconds`);
  console.log(`Tokens: Prompt=${promptTokens}, Completion=${completionTokens}`);
  console.log(
    `Server-reported Prompt Eval: ${(promptMs / 1000).toFixed(3)} seconds`,
  );
  console.log(`Content: ${data.choices?.[0]?.message?.content}`);
} else {
  console.log(`Error: ${res.status} - ${await res.text()}`);
}
