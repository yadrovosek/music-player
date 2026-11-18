const { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu, screen, shell } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const AUDIO_EXT = ['.mp3', '.flac', '.ogg', '.m4a', '.wav', '.opus', '.aac'];
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'art', 'albumart', 'artwork'];
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const MINI_W = 400, MINI_H = 170;

let win = null, mini = null, tray = null;
let quitting = false;
let cornerOn = true;
let open = false, leaveAt = 0;
const cache = { meta: null, tick: null };
const bot = require('./discord-bot');

/* ---------- Метаданные ---------- */
let mmPromise;
const getMM = () =>
  (mmPromise ??= import('music-metadata').catch((e) => {
    console.log('[music-metadata] не удалось загрузить:', e.message);
    throw e;
  }));

function guessFromName(file) {
  const base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  const parts = base.split(' - ');
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: base };
}

async function scanDir(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await scanDir(full, out);
    } else if (AUDIO_EXT.includes(path.extname(e.name).toLowerCase())) {
      const guess = guessFromName(full);
      let title = guess.title, artist = guess.artist, album = '';
      try {
        const { parseFile } = await getMM();
        const meta = await parseFile(full, { skipCovers: true, duration: false });
        title = meta.common.title || title;
        artist = meta.common.artist || artist;
        album = meta.common.album || '';
      } catch {}
      out.push({ title, artist, album, path: full, url: pathToFileURL(full).href });
    }
  }
  return out;
}

/* ---------- Обложки ---------- */
function findFolderCover(filePath) {
  const dir = path.dirname(filePath);
  const stem = (f) => path.basename(f, path.extname(f)).toLowerCase();
  const base = stem(filePath);
  try {
    const imgs = fs.readdirSync(dir).filter((f) => IMG_EXT.includes(path.extname(f).toLowerCase()));
    const pick = imgs.find((f) => stem(f) === base) || imgs.find((f) => COVER_NAMES.includes(stem(f)));
    if (!pick) return null;
    const ext = path.extname(pick).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { mime, buf: fs.readFileSync(path.join(dir, pick)) };
  } catch { return null; }
}

async function findCover(filePath, verbose) {
  const name = path.basename(filePath);
  try {
    const { parseFile, selectCover } = await getMM();
    const meta = await parseFile(filePath, { duration: false });
    const pic = selectCover(meta.common.picture);
    if (pic) return { mime: pic.format, buf: Buffer.from(pic.data) };
    if (verbose) console.log('[cover] в тегах нет обложки:', name);
  } catch (e) {
    if (verbose) console.log('[cover] не удалось прочитать теги:', name, '-', e.message);
  }
  const f = findFolderCover(filePath);
  if (!f && verbose) console.log('[cover] рядом с файлом тоже нет подходящей картинки:', name);
  return f;
}

function toDataUrl(cover, size) {
  if (!cover) return null;
  try {
    let img = nativeImage.createFromBuffer(cover.buf);
    if (!img.isEmpty()) {
      const { width, height } = img.getSize();
      const k = Math.min(1, size / Math.max(width, height));
      if (k < 1) img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' });
      return 'data:image/jpeg;base64,' + img.toJPEG(88).toString('base64');
    }
  } catch {}
  return `data:${cover.mime};base64,${cover.buf.toString('base64')}`;
}

const thumbCache = new Map();

ipcMain.handle('track:cover', async (_e, filePath, size = 400) => {
  const key = size + '|' + filePath;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const url = toDataUrl(await findCover(filePath, size > 200), size);
  if (size <= 200) thumbCache.set(key, url);
  return url;
});

