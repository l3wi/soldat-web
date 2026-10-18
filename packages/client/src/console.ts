import type { ChatDelivery, ControlState, FeatureClientMessage } from '@soldat-web/protocol';
import { normalizeBinding } from './bindings';
import { assignGameplayBinding, DEFAULT_SETTINGS, saveSettings, validNickname, type ControlAction, type Settings } from './settings';
import { validChatText } from './taunts';
import { containsAdminCredential, featureCommand } from './feature-commands';

export type ChatChannel = 'public' | 'team';
export interface ConsoleLine { text: string; color: string; at: number; slot?: number; nickname?: string }
export interface ConsoleCallbacks {
  onChat?: (channel: ChatChannel, text: string) => void;
  onConsoleCommand?: (command: string, args: readonly string[]) => void | Promise<void>;
  onSettingsChange?: (settings: Settings) => void;
  onFeature?: (message: FeatureClientMessage) => void;
  onLocalMuteChange?: () => void;
}

/** One command only. Supports original doubled quotes and escaped quotes/backslashes; never evaluates JS/HTML. */
export function parseConsoleCommand(input: string): string[] {
  const text = input.trim().replace(/^\//, '');
  const args: string[] = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) { value += text[++i]; started = true; }
    else if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) { args.push(value); value = ''; started = false; }
    } else { value += char; started = true; }
  }
  if (quoted) throw new Error('Unclosed quote');
  if (started) args.push(value);
  return args;
}

export class ConsoleHistory {
  readonly entries: string[] = [];
  private position = 0;
  private draft = '';
  add(value: string): void {
    if (containsAdminCredential(value)) { this.reset(); return; }
    if (value && this.entries.at(-1) !== value) this.entries.push(value);
    if (this.entries.length > 100) this.entries.shift();
    this.position = this.entries.length;
    this.draft = '';
  }
  move(direction: -1 | 1, current: string): string {
    if (this.position === this.entries.length) this.draft = containsAdminCredential(current) ? '' : current;
    this.position = Math.max(0, Math.min(this.entries.length, this.position + direction));
    return this.entries[this.position] ?? this.draft;
  }
  reset(): void { this.position = this.entries.length; this.draft = ''; }
}

export const GAMEPLAY_BIND_COMMANDS: Readonly<Record<string, ControlAction>> = {
  '+left': 'left', '+right': 'right', '+jump': 'up', '+crouch': 'down', '+fire': 'fire', '+jet': 'jetpack',
  '+throwgrenade': 'throwNade', '+changeweapon': 'changeWeapon', '+dropweapon': 'throwWeapon',
  '+reload': 'reload', '+prone': 'prone', '+flagthrow': 'flagThrow',
};
const BOOLEAN_SETTINGS: Readonly<Record<string, 'mipmaps' | 'gameplayBackground' | 'sniperLine' | 'scope' | 'playerNames'>> = {
  r_mipmapping: 'mipmaps', r_renderbackground: 'gameplayBackground', ui_sniperline: 'sniperLine',
  scope: 'scope', playernames: 'playerNames',
};
const CONTEXT_COMMANDS: Readonly<Record<string, true>> = {
  screenshot: true, disconnect: true, shutdown: true, retry: true, connect: true, join: true, joinurl: true,
  switchcam: true, switchcamflag: true, team: true, weapons: true, matchmenu: true,
};
const HELP = [
  'Commands: /say "text", /say_team "text", /bind "key" "command", /unbindall',
  '/mute <slot|name|all>, /unmute <slot|name|all>, /taunt "Alt+key" <public|team> "text"',
  '/screenshot, /disconnect (or /shutdown), /retry, /switchcam <slot>, /switchcamflag <1|2|3>',
  '/team <0..5>, /weapons (native team/loadout legality still applies)',
  '/connect, /join or /joinurl <lobby code | friend link | HTTP(S)/WS(S) server origin> (one argument)',
  'Browser joining uses fresh admission. Native IP/port/password and consumed match-ticket URLs are not supported.',
  'Settings (omit value to read): snd_volume <0..100>, r_texturefilter <1|2>, r_mipmapping <0|1>,',
  'r_renderbackground <0|1>, ui_sniperline <0|1>, scope <0|1>, playernames <0|1>, cl_player_name "name"',
  'T: chat; Y: team chat; /: console; Enter: send; Escape: cancel; Up/Down: history; PageUp/PageDown: log.',
  'Alt+1..4: smoke, tabac, takeoff, victory; /kill: self-kill; V: numbered team radio; /radio <1..3> <1..3>.',
  '/vote map <map>, /vote kick <slot> <reason>, /vote yes (F12), /vote no (F11), /matchmenu.',
  '/admin [login] <token>, /admin logout. Operator tokens are never saved; use a secure server.',
  '/kick <slot> [reason], /ban <slot> <minutes> [reason], /unban <id>, /bans, /servermute or /serverunmute <slot>.',
  '/setteam <slot> <0..5>, /kill <slot>, /map <map>, /nextmap, /restart, /pause, /unpause.',
  'Local /mute is distinct from server moderation. /bind \"key\" \"+voicechat\" sets hold-to-talk (voice must be enabled).',
];

