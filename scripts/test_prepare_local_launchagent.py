import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "installer", Path(__file__).with_name("prepare-local-launchagent.py")
)
assert spec is not None and spec.loader is not None
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PrepareTests(unittest.TestCase):
    def test_preserves_secrets_and_settings_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for entry in ["server/dist/index.js", "server/scripts/local-server.mjs"]:
                path = root / entry
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            config = {
                "Label": installer.LABEL,
                "ProgramArguments": ["/usr/local/bin/node", str(root / "server/dist/index.js")],
                "WorkingDirectory": str(root),
                "EnvironmentVariables": {"DATABASE_URL": "secret", "OTHER": "preserve"},
                "StandardErrorPath": "/private/logs/preserve",
                "CustomSetting": {"preserve": True},
            }
            source, destination = root / "source.plist", root / "destination.plist"
            source.write_bytes(plistlib.dumps(config))
            installer.prepare(source, destination, root)
            result = plistlib.loads(destination.read_bytes())
            for key in ["EnvironmentVariables", "StandardErrorPath", "CustomSetting"]:
                self.assertEqual(result[key], config[key])
            self.assertEqual(result["ThrottleInterval"], 60)
            self.assertTrue(result["KeepAlive"])
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            installer.prepare(destination, destination, root)
            self.assertEqual(plistlib.loads(destination.read_bytes()), result)
            config["Label"] = "unrelated"
            source.write_bytes(plistlib.dumps(config))
            with self.assertRaises(ValueError):
                installer.prepare(source, destination, root)
            self.assertEqual(plistlib.loads(destination.read_bytes()), result)


if __name__ == "__main__":
    unittest.main()
