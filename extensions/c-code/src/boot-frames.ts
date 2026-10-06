/**
 * C-code 开局动效：5x7 点阵 "C-CODE" 扫描线揭示 + tagline 淡入。
 * 移植自 C-code.bak/packages/c-tui/src/boot.ts，差异：
 * - 着色经 paint 注入（跟随 pi 主题），不再硬编码 ANSI；
 * - 去掉"按任意键跳过"（extension 截获不到按键，改为固定播完）；
 * - 输入缓冲不需要（动画期间输入天然进编辑器）。
 * 纯函数，可单测；定时推进由 index.ts 的 header 组件负责。
 */

export interface BootPaint {
	main(text: string, row?: number): string;
	hot(text: string): string;
	dim(text: string): string;
	muted(text: string): string;
}

/** 像素头恒绿：7 行由亮到深，与主题无关（raw ANSI，零依赖）。 */
export const GREEN_SHADES = ["#8FFFBE", "#5CFFA3", "#00FF87", "#00E57A", "#00C46A", "#00A35A", "#00804A"];
const GREEN_HOT = "#E8FFF2";

function hexRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fg(text: string, hex: string, bold = false): string {
	const [r, g, b] = hexRgb(hex);
	return bold ? `\x1b[1;38;2;${r};${g};${b}m${text}\x1b[39;22m` : `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** 行渐变绿（缺省行取中位）；tagline 等无行场景传中位色。 */
export function greenMain(text: string, row?: number): string {
	const shade = GREEN_SHADES[row ?? 3] ?? GREEN_SHADES[3];
	return fg(text, shade);
}

/** 扫描线高亮边：近白绿。 */
export function greenHot(text: string): string {
	return fg(text, GREEN_HOT, true);
}

// 5x7 点阵字模（'#' = 像素）
const GLYPHS: Record<string, string[]> = {
	C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
	"-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
	O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
	D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
	E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
};

const LOGO = "C-CODE";
const ROWS = 7;
export const REVEAL_FRAMES = 10;
export const TAG_FRAMES = 6;
export const TOTAL_FRAMES = REVEAL_FRAMES + TAG_FRAMES;
const BLOCK = "█";

/** 7 行 logo 点阵（'#'/'.'）。 */
export function logoMatrix(): string[] {
	const rows: string[] = [];
	for (let r = 0; r < ROWS; r++) {
		let line = "";
		for (let i = 0; i < LOGO.length; i++) {
			const glyph = GLYPHS[LOGO[i]];
			if (!glyph) throw new Error(`boot-frames: no glyph for ${LOGO[i]}`);
			line += glyph[r];
			if (i < LOGO.length - 1) line += "..";
		}
		rows.push(line);
	}
	return rows;
}

/** 模块加载即构建并校验字模：glyph 缺失直接 fail-fast，渲染期零重复分配。 */
const LOGO_MATRIX: readonly string[] = logoMatrix();

function logoRow(paint: BootPaint, row: number, revealed: number, scale: number): string {
	const line = LOGO_MATRIX[row] ?? "";
	let out = "";
	for (const cell of line) {
		if (cell === "#") {
			const px = BLOCK.repeat(scale);
			out += row === revealed - 1 ? paint.hot(px) : paint.main(px, row);
		} else out += " ".repeat(scale);
	}
	return out;
}

/** 窄终端用 1 格/像素，否则 logo 过宽折行。 */
export function bootScale(width: number): number {
	return width >= 84 ? 2 : 1;
}

/** 给定帧的完整 splash 行（定高，各帧等长，首屏不跳动）。 */
export function renderBootFrame(
	paint: BootPaint,
	version: string,
	frame: number,
	scale = 2,
): string[] {
	const f = Math.max(0, Math.min(frame, TOTAL_FRAMES));
	const lines: string[] = [];
	const revealed = Math.min(ROWS, f);
	const blank = (LOGO.length * 7 - 2) * scale;
	for (let r = 0; r < ROWS; r++) {
		lines.push(r < revealed ? logoRow(paint, r, revealed, scale) : " ".repeat(blank));
	}
	const tagF = Math.max(0, f - REVEAL_FRAMES);
	lines.push("");
	lines.push(tagF >= 1 ? paint.main("  > 专属 coding agent") : "");
	lines.push(tagF >= 2 ? paint.dim(`  C-code · v${version}`) : "");
	return lines;
}
