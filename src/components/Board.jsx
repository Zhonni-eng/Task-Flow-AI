import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  closestCenter,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { useReducedMotion } from '../state/useReducedMotion.js';
import { CardPointerSensor, HandleKeyboardSensor } from './dndSensors.js';
import TaskCard from './TaskCard.jsx';

const COLUMN_PREFIX = 'column:';
const toColumnId = (status) => `${COLUMN_PREFIX}${status}`;
const isColumnId = (id) => String(id).startsWith(COLUMN_PREFIX);

const toListId = (status) => `list:${status}`;

/**
 * Pointer drags: the card under the pointer wins; over a column's empty area the
 * nearest card in that column is used (or the column itself when it is empty);
 * outside every column there is no target, so dropping there cancels.
 * Keyboard drags have no pointer and use the closest corners.
 */
function collisionDetection(args) {
  if (!args.pointerCoordinates) return closestCorners(args);

  const hits = pointerWithin(args);
  const cardHits = hits.filter((hit) => !isColumnId(hit.id));
  if (cardHits.length > 0) return cardHits;

  const columnHit = hits.find((hit) => isColumnId(hit.id));
  if (!columnHit) return [];

  const listId = toListId(String(columnHit.id).slice(COLUMN_PREFIX.length));
  const cardsInColumn = args.droppableContainers.filter(
    (container) => container.data.current?.sortable?.containerId === listId,
  );
  if (cardsInColumn.length === 0) return [columnHit];
  return closestCenter({ ...args, droppableContainers: cardsInColumn });
}

/** Status of the column that contains `id` (a task id or a column id). */
function findColumn(columns, id) {
  if (id == null) return null;
  if (isColumnId(id)) return String(id).slice(COLUMN_PREFIX.length);
  return Object.keys(columns).find((status) => columns[status].includes(id)) ?? null;
}

function SortableTaskCard({ task, categoryName, onEdit, onDelete }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    attributes: { roleDescription: t('dnd.roleDescription') },
  });

  return (
    <TaskCard
      task={task}
      categoryName={categoryName}
      onEdit={onEdit}
      onDelete={onDelete}
      isPlaceholder={isDragging}
      dragProps={{
        ref: setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        listeners,
        handleRef: setActivatorNodeRef,
        handleAttributes: attributes,
      }}
    />
  );
}

// Without manual reordering, cards in a column keep the order of the active sort while dragging.
const keepOrder = () => null;

