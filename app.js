/* =========================================================
   PURIKURA BOOTH - app.js
   撮影 → 編集（レイアウト/フレーム/スタンプ/テキスト） → 印刷 or QR
   ========================================================= */

const DEFAULT_SETTINGS = {
  password: '0000',
  shotCount: 4,
  countdownSec: 3,
  defaultLayout: 'grid2x2',
  defaultFrame: 'pink',
  logoDataURL: null,
  customStamps: [],
  soundEnabled: true,
  announceShotNumber: true,
  customSounds: { start: null, shotCue: null, countdownTick: null, shutter: null, shotCueByNumber: {} },
  adItems: [],
  adIntervalSec: 8,
  adBarItems: [],
  adBarIntervalSec: 8,
  subCameraCaption: '',
  adsensePub: '',
  adsenseSlot: '',
  editTimeLimitSec: 90,
};

function loadSettings(){
  try{
    const raw = localStorage.getItem('purikuraSettings');
    if(!raw) return { ...DEFAULT_SETTINGS, customSounds: { ...DEFAULT_SETTINGS.customSounds, shotCueByNumber: {} } };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      customSounds: {
        ...DEFAULT_SETTINGS.customSounds,
        ...(parsed.customSounds || {}),
        shotCueByNumber: { ...((parsed.customSounds && parsed.customSounds.shotCueByNumber) || {}) },
      },
    };
  }catch(e){ return { ...DEFAULT_SETTINGS, customSounds: { ...DEFAULT_SETTINGS.customSounds, shotCueByNumber: {} } }; }
}
function saveSettings(settings){
  try{
    localStorage.setItem('purikuraSettings', JSON.stringify(settings));
    return true;
  }catch(e){
    console.error(e);
    return false;
  }
}

const state = {
  stream: null,
  currentFilter: 'none',
  shots: [],          // 撮影した画像（HTMLCanvasElement）
  selectedShotIndices: [], // 使う写真（state.shotsへのインデックス、並び順）
  editingShotIndex: 0,
  layout: 'grid2x2',  // 'grid2x2' | 'strip'
  frame: 'pink',      // 'pink' | 'mint' | 'gold' | 'dot'
  textColor: '#ff3d9a',
  textFont: "'Mochiy Pop One', sans-serif",
  selectedSticker: null, // record
  stickers: [],
  strokes: [],
  activeStrokes: new Map(), // ポインターIDごとの描画中ストローク（マルチタッチ対応）
  drawMode: false,
  penColor: '#ff3d9a',
  penEffect: 'normal',
  penWidth: 10,
  printQty: 1,
  finalDataURL: null,
  settings: loadSettings(),
};

/* ---------- サブ画面との同期（BroadcastChannel） ---------- */
let syncChannel = null;
try{ syncChannel = new BroadcastChannel('purikura-sync'); }catch(e){ /* 未対応ブラウザは無視 */ }
function broadcastStatus(id){
  if(syncChannel) syncChannel.postMessage({ type: 'status', screen: id === 'screen-camera' ? 'camera' : 'other' });
}

/* ---------- 画面切り替え ---------- */
const STEP_MAP = { 'screen-camera':'camera', 'screen-edit':'edit', 'screen-output':'output' };

function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  broadcastStatus(id);

  const stepDots = document.getElementById('step-dots');
  const activeStep = STEP_MAP[id];
  if(activeStep){
    stepDots.style.visibility = 'visible';
    stepDots.querySelectorAll('.step').forEach(el=>{
      el.classList.toggle('current', el.dataset.step === activeStep);
    });
  }else{
    stepDots.style.visibility = 'hidden'; // スタート画面では非表示
  }
}
// 広告スライドショーはサブ画面(sub.html)専用です。メイン画面には表示されません。

/* ---------- 紙吹雪演出 ---------- */
const CONFETTI_EMOJI = ['✨','⭐','💖','🎀','🎉'];
function burstConfetti(count = 18){
  for(let i=0;i<count;i++){
    const el = document.createElement('span');
    el.className = 'confetti-piece';
    el.textContent = CONFETTI_EMOJI[Math.floor(Math.random()*CONFETTI_EMOJI.length)];
    el.style.left = Math.random()*100 + 'vw';
    el.style.animationDuration = (1.6 + Math.random()*1.2) + 's';
    el.style.fontSize = (1 + Math.random()*1.2) + 'rem';
    document.body.appendChild(el);
    setTimeout(()=> el.remove(), 3000);
  }
}

/* ---------- ロゴ表示 ---------- */
function applyLogo(){
  const img = document.getElementById('custom-logo');
  const defaultLogo = document.getElementById('default-logo');
  if(state.settings.logoDataURL){
    img.onload = ()=>{ img.classList.add('show'); defaultLogo.style.display = 'none'; };
    img.onerror = null;
    img.src = state.settings.logoDataURL;
  }else{
    // 設定でのロゴ指定がなければ、同フォルダの logo.png を試す（なければテキストロゴのまま）
    img.classList.remove('show');
    defaultLogo.style.display = '';
    img.onload = ()=>{ img.classList.add('show'); defaultLogo.style.display = 'none'; };
    img.onerror = ()=>{ img.classList.remove('show'); };
    img.src = 'logo.png?' + Date.now();
  }
}
applyLogo();

/* ---------- カメラ起動 ---------- */
const videoEl = document.getElementById('video');

async function startCamera(){
  try{
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' },
      audio: false
    });
    videoEl.srcObject = state.stream;
    startFrameBroadcast();
  }catch(err){
    alert('カメラを起動できませんでした。ブラウザのカメラ権限を許可してください。\n(' + err.message + ')');
    console.error(err);
  }
}

