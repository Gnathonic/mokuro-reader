/**
 * Run a callback synchronously inside the NEXT real user gesture.
 *
 * Popup blockers gate window.open on transient user activation, which is only
 * true during (and ~1s after) a genuine pointerdown/keydown. Anything that
 * must open a popup without a stored popup permission (e.g. a Google OAuth
 * re-auth after token expiry) can be deferred here: the callback runs inside
 * the gesture handler itself, so the popup inherits the activation.
 *
 * The callback MUST do its popup-opening work synchronously — an `await`
 * before window.open forfeits the activation window.
 *
 * Returns a cancel function that disarms the listener without firing.
 */
export function onNextUserGesture(callback: () => void): () => void {
  let armed = true;

  const handler = (event: Event) => {
    // Escape does not grant user activation (HTML spec) — don't burn the
    // one-shot on it.
    if (event instanceof KeyboardEvent && event.key === 'Escape') return;
    if (!armed) return;
    cancel();
    callback();
  };

  const cancel = () => {
    if (!armed) return;
    armed = false;
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('keydown', handler, true);
  };

  window.addEventListener('pointerdown', handler, true);
  window.addEventListener('keydown', handler, true);

  return cancel;
}
