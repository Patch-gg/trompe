import { describe, expect, it } from 'vitest';
import { classifyView, describeView, roofLabels } from '../src/core/semantics';
import { prompts, type PromptContext } from '../src/providers/models';

// 4x4 view: top row sky, then a roof row, then two wall rows (label 1) with a ground pixel (label 0)
const S = 4;
const LABELS = ['cobblestone ground', 'house walls', 'tiled roof'];
const nrm = new Float32Array(S * S * 4);
const pos = new Float32Array(S * S * 4);
const set = (i: number, n: [number, number, number], label: number, y: number) => {
  nrm.set([...n, label + 1], 4 * i);
  pos.set([0, y, 0, 5], 4 * i);
};
for (let x = 0; x < S; x++) set(S + x, [0, 0.8, 0.6], 2, 9);
for (let i = 2 * S; i < S * S; i++) set(i, [0, 0, 1], 1, 2);
set(S * S - 1, [0, 1, 0], 0, 0);

describe('semantics', () => {
  it('finds roofs by label, else by slope and height', () => {
    expect(roofLabels(LABELS)).toEqual([false, false, true]);
    expect(roofLabels(['clay'])).toBeNull();
    const c = classifyView(nrm, pos, LABELS, 0);
    expect(Array.from(c.roof)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, ...Array(8).fill(0)]);
    expect(c.floor[S * S - 1]).toBe(1);
    expect(c.label[0]).toBe(-1);
    const u = classifyView(nrm, pos, ['clay', 'clay2', 'clay3'].map(() => 'clay'), 0);
    expect(u.roof[S]).toBe(1);   // unlabelled: sloped and 9 m up
  });

  it('lists the parts in the area, biggest first, with positions', () => {
    const c = classifyView(nrm, pos, LABELS, 0);
    const d = describeView(c, LABELS, S);
    expect(d.parts.split(', ')[0]).toMatch(/^house walls/);
    expect(d.parts).toContain('tiled roof (');
    expect(d.roofShare).toBeCloseTo(4 / 12);
    expect(describeView(c, ['clay'], S).parts).toBe('');
  });
});

describe('prompts', () => {
  const base: PromptContext = { look: 'a village: limestone walls', roofLook: 'terracotta tiles', parts: '', mode: 'fill', floor: false };
  it('forbids additions unless the level models them', () => {
    const p = prompts.instruction({ ...base, parts: 'house walls (left), wooden market stall (center), wooden crates (bottom)' });
    expect(p).toContain('no awnings');
    expect(p).not.toMatch(/market stalls,|crates,/);
    expect(prompts.instruction(base)).toMatch(/market stalls, .*crates/);
  });
  it('asks roof passes for roofs only', () => {
    expect(prompts.instruction({ ...base, mode: 'roof' })).toMatch(/^Paint the masked roof surfaces as terracotta tiles/);
    expect(prompts.caption({ ...base, mode: 'first' })).toMatch(/^A photorealistic photo of a village/);
  });
});
