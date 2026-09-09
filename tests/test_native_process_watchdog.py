import threading
import time
import unittest
from native_process_watchdog import OwnedProcessWatchdog


class Process:
    def __init__(self):
        self.returncode = None
        self.kills = 0
        self.destroyed = threading.Event()
    def poll(self): return self.returncode
    def kill(self):
        self.kills += 1
        self.returncode = -1
        self.destroyed.set()


class Timer:
    def __init__(self, interval, callback):
        self.interval, self.callback = interval, callback
        self.started = self.cancelled = False
    def start(self): self.started = True
    def cancel(self): self.cancelled = True
    def fire(self): self.callback()


class WatchdogTests(unittest.TestCase):
    def test_deadline_includes_initialization_and_only_retained_process_is_killed(self):
        owned, unrelated, evidence = Process(), Process(), []
        watchdog = OwnedProcessWatchdog(owned, 25, started_at=10, clock=lambda: 15,
            timer_factory=Timer, on_expire=lambda state: evidence.append((owned.kills, state))).start()
        self.assertEqual(watchdog.timer.interval, 20)
        watchdog.timer.fire(); watchdog.timer.fire()
        self.assertEqual((owned.kills, unrelated.kills), (1, 0))
        self.assertEqual(evidence[0][0], 1, "Kill must precede evidence writing")
        self.assertTrue(evidence[0][1]["expired"])

    def test_closed_or_cancelled_process_is_not_killed(self):
        closed = Process(); closed.returncode = 0
        watchdog = OwnedProcessWatchdog(closed, 25, timer_factory=Timer).start()
        watchdog.timer.fire(); self.assertEqual(closed.kills, 0)
        active = Process(); watchdog = OwnedProcessWatchdog(active, 25, timer_factory=Timer).start()
        watchdog.cancel(); watchdog.timer.fire()
        self.assertEqual(active.kills, 0)

    def test_native_destruction_releases_blocking_rpc(self):
        owned = Process(); watchdog = OwnedProcessWatchdog(owned, .03).start()
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                watchdog.call(lambda: owned.destroyed.wait(2), label="fake Frida RPC")
            self.assertLess(time.monotonic()-started, .5)
            self.assertTrue(owned.destroyed.is_set())
            self.assertEqual(owned.kills, 1)
        finally: watchdog.cancel()

    def test_controller_escapes_even_without_rpc_destruction_notification(self):
        owned, blocked = Process(), threading.Event()
        watchdog = OwnedProcessWatchdog(owned, .03).start()
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                watchdog.call(lambda: blocked.wait(2), label="unresponsive transport")
            self.assertLess(time.monotonic()-started, .5)
            self.assertEqual(owned.kills, 1)
        finally:
            blocked.set(); watchdog.cancel()

    def test_normal_rpc_result_and_error_are_preserved(self):
        owned = Process(); watchdog = OwnedProcessWatchdog(owned, 1).start()
        try:
            self.assertEqual(watchdog.call(lambda value: value+1, 2), 3)
            with self.assertRaisesRegex(ValueError, 'original'):
                watchdog.call(lambda: (_ for _ in ()).throw(ValueError('original')))
            self.assertEqual(owned.kills, 0)
        finally: watchdog.cancel()


if __name__ == '__main__': unittest.main()
