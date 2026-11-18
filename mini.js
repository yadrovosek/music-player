const $ = (id) => document.getElementById(id);
const fmt = (s) => (!isFinite(s) ? '0:00' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'));
const fill = (el) => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');

let seeking = false, volDrag = false, curVol = 0.8;

window.api.onOpen((v) => document.body.classList.toggle('open', v));

window.api.onMeta((m) => {
  $('title').textContent = m.title || 'Ничего не играет';
  $('artist').textContent = m.artist || '';
  if (m.cover) { $('cover').src = m.cover; $('cover').hidden = false; $('ph').hidden = true; }
  else { $('cover').hidden = true; $('ph').hidden = false; }
});

window.api.onTick((t) => {
  $('play-ico').setAttribute('href', t.playing ? '#i-pause' : '#i-play');
  $('cur').textContent = fmt(t.cur);
  $('dur').textContent = fmt(t.dur);
  if (!seeking && t.dur) { $('seek').value = (t.cur / t.dur) * 100; fill($('seek')); }
  curVol = t.volume;
  if (!volDrag) { $('vol').value = t.volume; fill($('vol')); }
});

document.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = () => window.api.cmd(b.dataset.cmd)));

$('seek').addEventListener('pointerdown', () => (seeking = true));
$('vol').addEventListener('pointerdown', () => (volDrag = true));
window.addEventListener('pointerup', () => { seeking = false; volDrag = false; });
$('seek').oninput = () => { fill($('seek')); window.api.cmd('seek', +$('seek').value); };
$('vol').oninput = () => { fill($('vol')); curVol = +$('vol').value; window.api.cmd('volume', curVol); };

// колесо мыши над панелью меняет громкость
document.addEventListener('wheel', (e) => {
  curVol = Math.max(0, Math.min(1, curVol + (e.deltaY < 0 ? 0.05 : -0.05)));
  $('vol').value = curVol; fill($('vol'));
  window.api.cmd('volume', curVol);
});

fill($('seek')); fill($('vol'));