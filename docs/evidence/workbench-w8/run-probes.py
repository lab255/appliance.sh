"""Opt-in regression controls. Run from a clean worktree; source is restored in finally."""
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
os.chdir(ROOT)
MODE = os.environ.get("WORKBENCH_PROBE")
OUTPUT = os.environ.get("EVIDENCE_DIR")
if not MODE or not OUTPUT:
    sys.exit("Set WORKBENCH_PROBE and EVIDENCE_DIR; see README.")
output = pathlib.Path(OUTPUT)
output.mkdir(parents=True, exist_ok=True)
source = "packages/desktop/src-tauri/src/inspection.rs"
cargo = ["cargo", "test", "--manifest-path", "packages/desktop/src-tauri/Cargo.toml"]
profile = os.environ.get("WORKBENCH_CARGO_PROFILE", "dev")
if profile not in ("dev", "release"):
    sys.exit("WORKBENCH_CARGO_PROFILE must be dev or release")
if profile == "release":
    cargo.append("--release")
env = dict(os.environ, TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}')
saved = {}


def replace(file, before, after):
    value = pathlib.Path(file).read_text()
    assert before in value, "Mutation anchor missing"
    saved.setdefault(file, value)
    pathlib.Path(file).write_text(value.replace(before, after, 1))


def scrub(line):
    line = line.replace(str(ROOT), "<checkout>")
    line = re.sub(r"/Users/[^\s\"')]+", "<local-path>", line)
    return re.sub(r"/(?:private/)?(?:tmp|var/folders)/[^\s\"')]+", "<temporary-path>", line)


try:
    negative = False
    if MODE == "f3-defect":
        for file in ["lib/workbench-readiness.ts", "pages/workbench/detail.tsx", "pages/workbench/package-section.tsx", "pages/workbench/workspace-inspector.tsx"]:
            file = "packages/app/src/" + file
            saved[file] = pathlib.Path(file).read_text()
            pathlib.Path(file).write_bytes(subprocess.check_output(["git", "show", "5172323b:" + file]))
        command = ["pnpm", "--filter", "@appliance.sh/app", "exec", "vitest", "run", "src/pages/workbench/package-section.test.tsx", "src/pages/workbench/workspace-inspector.test.tsx"]
        negative = True
    elif MODE == "capture-order-defect":
        replace(source, "        let key = signing_key(true)?;\n", "")
        replace(source, "        output.sync_all().map_err(err)?;", "        output.sync_all().map_err(err)?;\n        let key = signing_key(true)?;")
        command = cargo + ["capture_key_failure_retains_cause", "--lib"]
        negative = True
    elif MODE == "refresh-invalidation-defect":
        replace("packages/app/src/pages/workbench/workspace-inspector.tsx", "      setBusy('Refreshing…');\n      onSnapshot?.(undefined);", "      setBusy('Refreshing…');")
        command = ["pnpm", "--filter", "@appliance.sh/app", "exec", "vitest", "run", "src/pages/workbench/workspace-inspector.test.tsx"]
        negative = True
    elif MODE == "hmac-defect":
        replace(source, "let tag = authenticate(path, &bytes)?;", 'let tag = fs::read(path.with_extension("hmac")).unwrap_or_default();')
        command = cargo + ["hmac_rejects", "--lib"]
        negative = True
    elif MODE == "encoding-defect":
        replace(source, 'serializer.serialize_str(&STANDARD.encode(bytes))', 'serializer.serialize_bytes(bytes)')
        replace(source, 'STANDARD\n            .decode(String::deserialize(deserializer)?)\n            .map_err(serde::de::Error::custom)', 'Vec::<u8>::deserialize(deserializer)')
        command = cargo + ["storage_v2_roundtrips", "--lib"]
        negative = True
    elif MODE == "cache-defect":
        replace(source, "return Ok(Arc::clone(value));", "let _ = value; // defect: force reparsing")
        command = cargo + ["storage_v2_roundtrips", "--lib"]
        negative = True
    elif MODE == "version-defect":
        replace(source, "if stored.version != BASELINE_VERSION {", "if false {")
        command = cargo + ["storage_old_or_unknown_versions", "--lib"]
        negative = True
    elif MODE == "keychain-defect":
        replace(source, "Err(keyring::Error::NoEntry) if create =>", "Err(keyring::Error::NoEntry) =>")
        command = cargo + ["hmac_native_keychain", "--lib", "--", "--ignored"]
        env["WORKBENCH_KEYCHAIN_TEST"] = "1"
        negative = True
    elif MODE == "keychain":
        command = cargo + ["hmac_native_keychain", "--lib", "--", "--ignored"]
        env["WORKBENCH_KEYCHAIN_TEST"] = "1"
    elif MODE == "storage-corpus-defect":
        replace(source, "for index in 0..60 {", "for index in 0..59 {")
        command = cargo + ["storage_measurement", "--lib", "--", "--ignored", "--nocapture"]
        env["WORKBENCH_STORAGE_MEASURE"] = "1"
        negative = True
    elif MODE == "storage-before":
        current = pathlib.Path(source).read_text()
        start = current.rfind("    #[test]", 0, current.index("    fn storage_measurement()"))
        end = current.index("    fn write_authenticated", start)
        benchmark = current[start:end].replace("            *baselines().lock().unwrap() = BaselineCache::default();\n", "")
        cache_start = benchmark.index("        let mut cached = Vec::new();")
        cache_end = benchmark.index("        samples.sort_by", cache_start)
        benchmark = benchmark[:cache_start] + benchmark[cache_end:]
        previous = subprocess.check_output(["git", "show", "f04853c9:" + source], text=True)
        saved[source] = current
        pathlib.Path(source).write_text(previous.replace("    fn tampered_baseline()", benchmark + "    fn tampered_baseline()", 1))
        command = cargo + ["storage_measurement", "--lib", "--", "--ignored", "--nocapture"]
        env["WORKBENCH_STORAGE_MEASURE"] = "1"
    elif MODE == "storage":
        command = cargo + ["storage_measurement", "--lib", "--", "--ignored", "--nocapture"]
        env["WORKBENCH_STORAGE_MEASURE"] = "1"
    elif MODE == "native":
        command = cargo + ["inspection::tests", "--lib"]
    else:
        sys.exit("Unknown WORKBENCH_PROBE")
    with (output / (MODE + ".log")).open("w") as log:
        process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        for line in process.stdout:
            clean = scrub(line)
            log.write(clean)
            log.flush()
            lines.append(clean)
        code = process.wait()
    result = "".join(lines)
    if negative:
        # Compilation failures are NOT a demonstrated regression control.
        assert code != 0 and ("test result: FAILED" in result or ("AssertionError" in result and re.search(r"Test Files\s+\d+ failed", result))), "Expected a failing test, not a build error"
    else:
        assert code == 0, "Probe failed; inspect scrubbed log"
    print(MODE + ": expected result confirmed")
finally:
    for file, value in saved.items():
        pathlib.Path(file).write_text(value)
