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

function byId<T extends HTMLElement>(id: string, kind: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`Missing dialog control: ${id}`);
  return node;
}

function dialogOutcome(dialog: HTMLDialogElement): Promise<string> {
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });
}

export interface AskTextOptions {
  message?: string;
  value?: string;
  placeholder?: string;
  label?: string;
  confirmLabel?: string;
  required?: boolean;
}

/** A non-blocking replacement for window.prompt. Returns null on cancel. */
export async function askText(title: string, options: AskTextOptions = {}): Promise<string | null> {
  const dialog = openModalDialog("shell-prompt-dialog");
  if (!dialog) return null;
  const heading = byId("shell-prompt-title", HTMLElement);
  const message = byId("shell-prompt-message", HTMLElement);
  const input = byId("shell-prompt-input", HTMLInputElement);
  const submit = byId("shell-prompt-submit", HTMLButtonElement);
  const cancel = byId("shell-prompt-cancel", HTMLButtonElement);

  heading.textContent = title;
  message.textContent = options.message ?? "";
  message.hidden = !options.message;
  input.value = options.value ?? "";
  input.placeholder = options.placeholder ?? "";
  input.required = options.required ?? false;
  const ariaLabel = options.label ?? title;
  input.setAttribute("aria-label", ariaLabel);
  submit.textContent = options.confirmLabel ?? "OK";
  cancel.onclick = () => {
    dialog.returnValue = "cancel";
    dialog.close();
  };
  dialog.returnValue = "";
  input.focus();
  input.select();

  const outcome = await dialogOutcome(dialog);
  return outcome === "confirm" ? input.value.trim() : null;
}

export interface AskConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "normal" | "danger";
}

/** A non-blocking replacement for window.confirm. */
export async function askConfirm(
  title: string,
  message: string,
  options: AskConfirmOptions = {},
): Promise<boolean> {
  const dialog = openModalDialog("shell-confirm-dialog");
  if (!dialog) return false;
  const heading = byId("shell-confirm-title", HTMLElement);
  const body = byId("shell-confirm-message", HTMLElement);
  const confirm = byId("shell-confirm-yes", HTMLButtonElement);
  const cancel = byId("shell-confirm-no", HTMLButtonElement);
  const close = byId("shell-confirm-cancel", HTMLButtonElement);

  heading.textContent = title;
  body.textContent = message;
  confirm.textContent = options.confirmLabel ?? "Confirm";
  cancel.textContent = options.cancelLabel ?? "Cancel";
  confirm.classList.toggle("danger", options.tone === "danger");
  confirm.classList.toggle("accent", options.tone !== "danger");
  dialog.returnValue = "";
  for (const button of [cancel, close]) {
    button.onclick = () => {
      dialog.returnValue = "cancel";
      dialog.close();
    };
  }
  confirm.focus();

  const outcome = await dialogOutcome(dialog);
  return outcome === "confirm";
}
