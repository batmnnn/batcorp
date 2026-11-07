import { expect, test } from "bun:test";
import { uiHosts } from "../src/ui/server.ts";

test("the local UI answers only local origins, plus a codespace's own forwarded address", () => {
  expect([...uiHosts(4173, {})]).toEqual(["127.0.0.1:4173", "localhost:4173"]);
  const cs = { CODESPACES: "true", CODESPACE_NAME: "judge-fluffy-robot-x5g7", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev" };
  expect(uiHosts(4173, cs).has("judge-fluffy-robot-x5g7-4173.app.github.dev")).toBe(true);
  expect(uiHosts(4173, { ...cs, CODESPACES: undefined }).size).toBe(2);
  expect(uiHosts(4173, { ...cs, CODESPACE_NAME: "evil.example/x" }).size).toBe(2);
  expect(uiHosts(4173, { ...cs, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "evil example" }).size).toBe(2);
});
