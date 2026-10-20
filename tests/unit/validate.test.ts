import { cleanName, isValidName, isValidEmail } from "../../src/utils/validate";

describe("name rules", () => {
  it("cleans extra spaces", () => {
    expect(cleanName("  Maha   Hafeez ")).toBe("Maha Hafeez");
  });
  it("accepts Maha Hafeez", () => {
    expect(isValidName("Maha Hafeez")).toBe(true);
  });
  it("rejects a 1-character name", () => {
    expect(isValidName("M")).toBe(false);
  });
  it("rejects a name over 60 characters", () => {
    expect(isValidName("M".repeat(61))).toBe(false);
  });
});

describe("email rules", () => {
  it("accepts maha.hafeez@company.com", () => {
    expect(isValidEmail("maha.hafeez@company.com")).toBe(true);
  });
  it("rejects an email with no @", () => {
    expect(isValidEmail("maha.hafeez.company.com")).toBe(false);
  });
});