function Column({ column, tasks, total, filtered, dragEnabled, reorderEnabled, categoryNameOf, isDropTarget, onEditTask, onDeleteTask }) {
  const { t } = useI18n();
  const titleId = `column-${column.id}-title`;
  const { setNodeRef } = useDroppable({ id: toColumnId(column.id), disabled: !dragEnabled });
  const count = filtered ? t('board.columnCountFiltered', { shown: tasks.length, total }) : tasks.length;

  return (
    <section
      ref={setNodeRef}
      className={`column column--${column.id}${isDropTarget ? ' is-drop-target' : ''}`}
      aria-labelledby={titleId}
    >
      <header className="column__header">
        <span className="column__marker" aria-hidden="true" />
        <h2 id={titleId} className="column__title">
          {t(column.titleKey)}
        </h2>
        <span className="column__count" title={t('board.columnTaskCount', { count: total })}>
          {count}
        </span>
      </header>
      <SortableContext id={toListId(column.id)} items={tasks.map((task) => task.id)} strategy={reorderEnabled ? verticalListSortingStrategy : keepOrder}>
        <div className="column__body">
          {tasks.map((task) =>
            dragEnabled ? (
              <SortableTaskCard key={task.id} task={task} categoryName={categoryNameOf?.(task)} onEdit={onEditTask} onDelete={onDeleteTask} />
            ) : (
              <TaskCard key={task.id} task={task} categoryName={categoryNameOf?.(task)} onEdit={onEditTask} onDelete={onDeleteTask} />
            ),
          )}
          {tasks.length === 0 && (
            <p className="column__empty">
              {filtered && total > 0 ? t('board.columnNoMatches') : dragEnabled ? t('board.dropHere') : t('board.columnEmpty')}
            </p>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

// :focus-visible is true for keyboard focus, not for focus caused by a mouse press.
const isKeyboardFocus = (element) => {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
};

/**
 * `columnTasks` holds the visible, ordered tasks per status and `totals` the full counts.
 * Moving a card to another column (a status change) works in every sort and filter mode.
 * Reordering within a column (`reorderEnabled`) only when the complete board is shown in manual
 * order, so a position is never computed from a partial or re-sorted list; otherwise a moved card
 * joins the end of its new column's manual order and appears where the active sort puts it.
 */
export default function Board({ columns, columnTasks, totals, filtered, dragEnabled = true, reorderEnabled = true, categoryNameOf, onEditTask, onDeleteTask, onMoveTask }) {
  const { t } = useI18n();
  // The CSS reduced-motion rule cannot reach dnd-kit's drop animation (Web Animations API).
  const reducedMotion = useReducedMotion();

  const sensors = useSensors(
    useSensor(CardPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(HandleKeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Committed layout: status -> ordered task ids.
  const committed = useMemo(
    () => Object.fromEntries(columns.map((column) => [column.id, columnTasks[column.id].map((task) => task.id)])),
    [columns, columnTasks],
  );
  const tasks = useMemo(() => columns.flatMap((column) => columnTasks[column.id]), [columns, columnTasks]);
  // While dragging, a preview layout shows where the card will land.
  const [preview, setPreview] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const fromStatus = useRef(null);
  const layout = preview ?? committed;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const activeTask = activeId ? taskById.get(activeId) : null;
  const activeColumn = activeId ? findColumn(layout, activeId) : null;

  const endDrag = () => {
    setActiveId(null);
    setPreview(null);
    document.body.classList.remove('is-dragging');
  };

  const handleDragStart = ({ active }) => {
    fromStatus.current = findColumn(committed, active.id);
    setActiveId(active.id);
    setPreview(committed);
    document.body.classList.add('is-dragging');
  };

  // Moving across columns updates the preview so the card appears in the new column.
  const handleDragOver = ({ active, over }) => {
    if (!over) return;
    setPreview((current) => {
      const columnsNow = current ?? committed;
      const from = findColumn(columnsNow, active.id);
      const to = findColumn(columnsNow, over.id);
      if (!from || !to || from === to) return current;

      const target = columnsNow[to].filter((id) => id !== active.id);
      let index = target.length;
      if (!isColumnId(over.id)) {
        index = target.indexOf(over.id);
        const dragged = active.rect.current.translated;
        if (dragged && dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2) index += 1;
      }
      target.splice(index, 0, active.id);
      return { ...columnsNow, [from]: columnsNow[from].filter((id) => id !== active.id), [to]: target };
    });
  };

  const handleDragEnd = ({ active, over }) => {
    const columnsNow = layoutRef.current;
    const status = findColumn(columnsNow, active.id);
    if (over && status && dragEnabled) {
      if (reorderEnabled) {
        const ids = columnsNow[status];
        let index = ids.indexOf(active.id);
        if (!isColumnId(over.id) && findColumn(columnsNow, over.id) === status) {
          index = ids.indexOf(over.id);
        }
        onMoveTask(active.id, status, index);
      } else if (status !== fromStatus.current) {
        // Sorted or filtered view: only the status changes - never a position from this list.
        onMoveTask(active.id, status, null);
      }
    }
    endDrag();
  };

  // Screen reader messages, positions are 1-based.
  const describe = (id, overId = id) => {
    const columnsNow = layoutRef.current;
    const status = findColumn(columnsNow, overId);
    if (!status) return {};
    const ids = columnsNow[status];
    const contains = ids.includes(id);
    let index = contains ? ids.indexOf(id) : ids.length;
    if (!isColumnId(overId) && overId !== id) index = ids.indexOf(overId);
    return { column: t(`columns.${status}`), position: index + 1, total: contains ? ids.length : ids.length + 1 };
  };
  const titleOf = (id) => taskById.get(id)?.title ?? '';
  const announcements = {
    onDragStart: ({ active }) => t('dnd.pickedUp', { title: titleOf(active.id), ...describe(active.id) }),
    onDragOver: ({ active, over }) =>
      over ? t('dnd.movedOver', describe(active.id, over.id)) : t('dnd.notOver', { title: titleOf(active.id) }),
    onDragEnd: ({ active, over }) =>
      over
        ? t('dnd.dropped', { title: titleOf(active.id), ...describe(active.id, over.id) })
        : t('dnd.cancelled', { title: titleOf(active.id) }),
    onDragCancel: ({ active }) => t('dnd.cancelled', { title: titleOf(active.id) }),
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      // Scroll columns only near their very edges so dropping onto a lower card stays predictable.
      autoScroll={{ threshold: { x: 0.2, y: 0.1 } }}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t('dnd.instructions') } }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={endDrag}
    >
      <div
        className={`board${columns.length < 3 ? ' board--partial' : ''}`}
        role="region"
        aria-label={t('board.label')}
        style={{ '--board-columns': columns.length }}
        // Chromium does not scroll the horizontally scrolling board to a newly focused control
        // inside a column; reveal it (with scroll-padding) for keyboard focus only. A mouse press
        // must not scroll, or the card would move under the pointer as a drag starts.
        onFocus={(event) => {
          if (document.body.classList.contains('is-dragging') || !isKeyboardFocus(event.target)) return;
          event.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }}
      >
        {columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            tasks={layout[column.id].map((id) => taskById.get(id)).filter(Boolean)}
            total={totals[column.id]}
            filtered={filtered}
            dragEnabled={dragEnabled}
            reorderEnabled={reorderEnabled}
            categoryNameOf={categoryNameOf}
            isDropTarget={activeColumn === column.id}
            onEditTask={onEditTask}
            onDeleteTask={onDeleteTask}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={reducedMotion ? null : { duration: 180, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }}>
        {activeTask ? (
          // The wrapper is what dnd-kit measures, so the card's tilt/scale does not skew collisions.
          <div className="drag-overlay">
            <TaskCard task={activeTask} categoryName={categoryNameOf?.(activeTask)} isOverlay />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
