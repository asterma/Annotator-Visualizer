(function () {
  const scene = {
    loader: new SceneLoader(),
    renderer: new BEVRenderer('single-bev-canvas'),
    loaded: false,
    fileName: '',
    videoName: '',
    videoPath: '',
    compatibleVideoUrl: '',
    loadTimings: null,
    jobId: '',
    pollOffset: 0,
    polling: false,
  };

  let currentFrame = 0;
  let lastRenderedFrame = -1;
  let isPlaying = false;
  let playbackSpeed = 1;
  let animFrameId = null;
  let manualPlayStartTs = 0;
  let manualPlayStartFrame = 0;
  let videoFallbackAttempted = false;
  let videoLoadPhase = 'idle';

  const videoEl = document.getElementById('scene-video');
  const videoPlaceholderEl = document.getElementById('video-placeholder');
  const btnLoadScene = document.getElementById('btn-load-scene');
  const btnClearScene = document.getElementById('btn-clear-scene');
  const btnPlay = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const btnStart = document.getElementById('btn-start');
  const btnEnd = document.getElementById('btn-end');
  const timeline = document.getElementById('timeline');
  const timelineTrack = document.getElementById('timeline-track');
  const playheadEl = document.getElementById('playhead');
  const frameDisplay = document.getElementById('frame-display');
  const timeDisplay = document.getElementById('time-display');
  const headerFrameId = document.getElementById('header-frame-id');
  const headerTimestamp = document.getElementById('header-timestamp');
  const speedButtons = document.querySelectorAll('.speed-opt');

  const singlePanelFileEl = document.getElementById('single-panel-file');
  const videoPanelFileEl = document.getElementById('video-panel-file');
  const infoSingleBagFileEl = document.getElementById('info-single-bag-file');
  const infoSingleVideoFileEl = document.getElementById('info-single-video-file');
  const infoSingleDataStatusEl = document.getElementById('info-single-data-status');
  const infoSingleFpsEl = document.getElementById('info-single-fps');
  const infoSingleTotalFramesEl = document.getElementById('info-single-total-frames');
  const infoSingleCountsEl = document.getElementById('info-single-counts');
  const infoSingleVideoMetaEl = document.getElementById('info-single-video-meta');
  const infoSingleTimingsEl = document.getElementById('info-single-load-timings');
  const singleLabelCountEl = document.getElementById('single-label-count');
  const singleLabelStatsEl = document.getElementById('single-label-stats');
  const singleFrameHintEl = document.getElementById('single-frame-hint');

  const singleFrameIdEl = document.getElementById('single-frame-id');
  const singleTimestampEl = document.getElementById('single-timestamp');
  const singleObjectsEl = document.getElementById('single-objects');
  const singleLanesEl = document.getElementById('single-lanes');
  const videoTimeEl = document.getElementById('video-time');
  const videoDurationEl = document.getElementById('video-duration');
  const videoResolutionEl = document.getElementById('video-resolution');

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
  }

  function formatMs(value) {
    return `${Number(value || 0).toFixed(1)} ms`;
  }

  function formatTimings(timings) {
    if (!timings) return 'No timing data';
    return [
      `cache hit: ${timings.cacheHit ? 'yes' : 'no'}`,
      `partial ready: ${timings.jobDone ? 'complete' : 'streaming'}`,
      `parse request: ${formatMs(timings.parseRequestMs)}`,
      `resolve paths: ${formatMs(timings.resolvePathsMs)}`,
      `read lane frames: ${formatMs(timings.readLaneFramesMs)}`,
      `compose scene: ${formatMs(timings.composeFramesMs)}`,
      `total compose: ${formatMs(timings.totalComposeMs)}`,
      `total backend: ${formatMs(timings.totalRequestMs)}`,
      `lane frames: ${timings.laneFrameCount || 0}`,
    ].join('\n');
  }

  function setMuted(el, muted) {
    if (!el) return;
    el.classList.toggle('muted', muted);
  }

  function setLoadState(message, progress, kind = '', extra = '') {
    void message;
    void progress;
    void kind;
    void extra;
  }

  function bagFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const bagPath = params.get('bag');
    if (!bagPath) return null;
    const parts = bagPath.split(/[\\/]/);
    return {
      path: bagPath,
      name: parts[parts.length - 1] || bagPath,
    };
  }

  function videoFrameEstimate() {
    if (!scene.loaded || !videoEl || !Number.isFinite(videoEl.duration)) return 0;
    return Math.max(1, Math.round(videoEl.duration * referenceFPS()));
  }

  function maxFrames() {
    return Math.max(scene.loader.totalFrames || 0, videoFrameEstimate());
  }

  function referenceFPS() {
    return scene.loader.fps || 20;
  }

  function clampTimelineFrame(frame) {
    return Math.max(0, Math.min(frame, Math.max(0, maxFrames() - 1)));
  }

  function emptyFrame(frameIndex) {
    return {
      frameId: frameIndex,
      timestamp: frameIndex / referenceFPS(),
      lanes: [],
      objects: [],
      trajectory: [],
      ego: { vx: 0, vy: 0, ax: 0, ay: 0 },
    };
  }

  function placeholderText() {
    const ctx = scene.renderer.ctx;
    const w = scene.renderer.width;
    const h = scene.renderer.height;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('NO LANE BAG', w / 2, h / 2);
    ctx.textAlign = 'left';
  }

  function updateMeta() {
    singlePanelFileEl.textContent = scene.fileName || 'No bag loaded';
    infoSingleBagFileEl.textContent = scene.fileName || 'No bag loaded';
    videoPanelFileEl.textContent = scene.videoName || 'No video loaded';
    infoSingleVideoFileEl.textContent = scene.videoName || 'No video loaded';
    setMuted(singlePanelFileEl, !scene.fileName);
    setMuted(infoSingleBagFileEl, !scene.fileName);
    setMuted(videoPanelFileEl, !scene.videoName);
    setMuted(infoSingleVideoFileEl, !scene.videoName);

    infoSingleFpsEl.textContent = scene.loaded ? String(scene.loader.fps || '--') : '--';
    infoSingleTotalFramesEl.textContent = scene.loaded ? String(scene.loader.totalFrames || 0) : '--';
    infoSingleTimingsEl.textContent = scene.loaded ? formatTimings(scene.loadTimings) : 'No timing data';
    infoSingleDataStatusEl.textContent = scene.loaded ? 'Lane scene and sync video loaded' : 'Waiting for lane bag';
    singleLabelCountEl.textContent = scene.loaded ? '1/1' : 'READY';
    singleFrameHintEl.textContent = scene.loaded ? 'Timeline drives the BEV scene and the synchronized MP4 together.' : 'Load one `_rf.bag`. The app infers the sibling `sync_image/*.mp4` file from the same parent session directory.';
    singleLabelStatsEl.textContent = 'Single lane scene on the left, synchronized camera video on the right.';

    if (!scene.loaded) {
      infoSingleCountsEl.textContent = '0 lanes · 0 objects';
      infoSingleVideoMetaEl.textContent = '--';
      setLoadState('Idle', 0, 'No source', 'Waiting');
    }
  }

  function sceneFrame(frameIndex) {
    if (!scene.loaded || !scene.loader.totalFrames) {
      return emptyFrame(frameIndex);
    }
    const clamped = Math.max(0, Math.min(frameIndex, scene.loader.totalFrames - 1));
    return scene.loader.getFrame(clamped);
  }

  function updateVideoMeta() {
    if (!scene.loaded || !Number.isFinite(videoEl.duration)) {
      videoTimeEl.textContent = '0.00 s';
      videoDurationEl.textContent = '0.00 s';
      videoResolutionEl.textContent = '--';
      infoSingleVideoMetaEl.textContent = '--';
      return;
    }
    videoTimeEl.textContent = `${videoEl.currentTime.toFixed(2)} s`;
    videoDurationEl.textContent = `${videoEl.duration.toFixed(2)} s`;
    const resolution = videoEl.videoWidth && videoEl.videoHeight ? `${videoEl.videoWidth}×${videoEl.videoHeight}` : '--';
    videoResolutionEl.textContent = resolution;
    infoSingleVideoMetaEl.textContent = `${resolution} · ${videoEl.duration.toFixed(2)} s`;
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
    playheadEl.style.left = `${trackStart + frac * timelineRect.width}px`;
  }

  function updateRuler() {
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

  function updateUI(frame) {
    const maxFrame = Math.max(0, maxFrames() - 1);
    timeline.max = maxFrame;
    timeline.value = String(Math.floor(currentFrame));
    frameDisplay.textContent = `${String(Math.floor(currentFrame)).padStart(4, '0')} / ${String(maxFrame).padStart(4, '0')}`;
    const frameTime = frame.timestamp || 0;
    timeDisplay.textContent = formatTime(frameTime);
    headerFrameId.textContent = `FRM ${Math.floor(currentFrame)}`;
    headerTimestamp.textContent = `${frameTime.toFixed(2)}s`;
    updatePlayhead();
    updateVideoMeta();
  }

  function renderFrame(index, syncVideo = true) {
    currentFrame = clampTimelineFrame(index);
    const frameIndex = Math.floor(currentFrame);
    if (!scene.loaded) {
      placeholderText();
      singleFrameIdEl.textContent = `FRM ${frameIndex}`;
      singleTimestampEl.textContent = '0.00 s';
      singleObjectsEl.textContent = '0 obj';
      singleLanesEl.textContent = '0 lanes';
      updateUI(emptyFrame(frameIndex));
      return;
    }

    const frame = sceneFrame(frameIndex);
    scene.renderer.render(frame);
    singleFrameIdEl.textContent = `FRM ${Math.min(frameIndex, Math.max(0, scene.loader.totalFrames - 1))}`;
    singleTimestampEl.textContent = `${(frame.timestamp || 0).toFixed(2)} s`;
    singleObjectsEl.textContent = `${(frame.objects || []).length} obj`;
    singleLanesEl.textContent = `${(frame.lanes || []).length} lanes`;
    infoSingleCountsEl.textContent = `${(frame.lanes || []).length} lanes · ${(frame.objects || []).length} objects`;

    if (syncVideo && Number.isFinite(videoEl.duration)) {
      const nextTime = Math.min(frameIndex / referenceFPS(), videoEl.duration);
      if (Math.abs(videoEl.currentTime - nextTime) > 0.04) {
        videoEl.currentTime = nextTime;
      }
    }

    updateUI(frame);
    lastRenderedFrame = frameIndex;
  }

  function seekToFrame(index) {
    pause();
    renderFrame(index);
  }

  function seekTimelineFromClientX(clientX) {
    if (!scene.loaded) return;
    const rect = timeline.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    seekToFrame(Math.round(frac * Math.max(0, maxFrames() - 1)));
  }

  function tick() {
    if (!isPlaying) return;
    if (Number.isFinite(videoEl.duration) && !videoEl.paused) {
      currentFrame = clampTimelineFrame(videoEl.currentTime * referenceFPS());
    } else {
      const elapsed = ((performance.now() - manualPlayStartTs) / 1000) * playbackSpeed;
      currentFrame = clampTimelineFrame(manualPlayStartFrame + elapsed * referenceFPS());
    }
    const frameIndex = Math.floor(currentFrame);
    if (frameIndex !== lastRenderedFrame) {
      renderFrame(frameIndex, false);
    }
    if (currentFrame >= maxFrames() - 1) {
      pause();
      seekToFrame(0);
      return;
    }
    animFrameId = requestAnimationFrame(tick);
  }

  async function play() {
    if (!scene.loaded || !maxFrames()) return;
    isPlaying = true;
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    videoEl.playbackRate = playbackSpeed;
    manualPlayStartTs = performance.now();
    manualPlayStartFrame = currentFrame;
    try {
      if (videoEl.src) {
        await videoEl.play();
      }
    } catch (error) {
      console.error(error);
    }
    tick();
  }

  function pause() {
    isPlaying = false;
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = null;
    if (videoEl && !videoEl.paused) {
      videoEl.pause();
    }
  }

  function waitForVideoMetadata() {
    return new Promise((resolve, reject) => {
      if (videoEl.readyState >= 1) {
        resolve();
        return;
      }
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Failed to load MP4 metadata'));
      };
      function cleanup() {
        videoEl.removeEventListener('loadedmetadata', onLoaded);
        videoEl.removeEventListener('error', onError);
      }
      videoEl.addEventListener('loadedmetadata', onLoaded, { once: true });
      videoEl.addEventListener('error', onError, { once: true });
    });
  }

  async function loadVideoWithFallback(payload) {
    videoFallbackAttempted = false;
    videoLoadPhase = 'primary';
    videoEl.src = payload.video_url || '';
    videoEl.load();
    try {
      await waitForVideoMetadata();
      return;
    } catch (primaryError) {
      if (!payload.compatible_video_url) {
        throw primaryError;
      }
      videoFallbackAttempted = true;
      videoLoadPhase = 'compat';
      setLoadState('Transcoding browser-compatible MP4', 86, 'lane+video', 'Falling back to H.264/AAC');
      videoEl.src = payload.compatible_video_url;
      videoEl.load();
      await waitForVideoMetadata();
    }
  }

  async function pollRemainingSceneFrames() {
    if (!scene.jobId || scene.polling) return;
    scene.polling = true;
    try {
      while (scene.jobId) {
        const response = await fetch(`/api/lane-scene-chunk?job_id=${encodeURIComponent(scene.jobId)}&offset=${scene.pollOffset}`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || `Chunk load failed with status ${response.status}`);
        }
        if (Array.isArray(payload.frames) && payload.frames.length > 0) {
          scene.loader.appendFrames(payload.frames);
          scene.pollOffset = payload.next_offset || scene.pollOffset;
          scene.loader.updateMeta({
            totalFrames: payload.total_frames || scene.loader.totalFrames,
            fps: referenceFPS(),
            duration: referenceFPS() ? (payload.total_frames || scene.loader.totalFrames) / referenceFPS() : 0,
            coordinateSystem: 'bag_xy',
          });
          updateMeta();
          updateRuler();
          renderFrame(currentFrame, false);
        }
        if (payload.done) {
          scene.jobId = '';
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } catch (error) {
      console.error(error);
      setLoadState(error instanceof Error ? error.message : String(error), 0, 'lane+video', 'Scene stream failed');
    } finally {
      scene.polling = false;
    }
  }

  async function loadLaneBagPath(laneBag) {
    pause();
    setLoadState(`Resolving ${laneBag.name}`, 18, 'lane+video', laneBag.path);
    const response = await fetch('/api/load-lane-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lane_bag_path: laneBag.path,
        fps: 20,
      }),
    });
    setLoadState(`Building scene ${laneBag.name}`, 72, 'lane+video', 'Inferring sibling sync_image mp4');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Lane/video load failed with status ${response.status}`);
    }

    scene.fileName = payload.lane_filename || laneBag.name;
    scene.videoName = payload.video_filename || '';
    scene.videoPath = payload.video_path || '';
    scene.compatibleVideoUrl = payload.compatible_video_url || '';
    scene.loadTimings = payload.timings || null;
    scene.jobId = payload.job_id || '';
    scene.pollOffset = (payload.scene_json && payload.scene_json.frames ? payload.scene_json.frames.length : 0);
    scene.loader.loadPartialObject(payload.scene_json);
    scene.loaded = true;
    updateMeta();
    updateRuler();
    renderFrame(0, false);
    setLoadState('Scene ready, loading video', 84, 'lane+video', scene.videoName || 'MP4 pending');
    videoPlaceholderEl.style.display = 'none';
    if (scene.jobId) {
      pollRemainingSceneFrames();
    }
    loadVideoWithFallback(payload).then(() => {
      updateMeta();
      renderFrame(currentFrame, false);
      if (!videoFallbackAttempted) {
        setLoadState('SINGLE ready', 100, 'lane+video', scene.videoName || 'MP4 ready');
      }
    }).catch((error) => {
      console.error(error);
      setLoadState(error instanceof Error ? error.message : String(error), 0, 'lane+video', 'Video failed');
    });
  }

  function clearScene() {
    pause();
    scene.loader.reset();
    scene.loaded = false;
    scene.fileName = '';
    scene.videoName = '';
    scene.videoPath = '';
    scene.compatibleVideoUrl = '';
    scene.loadTimings = null;
    scene.jobId = '';
    scene.pollOffset = 0;
    scene.polling = false;
    videoFallbackAttempted = false;
    videoLoadPhase = 'idle';
    videoEl.removeAttribute('src');
    videoEl.load();
    videoPlaceholderEl.style.display = 'flex';
    updateMeta();
    updateRuler();
    renderFrame(0, false);
    setLoadState('Idle', 0, 'No source', 'Waiting');
  }

  function initResizeHandle() {
    const handle = document.getElementById('single-resize-handle');
    const column = document.getElementById('single-column');
    const sidebar = document.getElementById('label-sidebar');
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      handle.classList.add('active');
      const startX = event.clientX;
      const startLeftW = column.getBoundingClientRect().width;
      const startRightW = sidebar.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(moveEvent) {
        const dx = moveEvent.clientX - startX;
        const newLeft = Math.max(420, startLeftW + dx);
        const newRight = Math.max(280, startRightW - dx);
        column.style.flex = 'none';
        sidebar.style.flex = 'none';
        column.style.width = `${newLeft}px`;
        sidebar.style.width = `${newRight}px`;
        scene.renderer._resize();
        renderFrame(currentFrame, false);
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
    });
  }

  btnLoadScene.addEventListener('click', async () => {
    if (!window.nativeApp || typeof window.nativeApp.pickLaneBag !== 'function') {
      setLoadState('Native file picker is unavailable', 0, 'lane+video', 'Electron required');
      return;
    }
    try {
      const laneBag = await window.nativeApp.pickLaneBag();
      if (!laneBag) return;
      await loadLaneBagPath(laneBag);
    } catch (error) {
      console.error(error);
      setLoadState(error instanceof Error ? error.message : String(error), 0, 'lane+video', 'Failed');
    }
  });

  btnClearScene.addEventListener('click', clearScene);
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
      videoEl.playbackRate = playbackSpeed;
      if (isPlaying && videoEl.paused) {
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

  videoEl.addEventListener('loadedmetadata', () => {
    if (videoFallbackAttempted && videoLoadPhase === 'compat') {
      setLoadState('Compatible MP4 ready', 100, 'lane+video', 'Using H.264/AAC fallback');
    }
    updateMeta();
    updateRuler();
    renderFrame(currentFrame, false);
  });
  videoEl.addEventListener('error', () => {
    if (videoLoadPhase === 'compat') {
      setLoadState('Compatible MP4 failed', 0, 'lane+video', 'ffmpeg fallback did not decode');
    }
  });
  videoEl.addEventListener('timeupdate', () => {
    if (!isPlaying) updateVideoMeta();
  });
  videoEl.addEventListener('ended', () => {
    pause();
    seekToFrame(0);
  });

  window.addEventListener('resize', () => {
    updateRuler();
    renderFrame(currentFrame, false);
  });

  initResizeHandle();
  updateMeta();
  updateRuler();
  renderFrame(0, false);

  const initialBag = bagFromQuery();
  if (initialBag) {
    loadLaneBagPath(initialBag).catch((error) => {
      console.error(error);
    });
  }
})();
