import { COMPLETIONS_URL } from "./constants.js";

export async function analyzeWithCompletions(prompt: string): Promise<string> {
  const response = await fetch(COMPLETIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nvidia/nemotron-4-340b-instruct",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });
  if (!response.ok) throw new Error(`Completions API error: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}
