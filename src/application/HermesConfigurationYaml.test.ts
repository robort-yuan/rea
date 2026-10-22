import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  editHermesConfigurationYaml,
  parseHermesConfigurationYaml,
  stringifyHermesConfigurationYaml,
} from "./HermesConfigurationYaml.js";

it("refreshes an anchored entry without changing another server's resolved value", () => {
  const source =
    "mcp_servers:\n  rea: &server\n    command: old\n    enabled: false\n  other: *server # Independent server\n";
  const updated = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
    command: "rea",
    enabled: true,
  });
  expect(parseHermesConfigurationYaml(updated)).toEqual({
    mcp_servers: {
      rea: { command: "rea", enabled: true },
      other: { command: "old", enabled: false },
    },
  });
  expect(updated).toContain("# Independent server");
});

describe("Hermes surviving anchor definitions", () => {
  for (const shadowed of [false, true]) {
    it.each([undefined, { command: "rea" }])(
      `retains surviving shared target identity with shadowed=${shadowed} when writing %j`,
      (entry) => {
        const source =
          "defaults: &settings {MODE: 'off'}\nmcp_servers:\n  rea: &server\n    command: old\n    env: *settings\n" +
          (shadowed ? "later: &settings {MODE: 'later'}\n" : "") +
          "observer: *server\npeer: *settings\n";
        const result = parse(
          editHermesConfigurationYaml(source, ["mcp_servers", "rea"], entry),
        );
        expect(result.defaults).toEqual({ MODE: "off" });
        expect(result.observer.env).toBe(result.defaults);
        expect(result.peer).toBe(shadowed ? result.later : result.defaults);
        if (shadowed) expect(result.peer).not.toBe(result.defaults);
      },
    );
  }

  it.each(["settings", "missing"])(
    "still refuses a surviving %s dependency that cannot be retained",
    (reference) => {
      const source = `defaults: &settings {dependency: *${reference}}\nmcp_servers:\n  rea: &server {env: *settings}\nobserver: *server\n`;
      expect(() =>
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ).toThrow();
    },
  );
});

