const option = document.body.dataset.option || 'a';
const titles = { a: 'The limbo panel', b: 'The old client', c: 'The server board' };
const navigation = ['boot', 'name', 'menu', 'quickplay', 'lobby'];
const labels = ['Load', 'Name', 'Menu', 'Quick play', 'Friends'];
const icons = ['eagles', 'steyr', 'm79', 'barrett', 'knife', 'law'];
const menus = ['Quick play', 'Play with friends', 'Join lobby', 'Practice vs bots', 'Settings', 'Credits & licenses'];
const menuTargets = ['quickplay', 'lobby', 'join', 'practice', 'settings', 'credits'];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const storage = {
  get(key, fallback = '') { try { return localStorage.getItem(`field-shell-${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`field-shell-${key}`, value); } catch { /* The UI also works without persistent storage. */ } },
};
let name = storage.get('name');
let selected = 0;
let screen = 'boot';
let history = [];
let timers = [];
let host = true;
let ready = false;
let matchReady = false;
let practiceStarted = false;
let lobbyCode = 'K7M4Q2';
let currentMap = 0;
let currentMode = 0;
let botCount = 8;
let motion = storage.get('motion', 'on') === 'on';
let volume = Number(storage.get('volume', '60'));
let returnAfterName = 'menu';
const maps = ['Arena', 'Airpirates', 'DesertWind'];
const modes = ['Deathmatch', 'Capture the flag'];
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const initialCode = params.get('lobby') || '';
if (initialCode) { host = false; }
document.body.classList.toggle('reduce-motion', !motion);

function later(fn, delay) { const timer = setTimeout(fn, delay); timers.push(timer); return timer; }
function stopTimers() { timers.forEach(clearTimeout); timers = []; }
function mapName() { return currentMode === 1 ? 'ctf_Death' : maps[currentMap]; }
function identity() { return escape(name || 'Player'); }
function action(text, command, primary = false) { return `<button class="action${primary ? ' primary' : ''}" data-action="${command}">${text}</button>`; }
function topLine(label = 'Out of game') { return `<div class="topline"><span>${label}</span><span class="callsign"><i class="status-dot"></i>${identity()}</span></div>`; }
function menuRow(label, index, target, suffix = '') {
  return `<button class="menu-row${index === selected ? ' active' : ''}" data-action="${target}" data-menu-index="${index}"><img class="icon" src="./assets/${icons[index]}.png" alt=""><span class="number">${index + 1}</span><span>${label}</span>${suffix ? `<span class="suffix">${suffix}</span>` : ''}</button>`;
}
function sideArtwork() {
  return `<aside class="side-art" aria-label="Original game scenery"><div class="map-tag"><span>Map preview</span><span>02 / 2002</span></div><div><div class="art-name">DesertWind</div><p class="art-caption">Same small soldiers.<br>Same impossible jumps.</p><div class="radio-line">No install. Just a name.<br>Then get back out there.</div></div></aside>`;
}
function header() {
  return `<header class="masthead"><div><h1 class="wordmark"><span>Field</span><span>Sandbox</span></h1>${screen === 'boot' ? '<p class="boot-subtitle">Load the assets. Pick a name. Get in.</p>' : ''}</div><span class="edition">Working title<span class="edition-detail">Original art / browser edition</span></span></header>`;
}
function content() {
  switch (screen) {
    case 'boot': return `<div class="loader-heading"><span>Loading the battlefield</span><span id="load-percent">24%</span></div><div class="progress" role="progressbar" aria-label="Asset download preview" aria-valuemin="0" aria-valuemax="100" aria-valuenow="24"><span id="load-fill" style="width:24%"></span></div><div class="load-stats"><span id="load-bytes">1.27 / 5.30 MB</span><span id="load-files">76 / 318 files</span></div><p class="load-file" id="load-file">Reading map textures…</p><button class="boot-continue" data-action="next">Enter / Space to continue</button><div class="small">First visit ≈ 5.3 MB. Kept here for next time.</div>${option === 'b' ? '<details class="brand-toggle"><summary>Permission-dependent title art study</summary><div class="original-art"><img src="./assets/title-l.png" alt="SOL"><img src="./assets/title-r.png" alt="DAT"></div><p class="permission">Original SOLDAT title art — requires THD permission.<br>Field Sandbox remains the default product wordmark.</p></details>' : ''}<div class="score-strip"><span><strong>2002</strong><small>Original battlefield</small></span><span><strong>5.30 MB</strong><small>First-match download</small></span></div>`;
    case 'name': return `${topLine('Before you drop in')}<h2>What’s your name?</h2><p class="muted">The one they’ll see above your head.</p><form id="name-form" novalidate><div class="field"><label for="player-name">Player name</label><input id="player-name" name="player-name" autocomplete="nickname" maxlength="24" value="${escape(name)}" placeholder="Type your name" aria-describedby="name-hint name-error" spellcheck="false"><div class="field-info" id="name-hint"><span>1–24 printable ASCII characters</span><span id="name-count">${name.length} / 24</span></div><p class="error" id="name-error" role="alert"></p></div><button class="action primary" type="submit">Continue [Enter]</button></form><p class="menu-note">Remembered on this browser. No account needed.</p>`;
    case 'menu': return `${topLine('Choose your game')}<p class="key-hint">Press 1–6 or click to select</p><nav class="menu" aria-label="Main menu">${menus.map((label, index) => menuRow(label, index, menuTargets[index])).join('')}</nav><p class="menu-note">Quick play finds the lowest-ping lobby.<br>There’s always a game. Bots fill the empty slots.</p>`;
    case 'quickplay': return `${topLine('Quick play')}<h2>Finding a game</h2><p class="muted">Picking a lobby with the lowest latency.</p>${regionTable()}<div class="search-status" role="status"><i class="spinner"></i><span>Checking Sydney lobbies…</span></div><p class="rules-note">No waiting for a full server. Start with bots;<br>friends and strangers can join as you play.</p><div class="actions">${action('Join best lobby [Enter]', 'joined', true)}${action('Cancel', 'menu')}</div><p class="small" style="margin-top:14px">Region measurements are illustrative. Other regions are a stretch goal.</p>`;
    case 'joined': return `${topLine('Quick play / Sydney')}<h2>Found your game</h2><div class="preview-map"><span>Arena / Deathmatch</span></div><p class="joined-summary">3 players + 5 bots</p><p class="muted">Joined Arena. Sydney, 18 ms.</p><p class="rules-note">Players replace bots as they join; bots return when players leave.</p><div class="actions">${action('Enter Arena', 'enter-preview', true)}${action('Back to menu', 'menu')}</div><p id="preview-message" class="preview-notice" role="status">UI preview only. No game server connection.</p>`;
    case 'lobby': return `
      ${topLine(host ? 'Friends / You are the host' : 'Friends / Guest')}
      <h2>${host ? 'Your friend lobby' : 'Friend lobby'}</h2>
      <div class="lobby-code"><div><small>Lobby code</small><strong>${escape(lobbyCode)}</strong></div>
        <button class="action" data-action="copy-link" id="copy-link">Copy link</button>
      </div>
      <div class="lobby-columns">
        <div>
          <h3>Players <span class="small">2 / 8</span></h3>
          <ul class="players">
            <li><span>${identity()} <small>${host ? '(host)' : '(you)'}</small></span><span class="player-state">${host ? 'Ready' : ready ? 'Ready' : 'Not ready'}</span></li>
            <li><span>${host ? 'Sarge' : 'Sarge (host)'}</span><span class="player-state">Ready</span></li>
            ${['Billy', 'Boogie Man', 'Commando', 'Danko', 'Admiral', 'Blain'].map(bot => `<li class="bot"><span>${bot}</span><span>Bot</span></li>`).join('')}
          </ul>
        </div>
        <div class="config">
          <h3>Game setup ${host ? '' : '<small>(host controls)</small>'}</h3>
          <button class="menu-row" data-action="cycle-map" ${!host ? 'disabled' : ''}><span class="number">1</span><span>Map</span><strong>${mapName()}</strong></button>
          <button class="menu-row" data-action="cycle-mode" ${!host ? 'disabled' : ''}><span class="number">2</span><span>Mode</span><strong>${modes[currentMode]}</strong></button>
          <div class="preview-map" style="height:80px"><span>${mapName()}</span></div>
          <p class="small">Sydney · 18 ms<br>Only people with the link can join.</p>
        </div>
      </div>
      <p class="rules-note">Friends replace bots when they join. Bots return when they leave.</p>
      <div class="actions">${action(host ? (matchReady ? 'Match ready' : 'Start [Enter]') : (ready ? 'Ready ✓' : 'Ready up [Enter]'), host ? 'start-lobby' : 'toggle-ready', true)}${action('Leave lobby', 'menu')}</div>
      <p class="preview-notice" id="lobby-status" role="status">${matchReady ? `Everyone is ready. ${mapName()} would open here in the connected game.` : 'UI preview only. Share links stay inside these mockups.'}</p>`;
    case 'join': return `${topLine('Play with friends')}<h2>Join a lobby</h2><p class="muted">Paste the link your friend sent, or type their six-character code.</p><form id="join-form" novalidate><div class="field"><label for="lobby-link">Lobby link or code</label><input id="lobby-link" name="lobby-link" autocomplete="off" spellcheck="false" value="${escape(initialCode)}" placeholder="K7M4Q2" aria-describedby="join-error" style="font-size:18px"><p class="error" id="join-error" role="alert"></p></div><button class="action primary" type="submit">Join lobby [Enter]</button></form><div class="actions"><button class="text-button" data-action="menu">Back to menu</button></div><p class="menu-note">Try K7M4Q2 in this prototype.<br>Lobby and player data are simulated.</p>`;
    case 'practice': return `${topLine('Local sandbox')}<h2>Practice vs bots</h2><p class="muted">Pick a map and get your aim back.</p><div class="config"><button class="menu-row" data-action="cycle-map"><span class="number">1</span><span>Map</span><strong>${mapName()}</strong></button><button class="menu-row" data-action="cycle-mode"><span class="number">2</span><span>Mode</span><strong>${modes[currentMode]}</strong></button><button class="menu-row" data-action="cycle-bots"><span class="number">3</span><span>Bots</span><strong>${botCount}</strong></button></div><div class="preview-map"><span>${mapName()} / ${modes[currentMode]}</span></div><div class="actions">${action('Start practice [Enter]', 'start-practice', true)}${action('Back', 'menu')}</div><p id="practice-status" class="preview-notice" role="status">${practiceStarted ? `Practice selected: ${mapName()}, ${modes[currentMode]}, ${botCount} bots. Gameplay is outside this UI study.` : 'Current sandbox controls. Gameplay is outside this UI study.'}</p>`;
    case 'settings': return `${topLine('Settings')}<h2>Make yourself at home</h2><label class="settings-row" for="volume"><span>Master volume <small id="volume-value">${volume}%</small></span><input id="volume" type="range" min="0" max="100" value="${volume}"></label><label class="settings-row" for="motion"><span>Menu animation</span><input id="motion" type="checkbox" ${motion ? 'checked' : ''}></label><div class="settings-row"><span>Player name</span><button class="text-button" data-action="change-name">${identity()} / Change</button></div><p class="small" style="margin-top:20px">Saved on this browser. System reduced-motion preferences always win. This preview plays no audio.</p><div class="actions">${action('Back to menu [Enter]', 'menu', true)}</div>`;
    case 'credits': return `
      ${topLine('Credits & licenses')}
      <h2>The people behind the pixels</h2>
      <p class="small">An independent browser revival UI study. Field Sandbox is a working title, not the Soldat brand.</p>
      <ul class="credit-list">
        <li>Original Soldat art: Michal Marcinkowski, Transhuman Design and the base-content contributors.</li>
        <li>Airpirates: Evil Ville. DesertWind: grand_diablo. ctf_Death remake: NuZZ.</li>
        <li>Play typeface: Play contributors, SIL Open Font License 1.1.</li>
        <li>Original graphics and map captures are used under Creative Commons Attribution 4.0. Backdrops are cropped, darkened or tinted; the menu cursor is scaled down.</li>
      </ul>
      <nav class="menu" aria-label="License documents">
        <a class="small" href="./assets/base-license.txt">Read CC BY 4.0 license</a>
        <a class="small" href="./assets/base-credits.txt">Read base-content contributor credits</a>
        <a class="small" href="./assets/play-OFL.txt">Read Play font license</a>
      </nav>
      <p class="permission" style="margin-top:18px">The Soldat name and logo require written permission from Transhuman Design for product branding. The optional original-title study in option B is permission-dependent.</p>
      <div class="actions">${action('Back to menu [Enter]', 'menu', true)}</div>`;
    default: return '';
  }
}
function regionTable() { return `<table class="regions"><thead><tr><th>Region</th><th>Latency</th><th>Availability</th></tr></thead><tbody><tr class="chosen"><td>Sydney</td><td>18 ms</td><td>Best match</td></tr><tr><td>Singapore</td><td>96 ms</td><td><small>Stretch goal</small></td></tr><tr><td>Frankfurt</td><td>290 ms</td><td><small>Stretch goal</small></td></tr></tbody></table>`; }
function navigate(target, remember = true) {
  if (target === 'lobby' && screen === 'menu') { host = true; ready = false; matchReady = false; }
  if (target === 'name' && screen !== 'settings') returnAfterName = 'menu';
  if (remember && target !== screen) history.push(screen);
  screen = target;
  render();
}
function render() {
  stopTimers();
  app.innerHTML = `<div class="scene" aria-hidden="true"></div><div class="demo-bar"><a href="./index.html">← All options / ${option.toUpperCase()}</a><span>${titles[option]} / Interactive UI study</span><nav class="screen-tabs" aria-label="Preview screens">${navigation.map((target, i) => `<button data-action="${target}" ${screen === target || (screen === 'joined' && target === 'quickplay') ? 'aria-current="step"' : ''}>${labels[i]}</button>`).join('')}</nav></div><main class="stage ${screen}${screen === 'lobby' ? ' lobby-screen' : ''}${screen === 'credits' ? ' credits-screen' : ''}${screen === 'joined' ? ' joined-screen' : ''}"><div class="shell">${header()}${sideArtwork()}<section class="panel" aria-label="${screen === 'boot' ? 'Loading assets' : screen === 'menu' ? 'Main menu' : screen}">${content()}</section></div><div class="map-caption" aria-hidden="true"><strong>${option === 'a' ? 'Airpirates' : 'Arena'}</strong><span>Original maps. Original pixels.</span></div></main><footer class="footer"><span>Enter / Space: select &nbsp; Backspace: back &nbsp; 1–6: menu</span><span><button data-action="credits">Credits & licenses</button> &nbsp; UI preview / no server connection</span></footer>`;
  document.title = `${option.toUpperCase()} — ${titles[option]} / Field Sandbox`;
  const artwork = screen === 'lobby' || screen === 'practice'
    ? (currentMode === 1 ? 'ctf-death.png' : ['arena.jpg', 'airpirates.png', 'desertwind.png'][currentMap])
    : 'arena.jpg';
  app.querySelector('.stage').style.setProperty('--preview-map', `url('./assets/${artwork}')`);
  bind();
  if (screen === 'boot') beginLoader();
  if (screen === 'quickplay') later(() => navigate('joined'), 5200);
}
function bind() {
  app.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => perform(button.dataset.action)));
  app.querySelectorAll('[data-menu-index]').forEach(button => button.addEventListener('pointerenter', () => {
    selected = Number(button.dataset.menuIndex);
    app.querySelectorAll('[data-menu-index]').forEach(row => row.classList.toggle('active', Number(row.dataset.menuIndex) === selected));
  }));
  const nameInput = document.querySelector('#player-name');
  if (nameInput) {
    nameInput.addEventListener('input', () => { document.querySelector('#name-count').textContent = `${nameInput.value.length} / 24`; nameInput.removeAttribute('aria-invalid'); document.querySelector('#name-error').textContent = ''; });
    document.querySelector('#name-form').addEventListener('submit', event => { event.preventDefault(); saveName(); });
    nameInput.focus({ preventScroll: true });
  }
  const joinForm = document.querySelector('#join-form');
  if (joinForm) joinForm.addEventListener('submit', event => { event.preventDefault(); joinLobby(); });
  document.querySelector('#volume')?.addEventListener('input', event => {
    volume = Number(event.target.value); storage.set('volume', String(volume)); document.querySelector('#volume-value').textContent = `${volume}%`;
  });
  document.querySelector('#motion')?.addEventListener('change', event => {
    motion = event.target.checked; storage.set('motion', motion ? 'on' : 'off'); document.body.classList.toggle('reduce-motion', !motion);
  });
}
function beginLoader() {
  let progress = 24;
  function tick() {
    if (screen !== 'boot') return;
    progress = Math.min(100, progress + 4);
    document.querySelector('#load-percent').textContent = `${progress}%`;
    document.querySelector('#load-fill').style.width = `${progress}%`;
    document.querySelector('.progress').setAttribute('aria-valuenow', String(progress));
    document.querySelector('#load-bytes').textContent = `${(5.3 * progress / 100).toFixed(2)} / 5.30 MB`;
    document.querySelector('#load-files').textContent = `${Math.round(318 * progress / 100)} / 318 files`;
    document.querySelector('#load-file').textContent = progress === 100 ? 'Ready. The battlefield is waiting.' : progress < 45 ? 'Reading map textures…' : progress < 75 ? 'Loading soldiers and weapon sprites…' : 'Unpacking sounds and interface…';
    if (progress < 100) later(tick, 260);
  }
  later(tick, 260);
}
function saveName() {
  const input = document.querySelector('#player-name');
  const value = input.value;
  if (!/^[\x20-\x7e]{1,24}$/.test(value) || !value.trim()) {
    document.querySelector('#name-error').textContent = 'Use 1–24 printable ASCII characters, with at least one non-space character.';
    input.setAttribute('aria-invalid', 'true'); input.focus(); return;
  }
  name = value; storage.set('name', value); navigate(returnAfterName);
}
function joinLobby() {
  const input = document.querySelector('#lobby-link');
  let code = input.value.trim();
  try { const url = new URL(code); code = url.searchParams.get('lobby') || ''; } catch { /* A plain code needs no URL parsing. */ }
  if (!/^[A-Za-z0-9]{6}$/.test(code)) {
    document.querySelector('#join-error').textContent = 'Use a six-character code, or a link containing a lobby code.';
    input.setAttribute('aria-invalid', 'true'); input.focus(); return;
  }
  lobbyCode = code.toUpperCase(); host = false; ready = false; matchReady = false;
  if (!name) { navigate('name'); returnAfterName = 'lobby'; }
  else navigate('lobby');
}
function next() {
  if (screen === 'boot') navigate('name');
  else if (screen === 'name') saveName();
  else if (screen === 'menu') perform(menuTargets[selected]);
  else if (screen === 'quickplay') navigate('joined');
  else if (screen === 'joined') navigate('lobby');
  else if (screen === 'lobby') perform(host ? 'start-lobby' : 'toggle-ready');
  else if (screen === 'join') joinLobby();
  else if (screen === 'practice') perform('start-practice');
  else navigate('menu');
}
async function perform(command) {
  if (command === 'next') { next(); return; }
  if (command === 'change-name') { navigate('name'); returnAfterName = 'settings'; return; }
  if (command === 'cycle-map' && (screen !== 'lobby' || host)) { currentMap = (currentMap + 1) % maps.length; if (currentMode === 1) currentMode = 0; matchReady = false; practiceStarted = false; render(); return; }
  if (command === 'cycle-mode' && (screen !== 'lobby' || host)) { currentMode = (currentMode + 1) % modes.length; matchReady = false; practiceStarted = false; render(); return; }
  if (command === 'cycle-bots') { botCount = (botCount + 1) % 32; practiceStarted = false; render(); return; }
  if (command === 'toggle-ready') { ready = !ready; render(); return; }
  if (command === 'start-lobby') { matchReady = true; document.querySelector('#lobby-status').textContent = `Everyone is ready. ${mapName()} would open here in the connected game.`; document.querySelector('[data-action="start-lobby"]').textContent = 'Match ready'; return; }
  if (command === 'start-practice') { practiceStarted = true; document.querySelector('#practice-status').textContent = `Practice selected: ${mapName()}, ${modes[currentMode]}, ${botCount} bots. Gameplay is outside this UI study.`; return; }
  if (command === 'enter-preview') { document.querySelector('#preview-message').textContent = 'Arena is ready. Gameplay would open here in the connected game.'; return; }
  if (command === 'copy-link') {
    const url = new URL(location.href); url.search = ''; url.searchParams.set('lobby', lobbyCode); url.hash = '';
    try { await navigator.clipboard.writeText(url.href); document.querySelector('#copy-link').textContent = 'Link copied'; document.querySelector('#lobby-status').textContent = 'Link copied. Send it to a friend to open the join screen.'; }
    catch { document.querySelector('#lobby-status').innerHTML = `<label for="copy-fallback">Copy this link:</label><input id="copy-fallback" style="width:100%;font-size:12px;margin-top:8px" readonly value="${escape(url.href)}">`; const input = document.querySelector('#copy-fallback'); input.focus(); input.select(); }
    return;
  }
  if (['boot', 'name', 'menu', 'quickplay', 'joined', 'lobby', 'join', 'practice', 'settings', 'credits'].includes(command)) navigate(command);
}
document.addEventListener('keydown', event => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
  if (editing) return;
  if (event.key === 'Backspace' || event.key === 'Escape') { event.preventDefault(); const previous = history.pop() || 'menu'; navigate(previous, false); return; }
  if (screen === 'menu' && /^[1-6]$/.test(event.key)) { event.preventDefault(); selected = Number(event.key) - 1; perform(menuTargets[selected]); return; }
  if ((screen === 'lobby' || screen === 'practice') && /^[1-3]$/.test(event.key)) { event.preventDefault(); const command = ['cycle-map', 'cycle-mode', 'cycle-bots'][Number(event.key) - 1]; if (screen === 'practice' || Number(event.key) < 3) perform(command); return; }
  if (screen === 'menu' && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : 5)) % 6; app.querySelectorAll('[data-menu-index]').forEach(row => row.classList.toggle('active', Number(row.dataset.menuIndex) === selected)); return; }
  if (event.key === 'Enter' || event.key === ' ') {
    // Let focused controls retain native activation; otherwise advance the screen.
    if (event.target.closest('button,a,summary')) return;
    event.preventDefault(); next();
  }
});
render();
if (initialCode) navigate('join', false);
else if (params.has('screen') && ['boot', 'name', 'menu', 'quickplay', 'joined', 'lobby', 'join', 'practice', 'settings', 'credits'].includes(params.get('screen'))) navigate(params.get('screen'), false);
