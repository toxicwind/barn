# Gemini API inventory — consolidated union, 2026-09-14

57 models across the 5-key pool (56 shared + 1 EAP-exclusive:
`models/gemini-flash-tool-retrieval`, key #2 only). Methods are
`supportedGenerationMethods` from `GET /v1beta/models`.

## Chat / generation (generateContent + countTokens)

- models/gemini-2.5-flash (+ createCachedContent, batchGenerateContent)
- models/gemini-2.5-flash-lite (+ createCachedContent, batchGenerateContent)
- models/gemini-2.5-pro (+ createCachedContent, batchGenerateContent)
- models/gemini-3-flash-preview (+ createCachedContent, batchGenerateContent)
- models/gemini-3.1-flash-lite (+ createCachedContent, batchGenerateContent)
- models/gemini-3.1-flash-lite-preview (+ createCachedContent, batchGenerateContent)
- models/gemini-3.1-pro-preview (+ createCachedContent, batchGenerateContent)
- models/gemini-3.1-pro-preview-customtools (+ createCachedContent, batchGenerateContent)
- models/gemini-3.5-flash (+ createCachedContent, batchGenerateContent)
- models/gemini-3.5-flash-lite (+ createCachedContent, batchGenerateContent)
- models/gemini-3.6-flash (+ createCachedContent, batchGenerateContent)
- models/gemini-3.7-flash (+ createCachedContent, batchGenerateContent)
- models/gemini-3.8-flash (+ createCachedContent, batchGenerateContent)
- models/gemini-flash-latest (+ createCachedContent, batchGenerateContent)
- models/gemini-flash-lite-latest (+ createCachedContent, batchGenerateContent)
- models/gemini-pro-latest (+ createCachedContent, batchGenerateContent)
- models/gemini-flash-tool-retrieval (+ batchGenerateContent) **[EAP key #2 only]**
- models/gemma-4-26b-a4b-it
- models/gemma-4-31b-it
- models/gemini-omni-1.1-flash
- models/gemini-omni-flash-preview

## Image generation

- models/gemini-2.5-flash-image (+ batchGenerateContent)
- models/gemini-3-pro-image (+ batchGenerateContent)
- models/gemini-3-pro-image-preview (+ batchGenerateContent)
- models/gemini-3.1-flash-image (+ batchGenerateContent)
- models/gemini-3.1-flash-image-preview (+ batchGenerateContent)
- models/gemini-3.1-flash-lite-image (+ batchGenerateContent)
- models/nano-banana-pro-preview (+ batchGenerateContent)

## Video generation (predictLongRunning)

- models/veo-3.1-generate-preview
- models/veo-3.1-fast-generate-preview
- models/veo-3.1-lite-generate-preview

## Audio / TTS / live (bidiGenerateContent or generateContent)

- models/gemini-2.5-flash-native-audio-latest (countTokens, bidiGenerateContent)
- models/gemini-2.5-flash-native-audio-preview-09-2025 (countTokens, bidiGenerateContent)
- models/gemini-2.5-flash-native-audio-preview-12-2025 (countTokens, bidiGenerateContent)
- models/gemini-2.5-flash-preview-tts (countTokens, generateContent)
- models/gemini-2.5-pro-preview-tts (countTokens, generateContent, batchGenerateContent)
- models/gemini-3.1-flash-tts-preview (generateContent, countTokens, batchGenerateContent)
- models/gemini-3.1-flash-live-preview (bidiGenerateContent)
- models/gemini-3.5-live-translate-preview (bidiGenerateContent)
- models/gemini-3.5-transcribe (generateContent, countTokens)
- models/gemini-3.5-transcribe-live (bidiGenerateContent)

## Music

- models/lyria-3-clip-preview (generateContent, countTokens)
- models/lyria-3-pro-preview (generateContent, countTokens)
- models/lyria-3.5 (generateContent, countTokens)
- models/lyria-realtime-exp (bidiGenerateMusic)

## Embeddings

- models/gemini-embedding-001 (embedContent, countTextTokens, countTokens, asyncBatchEmbedContent)
- models/gemini-embedding-2 (embedContent, countTextTokens, countTokens, asyncBatchEmbedContent)
- models/gemini-embedding-2-preview (embedContent, countTextTokens, countTokens, asyncBatchEmbedContent)

## Research / agents / misc

- models/deep-research-preview-04-2026 (generateContent, countTokens)
- models/deep-research-max-preview-04-2026 (generateContent, countTokens)
- models/deep-research-pro-preview-12-2025 (generateContent, countTokens)
- models/gemini-2.5-computer-use-preview-10-2025 (generateContent, countTokens)
- models/gemini-robotics-er-2-preview (generateContent, countTokens, createCachedContent, batchGenerateContent)
- models/gemini-robotics-er-2-streaming-preview (bidiGenerateContent)
- models/antigravity-preview-05-2026 (generateContent, countTokens)
- models/antigravity-preview-09-2026 (generateContent, countTokens)
- models/aqa (generateAnswer)

## Endpoints exercised by gemini-mcp

- `GET /v1beta/models` — list_models
- `POST /v1beta/{model}:generateContent` — generate_content
- `POST /v1beta/{model}:countTokens` — count_tokens
