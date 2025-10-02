import { Application, Container, Graphics, Text, TextStyle, Circle, Sprite, Texture, Assets } from 'pixi.js';
import { isTutorialActive, getTutorialPlanForDay, TutorialDayPlan } from './tutorialPlan';
import jungleBackgroundUrl from '../assets/jungle/jungle_background.png';
import carnivalBackgroundUrl from '../assets/carnival/carnival_background.png';
import tokenIconUrl from '../assets/general/token.svg';
import carnivalCharacterUrl from '../assets/carnival/carnival_character.png';

/* Vertical Candy-Crush-like Trail
 - Levels start at bottom and ascend upwards
 - Only ~8 levels visible via camera window height
 - Top area fades out (handled with DOM/CSS gradient overlay added separately)
 - Randomized slight jitter for organic feel
*/

let LEVEL_COUNT = 30; // becomes 100 after tutorial ends
const STORAGE_KEY = 'trailProgressV2';
const TOKEN_STORAGE_KEY = 'tokensV1';
const VISIBLE_LEVEL_WINDOW = 8; // we want: current + 7 ahead visible
// Visual paddings: top fade area + space above first visible future node; bottom contains dice bar & breathing room.
let TOP_VISIBLE_PADDING = 140;
let BOTTOM_VISIBLE_PADDING = 260; // includes dice bar clearance

// Dynamic tile radius (updated on viewport compute) so tiles scale slightly on small screens but capped on large.
let TILE_RADIUS = 38; // default; recomputed each resize

// ---------------- Zones ----------------
// Zone 1: Jungle (levels 1-14) | Zone 2: Carnival (levels 15-30)
const ZONE_BOUNDARY_LEVEL = 15; // entering this level begins Carnival zone
interface ZoneDef { id: string; startLevel: number; bgTexture?: Texture|null; }
const ZONES: ZoneDef[] = [
  { id: 'Jungle', startLevel: 1 },
  { id: 'Carnival', startLevel: ZONE_BOUNDARY_LEVEL }
];
let currentZoneId = 'Jungle'; // Forced to 'Carnival' during tutorial days (1-8)

interface ProgressState { current: number }
interface LevelPos { x: number; y: number }
interface ManualPatternNode { x: number; yOffset?: number }
interface LevelNode { level: number; container: Container; circle: Graphics; label: Text }
interface Connector { from: number; to: number; line: Graphics }

// ---------------- Minigame, Category & Rewards Types ----------------
type MinigameId = 'slot' | 'spin_wheel' | 'lootbox';
interface MinigameAssignment { level: number; game: MinigameId; completed: boolean; }
interface Reward { kind: 'tokens' | 'freePlays' | 'cash' | 'bonus' | 'streakKeys' | 'prizeStars' | 'nothing'; amount?: number; label: string }
// New tile categories replacing empties
type CategoryId = 'instant_tokens' | 'instant_prize' | 'reveal' | 'minigame' | 'bonus_round' | 'mystery' | 'extra_move' | 'travel_back';
interface CategoryAssignment { level:number; category: CategoryId; minigame?: MinigameId; completed?: boolean; resolvedAs?: CategoryId; tileId?: string; forcedReward?: Reward }

const MINIGAMES: MinigameId[] = ['slot','spin_wheel','lootbox'];
const MINIGAME_ASSIGN_KEY = 'minigameAssignmentsV1';
const CURRENCY_KEY = 'currenciesV1';
const CATEGORY_ASSIGN_KEY = 'categoryAssignmentsV1';
const DAY_STATE_KEY = 'dayStateV1';
const STREAK_STATE_KEY = 'streakStateV1'; // legacy key retained for migration
const LEVEL_STATE_KEY = 'levelStateV1';

interface DayState { day: number; rollUsed: boolean }
let dayState: DayState = { day: 1, rollUsed: false };
function loadDayState(){
  try {
    const raw = localStorage.getItem(DAY_STATE_KEY);
    if(!raw) return;
    const data = JSON.parse(raw);
    if(typeof data.day==='number' && data.day>=1 && typeof data.rollUsed==='boolean'){
      dayState.day = Math.floor(data.day);
      dayState.rollUsed = data.rollUsed;
    }
  } catch {}
}
function saveDayState(){ localStorage.setItem(DAY_STATE_KEY, JSON.stringify(dayState)); }

// Player level state (replaces streak)
interface LevelState { level: number }
let levelState: LevelState = { level: 1 };
function loadLevelState(){
  try {
    // Migrate legacy streak to level 1 if no level saved yet
    const raw = localStorage.getItem(LEVEL_STATE_KEY);
    if(raw){
      const data = JSON.parse(raw);
      if(typeof data.level==='number' && data.level>=1){ levelState.level = Math.floor(data.level); }
    } else {
      // If old streak existed, we could map it loosely (e.g., every 5 streaks = 1 level). For now just start at 1.
    }
  } catch {}
}
function saveLevelState(){ localStorage.setItem(LEVEL_STATE_KEY, JSON.stringify(levelState)); }

// Category assignments (supersede classic minigame-only approach)
let categoryAssignments: CategoryAssignment[] = [];
function loadCategoryAssignments(): boolean {
  try {
    const raw = localStorage.getItem(CATEGORY_ASSIGN_KEY);
    if(!raw) return false;
    const arr = JSON.parse(raw);
    if(Array.isArray(arr)){
  categoryAssignments = arr.filter(a=> typeof a.level==='number' && a.level>=1 && a.level<=LEVEL_COUNT && typeof a.category==='string');
  // Ensure tileId backfilled
  categoryAssignments.forEach(a=>{ if(!a.tileId) a.tileId = `tile_${a.level}`; });
      // Migration: remove direct movement tiles (extra_move/travel_back) so they only appear via mystery resolution
      let migrated = false;
      categoryAssignments.forEach(a=>{
        if((a.category==='extra_move' || a.category==='travel_back')){
          // Convert to unresolved mystery tile unless already completed; keep completion state if it was completed
          a.resolvedAs = undefined;
          a.category = 'mystery';
          migrated = true;
        }
      });
      if(migrated) saveCategoryAssignments();
      if(categoryAssignments.length===0){
        return false; // force regeneration
      }
      return true;
    }
  } catch {}
  return false;
}
function saveCategoryAssignments(){ localStorage.setItem(CATEGORY_ASSIGN_KEY, JSON.stringify(categoryAssignments)); }
function shuffle<T>(arr:T[]):T[]{ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];} return arr; }
function generateCategoryAssignments(){
  const levels = Array.from({length:LEVEL_COUNT},(_,i)=>i+1);
  // Choose minigame levels (excluding level 1)
  const mgLevels = shuffle(levels.slice(1)).slice(0, MINIGAMES.length);
  const used = new Set<number>(mgLevels);
  const assignments: CategoryAssignment[] = mgLevels.map((lvl,i)=>({ level:lvl, category:'minigame', minigame: MINIGAMES[i], completed:false, tileId:`tile_${lvl}` }));
  // Mandatory categories ensure coverage (movement tiles removed from direct pool; only appear via mystery resolution)
  const mandatory: CategoryId[] = ['instant_tokens','instant_prize','reveal','bonus_round','mystery'];
  const remain = shuffle(levels.slice(1).filter(l=> !used.has(l))); // keep level 1 separate
  mandatory.forEach((cat,i)=>{ if(remain[i]!==undefined){ const lvl = remain[i]; assignments.push({ level: lvl, category: cat, tileId:`tile_${lvl}` }); used.add(lvl); } });
  // Level 1 always a simple instant token tile
  assignments.push({ level:1, category:'instant_tokens', completed:false, tileId:'tile_1' }); used.add(1);
  // Fill gaps (movement categories removed from direct generation)
  const fillPool: CategoryId[] = ['instant_tokens','instant_prize','reveal','mystery','minigame'];
  levels.forEach(l=>{
    if(!used.has(l)){
      const cat = fillPool[Math.floor(Math.random()*fillPool.length)];
      if(cat==='minigame'){
        const unused = MINIGAMES.filter(m=> !assignments.some(a=>a.minigame===m));
        if(unused.length){ assignments.push({ level:l, category:'minigame', minigame: unused[0], completed:false, tileId:`tile_${l}` }); }
        else assignments.push({ level:l, category:'instant_tokens', completed:false, tileId:`tile_${l}` });
      } else assignments.push({ level:l, category:cat, tileId:`tile_${l}` });
    }
  });
  categoryAssignments = assignments.sort((a,b)=>a.level-b.level);
  saveCategoryAssignments();
}
function ensureCategoryAssignments(){ if(!loadCategoryAssignments()) generateCategoryAssignments(); }
function getCategoryAssignment(level:number){ return categoryAssignments.find(a=>a.level===level); }
function getCategoryAssignmentByTileId(tileId:string){ return categoryAssignments.find(a=> a.tileId===tileId); }

// Expose developer helper to force a specific reward on an instant_prize tile
(window as any).forceTileReward = function(tileId:string, reward: Reward){
  const assign = getCategoryAssignmentByTileId(tileId);
  if(!assign){ console.warn('Tile not found for id', tileId); return; }
  if(assign.category!=='instant_prize'){ console.warn('Tile is not an instant_prize category; current:', assign.category); }
  assign.forcedReward = reward;
  saveCategoryAssignments();
  console.log('Forced reward set on', tileId, reward);
};

// One-off landing category override for next landing only (debug)
let nextLandingCategoryOverride: CategoryId | null = null;
(window as any).overrideLandingCategoryOnce = function(cat:CategoryId){
  nextLandingCategoryOverride = cat; console.log('Next landing category will be forced to', cat);
};

// Reward catalogue
const REWARDS: Reward[] = [
  { kind:'freePlays', amount:1, label:'1 Free Play' },
  { kind:'freePlays', amount:5, label:'5 Free Plays' },
  { kind:'cash', amount:10, label:'10p Cash' },
  { kind:'cash', amount:100, label:'£1 Cash' },
  { kind:'bonus', amount:50, label:'50p Bonus Money' },
  { kind:'bonus', amount:100, label:'£1 Bonus Money' },
  { kind:'bonus', amount:500, label:'£5 Bonus Money' },
  { kind:'tokens', amount:10, label:'10 Tokens' },
  { kind:'tokens', amount:50, label:'50 Tokens' },
  { kind:'tokens', amount:100, label:'100 Tokens' },
  { kind:'nothing', label:'Nothing' }
];

// Currency state
let freePlays = 0; // integer count
let cashPence = 0; // store pence (100 == £1)
let bonusPence = 0; // bonus money in pence
let streakKeys = 0; // new currency type
let prizeStars = 0; // new currency type

function loadCurrencies() {
  try {
    const raw = localStorage.getItem(CURRENCY_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.freePlays === 'number') freePlays = data.freePlays;
    if (typeof data.cashPence === 'number') cashPence = data.cashPence;
    if (typeof data.bonusPence === 'number') bonusPence = data.bonusPence;
    if (typeof data.streakKeys === 'number') streakKeys = data.streakKeys;
    if (typeof data.prizeStars === 'number') prizeStars = data.prizeStars;
  } catch {}
}
function saveCurrencies() {
  localStorage.setItem(CURRENCY_KEY, JSON.stringify({ freePlays, cashPence, bonusPence, streakKeys, prizeStars }));
}

function addFreePlays(n:number){ if(n>0){ freePlays+=n; saveCurrencies(); updateCurrencyCounters(); } }
function addCashPence(n:number){ if(n>0){ cashPence+=n; saveCurrencies(); updateCurrencyCounters(); } }
function addBonusPence(n:number){ if(n>0){ bonusPence+=n; saveCurrencies(); updateCurrencyCounters(); } }
function addStreakKeys(n:number){ if(n>0){ streakKeys+=n; saveCurrencies(); updateCurrencyCounters(); } }
function addPrizeStars(n:number){ if(n>0){ prizeStars+=n; saveCurrencies(); updateCurrencyCounters(); } }

// Minigame assignments
let minigameAssignments: MinigameAssignment[] = [];
function loadMinigameAssignments() {
    ensureResetFab();
  try {
    const raw = localStorage.getItem(MINIGAME_ASSIGN_KEY);
    if (!raw) return false;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const filtered = arr.filter(a => a && typeof a.level === 'number' && MINIGAMES.includes(a.game));
      const removed = arr.length - filtered.length;
      // If after filtering we don't have a full set for current roster, regenerate fresh to spread them out
      if (filtered.length < MINIGAMES.length) {
        generateMinigameAssignments();
        return true;
      }
      minigameAssignments = filtered;
      // Persist sanitized list if anything was removed
      if (removed > 0) saveMinigameAssignments();
      return true;
    }
  } catch {}
  return false;
}
function saveMinigameAssignments() { localStorage.setItem(MINIGAME_ASSIGN_KEY, JSON.stringify(minigameAssignments)); }
function generateMinigameAssignments() {
  const availableLevels = Array.from({length: LEVEL_COUNT-1}, (_,i)=>i+2); // exclude level 1
  // Shuffle
  for (let i=availableLevels.length-1;i>0;i--){ const j=Math.floor(Math.random()* (i+1)); [availableLevels[i],availableLevels[j]]=[availableLevels[j],availableLevels[i]]; }
  const chosen = availableLevels.slice(0, MINIGAMES.length);
  minigameAssignments = chosen.map((level, idx) => ({ level, game: MINIGAMES[idx], completed:false }));
  saveMinigameAssignments();
}
function getAssignmentForLevel(level:number){ return minigameAssignments.find(a=>a.level===level); }

function ensureMinigameAssignments(){ if(!loadMinigameAssignments()) generateMinigameAssignments(); }

function formatCash(pence:number){ if(pence < 100) return pence + 'p'; const pounds = (pence/100).toFixed(pence%100===0?0:2); return '£'+pounds; }

function selectReward(): Reward {
  // During tutorial days, suppress 'nothing' outcomes to keep early experience rewarding
  if(isTutorialActive(dayState.day)){
    const filtered = REWARDS.filter(r=> r.kind!=='nothing');
    return filtered[Math.floor(Math.random()*filtered.length)];
  }
  return REWARDS[Math.floor(Math.random()*REWARDS.length)];
}
function applyReward(r: Reward){
  if(r.kind==='tokens' && r.amount) addTokens(r.amount);
  else if(r.kind==='freePlays' && r.amount) addFreePlays(r.amount);
  else if(r.kind==='cash' && r.amount) addCashPence(r.amount);
  else if(r.kind==='bonus' && r.amount) addBonusPence(r.amount);
  else if(r.kind==='streakKeys' && r.amount) addStreakKeys(r.amount);
  else if(r.kind==='prizeStars' && r.amount) addPrizeStars(r.amount);
  updateCurrencyCounters();
}

// Helper to format appended meta reward line
function formatMetaBonusLine(){
  return `<p class='meta-bonus-line' style="margin-top:10px;font-size:13px;opacity:.85;"><strong>+1 🔑 Streak Key</strong> & <strong>+1 ⭐ Prize Star</strong></p>`;
}

// Declare node/connector storage early so buildTrail can populate them
const levelNodes: LevelNode[] = [];
const connectors: Connector[] = [];

function loadProgress(): ProgressState { try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return { current: 1 }; const data = JSON.parse(raw); if (typeof data.current !== 'number' || data.current < 1 || data.current > LEVEL_COUNT) return { current: 1 }; return data; } catch { return { current: 1 }; } }
function saveProgress(state: ProgressState) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
const progress = loadProgress();

// Track whether a multi-step movement animation (advance or retreat) is currently playing so we can delay UI like Next Day button
let movementInProgress = false;

// ---------------------------------------------------------------------------------
// Full manual layout (one entry per level) for horizontal meander & small vertical nudges.
// x: relative horizontal offset from center; yOffset: adds/subtracts pixels to the base vertical step for local variety.
// Adjust freely without affecting spacing logic elsewhere. BASE_LEVEL_SPACING controls the uniform vertical rhythm.
// ---------------------------------------------------------------------------------
const LEVEL_LAYOUT: ManualPatternNode[] = [
  { x: -200 }, // 1
  { x: -180 }, // 2
  { x: -130 }, // 3
  { x:  -80 }, // 4
  { x:  -70 }, // 5
  { x: -100 }, // 6
  { x: -180 }, // 7
  { x: -180 }, // 8
  { x: -130 }, // 9
  { x:  -70 }, // 10
  { x:  -60 }, // 11
  { x:  -95 }, // 12
  { x: -150 }, // 13
  { x: -190 }, // 14
  { x: -160 }, // 15
  { x: -110 }, // 16
  { x:  -80 }, // 17
  { x: -120 }, // 18
  { x: -170 }, // 19
  { x: -155 }, // 20
  { x: -115 }, // 21
  { x:  -85 }, // 22
  { x:  -95 }, // 23
  { x: -140 }, // 24
  { x: -185 }, // 25
  { x: -175 }, // 26
  { x: -145 }, // 27
  { x: -110 }, // 28
  { x:  -90 }, // 29
  { x: -130 }, // 30
];

// Fixed base spacing (design units). We keep this constant across resolutions and only scale tile radius.
const BASE_LEVEL_SPACING = 140; // tweak for tighter/looser vertical rhythm
function computeBaseSpacing(): number { return BASE_LEVEL_SPACING; }

// Generate vertical positions bottom->top using manual pattern & dynamic spacing
function generateVerticalPositions(count: number): LevelPos[] {
  const spacing = computeBaseSpacing();
  const centerX = 400;
  const arr: LevelPos[] = [];
  // Total height computed from fixed spacing (still used for camera clamping/background tiling)
  const totalHeight = spacing * (count - 1) + TOP_VISIBLE_PADDING + BOTTOM_VISIBLE_PADDING;
  for (let i = 0; i < count; i++) {
    const layout = LEVEL_LAYOUT[i] || LEVEL_LAYOUT[LEVEL_LAYOUT.length - 1];
    const yFromBottom = BOTTOM_VISIBLE_PADDING + i * spacing + (layout.yOffset || 0);
    const y = totalHeight - yFromBottom;
    const x = centerX + layout.x;
    arr.push({ x, y });
  }
  return arr;
}

// Deterministic pseudo-random for reproducibility
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed) * 10000; return x - Math.floor(x);
}

