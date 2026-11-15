# P8-RESTORE-DRILL dry-run fixtures

The canned answers of `bash infra/drill/restore-drill.sh dry-run`, read by `infra/drill/guard.sh`.

- `instances.txt`, `keys.txt`: the Lightsail state the dry run starts from: the hosted server only. Each instance line is name, plan, state and a TEST-NET address, separated by tabs.
- `bucket.txt`: the answer of the hosted server's READ-ONLY bucket listing (the ssh call the guard passes to the hosted target; key, size, ETag and last modified, separated by tabs). A `bucket-<n>.txt` file, if there is one, answers the n-th listing instead. A test plants a change that way. The driver sorts each answer before it compares them.
- `healthz2.txt` (none by default, so every healthz answers 200): the answers to copy 2's healthz after the stack is started, 1 HTTP code per line, the n-th line for the n-th try. Its last line answers every later try. A test plants a proxy that answers 502 before 200 that way (F-1585).
- `<step>.sh`: the answer of an ssh call or the smoke made during that step (`BW_DRILL_STEP`). Its stdout is the answer and its exit code is the call's exit code. A step with no file answers nothing and exits 0. A digit at the end of a step name is dropped when looking for the file, so `fresh1` uses `fresh.sh`.

A test copies this folder, changes 1 file and points `BW_DRILL_FIXTURES` at the copy.
