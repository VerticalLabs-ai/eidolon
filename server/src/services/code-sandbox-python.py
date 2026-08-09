"""Eidolon code sandbox preload for Python (M6).

Loaded BEFORE user code via ``python3 -c "import _eidolon_sandbox; import runpy;
runpy.run_path(...)"``. Enforces the same dev-local boundary as
``code-sandbox-shim.cjs``:

  1. Filesystem access restricted to the sandbox root (the artifact's own
     files). ``builtins.open`` and ``io.open`` resolve the target path and
     reject anything outside the sandbox root.
  2. No subprocess / process spawning — ``os.system``, ``os.popen``,
     ``os.exec*``, ``os.spawn*``, ``os.fork`` are blocked, and imports of
     ``subprocess``, ``ctypes``, ``multiprocessing``, ``pty``, ``fcntl`` are
     rejected.
  3. No non-loopback network egress — ``socket.socket.connect`` rejects any
     destination that is not 127.0.0.1, ::1, localhost, or a unix socket path.

This is a dev-local equivalent (not OS-level containment). The production
posture uses the operator-managed ``EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND``
launcher; both paths assert the same boundary: a user/agent-authored code
artifact cannot read host files, exfiltrate secrets, spawn subprocesses, or
open unapproved network connections.

The sandbox root is communicated via the ``EIDOLON_CODE_SANDBOX_ROOT``
environment variable, set by the runner when spawning the child process.
"""

import builtins as _builtins
import io as _io
import os as _os
import socket as _socket
import sys as _sys

SANDBOX_ROOT = _os.path.realpath(
    _os.environ.get("EIDOLON_CODE_SANDBOX_ROOT") or _os.getcwd()
)

# --- originals (captured before any patching) ------------------------------
_original_open = _builtins.open
_original_import = _builtins.__import__
_original_connect = _socket.socket.connect

# Modules that grant escape hatches (subprocess, native ffi, parallel procs).
_BLOCKED_MODULES = frozenset(
    {"subprocess", "ctypes", "multiprocessing", "pty", "fcntl", "_posixsubprocess"}
)

# os functions that take paths — wrap every path operand to restrict access to
# the sandbox root. Each entry contains positional indexes and keyword names.
_OS_PATH_FNS = {
    # ``os.open(path, flags, mode)`` opens a host file by raw fd.
    "open": ((0,), ("path",)),
    "remove": ((0,), ("path",)), "unlink": ((0,), ("path",)),
    "rename": ((0, 1), ("src", "dst")),
    "replace": ((0, 1), ("src", "dst")),
    "mkdir": ((0,), ("path",)), "makedirs": ((0,), ("name",)),
    "rmdir": ((0,), ("path",)), "chmod": ((0,), ("path",)),
    "lchmod": ((0,), ("path",)), "chown": ((0,), ("path",)),
    "lchown": ((0,), ("path",)), "utime": ((0,), ("path",)),
    "link": ((0, 1), ("src", "dst")),
    "symlink": ((0, 1), ("src", "dst")),
    "listdir": ((0,), ("path",)), "scandir": ((0,), ("path",)),
    "stat": ((0,), ("path",)), "lstat": ((0,), ("path",)),
    "access": ((0,), ("path",)), "readlink": ((0,), ("path",)),
    "pathconf": ((0,), ("path",)), "truncate": ((0,), ("path",)),
    "mknod": ((0,), ("path",)), "mkfifo": ((0,), ("path",)),
}

# os functions that spawn processes or alter the process environment in a way
# that escapes the sandbox — blocked entirely.
_OS_BLOCKED_FNS = (
    "system", "popen", "execv", "execve", "execvp", "execvpe",
    "spawnl", "spawnle", "spawnlp", "spawnlpe",
    "spawnv", "spawnve", "spawnvp", "spawnvpe",
    "fork", "forkpty", "chroot",
)


def _within_sandbox(path):
    """Return ``path`` resolved against the sandbox root if it stays inside.

    Uses ``os.path.abspath`` (lexical normalization, no symlink resolution)
    to match the JS shim's ``path.resolve`` boundary semantics and avoid
    recursing through the wrapped ``os.lstat``/``os.readlink`` that
    ``os.path.realpath`` would invoke.
    """
    p = _os.fspath(path)
    if not _os.path.isabs(p):
        p = _os.path.join(_os.getcwd(), p)
    real = _os.path.abspath(p)
    if real == SANDBOX_ROOT or real.startswith(SANDBOX_ROOT + _os.sep):
        return real
    raise PermissionError(
        "Sandbox blocked filesystem access outside the artifact directory: " + str(path)
    )


def _sandboxed_open(file, mode="r", buffering=-1, encoding=None, errors=None,
                    newline=None, closefd=True, opener=None):
    if isinstance(file, (str, bytes, _os.PathLike)):
        file = _within_sandbox(file)
    return _original_open(file, mode, buffering, encoding, errors, newline, closefd, opener)


def _wrap_path_fn(fn, name, path_args, path_kwargs):
    def wrapper(*args, **kwargs):
        args = list(args)
        for index in path_args:
            if index < len(args) and isinstance(args[index], (str, bytes, _os.PathLike)):
                args[index] = _within_sandbox(args[index])
        for keyword in path_kwargs:
            if keyword in kwargs and isinstance(kwargs[keyword], (str, bytes, _os.PathLike)):
                kwargs[keyword] = _within_sandbox(kwargs[keyword])
        return fn(*args, **kwargs)
    wrapper.__name__ = "sandboxed_" + name
    return wrapper


def _blocked_fn(name):
    def _raise(*_args, **_kwargs):
        raise PermissionError("Sandbox blocked os." + name)
    _raise.__name__ = "blocked_" + name
    return _raise


def _sandboxed_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0] if level == 0 else name
    if name in _BLOCKED_MODULES or root in _BLOCKED_MODULES:
        raise ImportError("Sandbox blocked import of " + name)
    return _original_import(name, globals, locals, fromlist, level)


def _sandboxed_connect(self, address, *args, **kwargs):
    host = ""
    if isinstance(address, tuple) and len(address) > 0:
        host = address[0]
    elif isinstance(address, (str, bytes)):
        host = address  # AF_UNIX path
    if isinstance(host, str) and (
        host in ("127.0.0.1", "::1", "localhost") or host.startswith("/")
    ):
        return _original_connect(self, address, *args, **kwargs)
    if isinstance(host, bytes) and host.startswith(b"/"):
        return _original_connect(self, address, *args, **kwargs)
    raise PermissionError("Sandbox blocked network egress to " + str(host))


def install():
    """Install the sandbox patches over builtins/os/socket/io."""
    _builtins.open = _sandboxed_open
    _io.open = _sandboxed_open
    _builtins.__import__ = _sandboxed_import
    for _name, (_path_args, _path_kwargs) in _OS_PATH_FNS.items():
        if hasattr(_os, _name):
            setattr(
                _os,
                _name,
                _wrap_path_fn(getattr(_os, _name), _name, _path_args, _path_kwargs),
            )
    for _name in _OS_BLOCKED_FNS:
        if hasattr(_os, _name):
            setattr(_os, _name, _blocked_fn(_name))
    _socket.socket.connect = _sandboxed_connect


# Install on import so the `-c "import _eidolon_sandbox; ..."` invocation
# locks down the interpreter before runpy loads user code.
install()
