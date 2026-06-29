export type ApprovalBroker = {
	confirm: (title: string, message: string, options: { timeoutMs: number }) => Promise<boolean>;
};

const brokerBySessionId = new Map<string, ApprovalBroker>();

export function setWorkerApprovalBroker(
	sessionId: string,
	broker: ApprovalBroker | undefined,
): void {
	if (!sessionId) return;
	if (!broker) brokerBySessionId.delete(sessionId);
	else brokerBySessionId.set(sessionId, broker);
}

export function getWorkerApprovalBroker(sessionId: string): ApprovalBroker | undefined {
	return brokerBySessionId.get(sessionId);
}

export function createUiApprovalBroker(ui: {
	confirm: (title: string, message: string, options: { timeout?: number }) => Promise<boolean>;
}): ApprovalBroker {
	// Serialize prompts so we never show overlapping dialogs.
	let queue = Promise.resolve();

	return {
		confirm(title, message, options) {
			const timeout = Math.max(0, Number(options?.timeoutMs ?? 0));
			const run = async () => ui.confirm(title, message, { timeout });
			const p = queue.then(run, run);
			queue = p.then(
				() => undefined,
				() => undefined,
			);
			return p;
		},
	};
}
