const $ = (id) => document.getElementById(id);
const audio = $('audio');
const list = $('tracklist');
const nowBox = $('now');

/* ---------- Настройки (сохраняются между запусками) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const state = {
  folder: store.get('folder', null),
  gif: store.get('gif', null),
  fit: store.get('fit', 'cover'),
  volume: store.get('volume', 0.8),
  skip: store.get('skip', 10),
  dim: store.get('dim', 0.35),
  autoplay: store.get('autoplay', true),
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'all'), // off | all | one
  last: store.get('last', null),
  pinned: store.get('pinned', false),
  covers: store.get('covers', {}), // свои обложки: путь трека -> url картинки
  nowPos: store.get('nowPos', null), // положение виджета {x, y}
};
const save = (k, v) => { state[k] = v; store.set(k, v); };

let tracks = [];
let index = -1;
let coverToken = 0;

const fmt = (s) => (!isFinite(s) ? '0:00' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'));
const fillSlider = (el) => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
const skipLabel = (s) => (s >= 60 ? s / 60 + ' мин' : s + ' с');
const setIcon = (sel, name) => document.querySelectorAll(sel).forEach((u) => u.setAttribute('href', '#i-' + name));

function phStyle(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = 120 + (h % 60);
  return `linear-gradient(135deg, hsl(${hue} 45% 14%), hsl(${hue + 20} 55% 24%))`;
}

/* ---------- Фон ---------- */
function applyBg() {
  const bg = $('bg');
  if (state.gif) { bg.style.backgroundImage = `url("${state.gif}")`; bg.classList.add('custom'); }
  else { bg.style.backgroundImage = ''; bg.classList.remove('custom'); }
  bg.classList.toggle('contain', state.fit === 'contain');
  $('bg-dim').style.opacity = state.dim;
  document.body.classList.toggle('pinned', state.pinned);
  $('btn-pin').classList.toggle('on', state.pinned);
}

/* ---------- Перетаскиваемый виджет ---------- */
function placeNow(x, y) {
  const maxX = Math.max(0, window.innerWidth - nowBox.offsetWidth);
  const maxY = Math.max(36, window.innerHeight - nowBox.offsetHeight);
  nowBox.style.left = Math.min(Math.max(0, x), maxX) + 'px';
  nowBox.style.top = Math.min(Math.max(36, y), maxY) + 'px';
  nowBox.style.bottom = 'auto';
}

let drag = null;
let moved = false;
nowBox.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const r = nowBox.getBoundingClientRect();
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
  moved = false;
  nowBox.setPointerCapture(e.pointerId);
});
nowBox.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
  moved = true;
  nowBox.classList.add('dragging');
  placeNow(e.clientX - drag.dx, e.clientY - drag.dy);
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  nowBox.classList.remove('dragging');
  if (moved) save('nowPos', { x: parseFloat(nowBox.style.left), y: parseFloat(nowBox.style.top) });
};
nowBox.addEventListener('pointerup', endDrag);
nowBox.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', () => { if (state.nowPos) placeNow(state.nowPos.x, state.nowPos.y); });

$('btn-now-reset').onclick = () => {
  save('nowPos', null);
  nowBox.style.left = ''; nowBox.style.top = ''; nowBox.style.bottom = '';
};

/* ---------- Обложки ---------- */
async function coverFor(t, size) {
  const custom = state.covers[t.path];
  if (custom) return custom;
  return window.api.cover(t.path, size);
}

$('cover').onerror = () => { $('cover').hidden = true; $('cover-ph').hidden = false; };

async function showCover(track) {
  const token = ++coverToken;
  const ph = $('cover-ph');
  ph.style.background = phStyle(track.title + track.artist);
  $('cover').hidden = true; ph.hidden = false;
  const data = await coverFor(track, 400);
  if (token !== coverToken) return;
  if (data) { $('cover').src = data; $('cover').hidden = false; ph.hidden = true; }
  setMediaSession(track, data);
}

