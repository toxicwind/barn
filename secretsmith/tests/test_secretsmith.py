#!/usr/bin/env python3
"""secretsmith tests: unit tests always run; keyring integration runs live
when SSM_TEST_KEYRING=1 (uses a throwaway collection, cleans up after itself)."""

import base64
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import secretsmith as ssm


class TestRegistry(unittest.TestCase):
    def test_registry_loads(self):
        reg = ssm.load_registry()
        self.assertIn("chromium", reg["schemas"])

    def test_chromium_resolves(self):
        reg = ssm.load_registry()
        schema, entry = ssm.resolve_schema("chromium", reg)
        self.assertEqual(schema, "chrome_libsecret_os_crypt_password_v2")
        self.assertTrue(entry["secret_is_key"])

    def test_chrome_alias(self):
        reg = ssm.load_registry()
        schema, _ = ssm.resolve_schema("chrome", reg)
        self.assertEqual(schema, "chrome_libsecret_os_crypt_password_v2")

    def test_generic_is_not_chromium(self):
        reg = ssm.load_registry()
        schema, _ = ssm.resolve_schema("generic", reg)
        self.assertNotEqual(schema, "chrome_libsecret_os_crypt_password_v2")

    def test_raw_passthrough(self):
        reg = ssm.load_registry()
        schema, entry = ssm.resolve_schema("com.example.Custom", reg)
        self.assertEqual(schema, "com.example.Custom")
        self.assertIn("unregistered", entry["description"])


class TestChromiumCrypto(unittest.TestCase):
    def _blob(self, key, pt):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        pad = 16 - len(pt) % 16
        pt = pt + bytes([pad]) * pad
        d = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).encryptor()
        return b"v10" + d.update(pt) + d.finalize()

    def test_roundtrip_raw_key(self):
        key = os.urandom(16)
        blob = self._blob(key, b"hunter2")
        self.assertEqual(ssm.decrypt_chromium_blob(blob, [key]), b"hunter2")

    def test_roundtrip_b64_key(self):
        key = os.urandom(16)
        stored = base64.b64encode(key)  # 24 chars, like the real keyring entry
        self.assertEqual(len(stored), 24)
        blob = self._blob(key, b"correct horse")
        cands = ssm._key_candidates(stored)
        self.assertIn(key, cands)
        self.assertEqual(ssm.decrypt_chromium_blob(blob, cands), b"correct horse")

    def test_wrong_key_fails(self):
        blob = self._blob(os.urandom(16), b"nope")
        with self.assertRaises(ssm.SecretsmithError):
            ssm.decrypt_chromium_blob(blob, [os.urandom(16)])

    def test_bad_prefix_fails(self):
        with self.assertRaises(ssm.SecretsmithError):
            ssm.decrypt_chromium_blob(b"v99" + b"x" * 32, [os.urandom(16)])


class TestSafety(unittest.TestCase):
    def test_redact_format(self):
        self.assertEqual(ssm.redact(24), "<redacted: 24 bytes>")

    def test_parse_attrs(self):
        self.assertEqual(ssm.parse_attrs(["a=1", "b=x=y"]), {"a": "1", "b": "x=y"})

    def test_parse_attrs_rejects_bare(self):
        with self.assertRaises(ssm.SecretsmithError):
            ssm.parse_attrs(["bare"])


class _FakeSvc:
    """In-memory stub of SecretService for the env-loader unit test."""

    def __init__(self, items):
        self._items = items

    def search(self, filters, collection=None):
        out = []
        for it in self._items:
            if all(it["attributes"].get(k) == v for k, v in filters.items()):
                out.append(it)
        return out

    def ensure_unlocked_items(self, items):
        return

    def get_secret(self, item_path):
        for it in self._items:
            if it["path"] == item_path:
                return it["_secret"], "text/plain"
        raise ssm.SecretsmithError("no such item")


def _fake_item(label, secret, attrs=None):
    return {
        "label": label,
        "path": "/x/" + label,
        "locked": False,
        "attributes": attrs or {},
        "_secret": secret,
    }


def _env_args(app="", attr=(), as_json=False):
    import types

    a = types.SimpleNamespace(app=app, attr=list(attr), collection=None)
    return a, as_json


