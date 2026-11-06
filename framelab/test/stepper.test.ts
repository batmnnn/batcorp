import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { engineJwt } from "../src/env/stepper.ts";

test("engine JWT is HS256 over iat and verifies with the secret", () => {
  const secret = Buffer.alloc(32, 7);
  const token = engineJwt(secret, 1_700_000_000);
  const [header, payload, signature] = token.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 1_700_000_000 });
  expect(signature).toBe(createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
});
