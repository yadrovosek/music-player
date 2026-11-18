const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, 'discord.config.json');

let client = null, connection = null, player = null, resource = null, ffmpeg = null;
let voice = null;
let curPath = null, startPos = 0, wantPlaying = false, volume = 0.8;
let busy = false;
let statusCb = () => {};
let library = [];
let ctl = { command: () => {}, getState: () => ({}) };

const setStatusHandler = (cb) => { statusCb = cb; };
const setStatus = (status, msg = '') => statusCb({ status, msg });
const setLibrary = (l) => { library = Array.isArray(l) ? l : []; };
const setController = (c) => { ctl = c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG)) {
    fs.writeFileSync(CONFIG, JSON.stringify({ token: '', channelId: '', allowedUserIds: [] }, null, 2));
  }
  return CONFIG;
}

/* ---------- Звук ---------- */
function killFfmpeg() {
  try { ffmpeg?.destroy(); } catch {}
  ffmpeg = null;
}

function startTrack(pos = 0) {
  if (!player || !curPath) return;
  killFfmpeg();
  const prism = require('prism-media');
  ffmpeg = new prism.FFmpeg({
    args: ['-analyzeduration', '0', '-loglevel', '0', '-ss', String(Math.max(0, pos)), '-i', curPath,
           '-f', 's16le', '-ar', '48000', '-ac', '2'],
  });
  ffmpeg.on('error', (e) => console.log('[discord] ffmpeg:', e.message));
  resource = voice.createAudioResource(ffmpeg, { inputType: voice.StreamType.Raw, inlineVolume: true });
  resource.volume.setVolume(volume);
  startPos = pos;
  player.play(resource);
  if (!wantPlaying) player.pause();
}

function onTick(t) {
  volume = t.volume;
  wantPlaying = t.playing;
  if (resource?.volume) resource.volume.setVolume(volume);
  if (!player) return;

  if (t.path !== curPath) {
    curPath = t.path;
    if (curPath) startTrack(t.cur);
    return;
  }
  const st = player.state.status;
  if (t.playing && (st === 'paused' || st === 'autopaused')) player.unpause();
  else if (!t.playing && st === 'playing') player.pause();

  if (resource && t.playing && st !== 'idle' && !(t.dur && t.cur > t.dur - 2)) {
    const pos = startPos + resource.playbackDuration / 1000;
    if (Math.abs(pos - t.cur) > 3) startTrack(t.cur);
  }
}

/* ---------- Поиск по библиотеке ---------- */
const label = (t) => `${t.artist ? t.artist + ' — ' : ''}${t.title}`;

function search(q, limit = 25) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (let n = 0; n < library.length && out.length < limit; n++) {
    const t = library[n];
    const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push({ t, n });
  }
  return out;
}

