import { Application, Container, Graphics, Text, TextStyle, Circle, Sprite, Texture, Assets } from 'pixi.js';

/* Vertical Candy-Crush-like Trail
 - Levels start at bottom and ascend upwards
 - Only ~8 levels visible via camera window height
 - Top area fades out (handled with DOM/CSS gradient overlay added separately)
 - Randomized slight jitter for organic feel
*/

const LEVEL_COUNT = 30;
const STORAGE_KEY = 'trailProgressV2';
const VISIBLE_LEVEL_WINDOW = 8; // approximate number of levels visible

interface ProgressState { current: number }
interface LevelPos { x: number; y: number }
interface ManualPatternNode { x: number; yOffset?: number }
interface LevelNode { level: number; container: Container; circle: Graphics; label: Text }
interface Connector { from: number; to: number; line: Graphics }

// Declare node/connector storage early so buildTrail can populate them
const levelNodes: LevelNode[] = [];
const connectors: Connector[] = [];

function loadProgress(): ProgressState { try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return { current: 1 }; const data = JSON.parse(raw); if (typeof data.current !== 'number' || data.current < 1 || data.current > LEVEL_COUNT) return { current: 1 }; return data; } catch { return { current: 1 }; } }
function saveProgress(state: ProgressState) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
const progress = loadProgress();

// ---------------------------------------------------------------------------------
// Manual pattern support
// Edit the array below to manually position the FIRST 10 tiles (relative X offsets)
// Optional: provide small yOffset adjustments (positive pushes the level LOWER).
// Those 10 entries will then repeat for the entire trail.
// To realign the whole pattern horizontally, adjust values OR shift center via RIVER_RELATIVE_X.
// Example tweak: reduce large swings, make a gentle meander, etc.
// ---------------------------------------------------------------------------------
const MANUAL_PATTERN: ManualPatternNode[] = [
  { x: -200 }, // Level 1 pattern position
  { x: -180 },
  { x:  -130 },
  { x:  -80 },
  { x: -70 },
  { x:  -100 },
  { x:  -180 },
  { x: -180 },
  { x: -130 },
  { x: -70 }, // Level 10 pattern position,
  { x: -70 }, 
  { x: -95 }, 
  { x: -180 }, 
];

// Generate vertical positions from bottom to top using the MANUAL_PATTERN repeated.
function generateVerticalPositions(count: number): LevelPos[] {
  const arr: LevelPos[] = [];
  const baseSpacing = 160; // vertical distance between pattern rows
  const patternLen = MANUAL_PATTERN.length;
  const centerX = 400; // design center (half of 800 logical width reference)
  // totalHeight uses uniform spacing to maintain camera math simplicity
  const totalHeight = baseSpacing * (count - 1) + 300;
  for (let i = 0; i < count; i++) {
    const pattern = MANUAL_PATTERN[i % patternLen];
    const yFromBottom = 150 + i * baseSpacing + (pattern.yOffset || 0);
    const y = (totalHeight - yFromBottom);
    const x = centerX + pattern.x; // relative offset from center
    arr.push({ x, y });
  }
  return arr;
}

// Deterministic pseudo-random for reproducibility
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed) * 10000; return x - Math.floor(x);
}

const positions = generateVerticalPositions(LEVEL_COUNT);

let viewWidth = 800;
let viewHeight = 900;
function computeViewport() {
  const isPortrait = window.innerHeight >= window.innerWidth;
  const maxWidth = 540; // narrower on mobile portrait
  viewWidth = Math.min(maxWidth, window.innerWidth - 8);
  viewWidth = Math.max(360, viewWidth);
  // Maintain similar aspect but allow taller viewport
  viewHeight = Math.min(window.innerHeight - 12, 1100);
  viewHeight = Math.max(640, viewHeight);
}
computeViewport();

// Dynamic canvas viewport (no CSS scaling). Height of world independent.
const height = Math.max(1600, Math.max(...positions.map(p => p.y)) + 300); // ensure tail room

const app = new Application();

// Background layer (will parallax scroll vertically with world; stays decoupled horizontally)
const backgroundLayer = new Container(); // jungle tiles (now locked to world movement: no parallax)
const world = new Container(); // moves with camera
const trailLayer = new Container();
const levelLayer = new Container();
const fxLayer = new Container();
world.addChild(trailLayer, levelLayer, fxLayer);
app.stage.addChild(backgroundLayer);
app.stage.addChild(world);