function stopCamera(){
  if(state.stream){
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  stopFrameBroadcast();
}

/* ---------- サブ画面へのカメラプレビュー配信 ---------- */
let frameBroadcastTimer = null;
function startFrameBroadcast(){
  stopFrameBroadcast();
  if(!syncChannel) return;
  frameBroadcastTimer = setInterval(()=>{
    if(!videoEl.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = Math.round(960 * videoEl.videoHeight / videoEl.videoWidth);
    const cx = c.getContext('2d');
    cx.save();
    cx.translate(c.width, 0);
    cx.scale(-1, 1); // 見た目どおりミラー
    cx.drawImage(videoEl, 0, 0, c.width, c.height);
    cx.restore();
    try{ syncChannel.postMessage({ type: 'camera-frame', dataURL: c.toDataURL('image/jpeg', 0.6) }); }catch(e){}
  }, 150);
}
function stopFrameBroadcast(){
  clearInterval(frameBroadcastTimer);
  frameBroadcastTimer = null;
}

/* ---------- フィルター選択 ---------- */
const FILTER_CSS = {
  none:  '',
  soft:  'brightness(1.1) contrast(0.92) saturate(1.05)',
  vivid: 'saturate(1.6) contrast(1.15)',
  mono:  'grayscale(1) contrast(1.1)',
  sepia: 'sepia(0.7) contrast(1.05)',
};
const FILTER_CLASS = { none:'', soft:'f-soft', vivid:'f-vivid', mono:'f-mono', sepia:'f-sepia' };

document.getElementById('filter-picker').addEventListener('click', (e)=>{
  const btn = e.target.closest('.filter-chip[data-filter]');
  if(!btn) return;
  document.querySelectorAll('#filter-picker .filter-chip[data-filter]').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  state.currentFilter = btn.dataset.filter;
  videoEl.className = '';
  if(FILTER_CLASS[state.currentFilter]) videoEl.classList.add(FILTER_CLASS[state.currentFilter]);
});

const soundToggleBtn = document.getElementById('btn-sound-toggle');
function syncSoundToggleBtn(){
  soundToggleBtn.textContent = state.settings.soundEnabled ? '🔊 音声ON' : '🔇 音声OFF';
  soundToggleBtn.classList.toggle('active', state.settings.soundEnabled);
}
syncSoundToggleBtn();
soundToggleBtn.addEventListener('click', ()=>{
  state.settings.soundEnabled = !state.settings.soundEnabled;
  saveSettings(state.settings);
  syncSoundToggleBtn();
});

/* ---------- 撮影シーケンス ---------- */
const countdownEl = document.getElementById('countdown');
const flashEl = document.getElementById('flash');
const shotIndicatorEl = document.getElementById('shot-indicator');
const cameraFrameEl = document.querySelector('.camera-frame');

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* ---------- 撮影時の音声・効果音 ---------- */
let audioCtx = null;
function getAudioCtx(){
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playBeep(freq = 880, duration = 0.12){
  if(!state.settings.soundEnabled) return;
  try{
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  }catch(e){ /* 音が出せない環境は無視 */ }
}
function playShutterSound(){
  if(!state.settings.soundEnabled) return;
  try{
    const ctx = getAudioCtx();
    [0, 0.07].forEach(delay=>{
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 1800;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.05);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.06);
    });
  }catch(e){ /* 音が出せない環境は無視 */ }
}
function speak(text){
  if(!state.settings.soundEnabled) return;
  try{
    if(!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  }catch(e){ /* 読み上げに対応していない環境は無視 */ }
}

// 自分でアップロードした音声ファイルを再生し、再生し終わるまで待つ（最大8秒でタイムアウト）
function playAudioClip(dataURL){
  return new Promise((resolve)=>{
    try{
      const audio = new Audio(dataURL);
      const done = ()=> resolve();
      audio.addEventListener('ended', done, { once:true });
      audio.addEventListener('error', done, { once:true });
      audio.play().catch(done);
      setTimeout(done, 8000);
    }catch(e){ resolve(); }
  });
}
function fireAudioClip(dataURL){
  try{ new Audio(dataURL).play().catch(()=>{}); }catch(e){}
}

// 各場面の音声：カスタム音声が設定されていればそれを再生、なければ自動音声・効果音にフォールバック
async function playStartCue(){
  if(!state.settings.soundEnabled) return;
  const custom = state.settings.customSounds && state.settings.customSounds.start;
  if(custom){ await playAudioClip(custom); }
  else{ speak('スタートするよ、ポーズの準備をしてね'); await sleep(1200); }
}
async function playShotCue(shotNumber){
  if(!state.settings.soundEnabled) return;
  const byNumber = state.settings.customSounds && state.settings.customSounds.shotCueByNumber;
  const numberSpecific = byNumber && byNumber[String(shotNumber)];
  if(numberSpecific){ await playAudioClip(numberSpecific); return; }
  const custom = state.settings.customSounds && state.settings.customSounds.shotCue;
  if(custom){ await playAudioClip(custom); return; }
  if(state.settings.announceShotNumber === false){ await sleep(300); return; }
  speak(`${shotNumber}枚目、いくよー`); await sleep(700);
}
function playCountdownCue(freq){
  if(!state.settings.soundEnabled) return;
  const custom = state.settings.customSounds && state.settings.customSounds.countdownTick;
  if(custom){ fireAudioClip(custom); }
  else{ playBeep(freq, 0.12); }
}
function playShutterCue(){
  if(!state.settings.soundEnabled) return;
  const custom = state.settings.customSounds && state.settings.customSounds.shutter;
  if(custom){ fireAudioClip(custom); }
  else{ playShutterSound(); }
}

function buildShotIndicator(){
  shotIndicatorEl.innerHTML = '';
  for(let i=0;i<state.settings.shotCount;i++){
    const s = document.createElement('span');
    shotIndicatorEl.appendChild(s);
  }
}

function markShotDone(i){
  const dots = shotIndicatorEl.querySelectorAll('span');
  if(dots[i]) dots[i].classList.add('done');
}

// 撮影の見た目（ミラー＋クロップ）そのままをキャプチャする（フィルターは後段で適用＝編集画面で選び直せる）
function captureVideoFrame(){
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  const boxW = cameraFrameEl.clientWidth, boxH = cameraFrameEl.clientHeight; // 4:3
  // object-fit: cover 相当のソース切り出し矩形を計算
  const boxRatio = boxW / boxH;
  const vRatio = vw / vh;
  let sx, sy, sw, sh;
  if(vRatio > boxRatio){ // 横長すぎる→左右を切る
    sh = vh; sw = vh * boxRatio; sy = 0; sx = (vw - sw) / 2;
  }else{ // 縦長すぎる→上下を切る
    sw = vw; sh = vw / boxRatio; sx = 0; sy = (vh - sh) / 2;
  }
  const out = document.createElement('canvas');
  out.width = 800; out.height = Math.round(800 / boxRatio);
  const ctx = out.getContext('2d');
  ctx.save();
  ctx.translate(out.width, 0);
  ctx.scale(-1, 1); // 見た目どおりミラー
  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, out.width, out.height);
  ctx.restore();
  return out;
}

async function runShootingSequence(){
  state.shots = [];
  buildShotIndicator();
  document.getElementById('btn-shoot').disabled = true;

  await playStartCue();

  for(let i=0;i<state.settings.shotCount;i++){
    await playShotCue(i+1);
    for(let n=state.settings.countdownSec;n>=1;n--){
      countdownEl.textContent = n;
      playCountdownCue(700 + (state.settings.countdownSec - n) * 90);
      await sleep(700);
    }
    countdownEl.textContent = '';
    flashEl.classList.remove('on'); void flashEl.offsetWidth; flashEl.classList.add('on');
    playShutterCue();
    const raw = captureVideoFrame();
    state.shots.push({ raw, filter: state.currentFilter, eye: 0, faceSlim: 0, _cache: null, _cacheKey: null });
    markShotDone(i);
    await sleep(500);
  }

  document.getElementById('btn-shoot').disabled = false;
  stopCamera();
  burstConfetti(24);
  goToEditScreen();
}

document.getElementById('btn-shoot').addEventListener('click', ()=>{
  try{ getAudioCtx().resume(); }catch(e){}
  runShootingSequence();
});
document.getElementById('btn-start').addEventListener('click', ()=>{
  showScreen('screen-camera');
  startCamera();
});

/* ---------- 編集画面（1組目 / 2組目の2つを並行編集） ---------- */
const editCanvas = document.getElementById('edit-canvas');
const stickerLayer = document.getElementById('sticker-layer');
const editCtx = editCanvas.getContext('2d');

/* ---------- らくがきペン（1枚の写真に、両サイドから・マルチタッチで同時に描ける） ---------- */
const doodleCanvas = document.getElementById('doodle-canvas');
const doodleCtx = doodleCanvas.getContext('2d');

function initDoodleCanvas(){
  const w = stickerLayer.clientWidth, h = stickerLayer.clientHeight;
  if(w > 0 && h > 0){
    doodleCanvas.width = w;
    doodleCanvas.height = h;
  }
  state.strokes = [];
  state.activeStrokes = new Map();
}

function strokePath(ctx, points){
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for(let i=1;i<points.length;i++){
    const p0 = points[i-1], p1 = points[i];
    const mx = (p0.x+p1.x)/2, my = (p0.y+p1.y)/2;
    ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
  }
  const last = points[points.length-1];
  ctx.lineTo(last.x, last.y);
}

function drawDot(ctx, p, color, width, effect){
  ctx.save();
  if(effect === 'eraser'){
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(p.x, p.y, width*0.9, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, width/2, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
}

const DRAW_EFFECTS = {
  normal(ctx, points, color, width){
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = 1;
    strokePath(ctx, points); ctx.stroke();
    ctx.restore();
  },
  glow(ctx, points, color, width){
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = width*2.2;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = 0.9;
    strokePath(ctx, points); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, width*0.35); ctx.globalAlpha = 0.95;
    strokePath(ctx, points); ctx.stroke();
    ctx.restore();
  },
  pixel(ctx, points, color, width){
    const grid = Math.max(8, Math.round(width*1.2));
    ctx.save();
    ctx.fillStyle = color;
    const seen = new Set();
    function stampAt(x,y){
      const gx = Math.round(x/grid)*grid, gy = Math.round(y/grid)*grid;
      const key = gx+','+gy;
      if(!seen.has(key)){ seen.add(key); ctx.fillRect(gx-grid/2, gy-grid/2, grid, grid); }
    }
    for(let i=0;i<points.length;i++){
      stampAt(points[i].x, points[i].y);
      if(i>0){
        const a = points[i-1], b = points[i];
        const dist = Math.hypot(b.x-a.x, b.y-a.y);
        const steps = Math.ceil(dist / Math.max(2, grid/2));
        for(let s=1;s<steps;s++){
          const t = s/steps;
          stampAt(a.x+(b.x-a.x)*t, a.y+(b.y-a.y)*t);
        }
      }
    }
    ctx.restore();
  },
  zombie(ctx, points, color, width){
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    for(let pass=0; pass<3; pass++){
      ctx.beginPath();
      ctx.lineWidth = width * (0.5 + Math.random()*0.7);
      ctx.globalAlpha = 0.45 + Math.random()*0.3;
      points.forEach((p,i)=>{
        const jx = p.x + (Math.random()-0.5)*width*0.35;
        const jy = p.y + (Math.random()-0.5)*width*0.35;
        if(i===0) ctx.moveTo(jx,jy); else ctx.lineTo(jx,jy);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 0.7;
    points.forEach((p,i)=>{
      if(i % 14 === 0){
        const dripLen = width * (1 + Math.random()*2.5);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x, p.y + dripLen);
        ctx.lineWidth = Math.max(1, width*0.25);
        ctx.stroke();
      }
    });
    ctx.restore();
  },
  pop(ctx, points, color, width){
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = width*1.6; ctx.globalAlpha = 1;
    strokePath(ctx, points); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width;
    strokePath(ctx, points); ctx.stroke();
    const dots = ['#ffc700','#00d9c6','#7c5cff','#ff3d9a'];
    points.forEach((p,i)=>{
      if(i % 10 === 0){
        ctx.beginPath();
        ctx.fillStyle = dots[Math.floor(Math.random()*dots.length)];
        ctx.arc(p.x + (Math.random()-0.5)*width*3, p.y + (Math.random()-0.5)*width*3, width*0.25, 0, Math.PI*2);
        ctx.fill();
      }
    });
    ctx.restore();
  },
  eraser(ctx, points, color, width){
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = width*1.8;
    strokePath(ctx, points); ctx.stroke();
    ctx.restore();
  },
};

function renderDoodleCanvas(){
  doodleCtx.clearRect(0, 0, doodleCanvas.width, doodleCanvas.height);
  const active = Array.from(state.activeStrokes.values());
  const all = [...state.strokes, ...active];
  all.forEach(s=>{
    if(s.points.length < 2){ drawDot(doodleCtx, s.points[0], s.color, s.width, s.effect); return; }
    (DRAW_EFFECTS[s.effect] || DRAW_EFFECTS.normal)(doodleCtx, s.points, s.color, s.width);
  });
}

function getDoodlePoint(e){
  const rect = doodleCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (doodleCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (doodleCanvas.height / rect.height);
  return { x, y };
}

// ポインターIDごとに描画中ストロークを管理するので、2人が同時に別々の指で描いてもOK
doodleCanvas.addEventListener('pointerdown', (e)=>{
  if(!state.drawMode) return;
  e.preventDefault();
  doodleCanvas.setPointerCapture(e.pointerId);
  const pt = getDoodlePoint(e);
  const pressure = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.6;
  state.activeStrokes.set(e.pointerId, {
    points: [pt],
    color: state.penColor,
    effect: state.penEffect,
    width: state.penWidth * (0.6 + pressure*0.8),
  });
  renderDoodleCanvas();
});
doodleCanvas.addEventListener('pointermove', (e)=>{
  if(!state.drawMode) return;
  const stroke = state.activeStrokes.get(e.pointerId);
  if(!stroke) return;
  stroke.points.push(getDoodlePoint(e));
  renderDoodleCanvas();
});
function endDoodleStroke(e){
  const stroke = state.activeStrokes.get(e.pointerId);
  if(stroke){
    state.strokes.push(stroke);
    state.activeStrokes.delete(e.pointerId);
  }
}
doodleCanvas.addEventListener('pointerup', endDoodleStroke);
doodleCanvas.addEventListener('pointercancel', endDoodleStroke);
doodleCanvas.addEventListener('pointerleave', endDoodleStroke);

// 左右どちらのパネルのボタンを押しても、同じ共有state・両パネルの表示を同期する
function syncBothPanels(selector, updateFn){
  document.querySelectorAll(selector).forEach(updateFn);
}

document.querySelectorAll('.btn-pen-toggle').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    state.drawMode = !state.drawMode;
    doodleCanvas.classList.toggle('pen-active', state.drawMode);
    syncBothPanels('.btn-pen-toggle', b=>{
      b.classList.toggle('active', state.drawMode);
      b.textContent = state.drawMode ? 'ペンをOFFにする' : 'ペンをONにする';
    });
  });
});
document.querySelectorAll('.draw-color-picker').forEach(picker=>{
  picker.addEventListener('click', (e)=>{
    const btn = e.target.closest('.color-chip'); if(!btn) return;
    state.penColor = btn.dataset.color;
    syncBothPanels('.draw-color-picker .color-chip', b=>{
      b.classList.toggle('active', b.dataset.color === state.penColor);
    });
  });
});
document.querySelectorAll('.draw-effect-picker').forEach(picker=>{
  picker.addEventListener('click', (e)=>{
    const btn = e.target.closest('.chip'); if(!btn) return;
    state.penEffect = btn.dataset.effect;
    syncBothPanels('.draw-effect-picker .chip', b=>{
      b.classList.toggle('active', b.dataset.effect === state.penEffect);
    });
  });
});
document.querySelectorAll('.draw-width').forEach(slider=>{
  slider.addEventListener('input', (e)=>{
    state.penWidth = parseInt(e.target.value, 10) || 10;
    syncBothPanels('.draw-width', s=>{ if(s !== e.target) s.value = state.penWidth; });
  });
});
document.querySelectorAll('.btn-undo-doodle').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    state.strokes.pop();
    renderDoodleCanvas();
  });
});
document.querySelectorAll('.btn-clear-doodle').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    state.strokes = [];
    state.activeStrokes = new Map();
    renderDoodleCanvas();
  });
});

