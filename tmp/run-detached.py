#!/usr/bin/env python3
"""Run a command fully detached from the invoking shell.

The Shell tool kills its descendants on session teardown, so long-lived
dev servers must reparent themselves before starting.

Usage: run-detached.py <logfile> <cwd> <command...>
"""

import os
import sys

log_path = sys.argv[1]
work_dir = sys.argv[2]
command = sys.argv[3:]

if os.fork() > 0:
    print("detached:", " ".join(command))
    sys.exit(0)

os.setsid()
if os.fork() > 0:
    os._exit(0)

os.chdir(work_dir)
with open(log_path, "wb", buffering=0) as log:
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
os.close(0)
os.open(os.devnull, os.O_RDONLY)
os.execvp(command[0], command)
