import { describe, test, expect } from 'vitest';
import { shouldCloseOnBackdropClick } from './backdrop-close';

describe('shouldCloseOnBackdropClick', () => {
	const backdrop = {} as EventTarget;
	const input = {} as EventTarget;

	test('closes when press and release are both on the backdrop', () => {
		expect(shouldCloseOnBackdropClick(backdrop, backdrop, backdrop)).toBe(true);
	});

	test('does not close when the press started inside the panel', () => {
		expect(shouldCloseOnBackdropClick(backdrop, input, backdrop)).toBe(false);
	});

	test('does not close when the release is inside the panel', () => {
		expect(shouldCloseOnBackdropClick(backdrop, backdrop, input)).toBe(false);
	});

	test('does not close without a recorded mousedown', () => {
		expect(shouldCloseOnBackdropClick(backdrop, null, backdrop)).toBe(false);
	});
});
