"""The diagnostic memory sample is the current resident size in MiB, or None when unavailable."""
import os
import subprocess
import sys
import unittest
from unittest import mock

import process_metrics


class ProcessMemoryTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "macOS resident size")
    def test_macos_reports_current_resident_mebibytes(self):
        # ps reports the same resident set in KiB; allow for the process changing between samples.
        sampled = process_metrics.memory_mib()
        resident = int(subprocess.run(["ps", "-o", "rss=", "-p", str(os.getpid())], capture_output=True, text=True, check=True).stdout) / 1024
        self.assertIsInstance(sampled, float)
        self.assertGreater(sampled, 1)
        self.assertLess(abs(sampled - resident), max(8, resident * .25))

    @unittest.skipUnless(sys.platform == "darwin", "macOS resident size")
    def test_macos_failure_is_missing_not_zero(self):
        with mock.patch("ctypes.CDLL", side_effect=OSError("unavailable")):
            self.assertIsNone(process_metrics.memory_mib())

    def test_unsupported_platform_is_missing(self):
        with mock.patch.object(process_metrics.sys, "platform", "sunos5"):
            self.assertIsNone(process_metrics.memory_mib())


if __name__ == "__main__":
    unittest.main()
