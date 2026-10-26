/**
 * A backdrop click closes a dialog only if the press started and ended on the
 * backdrop itself. Selecting text in a field and releasing outside the panel
 * produces a click on the backdrop, but its mousedown target was the field.
 */
export function shouldCloseOnBackdropClick(
	backdrop: EventTarget,
	mousedownTarget: EventTarget | null,
	clickTarget: EventTarget | null
): boolean {
	return mousedownTarget === backdrop && clickTarget === backdrop;
}
