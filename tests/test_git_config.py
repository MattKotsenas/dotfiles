"""Offline checks using real Git/gh and temporary, fictitious work credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]


class GitConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        config = self.home / ".config/git"
        config.mkdir(parents=True)
        for name in ["user.gitconfig", "user.github.gitconfig", "user.codeberg.gitconfig"]:
            shutil.copyfile(SOURCE / "git" / name, config / name)
        (config / "user.ghe.gitconfig").write_text("[user]\n name = Work Fixture\n email = work@example.invalid\n")
        (self.home / ".gitconfig").write_text('[include]\n path = ./.config/git/user.gitconfig\n')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k not in (
            "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "SSH_ASKPASS"
        )}
        self.env.update(HOME=str(self.home), USERPROFILE=str(self.home), GIT_CONFIG_NOSYSTEM="1",
                        GIT_CONFIG_GLOBAL=str(self.home / ".gitconfig"), GIT_TERMINAL_PROMPT="0",
                        GH_CONFIG_DIR=str(self.home / "gh"), GCM_INTERACTIVE="never")
        self.personal_user = "personal-user"
        self.personal_email = self.git("config", "--file", str(config / "user.github.gitconfig"),
                                       "--get", "user.email").stdout.strip()
        (self.home / "gh").mkdir()
        (self.home / "gh/hosts.yml").write_text(
            f"github.com:\n    user: {self.personal_user}\n    oauth_token: fake-personal-token\n"
            "example.ghe.com:\n    user: work-user\n    oauth_token: fake-work-token\n"
        )
        for host in ["github.com", "example.ghe.com"]:
            result = subprocess.run(["gh", "auth", "setup-git", "--hostname", host],
                                    cwd=self.home, env=self.env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.repo = self.home / "repo"
        self.git("init", "--quiet", str(self.repo))
        self.git("remote", "add", "origin", "https://unknown.example.invalid/repo", cwd=self.repo)

    def git(self, *args, cwd=None, input=None, check=True):
        result = subprocess.run(["git", *args], cwd=cwd or self.home, env=self.env,
                                input=input, text=True, capture_output=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_identity_follows_host_with_local_overrides(self):
        self.assertNotEqual(self.git("var", "GIT_AUTHOR_IDENT", cwd=self.repo, check=False).returncode, 0)
        for url, email in [
            ("https://github.com/example/repo", self.personal_email),
            ("git@github.com:example/repo", self.personal_email),
            ("https://example.ghe.com/example/repo", "work@example.invalid"),
            ("git@example.ghe.com:example/repo", "work@example.invalid"),
        ]:
            with self.subTest(url=url):
                self.git("remote", "set-url", "origin", url, cwd=self.repo)
                self.assertEqual(self.git("config", "user.email", cwd=self.repo).stdout.strip(), email)
        self.git("remote", "add", "upstream", "https://github.com/example/repo", cwd=self.repo)
        self.assertEqual(self.git("config", "user.email", cwd=self.repo).stdout.strip(), "work@example.invalid")
        self.git("config", "--local", "user.email", "override@example.invalid", cwd=self.repo)
        self.assertEqual(self.git("config", "user.email", cwd=self.repo).stdout.strip(), "override@example.invalid")

    def test_native_credentials_work_without_a_checkout(self):
        for host, user, token in [("github.com", self.personal_user, "fake-personal-token"),
                                  ("gist.github.com", "x-access-token", "fake-personal-token"),
                                  ("example.ghe.com", "work-user", "fake-work-token")]:
            with self.subTest(host=host):
                result = self.git("credential", "fill", input=f"protocol=https\nhost={host}\n\n")
                values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
                self.assertEqual((values["username"], values["password"]), (user, token))
        result = self.git("credential", "fill", input="url=https://unknown@example.ghe.com/repo\n\n", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("password=", result.stdout)

    def test_work_configuration_is_ignored(self):
        shutil.copyfile(SOURCE / ".gitignore", self.repo / ".gitignore")
        self.git("check-ignore", "git/user.ghe.gitconfig", cwd=self.repo)


if __name__ == "__main__":
    unittest.main()
