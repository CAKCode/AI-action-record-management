#!/usr/bin/env python3
import ctypes
import os
import signal
import sys


def arm_parent_death_signal():
    if not sys.platform.startswith("linux"):
        return None
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")
    if os.getppid() == 1:
        os._exit(125)
    return libc


def main():
    separator = sys.argv.index("--") if "--" in sys.argv else -1
    command = sys.argv[separator + 1:] if separator >= 0 else []
    if not command:
        raise SystemExit("usage: execution-gate.py -- command [args ...]")
    libc = arm_parent_death_signal()
    if os.read(0, 1) != b"\x01":
        os._exit(125)
    if libc is not None and libc.prctl(1, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG clear) failed")
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    main()