async function loadThumb(li) {
  const t = tracks[+li.dataset.i];
  if (!t) return;
  const src = await coverFor(t, 96);
  if (!src || !li.isConnected) return;
  const img = new Image();
  img.onload = () => {
    const av = li.querySelector('.av');
    av.textContent = '';
    av.appendChild(img);
  };
  img.src = src;
}

async function chooseCover(i) {
  const url = await window.api.pickImage();
  if (!url) return;
  state.covers[tracks[i].path] = url;
  store.set('covers', state.covers);
  const li = list.children[i];
  if (li) loadThumb(li);
  if (i === index) showCover(tracks[i]);
}

/* ---------- Список ---------- */
let io;
function renderList() {
  io?.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      loadThumb(en.target);
    }
  }, { root: list, rootMargin: '200px' });

  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    const av = document.createElement('div');
    av.className = 'av'; av.style.background = phStyle(t.title + t.artist); av.textContent = '♪';
    const meta = document.createElement('div'); meta.className = 'meta';
    const a = document.createElement('div'); a.className = 't'; a.textContent = t.title;
    const b = document.createElement('div'); b.className = 'a'; b.textContent = [t.artist, t.album].filter(Boolean).join(' • ');
    meta.append(a, b);
    li.append(av, meta);
    li.onclick = () => playIndex(i);
    li.oncontextmenu = (e) => { e.preventDefault(); chooseCover(i); };
    if (i === index) li.classList.add('active');
    list.appendChild(li);
    io.observe(li);
  });
  $('count').textContent = tracks.length || '';
  function applySearch() {
  const words = $('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  [...list.children].forEach((li, i) => {
    const t = tracks[i];
    const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
    li.hidden = !words.every((w) => hay.includes(w));
  });
}
}

