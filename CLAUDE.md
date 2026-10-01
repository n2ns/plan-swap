@AGENTS.md

## Claude Code-specific execution rules

Project safety constraints, temporary-HOME tests, packaging restrictions and the prohibition on testing editor-server restarts are inherited from AGENTS.md.

- Never kill processes by name (`pkill`, `killall`, `taskkill /IM`). Only act on PIDs of processes started in the current session.
- Include the [preview verification](docs/manual-verification.md#preview-verification) requirements in every frontend task given to a subagent.
