import { expect, test } from 'bun:test';
import { DEFAULT_APPEARANCE, GAME_MODES, PROTOCOL_VERSION, ProtocolError, decodeMessage, encodeMessage, normalizeMatchRules, teamCount, validateAppearance, validateTeam } from '../src/index.ts';

test('seven original mode IDs and team domains round-trip without coercion', () => {
  for (const [id, mode] of GAME_MODES.entries()) {
    const bytes = encodeMessage({ type: 'lobby-update', mode });
    expect(bytes[9]).toBe(id); expect(decodeMessage(bytes)).toEqual({ type: 'lobby-update', mode });
    expect(() => validateTeam(5, mode)).not.toThrow();
    if (!teamCount(mode)) {
      expect(() => validateTeam(0, mode)).not.toThrow(); expect(() => validateTeam(1, mode)).toThrow(ProtocolError);
    } else {
      for (let team = 1; team <= teamCount(mode); team++) expect(() => validateTeam(team, mode)).not.toThrow();
      expect(() => validateTeam(0, mode)).toThrow(ProtocolError);
      expect(() => validateTeam(teamCount(mode) === 4 ? 6 : 3, mode)).toThrow(ProtocolError);
    }
  }
});

test('rules validate every field before returning an owned enabled-weapon list', () => {
  const supplied = { weapons: [1, 4, 11], mode: 'inf', realistic: true };
  const before = structuredClone(supplied), rules = normalizeMatchRules(supplied);
  rules.weapons.push(12); expect(supplied).toEqual(before);
  for (const value of [null, [], true, { mode: 'ctf2' }, { realistic: 1 }, { survival: null }, { advanceAmount: 0 }, { advanceAmount: 10000 }, { bonusFrequency: 6 }, { scoreLimit: 10000 }, { timeLimitTicks: Infinity }, { scoreLimit: 1.5 }, { weapons: [1, 1] }, { weapons: [14] }, { weapons: ['4'] }, { chat: true }, JSON.parse('{"__proto__":true}')]) {
    expect(() => normalizeMatchRules(value)).toThrow(ProtocolError);
  }
  expect(normalizeMatchRules({ weapons: [], timeLimitTicks: 0, scoreLimit: 0 }).weapons).toEqual([]);
});

test('appearance and team controls reject malformed wire values before application', () => {
  for (const appearance of [{ ...DEFAULT_APPEARANCE, shirtColor: -1 }, { ...DEFAULT_APPEARANCE, jetColor: 0x1000000 }, { ...DEFAULT_APPEARANCE, hairStyle: 5 }, { ...DEFAULT_APPEARANCE, headStyle: 3 }, { ...DEFAULT_APPEARANCE, chainStyle: NaN }, { ...DEFAULT_APPEARANCE, extra: true }]) {
    expect(() => validateAppearance(appearance)).toThrow(ProtocolError);
  }
  const appearance = encodeMessage({ type: 'appearance', appearance: { ...DEFAULT_APPEARANCE } });
  appearance[28] = 5; expect(() => decodeMessage(appearance)).toThrow(ProtocolError);
  const team = encodeMessage({ type: 'team-change', team: 0 }); team[8] = 6;
  expect(() => decodeMessage(team)).toThrow(ProtocolError);
  for (const mapRotation of [[], ['Arena', 'Arena'], Array.from({ length: 33 }, (_, i) => String(i))]) expect(() => encodeMessage({ type: 'lobby-update', mapRotation })).toThrow(ProtocolError);
});

test('untrusted rule JSON is validated after binary framing', () => {
  for (const text of ['{"realistic":0}', '{"weapons":[1,1]}', '{"mode":"unknown"}', '{"scoreLimit":1e100}', '{"cheat":true}']) {
    const json = new TextEncoder().encode(text), packet = new Uint8Array(11 + json.length), view = new DataView(packet.buffer);
    view.setUint16(0, PROTOCOL_VERSION, true); packet[2] = 15;
    view.setUint32(4, 3 + json.length, true); packet[8] = 8; view.setUint16(9, json.length, true); packet.set(json, 11);
    expect(() => decodeMessage(packet)).toThrow(ProtocolError);
  }
});
