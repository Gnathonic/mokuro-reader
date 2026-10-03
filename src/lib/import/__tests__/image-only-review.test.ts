import { describe, expect, it } from 'vitest';
import {
  defaultNaming,
  groupCandidates,
  nameGroup,
  type ReviewCandidate
} from '../image-only-review';
import { storedTitle } from '../image-only-naming';
import { generateDeterministicUUID } from '$lib/util/series-extraction';

const candidate = (id: string, basePath: string, titlePath?: string): ReviewCandidate => ({
  id,
  basePath,
  titlePath,
  source: titlePath ?? basePath
});

const summary = (candidates: ReviewCandidate[]) =>
  groupCandidates(candidates).map((g) => ({
    series: g.series,
    ids: g.candidates.map((c) => c.id)
  }));

describe('groupCandidates (#285)', () => {
  it('groups volumes that have a parent folder by that folder, literally', () => {
    expect(
      summary([
        candidate('k1', 'Killing Bites/Killing Bites 01'),
        candidate('c2', 'Chained Soldier (Semi-Color)/02'),
        candidate('c1', 'Chained Soldier (Semi-Color)/01')
      ])
    ).toEqual([
      { series: 'Chained Soldier (Semi-Color)', ids: ['c1', 'c2'] },
      { series: 'Killing Bites', ids: ['k1'] }
    ]);
  });

  it('groups loose archives by the series their names carry', () => {
    expect(summary(['v10', 'v02', 'v01'].map((v) => candidate(v, `Killing Bites ${v}`)))).toEqual([
      { series: 'Killing Bites', ids: ['v01', 'v02', 'v10'] }
    ]);
  });

  it('keeps an archive of volume folders as one series, named after the archive', () => {
    expect(
      summary([
        candidate('a', 'v01 extra', 'Series Pack [Digital]/v01 extra'),
        candidate('b', 'v02 extra', 'Series Pack [Digital]/v02 extra')
      ])
    ).toEqual([{ series: 'Series Pack [Digital]', ids: ['a', 'b'] }]);
  });

  it('puts a loose volume and a series folder of the same name in one step', () => {
    expect(
      summary([
        candidate('l', 'Killing Bites v05'),
        candidate('f', 'Killing Bites/Killing Bites 01')
      ])
    ).toEqual([{ series: 'Killing Bites', ids: ['f', 'l'] }]);
  });

  it('keeps different series apart and orders them by name', () => {
    expect(
      summary([
        candidate('d', 'Dorohedoro 05'),
        candidate('b', 'Berserk v01'),
        candidate('x', 'Chained Soldier (Semi-Color)/01')
      ]).map((g) => g.series)
    ).toEqual(['Berserk', 'Chained Soldier (Semi-Color)', 'Dorohedoro']);
  });

  it('orders volumes naturally by their literal names', () => {
    const [group] = groupCandidates(['10', '2', '01'].map((v) => candidate(v, `Big/${v}`)));
    expect(group.candidates.map((c) => c.id)).toEqual(['01', '2', '10']);
  });

  it('knows the uuids its volumes will be saved under, and starts with no existing count', () => {
    const [group] = groupCandidates([candidate('a', 'Chained Soldier (Semi-Color)/01')]);
    expect(group.ownUuids).toEqual([generateDeterministicUUID('Chained Soldier (Semi-Color)/01')]);
    expect(group.existingCount).toBe(0);
  });
});