function goToEditScreen(){
  showScreen('screen-edit');
  state.layout = state.settings.defaultLayout;
  state.frame = state.settings.defaultFrame;
  document.querySelectorAll('#layout-picker .chip').forEach(b=>b.classList.toggle('active', b.dataset.layout === state.layout));
  document.querySelectorAll('#frame-picker .chip').forEach(b=>b.classList.toggle('active', b.dataset.frame === state.frame));

  clearAllStickers();
  initDoodleCanvas();
  renderEditCanvas();

  state.drawMode = false;
  doodleCanvas.classList.remove('pen-active');
  syncBothPanels('.btn-pen-toggle', b=>{ b.classList.remove('active'); b.textContent = 'ペンをONにする'; });

  state.editingShotIndex = 0;
  state.selectedShotIndices = state.shots.map((_, i)=>i).slice(0, neededShotCount());
  buildShotThumbPicker();
  syncShotControls();
  buildImageStampPicker();
  detectFacesForAllShots(); // バックグラウンドでAI顔検出（失敗しても簡易版にフォールバック）
}

/* --- 写真ごとの補正（フィルター・デカ目・小顔）：拡大編集モーダルの中で操作する --- */
function buildShotThumbPicker(){
  const wrap = document.getElementById('shot-thumb-picker');
  wrap.innerHTML = '';
  state.shots.forEach((s, i)=>{
    const cell = document.createElement('div');
    cell.className = 'shot-thumb-cell';

    const btn = document.createElement('button');
    btn.className = 'shot-thumb-btn' + (i === state.editingShotIndex ? ' active' : '');
    const img = document.createElement('img');
    img.src = s.raw.toDataURL('image/jpeg', 0.6);
    btn.appendChild(img);
    btn.addEventListener('click', ()=>{
      state.editingShotIndex = i;
      wrap.querySelectorAll('.shot-thumb-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      syncShotControls();
      openShotZoomModal();
    });

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'shot-select-badge';
    const pos = state.selectedShotIndices.indexOf(i);
    if(pos >= 0){
      badge.textContent = String(pos + 1);
      badge.classList.add('selected');
    }else{
      badge.textContent = '＋';
    }
    badge.addEventListener('click', (e)=>{
      e.stopPropagation();
      toggleShotSelection(i);
    });

    cell.appendChild(btn);
    cell.appendChild(badge);
    wrap.appendChild(cell);
  });
  const countEl = document.getElementById('shot-select-count');
  if(countEl) countEl.textContent = `${state.selectedShotIndices.length}/${neededShotCount()}`;
}

function toggleShotSelection(i){
  const idx = state.selectedShotIndices.indexOf(i);
  if(idx >= 0){
    state.selectedShotIndices.splice(idx, 1);
  }else{
    if(state.selectedShotIndices.length >= neededShotCount()){
      alert(`使う写真は${neededShotCount()}枚までです。他の写真の✓を外してから選んでください。`);
      return;
    }
    state.selectedShotIndices.push(i);
  }
  buildShotThumbPicker();
  renderEditCanvas();
}

function syncShotControls(){
  const s = state.shots[state.editingShotIndex];
  if(!s) return;
  document.querySelectorAll('#shot-filter-picker .chip').forEach(b=>b.classList.toggle('active', b.dataset.filter === s.filter));
  document.getElementById('shot-eye-slider').value = Math.round((s.eye || 0) * 100);
  document.getElementById('shot-faceslim-slider').value = Math.round((s.faceSlim || 0) * 100);
  renderShotZoomCanvas();
}

const debouncedRenderEditCanvas = debounce(()=>{ renderEditCanvas(); renderShotZoomCanvas(); }, 100);

document.getElementById('shot-filter-picker').addEventListener('click', (e)=>{
  const btn = e.target.closest('.chip'); if(!btn) return;
  document.querySelectorAll('#shot-filter-picker .chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const s = state.shots[state.editingShotIndex];
  if(s){ s.filter = btn.dataset.filter; renderEditCanvas(); renderShotZoomCanvas(); }
});
document.getElementById('shot-eye-slider').addEventListener('input', (e)=>{
  const s = state.shots[state.editingShotIndex];
  if(s){ s.eye = (parseInt(e.target.value, 10) || 0) / 100; debouncedRenderEditCanvas(); }
});
document.getElementById('shot-faceslim-slider').addEventListener('input', (e)=>{
  const s = state.shots[state.editingShotIndex];
  if(s){ s.faceSlim = (parseInt(e.target.value, 10) || 0) / 100; debouncedRenderEditCanvas(); }
});

/* --- 拡大編集モーダル（写真ごとの補正をここで操作する） --- */
const shotZoomModal = document.getElementById('shot-zoom-modal');
const shotZoomCanvas = document.getElementById('shot-zoom-canvas');

function renderShotZoomCanvas(){
  if(shotZoomModal.style.display === 'none') return;
  const s = state.shots[state.editingShotIndex];
  if(!s) return;
  const processed = getProcessedShot(state.editingShotIndex);
  shotZoomCanvas.width = processed.width;
  shotZoomCanvas.height = processed.height;
  const ctx = shotZoomCanvas.getContext('2d');
  ctx.drawImage(processed, 0, 0);
}

function openShotZoomModal(){
  shotZoomModal.style.display = 'flex';
  renderShotZoomCanvas();
}
document.getElementById('btn-close-zoom').addEventListener('click', ()=>{
  shotZoomModal.style.display = 'none';
});

document.getElementById('layout-picker').addEventListener('click', (e)=>{
  const btn = e.target.closest('.chip'); if(!btn) return;
  document.querySelectorAll('#layout-picker .chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  state.layout = btn.dataset.layout;
  clearAllStickers();
  initDoodleCanvas();
  renderEditCanvas();
});

document.getElementById('frame-picker').addEventListener('click', (e)=>{
  const btn = e.target.closest('.chip'); if(!btn) return;
  document.querySelectorAll('#frame-picker .chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  state.frame = btn.dataset.frame;
  renderEditCanvas();
});

/* --- レイアウト別の描画 --- */
function drawCoverImage(ctx, img, dx, dy, dw, dh){
  const ir = img.width / img.height, dr = dw / dh;
  let sx, sy, sw, sh;
  if(ir > dr){ sh = img.height; sw = img.height * dr; sy = 0; sx = (img.width - sw)/2; }
  else{ sw = img.width; sh = img.width / dr; sx = 0; sy = (img.height - sh)/2; }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

/* --- 顔エフェクト：AIの顔認識（face-api.js）で目・顔の位置を検出し、取れない場合は簡易位置にフォールバック --- */
const FACE_MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
let faceApiLoadPromise = null;
function ensureFaceApiLoaded(){
  if(faceApiLoadPromise) return faceApiLoadPromise;
  if(typeof faceapi === 'undefined'){
    faceApiLoadPromise = Promise.reject(new Error('face-api.js not loaded'));
    return faceApiLoadPromise;
  }
  faceApiLoadPromise = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
  ]);
  return faceApiLoadPromise;
}

function setFaceEffectStatus(text){
  const el = document.getElementById('face-effect-status');
  if(el) el.textContent = text;
  const panelEl = document.getElementById('face-effect-status-panel');
  if(panelEl) panelEl.textContent = '顔AI補正: ' + text.replace(/^※/, '');
}

// 撮影後すぐに全カットの顔検出をバックグラウンドで試みる（失敗しても簡易版にフォールバックするだけ）
async function detectFacesForAllShots(){
  setFaceEffectStatus('※顔認識モデルを読み込み中…');
  try{
    await ensureFaceApiLoaded();
  }catch(err){
    console.warn('顔認識モデルを読み込めませんでした。簡易版で動作します。', err);
    setFaceEffectStatus('※AI顔認識が読み込めなかったため、簡易版（中央上寄り前提）で動作しています');
    state.shots.forEach(s => { s.landmarks = null; });
    return;
  }
  setFaceEffectStatus('※AIで顔の位置を検出しています…');
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });
  await Promise.all(state.shots.map(async (s)=>{
    try{
      const result = await faceapi.detectSingleFace(s.raw, options).withFaceLandmarks();
      s.landmarks = result ? result.landmarks.positions.map(p=>({x:p.x, y:p.y})) : null;
    }catch(err){
      s.landmarks = null;
    }
  }));
  const detectedCount = state.shots.filter(s=>s.landmarks).length;
  if(detectedCount > 0){
    setFaceEffectStatus(`※AIで顔を検出しました（${detectedCount}/${state.shots.length}枚）。検出できなかった写真は簡易版で動作します`);
  }else{
    setFaceEffectStatus('※このセットでは顔を検出できませんでした。簡易版（中央上寄り前提）で動作しています');
  }
  // 検出結果を反映するため、全カットのキャッシュを無効化して再描画
  state.shots.forEach(sh => { sh._cacheKey = null; });
  renderEditCanvas();
  renderShotZoomCanvas();
}

function avgPoints(pts){
  return { x: pts.reduce((a,p)=>a+p.x,0)/pts.length, y: pts.reduce((a,p)=>a+p.y,0)/pts.length };
}
function pointDist(a, b){ return Math.hypot(a.x-b.x, a.y-b.y); }

function getFaceWarps(s, w, h){
  const warps = [];
  if(s.landmarks && s.landmarks.length === 68){
    const L = s.landmarks;
    const leftEye = avgPoints(L.slice(36,42));
    const rightEye = avgPoints(L.slice(42,48));
    const eyeDist = pointDist(leftEye, rightEye);
    const eyeRadius = eyeDist * 0.5;
    if(s.eye > 0){
      warps.push({ cx: leftEye.x, cy: leftEye.y, radius: eyeRadius, strength: s.eye*0.32 });
      warps.push({ cx: rightEye.x, cy: rightEye.y, radius: eyeRadius, strength: s.eye*0.32 });
    }
    if(s.faceSlim > 0){
      const jawLeft = L[0], jawRight = L[16], chin = L[8];
      const faceCx = (jawLeft.x + jawRight.x) / 2;
      const faceCy = (leftEye.y + rightEye.y) / 2 * 0.3 + chin.y * 0.7;
      const faceRadius = pointDist(jawLeft, jawRight) * 0.62;
      warps.push({ cx: faceCx, cy: faceCy, radius: faceRadius, strength: -(s.faceSlim*0.22) });
    }
    return warps;
  }
  // フォールバック：簡易固定位置（顔が中央上寄りにある前提）
  if(s.eye > 0){
    warps.push({ cx: w*0.40, cy: h*0.36, radius: w*0.10, strength: s.eye*0.28 });
    warps.push({ cx: w*0.60, cy: h*0.36, radius: w*0.10, strength: s.eye*0.28 });
  }
  if(s.faceSlim > 0){
    warps.push({ cx: w*0.5, cy: h*0.50, radius: w*0.28, strength: -(s.faceSlim*0.2) });
  }
  return warps;
}

/* --- 顔エフェクト適用のワープ本体 --- */
function applyWarp(srcCanvas, warps){
  if(!warps.length) return srcCanvas;
  const w = srcCanvas.width, h = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, w, h);
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const dstCtx = dst.getContext('2d');
  const dstData = dstCtx.createImageData(w, h);
  const sp = srcData.data, dp = dstData.data;

  for(let y=0; y<h; y++){
    for(let x=0; x<w; x++){
      // 各ワープの変位を「元のピクセル位置」から独立に計算して合算する
      // （順番に適用すると、デカ目と小顔を同時に使ったときに変形が連鎖して
      //   意図しないゆがみ方になるため、そちらは避ける）
      let totalDx = 0, totalDy = 0;
      for(const wp of warps){
        const dx = x - wp.cx, dy = y - wp.cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if(dist < wp.radius && dist > 0.0001){
          const ratio = dist / wp.radius;
          // strength > 0 → 中心を拡大（デカ目）、strength < 0 → 中心を縮小（小顔）
          const power = 1 + wp.strength;
          const newRatio = Math.pow(ratio, power);
          const factor = newRatio / ratio;
          const nx = wp.cx + dx*factor;
          const ny = wp.cy + dy*factor;
          totalDx += (nx - x);
          totalDy += (ny - y);
        }
      }
      const sx = x + totalDx, sy = y + totalDy;
      const ix = Math.min(w-1, Math.max(0, Math.round(sx)));
      const iy = Math.min(h-1, Math.max(0, Math.round(sy)));
      const si = (iy*w + ix) * 4;
      const di = (y*w + x) * 4;
      dp[di] = sp[si]; dp[di+1] = sp[si+1]; dp[di+2] = sp[si+2]; dp[di+3] = sp[si+3];
    }
  }
  dstCtx.putImageData(dstData, 0, 0);
  return dst;
}

