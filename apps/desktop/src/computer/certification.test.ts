import { describe, expect, it } from "vitest";
import { computerCertificationStatus, COMPUTER_CONTROL_CERTIFIED } from "./certification";
describe("preview availability is not certification", () => {
  it("permits macOS 14+ packaged opt-in preview without a development bypass", () => {
    expect(COMPUTER_CONTROL_CERTIFIED).toEqual({ darwin: false, win32: false });
    expect(computerCertificationStatus("darwin", true, undefined, "23.0.0")).toEqual({
      available: true,
    });
    expect(computerCertificationStatus("darwin", true, undefined, "22.0.0")).toMatchObject({
      reason: "os-too-old",
    });
  });
  it("keeps Windows packaged and Linux unavailable", () => {
    expect(computerCertificationStatus("win32", true, "1", "10.0.22631")).toMatchObject({
      reason: "not-certified",
    });
    expect(computerCertificationStatus("linux", false, "1", "6.0.0")).toMatchObject({
      reason: "unsupported-platform",
    });
  });
});
