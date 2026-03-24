"""
Export one OD + Lane rosbag pair to BEV JSON for the web viewer.

Usage:
    python scripts/export_bag_to_json.py \
      --od-bag /path/to/file_sync_od.bag \
      --lane-bag /path/to/file_sync_rf.bag \
      --output /path/to/scene_bev/file_sync_image.json

Dependencies:
    uv sync
"""

from __future__ import annotations

import argparse
import json
import math
from time import perf_counter
from pathlib import Path

from rosbags.rosbag1 import Reader
from rosbags.typesys import Stores, get_typestore
from rosbags.typesys.msg import get_types_from_msg

# rosbag label -> renderer type
CLASS_MAP = {
    'Car': 'car',
    'Van': 'car',
    'Truck': 'truck',
    'Big_Truck': 'truck',
    'Medium_Truck': 'truck',
    'Pedestrian': 'pedestrian',
    'Cyclist': 'cyclist',
    'Motorcycle': 'cyclist',
    'Bike': 'cyclist',
}


def load_typestore(bag_path: Path):
    """Create typestore and register custom message types from the bag."""
    typestore = get_typestore(Stores.ROS1_NOETIC)
    with Reader(bag_path) as reader:
        for conn in reader.connections:
            typs = get_types_from_msg(conn.msgdef.data, conn.msgtype)
            typestore.register(typs)
    return typestore


def build_typestore_from_reader(reader: Reader):
    """Register all message types from an already-open reader."""
    typestore = get_typestore(Stores.ROS1_NOETIC)
    for conn in reader.connections:
        typs = get_types_from_msg(conn.msgdef.data, conn.msgtype)
        typestore.register(typs)
    return typestore


def parse_lane_frame(msg) -> dict:
    """Convert one /ld_polyline3d_local message into a scene frame payload."""
    pt_map = {point.id: (float(point.x), float(point.y)) for point in msg.points}
    lines = []

    for line in msg.lines:
        pts = [pt_map[pid] for pid in line.point_id if pid in pt_map]
        if not pts:
            continue
        lane_pts = [{'x': round(pt[0], 3), 'y': round(pt[1], 3)} for pt in pts]
        lines.append({
            'type': line.type_str,
            'subType': line.sub_type_str,
            'points': lane_pts,
        })

    return {
        'frame_id': int(msg.frame_id),
        'lanes': lines,
    }


def iter_lane_frames(bag_path: Path):
    """Yield lane frames from /ld_polyline3d_local one by one."""
    with Reader(bag_path) as reader:
        typestore = build_typestore_from_reader(reader)
        for conn, _timestamp, rawdata in reader.messages():
            if conn.topic != '/ld_polyline3d_local':
                continue
            msg = typestore.deserialize_ros1(rawdata, conn.msgtype)
            yield parse_lane_frame(msg)


def read_od_frames(bag_path: Path):
    """Read all /ld_object_lists frames from OD bag."""
    typestore = load_typestore(bag_path)
    frames = []
    with Reader(bag_path) as reader:
        for conn, _timestamp, rawdata in reader.messages():
            if conn.topic != '/ld_object_lists':
                continue
            msg = typestore.deserialize_ros1(rawdata, conn.msgtype)
            objs = []
            for obj in msg.objects:
                x_lidar = obj.pose.position.x
                y_lidar = obj.pose.position.y
                cls = CLASS_MAP.get(obj.class_label_pred, 'car')
                distance = math.sqrt(x_lidar ** 2 + y_lidar ** 2)
                rel_angle = math.atan2(y_lidar, x_lidar)
                width = float(obj.dimensions.y)
                length = float(obj.dimensions.x)
                objs.append({
                    'type': cls,
                    'rawClass': obj.class_label_pred,
                    'x': round(x_lidar, 3),
                    'y': round(y_lidar, 3),
                    'yaw': round(float(obj.yaw), 5),
                    'distance': round(distance, 3),
                    'relAngle': round(rel_angle, 5),
                    'w': round(width, 2),
                    'h': round(length, 2),
                })
            frames.append({
                'frame_number': int(msg.frame_number),
                'objects': objs,
            })
    return frames


def read_lane_frames(bag_path: Path):
    """Read all /ld_polyline3d_local frames from Lane bag."""
    return list(iter_lane_frames(bag_path))


def read_ego_frames(bag_path: Path):
    """Read all /ld_imugps_can frames from OD bag for ego motion data."""
    typestore = load_typestore(bag_path)
    frames = []
    with Reader(bag_path) as reader:
        for conn, _timestamp, rawdata in reader.messages():
            if conn.topic != '/ld_imugps_can':
                continue
            msg = typestore.deserialize_ros1(rawdata, conn.msgtype)
            frames.append({
                'vx': round(float(msg.v_x_CAN), 4),
                'vy': round(float(msg.linear_velocity_imugps.y), 4),
                'ax': round(float(msg.acceleration_x), 4),
                'ay': round(float(msg.acceleration_y), 4),
                'yawRate': round(float(msg.yawrate), 6),
            })
    return frames


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return 0.5 * (ordered[mid - 1] + ordered[mid])


def _median_filter(values: list[float], radius: int) -> list[float]:
    if radius <= 0 or not values:
        return list(values)
    filtered = []
    for idx in range(len(values)):
        start = max(0, idx - radius)
        end = min(len(values), idx + radius + 1)
        filtered.append(_median(values[start:end]))
    return filtered


def _moving_average(values: list[float], radius: int) -> list[float]:
    if radius <= 0 or not values:
        return list(values)
    smoothed = []
    for idx in range(len(values)):
        start = max(0, idx - radius)
        end = min(len(values), idx + radius + 1)
        window = values[start:end]
        smoothed.append(sum(window) / len(window))
    return smoothed


