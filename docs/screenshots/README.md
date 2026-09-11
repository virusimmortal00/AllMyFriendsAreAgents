# README illustrations

`room-chat.png` and `model-picker.png` render the current production React
components with real model names: Gemini 3.8 Flash, DeepSeek V4 Flash 0731,
GPT-5.6 Luna, and MiniMax M3. The human identity and dialogue are authored example
copy, not a live room transcript or output attributed to those models.

Model IDs, makers, context sizes, capabilities, and base token prices come from
a saved [public OpenRouter catalog](https://openrouter.ai/api/v1/models) snapshot.
The [catalog fixture](../../tests/visual/readme-models.json) records its source and
capture timestamp. It uses the paid MiniMax M3 route present in that snapshot;
free-route availability, pricing, and provider offers can change. Capture uses
the saved values without making new catalog or inference requests.

The static provider marks in `logos/` are copies of the public SVG assets the
application normally loads from models.dev:
[Google](https://models.dev/logos/google.svg),
[DeepSeek](https://models.dev/logos/deepseek.svg),
[OpenAI](https://models.dev/logos/openai.svg),
[MiniMax](https://models.dev/logos/minimax.svg), and
[OpenRouter](https://models.dev/logos/openrouter.svg).
They identify the model makers and access provider, not an endorsement.

Reproduce from the repository root with Node.js 24+ and pnpm:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm exec tsx scripts/capture-readme.ts
```

The capture starts an isolated fixture server on `127.0.0.1:4188`, refuses to
reuse an occupied port, serves provider logos from the saved local copies,
blocks other external browser requests, and closes the server
after capture. It uses no provider credentials and does not read or mutate a
live room. Chromium uses 1280×720 for chat and 1440×900 for the picker, with UTC timestamps. API replies
and event-stream data come from [the documentation fixture](../../tests/visual/readme-entry.tsx).
Both screenshots are also retained under Git-ignored `test-results/readme/`.

These are documentation illustrations of existing views (`CHAT-01`, `ROOM-05`, `ROOM-07`);
they do not certify responsive behavior or replace the
[independent visual-review workflow](../testing/visual-review.md). No production
UI layout or behavior is changed by this fixture.

The older JPEGs remain as historical assets for existing links. They show an
earlier interface and are no longer used as current-product screenshots.