/* ---------- Диалоги и библиотека ---------- */
ipcMain.handle('library:pick-folder', async (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(w, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('library:scan', async (_e, folder) => {
  if (!folder || !fs.existsSync(folder)) return [];
  const tracks = await scanDir(folder);
  tracks.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  return tracks;
});

ipcMain.handle('ui:pick-image', async (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(w, {
    properties: ['openFile'],
    filters: [{ name: 'Картинки и GIF', extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp'] }],
  });
  return res.canceled ? null : pathToFileURL(res.filePaths[0]).href;
});

/* ---------- Кнопки окна ---------- */
ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender).minimize());
ipcMain.on('win:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender).close()); // уйдёт в трей

/* ---------- Иконка (рисуется кодом; если рядом лежит icon.png, возьмёт его) ---------- */
function makeIcon() {
  const p = path.join(__dirname, 'icon.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  const S = 32, buf = Buffer.alloc(S * S * 4), c = (S - 1) / 2, r = S / 2 - 1.5;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - c, y - c) + 0.5));
      let B = 0x80, G = 0xde, R = 0x4a; // зелёный
      const dx = x - (c - 3);
      if (dx >= 0 && dx <= 11 && Math.abs(y - c) <= (11 - dx) * 0.62) { B = 0x0a; G = 0x15; R = 0x03; } // треугольник play
      buf[i] = B; buf[i + 1] = G; buf[i + 2] = R; buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

/* ---------- Связь с плеером ---------- */
const toMini = (ch, ...args) => { if (mini && !mini.isDestroyed()) mini.webContents.send(ch, ...args); };
const sendCmd = (cmd, value) => { if (win && !win.isDestroyed()) win.webContents.send('player:cmd', cmd, value); };

ipcMain.on('player:meta', (_e, meta) => { cache.meta = meta; toMini('player:meta', meta); refreshTray(); });
ipcMain.on('player:tick', (_e, tick) => {
  const changed = cache.tick?.playing !== tick.playing;
  cache.tick = tick;
  toMini('player:tick', tick);
  bot.onTick(tick);
  if (changed) refreshTray();
});
ipcMain.on('mini:cmd', (_e, cmd, value) => sendCmd(cmd, value));
ipcMain.on('app:corner', (_e, on) => setCorner(on));

/* ---------- Главное окно ---------- */
function showMain() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function toggleMain() {
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showMain();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#050806',
    icon: makeIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // музыка и таймеры не тормозятся, когда окно спрятано
    },
  });
  win.loadFile('index.html');
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

/* ---------- Мини-панель в углу ---------- */
function placeMini() {
  const b = screen.getPrimaryDisplay().bounds;
  mini.setBounds({ x: b.x, y: b.y, width: MINI_W, height: MINI_H });
}

function setOpen(v) {
  if (open === v || !mini || mini.isDestroyed()) return;
  open = v;
  leaveAt = 0;
  mini.setIgnoreMouseEvents(!v); // пока спрятана, клики проходят сквозь неё
  toMini('mini:open', v);
}

function createMini() {
  const b = screen.getPrimaryDisplay().bounds;
  mini = new BrowserWindow({
    x: b.x, y: b.y, width: MINI_W, height: MINI_H,
    frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  mini.setAlwaysOnTop(true, 'screen-saver');
  mini.setIgnoreMouseEvents(true);
  mini.loadFile('mini.html');
  mini.webContents.on('did-finish-load', () => {
    if (cache.meta) toMini('player:meta', cache.meta);
    if (cache.tick) toMini('player:tick', cache.tick);
  });
  mini.once('ready-to-show', () => { if (cornerOn) mini.showInactive(); });
  screen.on('display-metrics-changed', () => { if (mini && !mini.isDestroyed()) placeMini(); });

  // Следим за курсором: угол экрана открывает панель, уход курсора закрывает
  setInterval(() => {
    if (!cornerOn || !mini || mini.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const d = screen.getPrimaryDisplay().bounds;
    const x = p.x - d.x, y = p.y - d.y;
    if (!open) {
      if (x >= 0 && x <= 3 && y >= 0 && y <= 3) setOpen(true);
    } else {
      const inside = x >= -1 && x <= MINI_W + 40 && y >= -1 && y <= MINI_H + 40;
      if (inside) leaveAt = 0;
      else if (!leaveAt) leaveAt = Date.now();
      else if (Date.now() - leaveAt > 450) setOpen(false);
    }
  }, 70);
}

function setCorner(on, fromTray = false) {
  cornerOn = !!on;
  if (mini && !mini.isDestroyed()) {
    if (!cornerOn) { setOpen(false); mini.hide(); }
    else { placeMini(); mini.showInactive(); }
  }
  if (fromTray) sendCmd('corner', cornerOn);
  refreshTray();
}

/* ---------- Трей ---------- */
function refreshTray() {
  if (!tray) return;
  const m = cache.meta, playing = !!cache.tick?.playing;
  const label = m?.title ? `${m.artist ? m.artist + ' — ' : ''}${m.title}` : 'Ничего не играет';
  tray.setToolTip(`${playing ? '▶ ' : ''}${label}`.slice(0, 120));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: label.slice(0, 50), enabled: false },
    { type: 'separator' },
    { label: playing ? 'Пауза' : 'Играть', click: () => sendCmd('toggle') },
    { label: 'Следующий', click: () => sendCmd('next') },
    { label: 'Предыдущий', click: () => sendCmd('prev') },
    { type: 'separator' },
    { label: 'Показать плеер', click: showMain },
    { label: 'Мини-панель в углу', type: 'checkbox', checked: cornerOn, click: (i) => setCorner(i.checked, true) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(makeIcon());
  tray.on('click', toggleMain);
  refreshTray();
}
/* ---------- Discord ---------- */
bot.setController({
  command: (cmd, value) => sendCmd(cmd, value),
  getState: () => ({ meta: cache.meta, tick: cache.tick }),
});
ipcMain.on('library:update', (_e, list) => bot.setLibrary(list));
bot.setStatusHandler((s) => { if (win && !win.isDestroyed()) win.webContents.send('discord:status', s); });
ipcMain.handle('discord:toggle', () => bot.toggle());
ipcMain.handle('discord:open-config', () => shell.openPath(bot.ensureConfig()));
/* ---------- Запуск ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', showMain);
app.on('before-quit', () => { quitting = true; bot.disconnect(false); });

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  createMini();
  createTray();
});