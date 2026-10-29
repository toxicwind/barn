# Gemini API key audit — 2026-09-14

Source: `/home/toxic/googleapi.txt` (5 entries). Probed via
`GET /v1beta/models?pageSize=100` per key. Key VALUES are never recorded
here or anywhere in this repo — fingerprints are first-4/last-4 only.

| # | Name (googleapi.txt) | Project | EAP | Fingerprint | Status | Models |
|---|---|---|---|---|---|---|
| 1 | Gemini API Key 2 | projects/269278422746 | no | AQ.A...1uzA | OK (HTTP 200) | 56 |
| 2 | Gemini API Key 5 | projects/654595778272 | **YES** | AQ.A...3ntQ | OK (HTTP 200) | **57** |
| 3 | Gemini API Key | projects/991309044265 | no | AQ.A...IJkw | OK (HTTP 200) | 56 |
| 4 | Gemini API Key | projects/55739192275 | no | AQ.A...YVMw | OK (HTTP 200) | 56 |
| 5 | Gemini API Key | projects/989227872366 | no | AQ.A...IMfw | OK (HTTP 200) | 56 |

## EAP audit

Key #2 (`Gemini API Key 5`, projects/654595778272) is labeled EAP in
googleapi.txt. Model-list diff vs the non-EAP keys shows exactly one
exclusive model: `models/gemini-flash-tool-retrieval`
(generateContent, countTokens, batchGenerateContent). All other 56
models are shared across all 5 keys.

## Notes

- All 5 keys valid and serving as of 2026-09-14 ~14:05 MDT.
- Keys at rest: `~/.secrets` (0600) as `GEMINI_API_KEY_1..5` (+ `_NAME`,
  `_PROJECT`, `_EAP` metadata). Never in this repo.
- Live re-audit anytime via the `keys_status` MCP tool.
