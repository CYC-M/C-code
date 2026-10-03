import {
	type Component,
	HStack,
	ScrollView,
	type ScrollViewScrollbar,
	SelectionBoundary,
	type StackChild,
	VStack,
} from "@earendil-works/pi-tui";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly side?: Component;
	/** Fixed side width, or a value re-evaluated per render so it follows terminal resizes. */
	readonly sideWidth?: number | (() => number | undefined);
	readonly sideMinViewportWidth?: number;
	readonly sideVisible?: (viewport: { width: number }) => boolean;
	/**
	 * Wrap the side column and each dock block in SelectionBoundary markers so
	 * fullscreen text selections never bleed across regions. Transparent for
	 * rendering, layout, and mouse dispatch.
	 */
	readonly isolateRegions?: boolean;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

/** Narrowest terminal width that still fits the side column in teamwork mode. */
export const TEAMWORK_SIDE_MIN_WIDTH = 90;
/** Narrowest terminal width that fits the side column outside teamwork mode. */
export const DEFAULT_SIDE_MIN_WIDTH = 100;

/** Comfortable roster width bounds for the teamwork side column. */
export const TEAMWORK_SIDE_WIDTH_MIN = 34;
export const TEAMWORK_SIDE_WIDTH_MAX = 46;

/** Terminal width at or above which the side column fully expands. */
export const TEAMWORK_SIDE_FULL_WIDTH = 120;
/** Fixed side width used on narrow viewports that still show the column. */
export const TEAMWORK_SIDE_NARROW_WIDTH = 30;

/**
 * Side column width for a terminal width: hidden below the visibility gate,
 * a fixed narrow column between the gate and the full-width breakpoint so
 * model names wrap instead of being squeezed, and a viewport share once
 * fully expanded so wide terminals give the roster room for full labels.
 */
export function teamworkSideWidth(columns: number): number | undefined {
	if (columns < TEAMWORK_SIDE_MIN_WIDTH) return undefined;
	if (columns < TEAMWORK_SIDE_FULL_WIDTH) return TEAMWORK_SIDE_NARROW_WIDTH;
	const wanted = Math.floor(columns * 0.28);
	return Math.max(TEAMWORK_SIDE_WIDTH_MIN, Math.min(TEAMWORK_SIDE_WIDTH_MAX, wanted));
}

export function shouldShowTeamSide(isTeamworkMode: boolean, viewportWidth: number): boolean {
	return viewportWidth >= (isTeamworkMode ? TEAMWORK_SIDE_MIN_WIDTH : DEFAULT_SIDE_MIN_WIDTH);
}

/**
 * HStack whose side column width is re-evaluated on every render. The layout engine reads
 * the entry objects directly, so updating the basis here is enough to follow a resize
 * without rebuilding the component tree.
 */
class SideColumnStack extends HStack {
	private readonly resolveSideWidth: () => number | undefined;

	constructor(children: StackChild[], gap: number, resolveSideWidth: () => number | undefined) {
		super(children, { gap });
		this.resolveSideWidth = resolveSideWidth;
	}

	override render(width: number): string[] {
		const sideWidth = this.resolveSideWidth();
		const entry = this.entries[1];
		if (entry !== undefined && sideWidth !== undefined) entry.basis = sideWidth;
		return super.render(width);
	}
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const isolate = (component: Component): Component => {
		if (!options.isolateRegions) return component;
		const boundary = new SelectionBoundary();
		boundary.addChild(component);
		return boundary;
	};
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dock = new VStack([
		{ component: isolate(options.pendingMessages), shrink: 1, minSize: 0 },
		{ component: isolate(options.status), shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined
			? []
			: [{ component: isolate(options.widgetsAbove), shrink: 1, minSize: 0 }]),
		{ component: isolate(options.editor), shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined
			? []
			: [{ component: isolate(options.widgetsBelow), shrink: 1, minSize: 0 }]),
		{ component: isolate(options.footer), shrink: 1, minSize: 0 },
	]);
	const main = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	if (options.side === undefined) {
		return {
			transcript,
			root: main,
		};
	}
	const resolveSideWidth =
		typeof options.sideWidth === "function" ? options.sideWidth : () => options.sideWidth as number | undefined;
	const minViewportWidth = options.sideMinViewportWidth ?? DEFAULT_SIDE_MIN_WIDTH;
	const isSideVisible = options.sideVisible ?? ((viewport) => viewport.width >= minViewportWidth);
	return {
		transcript,
		root: new SideColumnStack(
			[
				{ component: main, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{
					component: options.side === undefined || !options.isolateRegions ? options.side : isolate(options.side),
					basis: resolveSideWidth() ?? TEAMWORK_SIDE_NARROW_WIDTH,
					grow: 0,
					shrink: 1,
					minSize: 26,
					visible: (viewport) => isSideVisible(viewport),
				},
			],
			1,
			resolveSideWidth,
		),
	};
}
