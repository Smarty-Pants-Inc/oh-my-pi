import * as fs from "node:fs";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";

const resultPath = process.argv[2];
if (!resultPath) throw new Error("Runtime probe result path is required");
fs.writeFileSync(resultPath, JSON.stringify(isBunTestRuntime()));
