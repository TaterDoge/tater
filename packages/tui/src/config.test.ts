import { describe, expect, test } from "bun:test";
import { getConfigDir } from "./config";

describe("getConfigDir", () => {
  test("uses XDG_CONFIG_HOME", () => {
    expect(getConfigDir({ XDG_CONFIG_HOME: "/tmp/config" })).toBe(
      "/tmp/config/tater"
    );
  });

  test("defaults to ~/.config", () => {
    expect(getConfigDir({ HOME: "/home/user" })).toBe(
      "/home/user/.config/tater"
    );
  });
});
