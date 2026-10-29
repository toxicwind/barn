#!/usr/bin/env python3
"""
Backup NVIDIA fan controller (NVML) — prefer LACT (lactd) when available.

Hardware floor on this RTX 3090: min fan 30%.
Quiet curve matches /etc/lact/config.yaml.
"""
import logging
import signal
import sys
import time

import pynvml

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("nvidia-fan")

# (°C, fan %) — min 30% (driver hard floor on this card)
FAN_CURVE = [
    (20, 30),
    (40, 30),
    (48, 30),
    (52, 32),
    (55, 35),
    (60, 40),
    (65, 48),
    (70, 55),
    (75, 65),
    (80, 78),
    (85, 90),
    (90, 100),
]
POLL = 2
MIN_FAN = 30


class FanController:
    def __init__(self):
        self.running = True
        self.handle = None
        self.fan_count = 0
        self.curve = FAN_CURVE

    def init(self):
        pynvml.nvmlInit()
        self.handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(self.handle)
        if isinstance(name, bytes):
            name = name.decode()
        self.fan_count = pynvml.nvmlDeviceGetNumFans(self.handle)
        log.info(f"GPU 0: {name} ({self.fan_count} fans)")
        for i in range(self.fan_count):
            pynvml.nvmlDeviceSetFanControlPolicy(
                self.handle, i, pynvml.NVML_FAN_POLICY_MANUAL
            )

    def speed_for_temp(self, temp: int) -> int:
        curve = self.curve
        if temp <= curve[0][0]:
            return max(MIN_FAN, curve[0][1])
        if temp >= curve[-1][0]:
            return curve[-1][1]
        for i in range(len(curve) - 1):
            t1, s1 = curve[i]
            t2, s2 = curve[i + 1]
            if t1 <= temp < t2:
                return max(MIN_FAN, int(s1 + (s2 - s1) * (temp - t1) / (t2 - t1)))
        return curve[-1][1]

    def run(self):
        log.info(f"Curve: {self.curve}  Poll: {POLL}s  min={MIN_FAN}%")
        while self.running:
            try:
                temp = pynvml.nvmlDeviceGetTemperature(
                    self.handle, pynvml.NVML_TEMPERATURE_GPU
                )
            except Exception:
                time.sleep(POLL)
                continue
            target = self.speed_for_temp(temp)
            for i in range(self.fan_count):
                try:
                    pynvml.nvmlDeviceSetFanSpeed_v2(self.handle, i, target)
                except Exception as e:
                    log.info(f"fan {i} set failed: {e}")
            time.sleep(POLL)

    def shutdown(self):
        self.running = False
        try:
            for i in range(self.fan_count):
                pynvml.nvmlDeviceSetFanControlPolicy(
                    self.handle,
                    i,
                    pynvml.NVML_FAN_POLICY_TEMPERATURE_CONTINOUS_SW,
                )
        except Exception:
            pass
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass


def main():
    # Prefer LACT if daemon is healthy
    try:
        import subprocess

        out = subprocess.run(
            ["systemctl", "is-active", "lactd"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if out.stdout.strip() == "active":
            log.info("lactd is active — exit (LACT owns fans).")
            log.info("Edit /etc/lact/config.yaml then: sudo systemctl restart lactd")
            sys.exit(0)
    except Exception:
        pass

    ctrl = FanController()
    signal.signal(signal.SIGINT, lambda *_: setattr(ctrl, "running", False))
    signal.signal(signal.SIGTERM, lambda *_: setattr(ctrl, "running", False))
    try:
        ctrl.init()
        ctrl.run()
    finally:
        ctrl.shutdown()


if __name__ == "__main__":
    main()
