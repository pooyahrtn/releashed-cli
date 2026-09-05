import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_CONTENT_CLASSIFICATION,
  EXPLORER_MAXIMUM_INPUT_TOKENS,
  EXPLORER_MAXIMUM_OUTPUT_TOKENS
} from "../lib/explorer-protocol.mjs";
import { validateExplorerModelConfig } from "../lib/explorer-model-runtime.mjs";
import { BrokerProcess } from "./browser-broker-process.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_EXPLORER_CONTENT_BYTES = EXPLORER_MAXIMUM_INPUT_TOKENS - 16;

export function explorerModelBrokerEnvironment(source = process.env) {
  return {
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    OPENAI_API_KEY: source.OPENAI_API_KEY ?? ""
  };
}

function exactExplorerRequest(payload) {
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).sort().join("\n") === ["method", "content", "content_classification", "maximum_input_tokens", "maximum_output_tokens"].sort().join("\n") &&
    payload.method === "request" &&
    typeof payload.content === "string" &&
    payload.content.length > 0 &&
    Buffer.byteLength(payload.content, "utf8") <= MAX_EXPLORER_CONTENT_BYTES &&
    payload.content_classification === EXPLORER_CONTENT_CLASSIFICATION &&
    payload.maximum_input_tokens === EXPLORER_MAXIMUM_INPUT_TOKENS &&
    payload.maximum_output_tokens === EXPLORER_MAXIMUM_OUTPUT_TOKENS
  );
}

export class ExplorerModelBrokerProcess extends BrokerProcess {
  constructor(configPath, absoluteDeadlineMs, {
    brokerFile = join(repository, "supervisor", "model-broker.mjs"),
    environmentSource = process.env,
    readyTimeoutMs = 10_000,
    callTimeoutMs = 65_000
  } = {}) {
    const metadata = lstatSync(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) throw new Error("Explorer model configuration must be an ordinary mode-0600 file");
    validateExplorerModelConfig(JSON.parse(readFileSync(configPath, "utf8")));
    super(brokerFile, configPath, absoluteDeadlineMs, {
      label: "Explorer model broker",
      environment: explorerModelBrokerEnvironment(environmentSource),
      readyTimeoutMs,
      callTimeoutMs
    });
  }

  call(payload) {
    if (!exactExplorerRequest(payload)) return Promise.reject(new Error("Explorer model request escaped the fixed decision contract"));
    return super.call(payload, "explorer-supervisor");
  }
}
