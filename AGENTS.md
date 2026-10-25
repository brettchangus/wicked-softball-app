# README demo media

Regenerate screenshots and video in `docs/media/` with Node.js 24:

```sh
npm install --prefix netlify/functions
cd scripts/readme-media
npm ci
node capture.mjs
```

Use `--shots` or `--video` to capture only one. The capture needs installed Chrome (or Playwright Chromium) and ffmpeg on PATH for video. Run `node scripts/readme-media/demo-server.mjs` to explore the demo at http://localhost:3077.

The server renders the real dashboard using only fictional identities, players, venues and tournament templates from `scripts/readme-media/`. Never point it at private snapshots, Blob data or live provider data. The capture freezes the clock at `SCENARIO_TIMES` and uses the real snapshot merge and scouting metrics. Review the generated frames when the UI changes.

When editing an existing file, preserve whether it ends with a newline. Leave changes uncommitted and unpushed unless the user explicitly requests otherwise.
