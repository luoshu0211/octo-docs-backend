"""Isolated Docker samples with exact commands, exit status and OOM evidence.

Requires the task's immutable baseline image and the current compiled backend.
Never contacts a database or production service. Each case has a fresh cgroup.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("--phase", choices=["baseline", "patched"], required=True)
parser.add_argument("--fixtures", default="small,medium,1m,50m,large")
parser.add_argument("--samples", type=int, default=3)
parser.add_argument("--memory", default="4g")
parser.add_argument("--heap", default="4096")
parser.add_argument("--mode", choices=["save", "rooms"], default="save")
parser.add_argument("--count", type=int, default=1)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
output = args.output.resolve()
(output / "results").mkdir(parents=True, exist_ok=True)
(output / "fixtures").mkdir(exist_ok=True)
cases = {"small": 320000, "medium": 630000, "1m": 1000000, "50m": 1500000, "large": 3106503}
image = "octo-whole-baseline:20261016" if args.phase == "baseline" else "octo-block-stage4:20261015"
image_id = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()


def run(name, mode, fixture, count):
    container = f"octo-whole-{name}-{time.time_ns()}"
    command = ["docker", "run", "--name", container, f"--memory={args.memory}",
               f"--memory-swap={args.memory}", "--cpus=2", "--network=none", "--read-only",
               "--tmpfs", "/tmp:rw,size=32m", "-e", "NODE_ENV=test",
               "-e", f"NODE_OPTIONS=--max-old-space-size={args.heap}",
               "-e", f"BENCHMARK_RESULT=/evidence/results/{name}.json",
               "-v", f"{output}:/evidence", "-w", "/bench"]
    if args.phase == "patched" or mode == "generate":
        command += ["-v", f"{repo}:/bench:ro"]
    else:
        # Identical measurement/recovery harness with immutable BASE code/Yjs.
        command += ["-v", f"{repo / 'scripts/benchmarkWholeDocument.mjs'}:/bench/scripts/benchmarkWholeDocument.mjs:ro"]
    command += ["--entrypoint", "node", image, "--expose-gc", "scripts/benchmarkWholeDocument.mjs",
                mode, f"/evidence/fixtures/{fixture}", str(count), "2"]
    start = time.time()
    with (output / "results" / f"{name}.log").open("w") as log:
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            code = child.wait(timeout=90)
        except subprocess.TimeoutExpired:
            subprocess.run(["docker", "kill", container], check=False, capture_output=True)
            code = child.wait(timeout=10)
    state = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .State}}", container], text=True))
    record = {"command": command, "imageId": image_id, "elapsedSeconds": time.time() - start,
              "exitCode": code, "containerState": state}
    (output / "results" / f"{name}.execution.json").write_text(json.dumps(record, indent=2))
    subprocess.run(["docker", "rm", container], check=True, capture_output=True)
    print(json.dumps({"sample": name, "exit": code, "oom": state["OOMKilled"], "seconds": record["elapsedSeconds"]}), flush=True)
    return code


for case in args.fixtures.split(","):
    fixture = f"numeric-{case}-v2.bin"
    if not (output / "fixtures" / fixture).exists():
        assert run(f"generate-{case}", "generate", fixture, cases[case]) == 0
    for sample in range(1, args.samples + 1):
        name = f"{args.phase}-{case}-{args.memory}-{args.mode}-{sample}"
        if run(name, args.mode, fixture, args.count) != 0:
            break  # A container failure disqualifies this case; no repeated OOMs.
