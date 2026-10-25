import { useCallback, useEffect, useRef, useState } from 'react';

const TOAST_DURATION_MS = 4000;
const MAX_TOASTS = 3;

/** Short-lived confirmation messages ("Task deleted", …). */
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message, tone = 'success') => {
      const id = ++nextId.current;
      setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), { id, message, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), TOAST_DURATION_MS));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  return { toasts, notify, dismiss };
}
