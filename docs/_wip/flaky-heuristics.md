# Flaky Test Heuristics (Draft)

Error signatures are hashed by:
- Failure message prefix
- Stack frame top lines
- Failure rate > 30% over 5 runs marks case as FLAKY
