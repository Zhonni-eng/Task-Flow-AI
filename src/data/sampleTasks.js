// Demo tasks shown on first launch. Text is taken from the translation dictionaries
// in the language active at startup; afterwards the tasks are ordinary user content
// and are not re-translated when the interface language changes.
import { addDays, startOfToday, toDateKey } from '../utils/date.js';
import { createTask } from './taskModel.js';

const SAMPLES = [
  { id: 't1', status: 'todo', priority: 'high', dueIn: 2, labels: ['planning'] },
  { id: 't2', status: 'todo', priority: 'medium', dueIn: 6, labels: ['docs'] },
  { id: 't3', status: 'todo', priority: 'low', dueIn: 10, labels: ['research'] },
  { id: 't4', status: 'inProgress', priority: 'high', dueIn: 1, labels: ['design', 'ui'] },
  { id: 't5', status: 'inProgress', priority: 'high', dueIn: -1, labels: ['bug'] },
  { id: 't6', status: 'inProgress', priority: 'medium', dueIn: 4, labels: ['dev'] },
  { id: 't7', status: 'done', priority: 'medium', dueIn: -3, labels: ['dev'] },
  { id: 't8', status: 'done', priority: 'low', dueIn: -5, labels: ['design'] },
];

export function createSampleTasks(t) {
  const today = startOfToday();
  const nextOrder = {};
  return SAMPLES.map((sample) =>
    createTask({
      id: `sample-${sample.id}`,
      order: (nextOrder[sample.status] = (nextOrder[sample.status] ?? -1) + 1),
      title: t(`sample.tasks.${sample.id}.title`),
      description: t(`sample.tasks.${sample.id}.description`),
      priority: sample.priority,
      status: sample.status,
      dueDate: toDateKey(addDays(today, sample.dueIn)),
      labels: sample.labels.map((label) => t(`sample.labels.${label}`)),
    }),
  );
}
