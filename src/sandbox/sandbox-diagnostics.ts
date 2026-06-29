type SandboxFailure =
	| {
			kind: "network";
			subtype: "dns" | "blocked" | "connect";
			evidence: string;
			confidence: "high" | "medium";
	  }
	| {
			kind: "filesystem";
			subtype: "read" | "write";
			evidence: string;
			confidence: "high" | "medium";
	  }
	| {
			kind: "unknown";
			evidence: string;
			confidence: "low";
	  };

function trimEvidence(str: string, maxLen = 200): string {
	const s = str.trim();
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 3) + "...";
}

function extractLineAt(text: string, index: number): string {
	if (!text) return "";
	const start = text.lastIndexOf("\n", index);
	const end = text.indexOf("\n", index);
	const line = text.slice(start === -1 ? 0 : start + 1, end === -1 ? text.length : end);
	return trimEvidence(line);
}

function fallbackEvidence(text: string): string {
	if (!text) return "";
	const trimmed = text.trim();
	if (trimmed.length <= 200) return trimmed;
	return trimmed.slice(-200);
}

function matchFirst(text: string, patterns: RegExp[]): { evidence: string } | undefined {
	for (const pattern of patterns) {
		const m = pattern.exec(text);
		if (m) {
			return { evidence: extractLineAt(text, m.index) };
		}
	}
	return undefined;
}

/**
 * Classify a sandboxed command failure into a structured type.
 *
 * This is best-effort heuristics. We prefer avoiding false positives.
 */
export function classifySandboxFailure(output: string): SandboxFailure {
	const text = output ?? "";

	// Filesystem: typical write-denied signals (high confidence)
	{
		const hit = matchFirst(text, [
			/read-only file system/i,
			/\bEROFS\b/i,
			/permission denied/i,
			/\bEACCES\b/i,
			/operation not permitted/i,
			/\bEPERM\b/i,
		]);
		if (hit) {
			return {
				kind: "filesystem",
				subtype: "write",
				confidence: "high",
				evidence: hit.evidence,
			};
		}
	}

	// Filesystem: ENOENT on temp paths (medium confidence) - files created in /tmp
	// during a previous tool call may not exist if /tmp is an ephemeral tmpfs mount
	// (read-only sandbox mode). This manifests as "No such file or directory" for
	// paths under /tmp.
	{
		const enoentPattern = /no such file or directory[^]*?\/tmp\//i;
		const enoentPattern2 = /\/tmp\/[^\s'"]+[^]*?no such file or directory/i;
		const enoentPattern3 = /\bENOENT\b[^]*?\/tmp\//i;
		const hit = matchFirst(text, [enoentPattern, enoentPattern2, enoentPattern3]);
		if (hit) {
			return {
				kind: "filesystem",
				subtype: "read",
				confidence: "medium",
				evidence: hit.evidence,
			};
		}
	}

	// Network: DNS failures (medium confidence)
	{
		const hit = matchFirst(text, [
			/could not resolve host/i,
			/temporary failure in name resolution/i,
			/\bENOTFOUND\b/i,
			/\bEAI_AGAIN\b/i,
			/getaddrinfo\s+ENOTFOUND/i,
			/getaddrinfo\s+EAI_AGAIN/i,
		]);
		if (hit) {
			return {
				kind: "network",
				subtype: "dns",
				confidence: "medium",
				evidence: hit.evidence,
			};
		}
	}

	// Network: generic connectivity failures (medium confidence)
	{
		const hit = matchFirst(text, [
			/network is unreachable/i,
			/no route to host/i,
			/connection refused/i,
			/connection timed out/i,
			/timed out/i,
			/\bECONNREFUSED\b/i,
			/\bETIMEDOUT\b/i,
			/\bEHOSTUNREACH\b/i,
			/\bENETUNREACH\b/i,
		]);
		if (hit) {
			return {
				kind: "network",
				subtype: "connect",
				confidence: "medium",
				evidence: hit.evidence,
			};
		}
	}

	return {
		kind: "unknown",
		confidence: "low",
		evidence: trimEvidence(fallbackEvidence(text)),
	};
}
