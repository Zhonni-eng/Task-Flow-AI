import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  LIMITS,
  createTask,
  normalizeLabels,
  restoreTask,
  splitLabels,
  toFormValues,
  updateTask,
  validateTaskFields,
} from '../../src/data/taskModel.js';

describe('createTask', () => {
  it('applies sensible defaults', () => {
    const task = createTask({ title: 'Plan' });
    expect(task).toMatchObject({
      title: 'Plan',
      description: '',
      priority: DEFAULT_PRIORITY,
      dueDate: null,
      labels: [],
      status: DEFAULT_STATUS,
      categoryId: null,
      order: 0,
    });
    expect(task.id).toEqual(expect.any(String));
    expect(task.createdAt).toBe(task.updatedAt);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createTask({ title: 'x' }).id));
    expect(ids.size).toBe(50);
  });

  it('trims text and enforces length limits', () => {
    const task = createTask({ title: `  ${'a'.repeat(200)}  `, description: `  ${'d'.repeat(3000)} ` });
    expect(task.title).toHaveLength(LIMITS.title);
    expect(task.description).toHaveLength(LIMITS.description);
  });

  it('replaces invalid enum values and dates with defaults', () => {
    const task = createTask({ title: 'x', priority: 'urgent', status: 'archived', dueDate: '2026-02-30' });
    expect(task.priority).toBe('medium');
    expect(task.status).toBe('todo');
    expect(task.dueDate).toBeNull();
  });

  it('keeps a valid due date and category', () => {
    const task = createTask({ title: 'x', dueDate: '2026-11-15', categoryId: 'cat-1' });
    expect(task.dueDate).toBe('2026-11-15');
    expect(task.categoryId).toBe('cat-1');
  });

  it('treats an empty category id as uncategorized', () => {
    expect(createTask({ title: 'x', categoryId: '' }).categoryId).toBeNull();
  });
});

describe('labels', () => {
  it('splits comma-separated input', () => {
    expect(splitLabels('a, b,c')).toEqual(['a', ' b', 'c']);
  });

  it('trims, collapses whitespace and removes case-insensitive duplicates', () => {
    expect(normalizeLabels(['  Work ', 'work', 'Home  office', '', '   '])).toEqual(['Work', 'Home office']);
  });

  it('enforces per-label length and the label count limit', () => {
    const many = Array.from({ length: 15 }, (_, i) => `label-${i}`);
    expect(normalizeLabels(many)).toHaveLength(LIMITS.labels);
    expect(normalizeLabels(['x'.repeat(50)])[0]).toHaveLength(LIMITS.label);
  });

  it('handles Cyrillic labels case-insensitively', () => {
    expect(normalizeLabels(['Дизайн', 'ДИЗАЙН', 'дизайн'])).toEqual(['Дизайн']);
  });
});

describe('validateTaskFields', () => {
  it('requires a non-blank title', () => {
    expect(validateTaskFields({ title: '' })).toEqual({ title: 'titleRequired' });
    expect(validateTaskFields({ title: '   ' })).toEqual({ title: 'titleRequired' });
    expect(validateTaskFields({})).toEqual({ title: 'titleRequired' });
  });

  it('accepts a valid title', () => {
    expect(validateTaskFields({ title: 'Ok' })).toEqual({});
  });
});

describe('updateTask', () => {
  const base = createTask({ title: 'Base', labels: ['a'], status: 'inProgress' });

  it('keeps id, order and createdAt; normalizes changes', () => {
    const updated = updateTask({ ...base, order: 4 }, { title: '  New ', labels: ['b', 'B'] });
    expect(updated.id).toBe(base.id);
    expect(updated.order).toBe(4);
    expect(updated.createdAt).toBe(base.createdAt);
    expect(updated.title).toBe('New');
    expect(updated.labels).toEqual(['b']);
    expect(updated.status).toBe('inProgress');
  });

  it('ignores fields that are not editable', () => {
    const updated = updateTask(base, { id: 'hacked', order: 99, createdAt: 'x' });
    expect(updated.id).toBe(base.id);
    expect(updated.order).toBe(base.order);
    expect(updated.createdAt).toBe(base.createdAt);
  });
});

describe('restoreTask and toFormValues', () => {
  it('restores saved data and preserves order and timestamps', () => {
    const raw = { id: 7, title: 'T', priority: 'high', status: 'done', order: 3, createdAt: 'c', updatedAt: 'u', labels: ['x'] };
    expect(restoreTask(raw)).toMatchObject({ id: '7', title: 'T', priority: 'high', status: 'done', order: 3, createdAt: 'c', updatedAt: 'u' });
  });

  it('falls back to epoch timestamps when missing', () => {
    expect(restoreTask({ id: 'a', title: 'T' }).createdAt).toBe(new Date(0).toISOString());
  });

  it('builds empty form values for a new task and copies an existing one', () => {
    expect(toFormValues(null)).toEqual({
      title: '', description: '', priority: 'medium', dueDate: null, dueTime: null, reminders: [], recurrence: null, estimateMinutes: null, planned: null, labels: [], categoryId: null, subtasks: [],
    });
    const task = createTask({ title: 'T', categoryId: 'c' });
    expect(toFormValues(task)).toMatchObject({ title: 'T', categoryId: 'c' });
  });
});
