import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Board from './components/Board.jsx';
import BulkToolbar from './components/BulkToolbar.jsx';
import CategoryDeleteDialog from './components/CategoryDeleteDialog.jsx';
import AiPanel from './components/AiPanel.jsx';
import AiSettingsDialog from './components/AiSettingsDialog.jsx';
import CategoryNameDialog from './components/CategoryNameDialog.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import AppSettingsDialog from './components/AppSettingsDialog.jsx';
import StorageNotice from './components/StorageNotice.jsx';
import TaskDialog from './components/TaskDialog.jsx';
import TaskList from './components/TaskList.jsx';
import TaskStats from './components/TaskStats.jsx';
import Toaster from './components/Toaster.jsx';
import Toolbar from './components/Toolbar.jsx';
import ViewStatus from './components/ViewStatus.jsx';
import { COLUMNS } from './data/board.js';
import { normalizeCategoryName, restoreCategories, validateCategoryName } from './data/categoryModel.js';
import { createSampleTasks } from './data/sampleTasks.js';
import { isValidDateKey, parseDateKey } from './utils/date.js';
import { useI18n } from './i18n/I18nProvider.jsx';
import { saveLastView } from './storage/storage.js';
import { useToday } from './state/useToday.js';
import { useAssistant } from './ai/useAssistant.js';
import { categoriesReducer, categoryActions } from './state/categoriesReducer.js';
import {
  ALL_TASKS,
  EMPTY_VIEW,
  UNCATEGORIZED,
  buildBoardView,
  buildListView,
  computeStats,
  countByCategory,
  isDragAllowed,
  isFiltering,
  scopeTasks,
  toFullColumnIndex,
} from './state/taskView.js';
import { collectLabels, restoreTasks, selectColumnTasks, taskActions, tasksReducer } from './state/tasksReducer.js';
import { useSelection } from './state/useSelection.js';
import { useTaskPersistence } from './state/useTaskPersistence.js';
import { useToasts } from './state/useToasts.js';

const LAYOUTS = ['board', 'list'];

function initialData(boot, t) {
  const categories = restoreCategories(boot.categories);
  const known = new Set(categories.map((category) => category.id));
  // A task can never point at a category that does not exist: treat it as uncategorized.
  const tasks = boot.tasks
    ? restoreTasks(boot.tasks).map((task) => (task.categoryId && !known.has(task.categoryId) ? { ...task, categoryId: null } : task))
    : createSampleTasks(t);
  const remembered = boot.lastView ?? {};
  const destination =
    remembered.destination === UNCATEGORIZED || known.has(remembered.destination) ? remembered.destination : ALL_TASKS;
  const layout = LAYOUTS.includes(remembered.layout) ? remembered.layout : 'board';
  return { categories, tasks, destination, layout };
}

