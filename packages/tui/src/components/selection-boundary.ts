import { getLayoutBoxesAt, type LayoutFrame, type LayoutRect } from "../layout.ts";
import { Container } from "../tui.ts";

/**
 * Transparent wrapper that marks a copy-isolation region.
 * Pass-through for rendering, layout, and mouse dispatch; the fullscreen TUI
 * clamps text selections that start inside the boundary to its rect so copies
 * never bleed into neighboring regions.
 */
export class SelectionBoundary extends Container {}

/** Innermost boundary box containing the point, if any (deepest match wins). */
export function findSelectionBoundaryAt(frame: LayoutFrame, x: number, y: number): LayoutRect | undefined {
	const boxes = getLayoutBoxesAt(frame, x, y);
	for (const box of boxes) {
		if (box.component instanceof SelectionBoundary) return { ...box.rect };
	}
	return undefined;
}
