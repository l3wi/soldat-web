const app = document.querySelector('#app');
const background = document.querySelector('#attract-background');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const query = new URLSearchParams(location.search);
const screens = ['boot', 'name', 'menu', 'quickplay', 'joined', 'lobby', 'maps', 'join', 'practice', 'settings', 'credits'];
const menuLabels = ['Quick play', 'Play with friends', 'Join lobby', 'Practice vs bots', 'Settings', 'Credits & licenses'];
const menuScreens = ['quickplay', 'lobby', 'join', 'practice', 'settings', 'credits'];
const modes = ['Deathmatch', 'Capture the flag'];
const maps = [
  { name: 'Arena', image: 'arena.jpg', note: 'Open slopes and short jumps.' },
  { name: 'Airpirates', image: 'airpirates.png', note: 'Floating islands and long drops.' },
  { name: 'ctf_Ash', image: 'attract-poster.jpg', note: 'Two bases, a central bridge and a lower route.' },
  { name: 'ctf_Death', image: 'ctf-death.png', note: 'The skull-shaped classic.' },
  { name: 'DesertWind', image: 'desertwind.png', note: 'Rock arches and narrow bridges.' },
  { name: 'Jungle', image: 'jungle.jpg', note: 'Steep ground under the canopy.' },
  { name: 'inf_Biologic', image: 'biologic.jpg', note: 'Layered stone and jungle scenery.' },
  { name: 'Aero', image: 'aero.png', note: 'Small platforms in open sky.' },
];
const regions = [
  { name: 'Sydney', latency: 18, stretch: false },
  { name: 'Singapore', latency: 96, stretch: true },
  { name: 'Frankfurt', latency: 290, stretch: true },
];
const storage = {
  get(key, fallback = '') {
    try { return localStorage.getItem(`field-shell-${key}`) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`field-shell-${key}`, String(value)); }
    catch { /* A private or restricted browser can still use the whole flow. */ }
  },
};
const validName = value => /^[\x20-\x7e]{1,24}$/.test(value) && !!value.trim();
const rememberedName = storage.get('name');
const state = {
  screen: 'boot', name: validName(rememberedName) ? rememberedName : '', selected: 0,
  mode: 0, map: 0, highlightedMap: 0, mapReturn: 'lobby', bots: 8,
  host: true, ready: false, matchReady: false, code: 'K7M4Q2',
  volume: Number(storage.get('volume', '60')), motion: storage.get('motion', 'on') === 'on',
  afterName: 'menu', history: [],
};
let timers = [];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const later = (callback, delay) => timers.push(setTimeout(callback, delay));
const identity = () => escape(state.name || 'Player');
const action = (label, command, primary = false) => `<button class="action${primary ? ' primary' : ''}" data-action="${command}">${label}</button>`;
const preview = (map = maps[state.map]) => `<div class="preview-map" style="--preview-map:url('./assets/${map.image}')"><span>${map.name}</span></div>`;

function syncBackground() {
  const animate = state.motion && !reducedMotion.matches;
  document.body.classList.toggle('reduce-motion', !animate);
  if (!animate) {
    background.pause();
    background.parentElement.classList.remove('has-motion');
    return;
  }
  if (!background.querySelector('source').src) {
    background.querySelectorAll('source').forEach(source => { source.src = source.dataset.src; });
    background.load();
  }
  background.play().catch(() => background.parentElement.classList.remove('has-motion'));
}
background.addEventListener('playing', () => background.parentElement.classList.add('has-motion'));
reducedMotion.addEventListener('change', syncBackground);
syncBackground();

