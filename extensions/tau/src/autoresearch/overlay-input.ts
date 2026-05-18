import { Key, matchesKey } from "@earendil-works/pi-tui";

export function shouldCloseAutoresearchOverlay(data: string): boolean {
	return (
		matchesKey(data, Key.escape) ||
		matchesKey(data, Key.esc) ||
		matchesKey(data, Key.ctrlShift("x")) ||
		data === "q" ||
		data === "Q"
	);
}
