import { createHash } from "node:crypto";
import { Effect } from "effect";

import { BacklogIdGenerationError } from "./errors.js";

const base36Alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

function encodeBase36(bytes: Uint8Array, length: number): string {
	let num = 0n;
	for (const byte of bytes) {
		num = (num << 8n) + BigInt(byte);
	}

	let chars = "";
	while (num > 0n) {
		const mod = Number(num % 36n);
		chars = base36Alphabet[mod] + chars;
		num /= 36n;
	}

	if (chars.length < length) {
		chars = "0".repeat(length - chars.length) + chars;
	}

	if (chars.length > length) {
		chars = chars.slice(chars.length - length);
	}

	return chars;
}

function toUnixNanos(date: Date): string {
	const ms = BigInt(date.getTime());
	return (ms * 1_000_000n).toString();
}

function hashSha256(value: string): Uint8Array {
	const digest = createHash("sha256").update(value, "utf8").digest();
	return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

export function generateHashId(
	prefix: string,
	title: string,
	description: string,
	creator: string,
	timestamp: Date,
	length: number,
	nonce: number,
): string {
	const content = `${title}|${description}|${creator}|${toUnixNanos(timestamp)}|${nonce}`;
	const digest = hashSha256(content);

	let numBytes = 3;
	switch (length) {
		case 3:
			numBytes = 2;
			break;
		case 4:
			numBytes = 3;
			break;
		case 5:
		case 6:
			numBytes = 4;
			break;
		case 7:
		case 8:
			numBytes = 5;
			break;
	}

	const shortHash = encodeBase36(digest.slice(0, numBytes), length);
	return `${prefix}-${shortHash}`;
}

function collisionProbability(count: number, length: number): number {
	const total = Math.pow(36, length);
	const exponent = -(count * count) / (2 * total);
	return 1 - Math.exp(exponent);
}

function computeAdaptiveLength(count: number): number {
	for (let length = 3; length <= 8; length += 1) {
		if (collisionProbability(count, length) <= 0.25) {
			return length;
		}
	}
	return 8;
}

const generateIssueId = (params: {
	readonly prefix: string;
	readonly title: string;
	readonly description?: string;
	readonly creator: string;
	readonly timestamp: Date;
	readonly existingIds: ReadonlySet<string>;
	readonly existingTopLevelCount: number;
}): string | undefined => {
	const baseLength = computeAdaptiveLength(params.existingTopLevelCount);

	for (let length = Math.min(baseLength, 8); length <= 8; length += 1) {
		for (let nonce = 0; nonce < 10; nonce += 1) {
			const candidate = generateHashId(
				params.prefix,
				params.title,
				params.description ?? "",
				params.creator,
				params.timestamp,
				length,
				nonce,
			);

			if (!params.existingIds.has(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
};

const generateChildId = (parentId: string, childNumber: number, maxDepth = 3): string | undefined => {
	const depth = parentId.split(".").length - 1;
	if (depth >= maxDepth) {
		return undefined;
	}
	return `${parentId}.${childNumber}`;
};

export const generateIssueIdEffect = (params: {
	readonly prefix: string;
	readonly title: string;
	readonly description?: string;
	readonly creator: string;
	readonly timestamp: Date;
	readonly existingIds: ReadonlySet<string>;
	readonly existingTopLevelCount: number;
}): Effect.Effect<string, BacklogIdGenerationError, never> =>
	Effect.gen(function* () {
		const id = generateIssueId(params);
		if (id) {
			return id;
		}
		return yield* Effect.fail(
			new BacklogIdGenerationError({
				prefix: params.prefix,
				reason: "Failed to generate unique issue id",
			}),
		);
	});

export const generateChildIdEffect = (
	parentId: string,
	childNumber: number,
	maxDepth = 3,
): Effect.Effect<string, BacklogIdGenerationError, never> =>
	Effect.gen(function* () {
		const childId = generateChildId(parentId, childNumber, maxDepth);
		if (childId) {
			return childId;
		}
		return yield* Effect.fail(
			new BacklogIdGenerationError({
				prefix: parentId,
				reason: `Maximum hierarchy depth (${maxDepth}) exceeded for ${parentId}`,
			}),
		);
	});

export function nextChildNumber(parentId: string, existingIds: ReadonlySet<string>): number {
	let maxChild = 0;
	const prefix = `${parentId}.`;

	for (const id of existingIds) {
		if (!id.startsWith(prefix)) {
			continue;
		}
		const suffix = id.slice(prefix.length);
		const segment = suffix.split(".")[0];
		if (!segment) {
			continue;
		}
		const parsed = Number.parseInt(segment, 10);
		if (!Number.isNaN(parsed)) {
			maxChild = Math.max(maxChild, parsed);
		}
	}

	return maxChild + 1;
}
