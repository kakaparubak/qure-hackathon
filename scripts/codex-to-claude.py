#!/usr/bin/env python3
"""Convert Codex CLI session JSONL files to Claude Code JSONL format."""

import json
import os
import sys
import uuid
from pathlib import Path
from datetime import datetime

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

def codex_timestamp_to_iso(ts):
    """Convert Codex timestamp to ISO format string."""
    if isinstance(ts, (int, float)):
        dt = datetime.fromtimestamp(ts / 1000.0)
    elif isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now().isoformat() + "Z"
    else:
        return datetime.now().isoformat() + "Z"
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"

def extract_text(content):
    """Extract text from Codex content array."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and "text" in item:
                parts.append(item["text"])
        return "\n".join(parts)
    return ""

def convert_session(codex_file, target_project_dir, source_cwd, session_id=None):
    """Convert one Codex session file to Claude Code format."""
    if session_id is None:
        session_id = str(uuid.uuid4())

    git_branch = "main"
    version = "2.1.299"
    
    lines = []
    parent_uuid = None

    # Read and parse Codex session
    with open(codex_file) as f:
        codex_entries = [json.loads(line) for line in f if line.strip()]

    # Get session metadata
    session_meta = None
    for entry in codex_entries:
        if entry.get("type") == "session_meta":
            session_meta = entry.get("payload", {})
            break

    # Use cwd from metadata if available
    if session_meta and session_meta.get("cwd"):
        source_cwd = session_meta["cwd"]

    # Project directory is the path with / replaced by -
    project_dir_name = source_cwd.replace("/", "-")
    if not project_dir_name.startswith("-"):
        project_dir_name = "-" + project_dir_name

    output_dir = CLAUDE_PROJECTS_DIR / project_dir_name
    output_dir.mkdir(parents=True, exist_ok=True)

    messages_converted = 0

    for entry in codex_entries:
        entry_type = entry.get("type")
        payload = entry.get("payload", {})
        timestamp = codex_timestamp_to_iso(entry.get("timestamp"))

        # Skip session metadata, world_state, token_usage, turn_context, event_msg
        if entry_type in ("session_meta", "world_state", "token_usage_record", "turn_context", "event_msg"):
            # For task_complete, extract the last_agent_message if present
            if entry_type == "event_msg" and payload.get("type") == "task_complete":
                last_msg = payload.get("last_agent_message")
                if last_msg and isinstance(last_msg, str) and last_msg.strip():
                    msg_uuid = str(uuid.uuid4())
                    lines.append(json.dumps({
                        "parentUuid": parent_uuid,
                        "isSidechain": False,
                        "userType": "external",
                        "cwd": source_cwd,
                        "sessionId": session_id,
                        "version": version,
                        "gitBranch": git_branch,
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "model": "codex-imported",
                            "content": [{"type": "text", "text": last_msg, "citations": []}],
                            "stop_reason": "end_turn",
                            "stop_sequence": None,
                            "usage": {"input_tokens": 0, "output_tokens": 0}
                        },
                        "uuid": msg_uuid,
                        "timestamp": timestamp
                    }))
                    parent_uuid = msg_uuid
                    messages_converted += 1
            continue

        if entry_type == "response_item":
            payload_type = payload.get("type")

            if payload_type == "message":
                role = payload.get("role")
                text = extract_text(payload.get("content"))
                
                if not text.strip():
                    continue

                # Skip developer/system messages that are just instructions
                if role == "developer":
                    # Convert to system-style user messages (or skip short ones)
                    if len(text) > 100:
                        msg_uuid = str(uuid.uuid4())
                        lines.append(json.dumps({
                            "parentUuid": parent_uuid,
                            "isSidechain": False,
                            "userType": "external",
                            "cwd": source_cwd,
                            "sessionId": session_id,
                            "version": version,
                            "gitBranch": git_branch,
                            "type": "user",
                            "message": {
                                "role": "user",
                                "content": f"[System context] {text[:500]}..." if len(text) > 500 else text
                            },
                            "uuid": msg_uuid,
                            "timestamp": timestamp
                        }))
                        parent_uuid = msg_uuid
                        messages_converted += 1
                    continue

                if role == "user":
                    msg_uuid = str(uuid.uuid4())
                    # Check if this is actual user input or system context
                    is_system = text.startswith("# AGENTS.md") or text.startswith("<environment_context>")
                    if is_system:
                        lines.append(json.dumps({
                            "parentUuid": parent_uuid,
                            "isSidechain": False,
                            "attachment": {
                                "type": "session_context",
                                "context": {"content": text}
                            },
                            "rendered": [{"content": text}],
                            "renderedRole": "system",
                            "userType": "external",
                            "cwd": source_cwd,
                            "sessionId": session_id,
                            "version": version,
                            "gitBranch": git_branch,
                            "type": "attachment",
                            "uuid": msg_uuid,
                            "timestamp": timestamp
                        }))
                    else:
                        lines.append(json.dumps({
                            "parentUuid": parent_uuid,
                            "isSidechain": False,
                            "promptId": str(uuid.uuid4()),
                            "type": "user",
                            "message": {"role": "user", "content": text},
                            "uuid": msg_uuid,
                            "timestamp": timestamp,
                            "origin": {"kind": "human"},
                            "promptSource": "typed",
                            "turnOrigin": "human",
                            "userType": "external",
                            "cwd": source_cwd,
                            "sessionId": session_id,
                            "version": version,
                            "gitBranch": git_branch
                        }))
                    parent_uuid = msg_uuid
                    messages_converted += 1

                elif role == "assistant":
                    msg_uuid = str(uuid.uuid4())
                    lines.append(json.dumps({
                        "parentUuid": parent_uuid,
                        "isSidechain": False,
                        "userType": "external",
                        "cwd": source_cwd,
                        "sessionId": session_id,
                        "version": version,
                        "gitBranch": git_branch,
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "model": "codex-imported",
                            "content": [{"type": "text", "text": text, "citations": []}],
                            "stop_reason": "end_turn",
                            "stop_sequence": None,
                            "usage": {"input_tokens": 0, "output_tokens": 0}
                        },
                        "uuid": msg_uuid,
                        "timestamp": timestamp
                    }))
                    parent_uuid = msg_uuid
                    messages_converted += 1

            elif payload_type == "reasoning":
                text = ""
                if isinstance(payload.get("summary"), list):
                    text = "\n".join(s.get("text", "") for s in payload["summary"] if isinstance(s, dict))
                elif isinstance(payload.get("content"), list):
                    text = "\n".join(s.get("text", "") for s in payload["content"] if isinstance(s, dict) and "text" in s)
                
                if not text.strip():
                    continue

                msg_uuid = str(uuid.uuid4())
                lines.append(json.dumps({
                    "parentUuid": parent_uuid,
                    "isSidechain": False,
                    "userType": "external",
                    "cwd": source_cwd,
                    "sessionId": session_id,
                    "version": version,
                    "gitBranch": git_branch,
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "model": "codex-imported",
                        "content": [{
                            "type": "thinking",
                            "thinking": text,
                            "signature": ""
                        }],
                        "stop_reason": "end_turn",
                        "stop_sequence": None,
                        "usage": {"input_tokens": 0, "output_tokens": 0}
                    },
                    "uuid": msg_uuid,
                    "timestamp": timestamp
                }))
                parent_uuid = msg_uuid
                messages_converted += 1

            elif payload_type in ("function_call", "custom_tool_call"):
                name = payload.get("name", "unknown")
                args = payload.get("arguments", payload.get("input", ""))
                msg_uuid = str(uuid.uuid4())
                
                try:
                    if isinstance(args, str):
                        args_obj = json.loads(args)
                    else:
                        args_obj = args
                except (json.JSONDecodeError, TypeError):
                    args_obj = {"raw": str(args)}

                # Truncate large tool call args
                args_str = json.dumps(args_obj)
                if len(args_str) > 2000:
                    args_str = args_str[:2000] + "...(truncated)"
                    args_obj = {"_truncated": args_str}

                lines.append(json.dumps({
                    "parentUuid": parent_uuid,
                    "isSidechain": False,
                    "userType": "external",
                    "cwd": source_cwd,
                    "sessionId": session_id,
                    "version": version,
                    "gitBranch": git_branch,
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "model": "codex-imported",
                        "content": [{
                            "type": "tool_use",
                            "id": str(uuid.uuid4()),
                            "name": name,
                            "input": args_obj
                        }],
                        "stop_reason": "tool_use",
                        "stop_sequence": None,
                        "usage": {"input_tokens": 0, "output_tokens": 0}
                    },
                    "uuid": msg_uuid,
                    "timestamp": timestamp
                }))
                parent_uuid = msg_uuid
                messages_converted += 1

            elif payload_type in ("function_call_output", "custom_tool_call_output"):
                output_text = payload.get("output", "")
                if isinstance(output_text, dict):
                    output_text = json.dumps(output_text)
                if not isinstance(output_text, str):
                    output_text = str(output_text)
                
                # Truncate
                if len(output_text) > 3000:
                    output_text = output_text[:3000] + "\n...(truncated)"

                msg_uuid = str(uuid.uuid4())
                lines.append(json.dumps({
                    "parentUuid": parent_uuid,
                    "isSidechain": False,
                    "userType": "external",
                    "cwd": source_cwd,
                    "sessionId": session_id,
                    "version": version,
                    "gitBranch": git_branch,
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": str(uuid.uuid4()),
                            "content": output_text
                        }]
                    },
                    "uuid": msg_uuid,
                    "timestamp": timestamp
                }))
                parent_uuid = msg_uuid
                messages_converted += 1

    # Write header lines + messages
    header = []
    header.append(json.dumps({"type": "last-prompt", "sessionId": session_id, "leafUuid": parent_uuid}))
    header.append(json.dumps({"type": "mode", "mode": "normal", "sessionId": session_id}))
    header.append(json.dumps({"type": "permission-mode", "permissionMode": "auto", "sessionId": session_id}))

    output_file = output_dir / f"{session_id}.jsonl"
    with open(output_file, "w") as f:
        for h in header:
            f.write(h + "\n")
        for line in lines:
            f.write(line + "\n")

    return output_file, messages_converted


def main():
    codex_sessions_dir = Path.home() / ".codex" / "sessions"
    results = []

    # Find all .jsonl files
    session_files = sorted(codex_sessions_dir.rglob("rollout-*.jsonl"))

    for codex_file in session_files:
        # Extract session ID from filename
        # Format: rollout-YYYY-MM-DDTHH-MM-SS-<session_id>.jsonl
        filename = codex_file.stem
        parts = filename.split("-")
        # Session ID is the last 5 dash-separated parts (UUID format)
        original_session_id = "-".join(parts[-5:])

        # Read first line to get cwd
        try:
            with open(codex_file) as f:
                first_line = json.loads(f.readline())
            cwd = first_line.get("payload", {}).get("cwd", "")
        except (json.JSONDecodeError, IndexError):
            continue

        if not cwd:
            continue

        # Convert
        output_file, msg_count = convert_session(
            codex_file, None, cwd, session_id=str(uuid.uuid4())
        )

        results.append({
            "original_id": original_session_id,
            "source": str(codex_file),
            "cwd": cwd,
            "output": str(output_file),
            "messages": msg_count
        })

    print(f"\nConverted {len(results)} sessions:\n")
    for r in results:
        print(f"  [{r['messages']:3d} msgs] {r['original_id']}")
        print(f"           cwd: {r['cwd']}")
        print(f"           out: {r['output']}")
        print()

    print(json.dumps(results, indent=2))
    return results

if __name__ == "__main__":
    main()
