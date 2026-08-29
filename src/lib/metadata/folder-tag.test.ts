import { describe, expect, it } from 'vitest';
import { splitFolderTag } from './folder-tag';

describe('splitFolderTag', () => {
  it('splits a trailing (tag) off the folder name', () => {
    expect(splitFolderTag('One Piece (color)')).toEqual({ base: 'One Piece', tag: 'color' });
  });

  it('splits a trailing [tag]', () => {
    expect(splitFolderTag('One Piece [bw]')).toEqual({ base: 'One Piece', tag: 'bw' });
  });

  it('accepts fullwidth brackets', () => {
    expect(splitFolderTag('ワンピース（カラー）')).toEqual({ base: 'ワンピース', tag: 'カラー' });
    expect(splitFolderTag('ワンピース【新装版】')).toEqual({ base: 'ワンピース', tag: '新装版' });
  });

  it('joins several trailing groups into one tag, in order', () => {
    expect(splitFolderTag('One Piece [color] (webp)')).toEqual({
      base: 'One Piece',
      tag: 'color webp'
    });
  });

  it('leaves a name with no trailing group alone', () => {
    expect(splitFolderTag('One Piece')).toEqual({ base: 'One Piece', tag: undefined });
    expect(splitFolderTag('(Group) One Piece')).toEqual({
      base: '(Group) One Piece',
      tag: undefined
    });
  });

  it('never returns an empty base — a name that is only a bracket group is kept whole', () => {
    expect(splitFolderTag('[color]')).toEqual({ base: '[color]', tag: undefined });
    expect(splitFolderTag('   ')).toEqual({ base: '', tag: undefined });
  });

  it('ignores an empty group and trims what it keeps', () => {
    expect(splitFolderTag('One Piece ()')).toEqual({ base: 'One Piece ()', tag: undefined });
    expect(splitFolderTag('  One Piece  ( color ) ')).toEqual({ base: 'One Piece', tag: 'color' });
  });

  it('does not treat an unbalanced or nested closing bracket as a group', () => {
    expect(splitFolderTag('One Piece color)')).toEqual({
      base: 'One Piece color)',
      tag: undefined
    });
    expect(splitFolderTag("Fate/stay night (Heaven's Feel)")).toEqual({
      base: 'Fate/stay night',
      tag: "Heaven's Feel"
    });
  });
});
