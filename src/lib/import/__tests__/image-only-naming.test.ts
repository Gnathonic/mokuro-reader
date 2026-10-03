import { describe, expect, it } from 'vitest';
import { planImageOnlyNames } from '../image-only-naming';

const pairing = (id: string, basePath: string, titlePath?: string) => ({ id, basePath, titlePath });

describe('planImageOnlyNames (#285)', () => {
  const batch = [
    pairing('c10', 'Chained Soldier (Semi-Color)/10'),
    pairing('c2', 'Chained Soldier (Semi-Color)/2'),
    pairing('c1', 'Chained Soldier (Semi-Color)/01'),
    pairing('k1', 'Killing Bites/Killing Bites 01')
  ];

  it('cleaned: the series folder name, numbered in natural folder order', () => {
    const plan = planImageOnlyNames(batch);
    expect(plan.cleaned.get('c1')?.volume).toBe('Chained Soldier (Semi-Color) 01');
    expect(plan.cleaned.get('c2')?.volume).toBe('Chained Soldier (Semi-Color) 02');
    expect(plan.cleaned.get('c10')?.volume).toBe('Chained Soldier (Semi-Color) 03');
    expect(plan.cleaned.get('k1')).toMatchObject({
      series: 'Killing Bites',
      volume: 'Killing Bites 01'
    });
  });

  it('folder: the literal folder names', () => {
    const plan = planImageOnlyNames(batch);
    expect(plan.folder.get('c10')).toMatchObject({
      series: 'Chained Soldier (Semi-Color)',
      volume: '10'
    });
    expect(plan.folder.get('k1')).toMatchObject({
      series: 'Killing Bites',
      volume: 'Killing Bites 01'
    });
  });

  it('keys identity to the literal location, the same in both modes', () => {
    const plan = planImageOnlyNames(batch);
    for (const id of ['c1', 'c2', 'c10', 'k1']) {
      expect(plan.cleaned.get(id)?.identity).toBe(plan.folder.get(id)?.identity);
    }
    expect(plan.cleaned.get('c10')?.identity).toBe('Chained Soldier (Semi-Color)/10');
  });

  it('continues numbering after the volumes the series already has', () => {
    const plan = planImageOnlyNames(
      [
        pairing('a', 'Chained Soldier (Semi-Color)/21'),
        pairing('b', 'Chained Soldier (Semi-Color)/22')
      ],
      new Map([['Chained Soldier (Semi-Color)', 20]])
    );
    expect(plan.cleaned.get('a')?.volume).toBe('Chained Soldier (Semi-Color) 21');
    expect(plan.cleaned.get('b')?.volume).toBe('Chained Soldier (Semi-Color) 22');
  });

  it('pads to the width of the largest number, never below two digits', () => {
    const many = Array.from({ length: 120 }, (_, i) => pairing(`p${i}`, `Big/${i + 1}`));
    const plan = planImageOnlyNames(many);
    expect(plan.cleaned.get('p0')?.volume).toBe('Big 001');
    expect(plan.cleaned.get('p119')?.volume).toBe('Big 120');
  });

  it('a root-level volume: cleaned series by extraction, folder series by its own name', () => {
    const plan = planImageOnlyNames([pairing('g', 'Gleipnir v01 (2023) (Digital)')]);
    expect(plan.cleaned.get('g')).toMatchObject({ series: 'Gleipnir', volume: 'Gleipnir 01' });
    expect(plan.folder.get('g')).toMatchObject({
      series: 'Gleipnir v01 (2023) (Digital)',
      volume: 'Gleipnir v01 (2023) (Digital)'
    });
  });

  it('names an archive by where it sat (titlePath) over its inside path', () => {
    const plan = planImageOnlyNames([pairing('v', 'Vol 1', 'Pack/Vol 1')]);
    expect(plan.folder.get('v')).toMatchObject({ series: 'Pack', volume: 'Vol 1' });
    expect(plan.cleaned.get('v')).toMatchObject({ series: 'Pack', volume: 'Pack 01' });
  });

  it('previews both modes grouped by series, as stored (sanitized), natural order', () => {
    const plan = planImageOnlyNames([...batch, pairing('r', 'Re: Zero?/Vol 1.')]);
    expect(plan.preview.cleaned).toEqual([
      {
        seriesName: 'Chained Soldier (Semi-Color)',
        volumeCount: 3,
        volumeNames: [
          'Chained Soldier (Semi-Color) 01',
          'Chained Soldier (Semi-Color) 02',
          'Chained Soldier (Semi-Color) 03'
        ]
      },
      { seriesName: 'Killing Bites', volumeCount: 1, volumeNames: ['Killing Bites 01'] },
      { seriesName: 'Re： Zero？', volumeCount: 1, volumeNames: ['Re： Zero？ 01'] }
    ]);
    expect(plan.preview.folder.map((s) => s.volumeNames)).toEqual([
      ['01', '2', '10'],
      ['Killing Bites 01'],
      ['Vol 1․']
    ]);
  });
});
