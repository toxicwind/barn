import { OpenFangClient } from "../../lib/openfang_api";

const OPENFANG_URL = process.env.OPENFANG_URL || "http://127.0.0.1:25103";
const client = new OpenFangClient(OPENFANG_URL, process.env.OPENFANG_API_KEY);

export async function handleMessage(
  message: string,
  agent = "coyote",
): Promise<string> {
  try {
    return await client.chat(agent, message);
  } catch (err) {
    console.error(`[OpenFang Plugin] Error: ${err}`);
    return `[OpenFang Error: ${err}]`;
  }
}

if (import.meta.main) {
  console.log(`[OpenFang Plugin] Initialized. URL: ${OPENFANG_URL}`);
}
