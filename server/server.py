from __future__ import annotations

import json
import hashlib
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import perf_counter
from urllib.parse import parse_qs, quote, urlparse

APP_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_ROOT = APP_ROOT / 'public'
SCRIPTS_ROOT = APP_ROOT / 'scripts'
VIDEO_CACHE_ROOT = Path(tempfile.gettempdir()) / 'annotator-visualizer-video-cache'
PORT = int(os.environ.get('PORT', '3030'))
INITIAL_SCENE_FRAMES = 120
SCENE_CHUNK_SIZE = 240

LANE_SCENE_JOBS = {}
LANE_SCENE_JOB_KEYS = {}
LANE_SCENE_JOBS_LOCK = threading.Lock()

if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))


class VisualizerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/':
            self.path = '/single-visualizer.html'
        if parsed.path == '/api/local-video':
            return self._handle_local_video(parsed)
        if parsed.path == '/api/lane-scene-chunk':
            return self._handle_lane_scene_chunk(parsed)
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/convert-bag-path':
            return self._handle_convert_bag_path()
        if parsed.path == '/api/load-lane-video':
            return self._handle_load_lane_video()
        return self._send_json({'error': 'Not found'}, HTTPStatus.NOT_FOUND)

    def _infer_od_bag_from_lane_path(self, lane_bag_path: Path) -> Path:
        lane_path = lane_bag_path.expanduser().resolve()
        if not lane_path.exists():
            raise FileNotFoundError(f'Lane bag does not exist: {lane_path}')
        if not lane_path.is_file():
            raise FileNotFoundError(f'Lane bag is not a file: {lane_path}')

        lane_filename = lane_path.name
        if not lane_filename.endswith('_sync_rf.bag'):
            raise FileNotFoundError(
                'Lane bag filename must end with `_sync_rf.bag` to infer the matching od bag'
            )

        od_filename = lane_filename.replace('_sync_rf.bag', '_sync_od.bag')
        od_path = lane_path.parent.parent / 'od' / od_filename
        if not od_path.exists():
            raise FileNotFoundError(f'Could not locate matching od bag: {od_path}')
        return od_path

    def _infer_sync_video_from_lane_path(self, lane_bag_path: Path) -> Path:
        lane_path = lane_bag_path.expanduser().resolve()
        if not lane_path.exists():
            raise FileNotFoundError(f'Lane bag does not exist: {lane_path}')
        if not lane_path.is_file():
            raise FileNotFoundError(f'Lane bag is not a file: {lane_path}')

        sync_image_dir = lane_path.parent.parent / 'sync_image'
        exact_video_path = sync_image_dir / f'{lane_path.stem}.mp4'
        if exact_video_path.exists():
            return exact_video_path

        if not sync_image_dir.exists() or not sync_image_dir.is_dir():
            raise FileNotFoundError(f'Could not locate sync_image directory: {sync_image_dir}')

        lane_base = self._normalize_lane_stem(lane_path.stem)
        candidates = []
        for video_path in sync_image_dir.glob('*.mp4'):
            if self._normalize_video_stem(video_path.stem) == lane_base:
                candidates.append(video_path)

        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            raise FileNotFoundError(
                f'Multiple sync videos matched lane bag base `{lane_base}` in {sync_image_dir}'
            )

        raise FileNotFoundError(
            f'Could not locate matching sync video in {sync_image_dir} for lane bag base `{lane_base}`'
        )

    def _compatible_video_cache_path(self, video_path: Path) -> Path:
        digest = hashlib.sha1(str(video_path).encode('utf-8')).hexdigest()
        return VIDEO_CACHE_ROOT / f'{digest}.mp4'

    def _resolve_executable(self, command_name: str) -> str:
        candidates = [
            shutil.which(command_name),
            str(Path.home() / '.local' / 'bin' / command_name),
            str(Path.home() / '.cargo' / 'bin' / command_name),
            f'/opt/homebrew/bin/{command_name}',
            f'/usr/local/bin/{command_name}',
            f'/usr/bin/{command_name}',
        ]
        for candidate in candidates:
            if not candidate:
                continue
            candidate_path = Path(candidate)
            if candidate_path.exists() and os.access(candidate_path, os.X_OK):
                return str(candidate_path)
        raise FileNotFoundError(
            f'Could not find executable `{command_name}`. Install it and make sure it is available to the app.'
        )

    def _ensure_browser_compatible_video(self, video_path: Path) -> Path:
        VIDEO_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        cached_path = self._compatible_video_cache_path(video_path)
        if cached_path.exists() and cached_path.stat().st_mtime >= video_path.stat().st_mtime:
            return cached_path

        temp_output = cached_path.with_suffix('.tmp.mp4')
        if temp_output.exists():
            temp_output.unlink()

        ffmpeg_executable = self._resolve_executable('ffmpeg')
        command = [
            ffmpeg_executable,
            '-y',
            '-i', str(video_path),
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-b:a', '192k',
            str(temp_output),
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.strip().splitlines()
            detail = stderr[-1] if stderr else 'ffmpeg failed without stderr'
            raise RuntimeError(f'ffmpeg transcode failed: {detail}')

        temp_output.replace(cached_path)
        return cached_path

    def _lane_scene_job_key(self, lane_path: Path, fps: int) -> str:
        stat = lane_path.stat()
        raw = f'{lane_path}|{fps}|{stat.st_mtime_ns}|{stat.st_size}'
        return hashlib.sha1(raw.encode('utf-8')).hexdigest()

    def _scene_frame_from_lane_frame(self, frame_index: int, lane_frame: dict, fps: int) -> dict:
        return {
            'frameId': frame_index,
            'timestamp': round(frame_index / fps, 4),
            'objects': [],
            'lanes': lane_frame.get('lanes', []),
            'ego': {'vx': 0, 'vy': 0, 'ax': 0, 'ay': 0, 'yawRate': 0},
            'trajectory': [],
        }

    def _create_lane_scene_job(self, lane_path: Path, fps: int) -> dict:
        job = {
            'id': uuid.uuid4().hex,
            'lane_path': str(lane_path),
            'fps': fps,
            'frames': [],
            'done': False,
            'error': None,
            'condition': threading.Condition(),
        }

        def worker():
            try:
                from export_bag_to_json import iter_lane_frames

                for index, lane_frame in enumerate(iter_lane_frames(lane_path)):
                    scene_frame = self._scene_frame_from_lane_frame(index, lane_frame, fps)
                    with job['condition']:
                        job['frames'].append(scene_frame)
                        job['condition'].notify_all()
                with job['condition']:
                    job['done'] = True
                    job['condition'].notify_all()
            except Exception as error:
                with job['condition']:
                    job['error'] = str(error)
                    job['done'] = True
                    job['condition'].notify_all()

        threading.Thread(target=worker, daemon=True).start()
        return job

    def _get_or_start_lane_scene_job(self, lane_path: Path, fps: int) -> tuple[dict, bool]:
        job_key = self._lane_scene_job_key(lane_path, fps)
        with LANE_SCENE_JOBS_LOCK:
            existing_job_id = LANE_SCENE_JOB_KEYS.get(job_key)
            if existing_job_id:
                existing_job = LANE_SCENE_JOBS.get(existing_job_id)
                if existing_job:
                    return existing_job, True

            job = self._create_lane_scene_job(lane_path, fps)
            LANE_SCENE_JOBS[job['id']] = job
            LANE_SCENE_JOB_KEYS[job_key] = job['id']
            return job, False

    def _wait_for_initial_scene_frames(self, job: dict, minimum_frames: int) -> int:
        with job['condition']:
            while len(job['frames']) < minimum_frames and not job['done'] and not job['error']:
                job['condition'].wait(timeout=0.05)
            if job['error']:
                raise RuntimeError(job['error'])
            return len(job['frames'])

    def _strip_suffixes(self, stem: str, suffixes: tuple[str, ...]) -> str:
        normalized = stem
        changed = True
        while changed:
            changed = False
            for suffix in suffixes:
                if normalized.endswith(suffix):
                    normalized = normalized[:-len(suffix)]
                    changed = True
        return normalized.rstrip('_-')

    def _normalize_lane_stem(self, stem: str) -> str:
        return self._strip_suffixes(
            stem,
            (
                '_vls128_sync_rf',
                '_sync_rf',
                '_vls128_rf',
                '_rf',
                '_vls128',
            ),
        )

    def _normalize_video_stem(self, stem: str) -> str:
        return self._strip_suffixes(
            stem,
            (
                '_vls128_sync_image',
                '_sync_image',
                '_vls128_image',
                '_image',
                '_vls128',
            ),
        )

    def _read_json_body(self) -> dict:
        content_length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(content_length)
        try:
            payload = json.loads(body.decode('utf-8') or '{}')
        except json.JSONDecodeError as error:
            raise ValueError(f'Invalid JSON body: {error.msg}') from error
        if not isinstance(payload, dict):
            raise ValueError('JSON body must be an object')
        return payload

    def _handle_convert_bag_path(self):
        request_started_at = perf_counter()
        try:
            from export_bag_to_json import compose_scene_json_with_timings
        except ModuleNotFoundError as error:
            return self._send_json({
                'error': (
                    'Bag conversion dependency is missing. '
                    'Run `uv sync` before loading bags. '
                    f'Root cause: {error}'
                )
            }, HTTPStatus.BAD_REQUEST)

        try:
            step_started_at = perf_counter()
            fields = self._read_json_body()
            parse_request_ms = round((perf_counter() - step_started_at) * 1000, 2)
        except ValueError as error:
            return self._send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)

        lane_bag_path = fields.get('lane_bag_path')
        if not lane_bag_path or not isinstance(lane_bag_path, str):
            return self._send_json({'error': 'lane_bag_path is required'}, HTTPStatus.BAD_REQUEST)

        try:
            fps = int(fields.get('fps', 20))
        except ValueError:
            return self._send_json({'error': 'fps must be an integer'}, HTTPStatus.BAD_REQUEST)

        try:
            step_started_at = perf_counter()
            lane_path = Path(lane_bag_path).expanduser().resolve()
            od_path = self._infer_od_bag_from_lane_path(lane_path)
            resolve_paths_ms = round((perf_counter() - step_started_at) * 1000, 2)
            payload, compose_timings = compose_scene_json_with_timings(od_bag=od_path, lane_bag=lane_path, fps=fps)
        except Exception as error:
            return self._send_json({'error': f'Bag conversion failed: {error}'}, HTTPStatus.BAD_REQUEST)

        timings = {
            'parseRequestMs': parse_request_ms,
            'resolvePathsMs': resolve_paths_ms,
            **compose_timings,
            'totalRequestMs': round((perf_counter() - request_started_at) * 1000, 2),
        }

        return self._send_json({
            'ok': True,
            'od_filename': od_path.name,
            'lane_filename': lane_path.name,
            'lane_bag_path': str(lane_path),
            'od_bag_path': str(od_path),
            'meta': payload.get('meta', {}),
            'timings': timings,
            'scene_json': payload,
        })

    def _handle_load_lane_video(self):
        request_started_at = perf_counter()
        try:
            step_started_at = perf_counter()
            fields = self._read_json_body()
            parse_request_ms = round((perf_counter() - step_started_at) * 1000, 2)
        except ValueError as error:
            return self._send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)

        lane_bag_path = fields.get('lane_bag_path')
        if not lane_bag_path or not isinstance(lane_bag_path, str):
            return self._send_json({'error': 'lane_bag_path is required'}, HTTPStatus.BAD_REQUEST)

        try:
            fps = int(fields.get('fps', 20))
        except ValueError:
            return self._send_json({'error': 'fps must be an integer'}, HTTPStatus.BAD_REQUEST)

        try:
            step_started_at = perf_counter()
            lane_path = Path(lane_bag_path).expanduser().resolve()
            video_path = self._infer_sync_video_from_lane_path(lane_path)
            resolve_paths_ms = round((perf_counter() - step_started_at) * 1000, 2)
            step_started_at = perf_counter()
            job, memory_hit = self._get_or_start_lane_scene_job(lane_path, fps)
            available_frames = self._wait_for_initial_scene_frames(job, INITIAL_SCENE_FRAMES)
            initial_frames = list(job['frames'][:available_frames])
            compose_timings = {
                'readLaneFramesMs': round((perf_counter() - step_started_at) * 1000, 2),
                'composeFramesMs': 0.0,
                'totalComposeMs': round((perf_counter() - step_started_at) * 1000, 2),
                'laneFrameCount': len(initial_frames),
                'cacheHit': memory_hit,
                'jobDone': job['done'],
            }
            payload = {
                'meta': {
                    'totalFrames': len(initial_frames),
                    'fps': fps,
                    'duration': round(len(initial_frames) / fps, 2),
                    'coordinateSystem': 'bag_xy',
                    'partial': not job['done'],
                },
                'frames': initial_frames,
            }
        except Exception as error:
            print(f'[load-lane-video] ERROR: {error}')
            return self._send_json({'error': f'Lane/video load failed: {error}'}, HTTPStatus.BAD_REQUEST)

        video_query = f'/api/local-video?path={quote(str(video_path))}'
        timings = {
            'parseRequestMs': parse_request_ms,
            'resolvePathsMs': resolve_paths_ms,
            **compose_timings,
            'totalRequestMs': round((perf_counter() - request_started_at) * 1000, 2),
        }
        return self._send_json({
            'ok': True,
            'lane_filename': lane_path.name,
            'lane_bag_path': str(lane_path),
            'video_filename': video_path.name,
            'video_path': str(video_path),
            'video_url': video_query,
            'compatible_video_url': f'/api/local-video?path={quote(str(video_path))}&compat=1',
            'job_id': job['id'],
            'meta': payload.get('meta', {}),
            'timings': timings,
            'scene_json': payload,
        })

    def _handle_lane_scene_chunk(self, parsed):
        query = parse_qs(parsed.query)
        job_id = query.get('job_id', [None])[0]
        offset_raw = query.get('offset', ['0'])[0]
        if not job_id:
            return self._send_json({'error': 'job_id is required'}, HTTPStatus.BAD_REQUEST)
        try:
            offset = max(0, int(offset_raw))
        except ValueError:
            return self._send_json({'error': 'offset must be an integer'}, HTTPStatus.BAD_REQUEST)

        with LANE_SCENE_JOBS_LOCK:
            job = LANE_SCENE_JOBS.get(job_id)
        if not job:
            return self._send_json({'error': f'Unknown job_id: {job_id}'}, HTTPStatus.NOT_FOUND)

        with job['condition']:
            if job['error']:
                return self._send_json({'error': job['error']}, HTTPStatus.BAD_REQUEST)
            available = len(job['frames'])
            upper = min(available, offset + SCENE_CHUNK_SIZE)
            frames = list(job['frames'][offset:upper])
            done = job['done']
            total_frames = len(job['frames'])

        return self._send_json({
            'ok': True,
            'job_id': job_id,
            'offset': offset,
            'next_offset': upper,
            'frames': frames,
            'done': done and upper >= total_frames,
            'available_frames': available,
            'total_frames': total_frames,
        })

    def _handle_local_video(self, parsed):
        query = parse_qs(parsed.query)
        requested_path = query.get('path', [None])[0]
        if not requested_path:
            return self._send_json({'error': 'path is required'}, HTTPStatus.BAD_REQUEST)

        video_path = Path(requested_path).expanduser().resolve()
        if not video_path.exists() or not video_path.is_file():
            return self._send_json({'error': f'Video file not found: {video_path}'}, HTTPStatus.NOT_FOUND)

        compat = query.get('compat', ['0'])[0] == '1'
        if compat:
            try:
                video_path = self._ensure_browser_compatible_video(video_path)
            except Exception as error:
                print(f'[local-video compat] ERROR: {error}')
                return self._send_json({'error': f'Compatible video transcode failed: {error}'}, HTTPStatus.BAD_REQUEST)

        mime_type, _ = mimetypes.guess_type(str(video_path))
        content_type = mime_type or 'application/octet-stream'
        file_size = video_path.stat().st_size
        range_header = self.headers.get('Range')

        start = 0
        end = file_size - 1
        status = HTTPStatus.OK

        if range_header and range_header.startswith('bytes='):
            range_spec = range_header.removeprefix('bytes=').split('-', 1)
            if range_spec[0]:
                start = int(range_spec[0])
            if len(range_spec) > 1 and range_spec[1]:
                end = int(range_spec[1])
            end = min(end, file_size - 1)
            status = HTTPStatus.PARTIAL_CONTENT

        content_length = end - start + 1
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(content_length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.end_headers()

        with video_path.open('rb') as file_handle:
            file_handle.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = file_handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    # Chromium may cancel the current stream while probing or switching
                    # to the fallback-compatible MP4. That is expected and not actionable.
                    return
                remaining -= len(chunk)

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(('127.0.0.1', PORT), VisualizerHandler)
    print(f'Annotator visualizer listening on http://127.0.0.1:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