// 撮影ごとの補正（フィルター＋簡易顔エフェクト）を反映した画像をキャッシュ付きで返す
function getProcessedShot(i){
  const s = state.shots[i];
  if(!s) return null;
  const key = `${s.filter}|${s.eye}|${s.faceSlim}`;
  if(s._cacheKey === key && s._cache) return s._cache;

  let canvas = s.raw;
  if(s.filter && s.filter !== 'none'){
    const f = document.createElement('canvas');
    f.width = canvas.width; f.height = canvas.height;
    const fctx = f.getContext('2d');
    fctx.filter = FILTER_CSS[s.filter] || 'none';
    fctx.drawImage(canvas, 0, 0);
    canvas = f;
  }
  if(s.eye > 0 || s.faceSlim > 0){
    const w = canvas.width, h = canvas.height;
    const warps = getFaceWarps(s, w, h);
    canvas = applyWarp(canvas, warps);
  }
  s._cache = canvas;
  s._cacheKey = key;
  return canvas;
}

function debounce(fn, delay){
  let t;
  return (...args)=>{ clearTimeout(t); t = setTimeout(()=> fn(...args), delay); };
}


function drawFrameDecoration(ctx, w, h){
  const colors = {
    pink: ['#ff2e88', '#ff8fc2'],
    mint: ['#2be9c8', '#17c9ac'],
    gold: ['#ffe14d', '#ffb020'],
    dot:  ['#a26bff', '#ff2e88'],
  };
  const [c1, c2] = colors[state.frame];
  const border = Math.round(w * 0.025);
  ctx.strokeStyle = c1;
  ctx.lineWidth = border;
  ctx.strokeRect(border/2, border/2, w-border, h-border);

  // コーナー装飾（星っぽい四角の回転）
  function star(cx, cy, r, color){
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI/4);
    ctx.fillStyle = color;
    ctx.fillRect(-r/2, -r/2, r, r);
    ctx.restore();
  }
  const r = w * 0.035;
  const pad = border * 1.6;
  star(pad, pad, r, c2);
  star(w-pad, pad, r, c2);
  star(pad, h-pad, r, c2);
  star(w-pad, h-pad, r, c2);

  if(state.frame === 'dot'){
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const gap = w * 0.045;
    for(let x = gap; x < w; x += gap){
      ctx.beginPath(); ctx.arc(x, border*0.9, border*0.35, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, h-border*0.9, border*0.35, 0, Math.PI*2); ctx.fill();
    }
  }
}

