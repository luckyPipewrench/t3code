// Synchronous stat keeps session configuration builders out of the Effect runtime.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import type { McpProviderSessionConfig } from "./McpProviderSession.ts";

/**
 * Operator setting for a local stdio process that sits in front of the
 * per-session t3-code MCP HTTP endpoint. The value is an absolute executable
 * path plus optional fixed arguments, separated by whitespace. Quotes group
 * an argument; nothing is expanded and nothing is passed to a shell.
 */
export const T3_MCP_STDIO_WRAPPER_ENV = "T3_MCP_STDIO_WRAPPER";

/** Endpoint URL given to the wrapper. Never placed on the command line. */
export const T3_MCP_URL_ENV = "T3_MCP_URL";

/** Authorization header value given to the wrapper. Never placed on the command line. */
export const T3_MCP_AUTHORIZATION_ENV = "T3_MCP_AUTHORIZATION";

export class McpStdioWrapperConfigError extends Error {
  override readonly name = "McpStdioWrapperConfigError";
}

export interface McpStdioWrapperLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type ResolvedT3McpTransport =
  | {
      readonly kind: "http";
      readonly endpoint: string;
      readonly authorizationHeader: string;
    }
  | ({
      readonly kind: "stdio";
    } & McpStdioWrapperLaunch);

export interface ResolveT3McpTransportOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fileExists?: (path: string) => boolean;
}

/** POSIX root, Windows drive root, or UNC path. */
export function isAbsoluteWrapperPath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

function wrapperFileExists(path: string): boolean {
  try {
    if (!NodeFS.statSync(path).isFile()) return false;
    // Windows has no POSIX execute permission bit; process launch checks the
    // executable format there. On POSIX, reject an unusable file up front.
    if (HostProcessPlatform.defaultValue() !== "win32")
      NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fail(detail: string): never {
  throw new McpStdioWrapperConfigError(
    `${T3_MCP_STDIO_WRAPPER_ENV} is set but cannot be used: ${detail}`,
  );
}

/**
 * Splits a wrapper command into argv. Unmatched quotes and an empty command
 * are configuration errors. Backslashes are literal characters.
 */
export function parseMcpStdioWrapperCommand(value: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  const tokens: Array<string> = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let sawToken = false;
  for (const character of value) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        sawToken = true;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      sawToken = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      if (current.length > 0 || sawToken) {
        tokens.push(current);
        current = "";
        sawToken = false;
      }
      continue;
    }
    current += character;
    sawToken = true;
  }
  if (quote !== null) {
    fail("the command has an unmatched quote");
  }
  if (current.length > 0 || sawToken) {
    tokens.push(current);
  }
  const command = tokens[0];
  if (command === undefined || command.length === 0) {
    fail("the command is empty");
  }
  return { command, args: tokens.slice(1) };
}

/**
 * Unset means the direct HTTP transport. A present value that is not an
 * absolute path to an existing file refuses the session instead of connecting
 * directly.
 */
export function resolveT3McpTransport(
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
  options: ResolveT3McpTransportOptions = {},
): ResolvedT3McpTransport {
  const environment = options.environment ?? process.env;
  const configured = environment[T3_MCP_STDIO_WRAPPER_ENV];
  if (configured === undefined) {
    return {
      kind: "http",
      endpoint: session.endpoint,
      authorizationHeader: session.authorizationHeader,
    };
  }
  const parsed = parseMcpStdioWrapperCommand(configured);
  if (!isAbsoluteWrapperPath(parsed.command)) {
    fail("the executable path must be absolute");
  }
  const exists = options.fileExists ?? wrapperFileExists;
  if (!exists(parsed.command)) {
    fail(`the executable does not exist, is not a file, or is not executable (${parsed.command})`);
  }
  return {
    kind: "stdio",
    command: parsed.command,
    args: parsed.args,
    env: {
      [T3_MCP_URL_ENV]: session.endpoint,
      [T3_MCP_AUTHORIZATION_ENV]: session.authorizationHeader,
    },
  };
}

export type OpenCodeT3McpConfig =
  | {
      readonly type: "remote";
      readonly url: string;
      readonly headers: { readonly Authorization: string };
      readonly oauth: false;
    }
  | {
      readonly type: "local";
      readonly command: Array<string>;
      readonly environment: Record<string, string>;
    };

/** OpenCode 1.x and OpenCode 2 both accept this local-or-remote MCP config. */
export function openCodeT3McpConfig(
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
  options?: ResolveT3McpTransportOptions,
): OpenCodeT3McpConfig {
  const transport = resolveT3McpTransport(session, options);
  if (transport.kind === "stdio") {
    return {
      type: "local",
      command: [transport.command, ...transport.args],
      environment: { ...transport.env },
    };
  }
  return {
    type: "remote",
    url: session.endpoint,
    headers: { Authorization: session.authorizationHeader },
    oauth: false,
  };
}
