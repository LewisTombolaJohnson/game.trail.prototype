// Trail Map Game Logic
// Author: Initial scaffold

/*
Core concepts:
- A series of levels laid out along a winding path (Candy Crush style)
- Player can only click the current level (or maybe previously completed) to open a modal
- Completing a level advances progress; next level becomes current
- Persist progress in localStorage
- Provide reset button
*/

const LEVEL_COUNT = 30;
const STORAGE_KEY = 'trailProgressV1';

/**
 * Level states contract
 * locked: not yet reachable
 * current: the level where the player is positioned
 * completed: finished levels behind the player
 * future/unlocked (optional) could be previewed, but we'll keep it minimal
 */

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { current: 1 };
    const data = JSON.parse(raw);
    if (typeof data.current !== 'number' || data.current < 1 || data.current > LEVEL_COUNT) {
      return { current: 1 };
    }
    return data;
  } catch (e) {
    console.warn('Failed to parse progress', e);
    return { current: 1 };
  }
}

function saveProgress(progress) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

const progress = loadProgress();

// Data-driven positions for each level along a path.
// We'll generate positions algorithmically (snake / zig-zag) for now.
function generateLevelPositions(count) {
  const positions = [];
  // layout grid approach: 5 columns, levels proceed downward in rows.
  const cols = 5;
  const colSpacing = 100; // in svg units
  const rowSpacing = 130;
  const xOffset = 80;
  const yOffset = 80;
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRowIndex = i % cols;
    // snake effect: even rows left->right, odd rows right->left
    const col = row % 2 === 0 ? inRowIndex : (cols - 1 - inRowIndex);
    const x = xOffset + col * colSpacing + (Math.sin(row * 1.35) * 18);
    const y = yOffset + row * rowSpacing + (Math.cos(i * 0.7) * 10);
    positions.push({ x, y });
  }
  return positions;
}

const levelPositions = generateLevelPositions(LEVEL_COUNT);

// Build an SVG path that roughly goes through the nodes.
function buildTrailPath(points) {
  if (!points.length) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    // simple smoothness: use quadratic curve every other segment
    if (i % 2 === 0) {
      const prev = points[i - 1];
      const cx = (prev.x + p.x) / 2;
      const cy = (prev.y + p.y) / 2;
      d += ` Q ${cx} ${cy}, ${p.x} ${p.y}`;
    } else {
      d += ` L ${p.x} ${p.y}`;
    }
  }
  return d;
}

function createSVGNamespaceEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function renderMap(container) {
  const wrapper = document.createElement('div');
  wrapper.className = 'map-wrapper';

  const svg = createSVGNamespaceEl('svg', {
    class: 'trail-svg',
    viewBox: '0 0 600 1600',
    role: 'group',
    'aria-label': 'Level trail map'
  });

  // defs for gradients
  const defs = createSVGNamespaceEl('defs');
  const gradPlayer = createSVGNamespaceEl('linearGradient', { id: 'gradPlayer', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
  gradPlayer.appendChild(createSVGNamespaceEl('stop', { offset: '0%', 'stop-color': '#ffc247' }));
  gradPlayer.appendChild(createSVGNamespaceEl('stop', { offset: '100%', 'stop-color': '#ff7f32' }));
  defs.appendChild(gradPlayer);
  svg.appendChild(defs);

  const pathEl = createSVGNamespaceEl('path', { class: 'trail-path', d: buildTrailPath(levelPositions) });
  svg.appendChild(pathEl);

  // Group for levels
  const levelsGroup = createSVGNamespaceEl('g', { 'data-group': 'levels' });

  levelPositions.forEach((pos, idx) => {
    const levelNumber = idx + 1;
    const g = createSVGNamespaceEl('g', {
      class: 'level-node',
      tabindex: '0',
      'data-level': String(levelNumber),
      'aria-label': `Level ${levelNumber}`
    });

    const state = computeLevelState(levelNumber, progress.current);
    g.dataset.state = state;

    const circle = createSVGNamespaceEl('circle', {
      cx: pos.x,
      cy: pos.y,
      r: 28
    });

    const label = createSVGNamespaceEl('text', {
      x: pos.x,
      y: pos.y + 5,
      class: 'level-label'
    });
    label.textContent = levelNumber;

    g.appendChild(circle);
    g.appendChild(label);

    g.addEventListener('click', onLevelNodeClick);
    g.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onLevelNodeClick.call(g, e);
      }
    });

    levelsGroup.appendChild(g);
  });

  svg.appendChild(levelsGroup);

  // Player token
  const tokenGroup = createSVGNamespaceEl('g', { class: 'player-token', 'data-player': 'token' });
  const tokenCircle = createSVGNamespaceEl('circle', { cx: 0, cy: 0, r: 18 });
  const tokenText = createSVGNamespaceEl('text', { x: 0, y: 4 });
  tokenText.textContent = 'YOU';
  tokenGroup.appendChild(tokenCircle);
  tokenGroup.appendChild(tokenText);
  svg.appendChild(tokenGroup);

  wrapper.appendChild(svg);
  container.appendChild(wrapper);

  positionPlayerToken(progress.current);
}