function wordmark() {
  return `<header class="masthead"><h1 class="wordmark"><span>Soldat</span><span>Online</span></h1></header>`;
}
function roster(friends = false) {
  // A plain wrapping row of names; bots are one aggregate entry. In friend lobbies, unready names are dimmed.
  const others = friends ? ['Sarge', 'Kowalski', 'Rook'] : ['Sarge', 'Major', 'Kowalski', 'Rook', 'Viper', 'Mags'];
  const meReady = !friends || state.host || state.ready;
  const names = [`<li class="you${meReady ? '' : ' waiting'}" title="${friends ? (meReady ? 'Ready' : 'Not ready') : 'You'}">${identity()}</li>`,
    ...others.map((name, index) => `<li${friends && index === 2 ? ' class="waiting" title="Not ready"' : ''}>${name}</li>`),
    `<li class="bots">+ ${friends ? 4 : 2} bots</li>`];
  return `<ul class="roster" aria-label="${friends ? 'Lobby players' : 'Joined players'}">${names.join('')}</ul>`;
}
function setupRows() {
  return `<div class="config" aria-label="Game setup">
    <button class="menu-row" data-action="mode" ${state.screen === 'lobby' && !state.host ? 'disabled' : ''}><span class="number">1</span><span>Game type</span><strong>${modes[state.mode]}</strong></button>
    <button class="menu-row" data-action="maps" ${state.screen === 'lobby' && !state.host ? 'disabled' : ''}><span class="number">2</span><span>Map</span><strong>${maps[state.map].name}</strong></button>
  </div>`;
}
function content() {
  switch (state.screen) {
    case 'boot':
      return `<div class="progress" role="progressbar" aria-label="Loading assets" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="load-fill"></span></div><p id="load-status" class="load-file" role="status">Loading maps…</p>`;
    case 'name':
      return `<h2>Your name</h2>
        <form id="name-form" novalidate><div class="field">
          <input id="player-name" maxlength="24" autocomplete="nickname" spellcheck="false" value="${escape(state.name)}" placeholder="Type your name" aria-label="Player name" aria-describedby="name-error">
          <p class="error" id="name-error" role="alert"></p></div><button class="action primary" type="submit">Continue [Enter]</button>
        </form>`;
    case 'menu':
      return `<nav class="menu" aria-label="Main menu">${menuLabels.map((label, index) => `<button class="menu-row${state.selected === index ? ' active' : ''}" data-action="${menuScreens[index]}" data-menu-index="${index}"><span class="number">${index + 1}</span><span>${label}</span></button>`).join('')}</nav>`;
    case 'quickplay':
      return `<h2>Finding a game</h2>
        <div class="region-results"><table class="regions"><tbody id="region-rows"></tbody></table></div>
        <div class="search-status" id="search-status" role="status"><i class="spinner"></i><span>Testing Sydney…</span></div>
        <div class="actions">${action('Cancel [Esc]', 'cancel-search')}</div>`;
    case 'joined':
      return `<h2>Arena</h2><p class="match-label">Deathmatch / 18 ms</p>${preview(maps[0])}
        ${roster()}
        <div class="actions">${action('Enter game [Enter]', 'enter-game', true)}${action('Back', 'menu')}</div>
        <p class="preview-notice" id="game-status" role="status"></p>`;
    case 'lobby':
      return `<h2>Friend game</h2>
        <div class="lobby-setup">${setupRows()}${preview()}</div>
        <div class="lobby-code"><strong>${escape(state.code)}</strong>${action('Copy link', 'copy-link')}</div>
        ${roster(true)}
        <div class="actions">${action(state.host ? (state.matchReady ? 'Starting…' : 'Start [Enter]') : (state.ready ? 'Ready ✓' : 'Ready up [Enter]'), state.host ? 'start' : 'ready', true)}${action('Leave', 'menu')}</div>
        <p class="preview-notice" id="lobby-status" role="status"></p>`;
    case 'maps':
      return `<h2>Choose a map</h2>
        <div class="map-picker"><div class="map-list" role="listbox" aria-label="Maps">${maps.map((map, index) => `<button class="menu-row" role="option" aria-selected="${index === state.highlightedMap}" data-map="${index}"><span class="number">${index + 1}</span><span>${map.name}</span></button>`).join('')}</div>
          <div id="map-detail">${mapDetail()}</div>
        </div><div class="actions">${action('Back [Esc]', 'close-maps')}</div>`;
    case 'join':
      return `<h2>Join a friend game</h2>
        <form id="join-form" novalidate><div class="field"><input id="lobby-link" autocomplete="off" spellcheck="false" value="${escape(query.get('lobby') || '')}" placeholder="Link or code" aria-label="Lobby link or code" aria-describedby="join-error" style="font-size:18px"><p id="join-error" class="error" role="alert"></p></div><button class="action primary" type="submit">Join [Enter]</button></form>
        <div class="actions">${action('Back', 'menu')}</div>`;
    case 'practice':
      return `<h2>Practice vs bots</h2>${setupRows()}
        <label class="menu-row config" for="bot-count"><span class="number">3</span><span>Bots</span><input id="bot-count" type="number" min="0" max="31" value="${state.bots}"></label>
        ${preview()}<div class="actions">${action('Start practice [Enter]', 'practice-start', true)}${action('Back', 'menu')}</div>
        <p id="practice-status" class="preview-notice" role="status"></p>`;
    case 'settings':
      return `<h2>Settings</h2>
        <label class="settings-row" for="volume"><span>Master volume <small id="volume-value">${state.volume}%</small></span><input id="volume" type="range" min="0" max="100" value="${state.volume}"></label>
        <label class="settings-row" for="motion"><span>Gameplay background</span><input id="motion" type="checkbox" ${state.motion ? 'checked' : ''}></label>
        <div class="settings-row"><span>Name</span><button class="text-button" data-action="change-name">${identity()}</button></div>
        <div class="actions">${action('Back', 'menu', true)}</div>`;
    case 'credits':
      return `<h2>Credits</h2>
        <ul class="credit-list"><li>A port of the original OpenSoldat game logic, compiled to WebAssembly and verified bit-for-bit against the original server. Art and sound re-encoded for the web (lossless WebP, Opus).</li><li>Original art: Michal Marcinkowski, Transhuman Design and the base-content contributors.</li><li>Airpirates: Evil Ville. DesertWind: grand_diablo. ctf_Ash: chakapoko maker. ctf_Death remake: NuZZ.</li><li>Play typeface: Play contributors, SIL Open Font License 1.1.</li><li>Art and captures: CC BY 4.0, cropped or tinted.</li></ul>
        <nav class="menu" aria-label="License documents"><a class="small" href="./assets/base-license.txt" target="_blank" rel="noopener">CC BY 4.0 license</a><a class="small" href="./assets/base-credits.txt" target="_blank" rel="noopener">Contributor credits</a><a class="small" href="./assets/play-OFL.txt" target="_blank" rel="noopener">Play font license</a></nav>
        <div class="actions">${action('Back', 'menu', true)}</div>`;
  }
}
function mapDetail() {
  const map = maps[state.highlightedMap];
  return `${preview(map)}<p class="map-name">${map.name}</p>`;
}
function navigate(screen, remember = true) {
  if (remember && screen !== state.screen) state.history.push(state.screen);
  if (screen === 'lobby' && state.screen === 'menu') { state.host = true; state.ready = false; state.matchReady = false; }
  state.screen = screen;
  render();
}
function render() {
  timers.forEach(clearTimeout); timers = [];
  const tabScreens = ['boot', 'name', 'menu', 'quickplay', 'lobby'];
  const tabLabels = ['Load', 'Name', 'Menu', 'Quick play', 'Friends'];
  app.innerHTML = `<div class="demo-bar"><a href="./index.html">← All options / A</a><span>Chosen direction / Round 2</span><nav class="screen-tabs" aria-label="Preview screens">${tabScreens.map((screen, index) => `<button data-action="${screen}" ${screen === state.screen || (screen === 'quickplay' && state.screen === 'joined') || (screen === 'lobby' && state.screen === 'maps') ? 'aria-current="step"' : ''}>${tabLabels[index]}</button>`).join('')}</nav></div>
    <main class="stage ${state.screen}${['joined', 'lobby', 'maps', 'credits'].includes(state.screen) ? ` ${state.screen}-screen` : ''}"><div class="shell">${wordmark()}<section class="panel" aria-label="${state.screen}">${content()}</section></div></main>
    `;
  bind();
  if (state.screen === 'boot') load();
  if (state.screen === 'quickplay') ping();
}
function bind() {
  app.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => perform(button.dataset.action)));
  app.querySelectorAll('[data-menu-index]').forEach(button => button.addEventListener('pointerenter', () => {
    state.selected = Number(button.dataset.menuIndex);
    app.querySelectorAll('[data-menu-index]').forEach(row => row.classList.toggle('active', Number(row.dataset.menuIndex) === state.selected));
  }));
  app.querySelectorAll('[data-map]').forEach(button => {
    button.addEventListener('click', () => chooseMap(Number(button.dataset.map)));
    button.addEventListener('focus', () => highlightMap(Number(button.dataset.map)));
    button.addEventListener('pointerenter', () => highlightMap(Number(button.dataset.map)));
  });
  const nameInput = app.querySelector('#player-name');
  if (nameInput) {
    nameInput.focus({ preventScroll: true });
    nameInput.addEventListener('input', () => { nameInput.removeAttribute('aria-invalid'); app.querySelector('#name-error').textContent = ''; });
    app.querySelector('#name-form').addEventListener('submit', event => { event.preventDefault(); saveName(); });
  }
  app.querySelector('#join-form')?.addEventListener('submit', event => { event.preventDefault(); join(); });
  app.querySelector('#bot-count')?.addEventListener('input', event => { state.bots = Math.max(0, Math.min(31, Math.trunc(Number(event.target.value)))); });
  app.querySelector('#volume')?.addEventListener('input', event => { state.volume = Number(event.target.value); storage.set('volume', state.volume); app.querySelector('#volume-value').textContent = `${state.volume}%`; });
  app.querySelector('#motion')?.addEventListener('change', event => { state.motion = event.target.checked; storage.set('motion', state.motion ? 'on' : 'off'); syncBackground(); });
}
function load() {
  let progress = 0;
  const step = () => {
    progress = Math.min(100, progress + 5);
    app.querySelector('#load-fill').style.width = `${progress}%`;
    app.querySelector('.progress').setAttribute('aria-valuenow', String(progress));
    app.querySelector('#load-status').textContent = progress === 100 ? 'Ready.' : progress < 35 ? 'Loading maps…' : progress < 70 ? 'Loading soldiers…' : 'Loading sounds…';
    if (progress < 100) later(step, 140);
    else later(() => navigate(state.name ? 'menu' : 'name', false), 300);
  };
  later(step, 140);
}
function ping() {
  regions.forEach((region, index) => later(() => {
    app.querySelector('#region-rows').insertAdjacentHTML('beforeend', `<tr data-region="${region.name}"><td>${region.name}</td><td>${region.latency} ms</td></tr>`);
    if (index < regions.length - 1) app.querySelector('#search-status').innerHTML = `<i class="spinner"></i><span>Testing ${regions[index + 1].name}…</span>`;
    else {
      const best = regions.reduce((winner, region) => region.latency < winner.latency ? region : winner);
      app.querySelector(`[data-region="${best.name}"]`).classList.add('chosen');
      let seconds = 3;
      const countdown = () => {
        app.querySelector('#search-status').innerHTML = `<span class="countdown">Joining ${best.name} in <strong>${seconds}</strong>…</span>`;
        later(() => { seconds--; if (seconds === 0) navigate('joined', false); else countdown(); }, 1000);
      };
      countdown();
    }
  }, 500 + index * 500));
}
function saveName() {
  const input = app.querySelector('#player-name');
  if (!validName(input.value)) {
    app.querySelector('#name-error').textContent = 'Use 1–24 letters, numbers or symbols.';
    input.setAttribute('aria-invalid', 'true'); input.focus(); return;
  }
  state.name = input.value; storage.set('name', state.name); navigate(state.afterName);
}
function join() {
  const input = app.querySelector('#lobby-link');
  let code = input.value.trim();
  try { code = new URL(code).searchParams.get('lobby') || ''; } catch { /* Plain codes are allowed. */ }
  if (!/^[a-z0-9]{6}$/i.test(code)) { input.setAttribute('aria-invalid', 'true'); app.querySelector('#join-error').textContent = 'Paste a lobby link or 6-character code.'; input.focus(); return; }
  state.code = code.toUpperCase(); state.host = false; state.ready = false;
  if (!state.name) { state.afterName = 'lobby'; navigate('name'); }
  else navigate('lobby');
}
function highlightMap(index) {
  state.highlightedMap = index;
  app.querySelectorAll('[data-map]').forEach(row => row.setAttribute('aria-selected', String(Number(row.dataset.map) === index)));
  app.querySelector('#map-detail').innerHTML = mapDetail();
}
function chooseMap(index) {
  state.map = index; state.matchReady = false; navigate(state.mapReturn, false);
}
function back() {
  if (state.screen === 'quickplay') { navigate('menu', false); return; }
  if (state.screen === 'maps') { navigate(state.mapReturn, false); return; }
  navigate(state.history.pop() || 'menu', false);
}
async function perform(command) {
  if (command === 'cancel-search') { navigate('menu', false); return; }
  if (command === 'mode' && (state.screen !== 'lobby' || state.host)) { state.mode = (state.mode + 1) % modes.length; state.matchReady = false; render(); return; }
  if (command === 'maps') {
    if (state.screen === 'lobby' && !state.host) return;
    state.mapReturn = state.screen === 'practice' ? 'practice' : 'lobby'; state.highlightedMap = state.map; navigate('maps', false); return;
  }
  if (command === 'close-maps') { navigate(state.mapReturn, false); return; }
  if (command === 'change-name') { state.afterName = 'settings'; navigate('name'); return; }
  if (command === 'start') { state.matchReady = true; app.querySelector('[data-action="start"]').textContent = 'Starting…'; return; }
  if (command === 'ready') { state.ready = !state.ready; render(); return; }
  if (command === 'practice-start') { app.querySelector('[data-action="practice-start"]').textContent = 'Starting…'; return; }
  if (command === 'enter-game') { app.querySelector('[data-action="enter-game"]').textContent = 'Joining…'; return; }
  if (command === 'copy-link') {
    const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('lobby', state.code);
    try { await navigator.clipboard.writeText(url.href); app.querySelector('[data-action="copy-link"]').textContent = 'Link copied'; }
    catch { app.querySelector('#lobby-status').innerHTML = `<label for="copy-link">Copy this link:</label><input id="copy-link" readonly style="width:100%;margin-top:7px;font-size:12px" value="${escape(url.href)}">`; const input = app.querySelector('#copy-link'); input.focus(); input.select(); }
    return;
  }
  if (screens.includes(command)) { if (command === 'name') state.afterName = 'menu'; navigate(command); }
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); back(); return; }
  const editing = event.target.matches('input,select,textarea');
  if (editing) return;
  if (event.key === 'Backspace') { event.preventDefault(); back(); return; }
  if (state.screen === 'menu' && /^[1-6]$/.test(event.key)) { event.preventDefault(); state.selected = Number(event.key) - 1; perform(menuScreens[state.selected]); return; }
  if (state.screen === 'maps') {
    if (/^[1-8]$/.test(event.key)) { event.preventDefault(); chooseMap(Number(event.key) - 1); return; }
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; highlightMap((state.highlightedMap + direction + maps.length) % maps.length); app.querySelector(`[data-map="${state.highlightedMap}"]`).focus(); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseMap(state.highlightedMap); return; }
  }
  if (['lobby', 'practice'].includes(state.screen) && /^[12]$/.test(event.key)) { event.preventDefault(); perform(event.key === '1' ? 'mode' : 'maps'); return; }
  if (state.screen === 'practice' && event.key === '3') { event.preventDefault(); app.querySelector('#bot-count').focus(); return; }
  if (state.screen === 'menu' && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); state.selected = (state.selected + (event.key === 'ArrowDown' ? 1 : 5)) % 6; app.querySelectorAll('[data-menu-index]').forEach(row => row.classList.toggle('active', Number(row.dataset.menuIndex) === state.selected)); return; }
  if (event.key === 'Enter' || event.key === ' ') {
    if (event.target.closest('button,a')) return;
    event.preventDefault();
    const command = { menu: menuScreens[state.selected], joined: 'enter-game', lobby: state.host ? 'start' : 'ready', practice: 'practice-start', settings: 'menu', credits: 'menu' }[state.screen];
    if (command) perform(command);
  }
});
if (query.has('lobby')) { state.host = false; state.screen = 'join'; }
else if (screens.includes(query.get('screen'))) state.screen = query.get('screen');
render();
