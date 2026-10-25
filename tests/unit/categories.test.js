import { describe, expect, it } from 'vitest';
import {
  CATEGORY_NAME_LIMIT,
  createCategory,
  normalizeCategoryName,
  restoreCategories,
  validateCategoryName,
} from '../../src/data/categoryModel.js';
import { categoriesReducer, categoryActions } from '../../src/state/categoriesReducer.js';
import { makeCategory } from '../helpers/fixtures.js';

describe('category names', () => {
  it('normalizes whitespace and length', () => {
    expect(normalizeCategoryName('  Work   items ')).toBe('Work items');
    expect(normalizeCategoryName('x'.repeat(100))).toHaveLength(CATEGORY_NAME_LIMIT);
  });

  it('rejects empty and duplicate names (case- and space-insensitive)', () => {
    const categories = [makeCategory({ id: 'c1', name: 'Работа' })];
    expect(validateCategoryName('', categories)).toBe('required');
    expect(validateCategoryName('   ', categories)).toBe('required');
    expect(validateCategoryName('  работа ', categories)).toBe('duplicate');
    expect(validateCategoryName('Дом', categories)).toBeNull();
  });

  it('allows renaming a category to its own name', () => {
    const categories = [makeCategory({ id: 'c1', name: 'Work' })];
    expect(validateCategoryName('WORK', categories, 'c1')).toBeNull();
  });
});

describe('createCategory and restoreCategories', () => {
  it('creates categories with unique stable ids', () => {
    const a = createCategory('A', 0);
    const b = createCategory('B', 1);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ name: 'A', order: 0 });
  });

  it('restores, sorts by order and renumbers; drops invalid entries', () => {
    const restored = restoreCategories([
      { id: 'b', name: 'B', order: 5, createdAt: 'x' },
      { id: 'a', name: ' A ', order: 1, createdAt: 'x' },
      { id: 'bad', name: '   ' },
      null,
    ]);
    expect(restored.map((category) => [category.id, category.name, category.order])).toEqual([
      ['a', 'A', 0],
      ['b', 'B', 1],
    ]);
  });

  it('treats missing data as an empty list', () => {
    expect(restoreCategories(null)).toEqual([]);
  });
});

describe('categoriesReducer', () => {
  it('creates, renames and deletes while keeping ids and contiguous order', () => {
    let state = categoriesReducer([], categoryActions.create('Work'));
    state = categoriesReducer(state, categoryActions.create('Home'));
    const [work, home] = state;
    expect(state.map((category) => category.order)).toEqual([0, 1]);

    state = categoriesReducer(state, categoryActions.rename(work.id, '  Office '));
    expect(state[0]).toMatchObject({ id: work.id, name: 'Office' });

    state = categoriesReducer(state, categoryActions.remove(work.id));
    expect(state).toEqual([{ ...home, order: 0 }]);
  });

  it('ignores unknown actions', () => {
    const state = [makeCategory()];
    expect(categoriesReducer(state, { type: 'x' })).toBe(state);
  });
});
