import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** True when the system asks for reduced motion (follows changes while the app runs). */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => globalThis.matchMedia?.(QUERY).matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.(QUERY);
    if (!media) return undefined;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}
