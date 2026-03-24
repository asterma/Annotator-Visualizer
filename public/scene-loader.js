/**
 * Scene Loader
 * Loads one BEV scene payload and exposes per-frame accessors.
 */
class SceneLoader {
  constructor() {
    this.totalFrames = 0;
    this.fps = 20;
    this.duration = 0;
    this.coordinateSystem = null;
    this._frames = [];
    this._synthetic = false;
  }

  async load(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
    const data = await resp.json();
    this.loadObject(data);
  }

  loadObject(data) {
    this.totalFrames = data.meta.totalFrames;
    this.fps = data.meta.fps;
    this.duration = data.meta.duration;
    this.coordinateSystem = data.meta.coordinateSystem || null;
    let lastNonEmptyLanes = [];
    this._frames = (data.frames || []).map((frame) => {
      const lanes = Array.isArray(frame.lanes) ? frame.lanes : [];
      if (lanes.length > 0) {
        lastNonEmptyLanes = lanes;
      }
      return {
        ...frame,
        lanes: lanes.length > 0 ? lanes : lastNonEmptyLanes,
      };
    });
    this._synthetic = false;
  }

  loadPartialObject(data) {
    this.totalFrames = data.meta.totalFrames;
    this.fps = data.meta.fps;
    this.duration = data.meta.duration;
    this.coordinateSystem = data.meta.coordinateSystem || null;
    this._frames = [];
    this._synthetic = false;
    this.appendFrames(data.frames || []);
  }

  appendFrames(frames) {
    let lastNonEmptyLanes = [];
    if (this._frames.length > 0) {
      const lastFrame = this._frames[this._frames.length - 1];
      lastNonEmptyLanes = Array.isArray(lastFrame.lanes) ? lastFrame.lanes : [];
    }
    const normalized = (frames || []).map((frame) => {
      const lanes = Array.isArray(frame.lanes) ? frame.lanes : [];
      if (lanes.length > 0) {
        lastNonEmptyLanes = lanes;
      }
      return {
        ...frame,
        lanes: lanes.length > 0 ? lanes : lastNonEmptyLanes,
      };
    });
    this._frames.push(...normalized);
    this.totalFrames = Math.max(this.totalFrames, this._frames.length);
    this.duration = this.fps ? this.totalFrames / this.fps : 0;
  }

  updateMeta(meta = {}) {
    if (typeof meta.totalFrames === 'number') this.totalFrames = meta.totalFrames;
    if (typeof meta.fps === 'number') this.fps = meta.fps;
    if (typeof meta.duration === 'number') this.duration = meta.duration;
    if (meta.coordinateSystem !== undefined) this.coordinateSystem = meta.coordinateSystem || null;
  }

  loadSynthetic({ totalFrames, fps, duration }) {
    this.totalFrames = totalFrames;
    this.fps = fps;
    this.duration = duration;
    this.coordinateSystem = null;
    this._frames = [];
    this._synthetic = true;
  }

  reset() {
    this.totalFrames = 0;
    this.fps = 20;
    this.duration = 0;
    this.coordinateSystem = null;
    this._frames = [];
    this._synthetic = false;
  }

  getFrame(index) {
    const i = Math.max(0, Math.min(index, Math.max(0, this.totalFrames - 1)));
    if (this._synthetic || this._frames.length === 0) {
      return {
        timestamp: i / this.fps,
        coordinateSystem: this.coordinateSystem,
        lanes: [],
        objects: [],
        trajectory: [],
        ego: { vx: 0, vy: 0, ax: 0, ay: 0 },
      };
    }
    return {
      ...this._frames[i],
      coordinateSystem: this.coordinateSystem,
    };
  }
}
