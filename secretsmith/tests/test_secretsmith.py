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