function resolve(q) {
  if (/^#\d+$/.test(q)) return library[+q.slice(1)] || null;
  return search(q, 1)[0]?.t || null;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ---------- Слэш-команды ---------- */
/* ---------- Страницы списка ---------- */
const PAGE = 10;

function listView(page) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
  const pages = Math.max(1, Math.ceil(library.length / PAGE));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * PAGE;
  const items = library.slice(start, start + PAGE);
  const text = items.map((t, k) => `${start + k + 1}. ${label(t)}`).join('\n') || 'Библиотека пуста.';

  const rows = [];
  if (items.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('list:pick')
        .setPlaceholder('Выбери трек, чтобы включить')
        .addOptions(items.map((t, k) => ({ label: label(t).slice(0, 100), value: String(start + k) })))
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`list:${page - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId('list:noop').setLabel(`${page} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`list:${page + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages)
  ));
  return { content: `Страница ${page} из ${pages}:\n${text}`.slice(0, 1900), components: rows };
}
const COMMANDS = [
  { name: 'list', description: 'Список треков по страницам',
    options: [{ type: 4, name: 'page', description: 'Номер страницы', required: false, min_value: 1 }] },
  { name: 'play', description: 'Включить трек из библиотеки',
    options: [{ type: 3, name: 'query', description: 'Название или исполнитель', required: true, autocomplete: true }] },
  { name: 'search', description: 'Найти треки в библиотеке',
    options: [{ type: 3, name: 'query', description: 'Что искать', required: true }] },
  { name: 'pause', description: 'Пауза' },
  { name: 'resume', description: 'Продолжить' },
  { name: 'skip', description: 'Следующий трек' },
  { name: 'prev', description: 'Предыдущий трек' },
  { name: 'volume', description: 'Громкость',
    options: [{ type: 4, name: 'percent', description: '0–100', required: true, min_value: 0, max_value: 100 }] },
  { name: 'np', description: 'Что играет сейчас' },
];

function allowed(i) {
  const ids = (loadConfig() || {}).allowedUserIds || [];
  if (ids.length) return ids.includes(i.user.id);
  const vc = i.member?.voice?.channelId;
  return !!vc && vc === connection?.joinConfig?.channelId;
}

async function handleInteraction(i) {
  try {
    if (i.isAutocomplete()) {
      const found = search(i.options.getFocused(), 25);
      return await i.respond(found.map(({ t, n }) => ({ name: label(t).slice(0, 100), value: '#' + n })));
    }
    
        if (i.isButton() || i.isStringSelectMenu()) {
      if (!i.customId.startsWith('list:')) return;
      if (!allowed(i)) {
        return await i.reply({ content: '⛔ Управлять может тот, кто сидит в голосовом канале с ботом.', flags: 64 });
      }
      if (i.isStringSelectMenu()) {
        const t = library[+i.values[0]];
        if (!t) return await i.reply({ content: 'Не нашёл трек.', flags: 64 });
        ctl.command('playpath', t.path);
        return await i.reply(`▶ ${label(t)}`);
      }
      const p = +i.customId.slice(5);
      if (!Number.isFinite(p)) return await i.deferUpdate();
      return await i.update(listView(p));
    }
    if (!i.isChatInputCommand()) return;
    if (!allowed(i)) {
      return await i.reply({ content: '⛔ Управлять может тот, кто сидит в голосовом канале с ботом.', flags: 64 });
    }

    switch (i.commandName) {
      case 'list':
        return await i.reply(listView(i.options.getInteger('page') || 1));
      case 'play': {
        const t = resolve(i.options.getString('query'));
        if (!t) return await i.reply({ content: 'Ничего не нашёл.', flags: 64 });
        ctl.command('playpath', t.path);
        return await i.reply(`▶ ${label(t)}`);
      }
      case 'search': {
        const found = search(i.options.getString('query'), 10);
        if (!found.length) return await i.reply({ content: 'Ничего не нашёл.', flags: 64 });
        return await i.reply({ content: found.map(({ t }, k) => `${k + 1}. ${label(t)}`).join('\n').slice(0, 1900), flags: 64 });
      }
      case 'pause': ctl.command('pause'); return await i.reply('⏸ Пауза');
      case 'resume': ctl.command('resume'); return await i.reply('▶ Продолжаю');
      case 'skip': ctl.command('next'); return await i.reply('⏭ Следующий');
      case 'prev': ctl.command('prev'); return await i.reply('⏮ Предыдущий');
      case 'volume': {
        const p = i.options.getInteger('percent');
        ctl.command('volume', p / 100);
        return await i.reply(`🔊 Громкость ${p}%`);
      }
      case 'np': {
        const { meta, tick } = ctl.getState();
        if (!meta?.title) return await i.reply({ content: 'Сейчас ничего не играет.', flags: 64 });
        const time = tick ? ` (${mmss(tick.cur)} / ${mmss(tick.dur)})` : '';
        return await i.reply(`${tick?.playing ? '▶' : '⏸'} ${label(meta)}${time}`);
      }
    }
  } catch (e) {
    console.log('[discord] команда:', e.message);
    try { if (!i.replied && !i.deferred && !i.isAutocomplete()) await i.reply({ content: 'Ошибка команды.', flags: 64 }); } catch {}
  }
}

/* ---------- Подключение ---------- */
async function connect() {
  if (client || busy) return;
  busy = true;
  try {
    const cfg = loadConfig();
    if (!cfg?.token || !cfg?.channelId) throw new Error('Заполни token и channelId в discord.config.json');
    setStatus('connecting', 'Подключаюсь…');

    const { Client, GatewayIntentBits } = require('discord.js');
    voice = require('@discordjs/voice');

    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    client.on('interactionCreate', handleInteraction);
    await client.login(cfg.token);
    for (let i = 0; i < 100 && !client.isReady(); i++) await sleep(100);

    const channel = await client.channels.fetch(cfg.channelId);
    if (!channel || !channel.isVoiceBased()) throw new Error('Канал не найден или не голосовой');

    connection = voice.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 30000);

    player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
    player.on('error', (e) => console.log('[discord] player:', e.message));
    connection.subscribe(player);

    let msg = `В канале «${channel.name}»`;
    try { await channel.guild.commands.set(COMMANDS); }
    catch (e) {
      console.log('[discord] слэш-команды не зарегистрированы:', e.message);
      msg += ' (команды недоступны: добавь бота заново со scope applications.commands)';
    }
    setStatus('on', msg);
    if (curPath) startTrack(0);
  } catch (e) {
    console.log('[discord] ошибка:', e);
    disconnect(false);
    setStatus('error', e.message);
  } finally {
    busy = false;
  }
}

function disconnect(report = true) {
  killFfmpeg();
  try { player?.stop(); } catch {}
  try { connection?.destroy(); } catch {}
  try { client?.destroy(); } catch {}
  client = connection = player = resource = null;
  curPath = null;
  if (report) setStatus('off', 'Отключено');
}

async function toggle() {
  if (client) disconnect(); else await connect();
}

module.exports = { setStatusHandler, setLibrary, setController, ensureConfig, toggle, disconnect, onTick };