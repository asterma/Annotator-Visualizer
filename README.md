# Annotator Visualizer

Desktop review tool for raw ROS bag data.

It provides two workflows:

- `Dual View`: compare two `lane_rosbag/*_sync_rf.bag` files side by side in synchronized BEV canvases
- `Single View`: inspect one `lane_rosbag/*_sync_rf.bag` together with its synchronized `sync_image/*.mp4`

## Stack

- `Electron` for native file picking and desktop packaging
- `Python` for serving assets and converting ROS bag data
- `Plain browser JavaScript` for rendering and playback

## Repository Layout

- `electron/`
  Desktop shell and preload bridge.
- `public/`
  Frontend entry pages and rendering logic.
- `server/server.py`
  Static file server, bag conversion APIs, and local video streaming.
- `scripts/export_bag_to_json.py`
  ROS bag parsing and scene construction helpers.
- `pyproject.toml`
  Python dependency definition managed by `uv`.
- `package.json`
  Electron entrypoint and npm scripts.

## Run

```bash
uv sync
npm install
npm run dev
```

The desktop app starts a local server and opens the single-view workflow by default.

## Open `.bag` Files From Finder

The packaged macOS app registers itself as a viewer for `.bag` files.

Build the app:

```bash
npm run dist
```

Then install the generated `Annotator Visualizer.app` into `/Applications` and use Finder:

- Right click a `.bag` file
- Choose `Open With`
- Select `Annotator Visualizer`

When launched this way, the app opens directly into `Single View` and auto-loads the selected bag.

Notes for packaged app startup:

- The app still launches the Python backend through `uv`
- `uv` must be installed on the Mac, not only available inside one terminal session
- If Finder launches the app with a minimal `PATH`, the app falls back to common install locations such as `/opt/homebrew/bin/uv` and `~/.local/bin/uv`

## Modes

### Dual View

Choose two lane bags:

```text
.../lane_rosbag/xxx_sync_rf.bag
.../lane_rosbag/yyy_sync_rf.bag
```

Each file is mapped to its sibling OD bag:

```text
.../od/xxx_sync_od.bag
.../od/yyy_sync_od.bag
```

### Single View

Choose one lane bag:

```text
.../lane_rosbag/xxx_sync_rf.bag
```

It is paired with the sibling video directory:

```text
.../sync_image/*.mp4
```

The matcher first tries exact stem matching and then falls back to normalized base-name matching for camera-specific suffixes such as `_vls128_sync_image`.

## Notes

- The lane bag filename must end with `_sync_rf.bag`
- The app reads raw bag data directly and progressively fills the scene in single-view mode
- Compatible MP4 fallback uses `ffmpeg` when the original video stream cannot be decoded by Chromium