async function initApp() {
  await app.init({ backgroundAlpha: 0, antialias: true, width: viewWidth, height: viewHeight, autoDensity: true });
  const rootEl = document.getElementById('pixi-root');
  if (!rootEl) throw new Error('Missing pixi-root');
  rootEl.appendChild(app.canvas);
  ensureFadeOverlay(rootEl);
  window.addEventListener('resize', handleResize);

  await buildBackground();
  buildTrail();
  createLevels();
  createPlayerToken();
  renderControls();
  refreshStates();
  centerCameraOnLevel(progress.current, true);
}

function buildTrail() {
  // Wide ribbon
  const g = new Graphics();
  (g as any).lineStyle(34, 0x2f4256, 1);
  g.moveTo(positions[0].x, positions[0].y);
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i];
    const prev = positions[i - 1];
    const cx = (prev.x + p.x) / 2 + Math.sin(i * 0.7) * 40;
    const cy = (prev.y + p.y) / 2 + Math.cos(i * 0.45) * 60;
    g.quadraticCurveTo(cx, cy, p.x, p.y);
  }
  g.alpha = 0.9;
  trailLayer.addChild(g);
  // Slim directional connectors
  for (let i = 0; i < positions.length - 1; i++) {
    const line = new Graphics();
    connectors.push({ from: i + 1, to: i + 2, line });
    trailLayer.addChild(line);
  }
  connectors.forEach(c => drawConnector(c.line, c.from, c.to));
}

// --- Jungle background tiling ---
let jungleTexture: Texture | null = null;
let jungleTileHeight = 0; // cache for parallax bounds
async function buildBackground() {
  // Clear previous tiles
  backgroundLayer.removeChildren();
  // Lazy load (with multi-path fallback) only once
  if (!jungleTexture) {
    const candidatePaths = [
      'assets/jungle/jungle_background.png', // dev path (original source tree)
      'jungle/jungle_background.png',        // GitHub Pages output (observed in docs/)
      './assets/jungle/jungle_background.png',
      './jungle/jungle_background.png'
    ];
    let loaded: Texture | null = null;
    for (const p of candidatePaths) {
      try {
        loaded = await Assets.load(p);
        if (loaded) {
          console.info('[background] Loaded jungle texture from', p);
          break;
        }
      } catch (err) {
        // Try next
        console.debug('[background] Path failed, trying next:', p, err);
      }
    }
    if (!loaded) {
      console.warn('[background] Unable to load jungle background from any candidate path.');
      return;
    }
    jungleTexture = loaded;
  }
  if (!jungleTexture) return;
  // Expand tile width slightly to avoid edge gaps when camera recenters horizontally
  const padding = Math.max(120, Math.round(viewWidth * 0.2)); // dynamic overdraw
  const tileW = viewWidth + padding;
  const aspect = jungleTexture.height / jungleTexture.width || 1;
  const tileH = Math.round(tileW * aspect);
  if (tileH <= 0) return;
  jungleTileHeight = tileH;
  // We want to cover full world height + one extra tile for scrolling overlap
  const totalH = height + viewHeight + tileH; // little extra so parallax shift never exposes gap
  for (let y = 0; y < totalH; y += tileH) {
    const s = new Sprite(jungleTexture as Texture);
  // Keep centered regardless of world (camera) horizontal movement
  s.x = (viewWidth - tileW) / 2;
    s.y = y;
    s.width = tileW;
    s.height = tileH;
    s.alpha = 1;
    backgroundLayer.addChild(s);
  }
}

function drawConnector(g: Graphics, fromLevel: number, toLevel: number) {
  g.clear();
  const a = positions[fromLevel - 1];
  const b = positions[toLevel - 1];
  const fromState = computeState(fromLevel);
  const toState = computeState(toLevel);
  let color = 0x384651; // locked default
  if (fromState === 'completed') color = 0x4caf50;
  if (fromState === 'current') color = 0xff9f43;
  if (fromState === 'completed' && (toState === 'current' || toState === 'unlocked' || toState === 'completed')) color = 0x4caf50;
  (g as any).lineStyle(8, color, 1);
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.alpha = fromState === 'locked' ? 0.35 : 0.95;
}

const baseStyle = new TextStyle({ fill: '#ffffff', fontSize: 20, fontWeight: '600', stroke: '#000000' });

function computeState(level: number): 'completed' | 'current' | 'unlocked' | 'locked' {
  if (level < progress.current) return 'completed';
  if (level === progress.current) return 'current';
  if (level === progress.current + 1) return 'unlocked';
  return 'locked';
}