describe('nameGroup (#285)', () => {
  const chained = () =>
    groupCandidates([
      candidate('c10', 'Chained Soldier (Semi-Color)/10'),
      candidate('c2', 'Chained Soldier (Semi-Color)/2'),
      candidate('c1', 'Chained Soldier (Semi-Color)/01')
    ])[0];
  const ids = ['c1', 'c2', 'c10'];
  const volumes = (names: Map<string, { volume: string }>) =>
    ids.map((id) => names.get(id)?.volume);

  it('cleaned: the series name, numbered from the start in natural folder order', () => {
    const g = chained();
    expect(volumes(nameGroup(g, defaultNaming(g, 'cleaned')))).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Chained Soldier (Semi-Color) 02',
      'Chained Soldier (Semi-Color) 03'
    ]);
  });

  it('cleaned: starts after the volumes the series already has', () => {
    const g = { ...chained(), existingCount: 20 };
    expect(volumes(nameGroup(g, defaultNaming(g, 'cleaned')))).toEqual([
      'Chained Soldier (Semi-Color) 21',
      'Chained Soldier (Semi-Color) 22',
      'Chained Soldier (Semi-Color) 23'
    ]);
  });

  it('pads to the widest number, never below two digits', () => {
    const [g] = groupCandidates(
      Array.from({ length: 120 }, (_, i) => candidate(`p${i}`, `Big/${i + 1}`))
    );
    const names = nameGroup(g, defaultNaming(g, 'cleaned'));
    expect(names.get('p0')?.volume).toBe('Big 001');
    expect(names.get('p119')?.volume).toBe('Big 120');
    const late = nameGroup(g, { ...defaultNaming(g, 'cleaned'), start: 990 });
    expect(late.get('p0')?.volume).toBe('Big 0990');
  });

  it('an invalid start number counts from 1', () => {
    const g = chained();
    for (const start of [0, -3, Number.NaN, 2.5]) {
      expect(nameGroup(g, { ...defaultNaming(g, 'cleaned'), start }).get('c1')?.volume).toBe(
        'Chained Soldier (Semi-Color) 01'
      );
    }
  });

  it("folder: each volume's literal name under the step's series", () => {
    const g = chained();
    const names = nameGroup(g, defaultNaming(g, 'folder'));
    expect(volumes(names)).toEqual(['01', '2', '10']);
    expect(names.get('c1')?.series).toBe('Chained Soldier (Semi-Color)');
  });

  it('takes the series typed in the step for every volume; blank keeps the group series', () => {
    const g = chained();
    const typed = nameGroup(g, { ...defaultNaming(g, 'cleaned'), series: '  Chained Soldier ' });
    expect(volumes(typed)).toEqual([
      'Chained Soldier 01',
      'Chained Soldier 02',
      'Chained Soldier 03'
    ]);
    expect([...typed.values()].every((n) => n.series === 'Chained Soldier')).toBe(true);
    const blank = nameGroup(g, { ...defaultNaming(g, 'cleaned'), series: '   ' });
    expect(blank.get('c1')?.series).toBe('Chained Soldier (Semi-Color)');
  });

  it('a renamed volume keeps its name in both modes; a blank rename is no rename', () => {
    const g = chained();
    const overrides = { c2: 'Extra', c10: '   ' };
    expect(volumes(nameGroup(g, { ...defaultNaming(g, 'cleaned'), overrides }))).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Extra',
      'Chained Soldier (Semi-Color) 03'
    ]);
    expect(volumes(nameGroup(g, { ...defaultNaming(g, 'folder'), overrides }))).toEqual([
      '01',
      'Extra',
      '10'
    ]);
  });

  it('keeps identity on the literal location, whatever the step chose', () => {
    const g = chained();
    const a = nameGroup(g, defaultNaming(g, 'cleaned'));
    const b = nameGroup(g, {
      series: 'Other',
      mode: 'folder',
      start: 7,
      overrides: { c1: 'Renamed' }
    });
    for (const id of ids) expect(a.get(id)?.identity).toBe(b.get(id)?.identity);
    expect(a.get('c10')?.identity).toBe('Chained Soldier (Semi-Color)/10');
  });

  it('a loose volume: identity is its own name, the series is the extracted one in both modes', () => {
    const [g] = groupCandidates([candidate('g', 'Gleipnir v01 (2023) (Digital)')]);
    expect(nameGroup(g, defaultNaming(g, 'cleaned')).get('g')).toEqual({
      series: 'Gleipnir',
      volume: 'Gleipnir 01',
      identity: 'Gleipnir v01 (2023) (Digital)'
    });
    expect(nameGroup(g, defaultNaming(g, 'folder')).get('g')).toEqual({
      series: 'Gleipnir',
      volume: 'Gleipnir v01 (2023) (Digital)',
      identity: 'Gleipnir v01 (2023) (Digital)'
    });
  });

  it('names an archive volume by where the archive sat (titlePath)', () => {
    const [g] = groupCandidates([candidate('v', 'Vol 1', 'Pack/Vol 1')]);
    expect(nameGroup(g, defaultNaming(g, 'folder')).get('v')).toMatchObject({
      series: 'Pack',
      volume: 'Vol 1'
    });
    expect(nameGroup(g, defaultNaming(g, 'cleaned')).get('v')).toMatchObject({
      series: 'Pack',
      volume: 'Pack 01'
    });
  });

  it('stores names in their sanitized form, as saveVolume will', () => {
    const [g] = groupCandidates([candidate('r', 'Re: Zero?/Vol 1.')]);
    const folder = nameGroup(g, defaultNaming(g, 'folder')).get('r')!;
    expect([storedTitle(folder.series), storedTitle(folder.volume)]).toEqual([
      'Re： Zero？',
      'Vol 1․'
    ]);
    expect(storedTitle(nameGroup(g, defaultNaming(g, 'cleaned')).get('r')!.volume)).toBe(
      'Re： Zero？ 01'
    );
  });
});
