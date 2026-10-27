// Camera tab: the webcam as Jibo's camera (robot-os backend only).
//
// Off by default; the checkbox is the user gesture that asks for camera
// permission. Frames go to robot-os on this machine, where Jibo's own
// perception service (LPS) looks at them. The preview is what the LPS gets:
// mirrored like a selfie view and cropped to 16:9. On top of it are the boxes
// the LPS tracks in camera 0 (people green, motion orange).
//
// Callbacks: `onToggle(on)` and `onDevice(id)` return promises that reject
// with a user-readable Error.

export function installCameraPanel(panelEl, { video, onToggle, onDevice, listDevices }) {
  panelEl.innerHTML = '';
  panelEl.classList.add('camera-panel');
  panelEl.innerHTML = `
    <section class="rig-section">
      <h3>Webcam (Jibo's camera)</h3>
      <p class="rig-note">Jibo's own perception service, running in robot-os,
      sees your webcam: it finds and tracks people, and Jibo turns toward
      them. Frames only go to robot-os on this machine.</p>
      <label class="lps-check"><input type="checkbox" id="cam-on" disabled> Camera on</label>
      <div class="rig-row">
        <label for="cam-device">Device</label>
        <select id="cam-device" class="cam-device" disabled><option value="">Default camera</option></select>
        <span></span>
      </div>
      <p class="rig-note" id="cam-note">Needs the robot-os backend.</p>
      <p class="rig-note" id="cam-cloud" hidden></p>
    </section>
    <section class="rig-section">
      <div class="cam-preview" id="cam-preview" hidden>
        <canvas id="cam-overlay"></canvas>
      </div>
      <div class="lps-readout" id="cam-readout">Camera off</div>
      <div class="lps-readout" id="cam-lps"></div>
    </section>
  `;

  const onBox = panelEl.querySelector('#cam-on');
  const deviceSel = panelEl.querySelector('#cam-device');
  const note = panelEl.querySelector('#cam-note');
  const cloudNote = panelEl.querySelector('#cam-cloud');
  const preview = panelEl.querySelector('#cam-preview');
  const overlay = panelEl.querySelector('#cam-overlay');
  const readout = panelEl.querySelector('#cam-readout');
  const lpsReadout = panelEl.querySelector('#cam-lps');
  preview.insertBefore(video, overlay);

  let available = false;
  let lastError = '';
  function showError(msg) {
    lastError = msg;
    readout.textContent = msg;
  }

  async function refreshDevices(currentId) {
    const devices = await listDevices().catch(() => []);
    deviceSel.innerHTML = '';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      deviceSel.appendChild(opt);
    }
    if (currentId) deviceSel.value = currentId;
    deviceSel.disabled = devices.length < 2;
  }

  function showOff() {
    onBox.checked = false;
    preview.hidden = true;
    lpsReadout.textContent = '';
    drawEntities([]);
  }

  onBox.addEventListener('change', async () => {
    onBox.disabled = true;
    lastError = '';
    try {
      if (onBox.checked) {
        readout.textContent = 'Starting camera…';
        const currentId = await onToggle(true);
        preview.hidden = false;
        await refreshDevices(currentId);
      } else {
        await onToggle(false);
        showOff();
        readout.textContent = 'Camera off';
      }
    } catch (e) {
      showOff();
      showError(e && e.message ? e.message : String(e));
    } finally {
      onBox.disabled = !available;
    }
  });

  deviceSel.addEventListener('change', async () => {
    if (!onBox.checked) return;
    deviceSel.disabled = true;
    try { await onDevice(deviceSel.value); }
    catch (e) { await onToggle(false).catch(() => {}); showOff(); showError(e && e.message ? e.message : String(e)); }
    finally { deviceSel.disabled = deviceSel.options.length < 2; }
  });

  // Tracker rectangles are in the tracker's own image (imageSize {x, y}: person trackers
  // 640x360, motion trackers 128x128), which is the mirrored frame, like the preview.
  function drawEntities(entities) {
    const w = overlay.clientWidth, h = overlay.clientHeight;
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 2;
    ctx.font = '11px system-ui, sans-serif';
    for (const e of entities) {
      for (const part of e.parts || []) {
        for (const t of (part.value && part.value.trackers) || []) {
          if (!t || !t.rectangle || t.cameraId !== 0) continue;
          const size = t.imageSize || {};
          const iw = size.x || 640, ih = size.y || 360;
          const r = t.rectangle;
          if (!(r.right > r.left && r.bottom > r.top)) continue;
          const x0 = (r.left / iw) * w, x1 = (r.right / iw) * w;
          const y0 = (r.top / ih) * h, y1 = (r.bottom / ih) * h;
          ctx.strokeStyle = e.description === 'person' ? '#3f8' : '#fa3';
          ctx.fillStyle = ctx.strokeStyle;
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
          ctx.fillText(`${e.description} ${e.id}`, x0 + 2, Math.max(11, y0 - 3));
        }
      }
    }
  }

  return {
    // The camera only works with the robot-os backend; switching away turns it off
    // (the host stops the webcam).
    setAvailable(on, why) {
      available = !!on;
      onBox.disabled = !available;
      note.textContent = available ? '' : (why || 'Needs the robot-os backend.');
      note.hidden = available;
      if (!available && onBox.checked) {
        showOff();
        readout.textContent = 'Camera off';
      }
    },
    // A note about where kept photos go (robot-os's photo cloud); null hides it.
    showCloud(text) {
      cloudNote.textContent = text || '';
      cloudNote.hidden = !text;
    },
    // Uplink status (camera/uplink.js), called whenever it changes and about once a second.
    showUplink(s) {
      if (!onBox.checked || lastError) return;
      if (s.error) { readout.textContent = s.error; return; }
      const parts = [`Sending ${s.sentFps.toFixed(1)} fps`];
      if (s.remote) parts.push(`robot-os wrote ${s.remote.fps.toFixed(1)} fps (decode ${s.remote.decodeMs} ms)`);
      else if (!s.connected) parts.push('connecting to robot-os…');
      readout.textContent = parts.join(' · ');
    },
    // A /lps/visual_awareness frame, or null when the stream is not available.
    showAwareness(frame) {
      if (!onBox.checked) return;
      const entities = (frame && frame.entities) || [];
      drawEntities(entities);
      if (!frame) { lpsReadout.textContent = 'LPS: no data'; return; }
      const people = entities.filter((e) => e.description === 'person');
      const motion = entities.length - people.length;
      const parts = [`LPS: ${people.length} ${people.length === 1 ? 'person' : 'people'}`];
      if (motion) parts.push(`${motion} motion`);
      for (const e of people.slice(0, 2)) {
        const p = e.position || { x: 0, y: 0, z: 0 };
        const bearing = Math.atan2(p.y, p.x) * 180 / Math.PI;
        parts.push(`#${e.id} ${Math.hypot(p.x, p.y, p.z).toFixed(2)} m, ${bearing.toFixed(0)}°`);
      }
      lpsReadout.textContent = parts.join(' · ');
    },
    isOn: () => onBox.checked,
  };
}
