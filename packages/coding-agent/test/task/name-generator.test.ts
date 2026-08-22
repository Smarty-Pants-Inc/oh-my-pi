import { afterEach, describe, expect, it, vi } from "bun:test";
import { generateTaskName, resetTaskNames } from "@oh-my-pi/pi-coding-agent/task/name-generator";

afterEach(() => {
	resetTaskNames();
	vi.restoreAllMocks();
});

describe("task name generation", () => {
	it("does not mint retired product names", () => {
		vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.625);

		expect(generateTaskName()).toBe("AbleOrangutan");
	});
});