function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

function neededShotCount(){
  return 4; // 現在のレイアウトはどちらも4枠
}

function renderEditCanvas(){
  let W, H, cells; // cells: [{x,y,w,h}]
  if(state.layout === 'grid2x2'){
    W = 1000; H = 1000;
    const margin = 40, gap = 24;
    const cw = (W - margin*2 - gap) / 2;
    const ch = (H - margin*2 - gap) / 2;
    cells = [
      {x:margin, y:margin, w:cw, h:ch},
      {x:margin+cw+gap, y:margin, w:cw, h:ch},
      {x:margin, y:margin+ch+gap, w:cw, h:ch},
      {x:margin+cw+gap, y:margin+ch+gap, w:cw, h:ch},
    ];
  } else { // strip
    W = 560; H = 1700;
    const margin = 34, gap = 20;
    const cw = W - margin*2;
    const ch = (H - margin*2 - gap*3) / 4;
    cells = [0,1,2,3].map(i => ({x:margin, y:margin + i*(ch+gap), w:cw, h:ch}));
  }

  editCanvas.width = W; editCanvas.height = H;
  editCtx.fillStyle = '#ffffff';
  editCtx.fillRect(0,0,W,H);

  state.selectedShotIndices.forEach((shotIdx, i)=>{
    if(cells[i] && state.shots[shotIdx]) drawCoverImage(editCtx, getProcessedShot(shotIdx), cells[i].x, cells[i].y, cells[i].w, cells[i].h);
  });

  drawFrameDecoration(editCtx, W, H);
}