let viewWidth = 800;
let viewHeight = 900;
function computeViewport() {
  const isPortrait = window.innerHeight >= window.innerWidth;
  // Use 600px to align with #pixi-root max-width and fade overlay width so background spans fully
  const maxWidth = 600;
  viewWidth = Math.min(maxWidth, window.innerWidth - 8);
  viewWidth = Math.max(360, viewWidth);
  viewHeight = Math.min(window.innerHeight - 12, 1100);
  viewHeight = Math.max(640, viewHeight);
  // Recompute tile radius responsively: base 38 at 600w, scale down to ~30 at 360w.
  const t = (viewWidth - 360) / (600 - 360); // 0..1
  TILE_RADIUS = 30 + (38 - 30) * clamp(t, 0, 1);
  // Adjust paddings slightly on very short heights to avoid clipping
  if (viewHeight < 760) {
    TOP_VISIBLE_PADDING = 120;
    BOTTOM_VISIBLE_PADDING = 230;
  } else {
    TOP_VISIBLE_PADDING = 140;
    BOTTOM_VISIBLE_PADDING = 260;
  }
}
computeViewport();

// Token state
let tokens = 0;
function loadTokens() { try { const raw = localStorage.getItem(TOKEN_STORAGE_KEY); if(!raw) return 0; const n = Number(raw); return Number.isFinite(n)&&n>=0?Math.floor(n):0; } catch { return 0; } }
function saveTokens() { localStorage.setItem(TOKEN_STORAGE_KEY, String(tokens)); }
// (removed duplicate updateTokenCounter definition - consolidated earlier)
// Dual-choice milestone flags
let tokenDualPopupReady = false; // becomes true once threshold crossed
let tokenDualPopupConsumed = false; // set true once popup opened & tokens deducted
function addTokens(n:number){
  if(n>0){
    const prev = tokens;
    tokens+=n; saveTokens(); updateTokenCounter();
    if(!tokenDualPopupConsumed && prev < 120 && tokens >= 120){
      tokenDualPopupReady = true; // will be shown end-of-day
    }
  }
}
tokens = loadTokens();

let positions = generateVerticalPositions(LEVEL_COUNT);
let height = Math.max(1600, Math.max(...positions.map(p=>p.y))+400);

const app = new Application();

// Background layers (each zone gets its own tiled container for cross-fade)
const backgroundLayer = new Container(); // parent
const jungleLayer = new Container();
const carnivalLayer = new Container();
backgroundLayer.addChild(jungleLayer, carnivalLayer);
const world = new Container(); // moves with camera
const trailLayer = new Container();
const levelLayer = new Container();
const fxLayer = new Container();
world.addChild(trailLayer, levelLayer, fxLayer);
app.stage.addChild(backgroundLayer);
app.stage.addChild(world);

async function initApp() {
  loadCurrencies();
  loadDayState();
  loadLevelState();
  ensureCategoryAssignments(); // new category system (includes embedded minigames)
  await app.init({ backgroundAlpha: 0, antialias: true, width: viewWidth, height: viewHeight, autoDensity: true });
  const rootEl = document.getElementById('pixi-root');
  if (!rootEl) throw new Error('Missing pixi-root');
  rootEl.appendChild(app.canvas);
  ensureFadeOverlay(rootEl);
  window.addEventListener('resize', handleResize);
  initDebugOverlay();

  await buildBackground();
  buildTrail();
  createLevels();
  createPlayerToken();
  renderControls();
  renderRecenterButton();
  enableFreeScroll(rootEl);
  renderDice();
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
let carnivalTexture: Texture | null = null;
let jungleTileHeight = 0;
let carnivalTileHeight = 0;

async function buildBackground() {
  jungleLayer.removeChildren();
  carnivalLayer.removeChildren();
  if(!jungleTexture){ try { jungleTexture = await Assets.load(jungleBackgroundUrl);} catch(e){ console.warn('Failed to load jungle', e); } }
  if(!carnivalTexture){ try { carnivalTexture = await Assets.load(carnivalBackgroundUrl);} catch(e){ console.warn('Failed to load carnival', e); } }
  const OVERDRAW_X = 100;
  const HEIGHT_MULT = 1.28;
  const tileW = viewWidth + OVERDRAW_X;
  function tileLayer(tex:Texture|null, layer:Container, storeHeight:(h:number)=>void){
    if(!tex) return;
    const scale = tileW / tex.width;
    const tileH = Math.round(tex.height * scale * HEIGHT_MULT);
    if(tileH<=0) return;
    storeHeight(tileH);
    const totalH = height + viewHeight + tileH;
    for(let y=0;y<totalH;y+=tileH){
      const s = new Sprite(tex);
      s.x = -(OVERDRAW_X/2);
      s.y = y;
      s.width = tileW;
      s.height = tileH;
      s.alpha = 1;
      layer.addChild(s);
    }
  }
  tileLayer(jungleTexture, jungleLayer, h=>jungleTileHeight=h);
  tileLayer(carnivalTexture, carnivalLayer, h=>carnivalTileHeight=h);
  updateZoneCrossfade();
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

function makeLevelTextStyle(): TextStyle {
  // Base font size scaled from TILE_RADIUS: radius 38 => ~20px, radius 30 => ~16px.
  const t = (TILE_RADIUS - 30) / (38 - 30); // 0..1
  const size = Math.round(16 + (20 - 16) * clamp(t, 0, 1));
  return new TextStyle({ fill: '#ffffff', fontSize: size, fontWeight: '600', stroke: '#000000' });
}
let levelLabelStyle = makeLevelTextStyle();

function computeState(level: number): 'completed' | 'current' | 'unlocked' | 'locked' {
  if (level < progress.current) return 'completed';
  if (level === progress.current) return 'current';
  if (level === progress.current + 1) return 'unlocked';
  return 'locked';
}

function createLevels(){
  positions.forEach((pos,idx)=>{
    const levelNumber = idx+1;
    const container = new Container(); container.x=pos.x; container.y=pos.y; container.eventMode='static'; container.cursor='pointer';
    const g = new Graphics();
    const catAssign = getCategoryAssignment(levelNumber);
    if(catAssign) drawCategoryShape(g, catAssign); else drawCircleForState(g, computeState(levelNumber));
    const label = new Text({ text:String(levelNumber), style: levelLabelStyle }); label.anchor.set(0.5); label.y=2;
    container.addChild(g,label);
    container.hitArea = new Circle(0,0,TILE_RADIUS);
    container.on('pointertap', ()=> handleLevelClick(levelNumber));
    container.on('pointerover', ()=> container.scale.set(1.08));
    container.on('pointerout', ()=> container.scale.set(1));
    levelLayer.addChild(container); levelNodes.push({ level: levelNumber, container, circle: g, label });
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

function positionPlayer(level: number, instant = false, duration = 600) {
  const pos = positions[level - 1];
  if (!playerToken) return;
  // Place player token to the RIGHT of the level circle instead of above.
  // Level circle radius ≈ 38; token radius ≈ 26. Provide some gap.
  const H_OFFSET = TILE_RADIUS + 26 + 12; // dynamic circle radius + token radius + gap
  const targetX = pos.x + H_OFFSET;
  const targetY = pos.y + 2; // slight vertical alignment with circle center / label
  if (instant) { playerToken.position.set(targetX, targetY); return; }
  tween(playerToken, { x: targetX, y: targetY }, duration, easeInOutCubic);
}

// ---------------- Zone Crossfade Logic ----------------
function levelToY(level:number){ return positions[level-1]?.y ?? 0; }
// Determine a vertical boundary Y using boundary level position; crossfade across a vertical band
function getZoneBoundaryY(){ return levelToY(ZONE_BOUNDARY_LEVEL); }
// Size of blend band in pixels (above & below boundary center)
const ZONE_BLEND_HALF = 400; // tune for smoother / longer transition
function updateZoneCrossfade(){
  // Compute midpoint of viewport (world space)
  const viewportMidYWorld = -world.position.y + viewHeight/2;
  const boundaryY = getZoneBoundaryY();
  const dy = viewportMidYWorld - boundaryY; // negative means below boundary (earlier levels)
  // Map dy into 0..1 fade: when dy <= -ZONE_BLEND_HALF => jungle=1; when dy >= ZONE_BLEND_HALF => carnival=1
  const t = clamp((dy + ZONE_BLEND_HALF) / (ZONE_BLEND_HALF*2), 0, 1);
  jungleLayer.alpha = 1 - t;
  carnivalLayer.alpha = t;
  if(isTutorialActive(dayState.day)) currentZoneId = 'Carnival'; else currentZoneId = t < 0.5 ? 'Jungle' : 'Carnival';
}

function drawCircleForState(g: Graphics, state: ReturnType<typeof computeState>) {
  g.clear();
  // Fallback (should rarely render because all tiles have categories). We no longer color passed tiles green;
  // only explicit category completion will render green via drawCategoryShape.
  let fill = 0x3d444c; // locked base
  if (state === 'current') fill = 0xff9f43; // accent for current
  else if (state === 'unlocked') fill = 0x5a6470; // upcoming next tile
  else if (state === 'completed') fill = 0x46525d; // previously passed but unresolved (neutral, not green)
  (g as any).lineStyle(4, 0x182028, 1);
  g.beginFill(fill);
  g.drawCircle(0, 0, TILE_RADIUS);
  g.endFill();
}

function drawCategoryShape(g:Graphics, assign:CategoryAssignment){
  g.clear();
  const state = computeState(assign.level);
  let fill = 0x3d444c; // default locked / future
  if(assign.completed) fill = 0x4caf50; // only true category completion is green
  else if(state==='current') fill = 0xff9f43; // current tile
  else if(state==='unlocked') fill = 0x5a6470; // immediate next tile
  else if(state==='completed') fill = 0x46525d; // passed but not resolved (neutral)
  (g as any).lineStyle(4,0x182028,1);
  g.beginFill(fill);
  const r = TILE_RADIUS;
  const cat = assign.category==='mystery' && assign.resolvedAs ? assign.resolvedAs : assign.category;
  switch(cat){
    case 'instant_tokens': g.drawCircle(0,0,r); break;
    case 'instant_prize': g.drawRoundedRect(-r,-r,r*2,r*2,10); break;
    case 'reveal': for(let i=0;i<6;i++){ const a=Math.PI/3*i - Math.PI/6; const x=Math.cos(a)*r; const y=Math.sin(a)*r; if(i===0) g.moveTo(x,y); else g.lineTo(x,y);} g.closePath(); break;
    case 'minigame': g.moveTo(0,-r); g.lineTo(r,0); g.lineTo(0,r); g.lineTo(-r,0); g.closePath(); break; // diamond
    case 'bonus_round': for(let i=0;i<10;i++){ const a=Math.PI/5*i - Math.PI/2; const rad=i%2===0? r: r*0.45; const x=Math.cos(a)*rad; const y=Math.sin(a)*rad; if(i===0) g.moveTo(x,y); else g.lineTo(x,y);} g.closePath(); break; // star
    case 'mystery': for(let i=0;i<5;i++){ const a=(Math.PI*2/5)*i - Math.PI/2; const x=Math.cos(a)*r; const y=Math.sin(a)*r; if(i===0) g.moveTo(x,y); else g.lineTo(x,y);} g.closePath(); break; // pentagon
    case 'extra_move': g.moveTo(0,-r); g.lineTo(r,r); g.lineTo(-r,r); g.closePath(); break; // up triangle
    case 'travel_back': g.moveTo(-r,-r); g.lineTo(r,-r); g.lineTo(0,r); g.closePath(); break; // down triangle
  }
  g.endFill();
}

function refreshStates(){
  levelNodes.forEach(n=>{
    const st = computeState(n.level);
    const assign = getCategoryAssignment(n.level);
  if(assign) drawCategoryShape(n.circle, assign); else drawCircleForState(n.circle, st);
    const interactive = (st==='current'||st==='completed'||st==='unlocked');
    (n.container as any).eventMode = interactive? 'static':'none';
    n.container.alpha = st==='locked'? 0.3:1;
  });
  connectors.forEach(c=> drawConnector(c.line,c.from,c.to));
  updateResetButton();
}

function handleLevelClick(level:number){
  const st = computeState(level); if(st!=='current' && st!=='completed') return;
  triggerCategoryInteraction(level,true);
}

function triggerCategoryInteraction(level:number, manual:boolean, depth=0){
  const assign = getCategoryAssignment(level); if(!assign){ openModal(level); return; }
  if(assign.completed) return;
  // Mystery resolution
  if(assign.category==='mystery' && !assign.resolvedAs){
    const pool: CategoryId[] = ['instant_tokens','instant_prize','reveal','minigame','bonus_round','extra_move','travel_back'];
    assign.resolvedAs = pool[Math.floor(Math.random()*pool.length)];
    saveCategoryAssignments(); refreshStates();
  }
  const eff: CategoryId = assign.category==='mystery' && assign.resolvedAs ? assign.resolvedAs : assign.category;
  // (Bonus round deferral now handled generically at landing sequence in advanceBy when post_move tutorial opens)
  if(eff==='minigame'){
    if(!assign.minigame || !MINIGAMES.includes(assign.minigame)){
      assign.minigame = MINIGAMES[Math.floor(Math.random()*MINIGAMES.length)];
      saveCategoryAssignments();
    }
    let mg = getAssignmentForLevel(assign.level);
    if(!mg){ mg = { level: assign.level, game: assign.minigame!, completed: !!assign.completed }; minigameAssignments.push(mg); saveMinigameAssignments(); }
    if(!mg.completed) openMinigameModal(mg); else openInfoModal('Minigame','Already completed.');
    return;
  }
  switch(eff){
    case 'instant_tokens': openInstantTokensModal(assign); break;
    case 'instant_prize': openInstantPrizeModal(assign); break;
    case 'reveal': openRevealModal(assign); break;
    case 'bonus_round': openBonusRoundModal(assign); break;
    case 'extra_move': openMoveChainModal(assign,true); break;
    case 'travel_back': openMoveChainModal(assign,false); break;
    default: if(depth<2) triggerCategoryInteraction(level, manual, depth+1); break;
  }
}

function completeLevel(level: number) {
  if (level !== progress.current) return;
  if (progress.current < LEVEL_COUNT) {
    progress.current += 1;
    saveProgress(progress);
    // Award 1 token per forward step landed on
    addTokens(1);
    refreshStates();
    positionPlayer(progress.current);
    centerCameraOnLevel(progress.current);
    // Auto-trigger the newly reached tile's category effect after manual completion advance
    setTimeout(()=>{ maybeAutoTriggerCategory(); }, 650);
  }
}

// Advance multiple levels (e.g., via dice roll) with sequential animation
function advanceBy(steps: number) {
  if (steps <= 0) return;
  const remaining = Math.min(steps, LEVEL_COUNT - progress.current);
  if (remaining <= 0) return;
  movementInProgress = true;
  // Tutorial clamp to targetLevel if defined
  const plan = getTutorialPlanForDay(dayState.day);
  let effective = remaining;
  if(plan && plan.targetLevel>0){
    const allowed = plan.targetLevel - progress.current;
    if(allowed < effective) effective = Math.max(0, allowed);
  }
  const sequence: number[] = [];
  for (let i = 0; i < effective; i++) sequence.push(progress.current + 1 + i);
  const stepDuration = 520; // ms per hop (camera tween 600 so shorten move tween)
  function hop() {
    if (!sequence.length) return;
    progress.current += 1;
    saveProgress(progress);
    // Award 1 token per hop
    addTokens(1);
    refreshStates();
    positionPlayer(progress.current, false, stepDuration - 50);
    centerCameraOnLevel(progress.current);
    if (sequence.length > 1) {
      sequence.shift();
      setTimeout(hop, stepDuration);
    } else {
      sequence.shift();
      // Final landing – attempt auto-trigger (minigame etc.)
      setTimeout(()=>{ 
        // Tutorial category override: mutate landed tile category before reward & popups
        const planNow = getTutorialPlanForDay(dayState.day);
        const forcedCat = nextLandingCategoryOverride || (planNow && planNow.forceLandingCategory);
        if(forcedCat){
          const assign = getCategoryAssignment(progress.current);
          if(assign){
            if(assign.category !== forcedCat){
              assign.category = forcedCat as CategoryId;
              // Clear resolved/minigame specifics if overwriting
              if(assign.category !== 'minigame'){ delete assign.minigame; }
              assign.completed = false; // ensure it's active
              saveCategoryAssignments();
              refreshStates();
            }
          }
          nextLandingCategoryOverride = null;
        }
        maybeApplyTutorialReward('post_move');
        const openedPostMove = maybeApplyTutorialPopups('post_move');
        // If we opened a post_move tutorial chain and the landed category is an immediate-resolution category, defer until tutorial closes
        const assign = getCategoryAssignment(progress.current);
        if(openedPostMove && assign){
          const effCat: CategoryId = assign.category==='mystery' && assign.resolvedAs ? assign.resolvedAs : assign.category;
          const deferrable: CategoryId[] = ['bonus_round','instant_tokens','instant_prize','reveal'];
          if(deferrable.includes(effCat) && isTutorialActive(dayState.day)){
            // Force full replay of post_move chain even if some pages had been marked shown earlier (safety)
            forceReplayPhases.add('post_move');
            // Queue the auto trigger to run after tutorial closes (closeModal will process deferredCategoryAction)
            if(!deferredCategoryAction){
              deferredCategoryAction = ()=>{ maybeAutoTriggerCategory(); };
            }
          } else {
            maybeAutoTriggerCategory();
          }
        } else {
          maybeAutoTriggerCategory();
        }
        // Mark movement complete slightly after auto-trigger begins, then evaluate day completion (so button appears only after landing & triggers)
        setTimeout(()=>{ movementInProgress = false; evaluateDayCompletion(); }, 200);
      }, stepDuration + 120);
    }
  }
  hop();
}

// Reverse advance (move backwards without awarding tokens)
function retreatBy(steps:number){
  if(steps<=0) return;
  const canRetreat = progress.current - 1; // levels below current down to 1
  const remaining = Math.min(steps, canRetreat);
  if(remaining<=0) return;
  movementInProgress = true;
  const sequence:number[] = [];
  for(let i=0;i<remaining;i++) sequence.push(progress.current - 1 - i);
  const stepDuration = 420;
  function hop(){
    if(!sequence.length) return;
    progress.current -= 1;
    saveProgress(progress); // persist even for testing
    refreshStates();
    positionPlayer(progress.current, false, stepDuration - 60);
    centerCameraOnLevel(progress.current);
    if(sequence.length>1){
      sequence.shift();
      setTimeout(hop, stepDuration);
    } else {
      sequence.shift();
      // Final landing after retreat chain
      setTimeout(()=>{ maybeAutoTriggerCategory(); }, stepDuration + 120);
      setTimeout(()=>{ movementInProgress = false; evaluateDayCompletion(); }, stepDuration + 260);
    }
  }
  hop();
}

// Auto-trigger category behaviour for ANY category when landing on a tile (dice advance, retreat, extra move, manual completion)
function maybeAutoTriggerCategory(){
  const level = progress.current;
  const assign = getCategoryAssignment(level);
  if(!assign) return; // no category assigned (fallback placeholder)
  if(assign.completed) return; // already resolved
  // Defer if a forced tutorial minigame is queued; minigame should take precedence
  if(pendingForcedMinigame) return;
  // Close any existing modal before opening a new one (safety)
  closeModal();
  // Use standard interaction pipeline (manual=false)
  triggerCategoryInteraction(level,false);
}

// Camera logic: center around the player's current level keeping window of ~8 levels visible.
// (Optional) Horizontal adjustment constant retained for fine tuning if the river artwork isn't perfectly centered.
const RIVER_RELATIVE_X = 0.47; // 0.5 means centered; tweak slightly if needed (e.g., 0.48 / 0.52)

function centerCameraOnLevel(level: number, instant = false) {
  const pos = positions[level - 1];
  // Derive a dynamic bottom anchor so the current tile sits a consistent proportion above the bottom UI band.
  // We want some clearance for the dice bar and a fraction of spacing for forward lookahead.
  const spacing = computeBaseSpacing();
  const diceClearance = BOTTOM_VISIBLE_PADDING * 0.55; // portion of bottom padding actually reserved for UI
  const lookaheadFraction = 0.30; // baseline lift
  // Start with baseline offset (how far above the absolute bottom the tile center sits)
  let verticalOffset = diceClearance + spacing * lookaheadFraction + TILE_RADIUS;
  // Ensure we can see at least DESIRED_AHEAD_VISIBLE future tiles (centers) above the current one if space allows.
  const DESIRED_AHEAD_VISIBLE = 7; // number of future levels (not counting current) we aim to show
  const firstLevelExtra = level === 1 ? TILE_RADIUS * 1.2 : 0; // nudge for intro level
  // Compute maximum verticalOffset that still leaves enough room above the tile for desired ahead levels.
  // Constraint: (screenY_of_current - TOP_VISIBLE_PADDING) >= DESIRED_AHEAD_VISIBLE * spacing
  // screenY_of_current = viewHeight - verticalOffset - firstLevelExtra
  const maxVerticalOffsetForAhead = viewHeight - firstLevelExtra - TOP_VISIBLE_PADDING - DESIRED_AHEAD_VISIBLE * spacing;
  // Maintain a minimum so the tile doesn't sink into the dice bar.
  const minVerticalOffset = diceClearance + TILE_RADIUS + 8;
  // Clamp verticalOffset downward if needed to reveal more ahead tiles (but not below minVerticalOffset).
  verticalOffset = Math.min(verticalOffset, Math.max(minVerticalOffset, maxVerticalOffsetForAhead));
  const bottomAnchor = viewHeight - verticalOffset;
  // firstLevelExtra already computed above
  const targetYRaw = -(pos.y - (bottomAnchor - firstLevelExtra));
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
    updateZoneCrossfade();
  };
  if (instant) {
    world.position.set(targetX, targetY);
    syncBackground();
    return;
  }
  tween(world, { x: targetX, y: targetY }, 600, easeInOutCubic, syncBackground);
}

// ------- Free Scroll Support (wheel + drag) -------
let isDragging = false;
let dragStartY = 0;
let worldStartY = 0;

function clampCameraY(y: number) {
  const minY = -(height - viewHeight);
  return clamp(y, minY, 0);
}

function applyWorldY(y: number) {
  world.position.y = y;
  // sync background vertical position
  backgroundLayer.y = world.position.y;
  updateZoneCrossfade();
}

function enableFreeScroll(rootEl: HTMLElement) {
  // Wheel scroll
  rootEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = 1; // direct mapping for now
    const newY = clampCameraY(world.position.y - e.deltaY * factor);
    applyWorldY(newY);
  }, { passive: false });

  // Pointer drag (vertical only)
  rootEl.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.modal,.controls,.nav-fab')) return; // ignore UI overlays
    isDragging = true;
    dragStartY = e.clientY;
    worldStartY = world.position.y;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  });
  rootEl.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dy = e.clientY - dragStartY;
    const newY = clampCameraY(worldStartY + dy);
    applyWorldY(newY);
  });
  const endDrag = (e: PointerEvent) => {
    if (!isDragging) return;
    isDragging = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };
  rootEl.addEventListener('pointerup', endDrag);
  rootEl.addEventListener('pointerleave', endDrag);
}

