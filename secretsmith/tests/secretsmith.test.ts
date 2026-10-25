import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRETSMITH_DIR = "/home/toxic/estate/ranch/barn/secretsmith";
const PY = "python3";

interface PyResult {
  ok: boolean;
  value: string;
}

/**
 * Run a python expression against the secretsmith module (unit isolation, no
 * keyring write). The snippet is written to a temp .py file — never passed
 * through `python3 -c` inline — so arbitrary multi-statement python round-trips
 * verbatim. The wrapper imports `secretsmith`, `os`, and the cryptography
 * cipher modules, evaluates the expression, and prints a structured result:
 *   {"ok": true, "value": "<repr of expr>"}       on success
 *   {"ok": false, "value": "SecretsmithError"}    when the expression raises
 */
function pyUnit(pyExpr: string): PyResult {
  const dir = mkdtempSync(join(tmpdir(), "ssm-ts-"));
  const script = join(dir, "probe.py");
  const body = [
    `import json, sys`,
    `sys.path.insert(0, ${JSON.stringify(SECRETSMITH_DIR)})`,
    `import secretsmith as ssm`,
    `import os`,
    `from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes`,
    `try:`,
    `    __out = (${pyExpr})`,
    `    print(json.dumps({"ok": True, "value": repr(__out)}))`,
    `except Exception as __e:`,
    `    print(json.dumps({"ok": False, "value": type(__e).__name__}))`,
  ].join("\n");
  writeFileSync(script, body + "\n");
  try {
    const out = execSync(`${PY} ${script}`, { encoding: "utf8" }).trim();
    return JSON.parse(out) as PyResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Secretsmith CLI & Integrations", () => {
  test("secretsmith collections lists available collections", () => {
    const out = execSync("secretsmith collections", { encoding: "utf8" });
    expect(out).toContain("/org/freedesktop/secrets/collection");
  });

  test("secretsmith bw-status reports bitwarden status", () => {
    const out = execSync("secretsmith --json bw-status", { encoding: "utf8" });
    const data = JSON.parse(out);
    expect(data).toHaveProperty("status");
    expect(typeof data.status).toBe("string");
  });

  test("secretsmith cookie-vault sync executes and reports stored cookies", () => {
    const out = execSync("secretsmith cookie-vault status", { encoding: "utf8" });
    // status reports cookie + domain counts (vault path may differ across hosts)
    expect(out).toContain("cookies");
  });

  test("tau-auth-sync is wired into the CLI", () => {
    let exit = 0;
    let stderr = "";
    try {
      execSync("secretsmith tau-auth-sync --db-path /nonexistent/agent.db", {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e: any) {
      exit = e.status ?? -1;
      stderr = String(e.stderr ?? "");
    }
    expect(exit).toBe(1);
    expect(stderr).toContain("agent.db not found");
    expect(stderr).not.toContain("Traceback");
  });

  test("tau-auth-sync parses --db-path and --content-type", () => {
    const r = pyUnit(
      `(lambda p: (getattr(p, "cmd"), callable(p.func), p.db_path, p.content_type))(` +
        `ssm.build_parser().parse_args(["tau-auth-sync", "--db-path", "/x", "--content-type", "text/plain"]))`,
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe("('tau-auth-sync', True, '/x', 'text/plain')");
  });

  test("registry resolves chromium schema and chrome alias", () => {
    expect(pyUnit(`("chromium" in ssm.load_registry()["schemas"])`).value).toBe("True");
    // chromium schema (and its chrome alias) resolve to the libsecret key schema
    expect(pyUnit(`ssm.resolve_schema("chromium", ssm.load_registry())[0]`).value).toBe(
      "'chrome_libsecret_os_crypt_password_v2'",
    );
    expect(pyUnit(`ssm.resolve_schema("chrome", ssm.load_registry())[0]`).value).toBe(
      "'chrome_libsecret_os_crypt_password_v2'",
    );
    // generic is the non-chromium libsecret schema
    expect(pyUnit(`ssm.resolve_schema("generic", ssm.load_registry())[0]`).value).toBe(
      "'org.freedesktop.Secret.Generic'",
    );
    // unregistered custom schema passes through with an "unregistered" note
    const unreg = pyUnit(
      `(lambda s, e: (s, e["description"]))(*ssm.resolve_schema("com.example.Custom", ssm.load_registry()))`,
    );
    expect(unreg.value).toBe("('com.example.Custom', 'unregistered raw schema')");
  });

  test("chromium crypto round-trips raw and base64 keys", () => {
    const key = crypto.getRandomValues(new Uint8Array(16));
    const keyPy = `bytes.fromhex("${Buffer.from(key).toString("hex")}")`;
    // build a v10 blob over plaintext "correct horse" with this key
    const makeBlob = (
      `(lambda key: b"v10" + Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).encryptor().update(` +
      `b"correct horse" + bytes([16 - len(b"correct horse") % 16]) * (16 - len(b"correct horse") % 16)) + ` +
      `Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).encryptor().finalize())(${keyPy})`,
    );
    const blob = pyUnit(makeBlob);
    expect(blob.ok).toBe(true);
    // decrypt via the raw and the base64-encoded _key_candidates paths
    const rawDec = pyUnit(
      `(lambda blob, key: ssm.decrypt_chromium_blob(blob, [key]) == b"correct horse")(${blob.value}, ${keyPy})`,
    );
    expect(rawDec.value).toBe("True");
    const b64Key = pyUnit(`__import__("base64").b64encode(${keyPy})`);
    const b64Dec = pyUnit(
      `(lambda blob, b64k: ssm.decrypt_chromium_blob(blob, ssm._key_candidates(b64k)) == b"correct horse")(${blob.value}, ${b64Key.value})`,
    );
    expect(b64Dec.value).toBe("True");
  });

  test("chromium crypto rejects wrong key and bad prefix", () => {
    const key = crypto.getRandomValues(new Uint8Array(16));
    const keyPy = `bytes.fromhex("${Buffer.from(key).toString("hex")}")`;
    const makeBlob = (
      `(lambda key: b"v10" + Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).encryptor().update(` +
      `b"nope" + bytes([12]) * 12) + ` +
      `Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).encryptor().finalize())(${keyPy})`,
    );
    const blob = pyUnit(makeBlob);
    // wrong key -> SecretsmithError
    const wrong = pyUnit(`ssm.decrypt_chromium_blob(${blob.value}, [os.urandom(16)])`);
    expect(wrong.ok).toBe(false);
    expect(wrong.value).toBe("SecretsmithError");
    // bad v99 prefix -> SecretsmithError
    const badPrefix = pyUnit(`ssm.decrypt_chromium_blob(b"v99" + b"x" * 32, [os.urandom(16)])`);
    expect(badPrefix.ok).toBe(false);
    expect(badPrefix.value).toBe("SecretsmithError");
  });

  test("safety helpers redact and parse attrs", () => {
    expect(pyUnit(`ssm.redact(24)`).value).toBe("'<redacted: 24 bytes>'");
    expect(pyUnit(`ssm.parse_attrs(["a=1", "b=x=y"])`).value).toBe("{'a': '1', 'b': 'x=y'}");
    const bare = pyUnit(`ssm.parse_attrs(["bare"])`);
    expect(bare.ok).toBe(false);
    expect(bare.value).toBe("SecretsmithError");
  });
});

describe("Secretsmith live keyring (SSM_TEST_KEYRING=1)", () => {
  test("set/get/search/delete round-trip against real collection", () => {
    if (process.env.SSM_TEST_KEYRING !== "1") {
      console.log("skip: set SSM_TEST_KEYRING=1 to run live keyring tests");
      return;
    }
    const label = `ssm-ts-${process.pid}`;
    expect(
      execSync(`printf 's3cr3t-value' | secretsmith set --label "${label}" --attr test-id=${label}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).toContain("stored");
    expect(
      execSync(`secretsmith get --attr test-id=${label} --show`, { encoding: "utf8" }),
    ).toContain("s3cr3t-value");
    execSync(`secretsmith delete --attr test-id=${label} --yes`, { encoding: "utf8" });
    expect(execSync(`secretsmith search test-id=${label}`, { encoding: "utf8" })).not.toContain(label);
  });
});