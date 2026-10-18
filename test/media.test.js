import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { assertMediaUrl } from "../src/media.js";

test("assertMediaUrl accepts http(s) media addresses", () => {
  assert.equal(assertMediaUrl("https://cdn.example/a.ts").hostname, "cdn.example");
  assert.equal(assertMediaUrl("http://cdn.example/a.m3u8").protocol, "http:");
});

test("assertMediaUrl rejects empty and non-http addresses", () => {
  assert.throws(() => assertMediaUrl(""), AppError);
  assert.throws(() => assertMediaUrl("file:///tmp/a.ts"), AppError);
  assert.throws(() => assertMediaUrl("not a url"), AppError);
});