// ------- Recenter Button -------
function renderRecenterButton() {
  let existing = document.querySelector('.nav-fab');
  if (!existing) {
    const btn = document.createElement('button');
    btn.className = 'nav-fab';
    btn.type = 'button';
    btn.title = 'Recenter on current level';
    btn.ariaLabel = 'Recenter on current level';
    btn.innerHTML = '⤓';
    btn.addEventListener('click', () => centerCameraOnLevel(progress.current));
    document.getElementById('app')?.appendChild(btn);
  }
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
    controls.innerHTML = `
      <div class="currency-bar vertical" aria-label="Currencies">
        <div class="currency-meta" aria-label="Meta Progress">
          <div class="currency day-counter pill" title="Current Day"><span class="label">Day</span><span class="day-count">1</span></div>
          <div class="currency level-counter pill" title="Player Level"><span class="label">Lvl</span><span class="level-count">1</span></div>
          <div class="prize-star-progress" title="Prize Star Progress" aria-label="Prize Star Progress">
            <div class="ps-progress-bar"><div class="ps-progress-fill"></div></div>
            <div class="ps-progress-label"><span class="ps-progress-count">0</span>/5 ⭐</div>
          </div>
        </div>
        <div class="currency-group-card" aria-label="Reward Currencies">
          <div class="currency token-counter pill"><img src="${tokenIconUrl}" alt="Token" class="token-icon" /><span class="token-count">0</span></div>
          <div class="currency fp-counter pill" title="Free Plays"><span class="label">FP</span><span class="fp-count">0</span></div>
          <div class="currency cash-counter pill" title="Cash Balance"><span class="label">💰</span><span class="cash-count">0</span></div>
          <div class="currency bonus-counter pill" title="Bonus Money"><span class="label">BM</span><span class="bonus-count">0</span></div>
          <div class="currency sk-counter pill" title="Streak Keys"><span class="label">🔑</span><span class="sk-count">0</span></div>
          <div class="currency ps-counter pill" title="Prize Stars"><span class="label">⭐</span><span class="ps-count">0</span></div>
        </div>
      </div>
      <div class="control-row" style="display:flex;gap:8px;margin-top:10px;">
        <button type="button" data-action="reset" class="reset" aria-label="Reset progress">Reset</button>
      </div>`;
    document.getElementById('app')?.appendChild(controls);
    // Floating legend button (only once)
    if(!document.querySelector('.legend-fab')){
      const fab = document.createElement('button');
      fab.className='legend-fab'; fab.type='button'; fab.textContent='?'; fab.title='Tile Legend'; fab.ariaLabel='Tile Legend';
      Object.assign(fab.style,{position:'fixed',right:'14px',bottom:'118px',width:'44px',height:'44px',borderRadius:'50%',background:'#182028',color:'#fff',border:'2px solid #ff9f43',fontWeight:'700',cursor:'pointer',zIndex:'250',boxShadow:'0 4px 10px rgba(0,0,0,0.45)'});
      fab.addEventListener('click', openLegendModal);
      document.body.appendChild(fab);
    }
    // Inject minimal styling enhancements if not already present
    if(!document.getElementById('currency-pills-style')){
      const style = document.createElement('style');
      style.id = 'currency-pills-style';
      style.textContent = `.currency-bar{display:flex;gap:12px;align-items:flex-start;font-weight:600;font-size:13px;}
        .currency-bar.vertical{align-items:flex-start;flex-direction:row;flex-wrap:wrap;}
        .currency-bar .currency-meta{display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:rgba(32,38,45,0.55);border:1px solid #2a333c;border-radius:18px;backdrop-filter:blur(6px);box-shadow:0 4px 12px rgba(0,0,0,0.35);}
        .currency-bar.vertical .currency-group-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:rgba(20,24,28,0.55);border:1px solid #2a333c;border-radius:18px;backdrop-filter:blur(6px);box-shadow:0 4px 12px rgba(0,0,0,0.4);}
        .currency-bar.vertical .pill{background:rgba(255,255,255,0.06);border:1px solid #333;}
        .currency-bar .pill{display:flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(20,24,28,0.6);border:1px solid #2a333c;border-radius:18px;backdrop-filter:blur(4px);} 
        .currency-bar .pill .label{opacity:0.85;font-size:12px;letter-spacing:.5px;} 
        .currency-bar .cash-counter .label{font-size:15px;line-height:1;} 
    .currency-bar img.token-icon{width:18px;height:18px;display:block;}
    .currency-bar span{display:inline-block;min-width:14px;text-align:right;}
  .prize-star-progress{position:relative;display:flex;flex-direction:column;padding:6px 8px 8px;background:rgba(15,18,22,0.55);border:1px solid #2a333c;border-radius:14px;min-width:150px;}
  .ps-progress-bar{position:relative;width:100%;height:24px;background:#1f262d;border:1px solid #36424d;border-radius:10px;overflow:hidden;display:flex;align-items:center;}
  .ps-progress-fill{position:absolute;left:0;top:0;height:100%;width:0;background:linear-gradient(90deg,#ffcf9a,#ff9f43);box-shadow:0 0 6px rgba(255,159,67,0.6) inset,0 0 4px rgba(255,159,67,0.55);transition:width .6s cubic-bezier(.4,.8,.2,1),filter .5s;}
  /* Adjust vertical nudge of label here via translateY */
  .ps-progress-label{pointer-events:none;position:absolute;left:0;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;letter-spacing:.6px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.9),0 0 4px rgba(0,0,0,0.55);transform:translateY(-1px);} 
  .prize-star-progress .ps-progress-label .ps-progress-count{margin-right:4px;}
  .prize-star-progress.compact{padding:4px 6px 6px;}
  .ps-progress-complete .ps-progress-label{color:#222;}
  .ps-progress-complete .ps-progress-fill{filter:drop-shadow(0 0 6px #ff9f43) drop-shadow(0 0 12px rgba(255,159,67,.75));animation:psPulse 1.6s ease-in-out infinite alternate;}
  @keyframes psPulse{0%{opacity:1;}100%{opacity:.6;}}
        .controls button.next-day{background:#304050;color:#fff;border:1px solid #456075;padding:8px 14px;font-weight:600;border-radius:10px;cursor:pointer;transition:background .25s,box-shadow .25s;}
        .controls button.next-day:disabled{opacity:.35;cursor:default;box-shadow:none;}
        .controls button.next-day.ready{box-shadow:0 0 0 2px #ff9f43 inset,0 0 10px 2px rgba(255,159,67,0.55);}
        .controls button.reset{background:#402c2c;color:#fff;border:1px solid #664242;padding:8px 14px;font-weight:600;border-radius:10px;cursor:pointer;}
        .dice-bar .dice-btn.daily-used{background:#3a3f44 !important;border:0;color:#888;box-shadow:inset 0 0 0 2px #555;position:relative;}
        .dice-bar .dice-btn.daily-used::after{content:'Daily used';position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:600;color:#bbb;letter-spacing:.5px;}
        @keyframes diceGlow{0%,100%{box-shadow:0 0 0 4px rgba(255,159,67,0.25),0 0 18px 4px rgba(255,159,67,0.55);}50%{box-shadow:0 0 0 2px rgba(255,159,67,0.55),0 0 10px 2px rgba(255,159,67,0.9);}}
        @keyframes diceShake{0%,100%{transform:translateY(-3px) rotateZ(-3deg);}25%{transform:translate(-3px,1px) rotateZ(5deg);}50%{transform:translate(3px,-2px) rotateZ(-6deg);}75%{transform:translate(-2px,2px) rotateZ(4deg);}}
        .dice-cube.can-roll{animation:diceGlow 2.8s ease-in-out infinite;position:relative;}
        .dice-cube.can-roll::after{content:'Roll!';position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:11px;font-weight:600;color:#ffcf9a;letter-spacing:.5px;text-shadow:0 1px 2px #000;}
        .dice-cube.spinning{animation:diceShake 0.65s linear infinite;}
      `;
      document.head.appendChild(style);
    }
  }
  // Legacy inline reset button removed; ensure floating fab is present
  ensureResetFab();
  // next-day button now injected dynamically in place of dice when day complete
  updateResetButton();
  updateTokenCounter();
  updateDayUI();
}
function updateResetButton() { const btn = document.querySelector('[data-action="reset"]') as HTMLButtonElement | null; if (btn) btn.disabled = progress.current === 1; }

// Centralized full reset routine (used by inline button & floating reset-fab)
function performFullReset(){
  closeModal();
  progress.current = 1; saveProgress(progress);
  categoryAssignments.forEach(a=>{ a.completed = false; if(a.category==='mystery'){ delete a.resolvedAs; } }); saveCategoryAssignments();
  minigameAssignments.forEach(m=>{ m.completed = false; }); saveMinigameAssignments();
  tokens = 0; saveTokens();
  freePlays = 0; cashPence = 0; bonusPence = 0; streakKeys = 0; prizeStars = 0; saveCurrencies(); updateCurrencyCounters();
  dayState.day = 1; dayState.rollUsed = false; saveDayState(); updateDayUI();
  levelState.level = 1; saveLevelState(); updateLevelUI();
  document.querySelectorAll('.inline-next-day-btn').forEach(el=> el.remove());
  const diceBtn = document.querySelector('.dice-roll-btn') as HTMLButtonElement | null;
  if(diceBtn){ diceBtn.style.display=''; diceBtn.disabled=false; diceBtn.classList.remove('daily-used'); diceBtn.classList.add('can-roll'); }
  if(typeof prizeStarJackpotPlayedToday !== 'undefined') prizeStarJackpotPlayedToday = false;
  dayMinigameCompleted = false;
  LEVEL_COUNT = 30;
  generateMinigameAssignments();
  generateCategoryAssignments();
  refreshStates();
  positionPlayer(progress.current, true);
  centerCameraOnLevel(progress.current, true);
  trailLayer.removeChildren(); levelLayer.removeChildren(); connectors.splice(0, connectors.length); levelNodes.splice(0, levelNodes.length);
  positions = generateVerticalPositions(LEVEL_COUNT);
  height = Math.max(1600, Math.max(...positions.map(p => p.y)) + 400);
  app.renderer.resize(viewWidth, viewHeight);
  buildTrail(); createLevels(); refreshStates(); positionPlayer(progress.current, true);
  setTimeout(()=> maybeApplyTutorialPopups('start_day'), 400);
  updateResetButton();
}

function ensureResetFab(){
  let btn = document.querySelector('.reset-fab') as HTMLButtonElement | null;
  if(!btn){
    btn = document.createElement('button');
    btn.type='button';
    btn.className='reset-fab';
    btn.innerHTML='<span class="rf-icon" style="font-size:14px;line-height:1;">↺</span><span class="rf-label" style="margin-left:6px;">Reset</span>';
    btn.title='Reset progress'; btn.ariaLabel='Reset progress';
    document.body.appendChild(btn);
    btn.addEventListener('click',()=>{ if(confirm('Reset your progress?')) performFullReset(); });
  }
  return btn;
}

function updateTokenCounter() { const span = document.querySelector('.token-counter .token-count'); if(span) span.textContent = String(tokens); }
function updateCurrencyCounters(){
  updateTokenCounter();
  const fp = document.querySelector('.fp-count'); if(fp) fp.textContent = String(freePlays);
  const cash = document.querySelector('.cash-count'); if(cash) cash.textContent = formatCash(cashPence);
  const bonus = document.querySelector('.bonus-count'); if(bonus) bonus.textContent = formatCash(bonusPence);
  const sk = document.querySelector('.sk-count'); if(sk) sk.textContent = String(streakKeys);
  const ps = document.querySelector('.ps-count'); if(ps) ps.textContent = String(prizeStars);
  updatePrizeStarProgress();
  updateLevelUI();
}
function updatePrizeStarProgress(){
  const wrap = document.querySelector('.prize-star-progress'); if(!wrap) return;
  const fill = wrap.querySelector('.ps-progress-fill') as HTMLDivElement | null;
  const count = wrap.querySelector('.ps-progress-count') as HTMLSpanElement | null;
  if(count) count.textContent = String(Math.min(5, prizeStars));
  if(fill){
    const pct = Math.min(1, prizeStars/5);
    fill.style.width = (pct*100)+'%';
    if(pct>=1) wrap.classList.add('ps-progress-complete'); else wrap.classList.remove('ps-progress-complete');
  }
}
function updateDayUI(){
  const daySpan = document.querySelector('.day-count'); if(daySpan) daySpan.textContent = String(dayState.day);
  updateLevelUI();
  const rollBtn = document.querySelector('.dice-roll-btn') as HTMLButtonElement | null; 
  if(rollBtn){
    if(dayState.rollUsed){
      rollBtn.classList.add('daily-used');
      rollBtn.classList.remove('can-roll');
      rollBtn.disabled = true; // ensure disabled attribute
    } else {
      rollBtn.classList.remove('daily-used');
      rollBtn.classList.add('can-roll');
      if(!isRolling) rollBtn.disabled = false;
    }
  }
  // Dynamic next-day button state handled by evaluateDayCompletion
}

function updateLevelUI(){
  const levelSpan = document.querySelector('.level-count'); if(levelSpan) levelSpan.textContent = String(levelState.level);
}

