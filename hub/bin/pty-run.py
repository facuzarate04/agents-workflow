#!/usr/bin/env python3
"""Minimal PTY wrapper that runs a command with a pseudo-TTY.
Only forwards child stdout to parent stdout. Does not forward stdin.
Usage: pty-run.py "command to run"
"""
import pty, os, sys, select, errno

if len(sys.argv) < 2:
    sys.exit("usage: pty-run.py 'command'")

master, slave = pty.openpty()
pid = os.fork()

if pid == 0:
    # Child: set up PTY as stdin/stdout/stderr and exec
    os.close(master)
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.execvp("zsh", ["zsh", "-c", sys.argv[1]])
else:
    # Parent: read from PTY master and write to stdout
    os.close(slave)
    while True:
        try:
            ready, _, _ = select.select([master], [], [], 1.0)
            if ready:
                data = os.read(master, 4096)
                if not data:
                    break
                os.write(1, data)
        except OSError as e:
            if e.errno == errno.EIO:
                break  # child closed PTY
            raise
    _, status = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
