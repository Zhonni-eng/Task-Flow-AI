// Category data model. Categories group tasks independently of status and labels.
//
// Category = { id: string, name: string, order: number, createdAt: ISO string }
// A task's categoryId of null means "uncategorized".

export const CATEGORY_NAME_LIMIT = 60;

function generateId() {
  if (globalThis.crypto?.randomUUID) return `cat-${globalThis.crypto.randomUUID()}`;
  return `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeCategoryName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, CATEGORY_NAME_LIMIT).trimEnd();
}

/** Returns an error code ('required' | 'duplicate') or null when the name is valid. */
export function validateCategoryName(name, categories, excludeId = null) {
  const normalized = normalizeCategoryName(name);
  if (!normalized) return 'required';
  const key = normalized.toLocaleLowerCase();
  if (categories.some((category) => category.id !== excludeId && category.name.toLocaleLowerCase() === key)) {
    return 'duplicate';
  }
  return null;
}

export function createCategory(name, order) {
  return { id: generateId(), name: normalizeCategoryName(name), order, createdAt: new Date().toISOString() };
}

export function restoreCategories(raw) {
  return (raw ?? [])
    .filter((category) => category && typeof category.id === 'string' && normalizeCategoryName(category.name))
    .map((category, index) => ({
      id: category.id,
      name: normalizeCategoryName(category.name),
      order: Number.isFinite(category.order) ? category.order : index,
      createdAt: typeof category.createdAt === 'string' ? category.createdAt : new Date(0).toISOString(),
    }))
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .map((category, index) => ({ ...category, order: index }));
}