function openModal(level: number) {
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role','dialog');
  modal.innerHTML = `
    <h2>Level ${level}</h2>
    <p>Placeholder content for level ${level}. Complete to advance.</p>
    <div class="modal-footer">
      <button class="secondary" type="button" data-action="cancel">Close</button>
      <button class="primary" type="button" data-action="complete">Complete Level</button>
    </div>`;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  modal.querySelector('[data-action="cancel"]')?.addEventListener('click', closeModal);
  modal.querySelector('[data-action="complete"]')?.addEventListener('click', () => { completeLevel(level); closeModal(); });
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  setTimeout(() => (modal.querySelector('[data-action="complete"]') as HTMLButtonElement)?.focus(), 30);
}
let pendingPostMinigamePhase = false;
let pendingPostInstantWinPhase = false; // track tutorial follow-up after instant reward (non-minigame)
let pendingPostBonusRoundPhase = false; // follow-up after bonus round category
let pendingMetaTrail = false; // set when we should animate key/star travel after modal closes
// Deferred category interaction (used to delay Day 3 bonus round until after post_move tutorial closes)
let deferredCategoryAction: (()=>void) | null = null;
function closeModal() { 
  document.querySelector('.modal-backdrop')?.remove();
  document.body.classList.remove('modal-open');
  let fired=false;
  if(pendingPostInstantWinPhase){
    pendingPostInstantWinPhase=false; fired=true;
    setTimeout(()=>{ maybeApplyTutorialPopups('post_instantwin'); evaluateDayCompletion(); },60);
  } else if(pendingPostBonusRoundPhase){
    pendingPostBonusRoundPhase=false; fired=true;
    setTimeout(()=>{ maybeApplyTutorialPopups('post_bonus_round'); evaluateDayCompletion(); },60);
  } else if(pendingPostMinigamePhase){
    pendingPostMinigamePhase=false; fired=true;
    setTimeout(()=>{ maybeApplyTutorialPopups('post_minigame'); evaluateDayCompletion(); },60);
  }
  // If no immediate post-* phase fired and we have a deferred category action queued (e.g. Day 3 bonus round), run it now.
  if(!fired && deferredCategoryAction){
    const fn = deferredCategoryAction; deferredCategoryAction = null;
    // Slight delay so DOM has removed previous modal fully before opening the next
    setTimeout(()=>{ fn(); }, 40);
    fired = true; // treat as handled so evaluateDayCompletion waits for the resulting modal lifecycle
  }
  if(!fired){
    setTimeout(()=> {
      // First try day completion (may queue jackpot via existing evaluate logic if triggered at end of day)
      evaluateDayCompletion();
      // Also attempt post-tutorial jackpot trigger if player has full stars but day not ending yet
      ensurePrizeStarJackpotAfterTutorials();
    }, 60);
  }
  if(pendingMetaTrail){
    const run = ()=>{ triggerMetaTrailAnimation(); pendingMetaTrail = false; };
    setTimeout(run, 120);
  }
  setTimeout(()=>{ if(!document.querySelector('.modal-backdrop')) launchPendingForcedMinigame(); },40);
}

// If tutorials just ended and player has 5/5 stars, auto open jackpot (once) even mid-day (e.g., after post_move pages finish)
function ensurePrizeStarJackpotAfterTutorials(){
  if(prizeStars < 5) return;
  if(prizeStarJackpotPlayedToday) return;
  // Don't open over an existing modal
  if(document.querySelector('.modal-backdrop')) return;
  // Avoid interrupting chained tutorial flows: if any forced replay pending or tutorial popup would appear next, skip.
  if(forceReplayPhases.size>0) return;
  // Heuristic: if no tutorial popup just fired (closeModal path) and stars are full, show jackpot now.
  openPrizeStarJackpot();
}

// Animate a simple travel of 🔑 and ⭐ from player token position to their respective counters
function triggerMetaTrailAnimation(){
  try {
    if(!playerToken) return;
    const root = document.getElementById('app'); if(!root) return;
    const tokenGlobal = playerToken.getGlobalPosition();
    const canvasRect = (app.canvas as HTMLCanvasElement).getBoundingClientRect();
    const startX = canvasRect.left + tokenGlobal.x; // approximate world-to-screen (camera adjustments already in world position)
    const startY = canvasRect.top + tokenGlobal.y;
    const targets: { selector: string; glyph: string }[] = [
      { selector: '.sk-counter', glyph: '🔑' },
      { selector: '.ps-counter', glyph: '⭐' }
    ];
    targets.forEach(t=>{
      const targetEl = document.querySelector(t.selector) as HTMLElement | null;
      if(!targetEl) return;
      const rect = targetEl.getBoundingClientRect();
      const midX = rect.left + rect.width/2;
      const midY = rect.top + rect.height/2;
      const el = document.createElement('div');
      el.textContent = t.glyph;
      Object.assign(el.style,{
        position:'fixed',left:`${startX}px`,top:`${startY}px`,
        zIndex:'9999',fontSize:'20px',filter:'drop-shadow(0 2px 4px rgba(0,0,0,0.6))',
        transition:'transform 780ms cubic-bezier(.4,.8,.2,1), opacity 780ms ease',
        pointerEvents:'none',opacity:'1'
      });
      document.body.appendChild(el);
      requestAnimationFrame(()=>{
        const dx = midX - startX;
        const dy = midY - startY;
        el.style.transform = `translate(${dx}px,${dy}px) scale(0.6)`;
        el.style.opacity = '0';
      });
      setTimeout(()=>{ el.remove(); }, 820);
    });
  } catch(e){ console.warn('Meta trail animation failed', e); }
}

// Helper: if tutorial has any unseen post_minigame popups for today, set pending flag so they'll display after current modal closes.
function maybeQueuePostMinigamePhase(){
  if(pendingPostMinigamePhase) return; // already queued
  if(!isTutorialActive(dayState.day)) return;
  const plan = getTutorialPlanForDay(dayState.day);
  if(!plan) return;
  const raw = (plan as any).popups?.post_minigame;
  if(!raw) return; // nothing defined
  // Determine if at least one post_minigame popup not yet shown
  const pages: string[] = Array.isArray(raw)? raw : [raw];
  const unseen = pages.some(html=> !shownPlanPopups.has(`${plan.day}:post_minigame:${html}`));
  if(unseen){ pendingPostMinigamePhase = true; }
}

// Queue post_instantwin phase if any unseen popups exist for this day
function maybeQueuePostInstantWinPhase(){
  if(pendingPostInstantWinPhase) return;
  if(!isTutorialActive(dayState.day)) return;
  const plan = getTutorialPlanForDay(dayState.day); if(!plan) return;
  const raw = (plan as any).popups?.post_instantwin; if(!raw) return;
  const pages: string[] = Array.isArray(raw)? raw : [raw];
  const unseen = pages.some(html=> !shownPlanPopups.has(`${plan.day}:post_instantwin:${html}`));
  if(unseen) pendingPostInstantWinPhase = true;
}

function maybeQueuePostBonusRoundPhase(){
  if(pendingPostBonusRoundPhase) return;
  if(!isTutorialActive(dayState.day)) return;
  const plan = getTutorialPlanForDay(dayState.day); if(!plan) return;
  const raw = (plan as any).popups?.post_bonus_round; if(!raw) return;
  const pages: string[] = Array.isArray(raw)? raw : [raw];
  const unseen = pages.some(html=> !shownPlanPopups.has(`${plan.day}:post_bonus_round:${html}`));
  if(unseen) pendingPostBonusRoundPhase = true;
}

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
  // Refresh dynamic text style (depends on TILE_RADIUS)
  levelLabelStyle = makeLevelTextStyle();
  // Regenerate spacing & positions
  positions = generateVerticalPositions(LEVEL_COUNT);
  height = Math.max(1600, Math.max(...positions.map(p => p.y)) + 400);
  // Resize renderer
  app.renderer.resize(viewWidth, viewHeight);
  // Rebuild trail + levels
  trailLayer.removeChildren();
  levelLayer.removeChildren();
  connectors.splice(0, connectors.length);
  levelNodes.splice(0, levelNodes.length);
  buildTrail();
  createLevels();
  refreshStates();
  positionPlayer(prevLevel, true);
  // Rebuild background tiles to fit new width/height
  buildBackground();
  centerCameraOnLevel(prevLevel, true);
  backgroundLayer.y = world.position.y;
  backgroundLayer.x = 0;
  updateZoneCrossfade();
  updateCurrencyCounters();
}

// ---------------- Debug Overlay (toggle with '0') ----------------
let debugShown = false;
let debugEl: HTMLDivElement | null = null;
let debugButtonsEl: HTMLDivElement | null = null; // holds clickable debug controls (separate from readonly overlay)
function initDebugOverlay() {
  window.addEventListener('keydown', (e) => {
    if (e.key === '0') {
      debugShown = !debugShown;
      if (debugShown) {
        if (!debugEl) {
          debugEl = document.createElement('div');
          debugEl.className = 'debug-overlay';
          document.body.appendChild(debugEl);
          Object.assign(debugEl.style, {
            position: 'fixed', top: '8px', left: '8px', padding: '8px 10px', background: 'rgba(0,0,0,0.55)',
            color: '#fff', font: '12px/1.3 monospace', zIndex: '9999', maxWidth: '240px', borderRadius: '6px',
            pointerEvents: 'none', whiteSpace: 'pre', backdropFilter: 'blur(3px)' });
        }
        if(!debugButtonsEl){
          debugButtonsEl = document.createElement('div');
          debugButtonsEl.className = 'debug-buttons';
          document.body.appendChild(debugButtonsEl);
          Object.assign(debugButtonsEl.style, {
            position: 'fixed', bottom: '10px', right: '10px', display: 'flex', flexDirection: 'column', gap: '6px',
            zIndex: '10000', padding: '8px', background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '8px', font: '12px system-ui, sans-serif', boxShadow: '0 2px 6px rgba(0,0,0,0.4)'
          });
          const mkBtn = (label:string, game:MinigameId)=>{
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            Object.assign(b.style, {
              cursor: 'pointer', background: '#222', color: '#fff', border: '1px solid #444', padding: '4px 8px',
              borderRadius: '4px', fontSize: '12px', letterSpacing: '0.5px'
            });
            b.addEventListener('mouseenter', ()=>{ b.style.background = '#333'; });
            b.addEventListener('mouseleave', ()=>{ b.style.background = '#222'; });
            b.addEventListener('click', ()=>{
              const assign: MinigameAssignment = { level: -1, game, completed: false };
              openMinigameModal(assign);
            });
            return b;
          };
          debugButtonsEl.appendChild(mkBtn('Force Slot', 'slot'));
          debugButtonsEl.appendChild(mkBtn('Force Spin Wheel', 'spin_wheel'));
          debugButtonsEl.appendChild(mkBtn('Force Loot Box', 'lootbox'));
          // Force Jackpot (Prize Star big game)
          const jackpotBtn = document.createElement('button');
          jackpotBtn.type='button';
          jackpotBtn.textContent='Force Jackpot';
          Object.assign(jackpotBtn.style, {
            cursor: 'pointer', background: '#222', color: '#fff', border: '1px solid #444', padding: '4px 8px',
            borderRadius: '4px', fontSize: '12px', letterSpacing: '0.5px'
          });
          jackpotBtn.addEventListener('mouseenter', ()=>{ jackpotBtn.style.background = '#333'; });
          jackpotBtn.addEventListener('mouseleave', ()=>{ jackpotBtn.style.background = '#222'; });
          jackpotBtn.addEventListener('click', ()=>{
            // Set stars full and re-open jackpot overlay even if already played this day
            prizeStars = 5;
            prizeStarJackpotPlayedToday = false; // allow re-trigger
            saveCurrencies();
            updateCurrencyCounters();
            openPrizeStarJackpot();
          });
          debugButtonsEl.appendChild(jackpotBtn);
          // Force Dual Choice overlay (120 token milestone) & subgames
          const dualBtn = document.createElement('button');
          dualBtn.type='button'; dualBtn.textContent='Force Dual Choice';
          Object.assign(dualBtn.style, {
            cursor: 'pointer', background: '#222', color: '#fff', border: '1px solid #444', padding: '4px 8px',
            borderRadius: '4px', fontSize: '12px', letterSpacing: '0.5px'
          });
          dualBtn.addEventListener('mouseenter', ()=>{ dualBtn.style.background = '#333'; });
          dualBtn.addEventListener('mouseleave', ()=>{ dualBtn.style.background = '#222'; });
          dualBtn.addEventListener('click', ()=>{
            tokenDualPopupReady = true; tokenDualPopupConsumed = false; // re-arm
            openDualThresholdOverlay();
          });
          debugButtonsEl.appendChild(dualBtn);

          const specialScratchBtn = document.createElement('button');
          specialScratchBtn.type='button'; specialScratchBtn.textContent='Force Special Scratch';
          Object.assign(specialScratchBtn.style, {
            cursor: 'pointer', background: '#222', color: '#fff', border: '1px solid #444', padding: '4px 8px',
            borderRadius: '4px', fontSize: '12px', letterSpacing: '0.5px'
          });
          specialScratchBtn.addEventListener('mouseenter', ()=>{ specialScratchBtn.style.background = '#333'; });
          specialScratchBtn.addEventListener('mouseleave', ()=>{ specialScratchBtn.style.background = '#222'; });
          specialScratchBtn.addEventListener('click', ()=>{ openSpecialScratchJackpotOverlay(); });
          debugButtonsEl.appendChild(specialScratchBtn);

          const megaBoxBtn = document.createElement('button');
          megaBoxBtn.type='button'; megaBoxBtn.textContent='Force Mega Box';
          Object.assign(megaBoxBtn.style, {
            cursor: 'pointer', background: '#222', color: '#fff', border: '1px solid #444', padding: '4px 8px',
            borderRadius: '4px', fontSize: '12px', letterSpacing: '0.5px'
          });
          megaBoxBtn.addEventListener('mouseenter', ()=>{ megaBoxBtn.style.background = '#333'; });
          megaBoxBtn.addEventListener('mouseleave', ()=>{ megaBoxBtn.style.background = '#222'; });
          megaBoxBtn.addEventListener('click', ()=>{ openMegaBoxGameOverlay(); });
          debugButtonsEl.appendChild(megaBoxBtn);
          // Close button for convenience
          const closeBtn = mkBtn('Close Debug (0)', 'slot');
          closeBtn.removeEventListener('click', ()=>{}); // remove earlier listener
          closeBtn.addEventListener('click', ()=>{ window.dispatchEvent(new KeyboardEvent('keydown', { key: '0' })); });
          Object.assign(closeBtn.style, { background: '#552222' });
          debugButtonsEl.appendChild(closeBtn);
        }
        updateDebugOverlay();
      } else if (debugEl) {
        debugEl.remove();
        debugEl = null;
        if(debugButtonsEl){ debugButtonsEl.remove(); debugButtonsEl = null; }
      }
    }
  });
  // Periodic refresh when visible
  setInterval(() => { if (debugShown) updateDebugOverlay(); }, 400);
}

function updateDebugOverlay() {
  if (!debugEl) return;
  const spacing = computeBaseSpacing();
  const gapCount = VISIBLE_LEVEL_WINDOW - 1;
  const usable = viewHeight - TOP_VISIBLE_PADDING - BOTTOM_VISIBLE_PADDING;
  const camX = world.position.x.toFixed(1);
  const camY = world.position.y.toFixed(1);
  const current = progress.current;
  const ahead = Math.min(LEVEL_COUNT, current + 7);
  const visibleRange = `${current}-${ahead}`;
  const mgCount = minigameAssignments.length;
  const catCount = categoryAssignments.length;
  debugEl.textContent =
    `VIEW: ${viewWidth}x${viewHeight}\n` +
    `TILE_RADIUS: ${TILE_RADIUS.toFixed(1)}\n` +
    `spacing: ${spacing.toFixed(1)} (gaps:${gapCount})\n` +
    `usable: ${usable.toFixed(1)}\n` +
    `paddings T:${TOP_VISIBLE_PADDING} B:${BOTTOM_VISIBLE_PADDING}\n` +
    `camera: (${camX}, ${camY})\n` +
    `progress: ${current}/${LEVEL_COUNT} visible:${visibleRange}\n` +
  `categories: ${catCount} minigames: ${mgCount}\n`+
  `day: ${dayState.day} rollUsed:${dayState.rollUsed} level:${levelState.level}\n`+
  `zone: ${currentZoneId}`;
}

// ---------------- Minigame Modals ----------------
function openMinigameModal(assign: MinigameAssignment){
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className='modal-backdrop';
  const modal = document.createElement('div'); modal.className='modal'; modal.setAttribute('role','dialog');
  modal.innerHTML = `<h2>${minigameTitle(assign.game)}</h2><div class="minigame" data-game="${assign.game}"></div><div class="result"></div><div class="modal-footer"><button class="secondary" data-action="close" type="button">Close</button></div>`;
  backdrop.addEventListener('click', e=>{ if(e.target===backdrop) closeModal(); });
  modal.querySelector('[data-action="close"]')?.addEventListener('click', closeModal);
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  initMinigameUI(assign, modal.querySelector('.minigame') as HTMLDivElement, modal.querySelector('.result') as HTMLDivElement);
  // Show stacked tutorial card after render
  setTimeout(()=> showStackedPreMinigameMessages(assign, modal), 140);
}

function minigameTitle(id:MinigameId){
  switch(id){
    case 'slot': return '3x1 Slot';
    case 'spin_wheel': return 'Spin Wheel';
    case 'lootbox': return 'Loot Box';
    default: return 'Minigame';
  }
}

function initMinigameUI(assign:MinigameAssignment, root:HTMLDivElement, resultEl:HTMLDivElement){
  if(!MINIGAMES.includes(assign.game)){
    // Attempt self-heal: pick a random available minigame and persist
    assign.game = MINIGAMES[Math.floor(Math.random()*MINIGAMES.length)];
    saveMinigameAssignments();
  }
  switch(assign.game){
    case 'slot': return initSlot(root, assign, resultEl);
    case 'spin_wheel': return initSpinWheel(root, assign, resultEl);
    case 'lootbox': return initLootBox(root, assign, resultEl);
    default:
      root.innerHTML = `<p style='text-align:center;'>Minigame unavailable.</p>`;
  }
}

