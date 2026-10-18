import { bindingMatches, type BindingEvent } from './bindings';

export interface Taunt { channel: 'public' | 'team'; text: string }

/** Text taunts from pinned base/client/configs/bindings.cfg. Alt+1..4 are native gestures, not chat. */
const ORIGINAL_TAUNTS: Record<string, string> = {
  '0': 'Stick around!', '5': 'What the hell are you?', '6': 'If it bleeds, we can kill it',
  '7': "I'm gonna have me some fun!", '8': 'Bleed, bastard.', '9': 'Medic!',
  A: 'Die!', B: 'Son of a bitch!', C: "It's over Johnny", D: 'Anytime...', E: 'No!', F: 'Yes, Sir!',
  G: "I'll be back!", H: 'Get the flag!', I: 'OK', J: 'Help!', K: 'Sniper!',
  L: 'Heavy Machine Gun ahead!', M: 'Take Cover!', N: 'I need backup!', O: 'Follow me!',
  P: 'Kiss the ground soldier!', Q: 'On your feet soldier!', R: 'Come on!', S: 'Yeah',
  T: 'Return the flag!', U: 'Hurraaaa!!!', V: 'I am the law!', W: 'Engage at will!!!',
  X: "I ain't got time to bleed!", Y: "You're one ugly mother fu**er!", Z: 'Got it!',
};
export const DEFAULT_TAUNTS: Readonly<Record<string, Taunt>> = Object.fromEntries(
  Object.entries(ORIGINAL_TAUNTS).map(([key, text]) => [`Alt+${/^\d$/.test(key) ? 'Digit' : 'Key'}${key}`, { channel: 'public', text }]),
);
export const TAUNT_KEYS = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(key => `Alt+${/^\d$/.test(key) ? 'Digit' : 'Key'}${key}`);

export function cloneTaunts(taunts: Readonly<Record<string, Taunt>>): Record<string, Taunt> {
  return Object.fromEntries(Object.entries(taunts).map(([key, taunt]) => [key, { ...taunt }]));
}

export function validChatText(text: string): boolean {
  return text.trim().length > 0 && text.length <= 120 && !/[\u0000-\u001f\u007f]/.test(text);
}

/** Shared input boundary: modifiers must match exactly; held/repeated keys never resend taunts. */
export function tauntForKey(
  taunts: Readonly<Record<string, Taunt>>, event: BindingEvent & { repeat?: boolean; isComposing?: boolean },
  context: { paused: boolean; editing: boolean; overlay: boolean },
): Taunt | undefined {
  if (context.paused || context.editing || context.overlay || event.repeat || event.isComposing) return undefined;
  const key = Object.keys(taunts).find(key => bindingMatches(key, event));
  return key === undefined ? undefined : taunts[key];
}
