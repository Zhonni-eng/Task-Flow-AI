import { useEffect, useRef } from 'react';

// Accessible modal built on the native <dialog> element (focus trapping, Escape,
// top-layer stacking). The element marked [data-autofocus] receives initial focus.
export default function Modal({ onClose, labelledBy, describedBy, size = 'md', role, children }) {
  const ref = useRef(null);
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    const previouslyFocused = document.activeElement;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-autofocus]')?.focus();

    return () => {
      if (dialog.open) dialog.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal modal--${size}`}
      role={role}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === ref.current;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === ref.current) onClose();
      }}
    >
      <div className="modal__panel">{children}</div>
    </dialog>
  );
}
