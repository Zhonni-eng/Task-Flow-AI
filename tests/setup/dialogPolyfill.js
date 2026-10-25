// jsdom does not implement modal <dialog>. This polyfill reproduces the browser behavior
// the app relies on: showModal()/close(), a stack of open modals, and Escape firing a
// cancelable "cancel" event on the topmost dialog (unless the keydown was prevented).
const openDialogs = [];

export function installDialogPolyfill() {
  const proto = window.HTMLDialogElement?.prototype;
  if (!proto || proto.__taskflowPolyfill) return;
  proto.__taskflowPolyfill = true;

  proto.showModal = function showModal() {
    if (this.open) return;
    this.setAttribute('open', '');
    openDialogs.push(this);
  };

  proto.close = function close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    const index = openDialogs.indexOf(this);
    if (index !== -1) openDialogs.splice(index, 1);
    this.dispatchEvent(new Event('close'));
  };

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const top = openDialogs.filter((dialog) => dialog.isConnected).at(-1);
    if (!top) return;
    const cancel = new Event('cancel', { cancelable: true });
    top.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) top.close();
  });
}
