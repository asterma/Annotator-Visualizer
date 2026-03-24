# Annotator Visualizer

This directory is a minimal local app that reproduces the current dual-scene functionality of `public/visualizer.html` without the rest of the annotator stack.

## What it does

- Load a left and right `lane_rosbag/*.bag`
- Infer the matching `od/*.bag` automatically by filename
- Convert each bag pair to an in-memory scene payload
- Render synchronized dual BEV views
- Share one playback timeline across both sides
- Show `vx / vy / ax / ay` overlays
- Sync pan / zoom / reset across both BEV canvases

## Why this shape

From first principles, the app only needs two layers:

1. Frontend viewer
   - dual BEV panes
   - shared playback and signal charts
2. One conversion endpoint
   - accept `lane_bag`
   - find matching `od_bag`
   - return one scene payload per side

Everything else from the main repo was removed on purpose.

## Structure

- `public/`: standalone frontend
- `server/server.py`: minimal static server + `/api/convert-bags`
- `scripts/export_bag_to_json.py`: bag-to-scene conversion

## Run

Install Python dependency:

```bash
pip install -r requirements.txt
```

Point the app to your raw data root. It must contain paths like:

```text
BMW/raw/.../lane_rosbag/*.bag
BMW/raw/.../od/*.bag
```

Start:

```bash
VLA_DATA_ROOT=/path/to/data npm run dev
```

Open:

```text
http://127.0.0.1:3030/
```

## Matching rule

When you load a lane bag named:

```text
xxx_sync_rf.bag
```

the backend searches `VLA_DATA_ROOT` for:

```text
lane_rosbag/xxx_sync_rf.bag
```

and maps it to:

```text
od/xxx_sync_od.bag
```

The filename must be unique under `VLA_DATA_ROOT`.
