import { describe, expect, it } from "vitest";
import { clean, goalName, params } from "../src/validate";

describe("goal names", () => {
  it.each([
    ["signup", "signup"],
    ["Sign Up", "sign_up"],
    ["initiate:checkout", "initiate:checkout"],
    ["newsletter-signup", "newsletter-signup"],
    ["  add_to_cart  ", "add_to_cart"],
    ["a".repeat(64), "a".repeat(64)],
  ])("%s → %s", (input, out) => expect(goalName(input)).toBe(out));

  it.each([["a".repeat(65)], [""], ["bad!"], ["émoji"], [42], [null]])("rejects %s", (input) => {
    expect(goalName(input)).toBeNull();
  });
});

describe("parameters", () => {
  it("keeps numbers and booleans, cleans strings, skips null", () => {
    expect(params({ Plan: "pro", n: 1, ok: false, gone: null, also: undefined })).toEqual({
      plan: "pro",
      n: 1,
      ok: false,
    });
  });
  it("rejects bad names and more than 10", () => {
    expect(params({ "a b": 1 })).toBe('invalid parameter name "a b"');
    expect(params(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i])))).toBe(
      "maximum 10 custom parameters allowed",
    );
    expect(params("nope")).toBe("parameters must be an object");
    expect(params(undefined)).toEqual({});
  });
  it("strips dangerous characters and caps values", () => {
    expect(clean(`<a href="x" onclick='y'>&</a>`)).toBe("a href=x y/a");
    expect(clean("JavaScript:alert(1)")).toBe("alert(1)");
    expect(clean("vbscript:x data:y")).toBe("x y");
    expect(clean("z".repeat(300))).toHaveLength(255);
    expect(clean(12)).toBe("12");
  });
});
