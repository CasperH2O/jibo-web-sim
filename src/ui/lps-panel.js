// LPS tab — place a target for Jibo to look at.
//
// Preset buttons drop a target at a point around Jibo; a checkbox enables
// click-to-place in the 3D viewport. "Clear" removes the target. `onSetTarget`
// receives a {x,y,z} world point (or null to clear); `onFollowCamera()` makes
// Jibo track the viewport camera as it moves; `onPlacementMode(bool)` toggles
// viewport click-to-place. `setEnabled(false, why)` greys the tab out (with
// robot-os running Jibo's real LPS, which takes no placed targets).

// Jibo's face sits at ~(0.03, 0.26, 0) facing +X; presets ring that point.
const PRESETS = {
  Front: { x: 0.6, y: 0.26, z: 0.0 },
  Left: { x: 0.1, y: 0.26, z: 0.6 },
  Right: { x: 0.1, y: 0.26, z: -0.6 },
  Up: { x: 0.5, y: 0.6, z: 0.0 },
  Down: { x: 0.5, y: -0.05, z: 0.0 },
};

export function installLpsPanel(panelEl, { onSetTarget, onFollowCamera, onPlacementMode }) {
  panelEl.innerHTML = '';
  panelEl.classList.add('lps-panel');
  panelEl.innerHTML = `
    <section class="rig-section">
      <h3>Look-at target (LPS)</h3>
      <p class="rig-note">Place a target and Jibo turns to track it. Drop one at
      a preset point, or enable click-to-place and click in the viewport.</p>
      <div class="lps-grid">
        <button type="button" data-preset="Up">Up</button>
        <button type="button" data-preset="Left">Left</button>
        <button type="button" data-preset="Front">Front</button>
        <button type="button" data-preset="Right">Right</button>
        <button type="button" data-preset="Down">Down</button>
        <button type="button" id="lps-camera" title="Jibo keeps looking at the viewport camera, wherever you orbit it">Camera</button>
      </div>
    </section>
    <section class="rig-section">
      <label class="lps-check"><input type="checkbox" id="lps-place"> Click in viewport to place target</label>
      <button type="button" id="lps-clear" class="lps-clear">Clear target</button>
      <div class="lps-readout" id="lps-readout">No target</div>
    </section>
  `;

  const readout = panelEl.querySelector('#lps-readout');
  function showTarget(t, label) {
    readout.textContent = label || (t ? `Target: (${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)})` : 'No target');
  }

  for (const btn of panelEl.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => {
      const t = PRESETS[btn.dataset.preset];
      onSetTarget(t);
      showTarget(t);
    });
  }
  panelEl.querySelector('#lps-camera').addEventListener('click', () => onFollowCamera());
  panelEl.querySelector('#lps-clear').addEventListener('click', () => {
    onSetTarget(null);
    showTarget(null);
  });
  panelEl.querySelector('#lps-place').addEventListener('change', (e) => {
    onPlacementMode(e.target.checked);
  });

  const placeBox = panelEl.querySelector('#lps-place');
  function setEnabled(on, why) {
    for (const el of panelEl.querySelectorAll('button, input')) el.disabled = !on;
    if (!on && placeBox.checked) {
      placeBox.checked = false;
      onPlacementMode(false);
    }
    showTarget(null, on ? undefined : why);
  }

  return { showTarget, setEnabled };
}
