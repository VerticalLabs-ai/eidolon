#!/usr/bin/env python3
"""Prepare (but do not reload) an existing Eidolon LaunchAgent safely."""
import argparse
import os
from pathlib import Path
import plistlib
import tempfile

LABEL = "ai.verticallabs.eidolon.local-server"


def prepare(source, destination, runtime_root):
    source, destination = Path(source), Path(destination)
    root = Path(runtime_root).resolve()
    config = plistlib.loads(source.read_bytes())
    if config.get("Label") != LABEL:
        raise ValueError("Refusing an unrelated LaunchAgent")
    args = config.get("ProgramArguments", [])
    if len(args) != 2 or Path(args[0]).name != "node":
        raise ValueError("Expected the existing two-argument Node LaunchAgent")
    if Path(config.get("WorkingDirectory", "")).resolve() != root:
        raise ValueError("Runtime root must match the existing working directory")
    allowed = [root / "server/dist/index.js", root / "server/scripts/local-server.mjs"]
    if Path(args[1]).resolve() not in allowed:
        raise ValueError("Refusing an unexpected server entry point")
    if not all(p.is_file() for p in allowed):
        raise ValueError("Install the wrapper and build the runtime before preparing the plist")
    config["ProgramArguments"] = [args[0], str(allowed[1])]
    config["RunAtLoad"] = True
    config["KeepAlive"] = True
    config["ThrottleInterval"] = 60
    # Never reconstruct EnvironmentVariables, log paths, or unrelated settings.
    # Write beside the target, mode 0600, then atomically replace it.
    fd, temporary = tempfile.mkstemp(prefix=".eidolon-plist-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            plistlib.dump(config, handle)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--runtime-root", required=True)
    args = parser.parse_args()
    prepare(args.source, args.destination, args.runtime_root)
    print("Prepared Eidolon LaunchAgent; existing environment preserved. Reload separately.")
