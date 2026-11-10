#!/usr/bin/env python3
"""Bounded, read-only host checks. Never restarts a business service."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess


def snapshot():
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        name, value = line.split(':', 1)
        memory[name] = int(value.split()[0])
    disk = shutil.disk_usage('/')
    services = {}
    for name in os.environ.get('BIZHI_HEALTH_SERVICES', 'sshd,docker').split(','):
        try:
            result = subprocess.run(['systemctl', 'is-active', name + '.service'], capture_output=True, text=True, timeout=2)
            services[name] = result.stdout.strip()[:32] or 'unknown'
        except (OSError, subprocess.TimeoutExpired):
            services[name] = 'unknown'
    alerts = []
    if memory['MemAvailable'] < 256 * 1024:
        alerts.append('available_memory_below_256MiB')
    if disk.free / disk.total < 0.15:
        alerts.append('disk_free_below_15_percent')
    if os.getloadavg()[0] > (os.cpu_count() or 1) * 2:
        alerts.append('high_load')
    alerts.extend('service_' + name + '_' + state for name, state in services.items() if state != 'active')
    return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'memoryAvailableMiB': memory['MemAvailable'] // 1024,
            'swapUsedMiB': (memory.get('SwapTotal', 0) - memory.get('SwapFree', 0)) // 1024,
            'diskFreeMiB': disk.free // (1024 * 1024), 'load1': os.getloadavg()[0],
            'services': services, 'alerts': alerts}


def main():
    directory = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/bizhi-host-health'))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    report = snapshot()
    temp = directory / 'latest.tmp'
    temp.write_text(json.dumps(report, ensure_ascii=False) + '\n')
    temp.chmod(0o600)
    temp.replace(directory / 'latest.json')
    # One snapshot per UTC day, seven days retained within this owned directory.
    daily = directory / (report['at'][:10] + '.json')
    if not daily.exists():
        daily.write_text(json.dumps(report) + '\n')
        daily.chmod(0o600)
    for old in sorted(directory.glob('????-??-??.json'))[:-7]:
        old.unlink()
    print(json.dumps(report))


if __name__ == '__main__':
    main()