def smooth_ego_frames(frames: list[dict]) -> list[dict]:
    """Denoise vx/vy/ax/ay without changing frame count or timestamps."""
    if not frames:
        return frames

    configs = {
        'vx': {'median_radius': 1, 'avg_radius': 2},
        'vy': {'median_radius': 1, 'avg_radius': 2},
        'ax': {'median_radius': 1, 'avg_radius': 3},
        'ay': {'median_radius': 1, 'avg_radius': 3},
    }

    smoothed_columns = {}
    for key, config in configs.items():
        raw = [float(frame.get(key, 0.0)) for frame in frames]
        denoised = _median_filter(raw, config['median_radius'])
        smoothed_columns[key] = _moving_average(denoised, config['avg_radius'])

    smoothed_frames = []
    for idx, frame in enumerate(frames):
        updated = dict(frame)
        for key in configs:
            updated[key] = round(smoothed_columns[key][idx], 4)
        smoothed_frames.append(updated)
    return smoothed_frames


def compose_scene_json(od_bag: Path, lane_bag: Path, fps: int = 20) -> dict:
    """Build the BEV scene payload from OD and Lane bags."""
    od_frames = read_od_frames(od_bag)
    lane_frames = read_lane_frames(lane_bag)
    ego_frames = smooth_ego_frames(read_ego_frames(od_bag))

    n_frames = max(len(od_frames), len(lane_frames), len(ego_frames))
    duration = n_frames / fps
    empty_ego = {'vx': 0, 'vy': 0, 'ax': 0, 'ay': 0, 'yawRate': 0}
    frames = []

    for i in range(n_frames):
        frames.append({
            'frameId': i,
            'timestamp': round(i / fps, 4),
            'objects': od_frames[i]['objects'] if i < len(od_frames) else [],
            'lanes': lane_frames[i]['lanes'] if i < len(lane_frames) else [],
            'ego': ego_frames[i] if i < len(ego_frames) else empty_ego,
            'trajectory': [],
        })

    return {
        'meta': {
            'totalFrames': n_frames,
            'fps': fps,
            'duration': round(duration, 2),
            'coordinateSystem': 'bag_xy',
        },
        'frames': frames,
    }


def compose_scene_json_with_timings(od_bag: Path, lane_bag: Path, fps: int = 20) -> tuple[dict, dict]:
    """Build the BEV scene payload and return a timing breakdown in milliseconds."""
    started_at = perf_counter()

    step_started_at = perf_counter()
    od_frames = read_od_frames(od_bag)
    read_od_ms = round((perf_counter() - step_started_at) * 1000, 2)

    step_started_at = perf_counter()
    lane_frames = read_lane_frames(lane_bag)
    read_lane_ms = round((perf_counter() - step_started_at) * 1000, 2)

    step_started_at = perf_counter()
    ego_raw_frames = read_ego_frames(od_bag)
    read_ego_ms = round((perf_counter() - step_started_at) * 1000, 2)

    step_started_at = perf_counter()
    ego_frames = smooth_ego_frames(ego_raw_frames)
    smooth_ego_ms = round((perf_counter() - step_started_at) * 1000, 2)

    step_started_at = perf_counter()
    n_frames = max(len(od_frames), len(lane_frames), len(ego_frames))
    duration = n_frames / fps
    empty_ego = {'vx': 0, 'vy': 0, 'ax': 0, 'ay': 0, 'yawRate': 0}
    frames = []

    for i in range(n_frames):
        frames.append({
            'frameId': i,
            'timestamp': round(i / fps, 4),
            'objects': od_frames[i]['objects'] if i < len(od_frames) else [],
            'lanes': lane_frames[i]['lanes'] if i < len(lane_frames) else [],
            'ego': ego_frames[i] if i < len(ego_frames) else empty_ego,
            'trajectory': [],
        })
    compose_frames_ms = round((perf_counter() - step_started_at) * 1000, 2)

    payload = {
        'meta': {
            'totalFrames': n_frames,
            'fps': fps,
            'duration': round(duration, 2),
            'coordinateSystem': 'bag_xy',
        },
        'frames': frames,
    }

    timings = {
        'readOdFramesMs': read_od_ms,
        'readLaneFramesMs': read_lane_ms,
        'readEgoFramesMs': read_ego_ms,
        'smoothEgoFramesMs': smooth_ego_ms,
        'composeFramesMs': compose_frames_ms,
        'totalComposeMs': round((perf_counter() - started_at) * 1000, 2),
        'odFrameCount': len(od_frames),
        'laneFrameCount': len(lane_frames),
        'egoFrameCount': len(ego_frames),
    }
    return payload, timings


def export_scene_json(od_bag: Path, lane_bag: Path, output: Path, fps: int = 20) -> Path:
    """Generate and write one scene JSON file."""
    payload = compose_scene_json(od_bag=od_bag, lane_bag=lane_bag, fps=fps)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    return output


def parse_args():
    parser = argparse.ArgumentParser(description='Export one OD + lane rosbag pair to scene BEV JSON.')
    parser.add_argument('--od-bag', type=Path, required=True, help='Path to *_sync_od.bag')
    parser.add_argument('--lane-bag', type=Path, required=True, help='Path to *_sync_rf.bag')
    parser.add_argument('--output', type=Path, required=True, help='Path to output JSON')
    parser.add_argument('--fps', type=int, default=20, help='Output FPS metadata')
    return parser.parse_args()


def main():
    args = parse_args()
    output = export_scene_json(
        od_bag=args.od_bag,
        lane_bag=args.lane_bag,
        output=args.output,
        fps=args.fps,
    )
    print(output)


if __name__ == '__main__':
    main()
