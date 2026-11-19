#!/usr/bin/env python3
"""Resource budgets must use available physical AND remaining cgroup memory."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('resource_runtime',ROOT/'scripts/runtime-config.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)


class ResourceBudgetTests(unittest.TestCase):
    def available(self, files):
        def read(path,*args,**kwargs):
            if str(path) not in files:raise OSError('not present')
            return files[str(path)]
        with patch.object(Path,'read_text',read),patch.object(runtime.os,'sysconf',return_value=1024):
            return runtime.available_memory_bytes()

    def test_physical_available_is_used_instead_of_total(self):
        self.assertEqual(self.available({'/proc/meminfo':'MemAvailable: 100 kB\n'}),100*1024)

    def test_cgroup_v2_remaining_budget_beats_physical_available(self):
        self.assertEqual(self.available({'/proc/meminfo':'MemAvailable: 100 kB\n','/sys/fs/cgroup/memory.max':'10000','/sys/fs/cgroup/memory.current':'9000'}),1000)

    def test_cgroup_v1_and_exhaustion(self):
        for used,expected in [('9000',1000),('11000',0)]:
            self.assertEqual(self.available({'/proc/meminfo':'MemAvailable: 100 kB\n','/sys/fs/cgroup/memory/memory.limit_in_bytes':'10000','/sys/fs/cgroup/memory/memory.usage_in_bytes':used}),expected)

    def test_unlimited_cgroup_keeps_physical_available(self):
        self.assertEqual(self.available({'/proc/meminfo':'MemAvailable: 100 kB\n','/sys/fs/cgroup/memory.max':'max'}),100*1024)


if __name__=='__main__':unittest.main()