function createLevels() {
  positions.forEach((pos, idx) => {
    const levelNumber = idx + 1;
    const container = new Container();
    container.x = pos.x; container.y = pos.y;
    container.eventMode = 'static';
    container.cursor = 'pointer';

    const circle = new Graphics();
    drawCircleForState(circle, computeState(levelNumber));

    const label = new Text({ text: String(levelNumber), style: baseStyle });
    label.anchor.set(0.5);
    circle.x = 0; circle.y = 0;
    label.x = 0; label.y = 2;

    container.addChild(circle, label);

    // Use Pixi geometric Circle for accurate hit testing
    container.hitArea = new Circle(0, 0, 38);

    container.on('pointertap', () => handleLevelClick(levelNumber));
    container.on('pointerover', () => { container.scale.set(1.08); });
    container.on('pointerout', () => { container.scale.set(1); });

    levelLayer.addChild(container);
    levelNodes.push({ level: levelNumber, container, circle, label });
  });
}

let playerToken: Container | null = null;
function createPlayerToken() {
  const c = new Container();
  c.eventMode = 'none'; // ignore pointer events entirely
  const body = new Graphics();
  body.beginFill(0xff9f43); body.drawCircle(0, 0, 26); body.endFill();
  const txt = new Text({ text: 'YOU', style: new TextStyle({ fill: '#fff', fontSize: 16, fontWeight: '700', stroke: '#000' }) });
  txt.anchor.set(0.5);
  c.addChild(body, txt);
  fxLayer.addChild(c);
  playerToken = c;
  positionPlayer(progress.current, true);
}

function positionPlayer(level: number, instant = false) {
  const pos = positions[level - 1];
  if (!playerToken) return;
  const targetY = pos.y - 80; // offset above
  if (instant) { playerToken.position.set(pos.x, targetY); return; }
  tween(playerToken, { x: pos.x, y: targetY }, 600, easeInOutCubic);
}

function drawCircleForState(g: Graphics, state: ReturnType<typeof computeState>) {
  g.clear();
  // Color scheme update:
  // completed -> green, current -> accent orange, unlocked -> neutral (light gray), locked -> darker gray
  let fill = 0x3d444c; // locked base
  if (state === 'completed') fill = 0x4caf50; // green for completed
  else if (state === 'current') fill = 0xff9f43; // accent
  else if (state === 'unlocked') fill = 0x5a6470; // neutral mid tone (no green highlight)
  (g as any).lineStyle(4, 0x182028, 1);
  g.beginFill(fill);
  g.drawCircle(0, 0, 38);
  g.endFill();
}

function refreshStates() {
  levelNodes.forEach(n => {
    const st = computeState(n.level);
    drawCircleForState(n.circle, st);
    const interactive = (st === 'current' || st === 'completed' || st === 'unlocked');
    n.container.interactive = interactive;
    (n.container as any).eventMode = interactive ? 'static' : 'none';
    n.container.alpha = st === 'locked' ? 0.3 : 1;
  });
  connectors.forEach(c => drawConnector(c.line, c.from, c.to));
  updateResetButton();
}

function handleLevelClick(level: number) {
  const state = computeState(level);
  if (state !== 'current' && state !== 'completed') return;
  openModal(level);
}

function completeLevel(level: number) {
  if (level !== progress.current) return;
  if (progress.current < LEVEL_COUNT) {
    progress.current += 1;
    saveProgress(progress);
    refreshStates();
    positionPlayer(progress.current);
    centerCameraOnLevel(progress.current);
  }
}

// Camera logic: center around the player's current level keeping window of ~8 levels visible.
// (Optional) Horizontal adjustment constant retained for fine tuning if the river artwork isn't perfectly centered.
const RIVER_RELATIVE_X = 0.47; // 0.5 means centered; tweak slightly if needed (e.g., 0.48 / 0.52)

function centerCameraOnLevel(level: number, instant = false) {
  const pos = positions[level - 1];
  const desiredCenterY = viewHeight / 2;
  const specialOffset = level === 1 ? 140 : 0;
  const targetYRaw = -(pos.y - (desiredCenterY + specialOffset));
  const minY = -(height - viewHeight);
  const targetY = clamp(targetYRaw, minY, 0);
  // Horizontal centering based on average X of nodes
  const avgX = positions.reduce((s,p)=>s+p.x,0)/positions.length;
  // Horizontal camera center (avg positions) adjusted by relative factor
  const targetX = -(avgX - (viewWidth * RIVER_RELATIVE_X));
  const syncBackground = () => {
    // Keep background vertically synced, but do NOT move horizontally with camera
    backgroundLayer.y = world.position.y; // vertical lock (no parallax)
    backgroundLayer.x = 0; // horizontal decoupling keeps river centered
  };
  if (instant) {
    world.position.set(targetX, targetY);
    syncBackground();
    return;
  }
  tween(world, { x: targetX, y: targetY }, 600, easeInOutCubic, syncBackground);
}

