import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { projectPaths, resolveConfigInfos, userConfigPath } from "../src/config/paths.ts";

describe("userConfigPath", () => {
  test("resolves under $HOME/.zcode/cli", () => {
    expect(userConfigPath({ HOME: "/home/test" })).toBe(path.join("/home/test", ".zcode", "cli", "config.json"));
  });

  test("honors ZCODE_CONFIG_DIR override", () => {
    expect(userConfigPath({ ZCODE_CONFIG_DIR: "/data/zc" })).toBe(path.join("/data/zc", ".zcode", "cli", "config.json"));
  });
});

describe("projectPaths", () => {
  test("prefers .zcode/config.json as editable target", () => {
    const paths = projectPaths("/work/repo");
    expect(paths.editable).toBe(path.join("/work/repo", ".zcode", "config.json"));
    expect(paths.alternate).toBe(path.join("/work/repo", "zcode.json"));
  });
});

describe("resolveConfigInfos", () => {
  function tmpProject(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-paths-"));
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return root;
  }

  test("no project files: project info points at editable path, not existing", () => {
    const root = tmpProject({});
    const { project } = resolveConfigInfos(root, {
      env: { HOME: "/home/test" },
      readFile: () => null,
    });
    expect(project.exists).toBe(false);
    expect(project.path.endsWith(path.join(".zcode", "config.json"))).toBe(true);
  });

  test("prefers .zcode/config.json when both project files exist", () => {
    const root = tmpProject({
      "zcode.json": JSON.stringify({ model: { main: "a/b" } }),
      ".zcode/config.json": JSON.stringify({ model: { main: "c/d" } }),
    });
    const { project } = resolveConfigInfos(root, {
      env: { HOME: "/home/test" },
      readFile: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
    });
    expect(project.kind).toBe(".zcode/config.json");
    expect(project.config?.model?.main).toBe("c/d");
  });

  test("falls back to zcode.json when only it exists", () => {
    const root = tmpProject({ "zcode.json": JSON.stringify({ model: { main: "a/b" } }) });
    const { project } = resolveConfigInfos(root, {
      env: { HOME: "/home/test" },
      readFile: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
    });
    expect(project.kind).toBe("zcode.json");
    expect(project.config?.model?.main).toBe("a/b");
  });

  test("surfaces parse errors without throwing", () => {
    const root = tmpProject({ "zcode.json": "{broken" });
    const { project } = resolveConfigInfos(root, {
      env: { HOME: "/home/test" },
      readFile: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
    });
    expect(project.parseError).not.toBeNull();
    expect(project.config).toBeNull();
  });
});