function computeLevelState(levelNumber, current) {
  if (levelNumber < current) return 'completed';
  if (levelNumber === current) return 'current';
  if (levelNumber === current + 1) return 'unlocked';
  return 'locked';
}

function positionPlayerToken(levelNumber) {
  const token = document.querySelector('[data-player="token"]');
  const node = document.querySelector(`.level-node[data-level='${levelNumber}'] circle`);
  if (!token || !node) return;
  const cx = node.getAttribute('cx');
  const cy = node.getAttribute('cy');
  token.setAttribute('transform', `translate(${cx}, ${cy - 55})`); // offset above current node
}

function onLevelNodeClick(e) {
  const level = Number(this.getAttribute('data-level'));
  const state = this.getAttribute('data-state');
  if (state !== 'current' && state !== 'completed') {
    return; // locked or future
  }
  openLevelModal(level);
}

function openLevelModal(levelNumber) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <button class="close-btn" aria-label="Close">×</button>
    <h2>Level ${levelNumber}</h2>
    <p>This is a placeholder for level gameplay. Complete to advance!</p>
    <div class="modal-footer">
      <button class="secondary" type="button" data-action="cancel">Close</button>
      <button class="primary" type="button" data-action="complete">Complete Level</button>
    </div>
  `;

  modal.querySelector('.close-btn').addEventListener('click', closeModal);
  modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
  modal.querySelector('[data-action="complete"]').addEventListener('click', () => {
    completeLevel(levelNumber);
    closeModal();
  });

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  // Focus trap minimal
  setTimeout(() => modal.querySelector('.primary').focus(), 50);
}

function closeModal() {
  const existing = document.querySelector('.modal-backdrop');
  if (existing) existing.remove();
}

function completeLevel(levelNumber) {
  if (levelNumber !== progress.current) return; // only complete current
  if (progress.current < LEVEL_COUNT) {
    progress.current += 1;
    saveProgress(progress);
    refreshLevelStates();
    positionPlayerToken(progress.current);
  }
}

function refreshLevelStates() {
  document.querySelectorAll('.level-node').forEach(node => {
    const level = Number(node.getAttribute('data-level'));
    node.setAttribute('data-state', computeLevelState(level, progress.current));
  });
  updateControlStates();
}

function updateControlStates() {
  const resetBtn = document.querySelector('[data-action="reset"]');
  if (resetBtn) {
    resetBtn.disabled = progress.current === 1;
  }
}

function resetProgress() {
  progress.current = 1;
  saveProgress(progress);
  refreshLevelStates();
  positionPlayerToken(progress.current);
}

function renderControls(container) {
  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.innerHTML = `
    <button type="button" data-action="reset" class="reset" aria-label="Reset progress">Reset Progress</button>
  `;
  controls.querySelector('[data-action="reset"]').addEventListener('click', () => {
    if (confirm('Reset your progress?')) resetProgress();
  });
  container.appendChild(controls);
  updateControlStates();
}

function init() {
  const app = document.getElementById('app');
  const title = document.createElement('h1');
  title.className = 'title';
  title.textContent = 'Trail Map Demo';
  app.appendChild(title);

  renderMap(app);
  renderControls(app);
}

window.addEventListener('DOMContentLoaded', init);
