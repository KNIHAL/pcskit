import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePorcelainZ } from "../src/core/git.js";
import { parseHookPayload } from "../src/core/hooks.js";
import { redactDeep, redactText } from "../src/core/redact.js";
import { validateArgv } from "../src/core/runner.js";
import { validateAgentName } from "../src/core/sessions.js";

const RUNS = { numRuns: 300 };

describe("fuzz: redaction", () => {
  it("never throws and is idempotent on any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const once = redactText(s).text;
        expect(redactText(once).text).toBe(once);
      }),
      RUNS,
    );
  });

  it("removes a planted secret wherever it sits", () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9]{36}$/).map((t) => `ghp_${t}`);
    fc.assert(
      fc.property(fc.string(), secret, fc.string(), (a, tok, b) => {
        const out = redactText(`${a} ${tok} ${b}`).text;
        expect(out).not.toContain(tok);
      }),
      RUNS,
    );
  });

  it("redactDeep never throws on nested values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const r = redactDeep(v);
        expect(typeof r.count).toBe("number");
      }),
      RUNS,
    );
  });
});

describe("fuzz: parsers", () => {
  it("parsePorcelainZ never throws", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        expect(Array.isArray(parsePorcelainZ(s))).toBe(true);
      }),
      RUNS,
    );
  });

  it("parseHookPayload never throws and strips control chars", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const p = parseHookPayload(s);
        for (const v of [p.source, p.reason]) {
          if (v !== undefined) expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(v)).toBe(false);
        }
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        parseHookPayload(JSON.stringify(v));
      }),
      RUNS,
    );
  });

  it("validateArgv and validateAgentName either return or throw PcsError, never crash", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "binary" }), { maxLength: 8 }), (argv) => {
        try {
          const out = validateArgv(argv);
          expect(out).toEqual(argv);
        } catch (e) {
          expect((e as { code?: string }).code).toBe("INVALID_INPUT");
        }
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (name) => {
        try {
          validateAgentName(name);
        } catch (e) {
          expect((e as { code?: string }).code).toBe("INVALID_INPUT");
        }
      }),
      RUNS,
    );
  });
});
