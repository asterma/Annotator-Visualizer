# Repository Guidelines

## Project Structure & Module Organization
`electron/` contains the desktop shell that provides native file picking and launches the local server. `public/` contains the frontend app: `visualizer.html` is the main entry, with rendering and loading logic split across `bev-renderer.js`, `scene-loader.js`, and `visualizer-app.js`. `server/server.py` serves static assets and exposes bag conversion APIs. `scripts/export_bag_to_json.py` converts paired ROS bag inputs into the scene JSON consumed by the frontend. Keep generated artifacts and large sample data out of the repo.

## Build, Test, and Development Commands
Install Python dependencies with `uv sync`. Install Node dependencies with `npm install`. Start the local app with `npm run dev`; Electron launches the local server and opens the UI automatically. For direct conversion work, run:

```bash
uv run scripts/export_bag_to_json.py --od-bag /path/a_sync_od.bag --lane-bag /path/a_sync_rf.bag --output /tmp/scene.json
```

There is no formal build step in this repo.

## Coding Style & Naming Conventions
Match the existing style in each layer. Python uses 4-space indentation, type hints where useful, `Path` for filesystem work, and `snake_case` for functions and variables. Frontend code uses 2-space indentation, plain browser JavaScript, `camelCase` for functions and locals, and descriptive DOM ID names such as `btn-load-left-bag`. Prefer small, single-purpose helpers over adding framework-style abstractions.

## Testing Guidelines
No automated test suite is checked in. Validate changes by running the desktop app, loading representative lane bags, and confirming dual-pane sync, playback controls, and `/api/convert-bag-path` responses. If you add tests, place them in a new top-level `tests/` directory and use names like `test_server.py` or `visualizer-app.spec.js`.

## Commit & Pull Request Guidelines
Git history is not available in this checkout, so no repository-specific commit convention can be inferred. Use short, imperative commit subjects such as `Add lane bag lookup error handling`. PRs should include: a brief behavior summary, any lane-to-od path assumptions, manual verification steps, and screenshots or screen recordings for UI changes.

## Configuration Tips
The native app expects lane bags to live under a `lane_rosbag/` directory with a sibling `od/` directory one level above, for example `.../lane_rosbag/foo_sync_rf.bag` mapping to `.../od/foo_sync_od.bag`. Do not hardcode machine-specific data paths or commit local cache files such as `__pycache__/`.
