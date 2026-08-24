#!/usr/bin/env python3
from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import termios
import time
import tomllib
from dataclasses import replace
from pathlib import Path


DEFAULT_BRIDGE_ROOT = Path("/home/jenkins/connect2cli-bridge")
PTY_DRAIN_TIMEOUT_SECONDS = 2.0
PTY_COLUMNS = 120
PTY_ROWS = 40
RUNNER_CONTROL_PREFIX = "CODEX_TASK_CONTROL "
MAX_ROLLOUT_HEADER_BYTES = 1024 * 1024
MAX_ROLLOUT_EVENT_BYTES = 8 * 1024 * 1024
ROLLOUT_READ_CHUNK_BYTES = 64 * 1024
MAX_CODEX_CONFIG_BYTES = 8 * 1024 * 1024
COMPACT_CONTEXT_KEYS = (
    "sessionId:",
    "executionMode:",
    "SOURCE_DIR:",
    "CWD_DIR:",
    "CHATFILE_DIR:",
)


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr, flush=True)
    raise SystemExit(code)


def load_bridge_modules():
    bridge_root = Path(os.environ.get("CODEX_TASK_BRIDGE_ROOT") or DEFAULT_BRIDGE_ROOT).expanduser().resolve()
    if not bridge_root.is_dir():
        fail(f"Bridge module root does not exist: {bridge_root}", 4)
    sys.path.insert(0, str(bridge_root))
    try:
        from workspace_bridge.prompting import build_prompt
        from workspace_bridge.runner import build_runner_invocation
        from workspace_bridge.runtime import (
            build_bot_config,
            now_ms,
            prepare_session_run,
            update_session_record,
        )
    except Exception as exc:
        fail(f"Bridge modules could not be loaded from {bridge_root}: {exc}")
    return (
        build_prompt,
        build_runner_invocation,
        build_bot_config,
        now_ms,
        prepare_session_run,
        update_session_record,
    )


def open_audit_file(value: str) -> int:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    parent = candidate.parent.resolve()
    if not parent.is_dir():
        fail(f"Audit output directory does not exist: {parent}", 4)
    file_path = parent / candidate.name
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    return os.open(file_path, flags, 0o600)


