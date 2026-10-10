"""Drive actual pi-tui keyboard input using only Python's standard library."""
import errno
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

fixture, scenario, node = sys.argv[1:]
startup = scenario.startswith("setup-")
ready_text = b"Piexis setup for this project?" if startup else b"Question 1/"
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 72, 0, 0))
before = termios.tcgetattr(slave)
child = subprocess.Popen([node, fixture, scenario], stdin=slave, stdout=slave, stderr=slave,
                         env={**os.environ, "TERM": "xterm-256color"})
output = bytearray()

def drain(wait=0.1):
    if select.select([master], [], [], wait)[0]:
        try:
            output.extend(os.read(master, 65536))
        except OSError as error:
            if error.errno != errno.EIO:
                raise

actions = {
    "single": [b"\x1b[B", b"\r"],
    "multi": [b"\r", b" ", b"\x1b[B", b" ", b"\r"],
    "text": [b"\r", "\x1b[200~1, 999 café 🦊 & <>\x1b[201~".encode(), b"\r"],
    "other": [b"\x1b[B", b"\x1b[B", b"\r", b"1, 999", b"\r"],
    "navigation": [b"\x1b[B", b"\r", b"hello", b"\x1b[Z", b"\t", b"\r", b"\r"],
    "cancel": [b"\x1b"],
    "ctrl-c": [b"\x03"],
    "abort": [b"!"],
    "setup-enable": [b"\x1b[B", b"\r"],
    "setup-agent-upgrade": [b"\x1b[B", b"\r"],
    "setup-not-now": [b"\r"],
    "setup-disabled": [b"\x1b[B", b"\x1b[B", b"\r"],
}
try:
    deadline = time.monotonic() + 8
    while ready_text not in output and child.poll() is None and time.monotonic() < deadline:
        drain()
    if ready_text not in output:
        raise AssertionError("Question did not render: " + output.decode(errors="replace"))
    for action in actions[scenario]:
        os.write(master, action)
        end = time.monotonic() + 0.15
        while time.monotonic() < end:
            drain(0.03)
    while child.poll() is None and time.monotonic() < deadline:
        drain()
    if child.poll() is None:
        raise AssertionError("Terminal interaction did not settle")
    drain()
    assert child.returncode == 0, output.decode(errors="replace")
    assert termios.tcgetattr(slave) == before, "Terminal attributes were not restored"
    assert b"\x1b[?25h" in output, "Cursor was not restored"
    decoded = output.decode(errors="replace")
    result_line = decoded.split("RESULT:")[-1].splitlines()[0]
    result = json.loads(result_line)
    assert result["rawRestored"] and result["listenersRestored"] and result["restored"] == 1
    if scenario in ("single", "navigation"):
        assert result["answers"][0]["optionIds"] == ["b"]
    if scenario == "multi":
        assert "Choose at least 2" in decoded
        assert result["answers"][0]["optionIds"] == ["a", "b"]
        assert "[x]" in decoded
    if scenario == "text":
        assert "An answer is required" in decoded
        assert result["answers"][0]["answer"] == "1, 999 café 🦊 & <>"
    if scenario == "other":
        assert result["answers"][0]["answer"] == "1, 999"
        assert result["answers"][0]["custom"]
    if scenario == "navigation":
        assert result["answers"][1]["answer"] == "hello"
    expected = "aborted" if scenario == "abort" else "cancelled" if scenario in ("cancel", "ctrl-c") else "answered"
    assert result["status"] == expected, result
    print(json.dumps({"scenario": scenario, "status": result["status"], "terminalRestored": True}))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
    os.close(slave)
