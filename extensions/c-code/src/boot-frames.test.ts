import { describe, expect, test } from "vitest";
import {
	GREEN_SHADES,
	TOTAL_FRAMES,
	bootScale,
	greenHot,
	greenMain,
	logoMatrix,
	renderBootFrame,
} from "./boot-frames.ts";

const stubPaint = {
	main: (t: string) => `<m>${t}</m>`,
	hot: (t: string) => `<h>${t}</h>`,
	dim: (t: string) => `<d>${t}</d>`,
	muted: (t: string) => `<u>${t}</u>`,
};

describe("logoMatrix", () => {
	test("7 行等宽点阵，仅含 # 与 .", () => {
		const rows = logoMatrix();
		expect(rows).toHaveLength(7);
		const w = rows[0].length;
		for (const r of rows) {
			expect(r).toHaveLength(w);
			expect(r).toMatch(/^[#.]+$/);
		}
	});
});

describe("green shades", () => {
	test("7 阶绿深浅不一，均为合法 hex", () => {
		expect(GREEN_SHADES).toHaveLength(7);
		expect(new Set(GREEN_SHADES).size).toBe(7);
		for (const hex of GREEN_SHADES) expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
	});

	test("同字不同行着色不同（行渐变），缺省行回中位", () => {
		const top = greenMain("█", 0);
		const bottom = greenMain("█", 6);
		expect(top).not.toBe(bottom);
		expect(top).toContain("\x1b[38;2;");
		expect(greenMain("█")).toBe(greenMain("█", 3));
	});

	test("hot 为近白绿高亮", () => {
		expect(greenHot("█")).toContain("38;2;");
		expect(greenHot("█")).not.toBe(greenMain("█", 0));
	});

	test("renderBootFrame 把行号传给 main（逐行动效色）", () => {
		const seenRows: number[] = [];
		const rowPaint = {
			...stubPaint,
			main: (t: string, row?: number) => {
				seenRows.push(row ?? -1);
				return `<m${row}>${t}</m${row}>`;
			},
		};
		const lines = renderBootFrame(rowPaint, "9.9.9", TOTAL_FRAMES, 1);
		expect(lines.join("\n")).toContain("<m0>");
		expect(lines.join("\n")).toContain("<m5>");
		expect(lines.join("\n")).toContain("<h>");
		expect(new Set(seenRows).size).toBeGreaterThan(1);
	});
});

describe("renderBootFrame", () => {
	test("第 0 帧无像素，末帧有 logo + 版本 + 中文 tagline", () => {
		const first = renderBootFrame(stubPaint, "9.9.9", 0, 1).join("\n");
		expect(first).not.toContain("█");
		const last = renderBootFrame(stubPaint, "9.9.9", TOTAL_FRAMES, 1).join("\n");
		expect(last).toContain("█");
		expect(last).toContain("9.9.9");
		expect(last).toContain("专属 coding agent");
	});

	test("中间帧有扫描线高亮边", () => {
		const mid = renderBootFrame(stubPaint, "9.9.9", 3, 1).join("\n");
		expect(mid).toContain("<h>");
		expect(mid).toContain("<m>");
	});

	test("越界帧钳制", () => {
		expect(renderBootFrame(stubPaint, "v", -5, 1)).toEqual(renderBootFrame(stubPaint, "v", 0, 1));
		expect(renderBootFrame(stubPaint, "v", 9999, 1)).toEqual(
			renderBootFrame(stubPaint, "v", TOTAL_FRAMES, 1),
		);
	});

	test("所有帧等高（首屏不跳动）", () => {
		const heights = new Set<number>();
		for (let f = 0; f <= TOTAL_FRAMES; f++) {
			heights.add(renderBootFrame(stubPaint, "v", f, 1).length);
		}
		expect(heights.size).toBe(1);
	});
});

describe("bootScale", () => {
	test("窄终端 1 格/像素，宽终端 2 格/像素", () => {
		expect(bootScale(83)).toBe(1);
		expect(bootScale(84)).toBe(2);
	});
});
