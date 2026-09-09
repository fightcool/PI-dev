import { describe, expect, test } from "vitest";
import { resolveBase, withAppBase } from "../../web/src/base-url";

describe("PI-dev /dev base path", () => {
  test("normalizes with trailing slash", () => {
    expect(resolveBase("/dev")).toBe("/dev/");
    expect(resolveBase("/dev/")).toBe("/dev/");
    expect(resolveBase("/dev/index.html")).toBe("/dev/");
  });

  test("keeps application URLs inside the configured subpath", () => {
    expect(withAppBase("/api/health", "/dev/")).toBe("/dev/api/health");
    expect(withAppBase("/ws", "/dev/")).toBe("/dev/ws");
    expect(withAppBase("/assets/app.js", "/")).toBe("/assets/app.js");
  });
});