/* ---------- デコスタンプ（プリクラ風のシール素材） ---------- */
const DECO_STAMPS = {
  star: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 5 L61 38 L97 38 L68 59 L79 92 L50 71 L21 92 L32 59 L3 38 L39 38 Z" fill="#ffc700" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/></svg>`,
  heart: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 88 C18 62 4 42 4 26 C4 10 18 0 34 3 C43 5 48 12 50 19 C52 12 57 5 66 3 C82 0 96 10 96 26 C96 42 82 62 50 88 Z" fill="#ff3d9a" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/></svg>`,
  ribbon: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M8 15 L46 46 L8 77 Z" fill="#7c5cff" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/><path d="M92 15 L54 46 L92 77 Z" fill="#7c5cff" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/><circle cx="50" cy="46" r="14" fill="#ff3d9a" stroke="#ffffff" stroke-width="6"/></svg>`,
  crown: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M8 42 L26 60 L38 30 L50 55 L62 30 L74 60 L92 42 L86 78 L14 78 Z" fill="#ffc700" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/><circle cx="26" cy="60" r="5" fill="#ff3d9a"/><circle cx="50" cy="55" r="5" fill="#7c5cff"/><circle cx="74" cy="60" r="5" fill="#00d9c6"/></svg>`,
  sparkle: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 2 C54 36 64 46 98 50 C64 54 54 64 50 98 C46 64 36 54 2 50 C36 46 46 36 50 2 Z" fill="#00d9c6" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/></svg>`,
  flower: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g fill="#ffb3da" stroke="#ffffff" stroke-width="4"><circle cx="50" cy="24" r="18"/><circle cx="76" cy="42" r="18"/><circle cx="67" cy="72" r="18"/><circle cx="33" cy="72" r="18"/><circle cx="24" cy="42" r="18"/></g><circle cx="50" cy="50" r="16" fill="#ffc700" stroke="#ffffff" stroke-width="4"/></svg>`,
};

function buildDecoPicker(){
  document.querySelectorAll('.deco-picker-target').forEach(wrap=>{
    Object.keys(DECO_STAMPS).forEach(id=>{
      const btn = document.createElement('button');
      btn.className = 'stamp-btn';
      btn.dataset.deco = id;
      btn.innerHTML = DECO_STAMPS[id];
      wrap.appendChild(btn);
    });
  });
}
buildDecoPicker();

const decoImageCache = {};
function getDecoImage(stampId){
  if(decoImageCache[stampId]) return decoImageCache[stampId];
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DECO_STAMPS[stampId]);
  decoImageCache[stampId] = img;
  return img;
}
function waitForImage(img){
  if(img.complete && img.naturalWidth > 0) return Promise.resolve(img);
  return new Promise((resolve)=>{
    img.onload = ()=> resolve(img);
    img.onerror = ()=> resolve(img);
  });
}

document.querySelectorAll('.deco-picker-target').forEach(wrap=>{
  wrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('.stamp-btn[data-deco]'); if(!btn) return;
    addDecoSticker(btn.dataset.deco);
  });
});

function addDecoSticker(stampId){
  const el = document.createElement('img');
  el.className = 'deco-el';
  el.draggable = false;
  el.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DECO_STAMPS[stampId]);
  const layerW = stickerLayer.clientWidth, layerH = stickerLayer.clientHeight;
  const x = layerW * 0.5, y = layerH * 0.5;
  el.style.left = x + 'px'; el.style.top = y + 'px';
  stickerLayer.appendChild(el);
  const record = { type:'deco', stampId, el, x, y, scale: 1 };
  state.stickers.push(record);
  applySelectionTransform(record);
  makeDraggable(record);
  selectSticker(record);
}

/* ---------- 画像スタンプ（設定ページで登録した画像から選ぶ） ---------- */
function buildImageStampPicker(){
  const stamps = state.settings.customStamps || [];
  document.querySelectorAll('.image-stamp-picker-target').forEach(wrap=>{
    wrap.innerHTML = '';
    if(stamps.length === 0){
      wrap.innerHTML = '<p class="panel-note">まだ画像スタンプがありません。「⚙設定」ページから追加してください。</p>';
      return;
    }
    stamps.forEach(src=>{
      const btn = document.createElement('button');
      btn.className = 'stamp-btn';
      const img = document.createElement('img');
      img.src = src;
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      btn.appendChild(img);
      btn.addEventListener('click', ()=> addImageSticker(src));
      wrap.appendChild(btn);
    });
  });
}

function addImageSticker(dataURL){
  const el = document.createElement('img');
  el.className = 'deco-el image-el';
  el.draggable = false;
  el.src = dataURL;
  const layerW = stickerLayer.clientWidth, layerH = stickerLayer.clientHeight;
  const x = layerW * 0.5, y = layerH * 0.5;
  el.style.left = x + 'px'; el.style.top = y + 'px';
  stickerLayer.appendChild(el);
  const record = { type:'image', el, x, y, scale: 1 };
  state.stickers.push(record);
  applySelectionTransform(record);
  makeDraggable(record);
  selectSticker(record);
}

document.querySelectorAll('.sticker-picker').forEach(wrap=>{
  wrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('.stamp-btn'); if(!btn || !btn.dataset.stamp) return;
    addEmojiSticker(btn.dataset.stamp);
  });
});

function addEmojiSticker(emoji){
  const el = document.createElement('div');
  el.className = 'sticker-el';
  el.textContent = emoji;
  const layerW = stickerLayer.clientWidth, layerH = stickerLayer.clientHeight;
  const x = layerW * 0.5, y = layerH * 0.5;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  stickerLayer.appendChild(el);
  const record = { type:'emoji', el, emoji, x, y, scale: 1 };
  state.stickers.push(record);
  applySelectionTransform(record);
  makeDraggable(record);
  selectSticker(record);
}

/* --- 文字（テキストスタンプ）機能：自由に配置・移動できる --- */
document.querySelectorAll('.text-color-picker').forEach(picker=>{
  picker.addEventListener('click', (e)=>{
    const btn = e.target.closest('.color-chip'); if(!btn) return;
    state.textColor = btn.dataset.color;
    syncBothPanels('.text-color-picker .color-chip', b=>{
      b.classList.toggle('active', b.dataset.color === state.textColor);
    });
  });
});

document.querySelectorAll('.text-font-picker').forEach(picker=>{
  picker.addEventListener('click', (e)=>{
    const btn = e.target.closest('.chip'); if(!btn) return;
    state.textFont = btn.dataset.font;
    syncBothPanels('.text-font-picker .chip', b=>{
      b.classList.toggle('active', b.dataset.font === state.textFont);
    });
  });
});

document.querySelectorAll('.btn-add-text').forEach(btn=>{
  btn.addEventListener('click', addTextSticker);
});

function addTextSticker(){
  const el = document.createElement('div');
  el.className = 'text-el';
  el.textContent = 'テキスト';
  el.style.color = state.textColor;
  el.style.fontFamily = state.textFont;
  const layerW = stickerLayer.clientWidth, layerH = stickerLayer.clientHeight;
  const x = layerW * 0.5, y = layerH * 0.5;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  stickerLayer.appendChild(el);
  const record = { type:'text', el, x, y, color: state.textColor, font: state.textFont, scale: 1 };
  state.stickers.push(record);
  applySelectionTransform(record);
  makeDraggable(record);
  selectSticker(record);

  el.addEventListener('dblclick', (e)=>{
    e.stopPropagation();
    el.contentEditable = 'true';
    el.classList.add('editing');
    el.focus();
    document.execCommand('selectAll', false, null);
  });
  el.addEventListener('blur', ()=>{
    el.contentEditable = 'false';
    el.classList.remove('editing');
    if(el.textContent.trim() === ''){
      el.remove();
      state.stickers = state.stickers.filter(s => s !== record);
      if(state.selectedSticker === record) deselectSticker();
    }
  });
  // 追加直後にすぐ文字を打てるように
  setTimeout(()=>{
    el.contentEditable = 'true';
    el.classList.add('editing');
    el.focus();
    document.execCommand('selectAll', false, null);
  }, 0);
}

/* --- 選択中スタンプ／文字：サイズ変更・削除パネル --- */
const selectedItemPanel = document.getElementById('selected-item-panel');
const stickerSizeSlider = document.getElementById('sticker-size-slider');

function applySelectionTransform(record){
  record.el.style.transform = `translate(-50%,-50%) scale(${record.scale || 1})`;
}

function selectSticker(record){
  if(state.selectedSticker && state.selectedSticker.el){
    state.selectedSticker.el.classList.remove('selected');
  }
  state.selectedSticker = record;
  record.el.classList.add('selected');
  stickerSizeSlider.value = record.scale || 1;
  selectedItemPanel.style.display = 'block';
}
function deselectSticker(){
  if(state.selectedSticker && state.selectedSticker.el){
    state.selectedSticker.el.classList.remove('selected');
  }
  state.selectedSticker = null;
  selectedItemPanel.style.display = 'none';
}
stickerSizeSlider.addEventListener('input', (e)=>{
  if(!state.selectedSticker) return;
  state.selectedSticker.scale = parseFloat(e.target.value) || 1;
  applySelectionTransform(state.selectedSticker);
});
document.getElementById('btn-delete-selected').addEventListener('click', ()=>{
  if(!state.selectedSticker) return;
  state.selectedSticker.el.remove();
  state.stickers = state.stickers.filter(s => s !== state.selectedSticker);
  deselectSticker();
});
// スタンプ・文字の上以外をタップしたら選択解除
stickerLayer.addEventListener('pointerdown', (e)=>{
  if(e.target === stickerLayer || e.target === editCanvas || e.target === doodleCanvas){
    deselectSticker();
  }
});

function makeDraggable(record){
  const { el } = record;
  let dragging = false, offX = 0, offY = 0;

  el.addEventListener('pointerdown', (e)=>{
    if(el.contentEditable === 'true') return; // 編集中はドラッグしない
    e.stopPropagation();
    selectSticker(record);
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    const rect = stickerLayer.getBoundingClientRect();
    offX = e.clientX - rect.left - record.x;
    offY = e.clientY - rect.top - record.y;
  });
  el.addEventListener('pointermove', (e)=>{
    if(!dragging) return;
    const rect = stickerLayer.getBoundingClientRect();
    record.x = Math.min(Math.max(0, e.clientX - rect.left - offX), rect.width);
    record.y = Math.min(Math.max(0, e.clientY - rect.top - offY), rect.height);
    el.style.left = record.x + 'px';
    el.style.top = record.y + 'px';
  });
  el.addEventListener('pointerup', ()=>{ dragging = false; el.classList.remove('dragging'); });
}

function clearAllStickers(){
  state.stickers.forEach(s => s.el.remove());
  state.stickers = [];
  deselectSticker();
}
document.getElementById('btn-clear-stickers').addEventListener('click', clearAllStickers);

/* --- 撮り直す --- */
document.getElementById('btn-retake').addEventListener('click', ()=>{
  clearAllStickers();
  state.strokes = [];
  state.activeStrokes = new Map();
  showScreen('screen-camera');
  startCamera();
});

/* ---------- 出力（スタンプ・文字を焼き込んで最終画像を作る） ---------- */
async function bakeFinal(){
  const W = editCanvas.width, H = editCanvas.height;
  const layerW = stickerLayer.clientWidth, layerH = stickerLayer.clientHeight;
  const scaleX = W / layerW, scaleY = H / layerH;

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = W; finalCanvas.height = H;
  const fctx = finalCanvas.getContext('2d');
  fctx.drawImage(editCanvas, 0, 0);
  fctx.drawImage(doodleCanvas, 0, 0, doodleCanvas.width, doodleCanvas.height, 0, 0, W, H);

  for(const s of state.stickers){
    fctx.textAlign = 'center';
    fctx.textBaseline = 'middle';
    const x = s.x * scaleX, y = s.y * scaleY;
    const scale = s.scale || 1;
    if(s.type === 'emoji'){
      const fontSize = Math.round(W * 0.09 * scale);
      fctx.font = `${fontSize}px sans-serif`;
      fctx.fillText(s.emoji, x, y);
    }else if(s.type === 'text'){
      const fontSize = Math.round(W * 0.055 * scale);
      fctx.font = `700 ${fontSize}px ${s.font || "'Mochiy Pop One', sans-serif"}`;
      fctx.lineJoin = 'round';
      fctx.lineWidth = fontSize * 0.22;
      fctx.strokeStyle = '#ffffff';
      fctx.strokeText(s.el.textContent, x, y);
      fctx.fillStyle = s.color || '#ff3d9a';
      fctx.fillText(s.el.textContent, x, y);
    }else if(s.type === 'deco'){
      const img = getDecoImage(s.stampId);
      await waitForImage(img);
      const size = W * 0.11 * scale;
      fctx.drawImage(img, x - size/2, y - size/2, size, size);
    }else if(s.type === 'image'){
      await waitForImage(s.el);
      const ratio = (s.el.naturalWidth && s.el.naturalHeight) ? s.el.naturalWidth / s.el.naturalHeight : 1;
      const dw = W * 0.18 * scale, dh = dw / ratio;
      fctx.drawImage(s.el, x - dw/2, y - dh/2, dw, dh);
    }
  }

  return finalCanvas.toDataURL('image/jpeg', 0.92);
}

document.getElementById('btn-to-output').addEventListener('click', async ()=>{
  // カスタムフォントの読み込みを待ってから焼き込む（文字化け防止）
  try{ await document.fonts.ready; }catch(e){}

  state.finalDataURL = await bakeFinal();
  document.getElementById('output-preview').src = state.finalDataURL;
  const qrArea = document.getElementById('qr-area');
  qrArea.classList.remove('show');
  qrArea.innerHTML = '';
  showScreen('screen-output');
  burstConfetti(28);
});

/* ---------- 印刷（枚数を選んで印刷） ---------- */
document.getElementById('print-qty-picker').addEventListener('click', (e)=>{
  const btn = e.target.closest('.chip'); if(!btn) return;
  document.querySelectorAll('#print-qty-picker .chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  state.printQty = parseInt(btn.dataset.qty, 10) || 1;
});

document.getElementById('btn-print').addEventListener('click', ()=>{
  const printArea = document.getElementById('print-area');
  printArea.innerHTML = '';
  for(let i=0; i<state.printQty; i++){
    const img = document.createElement('img');
    img.className = 'print-copy';
    if(i < state.printQty - 1) img.classList.add('print-page-break');
    img.src = state.finalDataURL;
    printArea.appendChild(img);
  }
  setTimeout(()=> window.print(), 100);
});

/* ---------- QRコードで受け取り ---------- */
function showQrCode(url, qrArea){
  qrArea.innerHTML = '';
  new QRCode(qrArea, { text: url, width: 220, height: 220, colorDark: '#1a1035', colorLight: '#ffffff' });
  const p = document.createElement('p');
  p.textContent = 'スマホでQRを読み取って保存してね';
  qrArea.appendChild(p);
}

function showDownloadFallback(qrArea, message, dataURL){
  qrArea.innerHTML = `<p style="max-width:220px;">${message}</p>`;
  const a = document.createElement('a');
  a.download = 'purikura.jpg';
  a.href = dataURL;
  a.textContent = '画像をダウンロード';
  a.style.cssText = 'display:inline-block;margin-top:8px;padding:8px 14px;background:#ff2e88;color:white;border-radius:999px;text-decoration:none;font-size:0.85rem;';
  qrArea.appendChild(a);
}

// ① まずImgBB（設定済みならこちらを優先。同じネットワークでなくてもOK・完全無料・登録不要）
async function tryImgbbUpload(dataURL){
  const key = window.IMGBB_API_KEY;
  if(!key || key === 'YOUR_IMGBB_API_KEY') throw new Error('imgbb not configured');
  const base64 = dataURL.split(',')[1];
  const form = new FormData();
  form.append('image', base64);
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    body: form,
  });
  if(!res.ok) throw new Error('imgbb upload failed');
  const data = await res.json();
  if(!data || !data.data || !data.data.url) throw new Error('imgbb response invalid');
  return data.data.url;
}

// ② このPC上のローカルサーバー（server.js）経由でのアップロード（同じWi-Fiのみ・完全無料・登録不要）
async function tryLocalServerUpload(dataURL){
  const uploadRes = await fetch('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataURL }),
  });
  if(!uploadRes.ok) throw new Error('local upload failed');
  const { path: uploadPath } = await uploadRes.json();

  const whoamiRes = await fetch('/whoami');
  if(!whoamiRes.ok) throw new Error('whoami failed');
  const { ip, port } = await whoamiRes.json();
  return `http://${ip}:${port}${uploadPath}`;
}