export class GameConsole {
  readonly lines: ConsoleLine[] = [];
  readonly history = new ConsoleHistory();
  settings: Settings;
  controls: ControlState = { host: false, admin: false, paused: false, muted: false, vote: null };
  private muteAll = false;
  private readonly mutedSlots = new Map<number, string>();
  private readonly mutedNames = new Set<string>();
  players: readonly { slot: number; name?: string; bot?: boolean }[] = [];
  constructor(settings: Settings = DEFAULT_SETTINGS, private readonly callbacks: ConsoleCallbacks = {}) { this.settings = settings; }

  notice(text: string, color = '#ffe6aa'): void {
    this.lines.push({ text, color, at: Date.now() });
    if (this.lines.length > 200) this.lines.shift();
  }
  isPlayerMuted(slot: number, nickname: string): boolean {
    const name = nickname.toLowerCase();
    return this.muteAll || this.mutedNames.has(name) || this.mutedSlots.get(slot) === name;
  }
  receiveChat(message: ChatDelivery): boolean {
    const name = message.nickname.toLowerCase();
    if (this.isPlayerMuted(message.slot, message.nickname)) return false;
    this.lines.push({ text: `${message.channel === 'team' ? '(TEAM) ' : ''}${message.nickname}: ${message.text}`,
      color: message.channel === 'team' ? '#a5e6ff' : '#ffe6aa', at: Date.now(), slot: message.slot, nickname: name });
    if (this.lines.length > 200) this.lines.shift();
    return true;
  }
  sendChat(channel: ChatChannel, text: string): void {
    if (!validChatText(text)) throw new Error('Chat must contain 1–120 characters without control characters');
    if (!this.callbacks.onChat) throw new Error('Chat is unavailable in this session');
    this.callbacks.onChat(channel, text);
  }
  private change(settings: Settings): void {
    this.settings = settings;
    saveSettings(settings);
    this.callbacks.onSettingsChange?.(settings);
  }
  async submit(text: string, channel: ChatChannel = 'public'): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.history.add(trimmed);
    if (trimmed.startsWith('/')) await this.execute(trimmed);
    else {
      try { this.sendChat(channel, trimmed); }
      catch (error) { this.notice(`Error: ${error instanceof Error ? error.message : String(error)}`, '#ff7777'); }
    }
  }
  async execute(text: string): Promise<void> {
    try {
      const tokens = parseConsoleCommand(text);
      const command = tokens.shift()?.toLowerCase() ?? '';
      if (!command) return;
      const args = tokens;
      if (command === 'help') { for (const line of HELP) this.notice(line); return; }
      const feature = featureCommand(command, args, this.controls.vote);
      if (feature) {
        if (!this.callbacks.onFeature) throw new Error('Feature is unavailable in this session');
        // Never echo an authentication token or errors returned by a credential-bearing transport.
        try { this.callbacks.onFeature(feature); }
        catch (error) {
          if (feature.type === 'admin-auth') throw new Error('Operator authentication could not be sent');
          throw error;
        }
        return;
      }
      if (command === 'say' || command === 'say_team') { this.sendChat(command === 'say' ? 'public' : 'team', args.join(' ')); return; }
      if (command === 'bind') {
        if (args.length !== 2 || !args[1] || args[1].length > 512 || /[\u0000-\u001f\u007f]/.test(args[1])) throw new Error('Usage: bind "key" "command"');
        const key = normalizeBinding(args[0]!);
        const rawTarget = args[1]!.replace(/^\//, '');
        const target = rawTarget.startsWith('+') ? rawTarget.toLowerCase() : rawTarget;
        const action = Object.hasOwn(GAMEPLAY_BIND_COMMANDS, target.toLowerCase()) ? GAMEPLAY_BIND_COMMANDS[target.toLowerCase()] : undefined;
        if (containsAdminCredential(target)) throw new Error('Operator authentication cannot be bound or saved');
        if (target.startsWith('+') && !action && !['+chat', '+teamchat', '+cmd', '+weapons', '+fragslist', '+statsmenu', '+recorddemo', '+radio', '+voicechat', '+matchcontrols'].includes(target.toLowerCase()))
          throw new Error(`Unavailable control action: ${target}`);
        if (!target.trim()) throw new Error('A bind command cannot be empty');
        if (action) this.change(assignGameplayBinding(this.settings, action, key));
        else {
          const bindings = { ...this.settings.bindings };
          for (const name of Object.keys(bindings) as ControlAction[]) if (bindings[name] === key) bindings[name] = '';
          const commandBindings = { ...this.settings.commandBindings }, taunts = { ...this.settings.taunts };
          delete taunts[key];
          commandBindings[key] = target;
          this.change({ ...this.settings, bindings, commandBindings, taunts });
        }
        this.notice(`Bound ${key} to ${target}`); return;
      }
      if (command === 'unbindall') {
        this.change({ ...this.settings, bindings: Object.fromEntries(Object.keys(this.settings.bindings).map(key => [key, ''])) as Record<ControlAction, string>, commandBindings: {}, taunts: {} });
        this.notice('Unbound all binds. Use /bind to restore controls.'); return;
      }
      if (command === 'taunt') {
        if (args.length !== 3 || (args[1] !== 'public' && args[1] !== 'team') || !validChatText(args[2]!)) throw new Error('Usage: taunt "Alt+key" <public|team> "text" (1–120 characters)');
        const key = normalizeBinding(args[0]!);
        const bindings = { ...this.settings.bindings }, commandBindings = { ...this.settings.commandBindings };
        for (const name of Object.keys(bindings) as ControlAction[]) if (bindings[name] === key) bindings[name] = '';
        delete commandBindings[key];
        this.change({ ...this.settings, bindings, commandBindings, taunts: { ...this.settings.taunts, [key]: { channel: args[1], text: args[2]! } } });
        this.notice(`Taunt saved for ${key}`); return;
      }
      if (command === 'mute' || command === 'unmute') {
        const target = args.join(' ').toLowerCase();
        if (!target) throw new Error(`Usage: ${command} <slot|name|all>`);
        const mute = command === 'mute';
        if (target === 'all') {
          this.muteAll = mute ? !this.muteAll : false;
          if (!mute) { this.mutedSlots.clear(); this.mutedNames.clear(); }
          this.notice(`Everyone is ${this.muteAll ? 'muted' : 'unmuted'}`);
        } else {
          const slot = /^\d+$/.test(target) ? Number(target) : undefined;
          const player = this.players.find(player => slot === undefined ? player.name?.toLowerCase() === target : player.slot === slot);
          if (!player?.name) throw new Error('Player not found (use a current slot or exact nickname)');
          const name = player.name.toLowerCase();
          if (slot !== undefined) { if (mute) this.mutedSlots.set(slot, name); else this.mutedSlots.delete(slot); }
          else if (mute) this.mutedNames.add(name); else this.mutedNames.delete(name);
          if (!mute) { this.mutedSlots.delete(player.slot); this.mutedNames.delete(name); }
          this.notice(`${player.name} is ${mute ? 'muted' : 'unmuted'}`);
        }
        if (this.muteAll) {
          for (let i = this.lines.length - 1; i >= 0; i--) if (this.lines[i]!.slot !== undefined) this.lines.splice(i, 1);
        } else if (mute) {
          for (let i = this.lines.length - 1; i >= 0; i--) {
            const line = this.lines[i]!;
            if (line.slot !== undefined && (this.mutedNames.has(line.nickname!) || this.mutedSlots.get(line.slot) === line.nickname)) this.lines.splice(i, 1);
          }
        }
        this.callbacks.onLocalMuteChange?.();
        return;
      }
      const boolean = Object.hasOwn(BOOLEAN_SETTINGS, command) ? BOOLEAN_SETTINGS[command] : undefined;
      if (boolean) {
        if (args.length === 0) { this.notice(`${command} = ${Number(this.settings[boolean])}`); return; }
        if (args.length !== 1 || !['0', '1', 'true', 'false'].includes(args[0]!.toLowerCase())) throw new Error(`${command} expects 0 or 1`);
        const value = ['1', 'true'].includes(args[0]!.toLowerCase());
        this.change({ ...this.settings, [boolean]: value }); this.notice(`${command} = ${Number(value)}`); return;
      }
      if (command === 'snd_volume' || command === 'r_texturefilter' || command === 'cl_player_name') {
        if (args.length === 0) { this.notice(`${command} = ${command === 'snd_volume' ? this.settings.volume * 100 : command === 'r_texturefilter' ? this.settings.filter === 'nearest' ? 1 : 2 : this.settings.nickname}`); return; }
        if (args.length !== 1) throw new Error(`${command} expects one value; quote names containing spaces`);
        const value = args[0]!;
        if (command === 'snd_volume') {
          if (!/^\d+$/.test(value) || Number(value) > 100) throw new Error('snd_volume expects 0–100');
          this.change({ ...this.settings, volume: Number(value) / 100 });
        } else if (command === 'r_texturefilter') {
          if (value !== '1' && value !== '2') throw new Error('r_texturefilter expects 1 (nearest) or 2 (linear)');
          this.change({ ...this.settings, filter: value === '1' ? 'nearest' : 'linear' });
        } else {
          if (!validNickname(value)) throw new Error('Name must contain 1–24 printable ASCII characters');
          this.change({ ...this.settings, nickname: value });
        }
        this.notice(`${command} = ${value}${command === 'cl_player_name' ? ' (used on next join)' : ''}`); return;
      }
      if (Object.hasOwn(CONTEXT_COMMANDS, command)) {
        if (!this.callbacks.onConsoleCommand) throw new Error(`${command} is unavailable in this session`);
        await this.callbacks.onConsoleCommand(command, args); return;
      }
      if (/^(record|stop|demo|playdemo|\+recorddemo)$/.test(command)) throw new Error('Demo recording and playback are unavailable');
      throw new Error(`Unknown or unavailable command: ${command}. Use /help.`);
    } catch (error) { this.notice(`Error: ${error instanceof Error ? error.message : String(error)}`, '#ff7777'); }
  }
}