class TestEnvLoader(unittest.TestCase):
    def test_app_filters_on_service_and_emits_exports(self):
        a, as_json = _env_args(app="kappa")
        svc = _FakeSvc([
            _fake_item("KAPPA_SERVER_PASSWORD", b"s3cr3t", {"service": "kappa"}),
            _fake_item("OTHER", b"x", {"service": "else"}),
        ])
        with _capture_stdout() as out:
            rc = ssm.cmd_env(svc, a, ssm.load_registry(), as_json)
        text = out.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("KAPPA_SERVER_PASSWORD='s3cr3t'", text)
        self.assertNotIn("OTHER", text)
        self.assertNotIn("else", text)

    def test_invalid_identifier_label_skipped(self):
        a, as_json = _env_args(app="kappa")
        svc = _FakeSvc([
            _fake_item("kappa-freeinference", b"x", {"service": "kappa"}),
        ])
        with _capture_stdout() as out:
            rc = ssm.cmd_env(svc, a, ssm.load_registry(), as_json)
        self.assertEqual(rc, 1)
        self.assertEqual(out.getvalue(), "")

    def test_quote_escaping(self):
        a, as_json = _env_args()
        svc = _FakeSvc([
            _fake_item("QUOTED", b"it's got 'quotes'", {}),
        ])
        with _capture_stdout() as out:
            rc = ssm.cmd_env(svc, a, ssm.load_registry(), as_json)
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue(), "QUOTED='it'\\''s got '\\''quotes'\\'''\n")

    def test_nontext_secret_skipped(self):
        a, as_json = _env_args()
        svc = _FakeSvc([
            _fake_item("BINARY", b"\xff\xfe\x00secret", {}),
        ])
        with _capture_stdout() as out:
            rc = ssm.cmd_env(svc, a, ssm.load_registry(), as_json)
        self.assertEqual(rc, 1)
        self.assertEqual(out.getvalue(), "")

    def test_extra_attr_narrows(self):
        a, as_json = _env_args(app="kappa", attr=["scope=prod"])
        svc = _FakeSvc([
            _fake_item("A", b"1", {"service": "kappa", "scope": "prod"}),
            _fake_item("B", b"2", {"service": "kappa", "scope": "dev"}),
        ])
        with _capture_stdout() as out:
            rc = ssm.cmd_env(svc, a, ssm.load_registry(), as_json)
        text = out.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("A='1'", text)
        self.assertNotIn("B", text)


class _capture_stdout:
    """Context manager capturing writes to sys.stdout."""

    def __enter__(self):
        import io

        self._buf = io.StringIO()
        self._old = sys.stdout
        sys.stdout = self._buf
        return self._buf

    def __exit__(self, *exc):
        sys.stdout = self._old
        return False


class TestKeyringIntegration(unittest.TestCase):
    """Live D-Bus integration against the real (unlocked) login collection.
    Gated on SSM_TEST_KEYRING=1. Uses a uniquely-named item, deletes it after.
    Collection create/delete needs a GUI password prompt — covered only with
    SSM_TEST_COLLECTIONS=1 on an interactive session."""

    @classmethod
    def setUpClass(cls):
        if os.environ.get("SSM_TEST_KEYRING") != "1":
            raise unittest.SkipTest("set SSM_TEST_KEYRING=1 to run live keyring tests")
        cls.svc = ssm.SecretService()
        cls.reg = ssm.load_registry()
        cls.coll = cls.svc.default_collection() or cls.svc.collections()[0]["path"]
        cls.test_id = "ssm-test-%d" % os.getpid()

    def test_set_get_search_delete(self):
        p = self.svc.set_item(self.coll, "secretsmith test item",
                              {"xdg:schema": "org.freedesktop.Secret.Generic",
                               "test-id": self.test_id},
                              b"s3cr3t-value", replace=True)
        self.assertTrue(p.startswith("/"))
        try:
            found = self.svc.search({"test-id": self.test_id})
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]["label"], "secretsmith test item")
            secret, _ct = self.svc.get_secret(found[0]["path"])
            self.assertEqual(secret, b"s3cr3t-value")
        finally:
            for it in self.svc.search({"test-id": self.test_id}):
                self.svc.delete_item(it["path"])
        self.assertEqual(self.svc.search({"test-id": self.test_id}), [])

    def test_chromium_entry_visible(self):
        schema, _ = ssm.resolve_schema("chromium", self.reg)
        found = self.svc.search({"xdg:schema": schema})
        # the estate's Chromium Safe Storage entry must be findable via registry
        self.assertTrue(found, "Chromium Safe Storage entry not found via registry")

    def test_collection_create_delete(self):
        if os.environ.get("SSM_TEST_COLLECTIONS") != "1":
            raise unittest.SkipTest("needs GUI keyring password prompt")
        name = "secretsmith-test-%d" % os.getpid()
        path = self.svc.create_collection(name)
        self.assertTrue(path.startswith("/"))
        self.svc.delete_collection(name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