def write_all(fd: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("audit output write returned no progress")
        view = view[written:]


def compact_bridge_context(prompt: str) -> str:
    lines = prompt.splitlines()
    try:
        start = lines.index("[BridgeContext]")
        end = lines.index("[/BridgeContext]", start + 1)
    except ValueError:
        return prompt

    context_lines = lines[start + 1 : end]
    retained = []
    for key in COMPACT_CONTEXT_KEYS:
        matches = [line for line in context_lines if line.startswith(key)]
        if len(matches) != 1:
            return prompt
        retained.append(matches[0])

    compact = ["[BridgeContext]", *retained, "Run in CWD_DIR.", "[/BridgeContext]"]
    return "\n".join([*lines[:start], *compact, *lines[end + 1 :]])


def interactive_terminal_argv(
    argv: tuple[str, ...],
    prompt: str,
    working_directory: Path,
) -> tuple[str, ...]:
    values = list(argv)
    if not values:
        raise ValueError("Codex invocation is empty")

    try:
        exec_index = values.index("exec")
    except ValueError:
        exec_index = next(
            (
                index
                for index, value in enumerate(values)
                if value in {"--json", "--skip-git-repo-check", "-o", "--output-last-message"}
                or value.startswith("--output-last-message=")
            ),
            len(values),
        )
        command = values[:exec_index]
        exec_arguments = values[exec_index:]
    else:
        command = values[:exec_index]
        exec_arguments = values[exec_index + 1 :]
    if not command:
        raise ValueError("Codex executable is missing from the invocation")

    resume_thread_id = ""
    if exec_arguments and exec_arguments[0] == "resume":
        exec_arguments.pop(0)
        if exec_arguments and not exec_arguments[0].startswith("-"):
            resume_thread_id = exec_arguments.pop(0)
        if not resume_thread_id:
            raise ValueError("Codex resume invocation is missing its thread id")

    terminal_options: list[str] = []
    index = 0
    while index < len(exec_arguments):
        value = exec_arguments[index]
        if value in {"--json", "--skip-git-repo-check", "-"}:
            index += 1
            continue
        if value in {"-o", "--output-last-message", "--color"}:
            index += 2
            continue
        if value.startswith("--output-last-message=") or value.startswith("--color="):
            index += 1
            continue
        if value == "--full-auto":
            terminal_options.extend(["--sandbox", "workspace-write", "--ask-for-approval", "never"])
            index += 1
            continue
        terminal_options.append(value)
        index += 1

    result = [
        *command,
        *terminal_options,
        "--no-alt-screen",
        "-C",
        str(working_directory),
    ]
    if resume_thread_id:
        result.extend(["resume", resume_thread_id])
    result.extend(["--", prompt])
    return tuple(result)


def codex_home_from_env(environment: dict[str, str]) -> Path | None:
    raw = str(environment.get("CODEX_HOME") or "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def ensure_trusted_project(codex_home: Path | None, working_directory: Path) -> None:
    if codex_home is None:
        raise ValueError("Codex invocation is missing CODEX_HOME")
    if not codex_home.is_dir():
        raise ValueError("Codex home is not available")

    project_path = str(working_directory.expanduser().resolve())
    config_path = codex_home / "config.toml"
    source = ""
    if config_path.exists() or config_path.is_symlink():
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(config_path, flags)
        try:
            file_stat = os.fstat(descriptor)
            if not stat.S_ISREG(file_stat.st_mode):
                raise ValueError("Codex config.toml is not a regular file")
            if file_stat.st_size > MAX_CODEX_CONFIG_BYTES:
                raise ValueError("Codex config.toml exceeds the managed size limit")
            chunks = []
            remaining = file_stat.st_size
            while remaining:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            source_bytes = b"".join(chunks)
        finally:
            os.close(descriptor)
        try:
            source = source_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("Codex config.toml is not valid UTF-8 TOML") from exc

    try:
        parsed = tomllib.loads(source)
    except tomllib.TOMLDecodeError as exc:
        raise ValueError("Codex config.toml is not valid UTF-8 TOML") from exc

    projects = parsed.get("projects", {})
    if not isinstance(projects, dict):
        raise ValueError("Codex config.toml projects value must be a table")
    project = projects.get(project_path)
    if isinstance(project, dict) and project.get("trust_level") == "trusted":
        return
    if project is not None:
        raise ValueError("Codex config.toml has a conflicting trust setting for the task workspace")

    separator = "" if not source or source.endswith("\n\n") else "\n" if source.endswith("\n") else "\n\n"
    trusted_project = (
        f"[projects.{json.dumps(project_path, ensure_ascii=False)}]\n"
        'trust_level = "trusted"\n'
    )
    updated = f"{source}{separator}{trusted_project}"
    try:
        verified = tomllib.loads(updated)
    except tomllib.TOMLDecodeError as exc:
        raise ValueError("Task workspace trust could not be added to Codex config.toml") from exc
    if verified.get("projects", {}).get(project_path, {}).get("trust_level") != "trusted":
        raise ValueError("Task workspace trust could not be verified in Codex config.toml")

    temporary_path: Path | None = None
    directory_fd: int | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=".config.toml.", dir=codex_home)
        temporary_path = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            write_all(descriptor, updated.encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary_path, config_path)
        temporary_path = None
        directory_fd = os.open(codex_home, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.fsync(directory_fd)
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def rollout_snapshot(codex_home: Path | None) -> dict[Path, int]:
    if codex_home is None:
        return {}
    sessions_root = codex_home / "sessions"
    if not sessions_root.is_dir():
        return {}
    snapshot: dict[Path, int] = {}
    for candidate in sessions_root.glob("**/rollout-*.jsonl"):
        try:
            file_stat = candidate.lstat()
        except OSError:
            continue
        if stat.S_ISREG(file_stat.st_mode) and not candidate.is_symlink():
            snapshot[candidate.resolve()] = file_stat.st_size
    return snapshot


def rollout_thread_id(candidate: Path) -> str:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(candidate, flags)
    try:
        header = bytearray()
        while len(header) < MAX_ROLLOUT_HEADER_BYTES and b"\n" not in header:
            chunk = os.read(descriptor, min(65536, MAX_ROLLOUT_HEADER_BYTES - len(header)))
            if not chunk:
                break
            header.extend(chunk)
    finally:
        os.close(descriptor)
    first_line = bytes(header).split(b"\n", 1)[0]
    try:
        envelope = json.loads(first_line.decode("utf-8"))
    except Exception:
        return ""
    if envelope.get("type") != "session_meta":
        return ""
    payload = envelope.get("payload") or {}
    return str(payload.get("session_id") or payload.get("id") or "").strip()


def changed_rollout(
    codex_home: Path | None,
    before: dict[Path, int],
    expected_thread_id: str | None,
) -> tuple[Path, int, str] | None:
    after = rollout_snapshot(codex_home)
    candidates: list[tuple[Path, int, str]] = []
    for candidate, size in after.items():
        offset = before.get(candidate, 0)
        if size <= offset:
            continue
        try:
            thread_id = rollout_thread_id(candidate)
        except OSError:
            continue
        if not thread_id:
            continue
        if expected_thread_id and thread_id != expected_thread_id:
            continue
        candidates.append((candidate, offset, thread_id))
    if len(candidates) == 1:
        return candidates[0]
    return None


def read_rollout_terminal_event(
    candidate: Path,
    offset: int,
    pending: bytes,
) -> tuple[int, bytes, dict | None]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(candidate, flags)
    try:
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode):
            raise OSError("rollout path is not a regular file")
        if file_stat.st_size < offset:
            raise OSError("rollout file was truncated during the managed turn")
        chunks = [pending]
        position = offset
        while position < file_stat.st_size:
            chunk = os.pread(
                descriptor,
                min(ROLLOUT_READ_CHUNK_BYTES, file_stat.st_size - position),
                position,
            )
            if not chunk:
                break
            chunks.append(chunk)
            position += len(chunk)
    finally:
        os.close(descriptor)

    buffered = b"".join(chunks)
    lines = buffered.split(b"\n")
    pending = lines.pop()
    if len(pending) > MAX_ROLLOUT_EVENT_BYTES:
        raise OSError("rollout event exceeds the managed size limit")
    terminal_event = None
    for line in lines:
        if len(line) > MAX_ROLLOUT_EVENT_BYTES:
            raise OSError("rollout event exceeds the managed size limit")
        if b'"task_complete"' not in line and b'"turn_aborted"' not in line:
            continue
        try:
            envelope = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        payload = envelope.get("payload") or {}
        if envelope.get("type") != "event_msg" or payload.get("type") not in {
            "task_complete",
            "turn_aborted",
        }:
            continue
        terminal_event = payload
        break
    return position, pending, terminal_event


def write_result_file(value: str, content: str) -> None:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    flags = os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(candidate, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError("result path is not a regular file")
        write_all(descriptor, content.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def emit_control(payload: dict) -> None:
    print(f"{RUNNER_CONTROL_PREFIX}{json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one workspace-backed Codex turn in a real PTY.")
    parser.add_argument("--bot-id", required=True)
    parser.add_argument("--bot-name", required=True)
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--chatfile-root", required=True)
    parser.add_argument("--chat-key", required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--output-file")
    parser.add_argument("--stdout-file")
    parser.add_argument("--stderr-file")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    (
        build_prompt,
        build_runner_invocation,
        build_bot_config,
        now_ms,
        prepare_session_run,
        update_session_record,
    ) = load_bridge_modules()

    try:
        source_dir = Path(args.source_dir).expanduser().resolve()
        if not source_dir.exists():
            fail(f"source-dir does not exist: {source_dir}", 4)
        if not source_dir.is_dir():
            fail(f"source-dir is not a directory: {source_dir}", 4)
        bot = build_bot_config(
            bot_id=args.bot_id,
            bot_name=args.bot_name,
            source_dir=source_dir,
            runtime_root=args.runtime_root,
            chatfile_root=args.chatfile_root,
        )
        launch = prepare_session_run(bot, args.chat_key)
        prompt = compact_bridge_context(build_prompt(bot, launch, args.message))
    except ValueError as exc:
        fail(str(exc), 4)
    except Exception as exc:
        fail(str(exc) or "unexpected error", 1)

    if args.dry_run:
        payload = {
            "cwd": str(launch.cwd),
            "sessionId": launch.session.session_id,
            "workspaceId": launch.session.workspace_id,
            "cwdDir": str(launch.runtime_context.cwd_dir),
            "chatfileDir": str(launch.runtime_context.chatfile_dir),
            "effectiveSkills": list(launch.runtime_context.effective_skill_names),
            "prompt": prompt,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if not str(args.output_file or "").strip():
        fail("--output-file is required unless --dry-run is used", 4)
    if not str(args.stdout_file or "").strip() or not str(args.stderr_file or "").strip():
        fail("--stdout-file and --stderr-file are required unless --dry-run is used", 4)

    stdout_audit_fd: int | None = None
    stderr_audit_fd: int | None = None
    try:
        stdout_audit_fd = open_audit_file(args.stdout_file)
        stderr_audit_fd = open_audit_file(args.stderr_file)
    except Exception as exc:
        if stdout_audit_fd is not None:
            os.close(stdout_audit_fd)
        fail(f"Codex CLI audit output could not be opened: {exc}", 4)

    existing_thread_id = str(launch.session.thread_id or "").strip() or None
    master_fd: int | None = None
    slave_fd: int | None = None
    try:
        invocation = build_runner_invocation(
            launch,
            prompt=prompt,
            output_file=Path(args.output_file).expanduser().resolve(),
            resume=bool(existing_thread_id),
            resume_thread_id=existing_thread_id,
        )
        terminal_argv = interactive_terminal_argv(tuple(invocation.argv), invocation.prompt, Path(invocation.cwd))
        codex_home = codex_home_from_env(invocation.env)
        ensure_trusted_project(codex_home, Path(invocation.cwd))
        rollout_before = rollout_snapshot(codex_home)
        master_fd, slave_fd = pty.openpty()
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", PTY_ROWS, PTY_COLUMNS, 0, 0))
        process = subprocess.Popen(
            terminal_argv,
            cwd=invocation.cwd,
            env=invocation.env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
        )
        os.close(slave_fd)
        slave_fd = None
    except Exception as exc:
        if master_fd is not None:
            os.close(master_fd)
        if slave_fd is not None:
            os.close(slave_fd)
        os.close(stdout_audit_fd)
        os.close(stderr_audit_fd)
        fail(str(exc) or "unexpected error", 1)

    interrupted_signal: int | None = None
    forwarded_signal: int | None = None

    def handle_signal(signum, _frame) -> None:
        nonlocal interrupted_signal
        interrupted_signal = signum

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    emit_control({"type": "pty.started", "pid": process.pid, "cols": PTY_COLUMNS, "rows": PTY_ROWS})
    audit_errors: list[str] = []
    active_rollout: tuple[Path, int, str] | None = None
    rollout_read_offset = 0
    rollout_pending = b""
    terminal_event: dict | None = None
    rollout_control_emitted = False
    primary_exited_at: float | None = None
    pty_eof = False

    def record_audit_error(message: str) -> None:
        if message in audit_errors:
            return
        audit_errors.append(message)
        content = f"Codex CLI audit output is incomplete: {message}\n".encode("utf-8")
        try:
            write_all(stderr_audit_fd, content)
        except OSError:
            pass
        sys.stderr.buffer.write(content)
        sys.stderr.buffer.flush()

    def activate_rollout() -> None:
        nonlocal active_rollout, rollout_read_offset, rollout_control_emitted, existing_thread_id
        if active_rollout is not None:
            return
        active_rollout = changed_rollout(codex_home, rollout_before, existing_thread_id)
        if active_rollout is None:
            return
        rollout_path, rollout_read_offset, discovered_thread_id = active_rollout
        if discovered_thread_id != existing_thread_id:
            existing_thread_id = discovered_thread_id
            update_session_record(
                bot.runtime_root,
                launch.session.session_id,
                lambda current: replace(
                    current,
                    updated_at=now_ms(),
                    last_run_at=now_ms(),
                    thread_id=discovered_thread_id,
                ),
            )
        emit_control({
            "type": "rollout.ready",
            "path": str(rollout_path),
            "offset": rollout_read_offset,
            "threadId": discovered_thread_id,
        })
        rollout_control_emitted = True

    def observe_rollout() -> None:
        nonlocal rollout_read_offset, rollout_pending, terminal_event
        activate_rollout()
        if active_rollout is None or terminal_event is not None:
            return
        rollout_path, _, _ = active_rollout
        try:
            rollout_read_offset, rollout_pending, observed = read_rollout_terminal_event(
                rollout_path,
                rollout_read_offset,
                rollout_pending,
            )
        except OSError as exc:
            record_audit_error(f"rollout event read failed: {exc}")
            return
        if observed is None:
            return
        terminal_event = observed
        if observed.get("type") == "task_complete":
            try:
                write_result_file(args.output_file, str(observed.get("last_agent_message") or ""))
            except OSError as exc:
                record_audit_error(f"result output write failed: {exc}")
        if process.poll() is None:
            try:
                process.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass

    while True:
        if interrupted_signal is not None and forwarded_signal != interrupted_signal:
            forwarded_signal = interrupted_signal
            try:
                process.send_signal(interrupted_signal)
            except ProcessLookupError:
                pass

        observe_rollout()

        ready, _, _ = select.select([] if pty_eof else [master_fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(master_fd, 8192)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    chunk = b""
                else:
                    record_audit_error(f"PTY read failed: {exc}")
                    chunk = b""
            if chunk:
                try:
                    write_all(stdout_audit_fd, chunk)
                except OSError as exc:
                    record_audit_error(f"stdout audit write failed: {exc}")
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            else:
                pty_eof = True

        return_code = process.poll()
        if return_code is None:
            continue
        if primary_exited_at is None:
            primary_exited_at = time.monotonic()
        if pty_eof:
            break
        if time.monotonic() - primary_exited_at >= PTY_DRAIN_TIMEOUT_SECONDS:
            record_audit_error(
                f"PTY remained open for more than {PTY_DRAIN_TIMEOUT_SECONDS:g} seconds after Codex exited"
            )
            break

    return_code = process.wait()
    os.close(master_fd)
    observe_rollout()
    active_rollout = active_rollout or changed_rollout(codex_home, rollout_before, existing_thread_id)
    if active_rollout is not None:
        rollout_path, rollout_offset, active_thread_id = active_rollout
        if not rollout_control_emitted:
            emit_control({
                "type": "rollout.ready",
                "path": str(rollout_path),
                "offset": rollout_offset,
                "threadId": active_thread_id,
            })
    elif return_code == 0:
        record_audit_error("Codex exited successfully without a discoverable rollout increment")

    if terminal_event and terminal_event.get("type") == "task_complete":
        return_code = 0
    elif terminal_event and terminal_event.get("type") == "turn_aborted" and return_code == 0:
        return_code = 1

    for fd in (stdout_audit_fd, stderr_audit_fd):
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    if audit_errors and return_code == 0:
        return_code = 74
    update_session_record(
        bot.runtime_root,
        launch.session.session_id,
        lambda current: replace(
            current,
            updated_at=now_ms(),
            last_run_at=now_ms(),
            thread_id=existing_thread_id,
        ),
    )

    if interrupted_signal:
        return 128 + interrupted_signal
    return return_code if return_code >= 0 else 128 + abs(return_code)


if __name__ == "__main__":
    raise SystemExit(main())