// `boot` is the result of loadAppData(); `boot.tasks === null` means first launch.
export default function App({ boot }) {
  const { t, locale, language } = useI18n();
  const [initial] = useState(() => initialData(boot, t));
  const [tasks, dispatch] = useReducer(tasksReducer, initial.tasks);
  const [categories, dispatchCategory] = useReducer(categoriesReducer, initial.categories);
  const saveStatus = useTaskPersistence(tasks, categories, boot);
  const { toasts, notify, dismiss } = useToasts();

  // null | { mode: 'create' } | { mode: 'edit', taskId }
  const [editor, setEditor] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [pendingCategoryDeleteId, setPendingCategoryDeleteId] = useState(null);
  // null | { mode: 'create' } | { mode: 'rename', id }
  const [categoryEditor, setCategoryEditor] = useState(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState(() => ({
    reminders: boot.reminders ?? { enabled: true, allDayTime: '09:00' },
    availability: boot.availability ?? null,
  }));
  // Assistant panel: its conversation lives here, so closing the panel keeps it for this session.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [aiSettingsVersion, setAiSettingsVersion] = useState(0);
  const assistant = useAssistant({ tasks, categories, dispatch, dispatchCategory, language, availability: appSettings.availability });
  // Navigation and presentation state. Destination and layout are remembered as settings;
  // search, filters and sort are temporary. None of it is applied to task data.
  const [destination, setDestination] = useState(initial.destination);
  const [layout, setLayout] = useState(initial.layout);
  const [view, setView] = useState(EMPTY_VIEW);
  // Date filters and statistics follow the local calendar date (updated at midnight).
  const today = useToday();

  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  // A deleted category can never stay selected.
  const activeDestination =
    destination === ALL_TASKS || destination === UNCATEGORIZED || categoryById.has(destination) ? destination : ALL_TASKS;
  const selectedCategory = categoryById.get(activeDestination) ?? null;
  const destinationTitle =
    activeDestination === ALL_TASKS
      ? t('nav.allTasks')
      : activeDestination === UNCATEGORIZED
        ? t('nav.uncategorized')
        : selectedCategory.name;

  // Remember the destination and layout (skips the initial render).
  const lastViewRef = useRef(`${initial.destination}|${initial.layout}`);
  useEffect(() => {
    const key = `${activeDestination}|${layout}`;
    if (key === lastViewRef.current) return;
    lastViewRef.current = key;
    saveLastView({ destination: activeDestination, layout });
  }, [activeDestination, layout]);

  const scopedTasks = useMemo(() => scopeTasks(tasks, activeDestination), [tasks, activeDestination]);
  const counts = useMemo(() => countByCategory(tasks), [tasks]);
  const editingTask = editor?.mode === 'edit' ? tasks.find((task) => task.id === editor.taskId) : null;
  const pendingDeleteTask = tasks.find((task) => task.id === pendingDeleteId) ?? null;
  const pendingCategory = categoryById.get(pendingCategoryDeleteId) ?? null;
  const renamingCategory = categoryEditor?.mode === 'rename' ? categoryById.get(categoryEditor.id) : null;
  const labelSuggestions = useMemo(() => collectLabels(tasks), [tasks]);
  const boardView = useMemo(() => buildBoardView(scopedTasks, view, locale, today), [scopedTasks, view, locale, today]);
  const listTasks = useMemo(
    () => (layout === 'list' ? buildListView(scopedTasks, view, locale, today) : []),
    [layout, scopedTasks, view, locale, today],
  );
  const stats = useMemo(() => computeStats(scopedTasks, today), [scopedTasks, today]);
  // List View selection: only visible tasks; cleared when the destination or layout changes.
  const listIds = useMemo(() => listTasks.map((task) => task.id), [listTasks]);
  const selection = useSelection(listIds, `${activeDestination}|${layout}`);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const filtering = isFiltering(view);
  const dragAllowed = isDragAllowed(view);
  const visibleColumns = view.statuses.length > 0 ? COLUMNS.filter((column) => view.statuses.includes(column.id)) : COLUMNS;
  const noMatches = filtering && boardView.shown === 0 && boardView.total > 0;
  const showCategory = activeDestination === ALL_TASKS;
  const categoryNameOf = (task) => (task.categoryId ? categoryById.get(task.categoryId)?.name : null) ?? t('nav.uncategorized');
  const openCreateTask = () => setEditor({ mode: 'create' });

  // Keyboard focus after an action removes the focused control (deleting a task or category,
  // bulk actions closing the bulk toolbar): the first matching selector that exists gets focus.
  // Runs after dialogs have closed and restored their own focus.
  const focusRequest = useRef(null);
  const requestFocus = (...selectors) => {
    focusRequest.current = selectors;
  };
  useEffect(() => {
    const selectors = focusRequest.current;
    if (!selectors) return;
    focusRequest.current = null;
    for (const selector of selectors) {
      const element = selector && document.querySelector(selector);
      if (element && !element.disabled) {
        element.focus();
        return;
      }
    }
  });
  const taskFocusSelector = (id) => (id ? `[data-task-focus="${CSS.escape(id)}"]` : null);

  const closeEditor = () => setEditor(null);

  const handleSubmit = (fields) => {
    const title = fields.title.trim();
    if (editingTask) {
      dispatch(taskActions.update(editingTask.id, fields));
      notify(t('toast.taskUpdated', { title }));
    } else {
      dispatch(taskActions.create(fields));
      notify(t('toast.taskCreated', { title }));
    }
    closeEditor();
  };

  const confirmDelete = () => {
    // Focus moves to the next visible task (or the previous one), otherwise to "New task".
    const visible = layout === 'list' ? listTasks : (boardView.columns[pendingDeleteTask.status] ?? []);
    const index = visible.findIndex((task) => task.id === pendingDeleteId);
    requestFocus(taskFocusSelector(visible[index + 1]?.id), taskFocusSelector(visible[index - 1]?.id), '[data-focus-target="new-task"]');
    notify(t('toast.taskDeleted', { title: pendingDeleteTask.title }));
    dispatch(taskActions.remove(pendingDeleteId));
    if (editor?.taskId === pendingDeleteId) closeEditor();
    setPendingDeleteId(null);
  };

  // Drops are positioned within the visible (category-scoped) column; convert them to
  // the full column so tasks of other categories keep their relative order.
  // `visibleIndex` null: a status change from a sorted or filtered board - the task goes to the end
  // of its new column's manual order (the view shows it where the active sort puts it).
  const handleMove = (taskId, status, visibleIndex) => {
    if (visibleIndex === null) {
      dispatch(taskActions.move(taskId, status, Number.MAX_SAFE_INTEGER));
      return;
    }
    const fullIds = selectColumnTasks(tasks, status).map((task) => task.id);
    const visibleIds = boardView.columns[status].map((task) => task.id);
    dispatch(taskActions.move(taskId, status, toFullColumnIndex(fullIds, visibleIds, taskId, visibleIndex)));
  };

  // List View status change: the task goes to the end of its new column.
  // ---------- Bulk actions (List View) ----------
  // Every action works on the current selection's ids, which are always visible tasks.
  // Tasks that no longer exist are skipped; if none remain, nothing changes.
  const selectedTasks = () => {
    const ids = new Set(selection.selectedIds);
    return tasks.filter((task) => ids.has(task.id));
  };

  // The bulk toolbar closes with the selection; keep keyboard focus in the list.
  const clearBulkSelection = () => {
    selection.clear();
    requestFocus('[data-focus-target="select-all"]', '[data-focus-target="new-task"]');
  };

  const finishBulk = (changedCount, messageKey, params = {}) => {
    notify(changedCount > 0 ? t(messageKey, { count: changedCount, ...params }) : t('toast.bulkNoChange'));
    clearBulkSelection();
  };

  const withSelection = (action) => () => {
    const targets = selectedTasks();
    if (targets.length === 0) {
      notify(t('toast.bulkUnavailable'), 'error');
      clearBulkSelection();
      return;
    }
    action(targets);
  };

  const bulkSetStatus = (status, messageKey = 'toast.bulkStatus') =>
    withSelection((targets) => {
      const changing = targets.filter((task) => task.status !== status);
      if (changing.length > 0) dispatch(taskActions.bulkMove(changing.map((task) => task.id), status));
      finishBulk(changing.length, messageKey, { status: t(`columns.${status}`) });
    })();

  const bulkSetField = (field, value, messageKey, params) =>
    withSelection((targets) => {
      const changing = targets.filter((task) => task[field] !== value);
      if (changing.length > 0) dispatch(taskActions.bulkUpdate(changing.map((task) => task.id), { [field]: value }));
      finishBulk(changing.length, messageKey, params);
    })();

  const bulkSetCategory = (categoryId) => {
    // Only existing categories (or uncategorized) can be assigned; nothing is created.
    if (categoryId !== null && !categoryById.has(categoryId)) {
      notify(t('toast.bulkUnavailable'), 'error');
      return;
    }
    bulkSetField('categoryId', categoryId, 'toast.bulkCategory', {
      category: categoryId ? categoryById.get(categoryId).name : t('nav.uncategorized'),
    });
  };

  const bulkSetDueDate = (dateKey) => {
    if (dateKey !== null && !isValidDateKey(dateKey)) return;
    if (dateKey === null) {
      bulkSetField('dueDate', null, 'toast.bulkDueCleared');
      return;
    }
    const date = parseDateKey(dateKey).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    bulkSetField('dueDate', dateKey, 'toast.bulkDueDate', { date });
  };

  const confirmBulkDeletion = () => {
    const ids = selectedTasks().map((task) => task.id);
    setConfirmBulkDelete(false);
    if (ids.length === 0) {
      notify(t('toast.bulkUnavailable'), 'error');
      clearBulkSelection();
      return;
    }
    dispatch(taskActions.bulkRemove(ids));
    finishBulk(ids.length, 'toast.bulkDeleted');
  };

  const handleStatusChange = (taskId, status) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status === status) return;
    dispatch(taskActions.move(taskId, status, selectColumnTasks(tasks, status).length));
    notify(t('toast.statusChanged', { title: task.title, status: t(`columns.${status}`) }));
  };

  const submitCategoryName = (name) => {
    const existingId = renamingCategory?.id ?? null;
    const error = validateCategoryName(name, categories, existingId);
    if (error) return error;
    const clean = normalizeCategoryName(name);
    if (renamingCategory) {
      dispatchCategory(categoryActions.rename(renamingCategory.id, clean));
      notify(t('toast.categoryRenamed', { name: clean }));
    } else {
      dispatchCategory(categoryActions.create(clean));
      notify(t('toast.categoryCreated', { name: clean }));
    }
    setCategoryEditor(null);
    return null;
  };

  // Tasks are reassigned before the category disappears; both changes are saved together.
  const deleteCategory = (targetId) => {
    const moved = counts[pendingCategoryDeleteId] ?? 0;
    const name = pendingCategory.name;
    const target = targetId ? categoryById.get(targetId)?.name : t('nav.uncategorized');
    dispatch(taskActions.reassignCategory(pendingCategoryDeleteId, targetId));
    dispatchCategory(categoryActions.remove(pendingCategoryDeleteId));
    if (destination === pendingCategoryDeleteId) setDestination(ALL_TASKS);
    setPendingCategoryDeleteId(null);
    requestFocus('[data-focus-target="all-tasks"]');
    notify(
      moved > 0
        ? t('toast.categoryDeletedMoved', { name, count: moved, target })
        : t('toast.categoryDeleted', { name }),
    );
  };

  const scopeEmptyMessage = activeDestination === ALL_TASKS ? t('view.noTasksYet') : t('view.categoryEmpty');

  return (
    <div className="app">
      <Sidebar
        categories={categories}
        counts={counts}
        destination={activeDestination}
        onSelect={setDestination}
        onRequestCreate={() => setCategoryEditor({ mode: 'create' })}
        onRequestRename={(id) => setCategoryEditor({ mode: 'rename', id })}
        onRequestDelete={setPendingCategoryDeleteId}
        onOpenSettings={() => setAppSettingsOpen(true)}
      />
      <main className="main">
        <Header
          title={destinationTitle}
          layout={layout}
          categoryActions={
            selectedCategory
              ? {
                  onRename: () => setCategoryEditor({ mode: 'rename', id: selectedCategory.id }),
                  onDelete: () => setPendingCategoryDeleteId(selectedCategory.id),
                }
              : null
          }
          onCreateTask={openCreateTask}
          onOpenAssistant={() => setAssistantOpen((open) => !open)}
          assistantOpen={assistantOpen}
        />
        <StorageNotice boot={boot} saveStatus={saveStatus} />
        <Toolbar layout={layout} onLayoutChange={setLayout} view={view} onViewChange={setView} labels={labelSuggestions} />
        <div className="toolbar-secondary">
          <ViewStatus
            view={view}
            onViewChange={setView}
            shown={boardView.shown}
            total={boardView.total}
            dragAllowed={dragAllowed}
            layout={layout}
            emptyMessage={scopeEmptyMessage}
            onCreateTask={openCreateTask}
          />
          <TaskStats stats={stats} />
        </div>
        {noMatches ? (
          <div className="board-empty" role="status">
            <p className="board-empty__title">{t('view.noMatches')}</p>
            <p className="board-empty__hint">{t('view.noMatchesHint')}</p>
            <button type="button" className="btn btn--ghost" onClick={() => setView(EMPTY_VIEW)}>
              {t('view.resetAll')}
            </button>
          </div>
        ) : layout === 'list' ? (
          <div className={`list-view${selection.count > 0 ? ' has-selection' : ''}`}>
          <TaskList
            selection={selection}
            tasks={listTasks}
            categoryNameOf={categoryNameOf}
            showCategory={showCategory}
            onEditTask={(taskId) => setEditor({ mode: 'edit', taskId })}
            onDeleteTask={setPendingDeleteId}
            onStatusChange={handleStatusChange}
          />
          {selection.count > 0 && (
            <BulkToolbar
              count={selection.count}
              categories={categories}
              onComplete={() => bulkSetStatus('done', 'toast.bulkCompleted')}
              onStatus={(status) => bulkSetStatus(status)}
              onCategory={bulkSetCategory}
              onPriority={(priority) => bulkSetField('priority', priority, 'toast.bulkPriority', { priority: t(`priority.${priority}`) })}
              onDueDate={bulkSetDueDate}
              onDelete={() => setConfirmBulkDelete(true)}
              onClear={clearBulkSelection}
            />
          )}
          </div>
        ) : (
          <Board
            columns={visibleColumns}
            columnTasks={boardView.columns}
            totals={boardView.totals}
            filtered={filtering}
            dragEnabled
            reorderEnabled={dragAllowed}
            // Cards only tag tasks that have a category; uncategorized cards stay uncluttered.
            categoryNameOf={showCategory ? (task) => (task.categoryId ? categoryNameOf(task) : null) : undefined}
            onEditTask={(taskId) => setEditor({ mode: 'edit', taskId })}
            onDeleteTask={setPendingDeleteId}
            onMoveTask={handleMove}
          />
        )}
      </main>

      {(editor?.mode === 'create' || editingTask) && (
        <TaskDialog
          key={editingTask?.id ?? 'new'}
          task={editingTask}
          categories={categories}
          defaultCategoryId={selectedCategory?.id ?? null}
          labelSuggestions={labelSuggestions}
          onSubmit={handleSubmit}
          onCancel={closeEditor}
          onDelete={() => setPendingDeleteId(editingTask.id)}
        />
      )}

      {pendingDeleteTask && (
        <ConfirmDialog
          title={t('confirmDelete.title')}
          message={t('confirmDelete.message', { title: pendingDeleteTask.title })}
          confirmLabel={t('confirmDelete.confirm')}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {assistantOpen && (
        <AiPanel
          assistant={assistant}
          categories={categories}
          settingsVersion={aiSettingsVersion}
          onOpenSettings={() => setAiSettingsOpen(true)}
          onClose={() => {
            setAssistantOpen(false);
            document.querySelector('[data-focus-target="assistant"]')?.focus();
          }}
        />
      )}

      {appSettingsOpen && (
        <AppSettingsDialog
          reminders={appSettings.reminders}
          availability={appSettings.availability}
          onChange={setAppSettings}
          onClose={() => setAppSettingsOpen(false)}
        />
      )}

      {aiSettingsOpen && (
        <AiSettingsDialog
          onClose={() => {
            setAiSettingsOpen(false);
            setAiSettingsVersion((version) => version + 1);
          }}
        />
      )}

      {(categoryEditor?.mode === 'create' || renamingCategory) && (
        <CategoryNameDialog
          key={renamingCategory?.id ?? 'new'}
          initialName={renamingCategory?.name ?? ''}
          onSubmit={submitCategoryName}
          onCancel={() => setCategoryEditor(null)}
        />
      )}

      {confirmBulkDelete && selection.count > 0 && (
        <ConfirmDialog
          title={t('bulk.confirmTitle')}
          message={t('bulk.confirmMessage', { count: selection.count })}
          confirmLabel={t('bulk.confirmButton', { count: selection.count })}
          onConfirm={confirmBulkDeletion}
          onCancel={() => setConfirmBulkDelete(false)}
        />
      )}

      {pendingCategory && (
        <CategoryDeleteDialog
          category={pendingCategory}
          taskCount={counts[pendingCategory.id] ?? 0}
          otherCategories={categories.filter((category) => category.id !== pendingCategory.id)}
          onConfirm={deleteCategory}
          onCancel={() => setPendingCategoryDeleteId(null)}
        />
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
