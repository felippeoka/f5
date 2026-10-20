import { describe, expect, it } from "vitest";
import { Utf8Lines } from "./utf8Lines";

describe("UTF-8 line framing", () => {
  it("preserves every byte partition, empty lines and final unterminated output", () => {
    const bytes = new TextEncoder().encode('🙂\r\n\n{"text":"résumé中"}');
    for (let width = 1; width <= bytes.length; width++) {
      const framer = new Utf8Lines();
      const actual: string[] = [];
      for (let index = 0; index < bytes.length; index += width)
        actual.push(...framer.push(bytes.subarray(index, index + width)));
      actual.push(...framer.finish());
      expect(actual).toEqual(["🙂", "", '{"text":"résumé中"}']);
      expect(framer.finish()).toEqual([]);
    }
  });
  it("accepts large Codex frames while bounded transports enforce their own policy", () => {
    const huge = "x".repeat(17 * 1024 * 1024);
    expect(new Utf8Lines().push(huge + "\n")).toEqual([huge]);
    expect(() => new Utf8Lines(8).push("🙂🙂x")).toThrow("limit");
    const stderr = new Utf8Lines(8, "truncate");
    expect(stderr.push("🙂🙂x\nnext\n")).toEqual(["🙂🙂 [truncated]", "next"]);
  });
});
