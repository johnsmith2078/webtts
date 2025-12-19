# Repository Guidelines

## Project Structure & Module Organization

- `manifest.json`: Chrome/Edge Manifest V3 configuration (permissions, content scripts, popup).
- `src/content-script.js`: Core logic (selection detection, floating button in Shadow DOM, gTTS playback, word highlighting).
- `src/background.js`: gTTS synth requests (Google Translate) and MP3 data return.
- `src/popup.html` / `src/popup.js`: Action popup UI for language/tld/slow/rate/volume settings (persisted via `chrome.storage.sync`).
- `icons/`: Extension icons referenced by the manifest.

## Build, Test, and Development Commands

This repo has no bundler/build step. Develop by loading the folder as an unpacked extension:

- Open `chrome://extensions` (or `edge://extensions`) → enable **Developer mode** → **Load unpacked** → select the repo root.
- After changes: click **Reload** on the extension and refresh the target page.
- Quick syntax check (no runtime guarantees): `node -e "new Function(require('fs').readFileSync('src/content-script.js','utf8')); console.log('ok')"`

## Coding Style & Naming Conventions

- JavaScript: 2-space indentation, double quotes, semicolons (match existing files).
- Naming: `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for constants.
- Prefer small, single-purpose functions; avoid adding dependencies unless necessary.
- Keep page UI isolation (Shadow DOM / fixed overlay); don’t rely on host page CSS.

## Testing Guidelines

No automated tests currently. Validate manually:

- Select multi-line text, click the floating button, verify playback and that highlighting follows spoken words.
- Verify stop/cancel works and cleans up UI (button state, highlight overlay).
- Check behavior in pages with iframes and on scroll/resize.

## Commit & Pull Request Guidelines

- Commits in history are descriptive one-liners (often Chinese) that state the change and affected area/files; follow the same style and keep commits focused.
- PRs should include: what changed, how to test, and screenshots/GIFs for UI/UX changes. Call out any permission or network/host changes explicitly.

## Security & Configuration Tips

- Treat selected text as sensitive: avoid logging full content and minimize data retention.
- Keep network access limited to the required Google Translate endpoint and avoid broadening `host_permissions` without justification.
