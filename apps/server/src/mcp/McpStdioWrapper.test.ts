// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  isAbsoluteWrapperPath,
  McpStdioWrapperConfigError,
  parseMcpStdioWrapperCommand,
  resolveT3McpTransport,
  T3_MCP_AUTHORIZATION_ENV,
  T3_MCP_STDIO_WRAPPER_ENV,
  T3_MCP_URL_ENV,
} from "./McpStdioWrapper.ts";

const session = {
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer fixture-session-token",
};

describe("resolveT3McpTransport", () => {
  const executable = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-wrapper-"));
  const binary = NodePath.join(executable, "wrapper");
  NodeFS.writeFileSync(binary, "");

  it("leaves the HTTP transport unchanged when the setting is unset", () => {
    assert.deepEqual(resolveT3McpTransport(session, { environment: {} }), {
      kind: "http",
      endpoint: session.endpoint,
      authorizationHeader: session.authorizationHeader,
    });
  });

  it("launches a stdio wrapper with the credential only in the environment", () => {
    const transport = resolveT3McpTransport(session, {
      environment: {
        [T3_MCP_STDIO_WRAPPER_ENV]: `${binary} --listen stdio`,
      },
    });
    assert.deepEqual(transport, {
      kind: "stdio",
      command: binary,
      args: ["--listen", "stdio"],
      env: {
        [T3_MCP_URL_ENV]: session.endpoint,
        [T3_MCP_AUTHORIZATION_ENV]: session.authorizationHeader,
      },
    });
    assert.notInclude(
      JSON.stringify([
        transport.kind === "stdio" ? transport.command : "",
        ...(transport.kind === "stdio" ? transport.args : []),
      ]),
      "fixture-session-token",
    );
    assert.notInclude(
      JSON.stringify(transport.kind === "stdio" ? transport.args : []),
      session.endpoint,
    );
  });

  it.each([
    ["relative path", `${NodePath.relative(process.cwd(), binary)} --listen stdio`],
    ["dot relative path", `./${NodePath.relative(process.cwd(), binary)}`],
    ["missing file", NodePath.join(executable, "missing")],
    ["unmatched quote", `${binary} "unterminated`],
    ["empty value", "   "],
  ] as const)("refuses a %s", (_label, value) => {
    try {
      resolveT3McpTransport(session, {
        environment: { [T3_MCP_STDIO_WRAPPER_ENV]: value },
      });
      assert.fail("expected the wrapper setting to be refused");
    } catch (error) {
      assert.instanceOf(error, McpStdioWrapperConfigError);
      assert.include(error.message, T3_MCP_STDIO_WRAPPER_ENV);
      assert.notInclude(error.message, "fixture-session-token");
    }
  });

  it("treats a directory as a missing executable", () => {
    try {
      resolveT3McpTransport(session, {
        environment: { [T3_MCP_STDIO_WRAPPER_ENV]: executable },
      });
      assert.fail("expected a directory to be refused");
    } catch (error) {
      assert.instanceOf(error, McpStdioWrapperConfigError);
    }
  });
});

describe("parseMcpStdioWrapperCommand", () => {
  it("preserves empty quoted fixed arguments", () => {
    assert.deepEqual(parseMcpStdioWrapperCommand(`/opt/wrap "" --flag ''`), {
      command: "/opt/wrap",
      args: ["", "--flag", ""],
    });
  });
  it("keeps quoted arguments together and does not expand them", () => {
    assert.deepEqual(parseMcpStdioWrapperCommand(`/opt/wrap --flag "two words" 'a$b'`), {
      command: "/opt/wrap",
      args: ["--flag", "two words", "a$b"],
    });
  });
});

describe("isAbsoluteWrapperPath", () => {
  it.each([
    ["/opt/wrap", true],
    ["C:\\tools\\wrap.exe", true],
    ["c:/tools/wrap", true],
    ["\\\\host\\share\\wrap", true],
    ["wrap", false],
    ["./wrap", false],
    ["C:wrap", false],
    ["", false],
  ] as const)("classifies %j as absolute=%s", (value, absolute) => {
    assert.equal(isAbsoluteWrapperPath(value), absolute);
  });
});
