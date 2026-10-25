import { useEffect, useState } from 'react';
import { startOfToday, toDateKey } from '../utils/date.js';

/**
 * Start of the current local day. Re-renders at local midnight, so overdue/today/upcoming
 * indicators and filters stay correct when the app is left open overnight.
 */
export function useToday() {
  const [today, setToday] = useState(startOfToday);

  useEffect(() => {
    const next = new Date(today);
    next.setDate(next.getDate() + 1);
    // A second of margin; if the timer fires early, the check below simply re-arms it.
    const timer = setTimeout(() => {
      const now = startOfToday();
      setToday((current) => (toDateKey(current) === toDateKey(now) ? new Date(current) : now));
    }, Math.max(1000, next - Date.now() + 1000));
    return () => clearTimeout(timer);
  }, [today]);

  return today;
}
