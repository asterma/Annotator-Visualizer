(function () {
  const left = createSide('left', 'bev-canvas-left');
  const right = createSide('right', 'bev-canvas-right');

  let currentFrame = 0;
  let lastRenderedFrame = -1;
  let isPlaying = false;
  let playbackSpeed = 1;
  let animFrameId = null;
  let manualPlayStartTs = 0;
  let manualPlayStartFrame = 0;
  let suppressViewSync = false;

  const btnLoadLeftBag = document.getElementById('btn-load-left-bag');
  const btnLoadRightBag = document.getElementById('btn-load-right-bag');
  const btnClearLeft = document.getElementById('btn-clear-left');
  const btnClearRight = document.getElementById('btn-clear-right');

  const btnPlay = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const btnStart = document.getElementById('btn-start');
  const btnEnd = document.getElementById('btn-end');
  const timeline = document.getElementById('timeline');
  const timelineTrack = document.getElementById('timeline-track');
  const timeDisplay = document.getElementById('time-display');
  const frameDisplay = document.getElementById('frame-display');
  const headerFrameId = document.getElementById('header-frame-id');
  const headerTimestamp = document.getElementById('header-timestamp');
  const speedButtons = document.querySelectorAll('.speed-opt');
  const playheadEl = document.getElementById('playhead');

  const labelCountEl = document.getElementById('label-count');
  const vlaHint = document.getElementById('vla-frame-hint');
  const infoDataStatus = document.getElementById('info-data-status');
  const labelStatsEl = document.getElementById('label-stats');

  const signalEls = {
    vx: document.getElementById('sv-vx'),
    vy: document.getElementById('sv-vy'),
    ax: document.getElementById('sv-ax'),
    ay: document.getElementById('sv-ay'),
  };

  function createSide(name, canvasId) {
    return {
      name,
      loader: new SceneLoader(),
      renderer: new BEVRenderer(canvasId),
      loaded: false,
      fileName: '',
      matchedOdName: '',
      sourceKind: '',
      panelFileEl: document.getElementById(`${name}-panel-file`),
      infoFileEl: document.getElementById(`info-${name}-bag-file`),
      infoFpsEl: document.getElementById(`info-${name}-fps`),
      infoFramesEl: document.getElementById(`info-${name}-total-frames`),
      infoCountsEl: document.getElementById(`info-${name}-counts`),
      infoTimingsEl: document.getElementById(`info-${name}-load-timings`),
      loadStatusEl: document.getElementById(`${name}-load-status`),
      loadProgressBarEl: document.getElementById(`${name}-load-progress-bar`),
      loadProgressValueEl: document.getElementById(`${name}-load-progress-value`),
      loadKindEl: document.getElementById(`${name}-load-kind`),
      loadExtraEl: document.getElementById(`${name}-load-extra`),
      frameEl: document.getElementById(`${name}-frame-id`),
      timestampEl: document.getElementById(`${name}-timestamp`),
      objectsEl: document.getElementById(`${name}-objects`),
      lanesEl: document.getElementById(`${name}-lanes`),
      signalData: {
        vx: new Float32Array(0),
        vy: new Float32Array(0),
        ax: new Float32Array(0),
        ay: new Float32Array(0),
      },
      loadTimings: null,
    };
  }

  function formatMs(value) {
    return `${Number(value || 0).toFixed(1)} ms`;
  }

  function formatLoadTimings(timings) {
    if (!timings) return 'No timing data';
    return [
      `parse request: ${formatMs(timings.parseRequestMs)}`,
      `resolve paths: ${formatMs(timings.resolvePathsMs)}`,
      `read OD frames: ${formatMs(timings.readOdFramesMs)}`,
      `read lane frames: ${formatMs(timings.readLaneFramesMs)}`,
      `read ego frames: ${formatMs(timings.readEgoFramesMs)}`,
      `smooth ego: ${formatMs(timings.smoothEgoFramesMs)}`,
      `compose scene: ${formatMs(timings.composeFramesMs)}`,
      `total compose: ${formatMs(timings.totalComposeMs)}`,
      `total backend: ${formatMs(timings.totalRequestMs)}`,
      `frames od/lane/ego: ${timings.odFrameCount || 0}/${timings.laneFrameCount || 0}/${timings.egoFrameCount || 0}`,
    ].join('\n');
  }

  function syncRendererView(sourceSide, targetSide, viewState) {
    if (suppressViewSync) return;
    suppressViewSync = true;
    targetSide.renderer.setViewState(viewState);
    suppressViewSync = false;
  }

  function setLoading() {}

  function hideLoading() {}

  function setSideLoadState(side, message, progress, kind = '', extra = '') {
    const percent = Math.max(0, Math.min(100, Math.round(progress)));
    if (side.loadStatusEl) side.loadStatusEl.textContent = message;
    if (side.loadProgressBarEl) side.loadProgressBarEl.style.width = `${percent}%`;
    if (side.loadProgressValueEl) side.loadProgressValueEl.textContent = `${percent}%`;
    if (side.loadKindEl) side.loadKindEl.textContent = kind || 'No source';
    if (side.loadExtraEl) side.loadExtraEl.textContent = extra || 'Waiting';
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
  }

  function maxFrames() {
    return Math.max(left.loader.totalFrames || 0, right.loader.totalFrames || 0);
  }

  function clampTimelineFrame(frame) {
    return Math.max(0, Math.min(frame, Math.max(0, maxFrames() - 1)));
  }

  function sceneLoadedCount() {
    return Number(left.loaded) + Number(right.loaded);
  }

  function referenceFPS() {
    return left.loader.fps || right.loader.fps || 20;
  }

  function emptyFrame(frameIndex) {
    return {
      frameId: frameIndex,
      timestamp: 0,
      lanes: [],
      objects: [],
      trajectory: [],
      ego: { vx: 0, vy: 0, ax: 0, ay: 0 },
    };
  }

  function sideFrame(side, frameIndex) {
    if (!side.loaded || !side.loader.totalFrames) {
      return emptyFrame(frameIndex);
    }
    const clamped = Math.max(0, Math.min(frameIndex, side.loader.totalFrames - 1));
    return side.loader.getFrame(clamped);
  }

  function placeholderText(side) {
    const ctx = side.renderer.ctx;
    const w = side.renderer.width;
    const h = side.renderer.height;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`NO ${side.name.toUpperCase()} BAG`, w / 2, h / 2);
    ctx.textAlign = 'left';
  }

  function setMuted(el, muted) {
    if (!el) return;
    el.classList.toggle('muted', muted);
  }

  function updateSourceMeta() {
    if (infoDataStatus) {
      if (left.loaded && right.loaded) infoDataStatus.textContent = 'Both sides loaded and synchronized by frame index';
      else if (left.loaded) infoDataStatus.textContent = 'Only left side loaded';
      else if (right.loaded) infoDataStatus.textContent = 'Only right side loaded';
      else infoDataStatus.textContent = 'Waiting for left/right lane bags';
    }
    if (labelCountEl) labelCountEl.textContent = sceneLoadedCount() === 2 ? '2/2' : `${sceneLoadedCount()}/2`;
    if (vlaHint) vlaHint.textContent = left.loaded || right.loaded ? 'Shared controls, independent scene payloads on each side.' : 'Load lane bags directly. Matching od bags are inferred from the selected lane bag path.';
    if (labelStatsEl) labelStatsEl.textContent = 'Frame playback is shared; data and timing remain per-side.';
  }

  function updateSideMeta(side) {
    side.panelFileEl.textContent = side.fileName || 'No bag loaded';
    side.infoFileEl.textContent = side.fileName || 'No bag loaded';
    setMuted(side.panelFileEl, !side.fileName);
    setMuted(side.infoFileEl, !side.fileName);
    side.infoFpsEl.textContent = side.loaded ? String(side.loader.fps || '--') : '--';
    side.infoFramesEl.textContent = side.loaded ? String(side.loader.totalFrames || 0) : '--';
    if (side.infoTimingsEl) {
      side.infoTimingsEl.textContent = side.loaded ? formatLoadTimings(side.loadTimings) : 'No timing data';
    }
    if (!side.loaded) {
      side.infoCountsEl.textContent = '0 lanes · 0 objects';
      setSideLoadState(side, 'Idle', 0, 'No source', 'Waiting');
    }
  }

  function precomputeSignals(side) {
    const n = side.loader.totalFrames || 0;
    side.signalData.vx = new Float32Array(n);
    side.signalData.vy = new Float32Array(n);
    side.signalData.ax = new Float32Array(n);
    side.signalData.ay = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const frame = side.loader.getFrame(i);
      const ego = frame.ego || {};
      side.signalData.vx[i] = ego.vx || 0;
      side.signalData.vy[i] = ego.vy || 0;
      side.signalData.ax[i] = ego.ax || 0;
      side.signalData.ay[i] = ego.ay || 0;
    }
  }

  function drawOverlaySignal(canvasId, key) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.fillRect(0, 0, w, h);

    const leftData = left.signalData[key] || new Float32Array(0);
    const rightData = right.signalData[key] || new Float32Array(0);
    const values = [...leftData, ...rightData];
    if (!values.length) return;

    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (key === 'vy') {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (min === max) max = min + 1;
    const range = max - min;
    const pad = 3;

    const palette = {
      vx: { leftStroke: '#FF6B6B', leftFill: 'rgba(255, 107, 107, 0.12)', rightStroke: '#FF9A9A', rightFill: 'rgba(255, 154, 154, 0.10)' },
      vy: { leftStroke: '#FFB347', leftFill: 'rgba(255, 179, 71, 0.12)', rightStroke: '#FFD08A', rightFill: 'rgba(255, 208, 138, 0.10)' },
      ax: { leftStroke: '#5AC8FA', leftFill: 'rgba(90, 200, 250, 0.12)', rightStroke: '#96DFFF', rightFill: 'rgba(150, 223, 255, 0.10)' },
      ay: { leftStroke: '#4ECDC4', leftFill: 'rgba(78, 205, 196, 0.12)', rightStroke: '#8DE4DE', rightFill: 'rgba(141, 228, 222, 0.10)' },
    };
    const colors = palette[key] || palette.vx;

    if (key === 'vy') {
      const zeroY = h - pad - ((0 - min) / range) * (h - pad * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(w, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function drawSeries(data, stroke, fill) {
      if (!data.length) return;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < data.length; i++) {
        const x = (i / Math.max(1, data.length - 1)) * w;
        const y = h - pad - ((data[i] - min) / range) * (h - pad * 2);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = (i / Math.max(1, data.length - 1)) * w;
        const y = h - pad - ((data[i] - min) / range) * (h - pad * 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    drawSeries(leftData, colors.leftStroke, colors.leftFill);
    drawSeries(rightData, colors.rightStroke, colors.rightFill);
  }

  function drawAllSignals() {
    drawOverlaySignal('signal-vx', 'vx');
    drawOverlaySignal('signal-vy', 'vy');
    drawOverlaySignal('signal-ax', 'ax');
    drawOverlaySignal('signal-ay', 'ay');
  }

  function updateSignalValues(frameIndex) {
    const keys = ['vx', 'vy', 'ax', 'ay'];
    keys.forEach((key) => {
      const leftVal = left.loaded && left.signalData[key].length ? left.signalData[key][Math.min(frameIndex, left.signalData[key].length - 1)] : 0;
      const rightVal = right.loaded && right.signalData[key].length ? right.signalData[key][Math.min(frameIndex, right.signalData[key].length - 1)] : 0;
      signalEls[key].textContent = `L ${leftVal.toFixed(2)} | R ${rightVal.toFixed(2)}`;
    });
  }

  function drawRuler() {
    const canvas = document.getElementById('ruler-canvas');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    const totalFrames = maxFrames() || 1;
    const pxPerFrame = w / totalFrames;
    let majorInterval;
    let minorInterval;
    if (pxPerFrame > 4) {
      majorInterval = 10;
      minorInterval = 1;
    } else if (pxPerFrame > 1.5) {
      majorInterval = 50;
      minorInterval = 10;
    } else if (pxPerFrame > 0.5) {
      majorInterval = 100;
      minorInterval = 20;
    } else {
      majorInterval = 200;
      minorInterval = 50;
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(0, 0, w, h);

    for (let frame = 0; frame <= totalFrames; frame += minorInterval) {
      const x = (frame / Math.max(1, totalFrames - 1)) * w;
      const isMajor = frame % majorInterval === 0;
      ctx.strokeStyle = isMajor ? 'rgba(140, 120, 255, 0.25)' : 'rgba(140, 120, 255, 0.1)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 0 : h * 0.5);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = 'rgba(139, 130, 168, 0.6)';
        ctx.font = '8px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(frame.toString(), x, h * 0.45);
      }
    }
  }

  function updatePlayhead() {
    if (!playheadEl) return;
    const total = Math.max(1, maxFrames() - 1);
    const frac = Math.floor(currentFrame) / total;
    const container = document.getElementById('tracks-container');
    if (!container || !timeline) return;
    const containerRect = container.getBoundingClientRect();
    const timelineRect = timeline.getBoundingClientRect();
    const trackStart = timelineRect.left - containerRect.left;
    const x = trackStart + frac * timelineRect.width;
    playheadEl.style.left = `${x}px`;
  }

  function renderSide(side, frameIndex) {
    if (!side.loaded) {
      placeholderText(side);
      side.frameEl.textContent = `FRM ${frameIndex}`;
      side.timestampEl.textContent = '0.00 s';
      side.objectsEl.textContent = '0 obj';
      side.lanesEl.textContent = '0 lanes';
      side.infoCountsEl.textContent = '0 lanes · 0 objects';
      return emptyFrame(frameIndex);
    }
    const frame = sideFrame(side, frameIndex);
    side.renderer.render(frame);
    const actualFrame = Math.min(frameIndex, side.loader.totalFrames - 1);
    side.frameEl.textContent = `FRM ${actualFrame}`;
    side.timestampEl.textContent = `${(frame.timestamp || 0).toFixed(2)} s`;
    side.objectsEl.textContent = `${(frame.objects || []).length} obj`;
    side.lanesEl.textContent = `${(frame.lanes || []).length} lanes`;
    side.infoCountsEl.textContent = `${(frame.lanes || []).length} lanes · ${(frame.objects || []).length} objects`;
    return frame;
  }

  function updateUI(leftFrame, rightFrame) {
    const maxFrame = Math.max(0, maxFrames() - 1);
    timeline.max = maxFrame;
    timeline.value = String(Math.floor(currentFrame));
    frameDisplay.textContent = `${String(Math.floor(currentFrame)).padStart(4, '0')} / ${String(maxFrame).padStart(4, '0')}`;
    timeDisplay.textContent = `L ${formatTime(leftFrame.timestamp || 0)} | R ${formatTime(rightFrame.timestamp || 0)}`;
    headerFrameId.textContent = `FRM ${Math.floor(currentFrame)}`;
    headerTimestamp.textContent = `L ${(leftFrame.timestamp || 0).toFixed(2)}s | R ${(rightFrame.timestamp || 0).toFixed(2)}s`;
    updatePlayhead();
  }

  function renderFrame(index) {
    currentFrame = clampTimelineFrame(index);
    const frameIndex = Math.floor(currentFrame);
    const leftFrame = renderSide(left, frameIndex);
    const rightFrame = renderSide(right, frameIndex);
    updateSignalValues(frameIndex);
    updateUI(leftFrame, rightFrame);
    lastRenderedFrame = frameIndex;
  }

  function hasAnyData() {
    return left.loaded || right.loaded;
  }

  function seekToFrame(index) {
    pause();
    renderFrame(index);
  }

  function seekTimelineFromClientX(clientX) {
    if (!hasAnyData()) return;
    const rect = timeline.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const frameIndex = Math.round(frac * Math.max(0, maxFrames() - 1));
    seekToFrame(frameIndex);
  }

  function play() {
    if (!hasAnyData() || !maxFrames()) return;
    isPlaying = true;
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    manualPlayStartTs = performance.now();
    manualPlayStartFrame = currentFrame;
    tick();
  }

  function pause() {
    isPlaying = false;
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  function tick() {
    if (!isPlaying) return;
    const elapsed = ((performance.now() - manualPlayStartTs) / 1000) * playbackSpeed;
    currentFrame = clampTimelineFrame(manualPlayStartFrame + elapsed * referenceFPS());
    if (currentFrame >= maxFrames() - 1) {
      currentFrame = 0;
      manualPlayStartTs = performance.now();
      manualPlayStartFrame = 0;
    }
    const frameIndex = Math.floor(currentFrame);
    if (frameIndex !== lastRenderedFrame) {
      renderFrame(frameIndex);
    }
    animFrameId = requestAnimationFrame(tick);
  }

  async function loadPayloadToSide(side, payload, fileName, options = {}) {
    side.loader.loadObject(payload);
    side.loaded = true;
    side.fileName = fileName;
    side.matchedOdName = options.matchedOdName || '';
    side.sourceKind = options.sourceKind || 'bag';
    side.loadTimings = options.timings || null;
    updateSideMeta(side);
    precomputeSignals(side);
    updateSourceMeta();
    drawAllSignals();
    drawRuler();
    renderFrame(currentFrame);
    setSideLoadState(side, `${side.name.toUpperCase()} ready`, 100, options.sourceKind || 'bag', fileName);
    hideLoading();
  }

  async function loadLaneBagPath(side, laneBag) {
    pause();
    setSideLoadState(side, `Resolving ${laneBag.name}`, 18, 'native-path', laneBag.path);
    const response = await fetch('/api/convert-bag-path', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        lane_bag_path: laneBag.path,
        fps: 20,
      }),
    });
    setSideLoadState(side, `Converting ${laneBag.name}`, 72, 'native-path', 'Inferring sibling od bag');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Bag conversion failed with status ${response.status}`);
    }
    await loadPayloadToSide(side, payload.scene_json, laneBag.name, {
      sourceKind: 'native-path',
      matchedOdName: payload.od_filename || '',
      timings: payload.timings || null,
    });
  }

  function clearSide(side) {
    pause();
    side.loader.reset();
    side.loaded = false;
    side.fileName = '';
    side.matchedOdName = '';
    side.sourceKind = '';
    side.loadTimings = null;
    side.signalData = { vx: new Float32Array(0), vy: new Float32Array(0), ax: new Float32Array(0), ay: new Float32Array(0) };
    updateSideMeta(side);
    updateSourceMeta();
    drawAllSignals();
    drawRuler();
    renderFrame(Math.min(currentFrame, Math.max(0, maxFrames() - 1)));
    setSideLoadState(side, 'Idle', 0, 'No source', 'Waiting');
  }


  function initResizeHandle() {
    const handle = document.getElementById('resize-handle-1');
    const compareColumn = document.getElementById('compare-column');
    const sidebar = document.getElementById('label-sidebar');

    function onMouseDown(event) {
      event.preventDefault();
      handle.classList.add('active');
      const startX = event.clientX;
      const startLeftW = compareColumn.getBoundingClientRect().width;
      const startRightW = sidebar.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(moveEvent) {
        const dx = moveEvent.clientX - startX;
        const newLeft = Math.max(320, startLeftW + dx);
        const newRight = Math.max(280, startRightW - dx);
        compareColumn.style.flex = 'none';
        sidebar.style.flex = 'none';
        compareColumn.style.width = `${newLeft}px`;
        sidebar.style.width = `${newRight}px`;
        left.renderer._resize();
        right.renderer._resize();
        renderFrame(currentFrame);
      }

      function onUp() {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    handle.addEventListener('mousedown', onMouseDown);
  }

  btnLoadLeftBag.addEventListener('click', async () => {
    if (!window.nativeApp || typeof window.nativeApp.pickLaneBag !== 'function') {
      setSideLoadState(left, 'Native file picker is unavailable', 0, 'native-path', 'Electron required');
      return;
    }
    try {
      const laneBag = await window.nativeApp.pickLaneBag();
      if (!laneBag) return;
      await loadLaneBagPath(left, laneBag);
    } catch (error) {
      console.error(error);
      setSideLoadState(left, error instanceof Error ? error.message : String(error), 0, 'native-path', 'Failed');
    }
  });
  btnLoadRightBag.addEventListener('click', async () => {
    if (!window.nativeApp || typeof window.nativeApp.pickLaneBag !== 'function') {
      setSideLoadState(right, 'Native file picker is unavailable', 0, 'native-path', 'Electron required');
      return;
    }
    try {
      const laneBag = await window.nativeApp.pickLaneBag();
      if (!laneBag) return;
      await loadLaneBagPath(right, laneBag);
    } catch (error) {
      console.error(error);
      setSideLoadState(right, error instanceof Error ? error.message : String(error), 0, 'native-path', 'Failed');
    }
  });
  btnClearLeft.addEventListener('click', () => clearSide(left));
  btnClearRight.addEventListener('click', () => clearSide(right));

  btnPlay.addEventListener('click', () => {
    if (isPlaying) pause();
    else play();
  });
  btnPrev.addEventListener('click', () => seekToFrame(Math.floor(currentFrame) - 1));
  btnNext.addEventListener('click', () => seekToFrame(Math.floor(currentFrame) + 1));
  btnStart.addEventListener('click', () => seekToFrame(0));
  btnEnd.addEventListener('click', () => seekToFrame(maxFrames() - 1));
  timeline.addEventListener('input', () => seekToFrame(parseInt(timeline.value, 10)));

  if (timelineTrack) {
    timelineTrack.addEventListener('mousedown', (event) => {
      seekTimelineFromClientX(event.clientX);
      event.preventDefault();
    });
    timelineTrack.addEventListener('click', (event) => {
      seekTimelineFromClientX(event.clientX);
      event.preventDefault();
    });
  }

  speedButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      speedButtons.forEach(other => other.classList.remove('active'));
      btn.classList.add('active');
      playbackSpeed = parseFloat(btn.dataset.speed);
      if (isPlaying) {
        manualPlayStartTs = performance.now();
        manualPlayStartFrame = currentFrame;
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        if (isPlaying) pause();
        else play();
        break;
      case 'ArrowLeft':
        seekToFrame(Math.floor(currentFrame) - 1);
        break;
      case 'ArrowRight':
        seekToFrame(Math.floor(currentFrame) + 1);
        break;
      case 'Home':
        event.preventDefault();
        seekToFrame(0);
        break;
      case 'End':
        event.preventDefault();
        seekToFrame(maxFrames() - 1);
        break;
    }
  });

  window.addEventListener('resize', () => {
    drawAllSignals();
    drawRuler();
    renderFrame(currentFrame);
  });

  left.renderer.onViewChange = (viewState) => syncRendererView(left, right, viewState);
  right.renderer.onViewChange = (viewState) => syncRendererView(right, left, viewState);

  initResizeHandle();
  updateSideMeta(left);
  updateSideMeta(right);
  updateSourceMeta();
  drawAllSignals();
  drawRuler();
  renderFrame(0);
  hideLoading();
})();
