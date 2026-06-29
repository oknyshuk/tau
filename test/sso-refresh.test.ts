import { describe, expect, it } from "vitest";

import { latestExpiry, parseAwsConfig, resolveStartUrl } from "../src/sso/index.js";

const CONFIG = `
# a comment
[default]
region = us-east-1

[profile bedrock]
sso_session = corp
region = us-west-2

[profile direct]
sso_start_url = https://direct.awsapps.com/start

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start/
sso_region = us-east-1
`;

describe("parseAwsConfig / resolveStartUrl", () => {
	const sections = parseAwsConfig(CONFIG);

	it("parses sections while ignoring comments and blanks", () => {
		expect(sections.get("profile bedrock")).toEqual({ sso_session: "corp", region: "us-west-2" });
		expect(sections.get("sso-session corp")?.["sso_start_url"]).toBe(
			"https://corp.awsapps.com/start/",
		);
	});

	it("follows sso_session indirection and reads direct urls", () => {
		expect(resolveStartUrl(sections, "bedrock")).toBe("https://corp.awsapps.com/start/");
		expect(resolveStartUrl(sections, "direct")).toBe("https://direct.awsapps.com/start");
	});

	it("returns undefined for unknown or url-less profiles", () => {
		expect(resolveStartUrl(sections, "missing")).toBeUndefined();
		expect(resolveStartUrl(sections, "default")).toBeUndefined();
	});
});

describe("latestExpiry", () => {
	const target = "https://corp.awsapps.com/start";

	it("picks the latest matching entry, normalizing trailing slashes", () => {
		const entries = [
			{ startUrl: "https://corp.awsapps.com/start/", expiresAt: "2026-06-29T12:30:00.000Z" },
			{ startUrl: "https://corp.awsapps.com/start", expiresAt: "2026-06-29T13:30:00.000Z" },
			{ startUrl: "https://other.awsapps.com/start", expiresAt: "2026-06-29T20:00:00.000Z" },
		];
		expect(latestExpiry(entries, target)).toBe(Date.parse("2026-06-29T13:30:00.000Z"));
	});

	it("ignores non-records and malformed entries, returning -Infinity when none match", () => {
		expect(latestExpiry([null, 5, "x", { startUrl: "https://nope/" }], target)).toBe(
			Number.NEGATIVE_INFINITY,
		);
	});
});