// ③ 上のどちらも使えない場合、設定済みならFirebaseを試す（2025年10月よりBlazeプラン＝要カード登録）
async function tryFirebaseUpload(dataURL){
  const configured = window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
  if(!configured) throw new Error('firebase not configured');
  if(!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const storageRef = firebase.storage().ref();
  const filename = `purikura/${Date.now()}_${Math.random().toString(36).slice(2,8)}.jpg`;
  const fileRef = storageRef.child(filename);
  await fileRef.putString(dataURL, 'data_url');
  return await fileRef.getDownloadURL();
}

document.getElementById('btn-qr').addEventListener('click', async ()=>{
  const qrArea = document.getElementById('qr-area');
  const dataURL = state.finalDataURL;
  qrArea.innerHTML = '<p>アップロード中...</p>';
  qrArea.classList.add('show');

  try{
    const url = await tryImgbbUpload(dataURL);
    showQrCode(url, qrArea);
    return;
  }catch(e){ /* ImgBB未設定・失敗の場合は次へ */ }

  try{
    const url = await tryLocalServerUpload(dataURL);
    showQrCode(url, qrArea);
    return;
  }catch(e){ /* ローカルサーバーが動いていない場合は次を試す */ }

  try{
    const url = await tryFirebaseUpload(dataURL);
    showQrCode(url, qrArea);
    return;
  }catch(e){ /* Firebase未設定・失敗の場合は次へ */ }

  showDownloadFallback(qrArea, 'QR受け取りには qr-upload-config.js（ImgBB・推奨）か、このPCで server.js を起動しておくか、firebase-config.jsの設定が必要です。今はダウンロードのみ利用できます。', dataURL);
});

/* ---------- 最初から ---------- */
document.getElementById('btn-restart').addEventListener('click', ()=>{
  state.shots = [];
  clearAllStickers();
  showScreen('screen-start');
});

/* ---------- 設定ページ（パスワード保護） ---------- */
const settingsLockView = document.getElementById('settings-lock-view');
const settingsFormView = document.getElementById('settings-form-view');

document.getElementById('btn-settings').addEventListener('click', ()=>{
  settingsLockView.style.display = 'flex';
  settingsFormView.style.display = 'none';
  document.getElementById('settings-password-input').value = '';
  document.getElementById('settings-lock-error').textContent = '';
  showScreen('screen-settings');
  setTimeout(()=> document.getElementById('settings-password-input').focus(), 50);
});

document.getElementById('btn-settings-cancel').addEventListener('click', ()=>{
  showScreen('screen-start');
});
document.getElementById('btn-settings-cancel2').addEventListener('click', ()=>{
  showScreen('screen-start');
});

document.getElementById('settings-lock-form').addEventListener('submit', (e)=>{
  e.preventDefault();
  const input = document.getElementById('settings-password-input').value;
  if(input === state.settings.password){
    openSettingsForm();
  }else{
    document.getElementById('settings-lock-error').textContent = 'パスワードが違います';
  }
});

function openSettingsForm(){
  settingsLockView.style.display = 'none';
  settingsFormView.style.display = 'flex';
  document.getElementById('set-shot-count').value = state.settings.shotCount;  document.getElementById('set-countdown').value = state.settings.countdownSec;
  document.getElementById('set-default-layout').value = state.settings.defaultLayout;
  document.getElementById('set-default-frame').value = state.settings.defaultFrame;
  document.getElementById('set-new-password').value = '';
  document.getElementById('set-new-password2').value = '';
  document.getElementById('set-sound-enabled').checked = state.settings.soundEnabled !== false;
  document.getElementById('set-announce-shot-number').checked = state.settings.announceShotNumber !== false;
  document.getElementById('set-logo-file').value = '';
  document.getElementById('set-add-stamp-file').value = '';
  document.getElementById('set-add-ad-file').value = '';
  document.getElementById('set-ad-interval').value = state.settings.adIntervalSec || 8;
  document.getElementById('set-add-ad-bar-file').value = '';
  document.getElementById('set-ad-bar-interval').value = state.settings.adBarIntervalSec || 8;
  document.getElementById('set-sub-caption').value = state.settings.subCameraCaption || '';
  document.getElementById('set-adsense-pub').value = state.settings.adsensePub || '';
  document.getElementById('set-adsense-slot').value = state.settings.adsenseSlot || '';
  document.getElementById('settings-saved-msg').textContent = '';
  pendingLogoDataURL = undefined;
  refreshLogoPreview();
  renderStampManageList();
  adSlideshowManager.render();
  adBarManager.render();
  renderSoundSlotList();
}

function refreshLogoPreview(){
  const wrap = document.getElementById('logo-preview-wrap');
  const img = document.getElementById('logo-preview-img');
  if(state.settings.logoDataURL){
    img.src = state.settings.logoDataURL;
    wrap.style.display = 'flex';
  }else{
    wrap.style.display = 'none';
  }
}

/* --- 画像スタンプ管理（設定ページ：追加・削除は即保存） --- */
function renderStampManageList(){
  const wrap = document.getElementById('set-stamp-list');
  wrap.innerHTML = '';
  (state.settings.customStamps || []).forEach((src, idx)=>{
    const item = document.createElement('div');
    item.className = 'stamp-manage-item';
    const img = document.createElement('img');
    img.src = src;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'stamp-manage-del';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', ()=>{
      state.settings.customStamps.splice(idx, 1);
      saveSettings(state.settings);
      renderStampManageList();
    });
    item.appendChild(img);
    item.appendChild(delBtn);
    wrap.appendChild(item);
  });
}

document.getElementById('set-add-stamp-file').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    if(!state.settings.customStamps) state.settings.customStamps = [];
    state.settings.customStamps.push(reader.result);
    const ok = saveSettings(state.settings);
    if(!ok){
      state.settings.customStamps.pop();
      alert('画像の保存に失敗しました（画像サイズが大きすぎる可能性があります。もっと小さい画像でお試しください）');
      return;
    }
    renderStampManageList();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

/* --- 待機画面・サブ画面の広告管理（設定ページ：追加・削除は即保存） --- */
const AD_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5MB（localStorageの容量制限のため、大きな動画は非推奨）

