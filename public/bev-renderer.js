/**
 * Bird's Eye View (BEV) Renderer
 * Renders radar-like top-down view with lane lines, detected objects, and ego vehicle.
 */
class BEVRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.defaultScale = 8;
    this.scale = this.defaultScale;
    this.minScale = 1;
    this.maxScale = 20;
    this.panX = 0;  // pixel offset from default center
    this.panY = 0;
    this._lastFrame = null;
    this._dragging = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this.onViewChange = null;
    this._resize();
    window.addEventListener('resize', () => this._resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._resize());
      if (this.canvas.parentElement) this._resizeObserver.observe(this.canvas.parentElement);
    }

    // Zoom with mouse wheel
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
      this._emitViewChange();
      if (this._lastFrame) this.render(this._lastFrame);
    }, { passive: false });

    // Pan with left mouse drag
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this._dragging = true;
      this._dragStartX = e.clientX - this.panX;
      this._dragStartY = e.clientY - this.panY;
      this.canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      this.panX = e.clientX - this._dragStartX;
      this.panY = e.clientY - this._dragStartY;
      this._emitViewChange();
      if (this._lastFrame) this.render(this._lastFrame);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      this._dragging = false;
      this.canvas.style.cursor = '';
    });

    // Double-click to reset view
    this.canvas.addEventListener('dblclick', () => {
      this.panX = 0;
      this.panY = 0;
      this.scale = this.defaultScale;
      this._emitViewChange();
      if (this._lastFrame) this.render(this._lastFrame);
    });
  }

  getViewState() {
    return {
      scale: this.scale,
      panX: this.panX,
      panY: this.panY,
    };
  }

  setViewState(viewState) {
    if (!viewState) return;
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, Number(viewState.scale) || this.scale));
    this.panX = Number(viewState.panX) || 0;
    this.panY = Number(viewState.panY) || 0;
    if (this._lastFrame) this.render(this._lastFrame);
  }

  _emitViewChange() {
    if (typeof this.onViewChange === 'function') {
      this.onViewChange(this.getViewState());
    }
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * devicePixelRatio;
    this.canvas.height = rect.height * devicePixelRatio;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  render(frame) {
    this._lastFrame = frame;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2 + this.panX;
    const cy = h * 0.62 + this.panY;

    // Background
    ctx.fillStyle = '#0c0f15';
    ctx.fillRect(0, 0, w, h);

    // Subtle radial gradient from ego
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.8);
    grad.addColorStop(0, 'rgba(0, 229, 255, 0.03)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    this._drawRangeRings(ctx, cx, cy);
    this._drawLanes(ctx, cx, cy, frame.lanes);
    this._drawObjects(ctx, cx, cy, frame.objects);
    this._drawTrajectory(ctx, cx, cy, frame.trajectory);
    this._drawEgo(ctx, cx, cy);
    this._drawZoomIndicator(ctx, w, h);
  }

  _isBagScene(frame) {
    if (!frame) return false;
    if (frame.coordinateSystem === 'bag_xy') return true;
    return Array.isArray(frame.lanes) &&
      frame.lanes.length > 0 &&
      frame.lanes[0] &&
      Array.isArray(frame.lanes[0].points);
  }

  _worldToScreen(cx, cy, x, y, bagScene) {
    if (bagScene) {
      return {
        sx: cx - y * this.scale,
        sy: cy - x * this.scale,
      };
    }
    return {
      sx: cx - x * this.scale,
      sy: cy - y * this.scale,
    };
  }

  _drawRangeRings(ctx, cx, cy) {
    // Pick a nice ring interval based on zoom: ~40–80 px apart
    const targetPx = 60;
    const rawInterval = targetPx / this.scale;
    const niceSteps = [1, 2, 5, 10, 20, 25, 50, 100];
    let interval = niceSteps[niceSteps.length - 1];
    for (const s of niceSteps) { if (s >= rawInterval) { interval = s; break; } }
    const maxDist = Math.ceil(Math.max(this.width, this.height) / this.scale);
    const distances = [];
    for (let d = interval; d <= maxDist; d += interval) distances.push(d);

    for (const d of distances) {
      const r = d * this.scale;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.fillText(d + 'm', cx + 4, cy - r + 10);
    }

    // Cross-hair lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cy + 60);
    ctx.moveTo(0, cy);
    ctx.lineTo(this.width, cy);
    ctx.stroke();
  }

  _drawLanes(ctx, cx, cy, lanes) {
    const bagScene = lanes.some((lane) => lane && Array.isArray(lane.points));
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      const points = Array.isArray(lane.points) ? lane.points : lane;
      const laneType = lane.type || null;
      const laneSubType = lane.subType || null;

      if (bagScene) {
        ctx.strokeStyle = laneType === 'road_boundary' ? 'rgba(255, 149, 0, 0.85)' : 'rgba(0, 229, 255, 0.72)';
        ctx.lineWidth = laneType === 'road_boundary' ? 1.8 : 1.2;
        if (laneSubType === 'lane_single_dashed') {
          ctx.setLineDash([7, 6]);
        } else {
          ctx.setLineDash([]);
        }
      } else {
        const isBoundary = (i === 0 || i === lanes.length - 1);
        ctx.strokeStyle = isBoundary ? 'rgba(0, 229, 255, 0.85)' : 'rgba(0, 229, 255, 0.4)';
        ctx.lineWidth = isBoundary ? 2 : 1.2;
        if (!isBoundary) {
          ctx.setLineDash([4, 6]);
        } else {
          ctx.setLineDash([]);
        }
      }

      ctx.beginPath();
      for (let j = 0; j < points.length; j++) {
        const { sx, sy } = this._worldToScreen(cx, cy, points[j].x, points[j].y, bagScene);
        if (j === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawObjects(ctx, cx, cy, objects) {
    const bagScene = objects.some((obj) => obj && obj.yaw !== undefined && obj.x !== undefined && obj.y !== undefined);
    for (const obj of objects) {
      let sx, sy;
      if (obj.x !== undefined && obj.y !== undefined) {
        ({ sx, sy } = this._worldToScreen(cx, cy, obj.x, obj.y, bagScene));
      } else {
        sx = cx - Math.cos(obj.relAngle) * obj.distance * this.scale;
        sy = cy - Math.sin(obj.relAngle) * obj.distance * this.scale;
      }

      let color, glowColor;
      switch (obj.type) {
        case 'car':
          color = '#ff2d55'; glowColor = 'rgba(255, 45, 85, 0.2)'; break;
        case 'truck':
          color = '#ffab00'; glowColor = 'rgba(255, 171, 0, 0.2)'; break;
        case 'pedestrian':
          color = '#ffdb4d'; glowColor = 'rgba(255, 219, 77, 0.2)'; break;
        case 'cyclist':
          color = '#34c759'; glowColor = 'rgba(52, 199, 89, 0.2)'; break;
        default:
          color = '#ff2d55'; glowColor = 'rgba(255, 45, 85, 0.2)';
      }

      const bw = obj.w * this.scale;
      const bh = obj.h * this.scale;

      if (obj.yaw !== undefined) {
        const angle = bagScene ? -obj.yaw - Math.PI / 2 : obj.yaw - Math.PI;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(angle);
        ctx.fillStyle = glowColor;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        if (bagScene) {
          ctx.fillRect(-bh / 2 - 2, -bw / 2 - 2, bh + 4, bw + 4);
          ctx.strokeRect(-bh / 2, -bw / 2, bh, bw);
        } else {
          ctx.fillRect(-bh / 2 - 2, -bw / 2 - 2, bh + 4, bw + 4);
          ctx.strokeRect(-bh / 2, -bw / 2, bh, bw);
        }
        ctx.restore();
      } else {
        // Axis-aligned box (simulated data)
        ctx.fillStyle = glowColor;
        ctx.fillRect(sx - bw / 2 - 2, sy - bh / 2 - 2, bw + 4, bh + 4);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(sx - bw / 2, sy - bh / 2, bw, bh);
      }

      // Center dot
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawTrajectory(ctx, cx, cy, trajectory) {
    if (!trajectory || trajectory.length === 0) return;

    // Trajectory glow
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.15)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (const p of trajectory) {
      ctx.lineTo(cx - p.x * this.scale * 0.3, cy - p.y * this.scale * 0.3);
    }
    ctx.stroke();

    // Trajectory line
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (const p of trajectory) {
      ctx.lineTo(cx - p.x * this.scale * 0.3, cy - p.y * this.scale * 0.3);
    }
    ctx.stroke();

    // Arrow dots
    for (let i = 0; i < trajectory.length; i += 4) {
      const p = trajectory[i];
      const lx = cx - p.x * this.scale * 0.3;
      const ly = cy - p.y * this.scale * 0.3;
      const alpha = 0.3 + (i / trajectory.length) * 0.5;
      ctx.fillStyle = `rgba(0, 229, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(lx, ly, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
  }

  _drawZoomIndicator(ctx, w, h) {
    // Scale bar in bottom-right corner
    const barMeters = Math.round(50 / this.scale);  // ~50px bar
    const nice = [1, 2, 5, 10, 20, 25, 50, 100];
    let label = nice[nice.length - 1];
    for (const n of nice) { if (n >= barMeters) { label = n; break; } }
    const barPx = label * this.scale;
    const x = w - 16 - barPx;
    const y = h - 16;
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 3); ctx.lineTo(x, y); ctx.lineTo(x + barPx, y); ctx.lineTo(x + barPx, y - 3);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0, 229, 255, 0.5)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label + 'm', x + barPx / 2, y - 6);
    ctx.textAlign = 'left';
  }

  _drawEgo(ctx, cx, cy) {
    // Ego glow
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18);
    grad.addColorStop(0, 'rgba(0, 229, 255, 0.15)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fill();

    // Ego triangle rotated 90deg CCW in the viewer.
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx - 5.5, cy + 5);
    ctx.lineTo(cx + 5.5, cy + 5);
    ctx.closePath();
    ctx.fill();

    // Inner highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx - 2.5, cy + 2);
    ctx.lineTo(cx + 2.5, cy + 2);
    ctx.closePath();
    ctx.fill();
  }
}
