"""Audit explicit Chromium input/surface/display IDs in an existing trace only."""
from __future__ import annotations
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    events = json.loads(args.trace.read_bytes())["traceEvents"]
    flows = [event for event in events if event.get("name") == "LatencyInfo.Flow"
             and event.get("args", {}).get("chrome_latency_info", {}).get("step") == "STEP_HANDLE_INPUT_EVENT_MAIN"]
    latency = {event["args"]["event_latency"]["event_latency_id"]: event for event in events
               if event.get("name") == "EventLatency" and event.get("ph") == "b"}
    pipelines = [event for event in events if event.get("name") == "Graphics.Pipeline"]
    presentations = [event for event in events if event.get("name") == "DCompPresenter::Present" and event.get("ph") == "X"]
    reporters = [event for event in events if event.get("name") == "PipelineReporter" and event.get("ph") == "b"]
    marks = [event for event in events if event.get("name", "").startswith("styk-matched-input-")]
    submit_marks = []
    for event in events:
        if event.get("name", "").startswith("styk-matched-submit-"):
            detail = event.get("args", {}).get("data", {}).get("detail", "{}")
            submit_marks.append((event, json.loads(detail) if isinstance(detail, str) else detail))
    rows = []
    for marker in marks:
        input_id = int(marker["name"].rsplit("-", 1)[1])
        enclosing = [flow for flow in flows if flow["pid"] == marker["pid"] and flow["tid"] == marker["tid"]
                     and flow["ts"] <= marker["ts"] <= flow["ts"] + flow.get("dur", 0)]
        row = {"inputId": input_id, "marker": marker, "enclosingMainInputFlows": len(enclosing)}
        if len(enclosing) == 1:
            flow = enclosing[0]
            trace_id = flow["args"]["chrome_latency_info"]["trace_id"]
            event = latency.get(trace_id)
            row["mainInputFlow"] = flow
            row["eventLatency"] = event
            if event:
                info = event["args"]["event_latency"]
                surface, display = info.get("surface_frame_trace_id"), info.get("display_trace_id")
                if surface is not None and display is not None:
                    linked = [item for item in pipelines if item.get("args", {}).get("chrome_graphics_pipeline", {}).get("display_trace_id") == display]
                    row["aggregationContainsSurface"] = any(surface in item["args"]["chrome_graphics_pipeline"].get("aggregated_surface_frame_trace_ids", []) for item in linked)
                    row["frameReporters"] = [item for item in reporters if item["args"].get("frame_reporter", {}).get("surface_frame_trace_id") == surface]
                    swap = [item for item in linked if item["args"]["chrome_graphics_pipeline"].get("step") == "STEP_BUFFER_SWAP_POST_SUBMIT"]
                    present = [item for item in presentations if any(parent["pid"] == item["pid"] and parent["tid"] == item["tid"]
                               and parent["ts"] <= item["ts"] and item["ts"] + item["dur"] <= parent["ts"] + parent["dur"] for parent in swap)]
                    row["matchingPresentCalls"] = present
                    row["surfaceGeneration"] = [item for item in pipelines if item.get("args", {}).get("chrome_graphics_pipeline", {}).get("surface_frame_trace_id") == surface
                                                 and item["args"]["chrome_graphics_pipeline"].get("step") == "STEP_GENERATE_COMPOSITOR_FRAME"]
                    row["poseSubmitMarkers"] = [item for item, detail in submit_marks if detail.get("inputId") == input_id]
                    row["inputToNamedPresentCallMs"] = [(item["ts"] + item["dur"] - event["ts"]) / 1000 for item in present]
        rows.append(row)
    report = {"trace": str(args.trace), "status": "metadata-audit-not-target-pixel-proof", "inputs": rows,
              "summary": {"inputMarkers": len(rows), "uniqueEnclosingInputFlow": sum(row["enclosingMainInputFlows"] == 1 for row in rows),
                          "withSurfaceAndDisplay": sum(bool(row.get("aggregationContainsSurface")) for row in rows),
                          "withOneNamedPresentCall": sum(len(row.get("matchingPresentCalls", [])) == 1 for row in rows)},
              "limitation": "Input callback nesting and Chromium surface/display IDs establish an input-associated compositor frame. They do not by themselves prove that frame sampled the exact edited WebGPU texture. No physical scanout or native HRESULT is recorded by the DCompPresenter trace span. Import readiness has no corresponding input-latency flow."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"]))


if __name__ == "__main__":
    main()
