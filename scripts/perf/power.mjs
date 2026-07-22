#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

export async function detectPowerState() {
  if (process.platform === "linux") return linuxPowerState();
  if (process.platform === "darwin") return macPowerState();
  if (process.platform === "win32") return windowsPowerState();
  return unknownPowerState(`unsupported platform ${process.platform}`);
}

async function linuxPowerState() {
  const directory = "/sys/class/power_supply";
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return unknownPowerState("Linux power_supply sysfs is unavailable", "linux-sysfs");
  }
  const supplies = await Promise.all(names.map(async (name) => {
    const base = `${directory}/${name}`;
    const [type, status, online] = await Promise.all([
      optionalText(`${base}/type`),
      optionalText(`${base}/status`),
      optionalText(`${base}/online`),
    ]);
    return { name, type, status, online: online === null ? null : online === "1" };
  }));
  const batteries = supplies.filter((supply) => supply.type === "Battery");
  const mains = supplies.filter((supply) => ["Mains", "USB", "USB_C"].includes(supply.type));
  if (!supplies.length) {
    return unknownPowerState("Linux reported no power supplies", "linux-sysfs");
  }
  const discharging = batteries.some((battery) => battery.status === "Discharging");
  const externalOnline = mains.some((supply) => supply.online === true);
  const onBattery = discharging ? true : externalOnline ? false : null;
  return {
    source: "linux-sysfs",
    onBattery,
    batteryCapable: batteries.length > 0,
    reason: onBattery === true
      ? "battery status is Discharging"
      : onBattery === false
        ? "external power is online"
        : "power source could not be determined",
    supplies,
  };
}

function macPowerState() {
  try {
    const output = execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" });
    const onBattery = /Now drawing from 'Battery Power'/.test(output);
    const batteryCapable = /InternalBattery/.test(output);
    return {
      source: "pmset",
      onBattery: batteryCapable ? onBattery : null,
      batteryCapable,
      reason: batteryCapable
        ? (onBattery ? "pmset reports Battery Power" : "pmset reports external power")
        : "pmset reported no internal battery",
    };
  } catch {
    return unknownPowerState("pmset power state is unavailable", "pmset");
  }
}

function windowsPowerState() {
  try {
    const script = [
      "$battery=Get-CimInstance Win32_Battery | Select-Object -First 1",
      "if(-not $battery){'none'}elseif($battery.BatteryStatus -eq 1){'battery'}else{'external'}",
    ].join(";");
    const state = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    return {
      source: "Win32_Battery",
      onBattery: state === "battery" ? true : state === "external" ? false : null,
      batteryCapable: state !== "none",
      reason: state === "battery"
        ? "Win32_Battery reports discharging"
        : state === "external"
          ? "Win32_Battery reports external power"
          : "Win32_Battery reported no battery",
    };
  } catch {
    return unknownPowerState("Win32_Battery power state is unavailable", "Win32_Battery");
  }
}

function unknownPowerState(reason, source = "unavailable") {
  return { source, onBattery: null, batteryCapable: false, reason };
}

async function optionalText(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const state = await detectPowerState();
  console.log(JSON.stringify(state));
  if (process.argv.includes("--require-battery") && state.onBattery !== true) {
    console.error(`Battery performance capture refused: ${state.reason}`);
    process.exitCode = 2;
  }
}