// Simple tween utility
interface TweenTarget { x: number; y: number }
function tween(target: TweenTarget, to: Partial<TweenTarget>, duration: number, ease: (t:number)=>number, onUpdate?: () => void) {
  const fromX = target.x; const fromY = target.y; const toX = to.x ?? target.x; const toY = to.y ?? target.y; const start = performance.now();
  function frame(now: number) {
    const t = Math.min(1, (now - start) / duration);
    const e = ease(t);
    target.x = fromX + (toX - fromX) * e;
    target.y = fromY + (toY - fromY) * e;
    if (onUpdate) onUpdate();
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Easing functions
function easeInOutCubic(t: number) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }

// Clamp helper
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

// DOM controls & modal
function renderControls() {
  let controls = document.querySelector('.controls');
  if (!controls) {
    controls = document.createElement('div');
    controls.className = 'controls';
    controls.innerHTML = `<button type="button" data-action="reset" class="reset" aria-label="Reset progress">Reset Progress</button>`;
    document.getElementById('app')?.appendChild(controls);
  }
  controls.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
    if (confirm('Reset your progress?')) {
      progress.current = 1;
      saveProgress(progress);
      refreshStates();
      positionPlayer(progress.current, true);
      centerCameraOnLevel(progress.current, true);
    }
  });
  updateResetButton();
}
function updateResetButton() { const btn = document.querySelector('[data-action="reset"]') as HTMLButtonElement | null; if (btn) btn.disabled = progress.current === 1; }

function openModal(level: number) {
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role','dialog');
  modal.innerHTML = `
    <button class="close-btn" aria-label="Close">×</button>
    <h2>Level ${level}</h2>
    <p>Placeholder content for level ${level}. Complete to advance.</p>
    <div class="modal-footer">
      <button class="secondary" type="button" data-action="cancel">Close</button>
      <button class="primary" type="button" data-action="complete">Complete Level</button>
    </div>`;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  modal.querySelector('.close-btn')?.addEventListener('click', closeModal);
  modal.querySelector('[data-action="cancel"]')?.addEventListener('click', closeModal);
  modal.querySelector('[data-action="complete"]')?.addEventListener('click', () => { completeLevel(level); closeModal(); });
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  setTimeout(() => (modal.querySelector('[data-action="complete"]') as HTMLButtonElement)?.focus(), 30);
}
function closeModal() { document.querySelector('.modal-backdrop')?.remove(); }

// Fade overlay (CSS gradient) inserted once
function ensureFadeOverlay(root: HTMLElement) {
  // Narrow fade restricted to the game area's width (inside #pixi-root)
  let fade = root.querySelector('.fade-top') as HTMLDivElement | null;
  if (!fade) {
    fade = document.createElement('div');
    fade.className = 'fade-top';
    root.appendChild(fade);
  }
  root.style.position = 'relative';
  fade.style.position = 'absolute';
  fade.style.top = '0';
  fade.style.left = '0';
  // Expand 112px beyond the current game width to cover missing area on the right
  fade.style.right = 'auto';
  fade.style.width = 'calc(100%)';
  fade.style.margin = '0 auto';
  fade.style.height = '170px';
  fade.style.pointerEvents = 'none';
  fade.style.zIndex = '20';
  fade.style.background = 'linear-gradient(to bottom, rgba(15,16,20,0.95) 0%, rgba(15,16,20,0.85) 22%, rgba(15,16,20,0.5) 60%, rgba(15,16,20,0) 100%)';
  fade.style.mixBlendMode = 'normal';
}

function handleResize() {
  const prevLevel = progress.current;
  computeViewport();
  app.renderer.resize(viewWidth, viewHeight);
  // Rebuild jungle tiles to fit new width
  buildBackground();
  centerCameraOnLevel(prevLevel, true);
  // Ensure background locked to world after resize
  backgroundLayer.y = world.position.y;
  backgroundLayer.x = 0;
}

// Kick off
initApp();