// Dynamically overlay pre_minigame tutorial messages (instead of blocking before opening the game)
// (Old full-screen overlay removed; replaced by showStackedPreMinigameMessages)
function showStackedPreMinigameMessages(assign:MinigameAssignment, modal:HTMLDivElement){
  if(!isTutorialActive(dayState.day)) return;
  const plan = getTutorialPlanForDay(dayState.day);
  if(!plan || !(plan as any).popups || !(plan as any).popups.pre_minigame) return;
  const raw = (plan as any).popups.pre_minigame;
  const pages:string[] = Array.isArray(raw)? raw : [raw];
  const toShow = pages.filter(html=>{
    const key = `${plan.day}:pre_minigame:${html}`;
    if(shownPlanPopups.has(key)) return false;
    shownPlanPopups.add(key); return true;
  });
  if(!toShow.length) return;
  ensureTutorStyles();
  const layer = document.createElement('div');
  Object.assign(layer.style,{
    position:'fixed',left:'0',top:'0',right:'0',bottom:'0',
    display:'flex',alignItems:'flex-start',justifyContent:'center',
    background:'rgba(0,0,0,0.45)',zIndex:'650',
    padding:'0',overflow:'auto'
  });
  const stage = document.createElement('div');
  stage.className='tutor-stage';
  // Let global tutor-stage padding/offset apply; ensure consistent centering below top shift
  stage.style.minHeight='unset';
  stage.style.width='100%';
  stage.style.maxWidth='var(--tutor-stage-max)';
  // Additional downward shift specific to pre-minigame overlay to match normal tutorial vertical position
  stage.style.marginTop='150px';
  const portraitWrap = document.createElement('div'); portraitWrap.className='tutor-portrait-wrap'; portraitWrap.innerHTML = `<img src='${carnivalCharacterUrl}' alt='Guide' class='tutor-character'/>`;
  const speech = document.createElement('div'); speech.className='tutor-speech';
  speech.innerHTML = `<div class='tutor-speech-arrow'></div><div class='tutor-speech-inner'><h2>Minigame</h2><div class='stacked-copy'></div><div class='tutor-actions stacked-actions' style='display:flex;align-items:center;justify-content:space-between;gap:16px;'><div class='ts-progress' style='font-size:12px;font-weight:600;opacity:.75;letter-spacing:.5px;'></div><div class='nav-btns' style='display:flex;gap:8px;'><button type='button' class='secondary ts-prev' style='display:none;'>Back</button><button type='button' class='primary ts-next'>Next</button></div></div></div>`;
  const copyHolder = speech.querySelector('.stacked-copy') as HTMLDivElement;
  layer.appendChild(stage); stage.appendChild(speech); stage.appendChild(portraitWrap); modal.appendChild(layer);
  let index=0;
  function render(){
    copyHolder.innerHTML = `<div style='font-size:14px;line-height:1.55;'>${toShow[index]}</div>`;
    const prog = speech.querySelector('.ts-progress') as HTMLDivElement;
    const prevBtn = speech.querySelector('.ts-prev') as HTMLButtonElement;
    const nextBtn = speech.querySelector('.ts-next') as HTMLButtonElement;
    prog.textContent = `Step ${index+1}/${toShow.length}`;
    prevBtn.style.display = index>0? 'inline-flex':'none';
    nextBtn.textContent = index===toShow.length-1? 'Finish':'Next';
  }
  speech.querySelector('.ts-prev')?.addEventListener('click',()=>{ if(index>0){ index--; render(); }});
  speech.querySelector('.ts-next')?.addEventListener('click',()=>{ if(index<toShow.length-1){ index++; render(); } else { layer.remove(); }});
  render();
}

function completeMinigame(assign:MinigameAssignment, success:boolean, resultEl:HTMLDivElement){
  if(assign.completed){ resultEl.innerHTML = '<p><strong>Already completed.</strong></p>'; return; }
  let msg='';
  if(success){
    const reward = selectReward();
    if(reward.kind==='nothing') msg = '<p><strong>No reward this time.</strong></p>';
    else {
      applyReward(reward); // applies base reward
      // Minigame-only meta currency bonus
      addStreakKeys(1);
      addPrizeStars(1);
      updateCurrencyCounters();
      msg = `<p><strong>Reward:</strong> ${reward.label}</p>${formatMetaBonusLine()}`;
      pendingMetaTrail = true;
    }
  } else msg = '<p><strong>Try again tomorrow!</strong></p>';
  assign.completed = true;
  saveMinigameAssignments();
  // Also mark the overarching category assignment as completed so the tile turns green (played out)
  const catAssign = getCategoryAssignment(assign.level);
  if(catAssign && !catAssign.completed){ catAssign.completed = true; saveCategoryAssignments(); }
  refreshStates();
  resultEl.innerHTML = msg;
  // Flag minigame completion for day progression (evaluate after modal close to avoid UI clutter)
  dayMinigameCompleted = true;
  // Defer tutorial post_minigame popups until modal close (handled in closeModal)
  pendingPostMinigamePhase = true;
}

// Helper for minigames that determine reward themselves (spin wheel / lootbox)
function finalizeMinigameManual(assign:MinigameAssignment, reward:Reward|null, resultEl:HTMLDivElement){
  if(assign.completed) return;
  let msg='';
  if(reward){
    if(reward.kind==='nothing'){
      msg = '<p><strong>No reward this time.</strong></p>';
    } else {
      applyReward(reward);
      addStreakKeys(1);
      addPrizeStars(1);
      updateCurrencyCounters();
      msg = `<p><strong>Reward:</strong> ${reward.label}</p>${formatMetaBonusLine()}`;
      pendingMetaTrail = true;
    }
  } else {
    msg = '<p><strong>Try again tomorrow!</strong></p>';
  }
  assign.completed = true; saveMinigameAssignments();
  const catAssign = getCategoryAssignment(assign.level); if(catAssign && !catAssign.completed){ catAssign.completed=true; saveCategoryAssignments(); }
  refreshStates();
  resultEl.innerHTML = msg;
  dayMinigameCompleted = true; pendingPostMinigamePhase = true;
}


// ---- Slot (3x1) ----
function initSlot(root:HTMLDivElement, assign:MinigameAssignment, resultEl:HTMLDivElement){
  root.innerHTML = `<div class='slot' style='display:flex;gap:8px;justify-content:center;margin-bottom:8px;'>
    <div class='reel' data-r='0' style='width:46px;height:46px;background:#222;border:2px solid #555;display:flex;align-items:center;justify-content:center;font-size:24px;'>?</div>
    <div class='reel' data-r='1' style='width:46px;height:46px;background:#222;border:2px solid #555;display:flex;align-items:center;justify-content:center;font-size:24px;'>?</div>
    <div class='reel' data-r='2' style='width:46px;height:46px;background:#222;border:2px solid #555;display:flex;align-items:center;justify-content:center;font-size:24px;'>?</div>
  </div><button class='primary' data-action='spin'>Spin</button>`;
  const symbols = ['🍒','⭐','7','🍋'];
  root.querySelector('[data-action="spin"]')?.addEventListener('click', ()=>{
    if(assign.completed) return;
    let plan = getTutorialPlanForDay(dayState.day);
    let forcedSymbols: string[] | null = null;
    if(plan && plan.reward.kind==='minigame' && plan.reward.minigame==='slot'){
      const r:any = plan.reward;
      if(Array.isArray(r.forceSlotSymbols) && r.forceSlotSymbols.length===3){ forcedSymbols = r.forceSlotSymbols; }
      else if(r.forceSlotSymbol){ forcedSymbols = [r.forceSlotSymbol,r.forceSlotSymbol,r.forceSlotSymbol]; }
    }
    const win = forcedSymbols ? true : Math.random()<0.5; // if forcing, treat as win scenario for reward
    const reels = Array.from(root.querySelectorAll('.reel')) as HTMLDivElement[];
    let spinCount=0;
    const interval = setInterval(()=>{
      reels.forEach(r=> r.textContent = symbols[Math.floor(Math.random()*symbols.length)]);
      spinCount++;
      if(spinCount>15){
        clearInterval(interval);
        if(forcedSymbols){
          reels.forEach((r,i)=> r.textContent = forcedSymbols![i]);
          completeMinigame(assign, true, resultEl);
        } else {
          const finalSymbol = win? '⭐' : symbols[Math.floor(Math.random()*symbols.length)];
          reels.forEach(r=> r.textContent = finalSymbol);
          completeMinigame(assign, win, resultEl);
        }
      }
    }, 80);
  });
}

