#!/usr/bin/env python3
"""Detach the PDF build from the invoking shell via a double fork.

The Shell tool's session teardown kills descendants, so the build must
reparent itself to init before Chrome starts.
"""

import os
import sys

LOG = "/tmp/pdf-build.log"
SCRIPT = "/Users/wangqichen/projects/brilliant/cuican-aide/tmp/build-intro-pdf.py"

if os.fork() > 0:
    print("detached")
    sys.exit(0)

os.setsid()
if os.fork() > 0:
    os._exit(0)

with open(LOG, "wb", buffering=0) as log:
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
os.close(0)
os.open(os.devnull, os.O_RDONLY)
os.execv(sys.executable, [sys.executable, SCRIPT])
