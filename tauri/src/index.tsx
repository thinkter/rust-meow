import { invoke } from "@tauri-apps/api/core";
import { render } from "solid-js/web";
import App from "./App";
import {
  installPerformanceHarness,
  type PerformanceCaptureConfig,
} from "./perf/harness";
import "./styles.css";

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("Rust Meow root element is missing");

  let performanceConfig: PerformanceCaptureConfig | null = null;
  if ("__TAURI_INTERNALS__" in window) {
    try {
      performanceConfig = await invoke<PerformanceCaptureConfig | null>("get_performance_capture_config");
    } catch (error) {
      // Performance capture is release instrumentation, never a startup
      // dependency for an ordinary user launch.
      console.warn("Could not inspect native performance capture config", error);
    }
  }
  if (performanceConfig) window.__RUST_MEOW_PERF_CONFIG__ = performanceConfig;
  const performanceHarness = installPerformanceHarness(performanceConfig ?? undefined);
  render(() => <App />, root);

  if (!performanceHarness) return;
  const capture = performanceConfig?.captureKind === "idle"
    ? performanceHarness.prepare().then(() => invoke("mark_performance_idle_ready"))
    : performanceHarness.run().then((result) => invoke("complete_performance_capture", { payload: { result } }));
  void capture.catch((error: unknown) => invoke("complete_performance_capture", {
    payload: { error: error instanceof Error ? error.message : String(error) },
  }));
}

void start();