describe("Hermes anchored-entry consumers", () => {
  it.each([undefined, { command: "rea" }])(
    "preserves an anchored registration key when writing %j",
    (entry) => {
      const source =
        "mcp_servers:\n  &server_name rea: {command: old}\nobserver: *server_name # Keep registration name\n";
      const updated = editHermesConfigurationYaml(
        source,
        ["mcp_servers", "rea"],
        entry,
      );
      expect(parseHermesConfigurationYaml(updated)).toEqual({
        mcp_servers: entry === undefined ? {} : { rea: entry },
        observer: "rea",
      });
      expect(updated).toContain("# Keep registration name");
      if (entry !== undefined) {
        expect(updated).toContain("&server_name rea:");
        expect(updated).toContain("*server_name");
      }
    },
  );

  it("preserves both key and value consumers of a removed pair", () => {
    const source =
      "mcp_servers:\n  &server_name rea: &server {command: old}\n  other: *server\nobserver: *server_name\nlater: &server_name later\nlater_observer: *server_name\n";
    expect(
      parseHermesConfigurationYaml(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ),
    ).toEqual({
      mcp_servers: { other: { command: "old" } },
      observer: "rea",
      later: "later",
      later_observer: "later",
    });
  });

  it.each([undefined, { command: "rea" }])(
    "preserves references to an anchored child when writing %j",
    (entry) => {
      const source =
        "mcp_servers:\n  rea:\n    command: old\n    env: &settings\n      MODE: 'off'\n  other:\n    command: other\n    env: *settings\n";
      const result = parseHermesConfigurationYaml(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], entry),
      );
      expect(result).toEqual({
        mcp_servers: {
          ...(entry === undefined ? {} : { rea: entry }),
          other: { command: "other", env: { MODE: "off" } },
        },
      });
    },
  );

  it.each([undefined, { command: "rea" }])(
    "retains nested alias comments when writing %j",
    (entry) => {
      const source =
        "defaults: &settings {MODE: 'old'}\nmcp_servers:\n  rea: &entry\n    command: old\n    env:\n      # Keep nested leading comment\n      *settings # Keep nested reference comment\n  other: *entry # Keep external reference comment\n";
      const updated = editHermesConfigurationYaml(
        source,
        ["mcp_servers", "rea"],
        entry,
      );
      expect(parseHermesConfigurationYaml(updated)).toEqual({
        defaults: { MODE: "old" },
        mcp_servers: {
          ...(entry === undefined ? {} : { rea: entry }),
          other: { command: "old", env: { MODE: "old" } },
        },
      });
      expect(updated).toContain("# Keep nested leading comment");
      expect(updated).toContain("# Keep nested reference comment");
      expect(updated).toContain("# Keep external reference comment");
    },
  );

  it("binds copied nested aliases before a later anchor reuses their name", () => {
    const source =
      "defaults: &settings {MODE: 'old'}\nmcp_servers:\n  rea: &entry\n    command: old\n    env: *settings\nlater: &settings {MODE: 'later'}\nobserver: *entry\n";
    const result = parseHermesConfigurationYaml(
      editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
        command: "rea",
      }),
    );
    expect(result).toEqual({
      defaults: { MODE: "old" },
      mcp_servers: { rea: { command: "rea" } },
      later: { MODE: "later" },
      observer: { command: "old", env: { MODE: "old" } },
    });
  });

  it("changes only consumers of the removed definition when an anchor name repeats", () => {
    const source =
      "mcp_servers:\n  rea: &server {command: old}\n  other: *server\nlater: &server {command: later}\nobserver: *server\n";
    expect(
      parseHermesConfigurationYaml(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ),
    ).toEqual({
      mcp_servers: { other: { command: "old" } },
      later: { command: "later" },
      observer: { command: "later" },
    });
  });

  it.each([true, false])(
    "keeps shared child identity with child first=%s",
    (childFirst) => {
      const child = "child: *settings\n";
      const parent = "parent: *entry\n";
      const source =
        "mcp_servers:\n  rea: &entry\n    command: old\n    env: &settings {MODE: 'off'}\n" +
        (childFirst ? child + parent : parent + child);
      const result = parse(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      );
      expect(result).toEqual({
        mcp_servers: {},
        child: { MODE: "off" },
        parent: { command: "old", env: { MODE: "off" } },
      });
      expect(result.child).toBe(result.parent.env);
    },
  );

  it("retains one source copy for repeated consumers instead of expanding every alias", () => {
    const source =
      "mcp_servers:\n  rea: &server {command: old}\nobservers:\n" +
      "  - *server\n".repeat(50);
    const updated = editHermesConfigurationYaml(
      source,
      ["mcp_servers", "rea"],
      undefined,
    );
    expect(parseHermesConfigurationYaml(updated)).toEqual({
      mcp_servers: {},
      observers: Array.from({ length: 50 }, () => ({ command: "old" })),
    });
    expect(updated.match(/command: old/gu)).toHaveLength(1);
  });

  it.each(["server", "missing"])(
    "still refuses a copied %s dependency that cannot be retained",
    (reference) => {
      const source = `mcp_servers:\n  rea: &server\n    command: old\n    dependency: *${reference}\nobserver: *server\n`;
      expect(() =>
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ).toThrow();
    },
  );
});

