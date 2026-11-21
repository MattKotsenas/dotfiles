"""File-level contract tests for the sandbox-owned OCI runtime launcher."""
import copy
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


LAUNCHER = Path(__file__).with_name("pi-container-runc")
CA_TARGET = "/etc/ssl/certs/ca-certificates.crt"
IMAGE_CA = b"-----BEGIN CERTIFICATE-----\nIMAGE-ROOT\n-----END CERTIFICATE-----\n"
BROKER_CA = b"-----BEGIN CERTIFICATE-----\nBROKER-ROOT\n-----END CERTIFICATE-----\n"


class ContainerRuncTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.bundle = self.directory / "bundle"
        self.rootfs = self.bundle / "rootfs"
        self.image_ca = self.rootfs / CA_TARGET.lstrip("/")
        self.image_ca.parent.mkdir(parents=True)
        self.image_ca.write_bytes(IMAGE_CA)
        self.broker_ca = self.directory / "broker.pem"
        self.broker_ca.write_bytes(BROKER_CA)
        self.policy = {
            "proxy": "http://192.0.2.10:8080",
            "no_proxy": "localhost,127.0.0.1,::1",
            "ca_file": str(self.broker_ca),
        }
        self.config = self.bundle / "config.json"
        self.original = {
            "ociVersion": "1.0.2",
            "root": {"path": "rootfs", "readonly": True},
            "process": {
                "terminal": False,
                "user": {"uid": 1000, "gid": 1000},
                "args": ["/bin/sh", "-c", "printf ready"],
                "env": ["PATH=/usr/local/bin:/usr/bin:/bin", "APP_MODE=test"],
                "cwd": "/workspace",
                "noNewPrivileges": True,
            },
            "mounts": [
                {"destination": "/proc", "type": "proc", "source": "proc"},
                {"destination": "/workspace", "type": "bind", "source": "/work",
                 "options": ["rbind", "rw"]},
            ],
            "linux": {"namespaces": [{"type": "mount"}, {"type": "pid"}]},
            "annotations": {"example.invalid/keep": "unchanged"},
        }
        self.write_json(self.config, self.original)
        self.assertEqual(self.read_json(self.config), self.original)
        self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)
        self.assertEqual(self.broker_ca.read_bytes(), BROKER_CA)
        loader = SourceFileLoader("pi_container_runc_test_subject", str(LAUNCHER))
        module = module_from_spec(spec_from_loader(loader.name, loader))
        with patch.dict(sys.modules, {loader.name: module}):
            loader.exec_module(module)
        self.prepare = module.prepare_invocation

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    @staticmethod
    def read_json(path):
        return json.loads(path.read_text(encoding="utf-8"))

    def prepare_bundle(self, command="create", bundle_args=None):
        if bundle_args is None:
            bundle_args = ["--bundle", str(self.bundle)]
        result = self.prepare([command, *bundle_args, "test-container"], self.policy)
        self.assertIsInstance(result, dict)
        return self.read_json(self.config)

    def assert_defaults(self, env, initial):
        expected = list(initial)
        for upper, lower, value in (
            ("HTTP_PROXY", "http_proxy", self.policy["proxy"]),
            ("HTTPS_PROXY", "https_proxy", self.policy["proxy"]),
            ("NO_PROXY", "no_proxy", self.policy["no_proxy"]),
        ):
            names = {entry.partition("=")[0] for entry in initial}
            if not names.intersection((upper, lower)):
                expected.extend((f"{upper}={value}", f"{lower}={value}"))
        self.assertCountEqual(env, expected)

    def assert_trust_mount(self, spec, expected_bytes, targets=(CA_TARGET,)):
        mounts = [mount for mount in spec["mounts"] if mount["destination"] in targets]
        self.assertEqual(len(mounts), 1, mounts)
        mount = mounts[0]
        self.assertTrue(mount.get("type") == "bind" or "bind" in mount.get("options", [])
                        or "rbind" in mount.get("options", []), mount)
        self.assertIn("ro", mount.get("options", []))
        self.assertNotIn("rw", mount.get("options", []))
        source = Path(mount["source"])
        if not source.is_absolute():
            source = self.bundle / source
        source = source.resolve()
        self.assertTrue(source.is_relative_to(self.bundle.resolve()), source)
        self.assertFalse(source.is_relative_to(self.rootfs.resolve()), source)
        self.assertEqual(source.read_bytes(), expected_bytes)
        self.assertEqual(self.broker_ca.read_bytes(), BROKER_CA)
        return source

    def test_create_and_run_merge_trust_and_preserve_unrelated_spec(self):
        for command in ("create", "run"):
            with self.subTest(command=command):
                self.write_json(self.config, self.original)
                self.assertEqual(self.read_json(self.config)["mounts"], self.original["mounts"])
                self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)
                spec = self.prepare_bundle(command)
                self.assert_trust_mount(spec, IMAGE_CA + BROKER_CA)
                self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)
                self.assert_defaults(spec["process"]["env"], self.original["process"]["env"])
                restored = copy.deepcopy(spec)
                restored["process"]["env"] = self.original["process"]["env"]
                restored["mounts"] = [m for m in spec["mounts"] if m["destination"] != CA_TARGET]
                self.assertEqual(restored, self.original)

    def test_bundle_flag_spellings(self):
        for flags in (["--bundle", str(self.bundle)], ["-b", str(self.bundle)],
                      [f"--bundle={self.bundle}"]):
            with self.subTest(flags=flags):
                self.write_json(self.config, self.original)
                spec = self.prepare_bundle(bundle_args=flags)
                self.assert_trust_mount(spec, IMAGE_CA + BROKER_CA)

    def test_bundle_defaults_to_current_directory(self):
        previous = os.getcwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.bundle)
        spec = self.prepare_bundle(bundle_args=[])
        self.assert_trust_mount(spec, IMAGE_CA + BROKER_CA)

    def test_proxy_defaults_do_not_copy_host_credentials_or_environment(self):
        with patch.dict(os.environ, {
            "HTTP_PROXY": "http://host.invalid:9000", "ALL_PROXY": "socks5://host.invalid",
            "GITHUB_TOKEN": "host-secret", "GH_TOKEN": "another-secret",
            "AWS_SECRET_ACCESS_KEY": "cloud-secret", "UNRELATED_HOST": "host-only",
        }):
            spec = self.prepare_bundle()
        self.assert_defaults(spec["process"]["env"], self.original["process"]["env"])

    def test_existing_proxy_settings_suppress_both_case_defaults_per_group(self):
        for env in (
            ["http_proxy=http://image.invalid:3128", "HTTPS_PROXY=https://provided.invalid",
             "no_proxy=internal.invalid"],
            ["HTTP_PROXY=", "https_proxy=", "NO_PROXY="],
            ["HTTP_PROXY=http://upper.invalid", "http_proxy=http://lower.invalid"],
        ):
            with self.subTest(env=env):
                initial = copy.deepcopy(self.original)
                initial["process"]["env"].extend(env)
                self.write_json(self.config, initial)
                self.assertEqual(self.read_json(self.config)["process"]["env"], initial["process"]["env"])
                spec = self.prepare_bundle()
                self.assert_defaults(spec["process"]["env"], initial["process"]["env"])

    def test_absolute_container_symlink_uses_container_root(self):
        alias = self.rootfs / "etc/ssl/cert.pem"
        alias.symlink_to(CA_TARGET)
        self.assertEqual(os.readlink(alias), CA_TARGET)
        self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)
        spec = self.prepare_bundle()
        self.assert_trust_mount(spec, IMAGE_CA + BROKER_CA,
                                targets=(CA_TARGET, "/etc/ssl/cert.pem"))
        self.assertEqual(os.readlink(alias), CA_TARGET)
        self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)

    def test_standard_ca_absolute_symlink_cannot_read_host_trust(self):
        container_target = "/usr/local/share/ca-certificates/image.pem"
        real_ca = self.rootfs / container_target.lstrip("/")
        real_ca.parent.mkdir(parents=True)
        self.image_ca.rename(real_ca)
        self.image_ca.symlink_to(container_target)
        self.assertEqual(os.readlink(self.image_ca), container_target)
        self.assertEqual(real_ca.read_bytes(), IMAGE_CA)
        spec = self.prepare_bundle()
        self.assert_trust_mount(spec, IMAGE_CA + BROKER_CA,
                                targets=(CA_TARGET, container_target))
        self.assertEqual(os.readlink(self.image_ca), container_target)
        self.assertEqual(real_ca.read_bytes(), IMAGE_CA)

    def test_missing_image_bundle_mounts_broker_at_standard_target(self):
        self.image_ca.unlink()
        self.assertFalse(self.image_ca.exists())
        spec = self.prepare_bundle()
        self.assert_trust_mount(spec, BROKER_CA)
        self.assertFalse(self.image_ca.exists())

    def test_prepare_is_idempotent_for_mounts_env_and_certificate_bytes(self):
        first = self.prepare_bundle()
        source = self.assert_trust_mount(first, IMAGE_CA + BROKER_CA)
        first_bytes = source.read_bytes()
        second = self.prepare_bundle()
        self.assertEqual(second, first)
        self.assertEqual(source.read_bytes(), first_bytes)
        self.assert_trust_mount(second, IMAGE_CA + BROKER_CA)
        self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)

    def test_caller_ca_mount_conflicts_fail_clearly(self):
        caller_ca = self.directory / "caller.pem"
        caller_ca.write_bytes(b"caller-owned trust\n")
        for destination in (CA_TARGET, "/etc/ssl/certs", "/etc/ssl"):
            with self.subTest(destination=destination):
                spec = copy.deepcopy(self.original)
                spec["mounts"].append({"destination": destination, "source": str(caller_ca),
                                       "type": "bind", "options": ["bind", "ro"]})
                self.write_json(self.config, spec)
                self.assertIn(destination, [m["destination"] for m in self.read_json(self.config)["mounts"]])
                with self.assertRaises(RuntimeError) as raised:
                    self.prepare_bundle()
                self.assertTrue(str(raised.exception).strip())
                self.assertEqual(caller_ca.read_bytes(), b"caller-owned trust\n")

    def test_caller_ca_alias_mount_conflicts_fail_clearly(self):
        caller_ca = self.directory / "caller.pem"
        caller_ca.write_bytes(b"caller-owned trust\n")
        alias = self.rootfs / "etc/ssl/cert.pem"
        alias.symlink_to(CA_TARGET)
        directory_alias = self.rootfs / "trust-alias"
        directory_alias.symlink_to("/etc/ssl/certs")
        self.assertEqual(os.readlink(alias), CA_TARGET)
        self.assertEqual(os.readlink(directory_alias), "/etc/ssl/certs")
        for destination in ("/etc/ssl/cert.pem", "/trust-alias", "/trust-alias/ca-certificates.crt"):
            with self.subTest(destination=destination):
                spec = copy.deepcopy(self.original)
                spec["mounts"].append({"destination": destination, "source": str(caller_ca),
                                       "type": "bind", "options": ["bind", "ro"]})
                self.write_json(self.config, spec)
                before = self.config.read_bytes()
                with self.assertRaisesRegex(RuntimeError, "overlaps"):
                    self.prepare_bundle()
                self.assertEqual(self.config.read_bytes(), before)
                self.assertEqual(caller_ca.read_bytes(), b"caller-owned trust\n")
                self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)

    def test_exec_changes_only_process_env_and_reuses_initial_ca_mount(self):
        spec = self.prepare_bundle()
        source = self.assert_trust_mount(spec, IMAGE_CA + BROKER_CA)
        config_bytes = self.config.read_bytes()
        process_path = self.directory / "exec-process.json"
        for flags in (["--process", str(process_path)], ["-p", str(process_path)],
                      [f"--process={process_path}"]):
            with self.subTest(flags=flags):
                process = copy.deepcopy(self.original["process"])
                process["args"] = ["/usr/bin/env"]
                process["env"].append("https_proxy=http://exec-override.invalid")
                self.write_json(process_path, process)
                self.assertEqual(self.read_json(process_path), process)
                self.assertIsInstance(self.prepare(["exec", *flags, "test-container"], self.policy), dict)
                updated = self.read_json(process_path)
                self.assert_defaults(updated["env"], process["env"])
                updated["env"] = process["env"]
                self.assertEqual(updated, process)
                self.assertEqual(self.config.read_bytes(), config_bytes)
                self.assertEqual(source.read_bytes(), IMAGE_CA + BROKER_CA)
                self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)

    def test_passthrough_commands_do_not_rewrite_files(self):
        previous = os.getcwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.bundle)
        before = self.config.read_bytes()
        initial_entries = sorted(p.relative_to(self.bundle) for p in self.bundle.rglob("*"))
        for argv in (["features"], ["delete", "create"], ["state", "run"],
                     ["--root", "run", "delete", "create"],
                     ["--log", "create", "features"],
                     ["exec", "test-container", "/bin/echo", "create"],
                     ["exec", "test-container", "/bin/echo", "--process", "not-a-file"],
                     ["exec", "--", "test-container", "/bin/echo", "-p", "not-a-file"]):
            with self.subTest(argv=argv):
                self.assertIsNone(self.prepare(argv, self.policy))
                self.assertEqual(self.config.read_bytes(), before)
                self.assertEqual(self.image_ca.read_bytes(), IMAGE_CA)
                self.assertEqual(sorted(p.relative_to(self.bundle) for p in self.bundle.rglob("*")),
                                 initial_entries)

    def test_global_option_values_are_not_mistaken_for_commands(self):
        for option in ("--root", "--log", "--log-format", "--criu", "--rootless"):
            for value in ("create", "run"):
                with self.subTest(option=option, value=value):
                    self.write_json(self.config, self.original)
                    result = self.prepare([option, value, "--debug", "--systemd-cgroup",
                                           "create", "-b", str(self.bundle), "test-container"],
                                          self.policy)
                    self.assertIsInstance(result, dict)
                    self.assert_trust_mount(self.read_json(self.config), IMAGE_CA + BROKER_CA)

    def test_invalid_bundle_json_or_spec_fails_clearly(self):
        for contents in ("{broken json", "[]", "null", '{"ociVersion":"1.0.2"}'):
            with self.subTest(contents=contents):
                self.config.write_text(contents, encoding="utf-8")
                self.assertEqual(self.config.read_text(encoding="utf-8"), contents)
                with self.assertRaises((RuntimeError, ValueError)) as raised:
                    self.prepare_bundle()
                self.assertTrue(str(raised.exception).strip())

    def test_invalid_exec_process_json_or_spec_fails_clearly(self):
        process_path = self.directory / "invalid-process.json"
        for contents in ("{broken json", "[]", "null"):
            with self.subTest(contents=contents):
                process_path.write_text(contents, encoding="utf-8")
                self.assertEqual(process_path.read_text(encoding="utf-8"), contents)
                with self.assertRaises((RuntimeError, ValueError)) as raised:
                    self.prepare(["exec", "-p", str(process_path), "test-container"], self.policy)
                self.assertTrue(str(raised.exception).strip())

    def test_ca_symlink_cycle_fails_clearly(self):
        self.image_ca.unlink()
        alias = self.rootfs / "etc/ssl/cert.pem"
        self.image_ca.symlink_to("/etc/ssl/cert.pem")
        alias.symlink_to(CA_TARGET)
        self.assertEqual(os.readlink(self.image_ca), "/etc/ssl/cert.pem")
        self.assertEqual(os.readlink(alias), CA_TARGET)
        with self.assertRaises((RuntimeError, ValueError)) as raised:
            self.prepare_bundle()
        self.assertTrue(str(raised.exception).strip())


if __name__ == "__main__":
    unittest.main()
