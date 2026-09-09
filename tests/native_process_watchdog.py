"""Wall deadline for one retained Popen instance; never resolves a PID by name."""
from __future__ import annotations

import threading
import time


class OwnedProcessWatchdog:
    def __init__(self, process, seconds, *, started_at=None, on_expire=None,
                 clock=time.monotonic, timer_factory=threading.Timer):
        self.process, self.clock, self.on_expire = process, clock, on_expire
        self.started = clock() if started_at is None else started_at
        self.deadline = self.started + seconds
        self._lock = threading.Lock()
        self._cancelled = False
        self._state = {"limitSeconds": seconds, "startedMonotonic": self.started,
                       "deadlineMonotonic": self.deadline, "expired": False,
                       "killAttempted": False, "processAlreadyExited": False}
        self.timer = timer_factory(max(0, self.deadline-clock()), self.enforce)
        self.timer.daemon = True

    def start(self):
        self.timer.start()
        return self

    def snapshot(self):
        with self._lock:
            return dict(self._state)

    def enforce(self):
        with self._lock:
            if self._cancelled or self._state["expired"]:
                return
            if self.process.poll() is not None:
                self._state["processAlreadyExited"] = True
                return
            self._state.update(expired=True, expiredMonotonic=self.clock(), killAttempted=True)
        # On Windows Popen.kill calls TerminateProcess on its retained _handle.
        # Keep the Popen object alive: never look up/reopen a process by PID.
        try:
            self.process.kill()
            with self._lock:
                self._state["killReturnedMonotonic"] = self.clock()
        except Exception as error:
            with self._lock:
                self._state["killError"] = str(error)
        if self.on_expire:
            try:
                self.on_expire(self.snapshot())
            except Exception as error:
                with self._lock:
                    self._state["evidenceError"] = str(error)

    def call(self, function, *args, label="native RPC", **kwargs):
        """Do not let a stalled Frida condition variable hold the controlling thread."""
        remaining = self.deadline-self.clock()
        if remaining <= 0 or self.snapshot()["expired"]:
            self.enforce()
            raise TimeoutError(f"Owned-process wall deadline expired before {label}")
        done, result = threading.Event(), {}
        def invoke():
            try:
                result["value"] = function(*args, **kwargs)
            except BaseException as error:
                result["error"] = error
            finally:
                done.set()
        # Killing Pivot normally destroys the Frida script and releases RPC.
        # This bounded wait also handles missing/delayed transport notification.
        worker = threading.Thread(target=invoke, name="owned-native-control", daemon=True)
        worker.start()
        if not done.wait(max(0, self.deadline-self.clock())):
            self.enforce()
            raise TimeoutError(f"Owned-process wall deadline expired during {label}")
        if self.snapshot()["expired"] or self.clock() >= self.deadline:
            self.enforce()
            raise TimeoutError(f"Owned-process wall deadline expired during {label}")
        if "error" in result:
            raise result["error"]
        return result.get("value")

    def cancel(self):
        with self._lock:
            self._cancelled = True
        self.timer.cancel()