// ---- Spin Wheel ----
function initSpinWheel(root:HTMLDivElement, assign:MinigameAssignment, resultEl:HTMLDivElement){
  // Graphical circular wheel
  const sliceCount = REWARDS.length;
  const size = 260; // pixel diameter
  root.innerHTML = `<div style='position:relative;width:${size}px;height:${size}px;margin:0 auto 12px;'>
    <canvas class='spin-wheel-canvas' width='${size}' height='${size}' style='width:${size}px;height:${size}px;display:block;'></canvas>
    <div class='wheel-pointer' style='position:absolute;left:50%;bottom:-10px;transform:translateX(-50%);width:0;height:0;border-left:16px solid transparent;border-right:16px solid transparent;border-bottom:30px solid #ff9f43;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));'></div>
  </div>
  <button class='primary' data-action='spinwheel'>Spin</button>`;
  const canvas = root.querySelector('.spin-wheel-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if(!ctx) return;
  const cx = ctx as CanvasRenderingContext2D; // non-null assertion helper
  const center = size/2;
  const radius = size/2 - 4;
  // Pre-pick target slice for fairness and compute final rotation to land that slice at pointer (pointer at top / angle 0)
  let plan = getTutorialPlanForDay(dayState.day);
  let targetIndex = Math.floor(Math.random()*sliceCount);
  if(isTutorialActive(dayState.day)){
    // Avoid landing on 'nothing' slice during tutorial unless all slices are nothing (they aren't)
    let guard=0; while(REWARDS[targetIndex].kind==='nothing' && guard<25){ targetIndex = Math.floor(Math.random()*sliceCount); guard++; }
  }
  if(plan && plan.reward.kind==='minigame' && plan.reward.minigame==='spin_wheel'){
    const r:any = plan.reward;
    // Try label first
    if(r.forceSpinWheelLabel){
      const idx = REWARDS.findIndex(w=> w.label===r.forceSpinWheelLabel);
      if(idx>=0) targetIndex = idx;
    } else if(r.forceSpinWheelKind || r.forceSpinWheelAmount!==undefined){
      const idx = REWARDS.findIndex(w=> (r.forceSpinWheelKind? w.kind===r.forceSpinWheelKind:true) && (r.forceSpinWheelAmount!==undefined? w.amount===r.forceSpinWheelAmount:true));
      if(idx>=0) targetIndex = idx;
    }
  }
  // Draw static wheel (we'll rotate canvas using CSS transform)
  const colors = ['#243240','#2f4256','#364d63','#2a3947'];
  function drawWheel(rotation: number){
    cx.clearRect(0,0,size,size);
    cx.save();
    cx.translate(center, center);
    // Apply 180deg base rotation so visual slice mapping inverts
  // Bottom pointer: natural 0 angle points to the right; we want slice centers to pass bottom (angle = Math.PI/2)
  cx.rotate(rotation);
    const arc = (Math.PI*2)/sliceCount;
    for(let i=0;i<sliceCount;i++){
  cx.beginPath();
  cx.moveTo(0,0);
  cx.fillStyle = colors[i%colors.length];
  cx.arc(0,0,radius, i*arc, (i+1)*arc);
  cx.closePath();
  cx.fill();
  cx.save();
  cx.rotate(i*arc + arc/2);
  cx.translate(radius*0.62,0);
  cx.rotate(Math.PI/2);
  cx.fillStyle='#fff';
  cx.font='12px system-ui, sans-serif';
  cx.textAlign='center';
  cx.textBaseline='middle';
    const reward = REWARDS[i];
    const short = reward.kind==='tokens' ? `${reward.amount}T` :
      reward.kind==='freePlays' ? `${reward.amount}FP` :
      reward.kind==='cash' ? `${(reward.amount||0)/100}£` :
      reward.kind==='bonus' ? `${(reward.amount||0)/100}B` :
      reward.kind==='streakKeys' ? `${reward.amount}K` :
      reward.kind==='prizeStars' ? `${reward.amount}★` : '—';
    const icon = reward.kind==='tokens' ? '🪙' :
      reward.kind==='freePlays' ? '▶️' :
      reward.kind==='cash' ? '💷' :
      reward.kind==='bonus' ? '🎟️' :
      reward.kind==='streakKeys' ? '🔑' :
      reward.kind==='prizeStars' ? '⭐' : 'Ø';
    wrapText(cx, icon + '\n' + short,0,0,70,12);
  cx.restore();
    }
    cx.restore();
  }
  function wrapText(context:CanvasRenderingContext2D, text:string, x:number, y:number, maxWidth:number, lineHeight:number){
    const words = text.split(' ');
    let line='';
    const lines:string[]=[];
    for(const w of words){
      const test = line ? line+' '+w : w;
      if(context.measureText(test).width > maxWidth){ lines.push(line); line=w; } else line=test;
    }
    if(line) lines.push(line);
    const offsetY = -((lines.length-1)*lineHeight)/2;
    lines.forEach((ln,i)=> context.fillText(ln,x,y+offsetY + i*lineHeight));
  }
  drawWheel(0);
  const spinBtn = root.querySelector('[data-action="spinwheel"]') as HTMLButtonElement;
  let spinning=false;
  spinBtn.addEventListener('click',()=>{
    if(spinning||assign.completed) return; spinning=true; spinBtn.disabled=true; spinBtn.textContent='Spinning...';
    // physics-ish spin: base rotations + random extra, then land precisely so targetIndex is selected
    const arc = (Math.PI*2)/sliceCount;
    const baseRotations = 6; // full turns
  // Pointer now at top but wheel pre-rotated 180deg; adjust final angle accordingly
  // We want target slice center to end at angle Math.PI/2 (bottom). Current rotation adds rotation value positively.
  // Slice center angle (without rotation) = targetIndex*arc + arc/2. We solve rotation so: (sliceAngle + rotation) mod 2PI = Math.PI/2
  // => rotation = Math.PI/2 - sliceAngle
  const sliceAngle = targetIndex*arc + arc/2;
  const finalAngle = (Math.PI/2) - sliceAngle;
    const totalRotation = baseRotations*Math.PI*2 + finalAngle + (Math.random()*arc - arc/2)*0.15; // slight jitter without changing target index
    const duration = 3800;
    const start = performance.now();
    function easeOutQuart(t:number){ return 1 - Math.pow(1 - t, 4); }
    function animate(now:number){
      const t = Math.min(1, (now-start)/duration);
      const eased = easeOutQuart(t);
      const current = totalRotation * eased;
      drawWheel(current);
      if(t<1) requestAnimationFrame(animate); else finish();
    }
    requestAnimationFrame(animate);
    function finish(){
      let reward = REWARDS[targetIndex];
      if(isTutorialActive(dayState.day) && reward.kind==='nothing'){
        // Failsafe: pick nearest non-nothing reward deterministically
        const forward = [...REWARDS.slice(targetIndex+1), ...REWARDS.slice(0,targetIndex)];
        const alt = forward.find(r=> r.kind!=='nothing');
        if(alt) reward = alt;
      }
      finalizeMinigameManual(assign, reward, resultEl);
    }
  });
}

// ---- Loot Box ----
function initLootBox(root:HTMLDivElement, assign:MinigameAssignment, resultEl:HTMLDivElement){
  // Rarity & weight system local to loot box (weights sum arbitrary; normalized internally)
  interface WeightedReward { reward: Reward; weight: number; rarity: 'common'|'uncommon'|'rare'|'epic'|'mythic'; }
  const rarityStyles: Record<string,{color:string;bg:string}> = {
    common:{color:'#ddd', bg:'#2a2a2a'},
    uncommon:{color:'#b1f29d', bg:'#244a28'},
    rare:{color:'#82c7ff', bg:'#14344d'},
    epic:{color:'#d5a6ff', bg:'#41245b'},
    mythic:{color:'#ffdf7f', bg:'#5a430f'}
  };
  // Map existing rewards to rarities (tune as desired)
  const weighted: WeightedReward[] = REWARDS.map(r=>{
    let rarity: WeightedReward['rarity'] = 'common';
    let weight = 30;
    if(r.kind==='nothing'){
      rarity='common';
      // During tutorial days, either zero weight or drastically reduce chance for 'nothing'
      weight = isTutorialActive(dayState.day)? 0 : 40;
    }
    else if(r.kind==='tokens' && (r.amount||0) >=50){ rarity='uncommon'; weight=18; }
    else if(r.kind==='cash' && (r.amount||0) >=100){ rarity='rare'; weight=10; }
    else if(r.kind==='bonus' && (r.amount||0) >=500){ rarity='epic'; weight=4; }
    else if(r.kind==='tokens' && (r.amount||0) >=100){ rarity='rare'; weight=8; }
    else if(r.kind==='freePlays' && (r.amount||0) >=5){ rarity='rare'; weight=7; }
    else if(r.kind==='bonus' && (r.amount||0) >=100){ rarity='uncommon'; weight=16; }
    return { reward:r, weight, rarity };
  });
  // If tutorial removed 'nothing', and all weights zero for that entry, filter it out to prevent zero-sum total.
  const effectiveWeighted = weighted.filter(w=> w.weight>0);
  function pickWeighted(): WeightedReward {
    const pool = effectiveWeighted.length? effectiveWeighted : weighted; // fallback if somehow emptied
    const total = pool.reduce((s,w)=>s+w.weight,0);
    let roll = Math.random()*total;
    for(const w of pool){ if(roll < w.weight) return w; roll-=w.weight; }
    return pool[0];
  }
  // Pre-determine final reward for fairness
  let final = pickWeighted();
  const plan = getTutorialPlanForDay(dayState.day);
  if(plan && plan.reward.kind==='minigame' && plan.reward.minigame==='lootbox'){
    const r:any = plan.reward;
    let forced: Reward | undefined;
    if(r.forceLootboxLabel) forced = REWARDS.find(rr=> rr.label===r.forceLootboxLabel);
    if(!forced && (r.forceLootboxKind || r.forceLootboxAmount!==undefined)){
      forced = REWARDS.find(rr=> (r.forceLootboxKind? rr.kind===r.forceLootboxKind:true) && (r.forceLootboxAmount!==undefined? rr.amount===r.forceLootboxAmount:true));
    }
    if(forced){
      final = { reward: forced, weight: 1, rarity: 'rare' } as typeof final; // rarity nominal
    }
  }
  // Build reel items (populate with random rewards, ensure final appears near end so decel lands there)
  const ITEM_COUNT = 48;
  const FINAL_INDEX = 40; // stop with item centered
  const reelRewards: WeightedReward[] = [];
  for(let i=0;i<ITEM_COUNT;i++){ if(i===FINAL_INDEX) reelRewards.push(final); else reelRewards.push(pickWeighted()); }
  root.innerHTML = `<div style='display:flex;flex-direction:column;align-items:center;gap:14px;width:100%;'>
    <div class='lootbox-reel-wrapper' style='position:relative;width:320px;height:86px;overflow:hidden;border:3px solid #555;border-radius:14px;background:#111;'>
      <div class='indicator' style='position:absolute;left:50%;top:0;bottom:0;width:2px;background:#ff9f43;box-shadow:0 0 6px #ff9f43;transform:translateX(-50%);pointer-events:none;'></div>
      <div class='lootbox-track' style='display:flex;align-items:center;gap:8px;will-change:transform;padding:8px;'></div>
    </div>
  <button class='primary' data-action='open'>Start</button>
  </div>`;
  const track = root.querySelector('.lootbox-track') as HTMLDivElement;
  reelRewards.forEach(rw=>{
    const st = rarityStyles[rw.rarity];
    const el = document.createElement('div');
    el.className='lb-item';
    el.style.cssText = `flex:0 0 96px;height:60px;border:2px solid ${st.color};border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:.5px;text-align:center;color:${st.color};background:${st.bg};padding:4px;box-shadow:0 0 4px rgba(0,0,0,.6);`;
    el.innerHTML = `<span style='font-size:12px;'>${rw.reward.label.replace(/\s+/g,'<br>')}</span>`;
    track.appendChild(el);
  });
  const btn = root.querySelector('[data-action="open"]') as HTMLButtonElement;
  let started=false;
  btn.addEventListener('click',()=>{
    if(started||assign.completed) return; started=true; btn.disabled=true; btn.textContent='Opening...';
    const itemWidth = 96+8; // width + gap
    const targetOffset = (FINAL_INDEX * itemWidth) - (320/2 - itemWidth/2);
    const duration = 4500;
    const start = performance.now();
    function easeOutCubic(t:number){ return 1 - Math.pow(1-t,3); }
    function frame(now:number){
      const t = Math.min(1, (now-start)/duration);
      const eased = easeOutCubic(t);
      const current = targetOffset * eased;
      track.style.transform = `translateX(${-current}px)`;
      if(t<1) requestAnimationFrame(frame); else finish();
    }
    requestAnimationFrame(frame);
    function finish(){
      const wrapper = root.querySelector('.lootbox-reel-wrapper') as HTMLDivElement;
      const indicatorX = wrapper.getBoundingClientRect().left + wrapper.clientWidth/2;
      let bestIndex = 0; let bestDist = Infinity; let bestEl:HTMLDivElement|null=null;
      Array.from(track.children).forEach((c,i)=>{
        const rect = (c as HTMLDivElement).getBoundingClientRect();
        const cx = rect.left + rect.width/2;
        const d = Math.abs(cx - indicatorX);
        if(d < bestDist){ bestDist=d; bestIndex=i; bestEl=c as HTMLDivElement; }
      });
      const finalEl = bestEl || (track.children[FINAL_INDEX] as HTMLDivElement);
      finalEl.style.outline='3px solid #fff';
      finalEl.animate([
        { transform:'scale(1)' },{ transform:'scale(1.15)' },{ transform:'scale(1)' }
      ],{ duration:600, easing:'ease' });
      const rewardObj = reelRewards[bestIndex].reward;
      finalizeMinigameManual(assign, rewardObj, resultEl);
    }
  });
}

// ---------------- Dice Roll UI ----------------
let isRolling = false;
function renderDice() {
  let bar = document.querySelector('.dice-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'dice-bar';
    bar.innerHTML = `
      <div class="dice-wrapper" style="display:flex;align-items:center;justify-content:center;">
        <button type="button" class="dice-cube dice-roll-btn" aria-label="Roll Dice" title="Roll Dice">-</button>
      </div>`;
    document.getElementById('app')?.appendChild(bar);
    const rollBtn = bar.querySelector('.dice-roll-btn') as HTMLButtonElement;
    const sharedFace = rollBtn; // rolled value appears on the dice itself
    // Style injection for dice if missing
    if(!document.getElementById('dice-style')){
      const style = document.createElement('style');
      style.id='dice-style';
      style.textContent = `.dice-bar{display:flex;justify-content:center;margin-top:6px;}
        .dice-cube{width:72px;height:72px;background:#222;border:4px solid #ff9f43;border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#fff;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,0.5);transition:transform .18s, background .25s, box-shadow .25s;}
        .dice-cube:hover:not(:disabled){transform:translateY(-3px) rotateZ(-3deg);}
        .dice-cube:disabled{opacity:.55;cursor:default;}
        .dice-cube.daily-used{background:#3a3f44 !important;color:#888;box-shadow:inset 0 0 0 3px #555;}
        .dice-cube.daily-used::after{content:'Daily used';position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:11px;font-weight:600;color:#bbb;letter-spacing:.5px;}
      `;
      document.head.appendChild(style);
    }
    rollBtn.addEventListener('click', () => {
      if (isRolling) return;
      if (progress.current >= LEVEL_COUNT) { sharedFace.textContent = '🏁'; return; }
      if(dayState.rollUsed){ return; }
      maybeApplyTutorialPopups('pre_roll');
      isRolling = true;
      rollBtn.disabled = true;
      rollBtn.classList.remove('can-roll');
      rollBtn.classList.add('spinning');
      let ticks = 0;
      let target = 1 + Math.floor(Math.random() * 6);
      const plan = getTutorialPlanForDay(dayState.day);
      if(plan && plan.forcedDice>=1 && plan.forcedDice<=6) target = plan.forcedDice;
      const spin = setInterval(() => {
        ticks++;
        sharedFace.textContent = String(1 + Math.floor(Math.random()*6));
        if (ticks >= 10) {
          clearInterval(spin);
          sharedFace.textContent = String(target);
          maybeApplyTutorialPopups('post_roll');
          advanceBy(target);
          dayState.rollUsed = true; saveDayState(); updateDayUI();
          setTimeout(() => { isRolling = false; rollBtn.classList.remove('spinning'); updateDayUI(); }, 900);
        }
      }, 80);
    });
  }
}

// Legend modal (if not already defined above)
function openLegendModal(){
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className='modal-backdrop';
  const modal = document.createElement('div'); modal.className='modal'; modal.setAttribute('role','dialog');
  const items = [
    {cat:'instant_tokens', label:'Instant Tokens', desc:'Immediate token bundle.'},
    {cat:'instant_prize', label:'Instant Prize', desc:'Immediate Free Plays / Cash / Bonus.'},
    {cat:'reveal', label:'Reveal', desc:'Open a random reward reveal.'},
    {cat:'minigame', label:'Minigame', desc:'Play for a reward.'},
    {cat:'bonus_round', label:'Bonus Round', desc:'High-value reward chance.'},
    {cat:'mystery', label:'Mystery', desc:'Transforms when landed on.'},
    {cat:'extra_move', label:'Extra Move', desc:'Automatically roll forward again.'},
    {cat:'travel_back', label:'Travel Back', desc:'Move backwards (no reward).'}
  ];
  modal.innerHTML = `<h2>Tile Legend</h2>
  <div class='legend-list' style='display:flex;flex-direction:column;gap:10px;max-height:360px;overflow:auto;'>
    ${items.map(i=>`<div style='display:flex;align-items:center;gap:10px;'>
      <canvas data-shape='${i.cat}' width='52' height='52' style='background:transparent;'></canvas>
      <div><strong>${i.label}</strong><br/><span style='font-size:12px;opacity:.85;'>${i.desc}</span></div>
    </div>`).join('')}
  </div><div class='modal-footer'><button class='primary' data-action='close'>Close</button></div>`;
  backdrop.addEventListener('click', e=>{ if(e.target===backdrop) closeModal(); });
  modal.querySelector('[data-action="close"]')?.addEventListener('click', closeModal);
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  setTimeout(()=>{
    modal.querySelectorAll('canvas[data-shape]').forEach(cnv=>{
      const ctx=(cnv as HTMLCanvasElement).getContext('2d'); if(!ctx) return; const r=20; const type=(cnv as HTMLCanvasElement).dataset.shape as CategoryId; ctx.lineWidth=3; ctx.strokeStyle='#182028'; ctx.fillStyle='#5a6470'; ctx.beginPath();
      switch(type){
        case 'instant_tokens': circlePath(ctx,26,26,r); break;
        case 'instant_prize': roundRectPath(ctx,6,6,40,40,10); break;
        case 'reveal': polygon(ctx,26,26,r,6,-Math.PI/6); break;
        case 'minigame': diamond(ctx,26,26,r); break;
        case 'bonus_round': star(ctx,26,26,r,5,0.45); break;
        case 'mystery': polygon(ctx,26,26,r,5,-Math.PI/2); break;
        case 'extra_move': triangleUp(ctx,26,26,r); break;
        case 'travel_back': triangleDown(ctx,26,26,r); break;
      }
      ctx.fill(); ctx.stroke();
    });
  },30);
}
function circlePath(ctx:CanvasRenderingContext2D,x:number,y:number,r:number){ ctx.moveTo(x+r,y); ctx.arc(x,y,r,0,Math.PI*2); }
function polygon(ctx:CanvasRenderingContext2D,cx:number,cy:number,r:number,sides:number,rot=0){ for(let i=0;i<sides;i++){ const a=rot+Math.PI*2*i/sides; const x=cx+Math.cos(a)*r; const y=cy+Math.sin(a)*r; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.closePath(); }
function diamond(ctx:CanvasRenderingContext2D,cx:number,cy:number,r:number){ ctx.moveTo(cx,cy-r); ctx.lineTo(cx+r,cy); ctx.lineTo(cx,cy+r); ctx.lineTo(cx-r,cy); ctx.closePath(); }
function star(ctx:CanvasRenderingContext2D,cx:number,cy:number,r:number,points:number,innerRatio:number){ for(let i=0;i<points*2;i++){ const a=-Math.PI/2 + Math.PI*i/points; const rad=i%2===0? r: r*innerRatio; const x=cx+Math.cos(a)*rad; const y=cy+Math.sin(a)*rad; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.closePath(); }
function triangleUp(ctx:CanvasRenderingContext2D,cx:number,cy:number,r:number){ ctx.moveTo(cx,cy-r); ctx.lineTo(cx+r,cy+r); ctx.lineTo(cx-r,cy+r); ctx.closePath(); }
function triangleDown(ctx:CanvasRenderingContext2D,cx:number,cy:number,r:number){ ctx.moveTo(cx-r,cy-r); ctx.lineTo(cx+r,cy-r); ctx.lineTo(cx,cy+r); ctx.closePath(); }
function roundRectPath(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number){ const rr=Math.min(r,w/2,h/2); ctx.moveTo(x+rr,y); ctx.lineTo(x+w-rr,y); ctx.quadraticCurveTo(x+w,y,x+w,y+rr); ctx.lineTo(x+w,y+h-rr); ctx.quadraticCurveTo(x+w,y+h,x+w-rr,y+h); ctx.lineTo(x+rr,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-rr); ctx.lineTo(x,y+rr); ctx.quadraticCurveTo(x,y,x+rr,y); }

// ---------------- Category Interaction Helpers ----------------
function randInt(a:number,b:number){ return a + Math.floor(Math.random()*(b-a+1)); }

function openInfoModal(title:string, bodyHtml:string, onClose?:()=>void){
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className='modal-backdrop';
  const modal = document.createElement('div'); modal.className='modal'; modal.setAttribute('role','dialog');
  const tutorialContext = isTutorialActive(dayState.day) && (title==='Info' || title==='Tutorial');
  if(tutorialContext){
    ensureTutorStyles();
    modal.classList.add('tutor-modal');
    modal.innerHTML = `<div class='tutor-stage'>
        <div class='tutor-portrait-wrap'>
          <img src='${carnivalCharacterUrl}' alt='Guide' class='tutor-character'/>
        </div>
        <div class='tutor-speech'>
          <div class='tutor-speech-arrow'></div>
          <div class='tutor-speech-inner'>
            <h2>${title}</h2>
            <div class='tutor-text'>${bodyHtml}</div>
            <div class='tutor-actions'><button class='primary' data-action='close'>Close</button></div>
          </div>
        </div>
      </div>`;
  } else {
    modal.innerHTML = `<h2>${title}</h2><div class='body'>${bodyHtml}</div><div class='modal-footer'><button class='primary' data-action='close'>Close</button></div>`;
  }
  // Disable backdrop dismissal for tutorial clarity
  backdrop.addEventListener('click', e=>{ /* no outside close */ });
  modal.querySelector('[data-action="close"]')?.addEventListener('click', ()=>{ closeModal(); onClose?.(); });
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
}

function openInstantTokensModal(assign:CategoryAssignment){
  const amount = randInt(10,50);
  addTokens(amount);
  // Meta bonus (instant rewards now also grant key & star)
  addStreakKeys(1); addPrizeStars(1); pendingMetaTrail = true;
  assign.completed = true; saveCategoryAssignments(); refreshStates();
  openInfoModal('Instant Tokens', `<p>You received <strong>${amount} Tokens</strong>.</p>${formatMetaBonusLine()}` , ()=>{ 
    const wasPending = pendingPostInstantWinPhase; 
    maybeQueuePostInstantWinPhase(); 
    if(pendingPostInstantWinPhase || wasPending){ pendingPostInstantWinPhase=false; maybeApplyTutorialPopups('post_instantwin'); }
  });
}

function randomInstantPrize(){
  const kind = ['freePlays','bonus','cash'][randInt(0,2)] as 'freePlays'|'bonus'|'cash';
  if(kind==='freePlays'){ const amt=randInt(1,3); return { label: `${amt} Free Play${amt>1?'s':''}`, apply:()=> addFreePlays(amt) }; }
  if(kind==='bonus'){ const p = randInt(1,50)*10; return { label: `${formatCash(p)} Bonus Money`, apply:()=> addBonusPence(p) }; }
  const c = randInt(1,10)*100; return { label: `${formatCash(c)} Cash`, apply:()=> addCashPence(c) };
}
function randomBonusRoundPrize(){
  const pool = [
    ()=>{ const t=randInt(20,100); addTokens(t); return `${t} Tokens`; },
    ()=>{ const fp=randInt(1,3); addFreePlays(fp); return `${fp} Free Play${fp>1?'s':''}`; },
    ()=>{ const b=randInt(10,50)*10; addBonusPence(b); return `${formatCash(b)} Bonus`; },
    ()=>{ const c=randInt(1,10)*100; addCashPence(c); return `${formatCash(c)} Cash`; }
  ];
  const fn = pool[randInt(0,pool.length-1)]; const label = fn(); return { label, apply:()=>{} }; // already applied
}

function openInstantPrizeModal(assign:CategoryAssignment){
  let label:string;
  if(assign.forcedReward){
    applyReward(assign.forcedReward);
    label = assign.forcedReward.label;
  } else {
    const prize = randomInstantPrize(); prize.apply(); label = prize.label;
  }
  // Meta bonus
  addStreakKeys(1); addPrizeStars(1); pendingMetaTrail = true;
  assign.completed = true; saveCategoryAssignments(); refreshStates();
  openInfoModal('Instant Prize', `<p>You won <strong>${label}</strong>.</p>${formatMetaBonusLine()}` , ()=>{ 
    const wasPending = pendingPostInstantWinPhase; 
    maybeQueuePostInstantWinPhase(); 
    if(pendingPostInstantWinPhase || wasPending){ pendingPostInstantWinPhase=false; maybeApplyTutorialPopups('post_instantwin'); }
  });
}

function openBonusRoundModal(assign:CategoryAssignment){
  const prize = randomBonusRoundPrize(); // already applied
  addStreakKeys(1); addPrizeStars(1); pendingMetaTrail = true;
  assign.completed = true; saveCategoryAssignments(); refreshStates();
  openInfoModal('BONUS ROUND', `<p><strong>${prize.label}</strong></p>${formatMetaBonusLine()}` , ()=>{ 
    const wasPending = pendingPostBonusRoundPhase; 
    maybeQueuePostBonusRoundPhase(); 
    if(pendingPostBonusRoundPhase || wasPending){ 
      // Ensure full chain shows even if previously partially shown
      forceReplayPhases.add('post_bonus_round');
      pendingPostBonusRoundPhase=false; 
      maybeApplyTutorialPopups('post_bonus_round'); 
    }
  });
}

function openRevealModal(assign:CategoryAssignment){
  // Simplified: direct reveal (pick-1-of-3 removed)
  closeModal();
  const reward = randomInstantPrize(); reward.apply();
  addStreakKeys(1); addPrizeStars(1); pendingMetaTrail = true;
  assign.completed = true; saveCategoryAssignments(); refreshStates();
  openInfoModal('Reveal', `<p>You uncovered <strong>${reward.label}</strong>.</p>${formatMetaBonusLine()}` , ()=>{ 
    const wasPending = pendingPostInstantWinPhase; 
    maybeQueuePostInstantWinPhase(); 
    if(pendingPostInstantWinPhase || wasPending){ pendingPostInstantWinPhase=false; maybeApplyTutorialPopups('post_instantwin'); }
  });
}

function openMoveChainModal(assign:CategoryAssignment, forward:boolean){
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className='modal-backdrop';
  const modal = document.createElement('div'); modal.className='modal'; modal.setAttribute('role','dialog');
  modal.innerHTML = `<h2>${forward? 'Extra Move':'Travel Back'}</h2><p>Rolling...</p>
    <div class='move-die' style='font-size:42px;font-weight:700;margin:14px auto;width:84px;height:84px;display:flex;align-items:center;justify-content:center;background:#222;border:3px solid #ff9f43;border-radius:16px;'>-</div>`;
  const die = modal.querySelector('.move-die') as HTMLDivElement;
  let ticks=0; const target = randInt(1,6);
  const timer = setInterval(()=>{
    ticks++; die.textContent=String(randInt(1,6));
    if(ticks>14){ clearInterval(timer); die.textContent=String(target); assign.completed=true; saveCategoryAssignments(); refreshStates(); setTimeout(()=>{ closeModal(); if(forward) advanceBy(target); else retreatBy(target); }, 650); }
  },80);
  backdrop.addEventListener('click', e=>{ if(e.target===backdrop) closeModal(); });
  modal.querySelector('.close-btn')?.addEventListener('click', closeModal);
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
}

// Kick off
initApp();
// Initial start_day popup (delay to ensure layout complete)
setTimeout(()=>{ maybeApplyTutorialPopups('start_day'); }, 800);

// Inject shared tutor speech bubble styles once
function ensureTutorStyles(){
  if(document.getElementById('tutor-bubble-styles')) return;
  const style = document.createElement('style');
  style.id='tutor-bubble-styles';
  style.textContent = `
  .tutor-modal{background:transparent !important;box-shadow:none !important;padding:0 !important;max-width:none !important;width:100% !important;}
  :root{--tutor-char-width:340px;--tutor-char-width-mobile:230px;--tutor-char-max-vw:60vw;--tutor-stage-top-shift:100px;--tutor-bubble-max:560px;--tutor-stage-max:600px;--tutor-stage-right-extra:50px;}
  /* Centered tutorial layout */
  .tutor-stage{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;padding: clamp(16px,4vh,40px) clamp(16px,5vw,48px);gap:32px;width:100%;max-width:var(--tutor-stage-max);margin:0 auto; box-sizing:border-box;}
  .tutor-speech{order:1;position:relative;max-width:var(--tutor-bubble-max);width:100%;margin:0 auto;display:flex;flex-direction:column;}
  .tutor-speech-inner{background:#1c232b;border:2px solid #ff9f43;border-radius:26px;padding:28px 30px 30px;box-shadow:0 14px 34px rgba(0,0,0,0.6);font-size:15px;line-height:1.6;}
  .tutor-speech-inner h2{margin:0 0 12px;font-size:22px;}
  .tutor-text{font-size:15px;}
  .tutor-actions{margin-top:22px;display:flex;justify-content:flex-end;}
  /* Arrow removed when centered */
  .tutor-speech-arrow{display:none;}
  .tutor-speech-arrow:after{display:none;}
  .tutor-portrait-wrap{order:2;display:flex;align-items:flex-end;justify-content:center;margin-top:12px;}
  .tutor-character{width:var(--tutor-char-width);max-width:var(--tutor-char-max-vw);height:auto;filter:drop-shadow(0 10px 18px rgba(0,0,0,.7));transition:transform .45s ease;image-rendering:auto;}
  .tutor-stage:hover .tutor-character{transform:translateY(4px);} 
  /* Responsive adjustments */
  @media (max-width:900px){
    .tutor-stage{padding: clamp(16px,4vh,34px) clamp(16px,5vw,42px);}
    .tutor-character{width:calc(var(--tutor-char-width) - 60px);}
    .tutor-speech-inner{padding:26px 24px 28px;font-size:14px;}
    .tutor-speech-inner h2{font-size:20px;}
  }
  @media (max-width:560px){
    .tutor-stage{padding: clamp(12px,3vh,30px) 16px;}
    .tutor-character{width:var(--tutor-char-width-mobile);}
    .tutor-speech-inner{padding:22px 20px 24px;font-size:13px;}
    .tutor-speech-inner h2{font-size:19px;}
  }
  @media (min-width:1280px){
    .tutor-stage{min-height:100dvh;}
    .tutor-character{width:380px;max-width:50vw;}
  }
  `;
  document.head.appendChild(style);
}

// ---------------- Day Transition / Advancement ----------------
function ensureDayFader(){
  let el = document.getElementById('day-fader');
  if(!el){
    el = document.createElement('div');
    el.id='day-fader';
    Object.assign(el.style,{position:'fixed',left:'0',top:'0',right:'0',bottom:'0',background:'#000',opacity:'0',transition:'opacity 420ms ease',zIndex:'9998',pointerEvents:'none'});
    document.body.appendChild(el);
  }
  return el as HTMLDivElement;
}
function advanceDayWithTransition(){
  const fader = ensureDayFader();
  fader.style.pointerEvents='auto';
  const labelId = 'day-fader-label';
  let label = document.getElementById(labelId) as HTMLDivElement | null;
  if(!label){
    label = document.createElement('div');
    label.id = labelId;
    Object.assign(label.style,{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',color:'#fff',fontSize:'48px',fontWeight:'700',fontFamily:'system-ui, sans-serif',textShadow:'0 4px 12px rgba(0,0,0,0.6)',opacity:'0',transition:'opacity 500ms ease'});
    fader.appendChild(label);
  }
  requestAnimationFrame(()=>{ fader.style.opacity='1'; });
  // After fade-in completes, increment day, show label for 3s, then fade out.
  const prevDay = dayState.day;
  setTimeout(()=>{
    // Legacy streak removed; maintain streakKeys reset if roll not used
    if(!dayState.rollUsed && streakKeys !== 0){ streakKeys = 0; saveCurrencies(); }
    maybeApplyTutorialPopups('end_day');
  dayState.day += 1; dayState.rollUsed = false; saveDayState();
  // If we just moved from final tutorial day (8 -> 9), expand board
  if(prevDay === 8 && dayState.day === 9){
    transitionToMainBoard();
  }
  // Reset inline next-day UI: show dice, remove inline button, reset flags
  dayMinigameCompleted = false;
  const diceBtn = document.querySelector('.dice-roll-btn') as HTMLButtonElement | null;
  if(diceBtn){ diceBtn.style.display=''; }
  document.querySelectorAll('.inline-next-day-btn').forEach(el=> el.remove());
  updateDayUI();
    if(label){ label.textContent = `Day ${dayState.day}`; label.style.opacity='1'; }
    setTimeout(()=>{
      if(label) label.style.opacity='0';
      fader.style.opacity='0';
      setTimeout(()=>{ 
        fader.style.pointerEvents='none'; 
        // Trigger start_day popups for the new day after fade completes
        maybeApplyTutorialPopups('start_day');
      }, 500);
    }, 3000); // hold 3 seconds
  }, 500);
}

// Expand from tutorial board (1-30) to main board (1-100) and place player at tile 30 start of new journey
function transitionToMainBoard(){
  // Increase level cap
  LEVEL_COUNT = 100;
  // Place player at tile 30 (end of tutorial trail). Ensure progress saved.
  progress.current = 30; saveProgress(progress);
  // Regenerate category & minigame assignments for enlarged board (fresh spread) keeping player position.
  generateMinigameAssignments(); // will use new LEVEL_COUNT for distribution logic indirectly where needed
  generateCategoryAssignments();
  // Rebuild trail visuals with new LEVEL_COUNT
  positions = generateVerticalPositions(LEVEL_COUNT);
  height = Math.max(1600, Math.max(...positions.map(p => p.y)) + 400);
  app.renderer.resize(viewWidth, viewHeight);
  trailLayer.removeChildren(); levelLayer.removeChildren(); connectors.splice(0, connectors.length); levelNodes.splice(0, levelNodes.length);
  buildTrail(); createLevels(); refreshStates(); positionPlayer(progress.current, true);
  buildBackground(); centerCameraOnLevel(progress.current, true); backgroundLayer.y = world.position.y; backgroundLayer.x = 0; updateZoneCrossfade();
  // Clear any residual tutorial popup scheduling (tutorial functions naturally no-op after day 8)
  console.log('[Transition] Tutorial complete. Main board activated (levels 1-100, starting at 30).');
}

// ---------------- Tutorial Reward & Popup System ----------------
type TutorialPopupPhase = 'start_day' | 'pre_roll' | 'post_roll' | 'post_move' | 'pre_minigame' | 'post_minigame' | 'post_instantwin' | 'post_bonus_round' | 'end_day';

interface ScheduledPopup { day:number; phase:TutorialPopupPhase; html:string; }
const tutorialPopups: ScheduledPopup[] = [];
const shownPlanPopups = new Set<string>();
// Force replay map: phases we want to ignore prior shown flags for exactly one invocation (clears after use)
const forceReplayPhases = new Set<TutorialPopupPhase>();
// Queued forced tutorial minigame (set when a tutorial reward wants a minigame). Launched after pre_minigame popups close.
let pendingForcedMinigame: MinigameId | null = null;
function launchPendingForcedMinigame(){
  if(!pendingForcedMinigame) return;
  // Avoid launching over an existing modal (wait for closure).
  if(document.querySelector('.modal-backdrop')) return;
  const game = pendingForcedMinigame;
  pendingForcedMinigame = null;
  openMinigameModal({ level: progress.current, game, completed:false });
}

function queueTutorialPopup(day:number, phase:TutorialPopupPhase, html:string){
  tutorialPopups.push({ day, phase, html });
}

function maybeApplyTutorialPopups(phase:TutorialPopupPhase): boolean {
  if(!isTutorialActive(dayState.day)) return false;
  const day = dayState.day;
  const collected: string[] = [];
  const forceReplay = forceReplayPhases.has(phase);
  if(forceReplay){ forceReplayPhases.delete(phase); }
  // Inline plan popups
  const plan = getTutorialPlanForDay(day);
  if(plan && (plan as any).popups && (plan as any).popups[phase]){
    const raw = (plan as any).popups[phase];
    const arr = Array.isArray(raw)? raw : [raw];
    arr.forEach(html=>{
      const key = `${day}:${phase}:${html}`;
      if(forceReplay){
        // Push regardless; leave shownPlanPopups as-is (do not re-add to avoid inflating state) but allow re-display
        collected.push(html);
        return;
      }
      if(!shownPlanPopups.has(key)){
        shownPlanPopups.add(key);
        collected.push(html);
      }
    });
  }
  // Legacy queued popups
  const legacy = tutorialPopups.filter(p=> p.day===day && p.phase===phase);
  legacy.forEach(p=> collected.push(p.html));
  if(collected.length===0) return false;
  if(collected.length===1){
    openInfoModal('Info', collected[0]);
    return true;
  }
  // Multi-step modal chain
  openChainedInfoModal(collected);
  return true;
}

function openChainedInfoModal(pages:string[]){
  closeModal();
  let index = 0;
  const backdrop = document.createElement('div'); backdrop.className='modal-backdrop';
  const modal = document.createElement('div'); modal.className='modal'; modal.setAttribute('role','dialog');
  const withPortrait = isTutorialActive(dayState.day);
  if(withPortrait) ensureTutorStyles();
  if(withPortrait){
    modal.classList.add('tutor-modal');
    backdrop.classList.add('tutor-backdrop');
    backdrop.classList.add('tutor-backdrop');
    modal.innerHTML = `<div class='tutor-stage'>
        <div class='tutor-portrait-wrap'>
          <img src='${carnivalCharacterUrl}' alt='Guide' class='tutor-character'/>
        </div>
        <div class='tutor-speech'>
          <div class='tutor-speech-arrow'></div>
          <div class='tutor-speech-inner'>
            <h2>Tutorial</h2>
            <div class='tutor-copy'></div>
            <div class='tutor-actions chain-actions'>
              <div class='progress-indicator'></div>
              <div class='nav-btns'>
                <button class='secondary prev-btn' type='button' style='display:none;'>Back</button>
                <button class='primary next-btn' type='button'>Next</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  } else {
    modal.innerHTML = `<h2>Tutorial</h2>
      <div class='body multi-body'><div class='tutor-copy'></div></div>
      <div class='modal-footer' style='display:flex;justify-content:space-between;align-items:center;width:100%;'>
        <div class='progress-indicator' style='font-size:12px;font-weight:600;letter-spacing:.5px;opacity:.75;'></div>
        <div style='display:flex;gap:8px;'>
          <button class='secondary prev-btn' type='button' style='display:none;'>Back</button>
          <button class='primary next-btn' type='button'>Next</button>
        </div>
      </div>`;
  }
  // Disable outside click dismissal
  backdrop.addEventListener('click', ()=>{});
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  const copyRoot = modal.querySelector('.tutor-copy') as HTMLDivElement | null;
  const nextBtn = modal.querySelector('.next-btn') as HTMLButtonElement | null;
  const prevBtn = modal.querySelector('.prev-btn') as HTMLButtonElement | null;
  const prog = modal.querySelector('.progress-indicator') as HTMLDivElement | null;
  function render(){
    if(copyRoot){ copyRoot.innerHTML = pages[index]; }
    else {
      const body = modal.querySelector('.multi-body') as HTMLDivElement | null;
      if(body) body.innerHTML = pages[index];
    }
    if(prog) prog.textContent = `Step ${index+1} / ${pages.length}`;
    if(prevBtn) prevBtn.style.display = index>0 ? 'inline-block':'none';
    if(nextBtn) nextBtn.textContent = index === pages.length-1 ? 'Finish' : 'Next';
  }
  nextBtn?.addEventListener('click',()=>{ if(index < pages.length-1){ index++; render(); } else { closeModal(); } });
  prevBtn?.addEventListener('click',()=>{ if(index>0){ index--; render(); } });
  render();
}

// ---------------- Next Day Overlay Logic ----------------
// New day completion evaluation replaces overlay & top-right next day button
let dayMinigameCompleted = false;
function evaluateDayCompletion(){
  if(movementInProgress) return; // defer until movement chain fully finished
  // Conditions: roll used AND (either no forced minigame today OR minigame completed if one was forced)
  const plan = getTutorialPlanForDay(dayState.day);
  const needsMinigame = plan && plan.reward.kind==='minigame' && plan.reward.minigame;
  if(!dayState.rollUsed) return;
  if(needsMinigame && !dayMinigameCompleted) return;
  // If milestone ready and not consumed, show after all other overlays/prompt sequences closed
  if(tokenDualPopupReady && !tokenDualPopupConsumed){
    // Ensure no tutorial or prize star jackpot is pending first
    if(!document.querySelector('.modal-backdrop')){
      if(tokens >= 120){ tokens -= 120; saveTokens(); updateTokenCounter(); }
      tokenDualPopupConsumed = true; tokenDualPopupReady = false;
      openDualThresholdOverlay();
      return; // wait until user finishes chosen game before continuing day completion
    }
  }
  // Check prize star jackpot before enabling next day if threshold met and not yet played today
  if(prizeStars >=5 && !prizeStarJackpotPlayedToday){
    // Launch jackpot overlay (defer actual next-day button swap until after overlay)
    openPrizeStarJackpot();
    return;
  }
  // Swap dice for next-day button if not already swapped
  const diceBtn = document.querySelector('.dice-roll-btn') as HTMLButtonElement | null;
  if(diceBtn && diceBtn.parentElement){
    if(diceBtn.style.display!=='none'){
      diceBtn.style.display='none';
      const holder = diceBtn.parentElement;
      let nextBtn = holder.querySelector('.inline-next-day-btn') as HTMLButtonElement | null;
      if(!nextBtn){
        nextBtn = document.createElement('button');
        nextBtn.type='button';
        nextBtn.className='inline-next-day-btn';
        nextBtn.textContent='Next Day';
        Object.assign(nextBtn.style,{width:'140px',height:'72px',background:'#ff9f43',border:'4px solid #ffcf9a',borderRadius:'18px',fontWeight:'800',fontSize:'18px',cursor:'pointer',color:'#111',boxShadow:'0 4px 10px rgba(0,0,0,0.45)'});
        nextBtn.addEventListener('click',()=>{ advanceDayWithTransition(); });
        holder.appendChild(nextBtn);
      }
    }
  }
}
// Patch updateDayUI to re-run evaluation (restore dice at new day handled in advanceDayWithTransition)
const originalUpdateDayUI = updateDayUI;
(updateDayUI as any) = function patchedUpdateDayUI(){
  originalUpdateDayUI();
  evaluateDayCompletion();
};

// Prize Star Jackpot (5/5) -------------------------------------------------
let prizeStarJackpotPlayedToday = false;
function openPrizeStarJackpot(){
  if(prizeStarJackpotPlayedToday) return;
  prizeStarJackpotPlayedToday = true;
  // Simple activation shine on progress bar
  const wrap = document.querySelector('.prize-star-progress');
  if(wrap){
    wrap.classList.add('ps-progress-activating');
    wrap.animate([
      { boxShadow:'0 0 0 0 rgba(255,159,67,0.0)' },
      { boxShadow:'0 0 14px 4px rgba(255,159,67,0.85)' },
      { boxShadow:'0 0 0 0 rgba(255,159,67,0.0)' }
    ],{ duration:1400, easing:'ease' });
  }
  setTimeout(()=> showPrizeStarJackpotOverlay(), 600);
}

function showPrizeStarJackpotOverlay(){
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className='modal-backdrop jackpot-backdrop';
  backdrop.style.backdropFilter='blur(4px)';
  const modal = document.createElement('div');
  modal.className='modal jackpot-modal';
  modal.style.maxWidth='640px';
  modal.style.width='100%';
  modal.innerHTML = `<h2 style='text-align:center;margin-bottom:8px;'>Prize Star Bonus Game</h2>
    <p style='text-align:center;margin:0 0 18px;font-size:14px;line-height:1.5;'>Scratch 3 panels to reveal your guaranteed big reward!</p>
    <div class='scratch-grid' style='display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 auto 20px;max-width:420px;'></div>
    <div class='jackpot-result' style='text-align:center;font-weight:600;font-size:16px;min-height:32px;'></div>
    <div class='modal-footer' style='justify-content:center;'><button class='primary jackpot-close' type='button' disabled>Close</button></div>`;
  const grid = modal.querySelector('.scratch-grid') as HTMLDivElement;
  const resultEl = modal.querySelector('.jackpot-result') as HTMLDivElement;
  const closeBtn = modal.querySelector('.jackpot-close') as HTMLButtonElement;
  const rewards = [
    { kind:'freePlays', amount:10, label:'10 Free Plays' },
    { kind:'bonus', amount:1000, label:'£10 Bonus Money' },
    { kind:'cash', amount:500, label:'£5 Cash' }
  ] as Reward[];
  // For now guarantee all 3 unique then randomly pick one final reveal sequence (player always "wins")
  const revealPool = [...rewards];
  const panelCount = 9;
  let revealed = 0;
  let chosenReward: Reward | null = null;
  for(let i=0;i<panelCount;i++){
    const btn = document.createElement('button');
    btn.type='button';
    btn.className='scratch-panel';
    Object.assign(btn.style,{
      position:'relative',height:'90px',background:'#222',border:'2px solid #555',borderRadius:'12px',cursor:'pointer',fontWeight:'700',color:'#ffcf9a',fontSize:'15px',letterSpacing:'.5px',display:'flex',alignItems:'center',justifyContent:'center'
    });
    btn.textContent='SCRATCH';
    btn.addEventListener('click',()=>{
      if(btn.dataset.revealed==='1') return;
      btn.dataset.revealed='1';
      revealed++;
      // Assign a reward symbol (cycle through revealPool first 3 picks, then repeat one of them)
      if(!chosenReward){
        // First three picks: assign unique rewards
        if(revealed<=3){
          const r = revealPool.shift()!; // guaranteed
          btn.textContent = r.label;
          if(revealed===3){
            // Choose one of the revealed rewards as final prize
            chosenReward = r; // deterministic last one picked acts as prize (simplify)
            finalizeJackpotReward(chosenReward, resultEl, closeBtn);
          }
        } else {
          btn.textContent='—';
        }
      } else {
        btn.textContent= chosenReward.label;
      }
      btn.style.background='#333';
      btn.style.borderColor='#ff9f43';
    });
    grid.appendChild(btn);
  }
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  closeBtn.addEventListener('click',()=>{
    if(closeBtn.disabled) return;
    // Reset prize stars back to zero after awarding
    prizeStars = 0; saveCurrencies(); updateCurrencyCounters();
    closeModal(); // remove jackpot modal
    evaluateDayCompletion(); // continue normal flow (next-day button etc.)
  });
}

function finalizeJackpotReward(r:Reward, resultEl:HTMLDivElement, closeBtn:HTMLButtonElement){
  // Apply the reward (guaranteed win) and show message
  applyReward(r);
  resultEl.innerHTML = `<p><strong>Congrats!</strong> You won ${r.label}!</p>`;
  closeBtn.disabled = false;
}

// ================= 120 Token Dual Choice Overlay & Games =================
function openDualThresholdOverlay(){
  ensureDualStyles();
  if(document.querySelector('.modal-backdrop')) return;
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className='modal-backdrop dual-choice-backdrop';
  const wrap = document.createElement('div');
  wrap.className='dual-choice-wrap';
  wrap.innerHTML = `
    <div class='dual-choice-header'>
      <h1>Milestone Unlocked!</h1>
      <p>You reached 120 Tokens. Choose ONE premium bonus game.</p>
    </div>
    <div class='dual-choice-inner'>
      <div class='choice left-choice' tabindex='0'>
        <div class='dual-choice-badges'><span class='dual-choice-badge'>Guaranteed Win</span><span class='dual-choice-badge'>High Value</span></div>
        <h2>Scratch Jackpot</h2>
        <p>Scratch 3 premium panels. One high-tier reward is yours—no duds.</p>
        <button type='button' class='primary play-left'>Play Scratch</button>
      </div>
      <div class='choice right-choice' tabindex='0'>
        <div class='dual-choice-badges'><span class='dual-choice-badge'>Tension Build</span><span class='dual-choice-badge'>Big Range</span></div>
        <h2>Mega Box Pick</h2>
        <p>Keep one box, eliminate the rest, then decide: stay or switch at the end.</p>
        <button type='button' class='primary play-right'>Play Mega Box</button>
      </div>
    </div>`;
  backdrop.appendChild(wrap); document.body.appendChild(backdrop); document.body.classList.add('modal-open');
  const toScratch = ()=>{ closeModal(); openSpecialScratchJackpotOverlay(); };
  const toMega = ()=>{ closeModal(); openMegaBoxGameOverlay(); };
  wrap.querySelector('.play-left')?.addEventListener('click', toScratch);
  wrap.querySelector('.play-right')?.addEventListener('click', toMega);
  const leftChoice = wrap.querySelector('.left-choice');
  const rightChoice = wrap.querySelector('.right-choice');
  if(leftChoice){ (leftChoice as HTMLElement).addEventListener('keydown', (e:any)=>{ const k=e.key||e.code; if(k==='Enter' || k===' ') { e.preventDefault(); toScratch(); }}); }
  if(rightChoice){ (rightChoice as HTMLElement).addEventListener('keydown', (e:any)=>{ const k=e.key||e.code; if(k==='Enter' || k===' ') { e.preventDefault(); toMega(); }}); }
  (leftChoice as HTMLElement)?.focus();
}

function ensureDualStyles(){
  let style = document.getElementById('dual-choice-styles') as HTMLStyleElement | null;
  if(!style){ style = document.createElement('style'); style.id='dual-choice-styles'; document.head.appendChild(style); }
  style.textContent = `
  .dual-choice-backdrop{backdrop-filter:blur(6px);}
  .dual-choice-wrap{width:100%;max-width:1000px;display:flex;flex-direction:column;align-items:stretch;padding:28px 26px 34px;gap:26px;}
  .dual-choice-header{text-align:center;}
  .dual-choice-header h1{margin:0 0 8px;font-size:30px;background:linear-gradient(90deg,#ffb25b,#ff6d3b);-webkit-background-clip:text;color:transparent;letter-spacing:1px;font-weight:800;}
  .dual-choice-header p{margin:0;font-size:15px;opacity:.85;letter-spacing:.5px;}
  .dual-choice-inner{display:flex;gap:34px;flex-wrap:wrap;justify-content:center;width:100%;}
  .dual-choice-inner .choice{position:relative;flex:1 1 360px;max-width:440px;background:linear-gradient(155deg,#111b23,#0c1217 60%,#181f26);border:2px solid rgba(255,159,67,0.65);border-radius:26px;padding:26px 28px 28px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 40px -14px rgba(0,0,0,0.75),0 0 0 1px rgba(255,159,67,0.15);overflow:hidden;}
  .dual-choice-inner .choice:before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 28% 18%,rgba(255,159,67,0.18),transparent 60%);pointer-events:none;}
  .dual-choice-inner .choice h2{margin:0 0 4px;font-size:24px;letter-spacing:.5px;}
  .dual-choice-inner .choice p{margin:0 0 10px;font-size:15px;line-height:1.55;opacity:.9;}
  .dual-choice-inner .choice button{align-self:flex-start;transition:transform .18s ease,background .2s;}
  .dual-choice-inner .choice:hover{border-color:#ffbc6e;box-shadow:0 18px 42px -14px rgba(0,0,0,0.8),0 0 0 1px rgba(255,188,110,0.35);}
  .dual-choice-inner .choice:hover button{transform:translateY(-2px);}
  .dual-choice-badges{display:flex;gap:10px;flex-wrap:wrap;}
  .dual-choice-badge{background:#1f2d36;padding:4px 10px;border-radius:30px;font-size:11px;letter-spacing:.7px;font-weight:600;text-transform:uppercase;border:1px solid #314149;color:#ffb56a;}
  @media(max-width:760px){ .dual-choice-inner{flex-direction:column;} .dual-choice-header h1{font-size:24px;} }
  .special-scratch{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:420px;margin:0 auto 20px;}
  .special-scratch button{position:relative;height:90px;background:#222;border:2px solid #555;border-radius:14px;cursor:pointer;font-weight:700;color:#ffcf9a;font-size:15px;letter-spacing:.5px;display:flex;align-items:center;justify-content:center;transition:background .2s,border-color .2s,transform .18s;}
  .special-scratch button:not(.revealed):hover{background:#2b2b2b;transform:translateY(-3px);} 
  .special-scratch button.revealed{background:#333;border-color:#ff9f43;}
  .mega-box-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;max-width:640px;margin:0 auto 16px;}
  .mega-box-grid button{height:86px;background:#1b2228;border:2px solid #3a4550;border-radius:12px;color:#fff;font-weight:600;cursor:pointer;letter-spacing:.5px;font-size:14px;position:relative;transition:background .18s,border-color .18s,transform .18s;}
  .mega-box-grid button:not(.opened):hover{background:#25323a;transform:translateY(-3px);} 
  .mega-box-grid button.kept{outline:3px solid #ff9f43;}
  .mega-box-grid button.eliminated{background:#101417;border-color:#222;color:#555;}
  .mega-box-grid button.final{animation:pulseFinal 1.4s ease-in-out infinite alternate;}
  @keyframes pulseFinal{0%{box-shadow:0 0 0 0 rgba(255,159,67,0.4);}100%{box-shadow:0 0 0 6px rgba(255,159,67,0.0);} }
  .mega-status{min-height:52px;text-align:center;font-size:15px;font-weight:600;letter-spacing:.5px;}
  .mega-decisions{display:flex;justify-content:center;gap:18px;margin:6px 0 10px;}
  .mega-decisions button{min-width:140px;}
  .mega-close-row{display:flex;justify-content:center;margin-top:8px;}
  .mega-close-row button{min-width:160px;}
  `;
}

function openSpecialScratchJackpotOverlay(){
  ensureDualStyles();
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className='modal-backdrop';
  const modal = document.createElement('div'); modal.className='modal';
  modal.style.maxWidth='680px';
  modal.innerHTML = `<h2 style='text-align:center;margin:0 0 10px;'>Grand Scratch Bonus</h2>
    <p style='text-align:center;margin:0 0 16px;font-size:14px;'>Scratch any 3 panels. One of the displayed rewards will be yours!</p>
    <div class='special-scratch'></div>
    <div class='jackpot-result' style='text-align:center;font-weight:600;font-size:16px;min-height:34px;'></div>
    <div class='modal-footer' style='justify-content:center;'><button class='primary close-special' type='button' disabled>Close</button></div>`;
  const grid = modal.querySelector('.special-scratch') as HTMLDivElement;
  const resultEl = modal.querySelector('.jackpot-result') as HTMLDivElement;
  const closeBtn = modal.querySelector('.close-special') as HTMLButtonElement;
  const rewards: Reward[] = [
    { kind:'freePlays', amount:15, label:'15 Free Plays' },
    { kind:'bonus', amount:1500, label:'£15 Bonus Money' },
    { kind:'cash', amount:1000, label:'£10 Cash' }
  ];
  let revealed=0; let finalReward: Reward | null = null;
  for(let i=0;i<9;i++){
    const btn = document.createElement('button'); btn.type='button'; btn.textContent='SCRATCH';
    btn.addEventListener('click',()=>{
      if(btn.classList.contains('revealed')) return;
      revealed++;
      if(revealed<=3){
        const pick = rewards[revealed-1];
        btn.textContent = pick.label; finalReward = pick; btn.classList.add('revealed');
        if(revealed===3 && finalReward){
          applyReward(finalReward); resultEl.innerHTML = `<p><strong>You won ${finalReward.label}!</strong></p>`; closeBtn.disabled=false;
        }
      } else {
        btn.textContent='—'; btn.classList.add('revealed');
      }
    });
    grid.appendChild(btn);
  }
  backdrop.appendChild(modal); document.body.appendChild(backdrop); document.body.classList.add('modal-open');
  closeBtn.addEventListener('click',()=>{ if(!closeBtn.disabled) closeModal(); });
}

function openMegaBoxGameOverlay(){
  ensureDualStyles();
  closeModal();
  const backdrop = document.createElement('div'); backdrop.className='modal-backdrop';
  const modal = document.createElement('div'); modal.className='modal'; modal.style.maxWidth='860px';
  modal.innerHTML = `<button class='close-x' aria-label='Close' style='position:absolute;top:10px;right:10px;background:#222;border:1px solid #444;color:#fff;border-radius:50%;width:34px;height:34px;font-size:16px;cursor:pointer;'>&times;</button>
    <h2 style='text-align:center;margin:0 0 10px;'>Mega Box Pick</h2>
    <p style='text-align:center;margin:0 0 14px;font-size:14px;'>Pick a box to keep. Eliminate the rest. When only one other box remains, decide to <strong>Keep</strong> or <strong>Switch</strong>. The unchosen final box will always be Nothing.</p>
    <div class='mega-box-grid'></div>
    <div class='mega-status'></div>
    <div class='mega-decisions' style='display:none;'>
      <button type='button' class='primary keep-choice' disabled>Keep My Box</button>
      <button type='button' class='secondary switch-choice' disabled>Switch Boxes</button>
    </div>
    <div class='mega-close-row' style='display:none;'>
      <button type='button' class='primary close-mega'>Close</button>
    </div>`;
  const grid = modal.querySelector('.mega-box-grid') as HTMLDivElement;
  const statusEl = modal.querySelector('.mega-status') as HTMLDivElement;
  const keepBtn = modal.querySelector('.keep-choice') as HTMLButtonElement;
  const switchBtn = modal.querySelector('.switch-choice') as HTMLButtonElement;
  const decisionsRow = modal.querySelector('.mega-decisions') as HTMLDivElement;
  const closeRow = modal.querySelector('.mega-close-row') as HTMLDivElement;
  const closeBtnTop = modal.querySelector('.close-x') as HTMLButtonElement;
  const closeBtnBottom = modal.querySelector('.close-mega') as HTMLButtonElement;
  closeBtnTop.addEventListener('click', closeModal); closeBtnBottom.addEventListener('click', closeModal);
  const rewardPool: Reward[] = [
    { kind:'cash', amount:2000, label:'£20 Cash' },
    { kind:'bonus', amount:2500, label:'£25 Bonus' },
    { kind:'freePlays', amount:20, label:'20 Free Plays' },
    { kind:'cash', amount:1000, label:'£10 Cash' },
    { kind:'bonus', amount:1500, label:'£15 Bonus' },
    { kind:'freePlays', amount:10, label:'10 Free Plays' },
    { kind:'tokens', amount:200, label:'200 Tokens' },
    { kind:'bonus', amount:500, label:'£5 Bonus' },
    { kind:'cash', amount:500, label:'£5 Cash' },
    { kind:'freePlays', amount:5, label:'5 Free Plays' },
    { kind:'tokens', amount:100, label:'100 Tokens' },
    { kind:'bonus', amount:1000, label:'£10 Bonus' }
  ];
  for(let i=rewardPool.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [rewardPool[i],rewardPool[j]]=[rewardPool[j],rewardPool[i]]; }
  interface BoxData { idx:number; reward:Reward; kept?:boolean; opened?:boolean; el:HTMLButtonElement; }
  const boxes: BoxData[] = rewardPool.map((r,i)=>{ const el=document.createElement('button'); el.type='button'; el.textContent=String(i+1); grid.appendChild(el); return { idx:i, reward:r, el }; });
  let keptBox: BoxData | null = null;
  let finalContender: BoxData | null = null;
  let finished = false;
  function updateStatus(msg:string){ statusEl.innerHTML = `<p>${msg}</p>`; }
  updateStatus('Select a box to keep.');
  boxes.forEach(b=>{
    b.el.addEventListener('click',()=>{
      if(finished) return;
      if(!keptBox){ keptBox = b; b.kept=true; b.el.classList.add('kept'); updateStatus('Now open every other box.'); return; }
      if(b===keptBox || b.opened) return;
      b.opened=true; b.el.classList.add('eliminated'); b.el.textContent = b.reward.label; b.el.classList.add('opened');
      const remaining = boxes.filter(x=> !x.opened && x!==keptBox);
      if(remaining.length===1){
        finalContender = remaining[0];
        finalContender.el.classList.add('final'); keptBox!.el.classList.add('final');
        updateStatus('Final decision: Keep your box or Switch?');
        decisionsRow.style.display='flex';
        keepBtn.disabled=false; switchBtn.disabled=false; keepBtn.focus();
      }
    });
  });
  function conclude(playerBox: BoxData, otherBox: BoxData){
    if(finished) return; finished = true;
    applyReward(playerBox.reward);
    playerBox.el.textContent = playerBox.reward.label + ' (Won)';
    otherBox.el.textContent = 'Nothing'; otherBox.el.classList.add('eliminated');
    // Outline handling: ensure only winning (kept) box shows kept outline
    boxes.forEach(b=> b.el.classList.remove('kept'));
    playerBox.el.classList.add('kept');
    otherBox.el.classList.remove('kept');
    updateStatus(`<strong>You won ${playerBox.reward.label}!</strong>`);
    decisionsRow.style.display='none';
    closeRow.style.display='flex';
    closeBtnBottom.focus();
  }
  keepBtn.addEventListener('click',()=>{ if(!keptBox || !finalContender) return; conclude(keptBox, finalContender); });
  switchBtn.addEventListener('click',()=>{ if(!keptBox || !finalContender) return; conclude(finalContender, keptBox); });
  backdrop.appendChild(modal); document.body.appendChild(backdrop); document.body.classList.add('modal-open');
}


function maybeApplyTutorialReward(triggerPhase: 'post_move' | 'post_minigame'){
  if(!isTutorialActive(dayState.day)) return;
  const plan = getTutorialPlanForDay(dayState.day);
  if(!plan) return;
  const flagKey = `tutorialRewardApplied_${plan.day}`;
  if((window as any)[flagKey]) return;
  if(triggerPhase==='post_move'){
    applyTutorialReward(plan);
    (window as any)[flagKey] = true;
    if(plan.reward.kind==='minigame' && plan.reward.minigame){
      // Queue minigame and show pre_minigame popups first. After user closes them, we auto-launch.
      pendingForcedMinigame = plan.reward.minigame as MinigameId;
      setTimeout(()=>{
        // We no longer show pre_minigame BEFORE the minigame; launch directly and overlay instructions inside the modal.
        launchPendingForcedMinigame();
      },450);
    }
  }
  if(triggerPhase==='post_minigame'){
    // Placeholder for future phases
  }
}

function applyTutorialReward(plan:TutorialDayPlan){
  const r = plan.reward;
  switch(r.kind){
    case 'tokens': if(r.amount) addTokens(r.amount); break;
    case 'prize': {
      // Placeholder: map prizeId to 1 free play unless amount provided
      if(r.amount) addFreePlays(r.amount); else if(r.prizeId){ addFreePlays(1); }
      break;
    }
    case 'freePlays': if(r.amount){ addFreePlays(r.amount); } break;
  case 'streak_boost': if(r.amount){ addPrizeStars(Math.min(5, r.amount)); } break;
    case 'nothing': default: break;
    case 'minigame': break; // minigame opened separately
  }
}

// Seed some tutorial popups (can be expanded or replaced later)
// queueTutorialPopup(1,'pre_roll',"<p>Welcome! Let's start your journey. Tap the dice to move.</p>");
// queueTutorialPopup(1,'post_move',"<p>Great! You earned some starter tokens.</p>");
// queueTutorialPopup(4,'pre_minigame',"<p>Your first minigame! Try it out.</p>");
// queueTutorialPopup(8,'end_day',"<p>Tutorial complete! Jungle zone unlocks tomorrow.</p>");
