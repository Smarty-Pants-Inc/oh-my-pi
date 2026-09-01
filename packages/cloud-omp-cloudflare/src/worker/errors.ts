import type { CloudOmpWireErrorCode } from "../protocol";

export class WorkspaceObjectError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 410 | 422 | 500,
		readonly code: CloudOmpWireErrorCode,
		message: string,
	) {
		super(message);
		this.name = "WorkspaceObjectError";
	}
}
