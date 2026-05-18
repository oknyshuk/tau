import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Context, Layer } from "effect";

export class PiAPI extends Context.Service<PiAPI, ExtensionAPI>()("PiAPI") {}

export const PiAPILive = (pi: ExtensionAPI) => Layer.succeed(PiAPI, pi);
