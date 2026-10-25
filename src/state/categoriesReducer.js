// In-memory category list, kept sorted by `order` (contiguous 0..n-1).
import { createCategory, normalizeCategoryName } from '../data/categoryModel.js';

export const categoryActions = {
  create: (name) => ({ type: 'category/created', name }),
  rename: (id, name) => ({ type: 'category/renamed', id, name }),
  remove: (id) => ({ type: 'category/deleted', id }),
  /** Adds ready-made categories (created for a confirmed assistant plan, with their ids). */
  add: (categories) => ({ type: 'categories/added', categories }),
  /** Removes categories by id (undo of an assistant plan). */
  removeMany: (ids) => ({ type: 'categories/removed', ids }),
};

export function categoriesReducer(state, action) {
  switch (action.type) {
    case 'category/created':
      return [...state, createCategory(action.name, state.length)];
    case 'category/renamed':
      return state.map((category) =>
        category.id === action.id ? { ...category, name: normalizeCategoryName(action.name) } : category,
      );
    case 'category/deleted':
      return state.filter((category) => category.id !== action.id).map((category, order) => ({ ...category, order }));
    case 'categories/added':
      return [...state, ...action.categories.filter((category) => !state.some((item) => item.id === category.id))].map((category, order) => ({ ...category, order }));
    case 'categories/removed': {
      const ids = new Set(action.ids);
      return state.filter((category) => !ids.has(category.id)).map((category, order) => ({ ...category, order }));
    }
    default:
      return state;
  }
}
