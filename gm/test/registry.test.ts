import { describe, expect, it } from 'vitest';
import { CheckType } from '../src/api';
import { DEFAULT_CONTEXT_PRIVACY, SUGGESTED_REGISTRY } from '../src/views/Setup';
import { assignTypeHotkeys } from '../src/views/Table';

describe('session 2 suggested registry', () => {
  it('has the exact campaign order, labels, and routing flags', () => {
    expect(SUGGESTED_REGISTRY.map((type) => type.id)).toEqual([
      'cosmology-major', 'research-major', 'investigation-major',
      'rk-general', 'lore-roots', 'perception-secret', 'sense-motive',
      'decipher-identify', 'gather-information', 'secret-skill-other',
      'npc-secret', 'npc-public', 'world-routine', 'world-major', 'public-gm-check',
    ]);
    expect(SUGGESTED_REGISTRY.map((type) => type.label)).toEqual([
      'Major cosmology inquiry', 'Major research check', 'Major investigation check',
      'Recall Knowledge', 'Recall Knowledge — roots Lore', 'Secret Perception', 'Sense Motive',
      'Decipher / Identify', 'Gather Information', 'Other secret skill check',
      'NPC secret check', 'NPC check the table watched', 'World — routine', 'World — major',
      'Public GM check',
    ]);
    expect(SUGGESTED_REGISTRY).toHaveLength(15);
    for (const type of SUGGESTED_REGISTRY.slice(0, 10)) {
      expect(type).toMatchObject({ lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false });
    }
    expect(SUGGESTED_REGISTRY.filter((type) => type.ritual).map((type) => type.id))
      .toEqual(['cosmology-major', 'research-major', 'investigation-major', 'world-major']);
    expect(SUGGESTED_REGISTRY.find((type) => type.id === 'npc-secret'))
      .toMatchObject({ lane: 'deep', roles: ['npc'], seal_dc: true, seal_modifier: true });
    expect(SUGGESTED_REGISTRY.find((type) => type.id === 'npc-public'))
      .toMatchObject({ lane: 'open', roles: ['npc'], seal_dc: false, seal_modifier: true });
    expect(SUGGESTED_REGISTRY.find((type) => type.id === 'public-gm-check'))
      .toMatchObject({ lane: 'open', roles: ['player', 'npc', 'world'], seal_dc: false, seal_modifier: false });
    expect(DEFAULT_CONTEXT_PRIVACY).toBe('sealed');
  });

  it('keeps the first-free-letter hotkeys stable for every role', () => {
    const keysFor = (role: string) => Object.fromEntries(assignTypeHotkeys(
      SUGGESTED_REGISTRY.filter((type) => type.roles.includes(role)) as CheckType[],
    ).map((type) => [type.id, type.key]));
    expect(keysFor('player')).toEqual({
      'cosmology-major': 'c', 'research-major': 'r', 'investigation-major': 'i',
      'rk-general': 'k', 'lore-roots': 'l', 'perception-secret': 'p',
      'sense-motive': 's', 'decipher-identify': 'e', 'gather-information': 'g',
      'secret-skill-other': 't', 'public-gm-check': 'u',
    });
    expect(keysFor('npc')).toEqual({ 'npc-secret': 'n', 'npc-public': 'p', 'public-gm-check': 'u' });
    expect(keysFor('world')).toEqual({ 'world-routine': 'w', 'world-major': 'o', 'public-gm-check': 'p' });
  });
});