describe("Hermes configuration YAML", () => {
  it("retains a quoted sequence element when replacing its registration", () => {
    const source =
      "mcp_servers:\n  rea:\n    command: old\n    args:\n      - 'mcp'\n";
    expect(
      editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
        command: "rea",
        args: ["mcp"],
      }),
    ).toBe(source.replace("command: old", "command: rea"));
  });

  it("retains explicit string tags on unchanged keys and values", () => {
    const source =
      "%YAML 1.2\n---\nmcp_servers:\n  rea:\n    command: old\n    env:\n      !!str ON: !!str off\n";
    const written = editHermesConfigurationYaml(
      source,
      ["mcp_servers", "rea"],
      {
        command: "rea",
        env: { ON: "off" },
      },
    );
    expect(written).toBe(source.replace("command: old", 'command: "rea"'));
    expect(
      parse(written.slice("%YAML 1.2\n---\n".length), { version: "1.1" }),
    ).toMatchObject({ mcp_servers: { rea: { env: { ON: "off" } } } });
  });

  it("writes an edited number from its new value", () => {
    expect(
      editHermesConfigurationYaml("mode: 0600\nmask: 0x1F\n", ["mode"], 420),
    ).toBe("mode: 0644\nmask: 0x1F\n");
  });

  it("accepts keys Hermes reads as distinct and rejects a repeated key", () => {
    expect(() =>
      parseHermesConfigurationYaml("0600: octal\n600: decimal\n"),
    ).not.toThrow();
    expect(() => parseHermesConfigurationYaml('a: 1\n"a": 2\n')).toThrow();
    expect(() => parseHermesConfigurationYaml("yes: 1\ntrue: 2\n")).toThrow();
    expect(() => parseHermesConfigurationYaml("no: 1\noff: 2\n")).toThrow();
  });

  it("matches Hermes numeric key equality without losing large integer precision", () => {
    for (const text of [
      "1: first\n01: second\n",
      "1.0: first\n1.00: second\n",
      "true: first\n1: second\n",
      "false: first\n0.0: second\n",
      ".nan: first\n.NAN: second\n",
      "9007199254740992: first\n9007199254740992.0: second\n",
    ])
      expect(() => parseHermesConfigurationYaml(text)).toThrow();

    expect(() =>
      parseHermesConfigurationYaml(
        "9007199254740992: first\n9007199254740993: second\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml(
        "9007199254740993: first\n9007199254740993.0: second\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml("0600: octal\n600: decimal\n"),
    ).not.toThrow();
    expect(parseHermesConfigurationYaml("value: 9007199254740993\n")).toEqual({
      value: Number("9007199254740993"),
    });
  });

  it("matches Hermes timestamp key precision, timezone, and date-type equality", () => {
    for (const text of [
      "2026-10-14T00:00:00.123456+08:00: first\n2026-10-13T16:00:00.123456Z: second\n",
      "2026-10-14T00:00:00.1234565Z: first\n2026-10-14T00:00:00.123457Z: second\n",
    ])
      expect(() => parseHermesConfigurationYaml(text)).toThrow();

    expect(() =>
      parseHermesConfigurationYaml(
        "2026-10-14T00:00:00.123456Z: first\n2026-10-14T00:00:00.123457Z: second\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml(
        "2026-10-14: date\n2026-10-14T00:00:00Z: timestamp\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml(
        "2026-10-14T00:00:00: local\n2026-10-14T00:00:00Z: utc\n",
      ),
    ).not.toThrow();
  });

  it("matches Hermes timestamp resolution and rejects invalid calendar values", () => {
    expect(parseHermesConfigurationYaml("short: 2026-1-1\n")).toEqual({
      short: "2026-1-1",
    });
    expect(
      parseHermesConfigurationYaml("short: 2026-1-1 1:02:03.\n"),
    ).toMatchObject({ short: expect.any(Date) });
    expect(
      parseHermesConfigurationYaml("short: 2026-01-01 1:02:03\n"),
    ).toMatchObject({ short: expect.any(Date) });
    expect(parseHermesConfigurationYaml("short: 2026-01-01 1:2:03\n")).toEqual({
      short: "2026-01-01 1:2:03",
    });
    expect(parseHermesConfigurationYaml("short: 2026-01-01 1:02:3\n")).toEqual({
      short: "2026-01-01 1:02:3",
    });
    const firstYear = parseHermesConfigurationYaml("date: 0001-01-01\n") as {
      date: Date;
    };
    expect(firstYear.date.getUTCFullYear()).toBe(1);
    expect(
      parseHermesConfigurationYaml("date: 1969-12-31T23:59:59.999999Z\n"),
    ).toEqual({ date: new Date("1969-12-31T23:59:59.999Z") });

    for (const invalid of [
      "date: 0000-01-01\n",
      "date: 2026-02-30\n",
      "date: 2026-01-01 24:00:00\n",
      "date: 2026-01-01 00:00:00+24\n",
      "date: 9999-12-31T23:59:59.9999995Z\n",
    ])
      expect(() => parseHermesConfigurationYaml(invalid)).toThrow();
  });

  it("preserves YAML 1.1 strings on fresh files and honors directives on edits", () => {
    const created = stringifyHermesConfigurationYaml({
      mcp_servers: { rea: { env: { PROFILE: "off" } } },
    });
    expect(parse(created, { version: "1.1" })).toMatchObject({
      mcp_servers: { rea: { env: { PROFILE: "off" } } },
    });

    const original =
      "%YAML 1.2\n---\nnotify: on\ntimestamp: 2026-10-14T00:00:00.123456+08:00\n";
    const updated = editHermesConfigurationYaml(original, ["environment"], {
      SETTING: "off",
      DATE: "2026-10-14",
    });
    expect(updated.startsWith(original)).toBe(true);
    expect(parse(updated)).toMatchObject({
      notify: "on",
      environment: { SETTING: "off", DATE: "2026-10-14" },
    });
    expect(
      parseHermesConfigurationYaml("%YAML 1.2\n---\ndate: 2026-10-14\n"),
    ).toEqual({ date: new Date("2026-10-14") });
  });
});
