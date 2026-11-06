# Videos

Scripts that make two videos of Shared To-Do. Outputs go to `video/out/`, which git ignores.

- `record-app.ts` drives the real app in two browser profiles, Alice and Bob, against a running relay and web app, and records both screens. It writes `alice.webm`, `bob.webm` and `markers.json` (when each step happened).
- `explainer-dev.html` (2:35) is for ToIP developers. It covers the mapping onto the four layers, the list as a small VTC, the Trust Task types and the registry specs they're shaped after, the path one change takes, each device's checks and Rego, convergence, private items, the real footage with technical captions, and open questions.
- `explainer.html` (1:22) is for a general audience, with the same footage.
- `render-explainer.ts` renders either one frame by frame and encodes it with ffmpeg.

```bash
npm run dev                                   # in the repository root, in another terminal
cd projects/shared-todo
npx playwright install chromium               # once
npx tsx video/record-app.ts                   # about 50 s of real use
npx tsx video/render-explainer.ts --page explainer-dev   # about 4 minutes; writes video/out/explainer-dev.mp4
npx tsx video/render-explainer.ts                        # about 2.5 minutes; writes video/out/explainer.mp4
```

The side-by-side recording, `app-recording.mp4`, was put together from `alice.webm` and `bob.webm` with ffmpeg. Bob's recording starts when his browser first opens the app, about 18.5 s into Alice's. If you re-record, check `markers.json`, where `bob-opens-link` gives that offset, and update `BOB_OFFSET` in `explainer.html` to match.

Tools: Playwright (Apache-2.0) and ffmpeg. No Remotion, because its license needs a paid company license for organizations with more than 3 employees.
