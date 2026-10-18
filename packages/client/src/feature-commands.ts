import type { AdminAction, FeatureClientMessage, GestureKind, VoteState } from '@soldat-web/protocol';

/** Conservative even for malformed/quoted binds: credentials must never enter retained text. */
export function containsAdminCredential(text: string): boolean {
  // The console permits quotes inside a word (ad"mi"n); discard quoting before classifying.
  return /(?:^|[\s/])admin(?:log|login)?(?:\s|$)/i.test(text.replace(/["\\]/g, ''));
}

function integer(value: string | undefined, name: string, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be ${min}–${max}`);
  return Number(value);
}
function one(args: readonly string[], usage: string): string {
  if (args.length !== 1 || !args[0]) throw new Error(`Usage: ${usage}`);
  return args[0];
}
function reason(args: readonly string[]): string {
  const value = args.join(' ');
  if (value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Reason must be at most 120 printable characters');
  return value;
}

/** Only typed protocol actions; no raw remote console or command evaluation. */
export function featureCommand(command: string, args: readonly string[], vote: VoteState | null): FeatureClientMessage | null {
  if (['smoke', 'tabac', 'takeoff', 'victory'].includes(command)) {
    if (args.length) throw new Error(`Usage: ${command}`);
    return { type: 'gesture', gesture: command as GestureKind };
  }
  if (command === 'kill' && !args.length) return { type: 'self-kill' };
  if (command === 'admin' || command === 'adminlog' || command === 'adminlogin') {
    if (args.length === 1 && args[0]?.toLowerCase() === 'logout') return { type: 'admin-logout' };
    const token = one(args[0]?.toLowerCase() === 'login' ? args.slice(1) : args, 'admin [login] <token> | admin logout');
    if (token.length > 256 || /[\u0000-\u0020\u007f]/.test(token)) throw new Error('Invalid operator token');
    return { type: 'admin-auth', token };
  }
  if (command === 'adminlogout') { if (args.length) throw new Error('Usage: adminlogout'); return { type: 'admin-logout' }; }
  if (command === 'vote' || command === 'votemap' || command === 'votekick') {
    const kind = command === 'votemap' ? 'map' : command === 'votekick' ? 'kick' : args[0]?.toLowerCase();
    const values = command === 'vote' ? args.slice(1) : args;
    if (kind === 'yes' || kind === 'no') {
      if (values.length || !vote || vote.phase !== 'active' || !vote.canVote || vote.myVote) throw new Error('No eligible, uncast vote');
      return { type: 'vote-cast', id: vote.id, choice: kind };
    }
    if (kind === 'map') return { type: 'vote-start', proposal: { kind: 'map', map: one(values, 'vote map <map>') } };
    if (kind === 'kick') {
      if (values.length < 2) throw new Error('Usage: vote kick <slot> <reason>');
      return { type: 'vote-start', proposal: { kind: 'kick', slot: integer(values[0], 'Slot', 1, 32), reason: reason(values.slice(1)) } };
    }
    throw new Error('Usage: vote map <map> | vote kick <slot> <reason> | vote yes | vote no');
  }
  if (command === 'radio') {
    if (args.length !== 2) throw new Error('Usage: radio <1..3> <1..3>');
    return { type: 'radio', category: integer(args[0], 'Category', 1, 3) as 1 | 2 | 3, direction: integer(args[1], 'Direction', 1, 3) as 1 | 2 | 3 };
  }
  let action: AdminAction;
  if (command === 'kick' || command === 'ban') {
    if (!args.length) throw new Error(`Usage: ${command} <slot>${command === 'ban' ? ' <minutes>' : ''} [reason]`);
    const slot = integer(args[0], 'Slot', 1, 32);
    action = command === 'ban' ? { kind: 'ban', slot, minutes: integer(args[1], 'Minutes', 1, 43200), reason: reason(args.slice(2)) }
      : { kind: 'kick', slot, reason: reason(args.slice(1)) };
  } else if (command === 'unban') action = { kind: 'unban', id: one(args, 'unban <ban id>') };
  else if (command === 'bans' || command === 'banlist') { if (args.length) throw new Error('Usage: bans'); action = { kind: 'bans' }; }
  else if (command === 'servermute' || command === 'serverunmute' || command === 'kill' || command === 'forcekill') {
    action = { kind: command === 'servermute' ? 'mute' : command === 'serverunmute' ? 'unmute' : 'kill', slot: integer(one(args, `${command} <slot>`), 'Slot', 1, 32) };
  } else if (command === 'setteam' || command === 'forceteam') {
    if (args.length !== 2) throw new Error(`Usage: ${command} <slot> <0..5>`);
    action = { kind: 'team', slot: integer(args[0], 'Slot', 1, 32), team: integer(args[1], 'Team', 0, 5) };
  } else if (command === 'map') action = { kind: 'map', map: one(args, 'map <map>') };
  else if (['nextmap', 'restart', 'pause', 'unpause'].includes(command)) {
    if (args.length) throw new Error(`Usage: ${command}`);
    action = { kind: command as 'nextmap' | 'restart' | 'pause' | 'unpause' };
  } else return null;
  return { type: 'admin-action', action };
}

export const RADIO_CATEGORIES = ['Enemy flagger', 'Friendly flagger', 'Enemy spotted'] as const;
export const RADIO_DIRECTIONS = ['up!', 'middle!', 'down!'] as const;
export function radioText(category: 1 | 2 | 3, direction: 1 | 2 | 3): string {
  return `${RADIO_CATEGORIES[category - 1]} ${RADIO_DIRECTIONS[direction - 1]}`;
}

/** Remaining time is a presentation estimate only; expiry and results remain server-owned. */
export function voteSecondsRemaining(remainingMs: number, receivedAt: number, now: number): number {
  return Math.max(0, Math.ceil((remainingMs - Math.max(0, now - receivedAt)) / 1000));
}
