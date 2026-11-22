// Modal dialogs in Talos Crest are single-slot: opening one must dismiss any
// other overlay so search, the command palette, and tool panels cannot stack on
// top of each other in WebKit's top layer.

const PROTECTED_DIALOGS = new Set(["file-conflict-dialog", "close-confirm-dialog"]);

export function closeOtherDialogs(exceptId: string): void {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) {
    if (dialog.id === exceptId || PROTECTED_DIALOGS.has(dialog.id)) continue;
    dialog.close();
  }
}

export function openModalDialog(id: string): HTMLDialogElement | null {
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return null;
  closeOtherDialogs(id);
  if (!dialog.open) dialog.showModal();
  return dialog;
}

// Escape must dismiss the topmost ordinary modal before any page-level view
// (such as the Explorer) reacts. Protected confirmation dialogs are left alone.
export function closeTopmostDialog(): boolean {
  const dialog = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")]
    .reverse()
    .find((candidate) => !PROTECTED_DIALOGS.has(candidate.id));
  if (!dialog) return false;
  dialog.close();
  return true;
}
