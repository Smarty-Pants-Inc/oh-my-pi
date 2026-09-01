import { expect, it } from "bun:test";
import { generateProtoTs, parseProto } from "../scripts/proto-parser";

it("emits a requested message's transitive schema and enum dependencies", () => {
	const output = generateProtoTs(
		parseProto(`
			syntax = "proto3";
			package example;

			enum State {
				STATE_UNSPECIFIED = 0;
				STATE_READY = 1;
			}

			message Child {
				string text = 1;
			}

			message Root {
				optional bool enabled = 1;
				Child child = 2;
				State state = 3;
				repeated State states = 4;
				map<string, State> states_by_name = 5;
				oneof choice {
					State selected_state = 6;
				}
			}

			message Unused {
				string ignored = 1;
			}
		`),
		{ includeMessages: ["example.Root"] },
	);

	expect(output).toContain("export interface Root");
	expect(output).toContain("export interface Child");
	expect(output).toContain("export enum State");
	expect(output).toContain("\tREADY = 1,");
	expect(output).not.toContain("\tSTATE_READY = 1,");
	expect(output).toContain("const StateJson");
	expect(output).toContain("STATE_READY: 1");
	expect(output).toContain('{ no: 3, name: "state", kind: "enum", E: () => StateJson }');
	expect(output).toContain('{ no: 4, name: "states", kind: "enum", E: () => StateJson, repeat: true }');
	expect(output).toContain('{ no: 5, name: "statesByName", kind: "map", K: "string", V: "enum", E: () => StateJson }');
	expect(output).toContain('{ no: 6, name: "selectedState", kind: "enum", E: () => StateJson }');
	expect(output).not.toContain("export interface Unused");
});