function applySearch() {
  const q = $('search').value.trim().toLowerCase();
  [...list.children].forEach((li, i) => {
    const t = tracks[i];
    li.hidden = !!q && !`${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q);
  });
}
$('search').oninput = applySearch;

function markActive() {
  [...list.children].forEach((li, i) => li.classList.toggle('active', i === index));
  list.children[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- Воспроизведение ---------- */
function playIndex(i) {
  if (!tracks.length) return;
  index = (i + tracks.length) % tracks.length;
  const t = tracks[index];
  audio.src = t.url;
  audio.play().catch(() => {});
  $('title').textContent = t.title;
  $('sub').textContent = [t.artist, t.album].filter(Boolean).join(' • ') || 'Неизвестный исполнитель';
  save('last', t.path);
  markActive();
  showCover(t);
}

function nextIndex() {
  if (state.shuffle && tracks.length > 1) {
    let r;
    do { r = Math.floor(Math.random() * tracks.length); } while (r === index);
    return r;
  }
  return index + 1;
}
const next = () => playIndex(nextIndex());
const prev = () => (audio.currentTime > 3 ? (audio.currentTime = 0) : playIndex(index - 1));
const togglePlay = () => (index === -1 ? playIndex(0) : audio.paused ? audio.play() : audio.pause());
const skipBy = (s) => { if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + s)); };


function setMediaSession(track, cover) {
  window.api.sendMeta({ title: track.title, artist: track.artist, cover: cover || null });
  if (!('mediaSession' in navigator)) return;    
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title, artist: track.artist, album: track.album,
      artwork: cover ? [{ src: cover }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', next);
  } catch {}
}

/* ---------- Загрузка папки ---------- */
async function loadFolder(folder, { autoplay = false } = {}) {
  $('folder-label').textContent = 'Сканирую…';
  tracks = await window.api.scan(folder);
  index = -1;
  $('folder-label').textContent = folder;
  renderList();
  window.api.sendLibrary(tracks.map((t) => ({ title: t.title, artist: t.artist, album: t.album, path: t.path })));
  if (!tracks.length) { $('sub').textContent = 'В папке нет музыки'; return; }
  if (autoplay) {
    const lastIdx = tracks.findIndex((t) => t.path === state.last);
    playIndex(lastIdx >= 0 ? lastIdx : state.shuffle ? Math.floor(Math.random() * tracks.length) : 0);
  } else {
    $('sub').textContent = `Найдено треков: ${tracks.length}`;
  }
}

/* ---------- Кнопки плеера ---------- */
$('btn-play').onclick = togglePlay;
nowBox.onclick = () => {
  if (moved) { moved = false; return; } // это было перетаскивание, а не клик
  togglePlay();
};
$('btn-next').onclick = next;
$('btn-prev').onclick = prev;
$('btn-back').onclick = () => skipBy(-state.skip);
$('btn-fwd').onclick = () => skipBy(state.skip);

function updateToggles() {
  $('btn-shuffle').classList.toggle('on', state.shuffle);
  $('btn-repeat').classList.toggle('on', state.repeat !== 'off');
  setIcon('#btn-repeat use', state.repeat === 'one' ? 'repeat1' : 'repeat');
}
$('btn-shuffle').onclick = () => { save('shuffle', !state.shuffle); updateToggles(); };
$('btn-repeat').onclick = () => {
  const order = ['off', 'all', 'one'];
  save('repeat', order[(order.indexOf(state.repeat) + 1) % 3]);
  updateToggles();
};

/* ---------- Аудио-события ---------- */
audio.onplay = () => { setIcon('.js-play-ico use', 'pause'); document.body.classList.add('playing'); };
audio.onpause = () => { setIcon('.js-play-ico use', 'play'); document.body.classList.remove('playing'); };
audio.onended = () => {
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (state.repeat === 'off' && !state.shuffle && index >= tracks.length - 1) return;
  next();
};
audio.ontimeupdate = () => {
  $('time-cur').textContent = fmt(audio.currentTime);
  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    $('seek').value = pct; fillSlider($('seek'));
    $('mini-fill').style.width = pct + '%';
  }
};
audio.onloadedmetadata = () => ($('time-dur').textContent = fmt(audio.duration));
$('seek').oninput = () => {
  if (audio.duration) audio.currentTime = ($('seek').value / 100) * audio.duration;
  fillSlider($('seek'));
};

/* ---------- Панель ---------- */
document.querySelectorAll('.tabs [data-tab]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
  };
});
$('btn-pin').onclick = () => { save('pinned', !state.pinned); applyBg(); };

$('btn-folder').onclick = async () => {
  const folder = await window.api.pickFolder();
  if (folder) { save('folder', folder); await loadFolder(folder); }
};
$('btn-gif').onclick = async () => {
  const url = await window.api.pickImage();
  if (url) { save('gif', url); applyBg(); }
};
$('btn-gif-clear').onclick = () => { save('gif', null); applyBg(); };

function updateFitChips() {
  document.querySelectorAll('#fit-chips button').forEach((b) => b.classList.toggle('on', b.dataset.fit === state.fit));
}
document.querySelectorAll('#fit-chips button').forEach((b) => {
  b.onclick = () => { save('fit', b.dataset.fit); updateFitChips(); applyBg(); };
});

const vol = $('volume');
vol.value = state.volume; audio.volume = state.volume; fillSlider(vol);
$('vol-val').textContent = Math.round(state.volume * 100) + '%';
vol.oninput = () => {
  audio.volume = vol.value; save('volume', +vol.value); fillSlider(vol);
  $('vol-val').textContent = Math.round(vol.value * 100) + '%';
};

const dim = $('dim');
dim.value = state.dim; fillSlider(dim);
dim.oninput = () => { save('dim', +dim.value); fillSlider(dim); applyBg(); };

function updateSkipChips() {
  document.querySelectorAll('#skip-chips button').forEach((b) => b.classList.toggle('on', +b.dataset.sec === state.skip));
  $('btn-back').title = `Назад ${skipLabel(state.skip)}`;
  $('btn-fwd').title = `Вперёд ${skipLabel(state.skip)}`;
}
document.querySelectorAll('#skip-chips button').forEach((b) => {
  b.onclick = () => { save('skip', +b.dataset.sec); updateSkipChips(); };
});

$('autoplay').checked = state.autoplay;
$('autoplay').onchange = (e) => save('autoplay', e.target.checked);

/* ---------- Клавиатура ---------- */
document.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'search'].includes(el.type))) return;
  const isRange = el.tagName === 'INPUT' && el.type === 'range';
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight' && !isRange) skipBy(state.skip);
  else if (e.code === 'ArrowLeft' && !isRange) skipBy(-state.skip);
});

/* ---------- Окно ---------- */
$('btn-min').onclick = () => window.api.minimize();
$('btn-max').onclick = () => window.api.maximize();
$('btn-close').onclick = () => window.api.close();

/* ---------- Старт ---------- */
applyBg();
updateToggles();
updateSkipChips();
updateFitChips();
fillSlider($('seek'));
if (state.nowPos) placeNow(state.nowPos.x, state.nowPos.y);
if (state.folder) loadFolder(state.folder, { autoplay: state.autoplay });
/* ---------- Трей и мини-панель ---------- */
let lastTick = 0;
function sendTick(force) {
  const now = Date.now();
  if (!force && now - lastTick < 400) return;
  lastTick = now;
  window.api.sendTick({
    playing: !audio.paused,
    cur: audio.currentTime || 0,
    dur: isFinite(audio.duration) ? audio.duration : 0,
    volume: audio.volume,
    path: tracks[index]?.path || null,
  });
}
audio.addEventListener('timeupdate', () => sendTick(false));
['play', 'pause', 'loadedmetadata', 'volumechange'].forEach((ev) => audio.addEventListener(ev, () => sendTick(true)));

function setVolume(v) {
  v = Math.max(0, Math.min(1, v));
  audio.volume = v; save('volume', v);
  vol.value = v; fillSlider(vol);
  $('vol-val').textContent = Math.round(v * 100) + '%';
}

window.api.onCmd((cmd, value) => {
  if (cmd === 'toggle') togglePlay();
  else if (cmd === 'pause') audio.pause();
  else if (cmd === 'resume') audio.play();
  else if (cmd === 'playpath') { const i = tracks.findIndex((t) => t.path === value); if (i >= 0) playIndex(i); }
  else if (cmd === 'next') next();
  else if (cmd === 'prev') prev();
  else if (cmd === 'back') skipBy(-state.skip);
  else if (cmd === 'fwd') skipBy(state.skip);
  else if (cmd === 'seek') { if (audio.duration) audio.currentTime = (value / 100) * audio.duration; }
  else if (cmd === 'volume') setVolume(value);
  else if (cmd === 'corner') { save('corner', value); $('corner-on').checked = value; }
});

$('corner-on').checked = store.get('corner', true);
$('corner-on').onchange = (e) => { save('corner', e.target.checked); window.api.setCorner(e.target.checked); };
window.api.setCorner($('corner-on').checked);
sendTick(true);
/* ---------- Discord ---------- */
let discordOn = false;
const applyMute = () => { audio.muted = discordOn && $('mute-local').checked; };

$('mute-local').checked = store.get('muteLocal', false);
$('mute-local').onchange = (e) => { save('muteLocal', e.target.checked); applyMute(); };
$('btn-discord-cfg').onclick = () => window.api.discordConfig();
$('btn-discord').onclick = () => window.api.discordToggle();

window.api.onDiscord(({ status, msg }) => {
  discordOn = status === 'on';
  $('discord-status').textContent = msg || (discordOn ? 'подключено' : 'отключено');
  $('btn-discord').textContent = status === 'on' || status === 'connecting' ? 'Отключить от Discord' : 'Подключить к Discord';
  applyMute();
});