function makeAdManager(settingsKey, listElId, fileInputId){
  function render(){
    const wrap = document.getElementById(listElId);
    wrap.innerHTML = '';
    (state.settings[settingsKey] || []).forEach((item, idx)=>{
      const el = document.createElement('div');
      el.className = 'stamp-manage-item';
      const media = (item.type && item.type.indexOf('video') === 0)
        ? document.createElement('video')
        : document.createElement('img');
      media.src = item.src;
      if(media.tagName === 'VIDEO'){ media.muted = true; media.loop = true; }
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'stamp-manage-del';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', ()=>{
        state.settings[settingsKey].splice(idx, 1);
        saveSettings(state.settings);
        render();
      });
      el.appendChild(media);
      el.appendChild(delBtn);
      wrap.appendChild(el);
    });
  }

  document.getElementById(fileInputId).addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    if(file.size > AD_FILE_MAX_BYTES){
      alert('ファイルサイズが大きすぎます（5MBまで）。動画は数秒程度の短いものにするか、画像・GIFをお使いください。\n（ブラウザの保存容量には限りがあるため、あまり大きくはできません）');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = ()=>{
      if(!state.settings[settingsKey]) state.settings[settingsKey] = [];
      state.settings[settingsKey].push({ type: file.type, src: reader.result });
      const ok = saveSettings(state.settings);
      if(!ok){
        state.settings[settingsKey].pop();
        alert('保存に失敗しました（保存容量の上限に達した可能性があります。ファイルを減らすか、より軽いものでお試しください）');
        return;
      }
      render();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  return { render };
}

const adSlideshowManager = makeAdManager('adItems', 'set-ad-list', 'set-add-ad-file');
const adBarManager = makeAdManager('adBarItems', 'set-ad-bar-list', 'set-add-ad-bar-file');

document.getElementById('btn-open-sub-screen').addEventListener('click', ()=>{
  window.open('sub.html', 'purikura-sub', 'noopener');
});

/* --- 音声のカスタマイズ管理（設定ページ：追加・削除は即保存） --- */
const SOUND_SLOTS = [
  { key: 'start', label: 'スタート時の音声（省略時：自動音声「スタートするよ」）' },
  { key: 'shotCue', label: '1枚ごとの掛け声（省略時：自動音声「n枚目、いくよー」）' },
  { key: 'countdownTick', label: 'カウントダウン音（省略時：ビープ音）' },
  { key: 'shutter', label: 'シャッター音（省略時：自動のシャッター音）' },
];

function renderSoundSlotList(){
  const wrap = document.getElementById('sound-slot-list');
  wrap.innerHTML = '';
  SOUND_SLOTS.forEach(({ key, label })=>{
    const block = document.createElement('div');
    block.className = 'sound-slot';

    const labelEl = document.createElement('label');
    labelEl.className = 'settings-label';
    labelEl.textContent = label;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.className = 'text-input';
    labelEl.appendChild(fileInput);
    block.appendChild(labelEl);

    const current = state.settings.customSounds && state.settings.customSounds[key];
    const previewWrap = document.createElement('div');
    previewWrap.className = 'sound-preview-wrap';
    previewWrap.style.display = current ? 'flex' : 'none';
    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    if(current) audioEl.src = current;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small';
    delBtn.textContent = 'この音声を削除';
    delBtn.addEventListener('click', ()=>{
      if(!state.settings.customSounds) state.settings.customSounds = {};
      delete state.settings.customSounds[key];
      saveSettings(state.settings);
      renderSoundSlotList();
    });
    previewWrap.appendChild(audioEl);
    previewWrap.appendChild(delBtn);
    block.appendChild(previewWrap);

    fileInput.addEventListener('change', (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = ()=>{
        if(!state.settings.customSounds) state.settings.customSounds = {};
        state.settings.customSounds[key] = reader.result;
        const ok = saveSettings(state.settings);
        if(!ok){
          delete state.settings.customSounds[key];
          alert('音声の保存に失敗しました（ファイルサイズが大きすぎる可能性があります。もっと短い・軽いファイルでお試しください）');
          return;
        }
        renderSoundSlotList();
      };
      reader.readAsDataURL(file);
    });

    wrap.appendChild(block);
  });
  renderShotNumberSoundList();
}

// 掛け声は「1枚目、2枚目…」と番号ごとに個別の音声を設定することもできる
// （設定しない番号は、上の「1枚ごとの掛け声」→ 自動音声の順にフォールバックする）
function renderShotNumberSoundList(){
  const wrap = document.getElementById('sound-slot-by-number-list');
  if(!wrap) return;
  wrap.innerHTML = '';
  const liveInput = document.getElementById('set-shot-count');
  const count = (liveInput && parseInt(liveInput.value, 10)) || state.settings.shotCount || DEFAULT_SETTINGS.shotCount;
  const byNumber = (state.settings.customSounds && state.settings.customSounds.shotCueByNumber) || {};

  for(let n=1; n<=count; n++){
    const block = document.createElement('div');
    block.className = 'sound-slot';

    const labelEl = document.createElement('label');
    labelEl.className = 'settings-label';
    labelEl.textContent = `${n}枚目だけの掛け声（任意）`;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.className = 'text-input';
    labelEl.appendChild(fileInput);
    block.appendChild(labelEl);

    const current = byNumber[String(n)];
    const previewWrap = document.createElement('div');
    previewWrap.className = 'sound-preview-wrap';
    previewWrap.style.display = current ? 'flex' : 'none';
    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    if(current) audioEl.src = current;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small';
    delBtn.textContent = 'この音声を削除';
    delBtn.addEventListener('click', ()=>{
      if(!state.settings.customSounds.shotCueByNumber) return;
      delete state.settings.customSounds.shotCueByNumber[String(n)];
      saveSettings(state.settings);
      renderShotNumberSoundList();
    });
    previewWrap.appendChild(audioEl);
    previewWrap.appendChild(delBtn);
    block.appendChild(previewWrap);

    fileInput.addEventListener('change', (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = ()=>{
        if(!state.settings.customSounds.shotCueByNumber) state.settings.customSounds.shotCueByNumber = {};
        state.settings.customSounds.shotCueByNumber[String(n)] = reader.result;
        const ok = saveSettings(state.settings);
        if(!ok){
          delete state.settings.customSounds.shotCueByNumber[String(n)];
          alert('音声の保存に失敗しました（ファイルサイズが大きすぎる可能性があります。もっと短い・軽いファイルでお試しください）');
          return;
        }
        renderShotNumberSoundList();
      };
      reader.readAsDataURL(file);
    });

    wrap.appendChild(block);
  }
}

let pendingLogoDataURL = undefined; // undefined=変更なし, null=削除, string=新しい画像
document.getElementById('set-logo-file').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    pendingLogoDataURL = reader.result;
    document.getElementById('logo-preview-img').src = pendingLogoDataURL;
    document.getElementById('logo-preview-wrap').style.display = 'flex';
  };
  reader.readAsDataURL(file);
});
document.getElementById('btn-remove-logo').addEventListener('click', ()=>{
  pendingLogoDataURL = null;
  document.getElementById('logo-preview-wrap').style.display = 'none';
  document.getElementById('set-logo-file').value = '';
});

document.getElementById('settings-form').addEventListener('submit', (e)=>{
  e.preventDefault();
  const newSettings = { ...state.settings };
  newSettings.shotCount = Math.min(8, Math.max(2, parseInt(document.getElementById('set-shot-count').value, 10) || DEFAULT_SETTINGS.shotCount));
  newSettings.countdownSec = Math.min(5, Math.max(1, parseInt(document.getElementById('set-countdown').value, 10) || DEFAULT_SETTINGS.countdownSec));
  newSettings.defaultLayout = document.getElementById('set-default-layout').value;
  newSettings.defaultFrame = document.getElementById('set-default-frame').value;
  newSettings.soundEnabled = document.getElementById('set-sound-enabled').checked;
  newSettings.announceShotNumber = document.getElementById('set-announce-shot-number').checked;
  newSettings.adIntervalSec = Math.min(60, Math.max(3, parseInt(document.getElementById('set-ad-interval').value, 10) || 8));
  newSettings.adBarIntervalSec = Math.min(60, Math.max(3, parseInt(document.getElementById('set-ad-bar-interval').value, 10) || 8));
  newSettings.subCameraCaption = document.getElementById('set-sub-caption').value.trim();
  newSettings.adsensePub = document.getElementById('set-adsense-pub').value.trim();
  newSettings.adsenseSlot = document.getElementById('set-adsense-slot').value.trim();
  if(pendingLogoDataURL !== undefined){
    newSettings.logoDataURL = pendingLogoDataURL; // 新画像 or null(削除)
  }

  const pw1 = document.getElementById('set-new-password').value;
  const pw2 = document.getElementById('set-new-password2').value;
  const msgEl = document.getElementById('settings-saved-msg');
  if(pw1 || pw2){
    if(pw1.length < 4){
      msgEl.style.color = '#e0157a';
      msgEl.textContent = '新しいパスワードは4文字以上にしてください';
      return;
    }
    if(pw1 !== pw2){
      msgEl.style.color = '#e0157a';
      msgEl.textContent = 'パスワード（確認）が一致しません';
      return;
    }
    newSettings.password = pw1;
  }

  state.settings = newSettings;
  const ok = saveSettings(newSettings);
  if(!ok){
    msgEl.style.color = '#e0157a';
    msgEl.textContent = '保存に失敗しました（ロゴ画像が大きすぎる可能性があります。もっと小さい画像でお試しください）';
    return;
  }
  applyLogo();
  syncSoundToggleBtn();
  msgEl.style.color = '#00a897';
  msgEl.textContent = '保存しました！';
});
